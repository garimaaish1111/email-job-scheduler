# Email Job Scheduler

A production shaped email scheduling service and dashboard. Accepts campaigns
over an API, stores every recipient as its own row, schedules the sends with
BullMQ delayed jobs, and sends them through Ethereal SMTP under a configurable
rate limit. The schedule lives in Redis and Postgres rather than in any running
process, so killing the worker mid campaign loses nothing.

## What it does

### Scheduling
- Campaigns accepted over `POST /api/campaigns`, validated with zod
- Postgres via Prisma as the source of truth, one `Email` row per recipient
- BullMQ delayed jobs (`addBulk` with a per job `delay`), no cron anywhere
- Three sender accounts, assigned round robin at enqueue
- Every email indexed in Elasticsearch, searchable at `GET /api/emails/search`
- Live queue dashboard with Bull Board at `/admin/queues`
- Survives restarts: Redis AOF plus boot time reconciliation from Postgres
- Exactly once sends: conditional claim update, job id equals row id

### Throughput and rate limiting
- Configurable worker concurrency, `WORKER_CONCURRENCY`, default 5
- Minimum gap between sends via the BullMQ limiter plus a Lua slot reservation, `MIN_DELAY_BETWEEN_EMAILS_MS`, default 2000 (see "Delay between sends")
- Hourly caps per sender and globally, `MAX_EMAILS_PER_HOUR_PER_SENDER` and `MAX_EMAILS_PER_HOUR_GLOBAL`
- Every limit read from `env.ts`, nothing hardcoded in the send path
- Safe across multiple workers: an atomic Lua script over Redis counters keyed `ratelimit:sender:{senderId}:{hourWindow}`, no in memory state
- Nothing is dropped: a job over the limit is moved to the next hour window (plus jitter) with `moveToDelayed` and `DelayedError`, marked `RATE_LIMITED`, and the failed count stays 0

### Slack notifications
- Real OAuth flow: `GET /api/slack/connect`, signed state, `oauth.v2.access` exchange
- Token stored per user
- A message is posted the moment a sender hits its hourly limit
- Users without Slack connected are simply not notified, and connecting later works without a redeploy because connection state is read per hit

### Under load
- 1000 rows inserted and enqueued in 1814 ms, 1000 jobs in the delayed set, 3.45 MB total Redis, spacing exact to 2.0 seconds across all 999 gaps
- When the rate limit would be exceeded, jobs defer to the next window rather than failing; see "Behaviour under load"

### Dashboard
- Google OAuth login (authorization code flow with ID token verification), redirecting to `/dashboard`
- Sidebar user card with name, email and avatar, plus logout
- Scheduled and Sent views with live counts
- Compose page: CSV or text upload parsed in the browser with the detected address count, plus start time, delay between emails and hourly limit
- Rows show recipient, subject, time and a status pill; failed sends carry the error message
- Loading states, distinct empty states, and toasts for API and validation errors

## Architecture

```
                                      ┌──────────────────┐
  Browser (Next.js) ──POST /campaigns─►│   Express API    │
                                      └────────┬─────────┘
                                               │ 1. write rows in one transaction
                                               ▼
                                      ┌──────────────────┐
                                      │    Postgres      │  emails table
                                      │ (source of truth)│  id | to | status | ...
                                      └────────┬─────────┘
                                               │ 2. addBulk N delayed jobs
                                               ▼
                                      ┌──────────────────┐
                                      │      Redis       │  ZSET bull:emails:delayed
                                      │    (the clock)   │  member=jobId score=sendAtMs
                                      └────────┬─────────┘
                                               │ 3. score <= now, job becomes ready
                                               ▼
                                      ┌──────────────────┐
                                      │  BullMQ Worker   │  separate process
                                      │  concurrency=5   │
                                      └────────┬─────────┘
                     ┌─────────────────────────┼─────────────────────────┐
                     ▼                         ▼                         ▼
             claim row (CAS)            send via Ethereal          index into
             rate limit check                                     Elasticsearch
                     │
                     └── over limit → moveToDelayed(next hour) + Slack notification
```

## Tech stack

| Layer | Choice |
| --- | --- |
| Language | TypeScript |
| API | Express 5 |
| Queue | BullMQ on Redis 7 |
| Database | Postgres 16 via Prisma 6 |
| Search | Elasticsearch 8.14 |
| SMTP | Ethereal Email, three sender accounts |
| Queue dashboard | Bull Board |
| Frontend | Next.js 16 App Router, React 19, Tailwind 4 |
| Auth | Google OAuth 2.0, JWT session cookie |

## Prerequisites

- Node 20 or newer
- pnpm
- Docker Desktop

## Running it

### 1. Infrastructure

From the repository root:

```bash
docker compose up -d
```

This starts Redis, Postgres and Elasticsearch. Verify all three answer before
continuing. Elasticsearch takes about 40 seconds on a cold start.

```bash
docker ps
docker exec es_redis redis-cli ping
curl http://localhost:9200
```

### 2. Backend

```bash
cd backend
pnpm install
cp .env.example .env
```

Fill in `.env` following the table below, then:

```bash
pnpm prisma:migrate
pnpm seed
```

`seed` upserts the three Ethereal accounts from your `.env` into the Sender
table. The API and the worker run as two separate processes, in two terminals:

```bash
pnpm dev
```

```bash
pnpm dev:worker
```

API on http://localhost:4000, queue dashboard on
http://localhost:4000/admin/queues.

### 3. Frontend

```bash
cd frontend
pnpm install
```

Create `frontend/.env.local`:

```
NEXT_PUBLIC_API_URL=http://localhost:4000
```

```bash
pnpm dev
```

Open http://localhost:3000.

## Getting the credentials

### Ethereal

Go to https://ethereal.email/create and press the create button three times.
Each press gives a fresh user and password. Put them in `SENDER_1_*` through
`SENDER_3_*`. Ethereal never delivers anything; it returns a hosted preview URL
per message, which the app stores and links from the dashboard.

Three accounts rather than one because the scheduler is built around multiple senders,
and per sender rate limiting is meaningless with a single sender.

### Google OAuth

1. https://console.cloud.google.com, create a project
2. APIs and Services, OAuth consent screen, User Type External
3. Add your own Google account under Test users. An External app in Testing mode
   only admits listed test users, and Google rejects everyone else at its own
   consent screen, so nothing reaches your backend logs
4. Credentials, Create OAuth client ID, Web application
   - Authorized JavaScript origin: `http://localhost:3000`
   - Authorized redirect URI: `http://localhost:4000/api/auth/google/callback`
5. Copy the client ID and secret into `.env`

The redirect points at port 4000, the backend, not the frontend. The backend owns
the token exchange and the session cookie so that one session system covers both
Google and Slack.

The redirect URI is compared as a literal string. A trailing slash, `https`
instead of `http`, or `127.0.0.1` instead of `localhost` all produce
`redirect_uri_mismatch`.

### Slack

1. https://api.slack.com/apps, Create New App, From scratch, pick a workspace
2. OAuth and Permissions, Redirect URLs, add
   `http://localhost:4000/api/slack/callback`, then Save URLs
3. Scopes, Bot Token Scopes, add `incoming-webhook`
4. Basic Information, copy the client ID and secret into `.env`

Slack accepts a localhost redirect URL, so no tunnel is needed for local
development.

Once a user connects, the incoming webhook URL is stored on their row and posts
directly to Slack, so notifications do not depend on any of the OAuth setup
staying reachable.

## Environment variables

| Variable | Meaning | Default |
| --- | --- | --- |
| `PORT` | API port | 4000 |
| `FRONTEND_URL` | Allowed CORS origin and post login redirect | http://localhost:3000 |
| `DATABASE_URL` | Postgres connection string | from docker compose |
| `REDIS_HOST` / `REDIS_PORT` | Redis location | localhost / 6379 |
| `ELASTICSEARCH_NODE` | Elasticsearch URL | http://localhost:9200 |
| `JWT_SECRET` | Signs the session cookie and the Slack OAuth state | required, 16 chars minimum |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth app | required |
| `GOOGLE_CALLBACK_URL` | Must match the registered redirect URI exactly | http://localhost:4000/api/auth/google/callback |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | Slack app | optional |
| `SLACK_REDIRECT_URI` | Must match the registered Slack redirect URL exactly | http://localhost:4000/api/slack/callback |
| `WORKER_CONCURRENCY` | Jobs in flight per worker process | 5 |
| `MIN_DELAY_BETWEEN_EMAILS_MS` | Hard floor between send starts | 2000 |
| `MAX_EMAILS_PER_HOUR_PER_SENDER` | Default per sender hourly cap | 50 |
| `MAX_EMAILS_PER_HOUR_GLOBAL` | Ceiling across all senders | 200 |
| `STALLED_SENDING_TIMEOUT_MS` | A row stuck in SENDING longer than this is treated as abandoned on worker boot | 60000 |
| `SMTP_HOST` / `SMTP_PORT` | Ethereal SMTP | smtp.ethereal.email / 587 |
| `SENDER_N_NAME` / `SENDER_N_USER` / `SENDER_N_PASS` | Three sender accounts | required |

Every variable is parsed once at boot through a zod schema in
`src/config/env.ts`. A missing or malformed value crashes startup and names
itself. Nothing else in the codebase reads `process.env` directly.

## How scheduling works

BullMQ has no timer loop polling a table. Delayed jobs live in a Redis sorted
set, where every member carries a numeric score and Redis keeps the set ordered
by it. For a delayed job the score is the millisecond timestamp at which it
should run, packed as `timestamp * 4096 + sequence` so jobs due at the same
millisecond still order deterministically.

Two questions become one command each:

| Question | Command |
| --- | --- |
| What is due now | `ZRANGEBYSCORE bull:emails:delayed -inf <now>` |
| When is the next one due | `ZRANGE key 0 0 WITHSCORES` |

The worker reads the smallest score, subtracts the current time and sets one
timer for that interval. One timer covers the whole queue no matter how many jobs
are in it. No cron anywhere, at the OS level or in a library.

On campaign creation the API writes the campaign row and one email row per
recipient in a single transaction, with UUIDs generated in application code so
the ids are known before insert. Jobs are then added in one `addBulk` call rather
than a loop, which is one pipelined round trip instead of N.

Each job carries only the email row id. Job payloads are serialised into Redis,
and duplicating a five kilobyte body across a thousand jobs would put megabytes
of redundant text in memory for nothing. The worker reads the row when it runs.

## How persistence on restart is handled

Two layers.

Redis is started with `--appendonly yes`, so every write is appended to disk. The
Node process holds no scheduling state at all, which means killing it changes
nothing about what is scheduled. Restarting the worker reconnects to the same
sorted set and carries on.

The second layer covers the case where Redis itself lost its data. On boot, before
consuming anything, the worker queries Postgres for every email still in
`SCHEDULED` or `RATE_LIMITED` status and checks whether a matching job exists.
Any that are missing are re-added with a delay computed from their stored
scheduled time. Rows whose time has already passed get zero delay and fire
immediately, so they are late rather than lost.

There is a third case. A worker that dies *mid send* leaves its row claimed as
`SENDING`, and the processor will not touch a row in that state again, so without
handling it that email is silently lost and the dashboard shows `Sending` forever.
The problem statement requires surviving restarts "without restarting from scratch
or losing jobs", and that counts as losing one.

So on boot the worker also returns any row that has been sitting in `SENDING`
longer than `STALLED_SENDING_TIMEOUT_MS` (default 60 seconds) back to `SCHEDULED`,
after which the reconciler re-queues it. The timeout matters because a row is
legitimately `SENDING` while it waits for its send slot, which with high
concurrency and a large configured spacing can take several seconds. Only rows
older than the timeout are treated as abandoned, which also stops one worker from
stealing another worker's in-flight rows.

Reconciliation checks the job's *state*, not merely whether a job exists.
Completed jobs are retained for 24 hours, so a recovered row still has its old
finished job in Redis; treating that as "already queued" would leave the row
stranded. Only `waiting`, `delayed`, `active`, `prioritized` and `waiting-children`
count as queued. Anything else is removed and re-added.

All three were tested:

- Worker killed mid campaign after four of six had sent. On restart the reconciler
  logged `2 pending in DB, 0 re-queued, 2 already in queue`, both remaining
  emails sent, and all six rows ended with an attempt count of exactly one.
- Redis wiped entirely with `FLUSHALL` while four emails were scheduled. On the
  next boot the reconciler logged `4 pending in DB, 4 re-queued, 0 already in
  queue`, the delayed set was rebuilt from Postgres, and all four sent.
- Worker killed while a send was in flight, leaving one row in `SENDING`. On
  restart BullMQ retried that job and the processor logged
  `skipped ...: already claimed or terminal`, which is the guard refusing a
  possible duplicate. Recovery then returned the row to `SCHEDULED`, the
  reconciler re-queued it and it sent. That row ended at two attempts; the other
  eleven at one.

## How idempotency is maintained

The job id is set to the email row UUID, so BullMQ refuses to add a second job
for an email that already has one. That protects against a duplicated API call
but only while the job exists in Redis.

The real guard is a conditional update. Before doing any work the processor runs
the equivalent of:

```sql
UPDATE emails SET status = 'SENDING'
WHERE id = $1 AND status IN ('SCHEDULED', 'RATE_LIMITED');
```

A single UPDATE statement takes a row level lock. If two workers issue it at the
same instant, one waits for the other to commit and then re-evaluates its own
WHERE clause. By that point the status is already `SENDING`, so it matches nothing
and affects zero rows, and that worker returns without sending. Exactly one worker
can win, and that is guaranteed by Postgres rather than by application timing.

Under normal operation no email row ever reached an attempt count above one.

The one deliberate exception is stalled recovery, described above. There is a
window a few milliseconds wide between SMTP accepting a message and the status
write landing; a process that dies exactly there will have its row recovered and
re-sent, producing a duplicate. The alternative is dropping that email entirely.
For a scheduler whose core promise is not losing jobs, a rare duplicate
after a crash is the better failure, and it is the only path in the system that
can produce one.

## How concurrency and rate limiting are implemented

### Concurrency

`WORKER_CONCURRENCY` sets how many jobs a single worker process holds in flight.
It helps because sending is dominated by waiting on the network. It does not
control throughput; the limiter does.

### Delay between sends

Enforced twice, and the chosen value is a **minimum of 2 seconds between sends**,
configurable through `MIN_DELAY_BETWEEN_EMAILS_MS`.

The BullMQ worker limiter is set to `{ max: 1, duration: MIN_DELAY }`. It is
backed by a Redis counter rather than an in process variable, so it holds across
multiple worker processes.

On top of that the processor reserves a send slot through a Lua script that reads
the last reserved timestamp, takes the later of now and last plus the minimum gap,
writes it back and returns how long to wait. This second layer exists because the
BullMQ limiter is a fixed window counter and therefore permits small bursts at
window boundaries. The reservation turns the guarantee into a hard floor.

Measured across ten emails all overdue at once, gaps between send starts were
2004, 2042, 2014, 2015, 1995, 2006, 2003, 2033 and 2004 milliseconds, with the
Lua reservation contributing top ups of 1, 7, 14 and 36 milliseconds on the runs
where the limiter drifted under.

One measurement note worth stating: `sentAt` records completion, not start. With
concurrency above one, completions interleave and the gaps between them do not
reflect send spacing. The instrumentation reports send start timestamps for this
reason.

### Emails per hour

Both a per sender and a global hourly cap, both configurable. Counters live in
Redis under `ratelimit:sender:{senderId}:{hourWindow}` and
`ratelimit:global:{hourWindow}`, where the window is `floor(now / 3600000)`.
Putting the window in the key means the counter rolls over to a fresh key by
itself at the top of each hour and old keys expire on their own. No reset job.

The check and the increment happen inside a single Lua script. Redis executes Lua
single threaded and atomically, so read, compare and increment cannot interleave.
Doing it as a GET followed by an INCR would let two workers both read 199 and both
decide they were under a limit of 200. Both counters are incremented only if both
limits pass, so a per sender rejection cannot leave the global counter inflated.

### When the limit is reached

Jobs are never dropped and never permanently failed. The processor computes the
milliseconds until the next hour boundary, adds a few seconds of random jitter,
calls `job.moveToDelayed` with that timestamp and throws `DelayedError`, which
tells BullMQ the job rescheduled itself rather than failing. The attempt counter
is decremented, because being rate limited is not a failed try.

The jitter matters. Without it every blocked job would be scored at the same
millisecond and the worker would pull all of them into the ready list at once at
the top of the hour.

Ordering is preserved approximately rather than strictly. The original spacing
survives because scheduled times were already staggered, and the jitter is small
relative to the two second send interval.

Tested: nine emails with a per sender limit of one across three senders produced
exactly three sends and six deferrals, zero failures, Redis counters reading 1 per
sender and 3 global, and the six deferred jobs scored at the next hour boundary
plus one to four seconds of jitter.

### Slack notification on rate limit

The user connects Slack from the dashboard through a real OAuth authorize flow
with the `incoming-webhook` scope. The resulting webhook URL is stored on the user
row.

Notifications are deduplicated to one per sender per hour with
`SET slack:notified:{senderId}:{hourWindow} 1 NX EX 3600`. `NX` sets the key only
if it does not exist and is atomic, so the first blocked job to arrive wins and
every other one returns silently. Without it, a sender that blocks two hundred
jobs would produce two hundred messages.

If no webhook is stored the notification step returns and does nothing, so an
unconnected user causes no error. Connection state is read from the database on
every rate limit hit, so connecting later starts notifications immediately with no
redeploy, and disconnecting stops them.

Tested live: nine emails with a per sender limit of one produced exactly three
Slack messages in the connected channel, one per sender, not six.

### Behaviour under load

For a thousand or more recipients scheduled at roughly the same time:

Rows are inserted in one transaction and jobs added in one bulk call. All of them
sit in the delayed sorted set, which Redis holds as a skiplist.

Measured with an actual 1000 recipient campaign:

| | |
| --- | --- |
| Request to HTTP 201 | 1814 ms, covering the transaction and the bulk enqueue |
| Jobs landed in the delayed set | 1000 |
| Total Redis memory | 3.45 MB |
| First scheduled send | 14:21:37 UTC |
| Last scheduled send | 14:54:56 UTC |
| Span | 33m 19s across 999 gaps, exactly 2.0 seconds each |

They become ready gradually because their scheduled times were staggered by the
configured delay at enqueue. The worker limiter caps starts at one per two seconds
regardless, a ceiling of 1800 per hour. The Redis counters then cap each sender at
its hourly limit, and anything over that is pushed into the next window.

Net effect for a thousand emails across three senders at fifty per hour each: the
campaign drains over roughly seven hours, in approximate order, with nothing lost
and nothing sent twice.

The enqueue path above was measured. The seven hour drain figure is arithmetic
from the configured limits rather than an observed run, since it would mean
sending a thousand messages through Ethereal.

## API

All routes except the OAuth entry points require the session cookie.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness |
| GET | `/api/auth/google` | Start Google OAuth |
| GET | `/api/auth/google/callback` | OAuth callback, sets the session cookie |
| GET | `/api/auth/me` | Current user and Slack connection state |
| POST | `/api/auth/logout` | Clear the session |
| POST | `/api/campaigns` | Create a campaign and schedule every recipient |
| GET | `/api/campaigns` | List the current user's campaigns |
| GET | `/api/emails` | List emails, filtered by `view=scheduled\|sent` or `status` |
| GET | `/api/emails/stats` | Counts per status |
| GET | `/api/emails/search` | Elasticsearch backed search |
| GET | `/api/slack/connect` | Start Slack OAuth |
| GET | `/api/slack/callback` | Store the incoming webhook |
| POST | `/api/slack/disconnect` | Forget the webhook |
| POST | `/api/slack/test` | Send a test notification |
| GET | `/admin/queues` | Bull Board |

`POST /api/campaigns` body:

```json
{
  "subject": "string",
  "body": "string",
  "startTime": "2026-09-06T18:30:00.000Z",
  "delayBetweenMs": 2000,
  "hourlyLimit": 50,
  "recipients": ["a@example.com", "b@example.com"]
}
```

Response:

```json
{
  "campaignId": "uuid",
  "totalRecipients": 12,
  "spacingMs": 2000,
  "hourlyLimit": 50,
  "firstSendAt": "2026-09-06T18:30:00.000Z",
  "lastSendAt": "2026-09-06T18:30:22.000Z"
}
```

## Features implemented

### Backend

- [x] Campaign scheduling API, one email row per recipient
- [x] Postgres via Prisma, four models and a status enum
- [x] BullMQ delayed jobs, no cron at OS or library level
- [x] Three Ethereal senders assigned round robin
- [x] Elasticsearch indexing on schedule and on send, with a search endpoint
- [x] Bull Board live queue dashboard
- [x] Persistence across worker restart, via Redis AOF
- [x] Persistence across total Redis loss, via boot time reconciliation from Postgres
- [x] Idempotency through a conditional update plus job id deduplication
- [x] Configurable worker concurrency
- [x] Minimum 2 second gap between sends, enforced by the BullMQ limiter and a Lua slot reservation
- [x] Per sender and global hourly limits, atomic Lua counters keyed by hour window
- [x] Rate limited jobs deferred to the next hour with jitter, never dropped
- [x] Slack OAuth connect, disconnect and reconnect, with once per sender per hour notifications
- [x] Graceful shutdown that drains in flight jobs

### Frontend

- [x] Real Google OAuth login
- [x] Sidebar with name, email, avatar and logout
- [x] Scheduled and Sent sections with live counts, polled
- [x] Compose page with CSV upload and detected address count
- [x] Recipient chips with overflow, plus manual entry
- [x] Start time, delay between emails and hourly limit controls
- [x] Send Later date picker with presets
- [x] Elasticsearch backed search with debounce
- [x] Loading states, empty states and error toasts
- [x] Links through to the real Ethereal preview for sent mail
- [x] Reusable UI components, one fetch wrapper, typed API contracts

## Assumptions and trade offs

**Ordering under rate limiting is approximate, not strict.** Jitter on re-delay
can reorder jobs within a few seconds of each other. Strict FIFO would need a per
sender ordered list and a different dequeue strategy, which was a deliberate
decision to leave out of this version.

**SMTP credentials are stored in plaintext in the database.** Acceptable for
Ethereal test accounts, would need encryption at rest for real ones.

**Elasticsearch indexing is best effort with no backfill.** If the cluster is
unavailable during a send, the document is simply missing until something
re-indexes it. Search failing must never stop an email from going out, so failures
are logged and swallowed.

**No multi tenancy beyond per user Slack tokens.** The sender pool is global rather
than owned by a user.

**The compose screen has no sender picker.** The backend round robins across
all three senders per campaign, so a picker would contradict the behaviour. The
From row is a static label instead.

**The login screen's email and password fields are not wired up.** Sign in is
Google OAuth only; submitting that form shows a message directing the user to
Google.

**Prisma is pinned to version 6.** Version 7 removed `url = env("DATABASE_URL")`
from the datasource block and requires a `prisma.config.ts` plus a driver adapter.
That is more moving parts than this project needs.

**The compose body is plain text.** The editor is a plain textarea and the body
is sent as both text and simple HTML. A rich text editor was out of scope.
