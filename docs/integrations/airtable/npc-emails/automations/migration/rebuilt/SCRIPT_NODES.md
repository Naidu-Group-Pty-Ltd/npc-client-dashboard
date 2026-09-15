# The five script nodes — what is done, and the paste

Base `appFNPL7iYiuQyHAO`. Four automations are **structure only**: the
`customScript` nodes they need are still missing, because the API will not
author one. Everything around them that *could* be done from here has been.

## The API still refuses, and that was re-tested rather than assumed

The accounts are now paid, so the refusal recorded in [`README.md`](./README.md)
was re-tested on **2026-09-15** against `update_automation` on the live base. It
still refuses, verbatim:

```json
{"isValid":false,"errors":[{"node":"wacVt0l4TPWwuWYNx","message":"readOnlyNodeType",
 "details":{"kind":"readOnlyNodeType","providedNodeType":"customScript"}}]}
```

**A minimal node is refused identically** — fresh key, no `inputObj`, no
`outputSchema`, body `console.log(1);`. Same error, same `kind`, naming the
*type*. It is not payload shape. **The failed call wrote nothing**:
`update_automation` replaces the whole draft, so a partial write would have
flattened the automation, and `get_automation` afterwards returned the prior
configuration byte for byte. Validation is atomic and runs before the write.

**Paid plan is not the variable.** Scripting automations exist on every Airtable
tier and this base already has `create` permission; the limit is in the MCP
automation API, not the licence.

Worth recording because it is misleading: the tool *schema* advertises support.
`customScript` is in the creatable `type` enum, `outputSchema` and `secrets` are
both documented "For customScript actions only", and it is **absent from the
spec's own "Exists but not creatable here" list**. Every readable signal says yes
and the server says no — which is why this was settled by effect. Re-probe with
the minimal node above rather than re-reading the catalog.

## Done from here on 2026-09-15

| | |
| --- | --- |
| Defect 1 — four recipient addresses with a leading space | **fixed in the live base** and verified against the sibling automation, which carries the same five without spaces |
| Defects 2 and 3 | fixed in the **script files**, which is the only place they can be fixed — see below |
| All four automations' descriptions | rewritten in the live base to say what is missing and which file to paste |
| Paste-ready script bodies | written as `*.PASTE.js`, headers stripped, input variables named |

Everything below is UI work.

## A correction: the id map was never incomplete

[`README.md`](./README.md) says `_id-map.json` "covers 24 of the 54 ids the
bundle references" and that the rest "belong to `Properties`,
`Property Intake Master` and the extra `Aurixa Waitlist` columns". **That is
wrong, and an earlier version of this file repeated it.** Counted:

- `id-references.json` holds **54** ids: 1 base, 6 tables, 37 fields, **10
  automations**.
- `_id-map.json` holds **44**: the base, all 6 tables, all 37 fields.
- **Zero `tbl…` or `fld…` ids are unmapped.** The 10 left over are `wfl…`
  *automation* ids, which are not remappable references — each rebuilt
  automation was minted a fresh id, already recorded in this directory's README.

So there is nothing to extend before the script-bearing automations can be
finished. All three tables they touch are mapped:

| Table | Legacy | Rebuilt |
| --- | --- | --- |
| `Properties` | `tblH9cW4EhVs6D5H1` | `tbl7JAawCPdd8QPZP` |
| `Property Intake Master` | `tblWIg5cs85O30pcY` | `tblumTIRYBn92B2ST` |
| `Aurixa Waitlist` | `tblHzGiB591W3GpoZ` | `tblaSuqLKa00rqdtu` |

Those three were also re-derived independently, by reading them back off the
live rebuilt automations, and agree with the map exactly.

## The property-intake clock is real, and it is harmless

`Delete Property Intake Records After 30 Days` filters on `Created Time`, which
in this base is a `CREATED_TIME()` formula minted at migration. All **148** rows
therefore read `2026-08-18T13:20:37` and come due together on **2026-09-17** —
the first run purges every one of them at once.

**That costs nothing, and the earlier version of this file was wrong to lead with
it as a hazard.** Those 148 rows are empty shells. The migration wrote at most
**one** populated field on any record and only 51 of 148 had even that; a live
read returns nothing but formula output (`"|||"`,
`"Unknown Property Intake Record"`) and the migration timestamp. No address, no
price, no sender, no image.

And the clock is only wrong for the migrated rows. Any record written after
cutover gets a genuine `CREATED_TIME()`, so **once the 148 are gone the
automation is correct as configured**. There is no better column to re-point the
filter at — the migration wrote no true-origin date, because it wrote almost no
fields at all.

Still leave it off until this base is actually taking intake. It is not.

## 1 — `wflz5O9df5UjBzd3X` · Delete Records After 30 Days

Run script inside the loop `wdeD53LsVujdzIcyR`, which is empty.

| Input variable | Value |
| --- | --- |
| `recordId` | the loop's current item → **Airtable record ID** |
| `tableId` | `tbl7JAawCPdd8QPZP` |

Paste [`delete-records-after-30-days.PASTE.js`](../../scripts/delete-records-after-30-days.PASTE.js).
Safe to enable: `Properties` holds 0 records.

## 2 — `wflOrWaQohUvhvcFb` · Delete Property Intake Records After 30 Days

Same shape. Loop `wde3USh8klqOZAuRt`, `tableId` = `tblumTIRYBn92B2ST`, paste
[`delete-property-intake-records-after-30-days.PASTE.js`](../../scripts/delete-property-intake-records-after-30-days.PASTE.js).
Read the clock section above before enabling.

## 3 and 4 — `wflEQ1wsJH1x7GQhL` · Aurixa Lead Capture

**One script, not two.**

**First script** — paste
[`aurixa-lead-capture-token.PASTE.js`](../../scripts/aurixa-lead-capture-token.PASTE.js),
one input variable `recordId` bound to the **trigger record's** Airtable record
ID. Everything else it addresses by name, so no id remapping applies.

### Defect 3 is real, and it is not where the snapshot said

The snapshot called the Stage-2 gate token "guessable, not secure" and a
`crypto.getRandomValues` version of this script was written to fix it. **Airtable
refused it**, measured by running it on 2026-09-15:

```
Error: crypto.getRandomValues is unavailable in this scripting runtime.
```

Airtable's automation script sandbox exposes no CSPRNG. The Scripting
*extension* runs in the browser and does; automation **actions** do not. So
there is no way to mint a strong token from inside Airtable.

**That matters less than it looks, because nothing checks the token.**
`aurixa-systems/src/lib/questionnaireLinkAccess.ts` gates `/questionnaire` and
says so in its own header: *"This is not an authorisation boundary, and cannot
be made into one."* It tests only that the token is SHAPED like one — 16+
URL-safe characters — and that `expires` is a future date. So
`?token=aaaaaaaaaaaaaaaa&expires=2030-01-01` already opens the form to anyone
who types it. Raising this script's entropy would change nothing about who gets
in: it is a stronger lock on a door that is not latched.

**The correct system exists and was never switched on.**
`aurixa-systems/supabase/functions/readiness-questionnaire/index.ts` — 616 lines,
**not deployed**, its migration **not applied** — mints tokens from 32 bytes of
CSPRNG, stores only their SHA-256, returns the raw value exactly once to the
caller that emails it, exchanges it through `authorise`, and answers unknown,
revoked and mismatched tokens identically so it cannot be used to probe whether
an application exists.

So the shipped file is **deliberately the legacy behaviour, unchanged**. Pasting
it is parity with the source base, not a regression — the exposure it carries is
the one production already has. Do not "improve" the RNG here; it is the wrong
layer. **When `readiness-questionnaire` is deployed this script should be
DELETED**, because minting the token stops being Airtable's job.

The one thing the file does fix is the wording: the source's comment called this
"secure, pseudo-random". It is neither, and the new comment says what it is.

**Second script — do not add it.** Defect 2 is that it busy-waits rather than
sleeping, and its comment says 60 seconds while `delayDuration = 10000` says ten.
The deeper point is that it is the **last node in the automation and nothing
follows it**, so nothing waits on what it waits for: it blocks the automation
runtime for ten seconds and then the run ends. It is the one node here whose
omission changes no behaviour. No corrected version is shipped, because a
correct version of a no-op is still a no-op.

**Defect 1 is already fixed** — the four recipient addresses that carried a
leading space were trimmed in the live base on 2026-09-15 and now match the five
on `Notify Aurixa Team on New Business Readiness Submission` exactly.

## 5 — `wflIvnXu2Jcs7eQ95` · Auto-generate report

Delete the placeholder `findRecords` (`wacM5IrEzCPRTTWDy`) inside the conditional
branch and put a Run script in its place, pasting
[`auto-generate-report.PASTE.js`](../../scripts/auto-generate-report.PASTE.js) —
which names all ten input variables, including `webhookSecret`.
[`AUTO_GENERATE_REPORT.md`](./AUTO_GENERATE_REPORT.md) carries the longer
reasoning and is still the file to read.

**Check before pasting.** Verified 2026-09-15 against the function source:
`auto-report-webhook` still reads `x-webhook-secret` and constant-time compares
it against `AUTO_REPORT_WEBHOOK_SECRET`, with `verify_jwt = false` at the
gateway. Its own comment records that **when `AUTO_REPORT_WEBHOOK_SECRET` is
unset the secret path is unavailable** — so if it is not set in the Supabase
project, nothing this script sends can authenticate and the automation cannot
work whatever is pasted. Confirm it is set first. That is the one thing here
nobody can check from outside the project.

## When all five are in

Nothing here is deployed, and none of the edits above changed that — every
automation in this base is still `undeployed`. Two of them send email to five
real addresses and one deletes permanently. Turn them on one at a time, after a
test run, in the order above.
