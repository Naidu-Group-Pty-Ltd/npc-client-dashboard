# Why the GoHighLevel, calendar and email imports were slow

Measured on the clone (`npc-client-dashboard`, Supabase `plisdzywzleljorrphxv`)
on 13 Sep 2026, against the prime reading the **same** GoHighLevel account and
the **same** Microsoft 365 mailbox.

## What the clone actually held

| table | prime | clone | clone has |
| --- | ---: | ---: | ---: |
| `clients` | 776 | 435 | 56% |
| `ghl_client_opportunities` | 655 | 308 | 47% |
| `ghl_conversations` | 804 | 194 | 24% |
| `ghl_conversation_messages` | 11,602 | 663 | **6%** |
| `email_copilot_emails` | 5,677 | 101 | **1.8%** |

And what its edge functions cost, from `function_edge_logs`:

| function | calls | avg | max |
| --- | ---: | ---: | ---: |
| `sync-ghl-conversations` | 5 | **78,562 ms** | **98,403 ms** |
| `outlook-email-sync` | 4 | 14,752 ms | 20,762 ms |
| `ghl-calendar` | 12 | 6,428 ms | 10,284 ms |

`sync-ghl-conversations` declares `request_timeout = 120`. It was averaging
78 seconds.

## The finding: the fast path already existed and these functions never used it

There are two generations of GoHighLevel code in this repository.

**The workers** — nine `ghl-migrate-*-worker` functions — call
`_shared/ghl-rate-limiter.ts`. That is a token bucket held in Postgres
(`ghl_rate_reserve` / `ghl_rate_note_429`, both `SECURITY DEFINER`, both
present on every clone), so every isolate and every function sharing a GHL
token cooperates on one limit. It reads `Retry-After` on a 429 and broadcasts
the cooldown to everybody else.

**The surfaces a person actually looks at** — Clients, Client Tracker, CRM
Conversations, Calendar — were on the older generation: hand-rolled
`delay(500)` sleeps, strictly sequential, no 429 handling. They simply never
adopted the limiter that was written for them.

## Four causes, each measured

### 1. `sync-ghl-conversations` spent most of its wall clock asleep

`delay(500)` per contact, `delay(300)` per conversation, `delay(300)` per
message page — awaited one after another. At 500ms per contact a 95s budget
reaches **at most 190** of the prime's 776 clients, and that is the floor,
before a single conversation or message is fetched.

A fixed sleep is the wrong instrument twice over. It is far slower than the
vendor allows when the vendor is idle, and it is **not a limit at all** when
two invocations overlap: two isolates each sleeping 500ms still issue 4 req/s
between them.

Pacing now comes from `ghlFetchShared`. Because it counts rather than sleeps,
requests are free to overlap, and `mapWithConcurrency` runs six contacts at a
time.

### 2. `import-clients-from-ghl` did 2–4 sequential round trips per contact

Per contact, in order: `SELECT` by `ghl_contact_id`; on a miss, `SELECT` by
`primary_email`; then `INSERT` or `UPDATE`; then sometimes an `INSERT` into
`lead_source_attributions`. At 100 contacts a page that is 200–400 serialized
queries, each paying full edge-to-Postgres latency, and **none of them
depending on the one before it**.

It is now four statements per page — one `IN` read by GHL id, one `IN` read by
email, one bulk insert, one bulk attribution insert — plus the non-destructive
`UPDATE`s eight at a time. Those cannot be batched because each patch is
computed against that row's own current values.

Two things the batch had to keep. **Per-contact error reporting**: a bulk
insert fails whole, so a failure falls back to per-row inserts, which is slow
exactly once and keeps every good row while naming the bad one. And
**deduplication within the page**: the old code re-queried for every contact,
so two GHL contacts sharing an email in one page could not both look new. A
batched read is taken once, before any write, so the page carries that rule
itself (`seenEmails`) or the import manufactures the duplicate it exists to
collapse.

### 3. Email Co-Pilot could not hold history, and no amount of syncing would fix it

`outlook-email-sync` issued `?$top=${limit}` once per folder and returned
`data.value`. **`@odata.nextLink` was never read.** `email-sync-cron` had a
second copy of the same one-page read with a hardcoded `$top=30`. The page asks
for `limit: 50`.

So the product could hold the most recent page per folder and, structurally,
nothing else — 101 rows against 5,677 on the same mailbox. Re-syncing could
never close it, because the second page was never requested.

Paging now lives once, in `_shared/graphMailPaging.ts`, and both callers use
it. Two rules it enforces:

- **A `nextLink` is opaque and complete.** It already carries `$top`,
  `$select`, `$orderby` and `$filter`. Appending to it or rebuilding it from
  parts is how a paginator silently re-reads page one for ever. It is followed
  verbatim or not at all.
- **"No more pages" and "out of budget" are different answers.** Graph offering
  no `nextLink` means the folder is exhausted and a backfill is genuinely
  finished; stopping on a deadline means come back. Collapsing them makes a
  half-read mailbox report itself complete, which looks exactly like a working
  import.

**History arrives without a cursor table.** The backfill asks for messages
older than the oldest row already stored, so the boundary is re-derived from
the database on every invocation: it cannot go stale, a run that dies halfway
loses nothing, and a repeat is a no-op against the duplicate constraint.

**It converges without anybody pressing anything.** `email-sync-cron` already
runs every five minutes; it now takes one bounded backfill step per tick after
its incremental pass, until `history_complete` is true, and then costs nothing.
A personal mailbox has no cron behind it, so Email Co-Pilot carries an "Import
Full History" action for that case alone.

The columns are `received_at` and `mailbox_source`. This table has **no**
`email_date` and **no** `mailbox` address column; naming either answers 42703,
which PostgREST hands back as `data: null` — read as "nothing stored yet", which
would restart the whole history walk on every tick for ever while reporting
progress the entire time. `scripts/security/check-edge-column-names.mjs` catches
that class, and was confirmed to catch this exact mistake.

### 4. Calendar fan-outs were sequential over independent requests

`ghl-calendar` fetched events one calendar at a time (GHL requires a request
per calendar); `outlook-calendar` read one colleague's calendar at a time.
Nothing in request N's answer affects request N+1, so the page cost the **sum**
of every calendar's or colleague's latency — and got slower every time somebody
joined the team. Both fan-outs are now bounded-concurrent.

## The shared primitive

`_shared/boundedConcurrency.pure.ts`. Three guarantees, each pinned by a test
and each checked by mutation:

- **Results come back in input order**, whatever order they finish in.
- **One item's failure is that item's failure.** Every result is settled. The
  loops this replaces all wrapped their body in try/catch and pushed onto an
  `errors` array; `Promise.all` would have discarded every sibling's work,
  including rows already written. "8 of 10 synced, 2 named" is the behaviour
  these functions had, and losing it would be a regression dressed as a
  speed-up.
- **Work already started always finishes.** `stop` is asked before a task
  *starts* and never cancels one in flight, because these tasks write to the
  database — cancelling mid-flight leaves a conversation row with no messages
  and nothing saying it is short. A wall-clock budget drains rather than
  truncates, which is why a caller's deadline must leave room for the slowest
  in-flight item.

`startedCount` is what a resumable caller adds to its cursor. It is a count and
not an index: with out-of-order completion no single index means "everything
before here is done", but "the first N were all started" stays true, because
tasks are started in order.

## What did not change

No vendor limit was raised and no safety was removed. The GHL limiter is the
*same* bucket the nine migration workers already share, so this adds callers to
an existing budget rather than inventing a new one — and it is strictly safer
than what it replaces, because a fixed sleep never knew about a 429 and this
does. Every error path, every non-destructive-update rule, every duplicate
guard and every resume cursor is preserved; the tests and this document exist
to say which ones and why.

## Three things the first pass got wrong, found by watching it run

Everything above was measured before the change. These three were measured
**after** it, from the prime's own function logs and the deploy ledger — and
each of them reported as ordinary operation from every surface except the one
that was actually looked at.

### 5. There is a THIRD conversation sync, and it is the one on the cron

The first pass un-slept `sync-ghl-conversations` and `ghl-conversations-cron`.
It missed `conversation-sync-cron`, which is what pg_cron actually fires every
ten minutes.

Measured on the prime, 13 Sep 2026, five consecutive runs of the same 56
contacts:

| start | finish | elapsed |
|---|---|---|
| 06:00:08 | 06:02:24 | 136s |
| 06:10:00 | 06:12:14 | 134s |
| 06:20:00 | 06:21:49 | 109s |
| 06:30:01 | 06:32:06 | 125s |
| 06:40:01 | 06:42:15 | 134s |

`await delay(500)` per contact is 28 seconds of the first number before a
single request is made, and `await delay(300)` per conversation adds more on
top. It now works six contacts at a time through `mapWithConcurrency`, paces
every call through `ghlFetchShared`, and stops **starting** contacts at a
wall-clock budget while what is in flight finishes and is kept.

Stopping is safe here for a specific reason: the contact set is re-derived
from the database on every tick, so a contact this run did not reach is
picked up by the next one. There is no cursor to leave stale.

A sweep of the other twelve edge functions that still call `delay()` found
**none of them on a cron** — they are one-off backfills, legacy migration
tools, and the report generators, which pace against model APIs for reasons
of their own.

### 6. The backfill boundary was sent to Graph exactly as Postgres wrote it

`received_at` comes back from PostgREST as `2025-11-24T01:11:04`, with no zone
designator, and OData refuses it:

```
Invalid filter clause: The DateTimeOffset text '2025-11-24T01:11:04' should be
in format 'yyyy-mm-ddThh:mm:ss('.'s+)?(zzzzzz)?'
```

Every backfill tick on the prime between 05:44 and 06:50 answered 400 on that.

`graphDateTimeOffset` renders it where the filter is built, so no caller can
get it wrong. Two things about it are deliberate. **The zone is appended, not
inferred** — ECMAScript parses a date-*only* form as UTC and a date-*time*
form with no offset as **local** time, so letting the runtime decide would
make the boundary depend on where the function happens to run. And **a
boundary that was asked for and cannot be rendered is refused, never
dropped**: dropping it returns the *newest* page instead of the oldest, so
every row is one already held, no history is ever reached, and the walk
reports pages fetched the whole time. That is the silent version of the same
bug, and the worse one.

### 7. A failed history walk took the live mail sync down with it

This is the one that cost something. The boundary **read** was guarded from
the first version — *"never fail the tick over the backfill, the incremental
sync is the job this function is scheduled for"* — but the **fetch** was not.
Graph's 400 propagated out of the handler and the thirty messages the
incremental pass had already retrieved were discarded with it:

```
[Email Sync Cron] Starting background email sync...
[Email Sync Cron] Fetched 30 recent inbox emails
[email-sync-cron] internal_error correlation_id=… Graph returned 400: …
```

`email_copilot_emails` took **nothing for sixty-five minutes** — 0 rows
inserted, measured. A history walk nobody asked for had taken the mail
delivery down.

The opportunistic half is contained now: it can fail, and what fails is the
backfill. `history_complete` stays null on a failed walk, which the response
already distinguishes from "there is nothing older" — **a walk that failed
must never be reported as one that finished.**

The rule the three of them share: *an optimisation may not be the reason the
thing it optimises stops working.*

## Getting the change onto a clone is its own problem

Worth knowing if a clone looks like it did not receive this. The clone's own
`deploy-supabase-functions.yml` **deploys nothing** — it resolves the project,
writes a job summary listing every candidate function, and hands off to
Mission Control, which holds the only credential that can deploy. A green
15-second run there is the hand-off working, not a deployment.

Mission Control's `edge_function_deploy` lane walks the bundles alphabetically
in budgeted passes and re-reads the prime's HEAD on **every** pass, while
marking "already delivered" against the run's *start time*. A run that spans a
prime merge therefore deploys its early letters from one tree and its late
ones from another, and reports the whole thing as deployed. Measured on
`npc-client-dashboard`: `email-sync-cron` (05:16), `ghl-conversations-cron`
(05:30), `ghl-calendar` (05:32) and `import-clients-from-ghl` (05:34) landed
from the tree before the 05:38 merge; `outlook-email-sync` (05:48) landed from
the tree after it. Fixed in Mission Control by `planDeployGeneration`, which
restarts the generation when the observed revision moves.
