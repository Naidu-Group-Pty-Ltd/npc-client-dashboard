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

## The login CAPTCHA is a per-deployment credential
`src/lib/turnstileSiteKey.ts` is the one place that decides which Turnstile
widget a build renders. A widget IS a **(site key, secret) pair** — the site key
is public and drawn by the browser, `TURNSTILE_SECRET_KEY` is its twin in the
backend — and `siteverify` reports the hostname a token was solved on, which no
login handler here reads. So a shared widget means a token farmed from ANY
tenant's login page satisfies the CAPTCHA on every other one.

The site key used to be a literal in `components/auth/TurnstileWidget.tsx`, and
`npc-client-dashboard` inherited it verbatim when this repo was mirrored. Two
rules now hold it. **The built-in key is used only while the build talks to the
Supabase project its secret lives in** — the same pairing rule
`integrations/supabase/env.ts` applies to the URL and anon key, and what makes a
built-in safe to inherit: a fork pointed elsewhere resolves to no key and says
so, rather than rendering this deployment's widget on another tenant's page. And
**the key is named in exactly one module**, asserted by
`turnstileIdentity.spec.ts`. Aurixa Mission Control mints each clone its own
widget and publishes `VITE_TURNSTILE_SITE_KEY`.

## The activation gate (a clone may be locked until it pays)
Read [`docs/billing/ACTIVATION_GATE.md`](./docs/billing/ACTIVATION_GATE.md)
before touching `_shared/paymentGate*.ts`, `mission-control-gate`,
`usePaymentGate` or the `PaymentGateOutlet` in `DashboardLayout`. A clone
provisioned onto a PAID plan boots on a clock (72h by default) and is locked
behind a payment screen when it runs out, until Stripe captures the activation
payment. **The prime and every clone that already exists are not gated and
cannot become gated** — a `clone_payment_gates` row IS the gate, only
provisioning writes one, and a test asserts no migration backfills the table.

Three rules bite. **The status is derived, never stored** — nothing closes a
gate, because `THE_CLONING_ENGINE.md` records six pg_cron jobs that were never
scheduled at all, silently, and a gate whose closing depends on a worker fails
OPEN under exactly that fault with nothing reporting it. **Only an explicit
locked answer locks**: an unreachable Mission Control, a timeout, an
unparseable body or an unrecognised reason word all render the dashboard,
because the enforcement that protects revenue is Mission Control's own 402 on
`tokens/reserve` and `seats/reserve` (an unpaid clone spends the PRIME'S
forwarded vendor keys), while the failure this screen could cause is locking
out somebody who has paid. And **a top-up does not activate a workspace** —
`seat_plan` and `setup_package` settle the gate, so a $50 credit pack cannot
open a $2,015/month plan.

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

## Distributing a Passport to several partners
Read [`docs/aml/PASSPORT_DISTRIBUTION.md`](./docs/aml/PASSPORT_DISTRIBUTION.md)
before touching `passportRecipients.pure.ts`, `PassportRecipientsPanel`, the
`deliver_to` argument on `grantAccess` or the wizard's grant step. Reliance on
one completed CDD process by several partners is the product, and it had no
surface: the register held two correct, active grants for the same case while
`delivered_to_email` was **null** on both, because `grant_access` emails the
link only when handed a `deliver_to` and the wizard called
`grantAccess(caseId, agreement.id)`. Nothing failed — the grant minted, the
audit event wrote, the badge went green, and the partner was told nothing.

Three rules carry it. **Delivery is part of the act** — a grant nobody was
emailed is access with no channel and is indistinguishable from a healthy one
in every register, so `undelivered` is its own state and the panel leads with
it. **A live link can never be re-read** (only its hash is stored), so a
holder's send is a REPLACEMENT carrying `reissue_of`, said before the click.
And **there is exactly one send path**, because there were two and that is why
one was wrong: `reissueGrant` passed the one-time link as a prompt field's
`placeholder`, which is not a value — the uncopyable-empty-box defect that was
reported, fixed on the other path, and survived here. `PromptField.value`
exists for the same reason.

The raw bearer token and the `/passport/<token>` link are the **same
credential**; the link is what a person opens and the token is for a partner
system with no browser, so it sits behind a disclosure rather than being
presented as the deliverable.

**Access can be withdrawn, and withdrawal is not deletion.** `revoke_grant`
existed from the first version and no surface ever called it. A grant records
that a disclosure was authorised, so revoking stops the access and KEEPS the
history — the only "remove this partner" a register may offer. It needs a
reason, it is offered only on a LIVE grant, and it is deliberately not gated
by what gates issuing (an overdue review, a missing attestation, the write
flag): those stop new disclosure, and stopping disclosure is what this does.
The explained action list that made blocked buttons legible had itself become
a wall — five rows of three lines, always open, beside the same grants listed
twice — so **one act is open (the server's `ready`) and the rest are a
disclosure**. And the four lists of the same partners (the grant, the written
arrangement, the emailed agreement, the case link) are now **one roster**,
`partnerRoster.pure.ts`: one row per organisation with ONE next step, chosen
by what actually blocks. Two rules there — **a badge must mean something is
unmet** (`active`, `reliance` and `builder_developer` are how a healthy record
looks, and colouring them like problems is what made eleven chips unreadable),
and **database vocabulary never reaches the operator**, asserted by a test that
refuses any underscore-cased identifier in a rendered field.

## One living record — the attestation everyone reads
Read [`docs/aml/ATTESTATION_CURRENCY.md`](./docs/aml/ATTESTATION_CURRENCY.md)
before touching `attestationCurrency.pure.ts`, `attestationForGrantRead` or the
manifest carry-forward in `issue_attestation`. A grant pinned `attestation_id`
and every read resolved through that pin, so **issuing v2 silently revoked
every partner who already held the Passport** — their next read answered 409
`attestation_superseded` and the only repair was to re-send it to each of them
by hand. Under schema v2 there was a second, independent cause of the same
outcome: the new version had no disclosure manifest, so every read would have
failed `manifest_missing` anyway.

The rule: **a grant authorises a PARTNER to read a CASE's attested record, not
one frozen version of it.** Reads resolve the case's current attestation and
the version served is recorded on the access log. Three rules carry it. **The
pin is history, never the reading** — `attestation_id` is never rewritten.
**Current means CURRENT, not merely newer**: a version flagged for refresh is
still withheld, because "we know this one is wrong" is not "there is a better
one" — and the refusal now promises no new link is needed. And **a widening is
never implicit**: the carry-forward copies the previous manifest's scope, and a
grant whose predecessor had no manifest gets none and fails closed.

## The Passport inside a partner's own portal
Read [`docs/aml/PASSPORT_IN_PORTAL.md`](./docs/aml/PASSPORT_IN_PORTAL.md)
before touching `_shared/aml/partnerSurface.pure.ts`, `PartnerPassportPanel`,
`enrol_partner_portal_access` or the `passport` field on
`get_partner_compliance_workspace`. The machinery existed and had never served
a partner, for **four independent reasons each fatal on its own**: the surface
flags were off; `partner_portal_memberships` held zero rows and its upsert op
had no caller anywhere; the organisation cross-reference columns were declared
by the Phase 1 migration and written by **nothing, ever**; and the page drew a
one-line identity strip rather than the booklet.

Four rules carry it. **The in-portal document is the SAME document** —
`buildCasePassportView(…, "partner")`, the assembler the emailed link uses, so
"identical" is a property of one implementation rather than two agreeing.
**Turning the Passport on NARROWS the page**: `aml_partner_passport_view`
resolves the surface to `passport_only` unless `aml_partner_workspace_full` is
also on, so showing a document cannot expose eight unreviewed panels — and the
mode is a mask over the per-portal adapter (`full && adapter`), never a
replacement for it. **Enrolment maps a real portal identity read from the
portal's own records, and never re-points an existing binding**, because that
would change which partner every existing portal account speaks for. And
**a withheld Passport renders its reason** — enrolled, linked and nothing to
read is a real state, and a blank area reads as a broken page.

A partner accumulates Passports, so the page is a **filing cabinet** now, not
a row of chips labelled `Matter …6a5a49` (the last six characters of a row
id). `partnerMatterIndex.pure.ts` orders matters by what can be opened and the
page is centred with the list beside the document. Its rule is a disclosure
rule: **a partner is told whose record a matter is only where they may READ
it** — `subject_label` is not sent for a withheld matter, decided by the same
`passportDisclosure` the document goes through, so neither the list nor the
search box can name a customer the partner may not see.

An eighth fault sat in front of all of it: the page and the nav entry gated on
`supabase.from("feature_flags")` **from the browser**, and that read can never
work for a partner — the table grants SELECT `TO authenticated`, a portal
user's client is anon, and RLS FILTERS rather than erroring, so it returned
`[]` with HTTP 200 and every flag coerced to `false`. Every partner in every
portal was told the page did not exist however the database was set. **This
was the third surface to hit that trap** (`useAmlV3Flags` and
`useBuilderStockMarketplaceFlag` carry the same header), so the rule is theirs:
**read through the server, not the table** —
`get_partner_surface_availability`. Two more rules follow: **one authority
decides** (the pages no longer gate at all; the server refuses and says why),
and **a failure is never cached and never reported as "off"** — `unknown` is a
distinct answer, so the Command Centre says nothing rather than something
false.

Two more faults sat behind the same symptom. **`create_agreement` never
accepted a `partner_org_id`**, so every wizard-written arrangement had NULL
there and `grant_access` stamps a grant only `if (agreement.partner_org_id)` —
the portal looks a grant up BY organisation, so it reported a Passport the
partner held as never shared; the fix is a validated field, an explicit
`bind_agreement_organisation` repair that never re-points, and a read path
that accepts either explicit route. And **nothing led from the emailed link to
the portal**: `portal_handoff` now offers "View in your portal" on the page and
in the email, but only when the surface is on AND an active membership exists,
because a door that refuses is worse than no door. The deep link carries a
matter id and never the token, and `returnToPath`/`safeReturnTo` are one rule
for all three logins — two of which used to discard the destination entirely.

The page's chrome answers to two more rules. **The compliance entry is second
in every portal**, directly under the Dashboard — Finance, Builder/Developer,
Solicitor and the Client Portal — and `portalNavPlacement.test.ts` pins the
position and nothing else; the Client Portal's is still called "Identity &
Compliance", because that reader is the customer proving who they are. And
**the standing "Your organisation remains responsible" banner is gone**: a
partner reaches the page only through a signed arrangement carrying those
acknowledgements, so it restated an agreement on every visit.
`ResponsibilityNotice.tsx` is DELETED rather than unmounted (a dormant
component is one import away from putting it back), while the statement itself
survives attached to the document it qualifies and the assessment form's
acknowledgement control is untouched — removing a notice must never remove a
control. The space that frees is not cosmetic: `bookletGeometry` fits the
spread to the box it is given, so container width and board height convert
directly into legible document.

**A magnified booklet has to be movable, and had nothing to move it with.**
Zooming severed the right-hand leaf at the dialog's edge, pushed the turn bar
off the bottom and offered a scrollbar on neither axis — and the same fault
crops the document at 100% on a short window or a phone. The scroll container
asked for `h-full`, which resolves against a containing block whose height
comes from flex rather than from a declared length, so it computed to `auto`,
the scroller grew to its own content (1,553px inside a 667px box) and
`overflow: auto` had nothing left to clip. A flex column plus `min-h-0 flex-1`
takes percentage resolution out of the path and still works where the holder
has no bounded height (the Client Portal). Four rules follow. **Centring is by
auto margin, never `justify-content`** — centring an overflowing box pins it
at a negative offset no scrollbar can reach, and one layout then serves the
fitted document and the magnified one. **Whether there is anywhere to pan is
asked of the DOM**: `overflows` was `zoom > 1`, which is neither necessary nor
sufficient, and a measured box carried on the geometry FLAPS where the
container is content-sized, because the box is then the one the board itself
makes — so `BookletZoom.overflows` is gone rather than left to be believed.
**A hidden affordance is no affordance** (drag to pan, and scrollbars drawn in
the document's own palette, because the platform default is browser chrome or
nothing at all). And **the arrow keys mean what they mean where the reader is
standing** — panning inside a magnified board, turning the page everywhere
else.

The booklet's own chrome answers to one more: **`.passport-action` must not
declare a width.** It declared `width: 100%`, and `.w-auto` — which every one
of its nineteen call sites pairs it with — is also a single-class selector, so
source order decided and the utility lost everywhere. The visible defect was
the turn bar (both buttons 535px of a 1200px row, the page title clipped to
"Identity Ver…"), but the same rule stacked every `flex flex-wrap` action row
in the Command Centre one button per line. The turn bar is a grid now, because
`justify-between` centres nothing, and the magnification cluster has a body of
its own — it was four chips in the page-number row, in the page-number style,
so nobody found it.

The raw bearer token is **gone from the Command Centre**: it and the
`/passport/<token>` link are one credential, and showing it twice invited an
operator to send "the code" instead of the link.

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

## Stage 9 — the service gate and the credential
Read [`docs/aml/STAGE_9_PASSPORT_AND_PARTNERS.md`](./docs/aml/STAGE_9_PASSPORT_AND_PARTNERS.md)
before touching `refreshRemedy`, the reason codes in
`_shared/aml/passport/passportState.pure.ts`, `gatePassportPath.pure.ts` or
`passportActions.pure.ts`. **`refresh_required` is one code covering two
different owed acts**, and the product rendered both as "issue a new version":
on the reported case the attestation was v1, issued, unsuperseded, with zero
open refresh obligations, and the state was flagged for the single reason
`service_gate_regressed` — the gate was under review. Stage 9 said "a newer
version is needed" and the reliance panel offered "Reissue as v2", which
supersedes a good v1 and changes nothing, because v2 carries the same reason
while the gate is unapproved. **A remedy that cannot discharge the reason is
never offered as the next step**; `refreshRemedy` is the one place that
classifies them, an unrecognised reason counts towards the reissue (the
conservative side), and a spec test fails on any reason the classifier does not
name.

**The gate is granted by the cleared decision, not asked for twice.**
`aml.service_gate_decisions` held ZERO rows across the whole database: Stage 9
carried an approval card whose button was disabled until a ten-character reason
was typed while still reading "Approve the gate — Approved", so clicking it did
nothing at all. And the platform disagreed with itself — `aml-cases`'
`transition` maps `cleared → approved` while `decide` deliberately left the gate
alone, so which one a case got depended on which button moved it. The second act
asked no new question either: `set_service_gate`'s approval preconditions and
`decide`'s clearance preconditions are the SAME `clearanceBlockReasons` over the
same inputs. `decide` records the gate itself now, through the one
`recordGateDecision` both paths use, and `GateApprovalCard` is DELETED. Three
rules hold: **only `cleared` grants**, **a `locked`/`terminated` gate is never
revived** (the MLRO's standing restriction is the only way a live Passport is
suspended or revoked), and **open conditions mean `approved_with_controls`**.
`set_service_gate` and the Decision stage's full eight-status card are
untouched — removing a ceremony must never remove a control.

Two more rules. **Completion is counted once, in the units of the steps** —
the header said "0 of 3 items on this stage complete", the rail said the same,
and the card listed four steps; Stage 9 defers both, `anytime` is excluded
because a look is not a debt, and where only the gate is owed the issuance step
is DONE rather than a second copy of the same fact. And **the finishing line is
named before the click**: approving the gate on that case completes the stage
outright, so the card says so — exactly when one owed step remains and this
operator can perform it, never when the last step is blocked.

**Partners are on ONE stage, and the rail says what the page says.** The
roster and every act on it have always been on the Passport stage; the stage
after it carried a read-only echo of the same organisations, read through
`aml_passport_partner_distribution` — a flag that is OFF wherever partners are
onboarded one at a time, so it announced "Passport distribution is not enabled
for this deployment" right after six partners had been given the Passport. The
cut follows the work: **Stage 9 is "Passport & Partners"** (you cannot share
what has not been issued) and **Stage 10 is "Ongoing CDD"**.
`PartnerDistributionCard` is DELETED, `distributionStage` no longer reads
`facts.passport` at all but still NAMES where the partners are, and Stage 9's
path gains a fifth `anytime` step — sharing is never owed, because a case may
legitimately have no partner. A `shortLabel` must be **part of** its `label`
(a test pins the rule, not the strings): the rail read "Partners" while the
heading read "Partners & ongoing CDD", which is how an operator comes to look
for partners on the wrong screen.

On the journey map, **Builder and Developer are one portal** (the wizard
already knew; the map's second tile could never connect, and a `developer`
grant had nowhere to appear), and **a live Passport reads green** like the
Client portal's own completion — worded as a fact about access, never as a
claim about the partner, and a revoked grant takes the colour back.

## The Command Centre on a phone
Read [`docs/aml/COMMAND_CENTRE_ON_A_PHONE.md`](./docs/aml/COMMAND_CENTRE_ON_A_PHONE.md)
before changing a layout class on an AML surface, `AmlPageHeader`,
`AmlWorkspaceHeader`, `AmlJourneyRail`, the AUSTRAC register or the
touch-target rules in `src/styles/utilities.css`. Every defect there was
found by rendering the real page into a real Chromium and measuring the DOM,
and several are invisible at 390px and appear only between 430 and 768 — so
"it looked fine on my phone" was never evidence either way.

**The module had no door on a phone.** `MobileSidebar` renders the shared
navigation registry and nothing else, and the AML entry is not in it — it is
gated by the `aml_ctf` flag AND an assigned AML role rather than by a module
entitlement — so the desktop sidebar built the entry inline, the command
palette built a SECOND copy under a different title and group, and the two
mobile surfaces never had it at all. The whole module was unreachable from a
phone; typing the URL worked, there was nothing to tap. It is defined once in
`lib/navigation/amlEntry.ts` now and every navigation surface asks for it,
pinned by `sidebarNavigation.spec.ts` — which already existed to forbid a
private navigation list and could not see this one, because it was not the
registry's. It **fails closed, loading included**: an entry is a claim that a
page will open. And **"we could not check" is not "you do not have it"** —
`useAmlAccess` collapsed a failed read into the server's own "no", so a lost
signal made the guard announce "AML/CTF is not enabled" to an MLRO; the
reading now carries `unavailable`, the guard offers a retry and says nothing
about permissions, one automatic retry is made when the transport marks the
failure retryable, and navigation still fails closed because a door that
cannot be verified is not drawn.

**`flex-1` does not make a row wrap.** A line wraps when its items'
HYPOTHETICAL sizes overflow it, and `flex: 1 1 0%` contributes zero — so a
`flex-1 min-w-0` title beside a 330px action cluster is handed the leftovers
however small they are. On the AUSTRAC hub at 430px that was EIGHTEEN pixels
and a heading 532px tall, one character per line, on all twenty pages that
draw `AmlPageHeader`; 390 escaped only because the cluster alone overflows
there and forces the wrap by itself. A column that must not be crushed
declares a `basis`. The same bug was already fixed once on the case workspace
header and existed a third time on the AUSTRAC draft page's action bar.

Three more rules. **`shrink-0` protects a cluster's width, not its
contents** — the workspace header's badge cluster kept its 418px max-content
width on a 390px screen and hung off the edge while its own `flex-wrap` never
engaged, and the badges inside it were `whitespace-nowrap` anyway. **One
layout at a time**: the AUSTRAC register is cards under 768px, switched on
`useIsMobile` (the hook `ResponsiveTable` uses) rather than drawn twice and
hidden with `md:hidden`, because a CSS-hidden copy still carries every
accessible name in the document — and its acts come from ONE `rowActions` so
a phone cannot offer an Approve the desktop has taken away. And **a link in a
sentence is not a control**: `utilities.css` gave every `<a>` a 44×44 box
under 768px, which stops an inline link sharing a line box with the words
around it — Compliance Home's one-line footer was 96px tall with its links
14px off the baseline beside them. The floor stays for every anchor that IS a
control; the considered version of that accommodation is the
`@media (pointer: coarse)` block, which is keyed on the pointer rather than
the width.

## What the AML navigation offers, and what it does not

The Command Centre's nav is **compliance surfaces only**. Everything about
shipping this software, verifying a deployment or administering the platform
keeps its route and leaves the strip — the treatment `aml-v3-cutover` and
`aml-integration-health` already had. **Hiding is never deleting**: every AML
route in `App.tsx` is declared unconditionally and a standing test asserts it,
so a bookmark, a deep link and the case workspace's own buttons all still land.

Customer Compliance is **Register + Compliance Passport** — the two cross-case
entry points. Every per-case topic (Verification, Screening, Risk, Funding &
Finance, Transactions) is a stage inside a named customer's case; the
standalone pages exist but each loads with `cases[0]` selected, which is the
most recently created case, and on the Risk page "Record decision" was live in
that state. Ownership & Control is **conditional** — `useHasEntityCases` asks
the server whether the tenant holds a non-individual case, because beneficial
ownership is a company/trust/SMSF question, and it **fails open** so a failed
read never hides a compliance surface.

**The primary strip is three tabs: Compliance Home, Customer Compliance and
AUSTRAC Hub.** Regulatory & Assurance is retired, and it went by being
REDISTRIBUTED rather than hidden — lodging a report is the daily job and it was
two clicks down, so the AUSTRAC Hub is a workspace of its own (its drafting
routes resolve by prefix, so writing a report never loses the strip), and
monitoring, EDD and records sit under Compliance Home beside the queues that
count them. **No path lost a workspace**, which is the rule that makes a
retirement safe. Compliance Home therefore owns real paths now, and
`pathMatchesWorkspace` matches the module ROOT exactly and never as a prefix —
`/admin/aml` is every AML URL's ancestor, and prefix-matching it would make
Home the active workspace on the case register and every other tab dead.

The chrome is now **one Refresh and nothing else**. "Open queue" linked to the
active workspace's `defaultPath` — the page an operator is already looking at,
because they arrive at a workspace BY its default path, so on Compliance Home
it was a no-op every time. Configuration went with it, and Compliance Home's
secondary strip went too. What holds it all together is that **`paths` and
`secondary` answer different questions**: `paths` is OWNERSHIP (a URL belonging
to nothing draws no chrome and highlights Home — reachable and looking broken),
`secondary` is what is OFFERED. Monitoring, Investigations & EDD, Records &
Privacy and Configuration keep the first and lose the second, so every route
resolves and every page keeps its trail while no tab is drawn. Configuration
also left Organisation Settings' `paths` — **a path belongs to exactly ONE
workspace**, and listed in two it resolves to whichever comes first while the
other silently loses it. Three of the four keep **one quiet, capability-gated
line at the foot of Compliance Home** ("Also in this workspace"), because
Monitoring is already deep-linked from three readings in the strip while the
others had no route at all — and two of them are statutory.

That redistribution is what let **"Your queues" go entirely**: every
destination it listed is in the navigation, so the card was a third launcher
after the primary strip and the role-adaptive "jump back" card above it. The
page's own header went with it — a second title, strapline and Refresh drawn
directly under the command centre's — which exposed that **the shell's Refresh
was a placebo**: it dispatched `aml-command-refresh` and nothing in the product
had ever listened, so the button moved a clock. Compliance Home answers it now,
and `AML_COMMAND_REFRESH_EVENT` is named in one module because a literal at
each end is how two ends drift. Configuration's one capability-gated door moved
with the header into the command centre's action row, where it is one click
from wherever an administrator is rather than only from Home.

Compliance Home's queue directory was, before it went, **four entries**, because a queue is work
waiting for somebody. **Transactions** left: `aml.transactions` and
`aml.transaction_parties` hold zero rows and the page is a PER-CASE surface
loading `cases[0]`, which is exactly why the nav audit already folded it into
Customer Compliance as a stage — leaving it in the queue list contradicted a
decision the product had made. **Configuration** left the list too but NOT the
page: nothing waits there, so it is not a queue, but it is the only
discoverable route to the sanctions register's health and hiding the page is
what once stranded that behind a blocked case; it moved to the page header,
still gated on `aml.configure`, and `amlLayout.test.tsx` still pins **one
door, capability-gated**. The six case/monitoring metrics are **one strip, not
six cards** — six borders around six single-digit numbers took more height
than the case list under them — via a `dense` variant on `AmlMetricCard` that
keeps the deep link, the skeleton and the "Not available" reading that is
never a fabricated zero, with the label's line RESERVED so every value sits on
one baseline.

Three surfaces left because they are build or platform tooling rather than
AML/CTF work, and the evidence is on the tenant rather than in an opinion:
**Launch Operations** (rollout stages, 13 acceptance scenarios none ever run,
0 certifications, a risk register of 8 seeded rows never edited, categories
including "Engineering"), **Partner Operations** (renders only a deployment
preflight table; its operational half is behind a disabled flag with four
empty tables, and partners are managed on the Passport & Partners stage), and
**Governance** (five tabs of Release Gate, AI Approvals, Step-Up Sessions,
Resilience Drills and Runbooks — its one compliance tab, Contacts, is gated on
`aml_v3_org_settings`, which is off, which is also why
`senior_manager_designations` is empty).

**Configuration left the strip too**, and it is the case that shows what
"hidden" has to mean. It is not platform tooling — it holds the verification
provider's credentials, the risk factors every assessment is scored against,
and the sanctions register's health — but it is set once and revisited
rarely, and it is step-up protected, which is what an administrator's
destination looks like rather than a tab. It is reached from exactly two
places now: one capability-gated tile on Compliance Home (a second button
beneath it went, having sat directly under a comment saying restricted
affordances live in the tiles), and Stage 5's "open list health" when
screening cannot run. **Hiding the PAGE would strand the register behind a
blocked case again**, which is the defect that put it there.

Three rules bite. **A path belongs to exactly ONE workspace** — missing from
`paths` a page draws no secondary strip and highlights Compliance Home, and
listed in TWO it resolves to whichever comes first and draws the wrong strip;
both are reachable-but-broken, and the Passport shipped that way once. **A
workspace with no tab is not the same as no workspace**: `hidden` keeps
Organisation Settings owning its four URLs while the strip stops drawing it,
so those pages keep their header — resolution reads the permitted set,
rendering reads the visible one. And **every hook goes above the early
returns**: `AmlConfiguration` returns early while loading and again when the
summary cannot be read, `?tab=` support was appended where it was USED, and
the second render called two more hooks than the first — React threw, the
boundary caught it, and the page read "Something went wrong" on every visit.
A source-level test now fails on any hook below the first early return,
because the page's own test file had only ever exercised a sub-component.

## Lodging a report with AUSTRAC
Read [`docs/aml/AUSTRAC_LODGEMENT_PATH.md`](./docs/aml/AUSTRAC_LODGEMENT_PATH.md)
before touching `austracReportPath.pure.ts`, `AustracReportPathCard` or the
`submit_record` / `record_receipt` operations. The server was already rigorous
— MLRO approval, step-up MFA, lodgement evidence, the AUSTRAC reference for an
SMR, an explicit no-tipping-off attestation — and the surface in front of it
was five boxes and a status table. The defect: **`reports.case_id` has existed
since the first migration and the draft dialog never set it**, so every report
was filed against nobody and reached no customer's file.

Four rules. **The clock is in BUSINESS days** (SMR 3 from the day the suspicion
was formed, TTR/IFTI 10; a suspicion about terrorism financing is 24 HOURS and
is the same report under a tighter clock, never a different kind) and it runs
from the OBLIGATION rather than the reporting period — a separate field, kept
in `metadata`, because a deadline derived from the wrong date is worse than
none. **The checks disclose and the server refuses** — two gates is how one of
them becomes wrong, so only "filed against nobody" and "past the window" read
as blocked. **The platform never lodges**: AUSTRAC Online is the entity's own
account and this holds no credentials, said on the page rather than in a
tooltip. And **tipping off is guarded at the projection** — both
`CLIENT_RESTRICTED_KEYS` and `PARTNER_RESTRICTED_KEYS` already carry `smr`,
`austrac` and `suspic`, and a test pins them rather than trusting them.

The draft dialog now says **why**, and `austracDraftGuidance.pure.ts` is where
that lives: per obligation, what the report is for, when AUSTRAC must be
informed, what it is NOT for and where that belongs instead, and what the
narrative has to answer. Four rules. **It advises and never decides** — no
field is written from it, and a test rejects any sentence that could read as
permission to lodge nothing, while the narrative helper inserts QUESTIONS
into an empty box so nothing it produces can be lodged as an assertion nobody
made. **The tipping-off warning is in the main column and on the SMR alone**:
below `lg` the reference panel drops under the whole form, and a prohibition
on what an operator may say cannot be below the fold. **The stored kind is
translated, never used as a table key** — `reports.kind` accepts five values
and `AUSTRAC_OBLIGATIONS` is keyed by four (`compliance` and `annual` are one
obligation), so a raw read is `undefined` and the next property access is a
crash; `toObligationKind` returns null rather than guessing. And **an annual
report is not a customer report**: it accounts for the business's own
programme, so demanding a case left the customer check permanently blocked
and step 1 of the path unable ever to complete.

**Drafting is a PAGE now** (`/admin/aml/austrac/new`,
`/admin/aml/austrac/:reportId/edit`). A report to a regulator is the longest
single piece of writing in this product, written against a statutory deadline
over more than one sitting, and a modal cannot be deep-linked, reopened where
it was left, sent to a colleague or reached with the back button — and closes
on an outside click with whatever was typed in it. Four rules. **The path sits
UNDER the hub's**, because `pathMatchesWorkspace` matches a prefix plus `/`
and a page in no workspace draws no strip. **Saving hands the report back**
via `?report=<id>`, which is what the dialog's close did implicitly. **An
unsaved change guards leaving** — registered only while there is one. And the
hub's action is **"Start AUSTRAC Report"**: "New Draft" named the row it would
add to a table, not the act. `AUSTRAC_KIND_LABEL` and `draftSectionsForReport`
are in the pure module because both were about to exist twice.

Three things the page itself got wrong. **A customer is typed, not scrolled**
— the field was a drop-down over every open case, so `caseSearch.pure.ts` now
holds one matching rule that the Compliance Passport register uses too (its
filter MOVED rather than being copied): every word must match and they may
match different fields, and a reference matches with or without its
punctuation. It filters the list already loaded and never queries on a
keystroke. **There is no character floor** — a 200-character minimum rendered
as `298 / 200 characters`, which is the shape of an overrun on the one field
where running out of room would be serious, and AUSTRAC sets no threshold;
`narrativeIsWritten` replaces it and the per-obligation questions under the
box are the guidance on substance. And **the label was sitting on the box**:
it shared a `flex items-end` row with that counter, which is what put its
descenders on the textarea's border.

Three more, from the hub beside it. **The "Bundle" download was a debug dump**
— `JSON.stringify` of the export, named by uuid, opening in a text editor —
and is now a PDF drawn by the SAME renderer and brand resolver as the client
submission record (`austracBundleRecord.pure.ts` projects onto
`SubmissionRecord`), issuing under the workspace's brand or the **Aurixa
Systems** fallback; the tipping-off prohibition travels IN the document and
on the SMR alone, and `RecordDocumentIdentity` became a defaulted parameter
because the renderer wrote "Submission v1" across every page it drew.
That record was correct and thin, and its first production render is the
document this rework is measured against: it opened on a field list, said
nothing about what OBLIGES the report, carried the MLRO decision only as a
version-table note reading "MLRO sign-off", said nothing about what was still
outstanding, and printed page two **blank apart from the colophon** — which
pinned itself to the foot of a fresh page whenever the content overran. It is
arranged as a story now (handling restriction, obligation, report, narrative,
pre-lodgement checks, approval, lodgement, receipt, versions, integrity) and
**nothing in it reads anything new**: the prose is `AUSTRAC_OBLIGATIONS` and
`KIND_GUIDANCE`, the checks are `austracReadiness` — the module the register
already renders — and the approver is read from the version row the sign-off
writes, because `mlro_signed_by` is an id with no label. Five rules carry it.
**The s.123 prohibition is met BEFORE the document is acted on and stated
once** — it was 8.5pt grey at the foot of the last page, where a reader who
has already forwarded it arrives; a test pins the rule (present, first,
exactly once) and not the field. **A lodgement is never asserted to have met
the deadline** — `submitted_at` says a report went, not that it went in time,
so the Deadline line compares against the due date. **An empty field is
omitted rather than printed as a dash** (two of eleven first-page rows carried
no fact). **The uuid leaves the body and stays in the running foot** — it
means nothing to any party the record is for, while the hash stays WHOLE
because truncating it destroys the only thing it is for. And **a colophon pins
to the foot only when it fits**, or an overrun buys a blank sheet with a
footer on it.
**A dead control is worse than no control** — the path card drew "Open" on
the open step while the page handled three of six keys, so a saved draft's
step 3 did nothing; it takes `stepActions` now, a step with no entry draws no
button, and step 3's act is `upsert_report` with `awaiting_mlro` (an existing
status the server already permits). And **the selected row needs more than a
tint**: `bg-muted/40` on a dark theme is the charcoal beside it, so selection
is an accent bar, a ground and the word "Viewing", with `aria-selected` and
keyboard operation — while badge COLOUR marks only the SMR, because
`--primary` and `--warning` are both gold in dark mode and five tones carried
no information at all.

The path is **five steps, not six**. "Clear the pre-lodgement checks" was a
HAND-OFF — it completed by moving the report to `awaiting_mlro` — and on an
entity where the drafter IS the MLRO that is a report sent from somebody to
themselves before they may act on it; strip the routing and it counts the same
fact as the approval beside it, and **two steps counting one thing** is how a
header disagrees with the list under it. They are one step now, "Review the
checks and approve it". **Removing a ceremony must never remove a control**:
`mlro_signoff` is untouched, `awaiting_mlro` still exists and still signs off,
and the hand-off's confirmation MOVED onto the approval — excluding the checks
the approval itself unlocks, and reading the same `factsFor` projection the
card does, because the table's button acts on a report that may not be the
selected one. An open step with no action now renders **whose** it is, because
a live step with neither an act nor an explanation reads as a broken page.

**The whole process happens in the report now.** Approving from a register row
asks somebody to authorise a document they are not looking at, so Stage 3's
button OPENS the report — checks, narrative and approval on one screen — and
approving there returns to the hub with the lodgement step open. Five rules.
**The approval saves first** (the MLRO approves what they are LOOKING AT; the
button says "Save and approve" while there is an unsaved change), and a report
past the draft statuses renders READ-ONLY with the reason rather than a form
whose Save the server answers 403 to. **One guard, asked from both surfaces** —
`approvalConfirmation` is in the pure module because two copies of "what is
still owed" is how one screen warns about something the other does not. **The
checks LEAD the card**, because they are what an approver must read and they
sat below what they were asked to do; and **no step may describe its own
position** (`above`/`below` are rejected by a test — the same text is drawn on
three screens and the checks sit differently in each). **The AUSTRAC Online
door is inside step 4**, with the statement that the entity lodges through its
own account and this product holds no credentials. And **the path is drawn once
per screen**: the draft rail's orientation list is suppressed exactly when the
live card is mounted.

Two more from the register. **The title opens the report** — "Edit" was
offered on a draft alone, so a submitted report could be selected and never
read; it is safe on every status because the page renders read-only where the
server would refuse a write (and stops calling itself "Edit"). And
**archiving is putting away, never throwing away**: `delete_report` refuses
anything past a draft because a lodged report is a retained record, so
`archived_at`/`archived_by` hide a row and keep every byte — row, versions,
submissions, receipts, case events — reversibly. The rule it turns on is that
**a report may be archived only once nothing is owed to AUSTRAC**
(`archiveBlockReason`, in `_shared`, rendered by the register and enforced by
the function): hiding an approved-but-unlodged SMR loses a statutory deadline
rather than tidying a list. Three things follow — a lodged report with no
receipt archives but the confirmation SAYS so; `upsert_report` must strip the
stamp or a client archives by saving; and the tiles count the working
register, because a number beside a row nobody can see is worse than none. Choosing
is explicit — a checkbox per archivable row and a select-all that reads the
same `archiveBlockReason` the server enforces, so a checkbox can never pick a
report the archive would refuse — and **undo is part of the act**: the inverse
call is offered on the toast, on exactly the rows that succeeded and with no
second confirmation, because undoing is not a new decision and a bulk archive
is where a mis-click costs most.

## The photograph on the Compliance Passport
Read [`docs/aml/PASSPORT_IDENTITY_PORTRAIT.md`](./docs/aml/PASSPORT_IDENTITY_PORTRAIT.md)
before touching `_shared/aml/passport/identityPortrait.pure.ts`,
`storeIdentityPortrait`, `attachPortraitUrls` or the object list in
`aml-idv-retention`. A Passport that proves an identity was verified and shows
no face is a certificate, so the booklet carries one image — and **which one is
the whole question**. Three exist and this deployment holds all three
(`didit_standalone` uploads the customer's capture to our own buckets): the
**`id_portrait`** the provider extracted from the document, the document page
itself, and the selfie. Only the first may travel, because a face crop carries
**no document number, no MRZ, no date of birth, no address and no signature**;
the page carries all of them and stays staff-only. The rule is an **allow-list
of exactly one key**, and `WITHHELD_CAPTURE_KEYS` names the other two rather
than leaving them absent.

**It sits on the Client Identity page, and the mount always draws.** It was
first put on the Identity Verification leaf behind
`.filter((p) => p.portrait)`, which meant two things and both reported as "I
cannot see the photo of the client anywhere": it was not on the page that
names the holder, and the block DISAPPEARED whenever no image was stored —
which is every Passport issued before this — so the page could not be told
apart from one that carries no photograph at all. `identity.portrait` is a
**slot**, never null, and names which of three absences it is; the wording is
about the RECORD and never about the customer, asserted by a test.

**A portrait that was never stored is fetched automatically, exactly once.**
The document page is still in NPC's bucket, so `backfillIdentityPortrait`
re-derives the crop from it — on the one-minute sweep that already exists,
never from a button. A first attempt put "Recover the holder's photograph" on
the page and that was wrong: **asking an operator to click once per case is
asking them to fix this product's own record-keeping bug by hand, for ever**,
and it makes a Passport's completeness depend on whether anybody opened it.
Five rules carry it. It **re-derives an image and never re-decides an
identity** — no status, verdict, score or timing is written, and a re-read
that disagrees with the recorded verdict is logged for a human rather than
adopted. **One attempt, ever**: the `portrait_backfill` stamp is written
whether the call succeeded, failed or produced nothing, and its PRESENCE is
the guard, never its outcome. **Nothing is stamped where nothing was spent**,
so a database fault or an unconfigured provider does not disqualify a check
permanently. The pass runs only when **the live verification queue took
nothing this tick**, and it is **bounded at two a tick** so a backlog drains
without a burst of spending. `pending_retrieval` and `unavailable` are
separate readings on the page, because "on its way" and "the document carried
none" are not the same thing to a reader.

**The object list was written twice, and every reader took the stale copy.**
That is the fault that survived three otherwise-correct attempts: the
portrait was uploaded, named by the capture plan and on the retention job's
list, while `sa.capture_objects ?? plan.objects` — four hand-written copies of
one expression across two edge functions — read the evidence block's copy,
which is composed once at the end of a run and never updated.
`captureObjectsFor` is the one reader now and **merges rather than choosing**
(the plan wins key by key, the legacy copy is a floor), the run no longer
writes the duplicate, and a test forbids naming `standalone.capture_objects`
in code. `attachPortraitUrls` is likewise one shared module rather than
twenty duplicated lines in each portal.

Nothing new is fetched — the portrait is already extracted as the Face Match
reference and was simply discarded. Three rules make storing a face safe. **It
is deleted on the same clock as the captures**: `aml-idv-retention` enumerates
FIXED keys, so a new object is invisible until named, and the capture plan is
re-persisted during processing because the job reads `standalone_capture`
rather than the evidence block. **Storing it can never fail a verification** —
null means "no portrait", which is the ordinary state for every case recorded
before this, and every surface renders unchanged on null. And **the URL is
minted for one reader at the moment of service**: a signed storage URL is a
bearer credential with a lifetime, so the projection carries a descriptor
(`url: null`) and the edge function signs five minutes for the request that
asked. It cascades to the client, the emailed link and the partners because
`buildCasePassportView` is one assembler with an audience parameter.

## Stage 10 — ongoing CDD, and the reminders it raises
Read [`docs/aml/ONGOING_CDD_AND_REMINDERS.md`](./docs/aml/ONGOING_CDD_AND_REMINDERS.md)
before touching `_shared/aml/reviewSchedule.pure.ts`,
`_shared/aml/complianceReminders.ts`, `armOngoingCdd` in `aml-reliance` or
`src/lib/aml/displayDate.ts`. Three things, and each was invisible.

**Dates took the reader's machine.** `toLocaleDateString()` with no locale
printed `8/29/2029` for an Australian reporting entity — 779 call sites across
230 files, now on the `en-AU` the rest of the product already used explicitly,
with `AU_LOCALE` the one place it is named and a test that fails any
un-localed formatting in AML.

**The review cycle was written twice and defaulted to three years.**
`DEFAULT_REVIEW_INTERVALS` served scheduling and the sweep; an inline copy
thirty lines away served `complete_review`, so completing a review booked the
next one on a cycle the rest of the product had stopped believing in. One
module now, and the programme's policy is **at least annually** — AUSTRAC
fixes no interval, so it is a parameter and this is where it is stated. Two
rules: a rating may make the cycle TIGHTER and never longer (`prohibited`
stays at 3 months), and **the ceiling binds a configured interval too**, with
the clamp recorded rather than silently applied.

**A scheduled review reached no reminder list in the product.** It lived in
`existing_customer_reviews` and on one card; the Reminders hub reads
`client_reminders` and knew nothing of it. `complianceReminders.ts` writes
there — a second reminder system is how two reminder systems disagree —
idempotent by `source_ref`, never the record, and it **never fails the act it
accompanies**. `reminder_type` is CHECK-constrained, so the AML kinds had to
be added to the column or every write would have been rejected there while
looking, from the function, exactly like a write nobody attempted. And
**issuing the Passport arms ongoing CDD**: `armOngoingCdd` books the first
review, never moves one that exists, and never fails the issuance.

The rail's "Advance status" card is **gone from every stage**. On a cleared
case it offered "Under review" behind an OPTIONAL reason, and one click
regressed the stage, the client portal and the service gate — flipping a live
Passport to "Refresh required". It was suppressed on the two post-decision
stages first, but the reason was never local to them: **a case's lifecycle is
the consequence of decisions that carry their own recorded reasons**, so a
rail control restating them as one-click buttons was a second way to do
something the product already had a place for.

**Removing a ceremony must never remove a control**, so every state it could
reach still has one, and a test checks rather than trusts that: `cleared` /
`blocked` / `escalated_mlro` are the Decision stage's, `kyc_*` are moved by
the client's own submission, `under_review` is deliberately not offered, and
**`closed` moved to the case header** — which is where the panel's own comment
had always claimed it lived while nothing there did it. Closing asks for a
reason it will not proceed without, is offered only to a writer, and never on
an already-closed record. `AmlContextActionPanel` is now the closed-case
notice and the authorised reopen, nothing else. Hiding a button was never
authorisation: `transition` is untouched and the server enforces exactly as
before, and the legacy case dialog — the rollback path when the workspace flag
is off — still carries the panel it always had.

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
