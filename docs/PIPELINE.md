# Project Pipeline

Running log of what has been set up so far, in the order it was done.
Updated as the build progresses.

Last updated: 6 September 2026

## Current status

Feature complete. Backend and frontend both build and typecheck. Scheduling,
persistence across restart, idempotency, rate limiting, Slack notifications,
search and both OAuth flows have been exercised end to end against real
services.

## Stage 1: Environment and accounts

Machine setup on Windows 11, AMD Ryzen 5 5500U, 16 GB RAM.

1. Installed Docker Desktop with the WSL 2 backend.
2. WSL 2 was not present on the machine, so it was installed separately with
   `wsl --install --no-distribution` from an elevated shell, followed by a
   reboot. The `--no-distribution` flag skips Ubuntu, which is unnecessary
   because Docker Desktop provisions its own `docker-desktop` distro.
3. Verified hardware virtualization was already enabled in firmware, so the
   "Virtualization support not detected" error on first launch was caused by
   the missing WSL platform rather than a BIOS setting.
4. Relocated Docker's disk image from `C:` to `E:\DockerData` through
   Settings, Resources, Advanced. The C: drive was nearly full and the image
   was expected to grow past 6 GB once images and Elasticsearch indices landed.
5. Moved the project directory itself to `E:\email-job-scheduler` and pointed the
   npm cache and the pnpm content store at the same drive. pnpm hardlinks
   packages out of its store into each `node_modules`, and hardlinks cannot
   cross volumes, so keeping the store and the project on one drive avoids
   silently falling back to full file copies.

External services registered:

| Service       | Purpose                                        |
| ------------- | ---------------------------------------------- |
| Ethereal      | Three SMTP test accounts, used as three senders |
| Google Cloud  | OAuth client for dashboard login               |
| Slack         | Workspace for rate limit notifications         |
| ngrok         | Registered for an HTTPS tunnel, later found unnecessary, see Stage 13 |

Google OAuth was configured as an External app in Testing mode, which restricts
sign in to explicitly listed test users. The signed in account was added to that
list. The redirect URI is registered as
`http://localhost:4000/api/auth/google/callback`, pointing at the backend rather
than the frontend, because the backend owns the token exchange and the session
cookie.

## Stage 2: Repository layout

```
email-job-scheduler/
  docker-compose.yml
  .gitignore
  docs/
  backend/
    src/
      config/
      db/
      queue/
      services/
      routes/
      middleware/
      types/
    prisma/
```

The worker will run as its own process (`src/worker.ts`), separate from the API
(`src/index.ts`). Two reasons. A slow SMTP call inside the API process would
block the event loop for HTTP requests, and separating them makes the restart
requirement demonstrable: the API can be killed while the worker keeps sending,
and the worker can be killed and restarted without losing the schedule.

## Stage 3: Infrastructure

Three services defined in `docker-compose.yml`:

| Service       | Image                    | Port |
| ------------- | ------------------------ | ---- |
| Redis         | redis:7-alpine           | 6379 |
| Postgres      | postgres:16-alpine       | 5432 |
| Elasticsearch | elasticsearch:8.14.0     | 9200 |

Three settings in that file are load bearing:

`redis-server --appendonly yes` enables the append only file. Every write is
appended to disk, so the delayed job set survives a container restart. This is
the persistence requirement, and without it a restart of the Redis container
would erase every scheduled job.

Named volumes (`redis_data`, `pg_data`, `es_data`) keep data outside the
containers, so `docker compose down` removes containers without touching data.

`ES_JAVA_OPTS=-Xms512m -Xmx512m` caps the Elasticsearch heap. Left alone the
JVM claims a quarter of system memory.

All three verified responding: `docker ps` shows three containers up,
`redis-cli ping` returns PONG, and `curl localhost:9200` returns the cluster
info document.

## Stage 4: Backend scaffolding

Runtime is Node 24 with TypeScript compiled to CommonJS. `tsx` runs the
TypeScript directly in development with file watching, so there is no build step
while iterating.

Dependencies installed:

| Package                  | Role                                    |
| ------------------------ | --------------------------------------- |
| express                  | HTTP server                             |
| bullmq, ioredis          | Delayed job queue backed by Redis       |
| @prisma/client, prisma   | Postgres access and migrations          |
| nodemailer               | SMTP sending through Ethereal           |
| @elastic/elasticsearch   | Indexing and search                     |
| @bull-board/express, api | Live queue dashboard                    |
| googleapis               | Google OAuth                            |
| zod                      | Env validation and request body parsing |
| multer, csv-parse        | CSV lead upload and parsing             |
| jsonwebtoken, cookie-parser | Session cookie                       |

Two install problems were fixed rather than worked around.

The Prisma CLI initially resolved to an 8.0.0 release candidate while
`@prisma/client` resolved to 7.10.0. The CLI generates the client, so mismatched
majors produce generated code the runtime cannot load. Both are now pinned to
version 7.

pnpm blocks dependency install scripts by default as a supply chain measure.
esbuild, Prisma's engines, and msgpackr-extract all download a native binary in
a postinstall step and are broken without it. These four are allowlisted in
`pnpm-workspace.yaml` under `allowBuilds`.

Environment variables are parsed once at boot in `src/config/env.ts` with a zod
schema, and the rest of the codebase imports the typed result. Reading
`process.env` directly returns `string | undefined`, which means a typo becomes
`undefined` flowing into application logic instead of a crash. Parsing at boot
turns a bad or missing variable into an immediate startup failure that names the
variable.

CORS is configured with an explicit origin and `credentials: true`, which the
session cookie depends on. The browser will neither store nor send a
cross origin cookie without it, and the corresponding `credentials: "include"`
is required on the frontend side.

Verified: `pnpm dev` starts the server and `GET /health` returns
`{"ok":true,"service":"email-scheduler-api","env":"development"}`.

## Stage 5: Database schema

Four models. User, Sender, Campaign, Email, plus an EmailStatus enum with the
values SCHEDULED, SENDING, SENT, FAILED and RATE_LIMITED.

One Email row is created per recipient rather than storing a JSON array of
addresses on the campaign. Per recipient status, send time, failure reason and
retry count are all requirements, and none of them are possible with a blob.

The SENDING status is not cosmetic. It is the value the idempotency guard writes
when it claims a row, described in Stage 7.

Indexes: [status, scheduledAt] backs the restart recovery query, which asks for
everything still pending. Without it that query is a full table scan on every
worker boot. [campaignId, status] and [senderId, sentAt] back the dashboard
queries.

Prisma 7 was tried first and reverted to Prisma 6. Version 7 removed
`url = env("DATABASE_URL")` from the datasource block and now requires a
prisma.config.ts plus a driver adapter passed to the client constructor. That is
more moving parts than this project needs and every reference for it assumes the
older form.

The three Ethereal accounts are seeded into the Sender table by prisma/seed.ts.

## Stage 6: Sending

`src/services/mailer.ts` keeps one nodemailer transport per sender in a Map,
created on first use. A transport holds a pooled TCP connection, so creating one
per email would mean a fresh TCP and TLS handshake every time.

Port 587 with `secure: false` is correct and looks wrong. 587 uses STARTTLS,
which opens in plaintext and upgrades. `secure: true` is for port 465, which is
TLS from the first byte. Setting it the other way hangs with no error.

Verified by sending a real message and opening its Ethereal preview URL.

## Stage 7: Queue, worker and processor

The queue is a BullMQ Queue named `emails`. The worker is a separate process,
`src/worker.ts`, started with its own script.

Enqueueing happens in `POST /api/campaigns`. The campaign row and all email rows
are written in one transaction, with UUIDs generated in application code so the
ids are known before insert. Jobs are then added with a single `addBulk` call,
one pipelined round trip rather than N.

Two details in the job options do real work. The payload carries only the email
row id, not the subject and body, because payloads are serialised into Redis and
duplicating a five kilobyte body across a thousand jobs wastes megabytes for
nothing. And the job id is set to the email row UUID, so BullMQ refuses to add a
second job for an email that already has one.

Idempotency does not rest on that alone. The processor claims a row before doing
any work:

    UPDATE emails SET status = 'SENDING'
    WHERE id = $1 AND status IN ('SCHEDULED', 'RATE_LIMITED')

A single UPDATE takes a row level lock. Two workers issuing it simultaneously
serialise, and the loser re-evaluates its WHERE clause against the already
updated row, matches nothing, and gets zero affected rows. Exactly one worker can
win, guaranteed by Postgres rather than by timing.

Verified: across every test run, no email row ever reached attempts greater than
one, and no email was sent twice.

## Stage 8: Persistence across restarts

Two layers, both verified.

Redis AOF covers the ordinary case. The worker process holds no scheduling
state, so killing it changes nothing. Test: a six email campaign was started, the
worker killed after four had sent, then restarted. The reconciler reported
"2 pending in DB, 0 re-queued, 2 already in queue", both remaining emails sent,
and all six rows ended with attempts of exactly one.

Boot time reconciliation covers the harder case where Redis itself has lost data.
Test: four emails were scheduled, then `FLUSHALL` wiped Redis completely. On the
next worker boot the reconciler reported "4 pending in DB, 4 re-queued, 0 already
in queue" and the delayed set was rebuilt from Postgres.

Emails whose scheduled time has already passed are enqueued with zero delay and
fire immediately, so they are late rather than lost.

## Stage 9: Concurrency, spacing and rate limiting

Worker concurrency is configurable and set to 5. It helps because sending is
dominated by waiting on the network.

Spacing between sends is enforced twice. The BullMQ worker limiter is set to
`{ max: 1, duration: MIN_DELAY_BETWEEN_EMAILS_MS }`, which is Redis backed and so
holds across worker processes. On top of that the processor reserves a send slot
through a Lua script that reads the last reserved timestamp, takes the later of
now and last plus the minimum gap, writes it back, and returns how long to wait.

The second layer exists because the BullMQ limiter is a fixed window counter,
which permits small bursts at window boundaries. Measured across ten emails all
overdue at once, gaps between send starts were 2004, 2042, 2014, 2015, 1995,
2006, 2003, 2033 and 2004 milliseconds, with the Lua reservation contributing
top ups of 1, 7, 14 and 36 milliseconds on the runs where the limiter drifted
under. The chosen value is a minimum of 2 seconds between sends.

An important measurement note: `sentAt` records completion, not start. With
concurrency above one, completions interleave and their gaps do not reflect send
spacing. The instrumentation was changed to report send start timestamps before
the numbers above were trusted.

Hourly limits are per sender and global, both configurable. Counters live in
Redis under `ratelimit:sender:{id}:{hourWindow}` and `ratelimit:global:{window}`
where the window is `floor(now / 3600000)`, so the counter rolls to a fresh key
by itself each hour and old keys expire on their own.

The check and the increment happen inside one Lua script. Redis runs Lua single
threaded and atomically, so read, compare and increment cannot interleave. Doing
it as a GET followed by an INCR would let two workers both read 199 and both
decide they were under a limit of 200. Both keys are only incremented if both
limits pass, so a sender rejection cannot leave the global counter inflated.

When a limit is reached the job is moved back into the delayed set at the next
hour boundary plus a few seconds of jitter, and `DelayedError` is thrown so
BullMQ treats it as a self reschedule rather than a failure. The attempt counter
is decremented so a rate limit does not burn a retry.

Verified: nine emails with a per sender limit of two across three senders
produced exactly six sent and three deferred. Redis counters read 2, 2, 2 per
sender and 6 global. The failed set was empty. The three deferred jobs were
scored at 13:00:01, 13:00:03 and 13:00:04 while the test ran at 12:15, and their
rows read RATE_LIMITED with an attempt count of zero.

## Stage 10: Elasticsearch

The client was installed at version 9 and downgraded to 8.19 to match the 8.14
server. The Elasticsearch JS client enforces major version compatibility and
refuses to talk to a server a major version behind.

The index mapping distinguishes keyword from text deliberately. A keyword field
is stored as one indivisible string, which is right for exact matching, so
status, recipientEmail, senderEmail, userId and the ids use it. A text field is
run through an analyser that lowercases and splits into tokens, so subject and
body use it. Reversing these produces a search that silently returns nothing.

Documents are written at two points, on campaign creation with status SCHEDULED
and again after a successful send with status SENT. Both use the email row id as
the document id, so the second write overwrites rather than duplicating.
Verified: three emails scheduled and sent left exactly three documents, all
reading SENT.

Indexing is best effort. Every call is wrapped so a failure is logged and
swallowed, and `ensureIndex` sets a flag that disables indexing entirely if the
cluster is unreachable at boot. Search being down must never stop an email from
sending.

The search endpoint runs a multi_match across subject, body, recipientEmail and
senderEmail with field boosts and fuzziness. Verified: "quarterly" matched on
subject, "revenu" matched despite the typo, and searching an exact recipient
address ranked that recipient first.

## Stage 11: Queue dashboard

Bull Board is mounted at /admin/queues through its Express adapter, giving live
views of waiting, active, delayed, completed and failed jobs.

## Stage 12: Google login

Real OAuth 2.0 authorization code flow, owned by the backend rather than the
frontend, so that one session system covers both Google and Slack.

`GET /api/auth/google` generates a state value, stores it in a short lived
HttpOnly cookie and redirects to Google. `GET /api/auth/google/callback`
verifies the state, exchanges the code for tokens, verifies the ID token
signature and audience, upserts the user on the Google subject id, signs a JWT
and sets it as an HttpOnly SameSite=Lax cookie, then redirects to the dashboard.

The session cookie is HttpOnly so injected JavaScript cannot read it, and
SameSite=Lax so the browser still sends it on the top level redirect back from
Google but not on cross site POSTs.

`GET /api/auth/me` returns the profile and whether Slack is connected.
`POST /api/auth/logout` clears the cookie.

Verified with a real Google account: the user row was created with name, email
and avatar URL populated from the verified ID token.

## Stage 13: Slack

The notification path is a per user incoming webhook obtained through a real
OAuth authorize flow with the incoming-webhook scope.

A detour worth recording: the build initially assumed Slack rejects a localhost
redirect URL and requires HTTPS. That assumption was wrong. Slack accepts
`http://localhost:4000/api/slack/callback` and saves it without complaint.

Acting on the wrong assumption cost time. ngrok was tried and abandoned twice,
once because the winget package ships 3.3.1 while ngrok now requires agent 3.20
or newer, and once because the direct download is quarantined by Windows
Defender as potentially unwanted software. cloudflared was then set up and
working, but its free hostname is ephemeral and had already expired by the next
morning, breaking the Slack configuration.

The final setup uses a plain localhost callback and no tunnel at all, which
removes a moving part from both local development and the setup instructions.

The OAuth state parameter is a signed JWT rather than a random value stored in a
cookie. It carries the user id and a ten minute expiry, signed with JWT_SECRET,
so it cannot be forged and the callback needs no session of its own. That was
originally chosen to survive the cross host redirect and was kept afterwards
because it is simpler than a cookie round trip through a third party.

Notifications are deduplicated to one per sender per hour using
`SET slack:notified:{senderId}:{hourWindow} 1 NX EX 3600`. NX sets the key only
if it does not exist and is atomic, so the first blocked job to arrive wins and
every other one returns silently. Without it, every blocked job would produce a
message.

If no webhook is stored the notification returns "no-webhook" and does nothing,
so an unconnected user causes no error. Connection state is read from the
database on every rate limit hit, so connecting later starts notifications
immediately with no redeploy.

Verified live. Nine emails with a per sender limit of one produced three sends,
six deferrals, zero failures, and exactly three Slack notification locks, one
per sender, confirming three messages rather than six.

## Stage 14: Frontend

Next.js 16 App Router with React 19 and Tailwind 4. Three routes: login,
dashboard, compose.

The layout is a left sidebar with a user card, a Compose button and a CORE
section listing Scheduled and Sent with live counts.

Structure:

    app/            login, dashboard, compose
    components/ui/  Button, Input, Spinner, StatusPill, EmptyState, Toast
    components/     Sidebar, EmailList, RecipientChips
    lib/api.ts      single fetch wrapper
    lib/utils.ts    date formatting, timezone conversion, address extraction
    hooks/          useAuth, useEmails, useStats
    types/          every API response and payload

`lib/api.ts` is the only place `fetch` is called. Base URL, credentials handling
and error shaping live there once, so components call `api.get<Email[]>(...)` and
the CORS cookie problem can only exist in one file.

Two things that would otherwise be intermittent bugs:

`<input type="datetime-local">` returns a string with no timezone. Sending it raw
would offset every send by the UTC offset and look exactly like a scheduler fault,
so it goes through `new Date(value).toISOString()` on the way out.

Start time is initialised in an effect rather than in `useState`. A "use client"
component is still server rendered for the initial HTML, so calling `Date.now()`
during render runs it on two clocks that can land on different minutes.

CSV parsing happens in the browser with PapaParse so the detected count appears
immediately. Only cells matching an address pattern are kept, which means a real
CSV with name and company columns works without column mapping, and the header
row drops out on its own.

Status pills show seconds. Without them a campaign spaced two seconds apart shows
twelve identical timestamps and the spacing is invisible.

The list polls every five seconds rather than using websockets. Simpler, and the
dashboard is not latency critical.

## Design decisions

The From row is a static label, not a sender dropdown. The backend round robins
across all three senders per campaign, so a picker would contradict the
behaviour.

The login screen has email and password fields, but sign in is Google OAuth
only. Submitting that form shows a message directing the user to Google.

The compose body is a plain textarea rather than a rich text editor; the body is
sent as both text and simple HTML.

## Verified end to end

- Google login with a real account, avatar and profile populated from the ID token
- Slack connected through the dashboard, channel shown in the menu afterwards
- Twelve leads uploaded from CSV, count reported correctly
- Campaign scheduled, rows appearing with amber pills two seconds apart
- Rows flipping to Sent, sidebar counts moving without interaction
- Sent row opening the real Ethereal message
- Two full campaigns, 24 emails, every row at exactly one attempt, zero failures
- Senders distributed 4 / 4 / 4 across the three accounts
