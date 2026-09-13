# Runtime consolidation — Supabase + the browser, and no Cloud Run

> **Target architecture, set in stone.** Frontend/browser + Supabase + existing
> external APIs. No Cloud Run, no Cloud Run Jobs, no Cloud Build application
> dependency, no Compute Engine, no GKE, no new Google-hosted application
> service. Google remains an API provider — principally Maps. Supabase is the
> authoritative backend, runtime and storage platform.

This file records what was **measured** before anything was changed, because
the measurement decided the plan. Read §1 before proposing any sequencing: the
number that matters is not how many report formats route through Cloud Run
(eleven) but how many client documents Cloud Run has actually produced.

---

## §1 — What the delivery evidence does and does not say

**The browser renderer is mature and proven in production. It is not the
current delivery path.** Both halves matter, and conflating them would send
RC-3 after the wrong thing.

### What it says: the browser renderer has done the work

`investment_reports.pdf_url` carries the storage path of the delivered
document, and the two engines write different path shapes. That difference is
a fingerprint, and it settles the question by execution rather than by reading
the code's intentions:

| path shape | engine | rows |
| --- | --- | ---: |
| `<reportId>_<suburb>_<state>_<epoch>.pdf` (stored as a public URL in the older era) | `PixelPerfectPDFGenerator` — **browser, pdf-lib** | **263** |
| `generated/<YYYY-MM-DD>/<uuid>-<name>` | `render-investment-report-pdf` — **Cloud Run WeasyPrint** | **12** |
| | **total delivered** | **275** |

So the browser leg is not a prototype. 263 real client documents came out of
it, with its own upload through `secureStorageUpload` and its own `pdf_url`
write. That is what de-risks RC-3: the target machinery has run at volume.

### What it does NOT say: that the cut has already happened

The **current** unified path is `produceInvestmentDocument` in
`src/lib/reports/investment/deliverInvestmentPdf.ts`, and it is Cloud Run
end to end:

```
tryTemplateDocument('investment', …)   → render-template-pdf  → WeasyPrint (Cloud Run)
  └─ null (no active template) ──────→ render-investment-report-pdf → WeasyPrint (Cloud Run)
```

Every surface — the primary download, Send to Client, the premium button, the
flatten copy — was deliberately folded onto that one module, so **both** of its
legs terminate at Cloud Run. The 263 rows are historical: they predate that
consolidation.

**RC-3 therefore has to migrate a live contract, not delete an unused
renderer.** The renderer implementation is what changes; template selection,
Supabase Storage, `pdf_url`, download, Send to Client and portal delivery all
stay exactly where they are, and the browser renderer becomes the standard
path rather than a second "legacy layout" control beside it.

### How much work Cloud Run has actually done

| signal | window | value |
| --- | --- | --- |
| metered WeasyPrint render calls | since metering began 2026-08-07 | **128**, all successful, last **2026-09-08** |
| `template_render_jobs` | since 2026-06-06 | 135 rows — 122 succeeded, 11 failed, 2 stuck `running` |
| the nine per-format flowing-route ledgers | all time | **42 rows in total** |
| `investment_report_renders` | all time | **0** — the route writes no row to it |
| `pdf_import_jobs` (Docling) | since 2026-06-12 | **86** — 53 succeeded, **33 failed (38.4%)**, last **2026-08-11** |

Two Cloud Run services, low hundreds of renders across the product's life, and
the PDF-import service idle for over a month at a 38% failure rate.

**Caveat, stated rather than glossed:** WeasyPrint metering began 2026-08-07,
so the 128 is not a lifetime total — `template_render_jobs` shows renders back
to June. The lifetime figure is bounded below by ~135 and is of that order, not
of the order of the 1,214 reports on file.

---

## §2 — Per-format render-path matrix

Every one of the eleven render routes is **hard-dependent** on WeasyPrint:
`weasyPrintConfig()` returning null is a hard error in all of them, and there
is no second server-side engine. (`render-investment-report-pdf` still mentions
an Api2PDF/headless-Chrome leg; it is disabled and throws rather than falling
back, deliberately, so a client never receives a stale-looking document.)

| format | Cloud Run route | live browser generator | library | already uploads to Storage |
| --- | --- | --- | --- | --- |
| Investment | `render-investment-report-pdf` + `render-template-pdf` | `reports/PixelPerfectPDFGenerator.tsx` | pdf-lib | **yes** — `secureStorageUpload` → `manage-investment-reports` → `pdf_url` |
| Portfolio | `render-portfolio-review-pdf` | `clients/PortfolioAnalysisPDFGenerator.tsx` | pdf-lib | yes |
| Market Intelligence | `render-market-intelligence-pdf` | `marketing/MarketIntelligencePDFGenerator.ts` | jsPDF | via its buttons |
| Borrowing Capacity | `render-borrowing-capacity-pdf` | `borrowing-capacity/BorrowingCapacityPDFReport.tsx` | jsPDF | via `publishReportToPortal` |
| Commercial & Industrial | `render-commercial-capacity-pdf` | `utils/commercial/commercialReportPdf.ts` | jsPDF | via its page |
| Property Comparison | `render-property-comparison-pdf` | `reports/ComparisonPDFGenerator.tsx` → PixelPerfect | pdf-lib | yes |
| Client Details | `render-client-details-pdf` | — (no dedicated generator) | — | — |
| 10 Year Cash Flow | `render-cash-flow-pdf` | inline in `CashFlowAnalysisModal.tsx` | jsPDF | **already wired as `legacyFallback`** |
| Cash Flow Comparison | `render-cash-flow-comparison-pdf` | — | — | — |
| Report Q&A | `render-report-qa-pdf` | `report-qa/{Conversation,Message}ReportEditor.tsx` | jsPDF | via its editors |
| Template Builder | `render-template-pdf` | `lib/reportTemplate/blocks/*` `drawXBlock` | jsPDF | via the route |

All five generators named in the mandate exist and are **mounted** — every one
has live UI call sites. None is dead code.

### The one place the browser path is genuinely thinner

`src/lib/reportTemplate/blocks/index.ts` already carries a complete dual
renderer — `*.html.ts` for WeasyPrint and `*.ts` `drawXBlock` for jsPDF — and
declares per block which engines support it. Measured:

* **62** registered block types
* **28** have a real jsPDF renderer
* **34** render `drawExtrasPlaceholder` — a literal placeholder

The 34 include **every chart type** (`chart-bar`, `chart-line`, `chart-pie`,
`chart-donut`, `chart-area`, `chart-scatter`, `chart-radar`,
`chart-stacked-bar`, `heatmap`, `sparkline`) plus `data-grid`, `pivot-table`,
`kpi-strip` and `auto-toc`.

This is the honest cost of the template leg and it is why §11 of the mandate —
*"if a browser renderer produces inferior output, fix the browser renderer
using existing design primitives"* — is load-bearing rather than a formality.
It is bounded by the fact that the design system renders **0.14%** of this
product's documents and **zero** investment reports, so no client document
depends on those 34 blocks today.

---

## §3 — What "change only the transport boundary" can and cannot mean

The mandate's §5 asks that only the final transport/render boundary change.
For an HTML-composing route that boundary is HTML → PDF, and the constraint
that decides the design is this:

**There is no production-grade browser HTML → PDF converter that both
preserves vector text and yields a `Blob` that can be stored.** The three
candidates fail for different reasons — `html2canvas` + jsPDF rasterises (the
inferior artefact this programme has already rejected once); the browser's own
print engine produces excellent output but cannot hand back bytes, which §6
requires; and no pure-JS vector HTML renderer exists at this quality.

So the resolution follows the mandate's **§4**, which is the more specific
instruction and names the files: the browser path consumes the same **data**,
through the same projections, calculations, branding and disclaimer logic, and
draws it with pdf-lib/jsPDF. Everything upstream of the draw is preserved
unchanged. What differs is the typesetting, and that is measured against §11's
checklist rather than assumed.

**This is not a new reporting engine.** It is the engine that already produced
263 of 275 delivered documents.

---

## §4 — Rules this consolidation answers to

* **Cost safety must never create false data.** A daily ceiling reached makes
  the provider unavailable, the measured field `null`, and the claim absent
  from the report. It never produces a substituted or estimated figure —
  `rentalEvidence`'s rule, applied at the producer.
* **One quota vocabulary.** The ceilings reconcile against the existing
  `GOOGLE_*_DAILY_LIMIT` counters and their existing units before anything is
  hard-coded. A second metering system is not built.
* **Generating a file locally is not sufficient.** Every production PDF path
  keeps download, Supabase Storage persistence, a stable PDF reference, Send to
  Client, portal access, email dispatch where supported, report history and
  access control — through the existing `secureStorageUpload` and delivery
  abstractions.
* **Nothing is deleted before cutover validation.** The order is: browser path
  live → parity passes → smoke passes → production dependency removed → deploy
  workflows deactivated → services decommissioned. No workflow is left able to
  recreate Cloud Run afterwards.
* **Asserted by effect, never by configuration.** A route is proven cut when a
  document is produced, stored, downloaded and sent without a `*.run.app` call
  — not when a setting says so.

---

## §5 — Maps cost control

The first pass of this section claimed `location-intelligence-service` was the
only uncapped paid Google call site. **That was wrong, twice over**, and
nothing in the repository could have caught it because nothing checked. A
targeted scan for outbound Google Maps Platform requests found seven callers
and two with no ceiling at all.

### The production caller matrix

Scanned for actual outbound requests to `maps.googleapis.com/maps/api/*`, not
for mentions of the key:

| caller | billable SKU(s) | before | now |
| --- | --- | --- | --- |
| `location-intelligence-service` | Geocoding, Places Nearby, Distance Matrix | **none** | per-SKU |
| `parse-property-pdf` | Geocoding | **none** | `geocoding` |
| `school-data-service` | Places Nearby | **none** | `placesNearby` |
| `resolve-listing-coordinates` | Geocoding | own bucket | `geocoding` (product-wide) |
| `google-places-autocomplete` | Places Autocomplete | shared `google_places` | `placesAutocomplete` |
| `street-view` | Street View metadata + imagery | one scope, one unit each | `streetView` |
| `_shared/builderStock/images.ts` | Geocoding, SV metadata, SV imagery, Static Maps | **all four billed to the Street View bucket** | routed per SKU |

Two corrections to earlier readings, recorded because the method matters more
than the conclusion:

* `builderStock/images.ts` was described as spending "one unit for up to four
  requests". **That was wrong and no such defect ever existed.** It has a
  `spend()` helper called immediately before each of its four billable
  requests, so the per-request accounting was always correct. The real defect
  was **routing**: all four counted against `google_street_view`, so its
  geocode never touched the geocoding budget and a static map was billed to
  Street View.
* The earlier count came from grepping how many times `enforceGlobalDailyQuota`
  appears in a file, which counts the import and the helper definition rather
  than the call sites. `googleMapsDailyCaps.spec.ts` now asserts the matrix by
  execution instead.

### What the existing counter actually does

Read off the deployed `security_consume_rate_limit`, not inferred:

| property | measured behaviour |
| --- | --- |
| increment | `count = count + 1` — **one unit per call**, consumed once immediately before each outbound request |
| allow test | `count <= p_max` — a ceiling of 250 admits the 250th and refuses the 251st |
| window | **fixed, not calendar**: `window_start` is stamped on first use and reset only once it is older than the window |
| key | `public:global:<scope>:daily`, regex-checked `^[a-z0-9:_./-]{1,200}$` — an invalid scope RAISES, turning a ceiling into a 500 |
| unavailable RPC | falls back to a **per-isolate** counter and flags `degraded` |

### Fail closed — this is a spending boundary, not abuse control

That last row is the one that decides the design. A per-isolate counter is not
a product-wide ceiling under horizontal Edge scaling: every isolate gets its
own first N, so under the exact fault the ceiling exists for, spend is
unbounded while the limiter still answers `ok: true`.

`publicAbuseControls` is right to fail open — for abuse control, disabling a
working feature is the more expensive failure, and its header records what
treating an unreadable store as "denied" once cost. **The Maps wrapper fails
closed instead**, and the general abuse-control behaviour for the rest of
Aurixa is untouched. `degraded` is checked *before* `ok`, because reading `ok`
first would let a degraded limiter permit spend while looking healthy.

### Scopes follow Google's billing SKUs

One scope per billable SKU, because Google prices them separately and a shared
bucket makes each configured number meaningless on its own:

| SKU | scope | env | default |
| --- | --- | --- | ---: |
| Geocoding | `google_geocoding` | `GOOGLE_GEOCODING_DAILY_LIMIT` | 250 |
| Places Nearby | `google_places_nearby` | `GOOGLE_PLACES_NEARBY_DAILY_LIMIT` | 150 |
| Places Autocomplete | `google_places_autocomplete` | `GOOGLE_PLACES_AUTOCOMPLETE_DAILY_LIMIT` (legacy `GOOGLE_PLACES_DAILY_LIMIT` still read) | 250 |
| Distance Matrix | `google_distance_matrix` | `GOOGLE_DISTANCE_MATRIX_DAILY_LIMIT` | 250 |
| Street View | `google_street_view` | `GOOGLE_STREET_VIEW_DAILY_LIMIT` | 250 |
| Static Maps | `google_static_maps` | `GOOGLE_STATIC_MAPS_DAILY_LIMIT` | 250 |

Nearby and Autocomplete are split because they were sharing one bucket, which
meant a busy address field could spend the allowance a client's report needed.

**Geocoding is the opposite case and the rule is the same: one SKU, one
budget.** All four geocoding callers consume `google_geocoding`, so
`GOOGLE_GEOCODING_DAILY_LIMIT` has one honest meaning across Aurixa. The
earlier "configure N/2 because two buckets exist" workaround is gone — the
architecture was fixed rather than documented around.

Circuit-breaker scopes are a **different axis** and survive untouched:
`resolve-listing-coordinates` keeps `google_listing_geocoding` for its breaker,
because a breaker is about one caller's error rate while a budget is about the
account's spend.

Street View metadata is free and is counted with the imagery — a deliberate
over-count, because a second counter for a SKU that costs nothing buys nothing
and over-counting spend is the safe direction.

Defaults are set to keep ordinary **pay-as-you-go** usage under Google's free
monthly thresholds with room for month-boundary timing. Nothing here subscribes
to a paid Maps plan. Places Nearby is the tightest because it is what limits
report throughput: one enrichment is 1 geocode + 6 Nearby + 1 Distance Matrix,
so 150 admits ~25 enrichments a day against a corpus that created 32 reports in
thirty.

### Configuration is visible, not hidden

Every ceiling the runtime reads is declared on the **existing** Google Maps
Platform card in `src/lib/integrations/registry.ts` and flows through the
generated `integrationSecrets.ts` allow-list. No second integration card, no
second secret system. A spending limit that exists only in code is
configuration an operator cannot see, and a test asserts the declaration.

### Three refusals, kept distinct — and none of them reaches a client

`kill_switch`, `daily_cap` and `limiter_unavailable` are different operational
facts sending an operator to three different places, so they stay separate
internally and appear in logs verbatim.

**None of them may be paraphrased into client-facing prose.** The geocode
refusal is returned in the response body, so it names no environment variable,
no limit, no vendor and no piece of infrastructure — it says location details
are unavailable, that the address was never rejected, and that nothing has been
estimated in its place. A test scans every client-reachable refusal string for
`GOOGLE_*`, for any SCREAMING_SNAKE identifier, and for infrastructure
vocabulary.

### A ceiling produces absence, never a value

This needed no new machinery — each caller already had the right absence
semantics and a refusal takes them:

| refused call | returns | what a reader gets |
| --- | --- | --- |
| Places category | `{ ok: false, count: 0 }` | `measuredCount` answers **null**; the line is omitted, not printed as `0` |
| Geocode (location intelligence) | `{ ok: false, capped: true }` | `geocoder_daily_cap_reached` — its own reason, because `geocoder_unavailable` sends an operator to hunt broken map access |
| Geocode (`parse-property-pdf`) | the payload untouched | the address keeps what the extraction genuinely read; nothing is filled in |
| Places Nearby (`school-data-service`) | `[]` | the caller answers `null` — "nothing honest to return" — rather than a location with no schools |
| Distance Matrix | `COMMUTE_CAP_REACHED` | distinct from `no_route_returned`, which is a **measurement** a reader may act on |

A reached-and-empty lookup keeps its real zero: a rural address with no
hospital within five kilometres is a fact worth printing. Collapsing that with
a failure is the defect this guards.

### Release-gate proofs

`googleMapsDailyCaps.spec.ts` — 22 assertions, each a state the boundary must
hold:

| state | asserted outcome |
| --- | --- |
| limiter healthy | permitted, exactly one unit consumed, against the right scope |
| daily allowance exhausted | refused, `daily_cap` |
| **global limiter degraded** | **refused**, `limiter_unavailable`, and never reported as `daily_cap` |
| kill switch active | refused, `kill_switch`, and never reported as `daily_cap` |
| provider failure | unavailable, not zero |
| successful measurement | real value retained |
| genuine successful zero | zero retained |
| every known caller | consumes the shared allowance |
| every caller | no longer spends a paid request on the raw abuse-control quota |
| every geocoding caller | consumes the one product-wide budget |
| every ceiling | declared in the registry and the generated allow-list |
| every client-reachable refusal | no env name, no infrastructure wording, no digit |

---

## §6 — A refusal is reported for what it actually was

Three internal reasons, and only one of them is "you have used today's
allowance". The first pass let all three reach a caller as
`daily_quota_exceeded` — `google-places-autocomplete` and `street-view`
answered it on every refusal, and `builderStock/images.ts` **persisted** "The
daily limit for location imagery has been reached" onto the row, where it
outlives the incident and is read by people who were not there.

That is not a wording nit. "Daily quota exceeded" tells an operator to wait
until tomorrow, and waiting clears neither of the other two: a provider
somebody switched off stays off, and a shared counter that cannot be read stays
unreadable.

| internal reason | client / persisted status | HTTP |
| --- | --- | ---: |
| `daily_cap` | `daily_quota_exceeded` | 429 |
| `kill_switch` | `temporarily_unavailable` | 503 |
| `limiter_unavailable` | `temporarily_unavailable` | 503 |
| unknown / absent | `temporarily_unavailable` | 503 |

Both codes already existed at these call sites; nothing new is introduced.
`clientStatusFor`, `clientHttpStatusFor` and `clientMessageFor` are the one
mapping, so four callers cannot drift — and no call site spells either literal,
which is what a test can then assert.

The exact reason still reaches the log at every caller, and
`location-intelligence-service` carries it on the outcome as `capReason`.

**The geocoder's own state was renamed for the same reason.**
`geocoder_daily_cap_reached` is returned in the response body and was true of
one refusal in three. It is `geocoder_not_attempted` now — named for what
happened rather than for one of its causes — and it stays distinct from
`geocoder_unavailable`, which means map service access is broken and is a
genuinely different afternoon's work.

Four tests pin it: the mapping itself; that the two neutral reasons never
produce allowance wording; that no client-reachable string carries a
configuration name, infrastructure vocabulary or a digit; and that no caller
spells the exhausted-quota claim itself. The last is judged on **code with
comments stripped** — a comment may quote the false claim in order to forbid
it, which is `rf72b1b0GeocodeRefusal`'s own rule.
