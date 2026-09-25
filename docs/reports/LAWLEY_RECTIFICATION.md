# 60 Lawley Street, Spalding WA 6530 — Compass rectification

**Evidence:** the Investment Compass delivered on 25 Sep 2026
(`Investment_Compass_60_Lawley_Street_Spalding_WA_6530_2026-09-25.pdf`),
report `5d8bc97e-9305-49a4-bb3d-5cd2a7a0d82d`, generated from revision
`08296a305` (main after #2763). Read as a document, page by page, and traced
through acquisition → validation → storage → scoring/narrative → tables →
export before anything was changed. The document is evidence of the output;
every cause below was confirmed in the code or the production logs before it
was repaired.

Two statuses are kept apart, as `QA_291SM_REMEDIATION_TRACKER.md` does:
**implemented · tested** means the code changed and a test that FAILS on
`08296a305` now passes (`lawleyRectification.spec.ts`: 47 such tests fail on
the base revision, 17 preservation tests pass on both); **verified on the
regenerated document** is reserved for a page read off a regeneration through
the product after deploy. Nothing is marked verified because code changed.

## Baseline

| | |
| --- | --- |
| Revision | `08296a305` |
| Report | `5d8bc97e-9305-49a4-bb3d-5cd2a7a0d82d`, Compass tier |
| Generation | 01:31:57Z → 01:38:26Z, 25 Sep 2026 (6 min 29 s, 16 sections; two other reports regenerated concurrently) |
| Score | Scoring V2 3.0.0 — **A+ at 89**; growth, location and yield measured; demand a gap (Domain HTTP 403, no SQM rent); risk not scoreable. Growth rests on the ABS state series for WA (caution recorded). |
| Scorer inputs | price 499,000 · weekly rent 525 · house · bedrooms 3 / bathrooms 2 (the generator's modelled defaults — the scorer does not read either) |
| Prompt budget | every section logged `trimmed true`; pinned context 33.8 KB, base prompt kept ~16.4 KB of 31.6 KB; 13 KB of each user message was the shortcode vocabulary |

## Scoring: what did not move

The brief forbids changing the five dimensions, weights, thresholds,
eligibility, missing-data treatment or the grade calculation, and none of them
changed. Proven two ways:

- **Frozen-input equivalence.** The same frozen Lawley input scored on
  `08296a305` and on this branch: total, grade, every dimension score, weight,
  exclusion and confidence, the risks and the caution are identical. The only
  differences are words — the growth strength now names the grain it was
  measured at, and the Location detail says what the transit count counts.
- **Preservation tests** pin those numbers and pass on both revisions.

What a regeneration CAN change, through the existing path only: an operator
who records bedrooms, bathrooms or a build year in the Manual Data Override
modal feeds `manual_overrides`, which the generator already read. Bathrooms
and the build year reach no scoring input (the scorer reads price, rent and
type). Bedrooms reach the SQM rent-series lookup, whose default is already 3.

## Issue checklist

| # | Symptom on the page | Confirmed cause | Correction | Status |
| --- | --- | --- | --- | --- |
| 1 | **No watch points** beside an A+ (p.3) | The projection filled `summary.watch` from `weaknesses` alone; a record whose scored dimensions are all strong has none | `verdictWatchPoints`: weaknesses where held, else the V2 record's own risks and the run's evidence caution — record words, nothing composed; V1 purchase risks never read | Implemented · tested |
| 2 | Strength "capital growth **in this suburb**" over a WA all-dwelling series | `swot()` hard-coded the geography | The strength names the grain in the caution's own words (`growthEvidenceGrain`); thresholds untouched | Implemented · tested |
| 3 | "Configuration · 2 car" (p.3) | Car spaces were the only part held; the line read as complete | Names what is not recorded; the modal now takes bedrooms, bathrooms and year built | Implemented · tested |
| 4 | SWOT "no weakness identified" beside a one-bathroom, older house | `buildSwot` never read bathrooms or the build year | Dwelling weaknesses from the RECORD only, each saying it is not a defect | Implemented · tested — needs the operator to record the rooms and year (Blocker B7) |
| 5 | Grade method inside the SWOT (pp.16–18); "reconstructed" beside "nothing is re-derived" | The dimension table was appended to the SWOT; the prose treated held-but-exact weights as missing | `composeGradeMethodology` → appendix; prose distinguishes held/exact/reconstructed; scoring OFF now removes it | Implemented · tested |
| 6 | Pages 13–14 quote portal DOM, medians and sales counts; later chapters say none held | The model used live search under a prohibition with no permitted form; composed chapters were right about the registers | Permitted form (`PORTAL_FIGURE_PERMITTED_FORM`) in both rule branches; composed text says "the registers this assessment reads" and that a portal figure is not a register reading | Implemented · tested; the evidence itself is Blocker B1 |
| 7 | Route 852 on pp.9–10 vs "no public transport" in the score and the risk register | The transport block ignored `stationsWithin2km` and told the model nothing was retrieved; the score detail said "no public transport"; frequency came from a council profile | Station count stated as what it is (stations only, no bus stops, no frequency); timetable rule; score detail reworded (score unchanged); SWOT says a route in prose is not a register measurement | Implemented · tested; operator timetable reading is Blocker B4 |
| 8 | Population "0.3% between 2020 and 2025" | The table printed `+1.62% (0.32% a year)`; the rule sat in the trimmed middle of the prompt | Row names total and rate; wording rule with the permitted sentence; both pinned | Implemented · tested |
| 9 | Opening "STRONG BUY" vs closing "proceed only after" | Two vocabularies, neither section told what the other is | Both sections' instructions state what the classification is and that the recommendation is conditional; no qualification removed | Implemented · tested (instruction); regeneration will show whether the model obeys it |
| 10 | $499,000 captioned "Contract, before costs" | The price is an operator-entered analysis figure (`accepted_input`); the caption is static text in the seeded dashboard master | Prose already says "recorded analysis price" | **Blocked** — B6 |
| 11 | "Visible competing Houses in Spalding" over the subject alone (p.14) | Every competing listing carried a placeholder; the half-table and then its caption survived | A comparison with one side left declines on both paths, caption included | Implemented · tested; real comparables are Blocker B1 |
| 12 | Planning registers after the Final Recommendation (p.21) | Placed as their own section at order 89 | `mergeBlocksIntoSections` closes each chapter with its evidence; old placement is the fallback | Implemented · tested |
| 13 | "ConfidenceChip:" (p.10), column "Date something happened" (p.7) | Registry ids and a purpose phrase handed to the model as words | Guide describes components in reader words; read-path scrub rewrites both | Implemented · tested |
| 14 | "Parcel area of not stated" | The planning purpose demanded a value slot | Purpose reworded | Implemented · tested |
| 15 | "Floor space ratio" asked of a WA lot, three times | NSW vocabulary for every jurisdiction | WA rows: R-Code, height, plot ratio; others byte-identical | Implemented · tested |
| 16 | "integrated for Queensland only so far" printed four times | A build note in the service's answer | Reader's sentence at the service and at both readers (cached answers) | Implemented · tested |
| 17 | Bushfire "Not searched" in WA | WA treated as one licence; OBRM-026 is CC BY 4.0 | Read by explicit layer id; `c7` invalidates cached answers | Implemented · tested; production egress unmeasured (B5) |
| 18 | Tenant-demand card clipped (p.4) | Tile value capped at two lines | Label 3 / value 4 / note 3 lines; ellipsis only beyond | Implemented · tested |
| 19 | Twin headings (p.18), empty "Disclaimer" heading | Adjacent same-words headings at two depths; footnote definitions counted as content | Folded; heading over only definitions dropped, definitions kept | Implemented · tested |
| 20 | Exit outlook introduced a projection the Compass does not carry | One intro for every tier | Intro follows what the section draws | Implemented · tested |
| 21 | Monitoring "On request" | A certificate route printed as a change frequency | First checks separated from readings; events, not a schedule | Implemented · tested |
| 22 | Commute called a commute and a drive interchangeably | Mode not read | Drive = free-flow, not peak; journey planner answer named as one | Implemented · tested |
| 23 | QA reported an unbalanced strengths/watch-points pair that was balanced | A run-in "**Watch points:** …" was not read as the second list | Both validator copies read it | Implemented · tested |
| 24 | "Recorded as a three-bedroom, one-bathroom House … reported build year of 1979", attributed to "the supplied property records" (pp.3–4) | The record holds none of the three (first invocation: `Beds: undefined`, `Baths: undefined`; no stored override carries them). The rule forbidding an unrecorded attribute sat in the base prompt, trimmed on every section, and the pin carried neither table nor rule; the figures came from a live search | `recordedAttributesBlock`: one composition of the attribute table and its rule, drawn in the base prompt and pinned, with the permitted form ("not recorded for this assessment; confirm against the contract, the listing and the inspection") | Implemented · tested; the rooms themselves are Blocker B7 |

Everything above is **pending verification on the regenerated document**:
merge, the edge deploy and a Lovable publish (the modal) come first, and they
wait on the owner's confirmation.

## Blockers, with the action each needs

- **B1 — Market, days on market and comparable sales.** Domain answers 403
  *"Operation not permitted on project"*: the Properties & Locations package is
  not attached. Action: Domain Developer Portal → Projects → API Access → add
  Properties & Locations → Save (`docs/integrations/DOMAIN_ACTIVATION_REQUEST.md`).
  Portal figures stay unreproduced until reuse terms are confirmed.
- **B2 — WA zone, R-Code and floodplain.** DPLH-071 (scheme zones) and the
  DWER floodplain datasets are published under "Custom (Active Acceptance)"
  terms. Action: written authorisation from DPLH/DWER for commercial reuse, or
  a City of Greater Geraldton planning enquiry / certificate supplied through
  the existing override route.
- **B3 — WA crime.** No WA register is integrated. Action: measure the WA
  Police Force locality statistics' terms and format, then add an ingest stage
  alongside SA/NT (`docs/reports/CRIME_SOURCES.md`).
- **B4 — Current operator timetable.** The PTA's GTFS (valid 22 Sep–21 Dec
  2026; includes TransGeraldton) answers from this sandbox and is now the
  declared WA candidate. It runs route 852 hourly on weekdays (9 departures
  07:34–16:04 one way, 10 departures 09:02–17:15 the other), every two hours
  on Saturday and not on Sunday — not the profile's "five daily services".
  Action: the owner decides on the PTA
  licence's trademark/attribution clause, then a production probe
  (`transport-gtfs-ingest` `{"stage":"probe"}`) and a load. A frequency reading
  is a new capability and is not built here.
- **B5 — Bushfire register from production.** CI and this sandbox reach
  `public-services.slip.wa.gov.au`; the production egress is unmeasured until
  the first WA report after deploy. Action: read `planning-data-service` logs
  on that run.
- **B6 — Price caption.** "Contract, before costs" is static text in the
  seeded dashboard master. Action: approve seed v20, its migration and the
  active-master refresh (a template change this brief does not authorise).
- **B7 — Rooms and year.** The record holds no bedrooms, bathrooms or build
  year. Action: record them in Manual Data Override (fields added here), then
  regenerate.
- **B8 — Infrastructure pipeline.** City of Greater Geraldton capital works and
  WA budget papers are not integrated registers; the report states the
  coverage limit. Action: supply the adopted capital works programme as a
  document through an existing ingestion route.

## Rules this added

- **A licence is read per resource, never per jurisdiction.** WA's scheme data
  is restricted; its bush fire map is CC BY 4.0.
- **Evidence closes the chapter it is evidence for**, and the recommendation
  stays the last assessment.
- **A comparison with one side left is not drawn** — and neither is its
  caption.
- **Our words never reach the page as labels**: a registry id or a phrase of
  the prompt is described to the model, and scrubbed on read.
