# The five script nodes — re-verified, and the paste runbook

Base `appFNPL7iYiuQyHAO`. Four automations are **structure only**: the
`customScript` nodes they need are still missing. This file is what to do about
that, with every id already resolved so the UI work is paste-only.

## The API still refuses, and that was re-tested rather than assumed

The accounts are now paid, so the refusal recorded in
[`README.md`](./README.md) was re-tested on **2026-09-15** against
`update_automation` on the live base. It still refuses, verbatim:

```json
{"isValid":false,"errors":[{"node":"wacVt0l4TPWwuWYNx","message":"readOnlyNodeType",
 "details":{"kind":"readOnlyNodeType","providedNodeType":"customScript"}}]}
```

Two things make that conclusive rather than a bad payload.

**A minimal node is refused identically.** A second attempt sent a fresh key, no
`inputObj`, no `outputSchema`, and a one-line body (`console.log(1);`). Same
error, same `kind`, naming the *type*. The refusal is on `customScript` itself,
not on anything in the node.

**The failed call wrote nothing.** `update_automation` replaces the whole draft,
so a partial write would have flattened the automation. `get_automation`
afterwards returned the prior configuration byte for byte. Validation is atomic
and runs before the write — a rejected payload is safe to retry.

**Paid plan is not the variable.** Scripting automations exist on every Airtable
tier and this base already has `create` permission; the limit is in the MCP
automation API, not the licence. Upgrading again will not move it.

Worth recording because it is misleading: the tool *schema* advertises support.
`customScript` is in the creatable `type` enum, and `outputSchema` and `secrets`
are both documented "For customScript actions only". It is also **absent from
the spec's own "Exists but not creatable here" list**, which names only
`slackSendActionableMessage`, `googleSheetsCreateRow`, `googleFormsCreateResponse`,
`salesforceCreateRecord`, `salesforceUpdateRecord` and `googleDocsUpdateDoc`.
Every readable signal says yes and the server says no — which is why this was
settled by effect. A future session should re-probe with the minimal node above
rather than re-reading the catalog.

## Read this before you finish the property-intake purge

`Delete Property Intake Records After 30 Days` **is armed by the calendar, and
the date is now.** Measured on the live base 2026-09-15:

- `Property Intake Master` holds **148** records.
- Every one carries `Created Time` = `2026-08-18T13:20:37.000Z`. That column is a
  `CREATED_TIME()` formula minted at migration, so it dates the copy, not the
  record — their true origin is 2026-07-23 to 2026-08-04.
- The filter is `Created Time < 30 days ago`. Thirty days after 2026-08-18 is
  **2026-09-17**.

So completing and enabling this automation purges **all 148 rows in one run, two
days from now**, and the loop deletes without a second look. Finish the other
three first. For this one, either leave it off until the retention question is
decided, or change the filter to something that dates the *record* rather than
the copy — there is no third option that both runs and is safe.

The sibling purge is harmless by comparison: `Properties` holds 0 records and
nothing writes to it.

## Table ids — the 30 the id map never covered

[`README.md`](./README.md) notes `_id-map.json` resolves 24 of the 54 referenced
ids, and that the rest "belong to `Properties`, `Property Intake Master` and the
extra `Aurixa Waitlist` columns that only the four script-bearing automations
touch". The three table ids among them are resolved here, read back from the
live rebuilt automations rather than inferred:

| Table | Legacy (`apptyShYE0yzL4IGB`) | Rebuilt (`appFNPL7iYiuQyHAO`) |
| --- | --- | --- |
| `Properties` | `tblH9cW4EhVs6D5H1` | `tbl7JAawCPdd8QPZP` |
| `Property Intake Master` | `tblWIg5cs85O30pcY` | `tblumTIRYBn92B2ST` |
| `Aurixa Waitlist` | `tblHzGiB591W3GpoZ` | `tblaSuqLKa00rqdtu` |

They are not folded into `_id-map.json` on purpose: that file is the exact
substitution that produced the five API-created automations, and extending it
would stop it being a record of what was actually sent.

## 1 — `wflz5O9df5UjBzd3X` · Delete Records After 30 Days

Put a **Run script** inside the loop `wdeD53LsVujdzIcyR`, which is empty.

| Input variable | Value |
| --- | --- |
| `recordId` | the loop's current item → **Airtable record ID** |
| `tableId` | `tbl7JAawCPdd8QPZP` |

Body — [`delete-records-after-30-days.wacVt0l4TPWwuWYNx.js`](../../scripts/delete-records-after-30-days.wacVt0l4TPWwuWYNx.js),
minus its header comment. The header says the API cannot author a script node,
which is true of the API and false of the box you are pasting into.

Safe to enable: the table holds 0 records.

## 2 — `wflOrWaQohUvhvcFb` · Delete Property Intake Records After 30 Days

Same shape. Loop `wde3USh8klqOZAuRt`, same two variables, `tableId` =
`tblumTIRYBn92B2ST`, same body. **Do not enable it** — see the date warning above.

## 3 and 4 — `wflEQ1wsJH1x7GQhL` · Aurixa Lead Capture

Two Run script actions, after the existing email `wacuQvJSp0tGlWStY`.

**First** — [`aurixa-lead-capture.wac6IfuZM2bkLGqk2.js`](../../scripts/aurixa-lead-capture.wac6IfuZM2bkLGqk2.js).
One input variable, `recordId`, bound to the **trigger record's** Airtable record
ID. It addresses everything else by name (`base.getTable("Aurixa Waitlist")`,
`"Token"`, `"Bypass URL"`), so no id remapping applies.

**Second** — [`aurixa-lead-capture.wac0NVTbcAAOXQsdM.js`](../../scripts/aurixa-lead-capture.wac0NVTbcAAOXQsdM.js),
no input variables. **Consider not adding it at all.** It is a busy-wait and it
is the *last* node in the automation, so nothing waits on what it waits for: it
blocks the automation runtime for ten seconds and then the run ends. It is the
one node here whose omission changes no behaviour. If it is added, it is carried
for fidelity, not for effect.

The three defects [`README.md`](../../README.md) recorded are still unfixed and
should be fixed deliberately while the nodes go in:

- Four of the five recipient addresses on the email above carry a **leading
  space** (`" rugesh@…"`, `" lavan@…"`, `" arvinraj@…"`, `" mithrubanbupathy@…"`).
  The sibling automation `Notify Aurixa Team…` has the same five without them.
- The second script's comment says 60 seconds; `delayDuration = 10000` says ten.
- The Stage-2 gate token comes from `Math.random()` while the comment calls it
  "secure, pseudo-random". That token is what guards the questionnaire URL, so it
  is a guessable access token. `Math.random()` is not a CSPRNG.

## 5 — `wflIvnXu2Jcs7eQ95` · Auto-generate report

Delete the placeholder `findRecords` (`wacM5IrEzCPRTTWDy`) inside the conditional
branch and put a **Run script** in its place. Nine input variables, the corrected
body, and the secret handling are all in
[`AUTO_GENERATE_REPORT.md`](./AUTO_GENERATE_REPORT.md) — follow that file, not
this one, and use `auto-generate-report.CORRECTED.js` rather than the verbatim
export beside it.

## When all five are in

Nothing here is deployed. Each automation is `undeployed` and stays that way
until somebody turns it on, and the two that send email reach five real
addresses while one of the purges deletes permanently. Turn them on one at a
time, after a test run, in the order above.
