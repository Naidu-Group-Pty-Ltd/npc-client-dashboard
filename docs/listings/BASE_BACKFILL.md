# Backfilling the rebuilt base — and why the cutover needs it first

Read this before running `npm run listings:backfill-intake`, before activating
any of the six re-pointed `NPC Email` / Aurixa scenarios in the new Make
account, or before changing which Airtable base the product reads.

## Where this stands

| | |
| --- | --- |
| Live base | `apptyShYE0yzL4IGB` — growing, and what the product serves today |
| Rebuild | `appFNPL7iYiuQyHAO` — a copy taken 2026-08-18, in a **different** Airtable account |
| `Property Intake Master` in the rebuild | **2 records** as of 2026-09-15 |
| `Aurixa Waitlist` in the rebuild | **10 records**, all stamped `2026-08-18T13:22:03` — untouched since the copy |
| Live rows in `listings_cache` | **171** (plus 51 archived) |

The 148 migrated `Property Intake Master` shells were **deleted on 2026-09-15**.
They were empty by construction — the migration wrote at most one populated
field on any record and only 51 of 148 had even that, so a live read returned
nothing but formula output (`"|||"`, `"Unknown Property Intake Record"`) and the
migration timestamp. Removing them cost nothing and retired the 2026-09-17 purge
clock that `SCRIPT_NODES.md` used to lead with.

What is in the table now is two real listings: a pilot written at 07:24
(`79 Woodlands Road`, Gatton) and one record written by the backfill script's
validation run at 08:34 (`19 Stanley Street`, Tweed Heads, carrying the stamp
described below). **Neither came from Make** — `NPC Email 1 New` is inactive in
the new account and has no execution history there.

## Why the backfill is the safe half of the cutover

The obvious reason is the one `MAKE_CUTOVER.md` already gives: activating the
re-pointed intake scenarios moves listing intake to a base nothing reads.

The sharper reason costs data. `listings_cache` is an **archive**
([`../integrations/AIRTABLE_RETENTION.md`](../integrations/AIRTABLE_RETENTION.md)),
and `planReconciliation` really deletes a cached row that vanished from the
source table **while still inside** the retention window. Re-pointing the sync at
a base that does not hold today's listings presents all 171 live rows as
vanished at once.

That is survivable — the destructive half carries its own 10% cap, so a batch
that large is archived rather than part-deleted, and archiving is reversible —
but the marketplace still empties, and it empties without anything reporting it.
Backfilling first turns the cutover from an incident into a decision.

**The backfill does not decide the cutover, and running it commits to nothing.**
It only makes the rebuild hold what the product already serves. It is reversible
in one command (`--undo`).

## What travels

The include set is **the columns the product actually reads** —
`INTAKE_FIELDS` in
[`airtableIntakeFields.pure.ts`](../../supabase/functions/_shared/airtableIntakeFields.pure.ts),
the one place intake column names live — plus a provenance set naming where each
row came from. The script parses that module at runtime rather than keeping a
second copy, because a second copy of these names is exactly the defect that
module's header was written to prevent.

Measured over the 171 live rows on 2026-09-15:

| | Bytes |
| --- | ---: |
| Every column the cache holds | 3,327,176 |
| …of which `Email Body Plain Text` alone | 2,540,658 (76%) |
| Product-read columns only | 302,703 |
| **Product-read plus provenance** | **384,571** |

Carrying everything would multiply the transfer roughly ninefold to move columns
no reader opens — the raw AI output, the parsed JSON, the email bodies, the
extraction telemetry. 164 distinct keys exist in the cache; 120 of them map to a
writable target column.

## What cannot travel, and why

Excluded by reading the **target's own schema** rather than by a hardcoded list,
so a schema change cannot silently reintroduce them:

- **Computed columns** — `formula`, `rollup`, `count`, `autoNumber`,
  `createdTime`, `lastModifiedTime`. The consequential one is `Created Time`,
  which in the rebuild is a `CREATED_TIME()` formula minted at migration. **A
  copied row is therefore stamped with the moment it was copied, not with when
  the listing arrived.** That is why the provenance set carries
  `Email Received At`, `Email Sent At` and `First Seen At`: the true origin dates
  survive in columns that can hold them, and `Email Received At` is the honest
  retention basis the schema's own description already recommends.
- **Attachments** — `Listing Images`, `Floorplan`, `Brochure`,
  `Additional Attachments`. An Airtable attachment URL expires within hours (the
  `Listing Image URLs` column description says so itself), so copying them writes
  links that are already dead. The durable URLs in `Listing Image URLs` and
  `Primary Image URL` do travel.
- **Collaborators** — `Assignee`, `Reviewed By`. A user id from one Airtable
  account names nobody in another.

`typecast: true` is set on every write. The rebuild's select options came from
the legacy schema and the live data has moved on, so an option that exists in
production but not yet in the rebuild is created rather than rejected — refusing
it would silently drop the column instead.

## Idempotency, and the undo

Every written record is stamped in `Internal Notes` — a column intake never
writes — as:

```
backfill:listings_cache:<listing_id>:<iso date>
```

The script reads those stamps back before writing and skips any source row
already present, so a run interrupted halfway resumes rather than duplicating.
The same stamp is the undo key: `--undo` deletes exactly the records carrying it
and leaves anything intake wrote alone.

`--verify` re-reads the target and reports any source row that is missing and any
copied cell that did not land.

## Credentials

The rebuild is in a different Airtable account, so the pipeline's own token
cannot reach it — **a personal access token reaches only its own account's
bases**, which is why a perfectly valid token is refused across this boundary and
why the first question on a 401 here is which account minted it.

The script therefore takes its own, under names that collide with none of the six
reserved pipeline names in `listingsPipelineSecrets.pure.ts`:

```sh
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
AIRTABLE_REBUILD_TOKEN=pat… AIRTABLE_REBUILD_BASE_ID=appFNPL7iYiuQyHAO \
  npm run listings:backfill-intake:dry-run
```

Then drop `:dry-run` to write, and `:verify` afterwards. The token needs
`data.records:write` and `schema.bases:read` on that base alone.

## Why this is a script and not something the migration already did

The copy was first attempted by relaying records through an assistant's tool
calls. That is not a sound mechanism for 171 records into a system of record:
the payload is ~660 KB of machine-generated JSON, reproducing it by hand invites
a transcription error inside a URL or a truncated string, and the error would be
invisible until somebody opened the wrong listing. A script reads the source and
writes the target with nothing in between, is re-runnable, and can verify its own
work — which is the only way to be sure the copy is faithful.

The one record written during validation proves the path end-to-end: 92 fields,
every select coerced, every date parsed, the stamp applied. It is left in place
deliberately, and the next run will skip it.
