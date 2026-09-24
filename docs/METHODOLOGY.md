# Methodology

How the scheduler is designed and why each decision was made. Written as the
design document the build worked towards, and kept as the record of the
reasoning behind what shipped.

## The problem in one sentence

Accept a request to send N emails starting at some future time, spaced apart,
under an hourly cap, and have every one of them go out exactly once even if the
process is killed and restarted in the middle.

## Why not cron

The scheduler deliberately avoids cron, and the reason is worth stating
properly.

Cron puts the schedule inside a process. A cron entry or a `node-cron` timer is
an instruction that only exists while something is running. Kill the process and
the schedule is gone. Restart it and you either lose the pending work or you
re-run work that already happened, because the process has no memory of what it
already did.

The alternative is to make the schedule a piece of data in a datastore, and let
whatever process happens to be alive read it. That is what BullMQ does, and it
is why surviving a restart becomes almost free.

## How scheduling works

BullMQ stores delayed jobs in a Redis sorted set, a ZSET. A ZSET holds members
with an attached numeric score and keeps them ordered by that score. For a
delayed job the score is the millisecond timestamp at which the job should run.

Two questions then become single commands:

| Question | Command | Cost |
| --- | --- | --- |
| What is due now? | `ZRANGEBYSCORE bull:emails:delayed -inf <now>` | O(log N) |
| When is the next one due? | `ZRANGE key 0 0 WITHSCORES` | O(1) |

The worker reads the smallest score, subtracts the current time, and sets a
single timer for that interval. One timer covers the entire queue regardless of
how many jobs are in it. There is no polling loop and no per job timer, which is
why a thousand scheduled emails cost effectively nothing.

## Data model

Two levels.

A campaign holds what the user typed once: subject, body, start time, delay
between sends, hourly limit, and the sender pool.

An email row is created per recipient. This matters. Storing recipients as a
JSON array on the campaign would make it impossible to track per recipient
status, per recipient send time, per recipient failure reason, or to retry one
address without retrying all of them. The tables that the dashboard renders are
just filtered queries over these rows.

Postgres is the source of truth for what should be sent and whether it already
was. Redis is only the clock. That split is deliberate: Redis is fast and
volatile, Postgres is durable and queryable, and the recovery path depends on
Postgres being able to answer "what was supposed to go out" independently of
Redis.

Statuses are `SCHEDULED`, `SENDING`, `SENT`, `FAILED`, and `RATE_LIMITED`. The
`SENDING` state is not cosmetic. It is the mechanism the idempotency guard
depends on, described below.

Indexes worth naming: `[status, scheduledAt]` supports the restart recovery
query, which asks for everything still scheduled. Without it that query is a
full table scan on every boot.

## Enqueueing

When a campaign is created, the API does the following inside one transaction:

1. Insert the campaign row.
2. Insert one email row per recipient, assigning senders round robin across the
   pool.
3. Compute each row's scheduled time as
   `startTime + index * max(delayBetween, MIN_DELAY_BETWEEN_EMAILS_MS)`.

Then it enqueues the jobs in a single `addBulk` call rather than a loop of
individual adds, which is one pipelined round trip to Redis instead of N.

Two details in the job options carry weight.

The job payload contains only the email row id, not the subject and body. Job
payloads are serialised into Redis, and duplicating a five kilobyte body across
a thousand jobs would put several megabytes of redundant text in memory for no
reason. The worker reads the row when it runs.

The job id is set explicitly to the email row's UUID. BullMQ refuses to add a
job whose id already exists, so a duplicated API call, a retry, or a double
click cannot create a second job for the same email.

## Idempotency

The job id gives one layer of protection, but it only holds while the job exists
in Redis. It does not protect against a manual retry of an already sent job, or
against two workers somehow both holding the same job.

The real guard is a conditional update in Postgres. Before doing any work, the
processor runs:

```sql
UPDATE emails SET status = 'SENDING'
WHERE id = $1 AND status IN ('SCHEDULED', 'RATE_LIMITED');
```

A single UPDATE statement takes a row level lock. If two workers issue it at the
same instant, one of them waits for the other to commit, then re-evaluates its
own WHERE clause. By that point the status is already `SENDING`, so it matches
nothing and the update affects zero rows. That worker returns immediately
without sending.

Exactly one worker can win, and that is guaranteed by the database rather than
by application logic or timing. This is a compare and swap, and it is the single
most important line in the system.

## Persistence across restarts

Two mechanisms, layered.

The first is Redis AOF. Every write is appended to a file on disk. The Node
process holds no scheduling state at all, so killing it changes nothing about
what is scheduled. Restarting the worker reconnects to the same sorted set and
carries on.

The second covers the harder case, where Redis itself has lost data or the
volume was removed. On worker boot, before starting to consume, the process
queries Postgres for every email still in `SCHEDULED` status and checks whether
a corresponding job exists in the queue. Any that are missing get re-added, with
a delay computed from their stored scheduled time. Rows whose time has already
passed get a delay of zero and fire immediately, which means they are late
rather than lost.

Together these mean the queue can be rebuilt from the database at any time, and
the database is never the thing that gets lost.

## Concurrency and the send delay

These are two different controls and they are commonly conflated.

Worker concurrency is how many jobs a single worker process will have in flight
at once, set by `WORKER_CONCURRENCY`. It helps because sending is dominated by
waiting on the network, so while one job waits on SMTP another can start.

The rate limiter is a separate constraint. Configuring the BullMQ worker with
`limiter: { max: 1, duration: MIN_DELAY_BETWEEN_EMAILS_MS }` means at most one
job may start per interval across all workers sharing the same Redis, because
the limiter is enforced with a Redis counter rather than an in process variable.

So concurrency governs parallelism and the limiter governs throughput, and when
they conflict the limiter wins. The chosen value is a minimum of 2 seconds
between sends, configurable through the environment.

Per campaign spacing is applied a second time at enqueue, by staggering each
row's scheduled time. The limiter is the floor that holds regardless of what a
campaign asks for.

## Hourly rate limiting

The goal is a per sender hourly cap that stays correct across multiple
concurrent jobs and multiple worker processes.

The naive version is broken:

```
current = GET key
if current < limit: INCR key
```

That is two round trips with a gap in between. Two workers can both read 199,
both decide they are under the limit, and both increment. This is a classic
check then act race.

The fix is to do the read, the comparison, and the increment inside a single Lua
script. Redis executes Lua scripts single threaded and atomically, so no other
command can interleave. The script reads the counter, returns a sentinel if the
limit is already reached, otherwise increments and sets the expiry on first use.

The key is `ratelimit:sender:{senderId}:{hourWindow}` where the window is
`floor(now / 3600000)`. Putting the hour in the key means the counter rolls over
to a fresh key on its own at the top of each hour, with no reset job and no
cleanup, because old keys expire themselves. The expiry is set only when the
counter first reaches one, since setting it on every increment would keep
pushing the expiry forward and the key would never die.

Both a per sender limit and a global limit are configurable. The per sender one
is the interesting case, since the system runs three senders and each gets its
own counter.

## What happens when the limit is hit

Jobs are never dropped and never permanently failed.

The processor computes the milliseconds remaining until the next hour boundary
and calls `job.moveToDelayed` with that timestamp plus a small random jitter,
then throws `DelayedError` to tell BullMQ that the job rescheduled itself rather
than failing. The job goes straight back into the delayed sorted set and is
picked up in the next window.

The jitter matters. Without it, every blocked job would be scored at the same
millisecond, and at the top of the hour the worker would pull all of them into
the ready list at once. A random spread of a few seconds smooths that.

Ordering is preserved approximately rather than strictly. The original spacing
survives because scheduled times were already staggered, and the jitter is small
relative to the two second send interval. Strict FIFO under a rate limit would
require a per sender ordered list and a different dequeue strategy, which is a
deliberate trade off not taken here.

## Slack notification

When a sender's hourly limit is reached, a message goes to the user's Slack.

The token is per user. The user connects Slack from the dashboard, which runs a
real OAuth authorize flow, and the resulting incoming webhook URL is stored on
the user row. If no webhook is stored, the notification step returns silently
and the rate limiting still works. If the user connects later, notifications
start working immediately, because the check is a database read rather than
configuration.

Sending it once per hour rather than once per blocked job uses
`SET key value NX EX 3600` on a notification key. `NX` sets the key only if it
does not already exist, and it is atomic, so whichever of the concurrent jobs
arrives first gets the OK and the rest get nil and return. Without this, two
hundred blocked jobs would produce two hundred Slack messages.

Slack accepts a localhost OAuth callback, so local development needs no tunnel.
The OAuth state is a signed token carrying the user id rather than a random value
held in a cookie, which keeps the callback stateless.

## Search

Emails are indexed into Elasticsearch on creation and again after a successful
send, using the email row id as the document id so the second write overwrites
the first rather than creating a duplicate.

The mapping distinguishes `keyword` from `text` fields deliberately. A `keyword`
field is stored as one indivisible string and is right for exact matching, so
status, sender address, and recipient address use it. A `text` field is run
through an analyser that lowercases and splits into tokens, which is what makes
partial and case insensitive matching work, so subject and body use it. Getting
this backwards produces a search that silently returns nothing.

Indexing is best effort. A failure to reach Elasticsearch is logged and
swallowed, because search being unavailable must never prevent an email from
being sent.

## Behaviour under load

For a campaign of a thousand or more recipients scheduled at roughly the same
time:

Rows are inserted in one transaction and jobs are added in one bulk call. All of
them sit in the delayed sorted set, which Redis holds as a skiplist at a few
hundred bytes per entry, so the memory cost is under a megabyte.

They become ready gradually because their scheduled times were staggered by the
configured delay. The worker limiter caps starts at one per two seconds
regardless, which is a ceiling of 1800 per hour. The Redis counter then caps
each sender at its own hourly limit, and anything over that is pushed into the
next window.

The net effect for a thousand emails across three senders at fifty per hour each
is that the campaign drains over roughly seven hours, in approximate order, with
nothing lost and nothing sent twice.

## Known trade offs

Ordering under rate limiting is approximate, not strict. Jitter on re-delay can
reorder jobs within a few seconds of each other.

SMTP credentials are stored in plaintext in the database. This is acceptable for
Ethereal test accounts and would need encryption at rest for real credentials.

Elasticsearch indexing is fire and forget with no backfill job. If the index is
unavailable during a send, that document is simply missing until something
re-indexes it.

There is no multi tenancy beyond per user Slack tokens. The sender pool is
global rather than owned by a user.

The Slack redirect URL is registered per app, so anyone running this locally has
to create their own Slack app and point it at their own callback. There is no
shared or hosted install path.
