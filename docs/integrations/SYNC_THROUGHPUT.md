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
