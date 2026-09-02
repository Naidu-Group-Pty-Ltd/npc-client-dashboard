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
