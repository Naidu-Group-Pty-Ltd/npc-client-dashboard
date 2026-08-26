# CLAUDE.md

Guidance for Claude Code (and Claude-based tools) working in this repo.

## Read first
- **Frontend / UI work → [`FRONTEND_TOOLING.md`](./FRONTEND_TOOLING.md)** is the
  cross-tool source of truth. It defines the installed frontend packages and the
  non-negotiable UI rules. Use it for anything touching `src/` UI.
- **Backend / security / AML →** [`AGENTS.md`](./AGENTS.md) and
  [`AGENTS_NPC_Property_Dashboard.md`](./AGENTS_NPC_Property_Dashboard.md).

## Installed tooling (already wired for Claude Code)
- **Claude Design** — the **NPC Services Design System** project at
  [claude.ai/design](https://claude.ai/design), reached with the built-in
  **DesignSync** tool. It is the source of the brand: read `tokens/colors.css` and
  `tokens/typography.css` from it before choosing any colour or typeface, and push
  cards back one at a time (never wholesale-replace). Details in
  [`FRONTEND_TOOLING.md`](./FRONTEND_TOOLING.md).
- **MCP servers** — [`.mcp.json`](./.mcp.json): `shadcn`, `chrome-devtools`,
  `@21st-dev/magic`, `21st` (hosted HTTP). Setup and the `MAGIC_API_KEY` /
  `TWENTY_FIRST_API_KEY` steps are in [`MCP_SETUP.md`](./MCP_SETUP.md).
- **Skills** — [`.claude/skills/`](./.claude/skills/): **`npc-services-design`** (the
  brand itself — colours, type, logo marks, voice, and the print rules for generated
  reports), `frontend-design` (aesthetic direction) and `web-design-guidelines`
  (accessibility / UX review).

## Listings intake (Airtable + Make)
Everything on the Listings page arrives through one Make scenario, **NPC Email 1**, which
reads a mailbox and writes Airtable's **Property Intake Master** (205 columns, base
`NPC Emails`). Read [`docs/integrations/NPC_EMAIL_1_AUDIT.md`](./docs/integrations/NPC_EMAIL_1_AUDIT.md)
before touching intake, the projection in `_shared/airtableListing.pure.ts`, or anything to
do with listing photographs — it records 22 defects found in that scenario, including the
two that meant the page had never received a single photo, and it names the columns the
dashboard now depends on. Retention is its own concern and the one that emptied the page. Read
[`AIRTABLE_RETENTION.md`](./docs/integrations/AIRTABLE_RETENTION.md) before
touching `planRetention`, `planReconciliation` or the reconciliation step in
`listings-cache`. Airtable prunes `Property Intake Master` at 30 days and that
is correct — **`listings_cache` used to MIRROR the prune**, which put the whole
marketplace on a thirty-day fuse: 148 listings on 2026-08-19 were 51 by
2026-08-26 and would have been 0 on 2026-09-04, unrecoverably, because nothing
else in the database can rebuild a listing. The cache is now an **archive**: a
row that aged out is kept and stamped `archived_at`, a row that vanished while
still inside the window is really deleted, and an undated one is kept. Two rules
bite. **`planReconciliation`'s two allowances are ANDed**, so on a small table a
walk that returned 26 of 148 records would be acted on in full — the destructive
half has its own 10% cap, and past it the batch is archived rather than
part-deleted, because archiving is reversible and deleting is not. And **the
purge is asserted by its effect, never by its configuration**: the live base is
not reachable by the Airtable token this repo's tooling holds, so every sync
records `oldest_live_created_time` / `retention_effective` instead.

The scenario that is actually **switched on** is `NPC Email 1 New` (Make id `9618493`); the
audited `NPC Email 1` (`6720116`) is off. Listings reach it *forwarded* by NPC staff rather
than sent by agents, and that broke who a listing belongs to — every record it wrote named a
colleague as the agent. Read [`FORWARDED_SENDER.md`](./docs/integrations/FORWARDED_SENDER.md)
before touching `Sender Email`/`Sender Name`, the contact fallback in
`_shared/listingContact.pure.ts`, or anything that decides who to email about a listing. It
also records the one rule that keeps biting: an address on our side of the pipeline is never
the answer, in any column.

Photographs are a separate concern from intake, and the one place a listing can
contradict itself on screen. Read
[`IMAGE_LIBRARY.md`](./docs/listings/IMAGE_LIBRARY.md) before touching
`_shared/listingImage*.pure.ts`, `signStoredImages`, `harvestListing` or
`useListingGallery`. **`imageIdentity` answers "same URL"; a gallery needs "same
picture"**, and the two diverge constantly — 240 of 4,807 stored rows were a
second copy of a photograph the same listing already held, one listing carrying
35 rows of four pictures. De-duplication is three layers (checksum → asset key →
perceptual signature), absent evidence never merges, and the guarantee is
enforced on the **read** path as well as the write path, because the table will
always accumulate copies and a repair migration has to be dispatched by hand.

**The server looks at the photographs now, and that is the point.** Visual
classification used to run only in a browser, only after the card had drawn — so
the most consequential decision here, *which image leads a listing*, was taken
with no visual information at all: 6 of 16 sampled heroes were floor plans, 5 of
those served from opaque Google Drive ids no URL rule can read.
`listingImageVision.pure.ts` is the one implementation of that judgement, its
thresholds are measured (21 labelled production images, 21 correct), and the
verdict is stored so every surface gets it before the first paint. Decoding is
**budgeted, not counted** — ~116 ms of CPU each against an Edge Function's
allowance — and the decoder import is lazy so `resolve` pays nothing.

The other half is a question no single image can answer: **is this photograph
even of this property?** 3,035 of 4,841 rows are a picture some other listing
also holds and 279 of 471 listings LED with one. `listing_image_reuse` answers
it and `bandOf` demotes it.

Three rules bite. An asset key is **only ever compared within one listing**,
which is what makes its filename rule safe. Ordering **demotes and never
promotes** — a filename-hint version of "pick the best photo" promoted an agency
logo over the photograph on two real listings, because a logo lockup is called a
*main* lockup. And **demotion is a sort, never a filter**: a listing whose whole
gallery is shared, or is entirely furniture, keeps every image in its own order,
which is why nothing here can blank a card.

One property can also arrive as several records. Read
[`DUPLICATE_RECORDS.md`](./docs/listings/DUPLICATE_RECORDS.md) before touching
`_shared/listingDuplicates.pure.ts` or `propertyDataService.buildResult`: the
marketplace was showing **148 listings for 107 properties** because the intake
scenario re-processes a message it has already written — `14 Yillowra St` exists
four times, three minutes apart, from one forwarded newsletter. `airtable-proxy`
has always TAGGED duplicates and deliberately removed none, leaving the decision
to the client, and no client ever made it. The rule that makes it is **address +
price + type + beds + land**, and the constraint is that **an address with no
street number is never a key** — eleven different City Beach properties share
one, because their street numbers never got extracted, and merging on address
alone deletes nine real listings.

Column names for that table live in `_shared/airtableIntakeFields.pure.ts` and nowhere else.
Airtable returns `undefined` for a column that does not exist exactly as it does for one
that is empty, so a mistyped name is invisible — that file's header records what that cost
last time.

## What the API gateway checks (`verify_jwt`)
Read [`docs/security/VERIFY_JWT.md`](./docs/security/VERIFY_JWT.md) before
changing a `verify_jwt` line in `supabase/config.toml`, the deploy workflow's
changed-function list, or a function's own auth check. **An omitted
`[functions.X]` block is not "no opinion"** — the CLI reads it as `true`, which
asserts the gateway is checking a Supabase JWT in front of that function; it was
wrong for 91 of 425, and `check-verify-jwt-declared.mjs` now fails CI on a
missing declaration.

Two rules bite. **A preflight is not a `verify_jwt` probe** — the gateway exempts
`OPTIONS` and enforces on the real request, so a guarded function answers its
preflight normally; every wrong conclusion in this area came from reading a 200
(or a 503, which was a boot failure) as evidence about the gateway. Ask the
Management API instead. And **a config-only edit used to deploy nothing**,
because the changed-function list was built from `supabase/functions/**` paths
alone — which is how a declaration and production came to disagree at all.

## Workflow Playground (the automation canvas)
Read [`docs/workflows/DISPATCH.md`](./docs/workflows/DISPATCH.md) before touching
the run engine, the trigger-capture triggers or the dispatcher. One engine serves
three callers — a test run, a live run a person starts, and a workflow a captured
event dispatches with nobody watching — so it lives in
`supabase/functions/_shared/workflow/` and `src/lib/workflow/*` are one-line
shims onto it. Those modules must parse under Deno: no `@/` aliases, explicit
`.ts` extensions.

Two things the doc records that keep biting. **Nothing is captured unless a live
workflow listens for it**, so an empty `workflow_trigger_events` on a deployment
with no live workflows is correct rather than broken. And **what can run live is
derived from the catalog, never listed**: an operation is runnable because it
declares a `request` descriptor (`httpRequest.pure.ts`), so adding a vendor is a
declaration beside the operation rather than a change to the executor — and a
new vendor call that skips `_shared/meteredFetch.ts` is billed to nobody.

## API usage metering (this deployment may be spending someone else's money)
A workspace provisioned by Aurixa Mission Control boots with the **prime's own
vendor keys** forwarded into its Supabase project — OpenAI, Resend, Domain,
Cotality, Lovable — so every model token and property lookup it makes is billed
to the prime's accounts and recharged per tenant. A key the workspace supplies
itself is charged at nothing. Read
[`docs/integrations/API_USAGE_METERING.md`](./docs/integrations/API_USAGE_METERING.md)
before touching `_shared/logApiUsage.ts`, adding a vendor API call, or changing
`service_name` on an existing one: an unmapped service is metered here and
**never billed**, because guessing which credential a call spent bills the wrong
tenant. The map is `_shared/apiUsageBilling.pure.ts` and nowhere else.

New vendor calls should use `_shared/meteredFetch.ts` rather than `fetch` — it
resolves the credential from the URL and logs the call itself, so metering
cannot be forgotten. Never add it to a call site that already calls
`logApiUsage` for the same request: that bills the tenant twice, which is worse
than not billing.

**Model calls are metered by `_shared/llmRouter.ts` itself**, which is why
`meterUsage` exists and why it **defaults to true** — 19 of the 25 edge
functions that call the router were spending a forwarded key for free, and an
omitted flag must never mean unbilled. Only the six functions that log
adjacently to their own call pass `meterUsage: false`. The credential a
`(route, modelId)` pair spends is resolved by `_shared/llmUsageBinding.pure.ts`,
which mirrors the router's dispatch and returns **null** rather than guessing; a
CI test reads the router's source and fails when the two drift.

## The Commercial & Industrial Analysis Workspace
`/calculators` is one guided workspace, not nine calculator cards. Read
[`docs/commercial/ANALYSIS_WORKSPACE.md`](./docs/commercial/ANALYSIS_WORKSPACE.md)
before touching it, `src/components/commercial/workspace/` or
`src/lib/ciAssessment/analysis*.ts`. The rule that carries it: **an analysis is
an assessment record** — there is no separate calculator session, client model
or property model, so autosave, calculation runs, client linking and the
rendered report are the platform's own rather than a second implementation. The
standalone suite it replaces kept the whole deal in a Zustand store with no
persistence (a refresh discarded it) and its "Generate Report" produced no
document at all.

Two things bite. The **two analysis engines use different units** —
`capRateEngine`'s valuation gap is a ratio, `dcfEngine`'s IRRs are already
percentages — and getting it wrong renders a plausible number rather than an
error; both are pinned by tests. And **readiness is not a second opinion**:
blocking is exactly what the report route refuses, everything else is disclosed.

## The sanctions register itself
Read [`docs/aml/SANCTIONS_LIST_LOADING.md`](./docs/aml/SANCTIONS_LIST_LOADING.md)
before touching `scripts/aml/load-sanctions-lists.mjs`, the
`ingest_sanctions_list` operation or the refresh workflow. `aml.sanctions_entries`
was empty from the day the platform was built, for **three** independent
reasons, and each one on its own explained it: the refresh has never had the
repository secret it needs to write; DFAT answers a scripted client with a 403;
and the prune step **failed every load it was part of** — on a mutation,
PostgREST resolves the columns inside a logical `or=(…)` against the RETURNING
projection rather than the table, so `.delete().or('sync_id…').select('id')`
answers `42703 column … does not exist` while the same filter on a GET
succeeds. That third one is the one that would have survived fixing the first:
the loader records the run as failed, and the provider fails closed on a
required list whose latest attempt failed — a complete, current list in the
table and every screening refusing to run.

Two rules bite. **Freshness of the load is not currency of the data** —
`assessListRecency` reads the file's own Control Dates, because every other
control measures when we synced and a four-year-old file uploaded today passes
all of them. And **normalisation is server-side, always**: names are indexed
with the same function the screening query uses, so a browser that normalised
differently writes entries no query can ever match, which looks exactly like a
list that works.

## AML screening execution
Read [`docs/aml/SCREENING_EXECUTION.md`](./docs/aml/SCREENING_EXECUTION.md)
before touching `cross-portal-outbox-worker/screeningConsumer.ts`, the inline
path in `aml-cases`, or anything that decides whether a party has been
screened. "Screening never starts" was reported as a UI defect and was in fact
**four stacked faults**, each of which explained the symptom on its own and
each of which reported as normal operation: the internal signing secret had
diverged, so 17,174 scheduled invocations were refused and no worker ran at
all; the claim predicate was a PostgREST `.or()` string with a timestamp
interpolated into it, which never parsed, so the claim had **never once
succeeded**; the claim's error was discarded, so a database fault was
indistinguishable from losing a race and the subject was left untouched; and a
provider that is configured but still in simulator mode was reported as no
provider at all, sending the administrator to the wrong remedy.

There is now a **second execution method**: a screening the MLRO carries out by
hand. It is a method and never an exemption — nothing on that path writes
`required` or can spell `not_required` — and it is the *same* record, an
ordinary `screening_checks` row whose candidates go to the existing
adjudication. `execution_mode` could not carry it (it is live-vs-simulator, and
a manual check is both live and authoritative), so the method has its own
column. A manual **no match** is refused unless it names the sources checked,
the names searched and a rationale, enforced three times over —
`manualScreening.pure.ts`, the `record_manual_screening` operation, and a table
constraint — with the rule written once and imported by both the dialog and the
edge function. It is also available where sanctions are **`not_required`**: what
is owed and what may be performed are different questions, and a voluntary
attempt leaves the policy state standing unless it FINDS something —
`projectManualScreeningToSubject` is the only place that decides. Provider
readiness is a fact about the automated method alone and never gates the manual
one.

Three rules carry it. **A green cron run is not a delivered request** —
pg_cron reports on the SQL that queued the HTTP call, not the call, so the
honest signals are `integration_outbox.attempts` and
`net._http_response.status_code`. **Never compose a filter as a string**: the
test double emulated `.or()` with a regex, so code and test agreed while only
the server disagreed, and a contract test now fails any interpolated filter.
And **production never runs the simulator and never screens against an empty
or stale list** — refusal is visible, a confident clear against nothing is not.

## Stage 5 — the screening resolution centre
Read [`docs/aml/STAGE_5_SCREENING_RESOLUTION.md`](./docs/aml/STAGE_5_SCREENING_RESOLUTION.md)
before touching `ScreeningStageCard`, `screeningResolution.pure.ts`,
`screeningNextAction.ts`, `AmlContextActionPanel` or `deriveScreeningNextAction`.
Stage 5 had every fact it needed and no arrangement of them, so this is
orchestration — no new screening system, determination store or journey status.

Three rules carry it. **Obligation, method and outcome are different
questions**: `not_required` is an obligation, `no match` is an outcome, and an
unavailable provider is a method — collapsing them into one badge is how "not
required" came to read as "clear", and a test asserts the two vocabularies
share no value. **A closed case is a retained record, not a stage in
progress** — it leads with that and offers only the authorised reopen, held on
both sides because they deploy separately, and a FINDING still outranks the
lifecycle. And **one blockage can have two lawful routes**: a blocked required
screening offers the MLRO a manual route and keeps the administrator's repair
named as the alternative, so neither role holds a status with no step and the
broken automation is never papered over.

The contradictory screen behind it was **data disagreeing with itself**:
`reopen_case` moved the legacy `status` and left the canonical `case_stage`
and `closed_at`, while `transition` had always synced all three. It now syncs
them too — and still never touches `service_gate_status`, because
`STATUS_TO_SERVICE_GATE[resumeStatus]` would revive a terminated gate.

## Stage 5 — the guided path
Read [`docs/aml/STAGE_5_GUIDED_PATH.md`](./docs/aml/STAGE_5_GUIDED_PATH.md)
before touching `screeningSteps.pure.ts`, `ScreeningPathCard`,
`pepDeclaration.pure.ts` or the political-exposure question in the client
portal. Stage 5 had every fact it needed and no ORDER: on the reported case the
whole screen reduced to one act, and "Record PEP determination" appeared four
times in four sets of words while everything else was already settled. The path
arranges the same server-decided facts as numbered steps with one of them open.

Four rules carry it. It **derives nothing new** — every obligation, method and
outcome comes from `buildDeterminationRows`. **`not_required` is not `done`**:
a step nobody owes settles the path, renders `—` rather than a tick, and says
nobody was screened and nobody was cleared. **The server owns "what next"** —
`next_action` decides the open step whatever the local ordering would say. And
**a candidate is not a finding**: `path.finding` is a confirmed match alone.

The customer's own political-exposure answer now travels to the person who has
to decide (`pep_declaration` on the stage sync), because it previously existed
only as `personal_details.pep` in the policy's material inputs. **A declaration
is evidence and never a determination** — the stored answer is still `yes`/`no`
so no policy reads anything new, an unanswered question reads as unanswered
rather than as a "no", and a corrected answer's detail is pruned at the write
boundary. `record_pep` was also missing from the reviewer-or-MLRO list, so an
analyst was offered a button `record_pep_determination` answers with 403.

## The PEP determination — what it rests on
Read [`docs/aml/PEP_DETERMINATION_EVIDENCE.md`](./docs/aml/PEP_DETERMINATION_EVIDENCE.md)
before touching `_shared/aml/pepEvidence.pure.ts`, `pepSearchLinks.pure.ts`,
`PepDeterminationDialog` or the `record_pep_determination` /
`defer_pep_determination` operations. Sanctions is a **match against a
register**; a PEP determination is a **conclusion a person reaches** on
reasonable grounds, and there is no register that settles it — so the record
has to show the sources checked, what was searched and what came back. The old
flow was a prompt with two free-text boxes that had already chosen the answer
before it opened.

Three rules carry it. **A sanctions register is not a PEP source** — the
dialog's own worked example was the DFAT consolidated list, and absence from a
sanctions register is not evidence that somebody is not politically exposed;
the asymmetry is why a HIT is surfaced as a signal while a MISS says nothing,
and `sanctionsSignalForPep` is deliberately silent for "screened, no match".
**One rule, rendered and enforced** — `assessPepEvidence` is the module the
dialog renders from and the edge function enforces, so what an operator is
asked for and what the server accepts cannot become two standards; above the
statutory floor it requires one source independent of the customer and a
recorded result for every source searched. And **a deferral is not a third
outcome**: `defer_pep_determination` writes no determination row, stamps the
event `determination_recorded: false` and leaves Stage 5 open, because forcing
an operator to pick "not a PEP" to close a dialog is how an unfounded
conclusion gets written down.

The assisted search **builds URLs and nothing else** — no request, no result,
no decision. Nothing in it can return "no match", because a partial index
reporting "no match" is the confident-clear-against-nothing failure this
platform has already had once. What the public sources do not reach (foreign
office holders, family and close associates, somebody who has left a post) is
rendered beside them every time. `holds_position_currently` is an attribute of
the determination and never a softer outcome: leaving office is a risk
assessment, not an expiry date.

## `aml.cases` has no `tenant_id` column
Read [`docs/aml/CASE_TENANT_COLUMN.md`](./docs/aml/CASE_TENANT_COLUMN.md)
before adding any `.select()` against `aml.cases` or touching
`_shared/aml/caseTenant.ts`. Eighteen call sites across five edge functions
selected a column the table has never had; PostgREST answers **42703**, the
discarded `error` leaves `data` null, and twelve handlers then reported
**"Case not found"** about a case the operator had open. That is why
`pep_determinations` was EMPTY from the day it was created, why Stage 5's
"Record PEP determination" appeared to do nothing, and why the rail said
"monitoring summary could not be read".

Three rules. **Never name a column the table does not have** — `readCase()`
throws on `tenant_id` where a developer sees it, and a contract test scans
every function. **A read that FAILED is not a row that is ABSENT**: a missing
case is 404 and final, a failed read is 503 and worth retrying, so `CaseRead`
carries `failed` separately from `row`. And **the tenant is a property of the
deployment** — every `tenant_id` in the schema is `default`, which is exactly
why `cases` has no such column; `tenantForCase()` is the one place that knows
it.

**An identifier that does not exist is never type debt.**
`defer_pep_determination` called `appendCaseEvent` when the helper is
`appendEvent` — the module LOADS, serves every other operation, and throws a
ReferenceError on one branch. A count baseline can absorb that (one goes, one
arrives, the number holds), so `TS2304`/`TS2552` are now fatal in
`check-edge-functions.mjs` and the pre-existing occurrences are frozen in
`edge-missing-names.txt`, keyed by file and identifier rather than by line.

## The PEP screening engine
Read [`docs/aml/PEP_SCREENING_ENGINE.md`](./docs/aml/PEP_SCREENING_ENGINE.md)
before touching `_shared/aml/pepScreeningEngine.pure.ts`, `run_pep_screening`,
`PepScreeningRunPanel` or `pepSearchLinks.pure.ts`. It replaces five browser
tabs — two of which were wrong: the Government Directory link was a Drupal 7
path the site no longer serves, so the most authoritative source answered
"Page not found" every time, and two of the five rows were a search engine
sitting beside DFAT as though it were a peer.

**It screens; it does not determine.** The verdict vocabulary
(`indicators_found`, `no_indicators`, `incomplete`, `not_searchable`) shares no
value with `pep_determinations.result` — no `clear`, no `not_pep` — and both a
test and the security gate assert it. `no_indicators` is drawn neutrally and
says it is a result about the SEARCH; a register that FAILED is never reported
as one that was empty; and anything unreached forces manual review, including
an unanswered declaration, because no register here publishes family members or
close associates.

**Every source is local, and that was measured.** Wikidata's action API answers
429 from this egress, its SPARQL endpoint 504 on a worldwide walk, and
directory.gov.au and aph.gov.au both 403 a scripted client. A compliance
decision cannot depend on somebody else's rate limiter, so registers load on a
schedule and are read locally at decision time. The two that a server cannot
reach are NAMED as unsearched rather than omitted. A candidate rejection must
say how it was told — enforced at the column, the endpoint and the button.
Foreign office holders are deliberately still a gap the engine discloses.

## The public office-holder index
Read [`docs/aml/PEP_OFFICEHOLDER_INDEX.md`](./docs/aml/PEP_OFFICEHOLDER_INDEX.md)
before touching `_shared/aml/pepOfficeholderIndex.pure.ts`,
`scripts/aml/load-pep-officeholders.mjs`, the `search_pep_officeholders`
operation or `PepOfficeholderIndexPanel`. It is the second register this
platform loads and **not the same kind of thing as the first**: a sanctions
match is an outcome, an index hit is a lead.

**A hit is a candidate; a miss is nothing** — and the worse failure is not the
empty reading but the OVERSTATED one. The first load walked a subclass tree
from an entity that is itself an office, wrote 1,254 people across two, and
the product told operators it covered ministers, judges and every state.
Offices are found by jurisdiction (`P1001`) now, coverage prose carries no
numbers at all (a test asserts it), and everything countable is measured by
the loader into `pep_officeholder_syncs.detail` and rendered from there.
`pep_type` is left NULL because the AUSTRAC category belongs to the
determination, not the index. The endpoint also fails by lying — 200 with the
JSON cut off at its own 60s limit — so the query groups server-side, reads
offices in batches, and names an unparseable body a truncated download.

No public source lists every
prominent public function and none lists family members or close associates,
so the danger is also the EMPTY reading — zero rows for somebody the index never
covered looks exactly like zero rows for somebody who holds no office, which
is the shape `sanctions_entries` already shipped once. So `searchVerdict` has
four readings and a test asserts none can be paraphrased into a clearance;
**coverage travels with every result including the empty one**; an index that
never loaded or whose latest load FAILED reads as `unavailable` rather than as
no candidates; and a database fault answers 503 rather than "nothing found".

Two more rules. **The index is never the source** — every row carries a
`confirm_url`, the panel says the source is collaboratively edited, and
`candidateToMethodDraft` leaves `result` EMPTY so the operator writes what they
saw when they confirmed it against the official register. And **normalisation
is server-side, always**: `normalised_names` uses the same `normaliseName` the
query does, imported rather than re-implemented, and a row with no searchable
tokens is refused by the loader and by a column constraint. The loader repeats
every rule the sanctions loader learned the hard way — refuse a zero-entry
parse, treat a shrink as a truncated download, name `sync_id` in the prune's
RETURNING projection, and pin Node 22.

## AML screening scope
Read [`docs/aml/SCREENING_SCOPE.md`](./docs/aml/SCREENING_SCOPE.md) before
touching `deriveScreeningScope`, `reconcileSubjectToScope` or the
`case_screening_scopes` / `case_screening_perimeter` tables. Every scope is
decided independently, so sanctions can be `not_required` while PEP stays
mandatory. **The only lever that reaches sanctions is the PERIMETER, never the
risk rating** — targeted financial sanctions bind every dealing under the
Charter of the UN Act 1945 and the Autonomous Sanctions Act 2011, so a test
asserts no reason code can even be spelled in terms of risk; what can be true
is that a case is not a dealing (an enquiry, a duplicate, a service declined
before it commenced).

Three rules bite. The perimeter is **recorded by a reviewer or MLRO, never
inferred** — nothing in the schema says whether a designated service is
provided, and the default is always INSIDE, so an unclassified case, an
unknown reason code or a finding that excludes nothing all resolve to
sanctions required. **`not_required` is not `clear`**: it means no obligation
arose and nobody was screened, and the client reading keeps `notRequired`
separate from `resolved` so it can never render as a result. And **readiness
is a property of a scope** — `provider_relevant` is the second question, so an
unloaded DFAT list is irrelevant to a case with no sanctions obligation rather
than a blocker.

## Stamp duty
Every duty figure in the product comes from `supabase/functions/_shared/stampDuty/`
and nowhere else; `src/utils/stampDutyCalculator.ts` is a one-line re-export.
Read [`docs/reports/STAMP_DUTY.md`](./docs/reports/STAMP_DUTY.md) before changing
a rate — it records the four divergent implementations this replaced (and what
each got wrong), the third-party iframe it retired, and the handful of published
quirks that look like bugs and must not be "fixed": VIC steps **up** at $960k,
the ACT steps **down** at $1.455m, and NT is quadratic below $525k. A rate change
is a data edit in `schedules.pure.ts` plus a regenerated seed — never a hand-written
one. The weekly sweep flags stale schedules and **never writes a rate**; the doc
explains why that asymmetry is deliberate.

## Stamp duty
Every duty figure in the product comes from `supabase/functions/_shared/stampDuty/`
and nowhere else; `src/utils/stampDutyCalculator.ts` is a one-line re-export.
Read [`docs/reports/STAMP_DUTY.md`](./docs/reports/STAMP_DUTY.md) before changing
a rate — it records the four divergent implementations this replaced (and what
each got wrong), the third-party iframe it retired, and the handful of published
quirks that look like bugs and must not be "fixed": VIC steps **up** at $960k,
the ACT steps **down** at $1.455m, and NT is quadratic below $525k. A rate change
is a data edit in `schedules.pure.ts` plus a regenerated seed — never a hand-written
one. The weekly sweep flags stale schedules and **never writes a rate**; the doc
explains why that asymmetry is deliberate.

## Generated reports / PDFs
**Read [`docs/reports/COVERAGE.md`](./docs/reports/COVERAGE.md) before anything
else here.** The design system renders **0.14%** of the documents this product
actually produces — 2 of 1,440, and zero of 1,162 investment reports. Every
other measure in this programme (the ink floor, the critique rubric, the golden
diff, PDF/UA validation) is taken against fixtures in a harness and passes while
that stays true. A correctness measure cannot see an unused system, so check
coverage before improving output.

**Which template a report comes out in is now a choice, and it never was.**
Read [`docs/reports/TEMPLATE_SELECTION.md`](./docs/reports/TEMPLATE_SELECTION.md)
before touching `_shared/reports/reportTemplateSelection.pure.ts`, the picker or
anything that decides which `report_templates` row a document is drawn from. A
template used to reach a document by **ranking alone** — no surface anywhere
bound one to a report format, and every path that touched a template ended in
the Template Builder, which is an editor. A selection is stored per (user,
format) and read **before** the ranking, never instead of it, so a format with
nothing chosen behaves exactly as it did. Three rules bite: a format has up to
four spellings and they are **one** format (the alias map is now in that pure
module and the registry re-exports it — two copies is how `commercial_industrial`
became activatable and unresolvable); a chosen template whose engine is not
`weasyprint` is **still selectable and says so**, because it is what the ranking
would have picked and it produces the legacy document either way; and a
selection that goes stale resolves to **`unavailable`**, never silently to a
different template.

**A document can be completely correct and still never reach the renderer.**
Read [`docs/reports/RENDER_BOUNDARY.md`](./docs/reports/RENDER_BOUNDARY.md)
before touching `renderResourcePolicy.pure.ts`, `printFontPolicy.pure.ts`,
`tokensToFontFaceCss` or anything that compiles HTML for WeasyPrint.
`render-template-pdf` asserts the HTML can make **no** network request before
it invokes the engine, and all 500 seeded masters name their typefaces with a
Google Fonts `cssUrl` — so every design-system render was refused at that gate,
after parsing, binding and drawing 84 blocks correctly. It was invisible
because the gate ran *before* the `template_render_jobs` row was written and
before `templateId` was read, so a refusal left no row in the ledger and none
in `template_events`; the route fell back, and the legacy generator produces a
well-typeset document too. Two rules: **for print the container is the font
source** (`compileTemplateHtmlForPdf` forces it, and the production route goes
through that compiler rather than its own copy of the step), and **a family the
image lacks is substituted explicitly, never left to fontconfig** — an unknown
face prints as the engine default with no warning from anything.

That boundary judges **where the renderer fetches, not where it draws**. It used
to scan the whole document as one string, so it refused reports for their prose —
808 of 1,182 investment reports carry a URL in their content, and the two
model-authored formats are the most exposed because a model cites its sources.
Attribute values and stylesheet bodies are judged; text between tags is not.
Every attribute is judged rather than a list of the fetchable ones (guessing
narrowly reopens the SSRF; guessing widely costs a loud refusal), and exactly two
are exempt: `xmlns*`, and `href` **on `<a>`** alone. The other half of the same
rule is that **an asset that cannot be brought inside the boundary is dropped and
named, never carried into it** — a bound `src` is resolved and inlined like a
literal one, and what cannot be fetched is left out with a notice rather than
failing the document.

Read [`.claude/skills/npc-services-design/reports/REPORT_RULES.md`](./.claude/skills/npc-services-design/reports/REPORT_RULES.md)
before touching any PDF generator — print has different contrast, colour and font
rules from screen, and most of the repo's "logo" files are email-signature banners
carrying the director's personal mobile number. Architecture and the migration
programme: [`docs/reports/DESIGN_SYSTEM.md`](./docs/reports/DESIGN_SYSTEM.md).

Every report is rendered by one container, `weasyprint-service/`, and it ships
on its **own** deploy — `ci.yml` builds that image to test it and publishes
nothing. `deploy-weasyprint-service.yml` stages a revision with no traffic on
every push and promotes only when a person asks, for the reason below; the
manual path and the one-time federation setup are in
[`docs/reports/CONTAINER_RELEASE.md`](./docs/reports/CONTAINER_RELEASE.md).
Read that before changing the engine pin, the fonts or the render options: it
also carries the order the container and the render routes have to ship in,
which is not interchangeable — the routes ask for `pdf/ua-1`, and an engine
without that variant returns a 500 on every report.

Investment report **generation** is a separate concern from rendering, and the
one pipeline that cannot finish inside a single request: 17 sections at ~25s each
against a ~150s edge ceiling. It survives by stopping at a wall-clock budget and
being resumed — by the browser, the bulk worker, or a cron watchdog. Read
[`docs/reports/INVESTMENT_REPORT_RESUME.md`](./docs/reports/INVESTMENT_REPORT_RESUME.md)
before changing the section loop, its timeouts, or anything that claims a report.

Ten formats have been migrated onto it, and each carries its own contract:
[`INVESTMENT.md`](./docs/reports/INVESTMENT.md),
[`BORROWING_CAPACITY.md`](./docs/reports/BORROWING_CAPACITY.md),
[`CASH_FLOW.md`](./docs/reports/CASH_FLOW.md),
[`PORTFOLIO.md`](./docs/reports/PORTFOLIO.md),
[`COMPARISON.md`](./docs/reports/COMPARISON.md),
[`CASH_FLOW_COMPARISON.md`](./docs/reports/CASH_FLOW_COMPARISON.md),
[`CLIENT_DETAILS.md`](./docs/reports/CLIENT_DETAILS.md),
[`QA.md`](./docs/reports/QA.md),
[`MARKET_INTELLIGENCE.md`](./docs/reports/MARKET_INTELLIGENCE.md) and
[`COMMERCIAL_CAPACITY.md`](./docs/reports/COMMERCIAL_CAPACITY.md). Read the
relevant one before touching that format — each records defects that only a
render against production data revealed, and each names the legacy generators
that must stay.

**Investment Location & Property Fit** is the highest-volume format by an order
of magnitude — 1,182 rows, 5-18 a week. Its *structure* is
[`INVESTMENT_STRUCTURE.md`](./docs/reports/INVESTMENT_STRUCTURE.md), which is the
one to read before changing a section, the generator prompt or the word caps:
the report carried **90 editorial commentary labels a report — 16.9% of the
document** and ran at 2.3× its own declared budget, because the prompt told the
model "after every visual" and "one per section" at the same time, and because
`compassPostProcessor` / `compassQAValidator` **had no caller in the generation
path at all** — every cap they enforce applied to everything except the document
a client receives. Two rules there keep biting: a label is stripped with its
paragraph but **never a figure or a table**, and a report banked under a
different section list is **regenerated rather than resumed**, because
`last_completed_section` is an index into whichever list is current.

`INVESTMENT.md` is the one to read before touching anything the *model* draws. Its prose carries a chart vocabulary the generator's
prompt demands and the renderer had never parsed: **3,753 `{{bars: ...}}`-style
directives, about 107 a report**, every one of which set as body copy on a
client's page. The parser and the router are shared
(`_shared/reports/vizDirectives.pure.ts`, `vizFigures.pure.ts`) and eleven of the
twelve kinds map one-to-one onto a chart primitive that already existed.
`INVESTMENT.md` also records why nothing keyed on a section *number* works any
more: of the 35 reports the current generator has produced, **none is numbered**.

**Commercial & Industrial Capacity** is the one to read before
adding a format whose prose a model writes. Its figures come from the stored
calculation run and never from a recomputation; its analysis section is
model-authored under a tool schema that contains **no numeric field at all**,
persisted against the run so a re-issued report says what the first one said,
and labelled as model-written on the page. It is also the format whose first
render found a live bug in `measure.pure.ts` — `formatDelta` reported "no
change" for every `rate` that changed, which had been silently wrong in the
Borrowing Capacity Snapshot's audit table.

Two of the ten carry model-authored Markdown rather than typed figures, and
they share the programme's only Markdown renderer,
`_shared/reports/markdown.pure.ts`. Read them first if you are touching prose.
**Report Q&A** discovers its sections from the content rather than declaring
them, and is the only render route that can call a model. **Market Intelligence**
is the one whose page budget is fitted block by block against real renders rather
than summed, the one that clips a section and says so on the page, and the only
one that writes a PDF a scheduled email later attaches.

## Partner agreements — TEMPLATES ONLY
The platform no longer runs the formation of a partner referral/commission
agreement. Read [`docs/agreements/TEMPLATES_ONLY.md`](./docs/agreements/TEMPLATES_ONLY.md)
before adding anything to `_shared/agreements/`, restoring a deleted module from
history, or wiring an agreement into referrals, commissions or compliance.
Issuance, acceptance, execution, status tracking, cross-portal sync and the
notifications are **gone**, along with three Edge Functions
(`manage-partner-agreements`, `finance-portal-agreements`,
`agreement-centre-render`) and eleven shared modules — facilitating and
recording a contract between two independent businesses made the platform look
like a participant in it. One rule carries what is left: **downloading a
template is the end of the platform's involvement.** The wording lives in
`templateResource.pure.ts` and both portals render it from there, no Edge
Function is invoked and nothing is written, and `agreementTemplatesOnly.spec.ts`
asserts the machinery stays gone.

**The document is a file, not a render.** These two instruments were typeset
**three** ways in this repository at once — a Python builder writing
`public/`, a browser DOCX renderer, and the documents their author actually
maintains — and the generated pair had gone stale, still carrying a section the
owner withdrew. That is how "the template keeps reverting to the old version"
kept happening. The author's file is now the artefact, declared in
`_shared/agreements/templateFiles.pure.ts`; the other two are **deleted rather
than dormant**, because a dormant generator is one `npm run` away from writing
a staler document beside the real one. Two rules follow. The locked content
modules are now the **specification, not the renderer** —
`agreementTemplateFiles.spec.ts` opens each shipped `.docx` and fails if any
subclause, heading, note or bullet is missing, and it scans the whole package
(including `docProps`, where Word puts the author's name) for tenant identity.
And **both portals hand over byte-identical files**: the branding stamp is gone,
because the supplied cover is built around `<<COMPANY NAME>>` and a
tenant-stamped blank reads as that side's prepared offer. Three things
that were deliberately NOT removed: the historical rows (nothing was ever
executed — 0 signatures — but destroying the record is irreversible), the Portal
Access / AML-CTF **Compliance Passport** agreements in
`partner-agreement-records` (Aurixa's own terms with its own users), and
`manage-agency-agreements` (agency ↔ client, a different feature).

## The PDF-import sidecar (Docling)
Template Builder's PDF import runs through one Cloud Run container,
`pdf-parse-service/`, dispatched by `pdf-parse-dispatch`. Read
[`docs/pdf-import/SIDECAR_PERFORMANCE_PROGRAMME.md`](./docs/pdf-import/SIDECAR_PERFORMANCE_PROGRAMME.md)
before changing its deployment, its Docling options or the watchdog: it records
what the production ledger measured against what the deploy docs assumed, and
they disagreed on nearly every point — **43% of 76 jobs failed**, one 94-page
job took 357s while another took 46,424s, and 42% of a healthy job's wall clock
was cross-Pacific IO to Supabase.

Two rules that keep biting. **OCR availability is not OCR forcing** — they were a
single expression until lane-policy v3, so enabling the fallback force-OCR'd
every page of 44% of traffic; and disabling it would have stopped `ocr_scanned`
OCR-ing a genuine scan, because the capability is a hard ceiling. **The sidecar
and the dispatcher share `LANE_POLICY_VERSION` and must deploy together**, or the
cache fingerprint serves stale-semantics artifacts.

Sidecar options live in `app.py`'s `GLOBAL_CAPABILITIES`, the lane matrix in
`lane_policy.py`, and the OCR language contract in `ocr_languages.py` — a
mistyped language code is not inert, it fails the whole conversion (`zh` is not
an EasyOCR code and cost 9 production jobs). Those three modules are pure and
gated by `ci.yml`; nothing else in `pdf-parse-service/` runs in CI.

That sidecar is only **one** of the two PDF engines. A checkbox in the import
dialog routes the file to Claude instead, via `template-design-agent`. Read
[`CLAUDE_RECONSTRUCTION_GROUNDING.md`](./docs/pdf-import/CLAUDE_RECONSTRUCTION_GROUNDING.md)
before touching that path: it was the only reference kind the importer did not
ground, and it now measures the attached PDF with PDF.js first. Two rules there
keep biting — grounding is read from the **attached bytes and never from the
open template** (measurements from the wrong document are worse than none, since
the agent treats them as authoritative), and **absent grounding is not empty
grounding** (an empty element list tells the model a scanned page has no text,
which it then reproduces).

The import review can now ask a model **what differs** between the source page
and the rendered one, per page, on an operator click. Read
[`VISUAL_CRITIQUE.md`](./docs/pdf-import/VISUAL_CRITIQUE.md) before touching
`_shared/visualCritique.pure.ts` or the `visual_critique` mode. It is a judge and
never a fixer: the model notices, and every claim geometry can settle is settled
by geometry before a reviewer sees it — a finding naming an element the page does
not contain is **dropped**, and one measurement contradicts is shown as
contradicted rather than as a defect. The doc also records the endpoint it
replaces: `layout_reconciliation_repair` reads a field its only client never
sent, so it answered "no changes" to every request ever made of it.

A scanned PDF is routed to the engine that can read it. Read
[`SCANNED_ROUTING.md`](./docs/pdf-import/SCANNED_ROUTING.md) before touching
`scannedDocumentPolicy.pure.ts` or `probeTextLayer`: the deterministic path
cannot read a scan and **OCR is not the fallback** — 0 OCR pages across 1,164 in
production, because the capability ceiling defaults false — so the dialog
measures the text layer in the browser and pre-selects the Claude engine. Two
rules there: a **failed probe is `unknown`, never `scanned`** (it fails on
encrypted files, which are not scans), and a stray watermark character must not
make a scanned page look native.

Chart reconstruction is **inert in production and now says so**. Read
[`CHART_RECONSTRUCTION_STATUS.md`](./docs/pdf-import/CHART_RECONSTRUCTION_STATUS.md)
before touching `chartCandidate.pure.ts` or anything in the chart path: 0 chart
overlays exist across 245 imports, for four independent reasons (the scene graph
never runs, so `chart_candidates.py` never executes; Docling's picture classifier
runs on 2 of 84 jobs; `chartNativeEnabled` is off). The client-side detector
recovers the classification from geometry the import already holds and **never
reads a value off a chart** — a misread number in a client's financial report is
this programme's top risk, and a classification cannot misstate a figure.

An import now also brings a **design system** with it, read off the source and
bound to its own overlays. Read
[`IMPORT_DESIGN_SYSTEM.md`](./docs/pdf-import/IMPORT_DESIGN_SYSTEM.md) before
touching `designSystemBinding.pure.ts`, the token derivation in
`mapDoclingToPagePlan`, or `applyTemplateImportPlan`'s token merge. One rule
carries it: **bind only where the token's value is exactly what the overlay
measured** — that is what makes the render byte-identical and the import
restyleable at the same time, and there is no tolerance parameter. Two things
that bit: anything which **measures** a template (CDIR) has to resolve the
references first or it derives a palette of `token:heading`, and the base
template's tokens win every conflict so an import cannot restyle pages it lands
beside.

An imported overlay also carries what the source said it **is** —
`overlay.semantics`, from Docling's own label. Read
[`SEMANTIC_STRUCTURE.md`](./docs/pdf-import/SEMANTIC_STRUCTURE.md) before
touching `semanticRole.pure.ts`, the overlay element name in
`blocks/_shared.html.ts`, or image `alt`. WeasyPrint builds the tagged PDF's
structure tree from the **element name**, and `render-template-pdf` asks for
`pdf/ua-1` — so a `<div>` is why an imported page's structure tree used to be
flat with zero headings. The stage's hard constraint is that it adds meaning and
moves nothing: pixel identity at 300 DPI is asserted before and after, and the
`margin:0` reset and the `<span>` inside a heading are both there for measured
reasons the doc records.

## The template converter
An existing template can be brought *onto* the design system rather than into the
visual editor: `/admin/template-builder/converter` extracts a template's section
structure, binds it to one of the migrated report formats, and renders it through
WeasyPrint under a **brand design system** — a saved brand colour plus a full
`ReportDesignOptions`, authored in the UI or drafted by Claude from a brief. The
palette is never stored, only resolved. Read
[`docs/reports/TEMPLATE_CONVERTER.md`](./docs/reports/TEMPLATE_CONVERTER.md)
before touching it: it records why binding is confirmed rather than guessed, why
unmatched sections become an appendix instead of being dropped, and why the
output goes to its own private bucket rather than `report-templates`. The
existing `ImportPdfDialog` / `parse-template-document` path is a different
destination and stays.

## Report templates
The seeded PDF catalogue is **generated**, not hand-edited. Never hand-edit the
generated migration — edit the source and run `npm run templates:library:seed`,
which revalidates every schema against the live Zod contract, the production
renderer allow-list and the publish gate before writing anything.

It carries **two authoring systems over one renderer**. The 43 *voice* templates
come from `scripts/template-library/designSystem.ts` — five voices keyed to the
catalogue's `style` axis, six accents keyed to subject, all derived from the NPC
tokens ([`06-design-system.md`](./docs/template-library/06-design-system.md)).

The 500 *family* templates come from the approved Claude Design **Investment
Compass Template Catalogue**: ten design families × five structural variants ×
ten colourways. The designs carry no subject matter, so they serve **all ten
migrated report formats** — 50 masters each of Investment Compass, the Borrowing
Capacity Snapshot, the Portfolio Performance Review, the Property Comparison
Analysis, the 10 Year Cash Flow, the Client Details Form, the Cash Flow
Comparison, Report Q&A, Commercial & Industrial Capacity and Market
Intelligence, sharing one shell (`investmentCompass/master.ts`) and contributing
a page sequence each. Nine are production-ready; the Cash Flow Comparison is
**preview-only because nothing about a comparison is persisted anywhere a
template can read** — not the projections, not the analysis, not the ledger.

**Model-authored Markdown is drawn by `markdown-block`, which takes source
rather than HTML.** Report Q&A and Market Intelligence both carry prose a model
wrote — 70% of Q&A answers use inline bold, and Market Intelligence is eight
Markdown layers — and neither could be drawn until that block existed. It renders
through `_shared/reports/markdown.pure.ts`, the programme's only Markdown
implementation and **escape-first**, so safety is a property of the renderer
rather than of the caller: no input to it produces markup the model chose. That
is what admits it to `PRODUCTION_SAFE_BLOCK_TYPES` without opening a hole in a
security allow-list, and a block accepting rendered HTML must never be added.

**A body of unknown length is carried by conditional pages, not by a bigger
block.** `packMarkdownPages` (`reports/markdownPaging.pure.ts`) is shared by the
block and the projections precisely so they cannot disagree — a master makes
page N conditional on a published page count while the block decides what page N
holds, and one line of drift prints a blank page or loses the end of a section.
Adding a format is a composer plus a `ReportFormat` descriptor — and the adapter
and projection that make it production-ready — not a second design system.

**A `category` must be one the column accepts.** `template_library_entries_category_check`
and the TypeScript `TemplateLibraryCategory` union have diverged: the union has
`market`, the column has `suburb`/`postcode`/`statewide`. The column decides, the
seed builder refuses to write when a category is outside it, and that guard
exists because 50 Client Details masters were rejected by Postgres **mid-apply,
after 290 rows had been written**.

Two rules are worth knowing before you bind anything. **A declared block height
is a promise the renderer keeps only if the text is as short as the author
assumed**, and a block that sets taller does not overflow the page, it prints
over the next one; size from `textHeight(chars)` against measured production
lengths, and `npm run templates:compass:qa` fails on the class. And **an
unresolved binding renders as the empty string, never as a visible `{{…}}`** —
which is why two formats shipped a cover with no title at all, why the
Investment Compass's narrative page and risk register were blank on every report
(49 of its 80 paths resolved to nothing), and why **every** document printed a
blank letterhead until `organisationProjection.pure.ts` gave `org.*` a producer.
A format's projection is the authority on what may be bound; the catalogue specs
assert the masters bind nothing it cannot publish, and the check that finds this
class is to resolve every bound path against a row taken verbatim from
production — never against `SAMPLE_REPORT_DATA`, which is written in the
catalogue's own vocabulary and passes while production is empty. Read
[`docs/template-library/07-investment-compass-families.md`](./docs/template-library/07-investment-compass-families.md)
before touching `scripts/template-library/investmentCompass/` or
`_shared/templateColourways.*`.

**The families and colourways are GENERATED, never hand-written.**
`investmentCompass/source.json` is a verbatim evaluation of `FAMILIES` and
`COLOURWAYS` from the Design file; `npm run templates:compass:generate` emits
the two `.generated.ts` modules from it. ~250 manifest entries and 500 colour
values are not something anyone transcribes correctly, and a mistyped hex is a
design change nobody approved — so `investmentCompassSource.spec.ts` re-checks
the generated files against the source every run. A design change goes to Claude
Design and comes back through the generator.

Four rules keep biting. **A colourway is tokens and nothing else** — the
catalogue's own rule is "tokens carry no layout meaning", which is why this is 50
masters × 10 palettes and not 500 templates; a spec asserts every block's
geometry is byte-identical across a family's ten palettes. **A colourway's `ink`
is the cover FIELD, not body copy** — body ink is derived by lifting it 4 points,
the measured gap between `--aurixa-obsidian` and `--foreground`, and setting body
copy to the field colour is invisible on screen and wrong on paper. **The
manifest vocabulary is resolved, never read directly** — 31 KPI layouts and 30
chart styles map onto primitives in `resolvers.ts`, which **throws** on an
unmapped value so a new family fails the build instead of silently rendering as
somebody else's layout. And **`family_id` is version lineage, not a design
family** — it is what the publish path deprecates siblings by, so overloading it
would make publishing one master deprecate the other four; family metadata lives
in the additive `design_meta` column instead.

## Mobile (Flutter) translation
The four portals are being translated into one cross-platform Flutter app.
[`mobile/plan.md`](./mobile/plan.md) is the master plan — architecture
decisions, the server-side prerequisites in this repo (bearer auth for the
cookie portals, a native Turnstile replacement, the missing account-deletion
flow), and the store verification rule catalog for the App Store, Google
Play **and Huawei AppGallery** (HMS devices have no Google services — the
push/attestation abstractions are three-platform by rule). Per-portal plans
live in `mobile/portals/*/plan.md`; listing/launch practice for all three
stores is `mobile/store-listing/plan.md`. Two generated artefacts feed the
Flutter workspace and must never be hand-edited: `mobile/design-tokens.json`
(`npm run mobile:tokens`) and `mobile/api-surface.json`
(`npm run mobile:api`); both have `:check` drift modes.

## Frontend loop (summary — full detail in `FRONTEND_TOOLING.md`)
1. Design new surfaces with the **frontend-design** skill.
2. Build shadcn-first; use **@21st-dev/magic** for net-new components, then adapt to
   our semantic tokens and `components.json` aliases.
3. Review with the **web-design-guidelines** skill.
4. Verify in a browser with **chrome-devtools** (console clean, screenshot the result).

## Hard rules
- **Semantic design tokens only** — never raw Tailwind palette classes or hardcoded
  colors/fonts in shared UI. `npm run audit:style` must not regress (new violations = 0).
- **Surfaces are glass.** The material lives in [`src/styles/glass.css`](./src/styles/glass.css)
  (recipe) and the glass scale in `src/styles/tokens.css` (values). Use a `.glass-*`
  class; don't hand-roll a frosted surface, don't add a `bg-*`/`shadow-*` utility to
  one, and don't put `backdrop-filter` on anything that repeats. Read that file's
  header before adding a surface — it explains why for each rule.
- Respect the shadcn setup (`components.json`, `tailwind.config.ts`, `src/index.css`).
- Before finishing a UI change, run `npm run lint`, `npm run audit:style`, and `npm run build`.
