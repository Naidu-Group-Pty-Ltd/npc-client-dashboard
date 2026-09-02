# Reporting Engine audit — September 2026

A full end-to-end audit of the reporting engine, conducted stage by stage with the
product owner: architecture → data injection → generation pathways → template
selection and white-label → practical rendering. This file is the durable record
of what was measured and found. **No behavioural change ships with this
document** — every fix is listed for the consolidation programme, and anything
that hides or retires a legacy pathway explicitly awaits the owner's
authorisation.

Method: the docs in `docs/reports/` were read first and then re-verified against
the code and against the **live production database** (read-only). Rendering
claims were verified by rendering: the pinned engine (WeasyPrint 69.0) with the
container's own typefaces, the repo's measurement tooling, real production rows
through the real projections and templates, and a page-by-page review of the
result. Every load-bearing number below is a fresh measurement dated
2026-09-02, not a quotation of an earlier doc.

---

## 1 · Architecture census

Two layers, separate in code and time:

**Generation** (content): `generate-investment-report` writes model-authored
Markdown into `investment_reports.report_content` under a wall-clock budget with
three resume drivers (browser pump, bulk worker, 2-minute cron watchdog). Other
formats are deterministic calculators plus bounded model prose. Sub-reports
derive from a Compass parent: **fork** (`fork-investment-report` — deterministic
section split via `_shared/reportSplitRegistry.ts`, no model calls, idempotent,
inherits the parent's data wholesale) and **condense**
(`condense-investment-report` — model-condensed briefing/snapshot, regenerates
in place).

**Rendering** (documents): five engines exist in live code.

| # | Engine | Carries |
| --- | --- | --- |
| 1 | WeasyPrint via nine per-format design-system routes (`render-*-pdf`) | the migrated formats' standard documents |
| 2 | WeasyPrint via `render-template-pdf` (browser compiles HTML through `compileTemplateHtmlForPdf`) | chosen-template documents |
| 3 | WeasyPrint via `render-investment-report-pdf` — 5.7k-line monolith, own inline THEME, own private client, Api2PDF fallback | nearly all Investment volume |
| 4 | pdf-lib in Deno ×2 (`quantitative-report-pipeline`, legacy export inside `report-qa`) | quantitative reports; legacy Q&A export |
| 5 | ~17 live browser generators (jsPDF / html2canvas / pdf-lib) | the legacy side of most formats; record nothing |

Storage: `investment-reports` (two producers), `client-files` (six routes),
`marketing-reports`, `qa_exports`, `quantitative-reports`, `converted-templates`;
all report PDFs served by signed URL (TTLs vary: 7d legacy / 24h routes / 15-min
`secure-storage` ceiling). Ledgers: nine `*_renders` tables +
`template_render_jobs` + `template_events`.

Two unrelated systems share the word "template": `report_templates`
(presentation / white-label) and `report_structure_templates` (generation-time
structure guides). They never touch.

## 2 · Live measurements (2026-09-02)

- Coverage (per `COVERAGE.md`'s own query): investment **1,174 / 0** via design
  system; report_qa 255/2; portfolio 26/2; market_intelligence 7/0.
  **The coverage query cannot see the templated path** — it counts `*_renders`
  ledgers, while template renders land in `template_render_jobs` (127 rows, 114
  succeeded, successes for `investment_compass` and `commercial_capacity` on the
  audit date). `investment_report_renders` has **no writer anywhere in the
  codebase**, so that cell can never move.
- Templates: 10 active global WeasyPrint masters (one per format spelling,
  "Private Banking — Chancery") + 4 active user-scoped adoptions; 96 legacy
  jspdf rows deactivated. 4 stored selections, all valid.
- Downloads, last 45 days: `premium_weasyprint` 24 (legacy investment route),
  `cash_flow_server` 11, `cash_flow_template` 7, `report_viewer` 6 (browser),
  `pixel_perfect_generator` 1.
- `investment_reports`: 1,174 completed / 18 failed / 1 stale pending (the
  resume watchdog works). 17 new reports in 30 days.
- Sub-reports in production: snapshot 25, briefing 22, financial 10,
  strategic 10 — all four active on the audit date.

## 3 · Findings register

Class key: **D** data/content · **P** pathway/delivery · **T** template/white-label · **R** rendering.

| # | Class | Finding | Evidence / location |
| --- | --- | --- | --- |
| F1 | D | `financial_calculations` injection unreliable: 190/1,174 rows overall; 71% of Compass rows since June; no record of why any row lacks it | live DB; `generate-investment-report` phase 2 |
| F2 | D | Stored record contradicts itself: `keyMetrics.annualNet/weeklyNet` vs `projections.moderate[0].cashFlow` agree on **0 of 162** rows, median gap **$24,793**; legacy renderer prints the keyMetrics side, templates print the series | `cashFlowProjection.pure.ts` header; `render-investment-report-pdf` exec summary |
| F3 | D | Overrides go stale: saving `manual_overrides` does not recalculate; legacy renderer references the column **zero** times; only `{{overrides.*}}` carries corrections and no master binds it. 435 rows (37%) carry overrides | `ManualDataOverrideModal.tsx:1174`; grep of legacy renderer |
| F4 | D/T | Brand baked into content: generator writes `# BRAND / YOUR DEDICATED PROPERTY PARTNER / Investment Report: …` into `report_content`; `narrative.source` republishes it verbatim, so templated documents print a second, generation-time cover inside the body (verified on a real render — including the literal heading "Cover Page") | `generate-investment-report:5311`; `compassSectionRegistry.ts` cover section `includeInCompass: true` |
| F5 | D | Missing source data is silent: Phase-1 service failures only log to console; nothing on the row records completeness | `generate-investment-report:2541-2575` |
| F6 | P | The two investment pathways differ in **content**: legacy adds a self-authored executive summary, an "Editor's Note", and hero photography; the templated path has none of these | `render-investment-report-pdf:3025-3055`, hero reads at `:2702-2730` |
| F7 | R | Charts drawn by two implementations (legacy's 11 private SVG renderers vs shared `vizFigures`) | both files |
| F8 | D | Reports unlinked from clients: `client_property_id` on 2/1,174; no client name on the row | live DB |
| F9 | P | Two engines answer to "Financial": `TierSwitcher` generates it via condense (model) while `ReportVariantControls` forks it (deterministic); both address the same child row and regenerate in place | `TierSwitcher.tsx:99`; `ReportVariantControls.tsx:30`; `condense-investment-report:404` |
| F10 | P | Sub-reports go stale silently: children refresh only on click; nothing compares child freshness to the parent's `updated_at` | `fork-investment-report`, `condense-investment-report` |
| F11 | P | The report page's primary "Download" produces a **.txt dump**; the PDF exits live lower in the export panel | `InvestmentReportView.tsx:136-151` |
| F12 | P/T | **Send to Client / client portal never receive the templated document**: they ship stored `pdf_url` (written by legacy route *or* browser generator, whichever last) or a fresh browser PDF | `SendToClientModal.tsx:159-199`; `InvestmentReportView.tsx:282`; `PortalReports.tsx:82-114` |
| F13 | T | The template invariant is process-enforced only: binding expressions permit arithmetic (`{{=financials.x * 1.1}}` passes `SAFE_EXPR_RE`), so nothing mechanical stops an approved template computing a figure | `bindingResolver.ts:193` |
| F14 | T | `client_branding_profiles` (the Templates → Branding tab) is a decoy: nothing in the reporting engine reads it | `BrandingManager.tsx`; grep of `applyOrganisationAndBrand` chain |
| F15 | T | `whitelabel_settings.company_name` stored with trailing space (no visual effect — the projection trims; data hygiene only) | live DB |
| F16 | P | Market Intelligence scheduled email has nothing to attach: `pdf_storage_path` is 0/7 (only the unused server persist path writes it); the labelled "Generate Report" button is the browser jsPDF path, which persists nothing | live DB; `MarketIntelligencePDFGenerator.ts` |
| F17 | D | Model prose contradicts structured facts: a real report states "3 bedrooms" (×3, including the closing summary) for a 4-bedroom subject; nothing reconciles prose against `property_specs` on any pathway | real render, pages 27/28/32 |
| F18 | R | Truncation leaves skeletons: `truncateNarrativeToCap` keeps headings while deleting their prose and appends a literal "…" — nine content-less headings and eight severed sentences on one real document | `compassPostProcessor.ts:190-210` |
| F19 | R | Markdown paging under-fills by ~2×: fixed `DEFAULT_LINES_PER_PAGE = 34` undershoots the rendered frame; 26 consecutive pages at 30–60% full; lead-in lines stranded above white | `reports/markdownPaging.pure.ts:16` |
| F20 | R | Loose ordered lists render as separate `<ol>`s — a 15-item checklist numbered "1., 1., 1., …" | `reports/markdown.pure.ts:985-1012`, `listHtml` ~`:1245` |
| F21 | R | A table row can be clipped with its continuation drawn above the running head and lost — observed mid-word on a real risk register | real render, pages 29→30 |
| F22 | D | The money page doesn't foot: upfront total $500 short of its own column; net position $2,176 off the visible rows (stored totals vs stored lines) | real render, page 6; `financial-calculator-service` outputs |
| F23 | R | The company/back page renders in a different palette and typeface from the template family around it | real render, page 36 |
| F24 | R | Footnote syntax (`[^abs]`) prints as body copy — no footnote handling in the Markdown renderer | `reports/markdown.pure.ts` |
| F25 | R | Part numbering counts pages, not sections: running heads reach "Part 49" on an 11-section document; two pages share "07" | `reports/investment/render.pure.ts:380` |

Minor (unnumbered): display heading overrun on one risk page; duplicated
headings 16 pages apart; pseudo-tables flattened to bullets; raw scoring-band
strings ("Good walkability (50-69)") and enum values reaching client prose;
mixed minus glyphs; "andother" missing space; contents labels disagreeing with
page headings.

## 4 · What verified sound

- **The template invariant holds on real data**: one live Compass row rendered
  through two families produced 81 currency/percent figures each, identical
  except each family's KPI strip curating a different *published* figure.
  Switching templates changes presentation only.
- **The selection chain**: 159 repo tests pass (route enforcement, resolver
  parity ×3, selection rules, seeded master through the real render boundary,
  font policy, brand-mark rules, adoption idempotency). Selections are re-read
  and re-validated server-side; stale choices fall back with a notice.
- **White-label sources are live and correctly keyed**: `report`/`reportMono`
  logo slots uploaded and matching the resolver's spelling; ABN, address,
  phone, disclaimer present in `global_report_settings`.
- **Typed design-system pages are professional**: fixture harness renders all
  formats with zero high-severity findings; real cash-flow tables are
  immaculate (banded, aligned, unwrapped numerals, semantic negatives).
- **The sub-report mechanism**: fork inheritance, idempotency, and one
  selection driving the whole family (compass + tiers fold to one key, active
  masters exist under both raw spellings).
- **Pipeline health**: watchdog keeps `investment_reports` at 1 stale row;
  production template renders succeeded on the audit date.

## 5 · Pathway / duplication register

**Same report, competing engines (user-visible):** investment's six exits
(.txt, template route, legacy server route, browser pdf-lib, Send-to-Client,
listings-modal jsPDF); Q&A's two exporters; Comparison's model-rewrite-per-
download beside the deterministic route; Market Intelligence's labelled jsPDF
button vs typeset popover; Cash Flow's four PDF exits; Client Details' Formara
twin; `FlattenPdfIconButton` on 18 surfaces. Commercial Capacity is the
consolidated model: one road.

**Same logic, multiple copies:** cash-flow cascade ×3 (the F2 divergence);
template resolver ×3; report-type normaliser ×2; chart primitives ×2;
browser/server calculator mirrors (`lenderLvrCaps.ts` and
`capitalAllocationLedger.ts` measurably drifted); orphaned
`buildTemplateBindingContext.ts` (three documented defects, zero callers);
drifted `compassSectionRegistry` mirror (672 vs 174 lines).

**Same name, different product:** "Financial" (F9); two unrelated "10 Year
Cash Flow" reports (investment modal vs commercial calculator print view).

**Dead but shipped:** `EnhancedInvestmentReportModal`, `QAPDFGenerator`,
`HybridPDFTemplate`, `StrictPDFTemplate`, `ClientPDFTemplate`,
`reportTemplate/pdfRenderer.ts`.

## 6 · Consolidation programme (draft — sequencing for owner sign-off)

Priorities agreed during the audit: accuracy · consistency · reliability ·
template compatibility · rendering quality · user experience. Legacy pathways
stay reachable throughout; **hiding them is a later, separately authorised
step**.

**A — Narrative channel (fixes most of what a client sees; small, local):**
exclude the Cover Page section from Compass assembly (the contents section
precedent is recorded in the registry's own header); truncation drops a heading
with its prose and never emits "…"; calibrate/measure markdown paging against
the rendered frame + keep-with-next for lead-ins; merge loose ordered lists and
carry `start`; strip or render footnote syntax; number parts by section, not
page; keep table rows whole across breaks; theme the company page from the
template family.

**B — Data-layer reconciliation (accuracy):** reconcile model prose against
`property_specs` at the enrichment boundary and fail loudly (F17); make
`financial_calculations` internally consistent or publish one side only (F2,
F22); record per-source fetch outcomes on the row (F5); regenerate-on-override
or stamp staleness (F3); investigate and alarm on missing fincalc (F1).

**C — Delivery unification (reach):** route Send-to-Client / portal / scheduled
sends through the same template-first delivery the downloads use (F12, F16);
make the report page's primary Download produce the document, not a .txt
(F11); single writer for `pdf_url`.

**D — Sub-report cascade:** one engine per variant name (fork for
financial/strategic, condense for briefing/snapshot — remove `financial` from
condense's accepted tiers or repoint `TierSwitcher`) (F9); staleness marker
against the parent (F10); regenerate children on parent regeneration or offer
one-click "refresh family".

**E — Invariant hardening:** refuse arithmetic over financial namespaces in the
production template guard (F13); retire or wire `client_branding_profiles`
(F14); write a `report_render_events` row from legacy paths and include
`template_render_jobs` in the coverage measure so the number tells the truth.

**F — Later, upon authorisation:** hide (not delete) the legacy generators
behind the unified delivery; retire dead components; fold the duplicated logic
copies onto their canonical modules.

## 7 · Reproduction

- Fixture harness: `npx tsx scripts/reports/renderAll.mts` (WeasyPrint 69 +
  `weasyprint-service/fonts/` installed locally; poppler-utils for
  `pdftoppm`/`pdftotext`).
- Real-row template render: build the projection data exactly as
  `scripts/template-library/productionFit.ts` does (`investmentData`), render
  with `renderTemplateToHtml(schema, { data, fontSource: 'container' })`, and
  measure with `scripts/reports/measure_pages.py`.
- Live counts: the SQL in `COVERAGE.md`, plus `template_render_jobs`,
  `report_template_selections`, `report_templates` grouped by
  engine/scope/active.

## 8 · Phase 0 + Phase 1A — implemented (2026-09-02)

The first two phases of §6's programme shipped together, and every number
below was re-measured on the same two production rows §5 measured, so the
before and after are the same instrument.

### Phase 0 — the measure

`public.report_render_coverage` (migration `20260915100000`) unions the nine
`*_renders` ledgers, `template_render_jobs`, and engine-tagged
`activity_logs` events into one engine × format × week matrix. The write side
is two pieces: `src/lib/secureInvoke.ts` auto-tags every successful
`render-*-pdf` / `render-template-pdf` invocation (the meteredFetch pattern —
coverage a new call site cannot forget), and `src/lib/reports/renderEvent.ts`
is the explicit helper for the ledgerless pathways, wired into the stored-PDF
chokepoint (`clientPdfDownload`), Formara, the Market Intelligence jsPDF
buttons and the portfolio pdf-lib generator. Remaining minor surfaces (print
views, flatten buttons, the QA editors, the commercial/industrial utils, the
listings modal) are listed for the same one-line treatment in the follow-up.

### Phase 1A — the narrative channel, calibrated and cleaned

`scripts/reports/markdownCalibration.mts` is the new measuring instrument: it
rendered probes through the real seeded Chancery master twice — pager in
charge, then bucket cap lifted — and found the pager sending every narrative
page at **40–47% of its measured capacity** (~54.5 rendered line-units per
continuation page, ~42.5 on the first; prose wraps at ~98 chars, the charge
model said 65). That under-fill was every "large sectional gap".

What changed (all charge-model changes are opt-in per format via
`resolveNarrativeProfile`; every uncalibrated caller is byte-identical):

- **Measured charges + calibrated budgets** for the investment narrative
  (`markdownPaging.pure.ts`, `markdown.pure.ts:charging`), resolved
  identically by the markdown block and the projection so the conditional
  page count and the drawn buckets cannot disagree. The deployed schemas'
  baked `linesPerPage: 34` is read as the legacy sentinel.
- **Keep-with-next**: a page never ends on a heading or a lead-in line
  ending in a colon.
- **Tables split by rows with the head repeated** when taller than a page
  (`splitTableBlock`), charged by real cell wrap — the clipped risk-register
  row (F21) is structurally impossible now.
- **Loose lists merge** (fifteen "1." items are one list again) and ordered
  runs keep their opening number (F20).
- **Footnotes render**: `[^id]` becomes a superscript with a Notes list;
  a citation-shaped ref with no definition strips instead of printing (F24).
  `sup.fn-ref`/`ol.fn-notes` joined the print stylesheet's vocabulary.
- **Skeleton headings drop** (`dropEmptyHeadings`, default on) and the
  word-cap truncation now cuts cleanly: no heading survives its deleted
  prose, no literal "…", while figures and tables still always survive
  (F18, and the standing figures-and-tables rule).
- **The baked cover is gone twice over**: `compass.cover` is excluded from
  generation (the contents-section precedent), and
  `reports/investment/narrativeClean.pure.ts` strips the masthead and
  "Cover Page" section out of the 1,100+ stored narratives at read time, on
  both sides of the contract (F4).
- **Scorecard band jargon is cleaned at the projection** — "Good walkability
  (50-69)" publishes as "Good walkability" (the F-series readability item).

Measured on the same rows as §5: 48 Budgeree via the user's selected
Dictionary master went **36pp → 22pp, median body ink 0.055 → 0.111**, with
every narrative page inside the native 0.10–0.13 band, zero cover/masthead
artefacts, zero footnote syntax; the 6 Acer Court financial fork via Chancery
went **21pp → 15pp, median 0.097**, risk register split with repeated heads
and no severed row. The remaining sparse pages are the typed fixed-geometry
pages (contents, dashboard, property, sources) — Phase 1B's schema-side
economy work, alongside the part-numbering and back-page theming that also
live in the seeded schemas.

### Phase 1B — the schema-side pass (2026-09-02, same day)

- **One part number for the whole report body.** Every narrative continuation
  page minted its own — running heads marched "Part 08 · Report" through
  "Part 33", and Sources introduced itself as Part 49 with a two-inch numeral.
  The opener mints the label once and every continuation (and the cut page)
  carries it verbatim; a Compass now runs Part 01–09. The labels are baked
  into schema furniture, so the fix ships as the v9 catalogue seed
  (`20260916100000`) plus a reactivation migration (`20260916110000`) that
  refreshes every active row from its published entry — the same mechanism,
  guards and colourway-exclusion as `20260816150000`, with a probe that no
  active investment schema still carries "Part 15 · Report".
- **The closing page dresses in the family's tokens.** `disclaimer.html.ts`
  hardcoded a foreign ground (#141414), one of the audit's eight stray golds
  (#BF9B50) and a Helvetica fallback — the critic's "back cover from a
  different design system". It now reads the colourway (`bg`,
  `accentOnField`, `text`, `mutedOnField`, the heading face), with the old
  literals as fallbacks so token-less templates render unchanged. The
  split wordmark (every word large, the last small beneath — "SERVICES" as a
  subtitle) is one name at one size in the family's heading face.
- **Deliberately not done here, and why:** the typed front-matter pages
  (contents, dashboard) measure sparse and are left so — front matter in a
  premium document is airy by intent, and densifying it is a family-design
  decision for the Claude Design catalogue, not a defect fix. The data-sparse
  typed pages on financially-empty rows are queued with Phase 2's
  completeness work, where the row-level `when:` guards already carry most of
  it.

## 9 · Phase 2 — accuracy gates (2026-09-02)

Phase 2 set out to make the Investment report's figures one truth end to end.
Reconnaissance for it found something larger than the divergence the audit
had measured: **every stored 10-year projection series was charging the
property's operating costs roughly three times over.**

### F26 — the projection fold triple-charged operating costs

`generateProjections` (financial-calculator-service) folded
`Object.values(annualCosts)` into its cost base, and that object carries its
own totals (`totalAnnual`, `totalAnnualExcludingLandTax`) and a percentage
beside the line items — so the opex base was
`2·totalAnnual + totalAnnualExcludingLandTax + percent`. Proven to the
dollar on the captured production row ($1.19M NSW house, rent $739/wk):

|                                   | stored | honest |
|-----------------------------------|--------|--------|
| Year-1 operating costs charged    | **$59,931** | $22,232 (totalAnnual × 1.038 CPI) |
| Year-1 cash flow (moderate)       | **−$92,557** | −$54,858 |
| Year-1 ROI                        | **−18.89%** | −3.05% |
| 10-year cumulative position       | overstated by ~**$370k** | — |

The buggy base reconstructs exactly: 2×21,418 + 14,893 + 7 = $57,736, and
×1.038 (that day's cached year-1 CPI) = $59,930 ≈ the stored charge. The
headline `keyMetrics` used a third base (un-escalated, land tax out), so one
page contradicted itself by $43,885/yr — and the generator's prompt injected
the poisoned series verbatim as the cash-flow table the model transcribes,
directly under a stated formula ("rent − operating costs − repayments")
whose quoted operating costs were the sane ones. The sensitivity analysis
carried the same fold twice more. Nobody could reconcile these numbers
because they were not reconcilable.

### F27 — adjacent accuracy defects, same commit series

- `totalUpfront` = deposit + duty + hardcoded $2,000 — ignoring the row's
  own `legalFees`/`inspectionFees` lines (historic rows off by $500+); the
  cash-on-cash denominator was a second hardcoded derivation.
- The prompt forced **accounting-negative notation onto positive cash
  flows** (`($X)` via `Math.abs`), taught that P&I repayments decline ~5% by
  year 10 (they are constant; the split changes), bound `p.lvr` — a field
  the series never had — printing the literal "XX%", and asserted "all
  scenarios produce negative cumulative cashflow" unconditionally.
- Manual overrides reached `financial_calculations` by three writers, all
  splatting values over computed leaves: the captured row carries overridden
  line items summing $13,578 beside `totalAnnual` $21,418, with projections
  and metrics describing neither (C5's defect, proven on the same row).

### What shipped

- **C1 — one engine, one cost base**
  (`_shared/reports/investment/financialEngine.pure.ts`). All calculator
  arithmetic extracted pure and pinned by `financialEngine.spec.ts` against
  the captured row; the service keeps orchestration only. Projections,
  sensitivity and headline cash flow share `operatingExpensesFrom` (the
  footed total, never a fold); the year-0→year-1 gap is exactly the declared
  escalation. The one deliberate asymmetry: net rental **yield** keeps the
  land-tax-excluded base (land tax follows the owner's aggregated holdings,
  not the property) and the report states the exclusion. Cash-on-cash
  divides by the same `totalUpfront` the report prints. The prompt's
  narrative figures are now derived FROM the series (`impliedOpexFromSeries`,
  `fmtCashFlow`, `seriesLvrPercent`, `cumulativeCashFlow`), so prose and
  table cannot disagree; the sign convention keeps the sign, and the
  cumulative-cashflow teaching is conditional on the data.
- **C2 — historic rows healed at every read boundary**
  (`reconcileStoredFinancials`). ~1,170 stored rows carry the fold; nothing
  rewrites them until regeneration, so readers heal them exactly: the fold
  base reconstructs from the row's own aggregates (original even where line
  items were overridden — nothing ever rewrote the aggregates), each year's
  CPI factor recovers as impliedOpex ÷ base, and cash flow, cumulative and
  ROI follow. Detection cannot misfire (buggy year-1 charge ≥ 2× totalAnnual;
  healthy ≤ ~1.1×). Totals are derived from the row's own lines; headline
  metrics recompute from components. Wired at the template binding
  projection, the legacy `render-investment-report-pdf` route (its 10-year
  and cash-flow charts drew the inflated series on every historic re-render),
  and the design-composer normaliser. Idempotent, never mutates the stored
  row, no-op on post-fix rows. Historic **prose** is beyond render-time
  repair — regeneration is the remedy, and regeneration now writes correct
  figures.
- **C5 — overrides go INTO the engine, on every writer**
  (`overrides.pure.ts`). An override that changes a modelled input (price,
  rent, rate, reviewed costs, duty, conveyancing) becomes calculator INPUT —
  `calculateAnnualCosts` takes the reviewed figures, an explicit $0 replaces
  the estimate, letting fees join the totals, and the totals foot against
  the final lines whoever supplied them. Only non-modelled fields (tax
  treatment, occupancy display, build splits, loan labels) merge afterwards,
  through one shared `applyDisplayOverrides`. `manage-investment-reports`
  recomputes server-side before the write (never blocking the save; the
  response and the modal's toast say which happened), and the generator's
  30-line splat loop is gone.
- **C3 — fact reconciliation** (`factReconciliation.pure.ts`). The prose is
  compared with the record at completion — bedrooms, bathrooms, car spaces,
  purchase price, weekly rent, land size. Report-level rule (recorded value
  never appears + a different value repeats) so comparative prose cannot
  trip it; money facts are context-anchored. Findings disclose as
  `validation_flags` `type:'fact'` entries in lay wording and never gate
  completion. Feeding findings into regeneration retries is deliberately
  deferred until the detector has production mileage.
- **C4 — completeness recorded and disclosed, no schema change.**
  `data_sources` now records all eleven attempted sources (was four) —
  present with provenance, or null as a recorded fact. The viewer's new
  `InvestmentReportCoverageNote` renders ONLY when a source is missing or a
  fact check flagged ("9 of 11 sources", the gaps named, each contradiction
  in a sentence); a complete, clean report shows nothing, because a badge
  must mean something is unmet. Carried on the detail projection of
  `get-investment-reports`.

### Verification

63 new spec assertions across `financialEngine.spec.ts`,
`investmentOverrides.spec.ts`, `factReconciliation.spec.ts` — the engine
pinned against the captured production row (its reconstruction reproduces
the stored totals and monthly payment exactly, and the heal reproduces the
stored corruption before repairing it). Full affected surface green: 2,330
tests, tsc, eslint, `audit:style` under baseline, production build.

### Deferred, with reasons

- Regeneration-retry wiring for fact findings (detector mileage first).
- Browser viewer chart components reading `financial_calculations` directly
  (the two live PDF routes and the composer are healed; the viewer's own
  charts join in the delivery-unification phase).
- Historic prose corrections (regeneration is the remedy; C1 makes every
  regeneration correct).

## 10 · Phase 3 — delivery unification (2026-09-02)

Programme item C: every pathway that puts an Investment document in front of
a person produces THE document — template-first, one implementation — and
the scheduled Market Intelligence email can finally attach one.

### What shipped

- **`deliverInvestmentPdf.ts` — investment's own `deliver*` module.** The
  correct chain (the person's chosen template → the legacy WeasyPrint
  route) existed once, inside `PremiumPdfButton`. It is the module now, in
  the same shape every other migrated format has, and every surface asks
  it. `templateRouteEnforcement`'s investment pins moved onto the module,
  which makes them stronger: they now guard the path every surface uses
  rather than one button.
- **F11 — the primary Download produces the document.** The page's main
  action (header, mobile bar) had saved the markdown as a `.txt` for the
  life of the page while the real PDF sat lower in a collapsible panel. It
  now delivers template-first with a busy state, and says "Download PDF".
  The raw-text export survives everywhere its label already said "raw
  text": the panel button, the header menu item, the document card.
- **F12 — Send to Client publishes what the operator reviewed.** The send
  produced nothing before: it shipped whatever `pdf_url` held (legacy
  route or browser raster, whichever wrote last) or minted a fresh raster.
  It now produces fresh through the same chain, uploads template renders,
  reuses the path the legacy route just persisted rather than re-uploading
  the same bytes, and falls back to the raster only when both engines fail
  — reachability kept, primacy corrected. The portal needed no change: it
  serves the snapshot it was sent, and the snapshot is now the document.
- **`pdf_url` has one meaning**: the storage path of the most recent
  standard-delivery document, recorded through the one
  `manage-investment-reports` broker (the module and the browser
  generator's bookkeeping both go through it; the legacy route's internal
  write is the same delivery's server half).
- **F16 — the scheduled Market Intelligence email renders its own
  attachment.** The dispatcher's generate step writes content, never a
  PDF, so every dispatch that had to generate failed before sending
  (`pdf_storage_path` 0/7 in production). It now reuses a recent report
  even when that report carries no PDF yet, renders through the same
  design-composer route the download button uses (`persist` on), and
  attaches the path handed back. The route still refuses anonymous
  service_role exactly as pinned; the dispatch acts FOR the schedule's
  creator, whose `marketing_analytics` permission the route checks under a
  delegated authMethod that cannot hit the permission short-circuit.

### Verification

18 behavioural assertions on the delivery module (chain order, option
forwarding, publish reuse-vs-upload, bookkeeping-never-fails-a-document)
plus the `investmentDeliveryUnified` source pins (F11/F12/F16 wiring by
name). Full affected surface green: 6,243 tests, `tsc`, eslint,
`audit:style` under baseline, production build; MI's `legacyPathStays`
route pins all hold; security inventory regenerated with the new
dispatcher→render edge.

### Deliberately not done here

- The orphaned investment design-composer (`buildInvestmentReport` /
  `render.pure.ts`) stays orphaned: it is the legacy monolith's eventual
  replacement and belongs to the separately-authorised legacy phase (F),
  not to delivery unification.
- `ClientPDFGenerator`'s client-side override splat (a fourth copy) is
  harmless now that stored financials are override-coherent (Phase 2 C5)
  and folds with the duplicate-copy work.

## 11 · Phase 4 — sub-report cascade (2026-09-02)

Programme item D: the Compass family behaves as one family — one engine per
variant name, one linkage, and staleness that shows itself.

### What the phase found live (beyond the register)

- **F9 was structural, not just a mis-routed button.** The two engines used
  DIFFERENT linkage columns (fork → `derived_from_report_id`, condense →
  `parent_report_id`) with different idempotency keys, so neither could see
  the other's child: one Compass could hold two contradictory "Financial"
  documents, one deterministic and one model-written.
- **F28 — the tier switcher read `investment_reports` from the browser.**
  The table's policies are service-role-only, so the sibling lookup always
  answered `[]` with HTTP 200: switching to an existing child was
  impossible and every click regenerated one (model spend included). The
  fourth surface to hit the read-through-the-server trap.
- **A regenerated condense child kept its first-creation data copies.**
  Regeneration rewrote the prose and left `financial_calculations`,
  demographics, specs et al. as copied on day one — fresh words over stale
  figures.
- **Every fork was scored against $0.** The fork's score inputs read
  `financial_calculations.purchasePrice` / `.weeklyRent` — paths the record
  never had (the figures live at `initialCosts.propertyValue` and
  `income.weeklyRent`).

### What shipped

- **`subReportFamily.pure.ts`** — one mapping (`engineForVariant`:
  financial/strategic → fork, briefing/snapshot → condense), family
  resolution across BOTH historical linkage columns, and derived staleness
  (`variant_generated_at` vs the parent's `updated_at`; missing stamps never
  cry wolf). Bridged to src; both switchers route through the shared
  `generateSubReport`, and `condense-investment-report` refuses
  `financial` at the server, naming the right engine.
- **`familyOf` on `get-investment-reports`** — the family read, server-side,
  under the reports module gate: two indexed lookups (never a composed
  `.or()` string), per-child staleness in the answer. `TierSwitcher` uses it
  (its direct browser query is gone), lists all five variants including
  Strategic, and shows "parent has changed since" on stale rows.
- **Staleness stamps and honest refreshes.** Condense stamps
  `variant_generated_at` on completion and refreshes the structured copies
  from the parent on regeneration; both engines write both linkage columns
  on new rows.
- **`InvestmentReportFamilyNotice`** on the report page: renders nothing
  when the family is clean; on a stale child, one "Refresh from latest
  data"; on a parent, which sub-reports lag and one click that refreshes
  exactly the children that already exist — a refresh never mints documents
  nobody asked for. Fork refreshes are free (deterministic); condense
  refreshes cost a generation and the button counts what it touches.
- **Fork scores read the record** (override → initialCosts/income), not
  absent top-level paths.

### Verification

31 assertions across the pure-module spec (engine mapping, dual-column
family resolution from any anchor, the staleness truth table, orphan and
incomplete-child handling) and the source pins (server refusal, no inline
engine choice on any surface, no browser table read, stamps and structured
refresh present, page wiring). Full affected surface green: 2,356 report
tests, `tsc`, eslint, `audit:style` under baseline, production build, edge
column gate; security inventory unchanged (no new call edges).

### Deliberately not done here

- Auto-regenerating children when a parent regenerates: a condense refresh
  spends a model generation, so the family refresh stays an explicit,
  counted click on the page rather than a silent side effect of every
  parent save.
- Backfilling the two linkage columns into one: readers resolve the union
  either way; a data migration is pure tidiness and can ride with any later
  schema work.
