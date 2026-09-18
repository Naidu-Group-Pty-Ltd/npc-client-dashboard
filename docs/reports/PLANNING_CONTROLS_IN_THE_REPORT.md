# Planning controls in the report

Read this before touching `_shared/planning/planningFacts.pure.ts`, the
`# Zoning & Planning Analysis` block in `generate-investment-report`, the
`planning` entry in `dataSources`, or `propertySpecs.zoning` /
`propertySpecs.councilArea`.

Companion documents: `ZONING_BY_JURISDICTION.md` records where each
jurisdiction's planning data comes from and how every endpoint was verified;
this one records what the **report** does with the answer.

---

## 1. The defect

`planning-data-service` has worked since 2026-09-06. It resolves the
jurisdiction from the layers themselves, returns the zone, the parcel, the
state development instruments and the DA activity, and says which of five
kinds of absence each empty cell is. `generate-investment-report` calls it on
every report with a verified coordinate and assigns the answer to
`enhancedData.planningData`.

The zoning **section** read none of it.

Measured on 262 Pallas Street, Maryborough QLD 4650 (report
`aa41bcec-5a5c-434d-9162-96deb50e9bdb`, generated 16 Sep 2026):

| question | answer |
| --- | --- |
| `property_specs.zoning` | null |
| `property_specs.councilArea` | null |
| zoning keys among the report's 25 manual overrides | 0 |
| `data_sources ? 'planning'` | false |
| the report's own stored coordinate | −25.5161079, 152.7074047 — correctly in Maryborough |

A live call to the deployed service at that report's own coordinate (pg_net
request 260612) answered `200` with `jurisdiction: QLD`, `parcel.status: ok`,
`lga: "Fraser Coast Regional"`, `locality: "Maryborough"`, `tenure: Freehold`,
licence CC BY 4.0, `zoning.status: not_served` (Queensland sets zoning in each
council scheme) and `developmentInstruments.status: none_at_point` — an
evidenced negative, not a gap. **The enrichment worked and the report
discarded 100% of it.**

What the reader got instead was the prompt's own furniture. The section was
101 lines of template carrying `[XX]%` site coverage, `[X]m` setbacks, `[XX]m²`
private open space, "Refer to LEP" for minimum lot size, height and floor space
ratio, and the sentence *"Check minimum lot size requirements (typically
450m²)"* — handed to a model with no source to fill any of it from. A model
asked for a control it has not been given supplies a plausible one. **450 m²,
8.5 m and 0.5:1 reached a client's document**, and nothing on the page told
them apart from a measurement. The template was also written for New South
Wales — Local Environmental Plan, Development Control Plan, a s10.7
certificate — on a Queensland property, where none of those instruments
exists.

---

## 2. The rules

1. **A control with no source is never a number.** Every cell is a value with
   a provenance or a named absence. There is no default, no "typical", and no
   bracketed placeholder for a model to fill. This is the rule the 450/8.5/0.5
   trio broke.
2. **An audited operator override outranks a layer, and says so.** A person
   who has read the certificate knows more than a spatial layer, so an
   override is never overwritten by an automatic reading — and it is labelled
   `operator_stated` rather than presented as a published control.
3. **A layer is indicative; the instrument settles it.** Every answer carries
   the jurisdiction's own verification instrument, and the section says on the
   page that this is desktop research rather than a planning certificate.
4. **The five absences are five different sentences.** `not_served` (the
   jurisdiction publishes no such dataset), `not_integrated` (no verified
   adapter), `licence_restricted` (the data exists and may not be
   republished), `none_at_point` (the service answered and nothing covers this
   point) and `unavailable` (the read failed). Collapsing them into "Not
   specified" is how "we did not look" comes to read as "there is nothing
   there".
5. **Adopted and draft never merge.** A control carries its standing, and a
   draft amendment is never reported as though it were in force.
6. **A zone that admits a use is not approval for it.** Development potential
   is described as conditional and subject to assessment, and no uplift is
   quantified.

---

## 3. What changed

`_shared/planning/planningFacts.pure.ts` is the one place that decides what a
report may state about planning.

- `buildPlanningFacts({ planningData, overrides })` folds the service's answer
  and the operator's audited overrides into one record: jurisdiction, council,
  locality, lot/plan, parcel area and basis, and a `PlanningCell` per control
  carrying `value | status | note | source | sourceUrl | licence |
  effectiveDate | retrievedAt | standing`.
- `renderPlanningControls(facts)` composes the client-facing table — Control /
  Reading / Standing / Evidence — plus the two paragraphs that qualify it
  (rules 3 and 6).
- `planningFactBlocks(facts)` is the prohibitions the prose beside it must
  obey. It deliberately does **not** repeat the readings: `planningStatBlocks`
  already puts the measured cells in the prompt and the table is handed over
  verbatim, so a third copy would give a model three versions of one fact to
  choose between.

In the generator:

- the eight `effectiveZoning*` constants are gone. They were computed from the
  overrides alone, at a point in the run **before a coordinate has been
  verified** and therefore before anything could have been retrieved — which
  is why a property whose zone the state's own layer would have answered
  printed placeholders instead.
- `property_specs.zoning` and `.councilArea` take the operator's record first,
  then what the jurisdiction's layer answered, then whatever the listing
  carried.
- `dataSources.planning` exists, carrying jurisdiction, council, zone status,
  source, licence, the layer's currency date, the verification sentence and
  the portal URL — so the coverage disclosure stops counting a source the run
  had already spent.

---

## 4. Queensland: what a council scheme can and cannot be read from

Queensland has no state-wide zoning layer; the zone is set in each council's
planning scheme. That is what `zoning.status: not_served` means, and it is
correct rather than a gap.

Measured 17 Sep 2026 from the production egress (pg_net; every request id is
recorded here):

| probe | request | result |
| --- | ---: | --- |
| ArcGIS Online search, "Fraser Coast zoning" | 261122 | 200 — the only Fraser Coast asset is `FCRC_Inundation_Zones`, published by the Queensland disaster-management org (`si70weKpzPSa0BGV`), not a planning scheme |
| that org's full catalogue, filtered for zone/planning/scheme/overlay | 261146 | 200 — evacuation and inundation zones for a dozen councils; **no planning-scheme zoning** |
| `eplan.frasercoast.qld.gov.au` | 261155 | **403** — the host exists and refuses a scripted client |
| ArcGIS Online, `title:(planning scheme zon*)` + Queensland | 261156 | 200 — **five councils publish a public planning-scheme zoning Feature Service**: Mackay, Moreton Bay (zones, dissolved zones and zone precincts), Burke Shire, Townsville and Sunshine Coast |
| Townsville's layer, queried at −19.2590, 146.8169 | 261206 | **200 with a feature** |

So Fraser Coast publishes no machine-readable scheme layer, and for 262 Pallas
Street `not_served` with the council named is the honest answer.

For the councils that do publish one, the endpoint shape is the same ArcGIS
point query the ACT adapter already uses, and Townsville's field names are
verified: `LVL1_ZONE` (`"Centre"`), `LVL2_ZONE` (`"Principal Centre"`),
`TCC_CODE` (`"PC"`), `LGA_CODE` (`7010`), with `GAZ_DATE` for currency.
Building `QLD_COUNCIL_SCHEME_LAYERS` — keyed by the cadastre's own `lga`, so
the council that answers the parcel query selects the scheme — is the next
step, and each council's field names must be verified by execution before it
is added, exactly as `planningSources.pure.ts` requires.

**One probing note worth keeping.** `services*.arcgis.com` answers `400 Bad
Request — invalid header name` to a pg_net request carrying a `User-Agent`
header, and `200` to the identical request without one. That is an artefact of
the probe tool, not of the endpoint: the edge functions use `fetch` and the ACT
adapter against `services1.arcgis.com` is verified working. Do not read a 400
from a pg_net probe as evidence that a council's layer is unreachable.

---

## 5. Infrastructure and the future outlook

Same shape, one section later. The enrichment already holds evidenced
development facts — Queensland's declared instruments at the property's own
coordinate, New South Wales' DA register for its council — and the outlook
sections used none of them.

What the prompt offered instead:

- a SWOT strength reading *"**Metro connectivity:** [Metro Line] opened
  [Year], fundamentally improving transport profile and CBD commute time to
  [XX] minutes. This infrastructure investment typically drives long-term
  capital growth"*;
- an opportunity reading *"**Infrastructure development:** Planned residential
  and commercial developments in [Suburb] region support continued population
  growth and property appreciation"*;
- a Location Overview paragraph opening *"A major infrastructure advancement
  occurred with the opening of [Station Name] in [Year]"*, with the line, the
  connecting station and the station's facilities all in brackets;
- and a formatting directive: *"Any infrastructure/project pipeline MUST use
  `{{timeline: …}}`"*, with a worked example carrying the horizons
  `Existing / 0-2y / 3-5y / 5y+`.

None of that is a question a model can answer from the record, so what came
back was a plausible pipeline: named projects, horizons, and a causal claim
about capital growth, with nothing behind any of it.

`_shared/planning/infrastructureEvidence.pure.ts` composes what the registers
actually said, and six rules hold it:

1. **A project is named only where a register named it.** No inferred
   pipeline, no horizon a publisher did not state.
2. **A status is the publisher's own word.** The reader's vocabulary —
   proposed, approved, funded, under construction, completed, delayed,
   cancelled — is added in parentheses only where the word maps unambiguously.
   Approval is never read as funding and funding is never read as a start on
   site; those are the three a reader most wants collapsed and the three it
   would be most expensive to collapse wrongly.
3. **A completion date is never invented.** A gazettal or a determination is a
   date something HAPPENED and is labelled as that.
4. **An announcement is never a capital-growth claim.** Nothing composed here
   quantifies an uplift, and the rules handed to the model forbid it in the
   prose beside it.
5. **Coverage is stated every time**, on a full list as well as an empty one:
   council capital works, state and federal budget programmes, agency
   announcements and anything outside the local government area asked about
   are named as what these registers do not reach.
6. **Development nearby cuts both ways.** Dwellings in the pipeline are
   competing supply as well as a sign of confidence, and the reading says so.

On 262 Pallas Street the honest answer is a short one: the StatePlanning
layers returned an evidenced `none_at_point` and Queensland publishes no
state-wide DA feed, so the section states both absences, states the coverage
limitation, and forbids the prose beside it from naming a project, drawing a
timeline or claiming that infrastructure underwrites growth.

**The gap this leaves, named.** A council capital-works programme, a state
budget infrastructure line and an agency project announcement are all real
sources and none is integrated. The section says so on the page rather than
letting a short list read as a quiet area, and wiring any of them is a
separate piece of work with its own reachability and licensing measurement —
the same standard `ZONING_BY_JURISDICTION.md` holds every other provider to.

---

## 6. What the first regeneration found: a rule can reach the model and its evidence not

262 Pallas Street was regenerated on 17 Sep 2026 (report
`4640d10a-c2ba-4a5d-8c59-b697f3885d0e`) through the production resume path, on
the deployed code. The placeholders were gone — no `450 m²`, no `[XX]%`, no
Local Environmental Plan on a Queensland property, and no raw `~~[…]~~` array.
The document still asserted, in its own voice:

- *"low‑density residential zoning"*, on a property whose zone
  `planning-data-service` had answered `not_served`;
- *"no identified bushfire, flood or heritage overlays"*, sourced to a listing
  portal's "flood risk — not detected";
- *"Planning overlays under active review by Fraser Coast Regional Council"*,
  naming TLPI 01/24 and Flood Hazard Resilient Precincts, marked **Verified**;
- and a four-item `{{timeline: …}}` — Bruce Highway upgrades, a TAFE
  manufacturing centre, a school amenities upgrade — on horizons no publisher
  stated, from an enrichment that had answered `none_at_point`.

**The enrichment was never the problem and neither were the rules.** The
function logged `Planning facts: { jurisdiction: "QLD", council: "Fraser Coast
Regional", zone: null, zoneStatus: "not_served" }` on all eleven sections. What
the same log also shows, on every one of them, is this:

```
✂️ Base prompt for Risk Dashboard trimmed: 92129 → 52844 bytes
✂️ Base prompt for Due Diligence Checklist trimmed: 92129 → 52831 bytes
✂️ Base prompt for Final Recommendation trimmed: 92129 → 52852 bytes
```

`limitPromptContext` keeps 62% head and 38% tail. The planning controls table
and the infrastructure register sat under two headings of their own about a
quarter of the way into that base prompt — in the band it drops — while the
rule that points at them (*"An infrastructure/project pipeline is drawn with
`{{timeline: …}}` — and ONLY from items in the Infrastructure & Development
Outlook table"*) lives in the section instructions, which are subtracted from
the budget first and are never trimmed.

So the model held a rule about a table that was not in front of it, under a
truncation notice that says in as many words *"Prioritise extracted
specifications and request fresh web research for missing details"*, with live
search available. It did exactly that.

Three things changed.

1. **Pinned context.** `generateReportSection` takes a `pinnedContext`
   argument. Its bytes come off the budget *before* the base prompt is measured
   and it is concatenated *after* the trim, so it reaches every section whole —
   and it is carried into the emergency compact prompt too, which is the one
   that runs when the full prompt was refused and therefore exactly where a
   correctness rule must not go missing. The planning table, the planning
   rules, the infrastructure table and the infrastructure rules are its first
   members, ~5.6 KB in total, and they are gone from the middle of
   `propertyPrompt`. **What a client document may state about planning is not
   allowed to depend on a byte boundary.**
2. **The rules are the report's, not a section's.** They read `RULES FOR THIS
   SECTION` while the Compass section list has no planning section at all —
   Executive Verdict, Property & Locality Snapshot, Why This Location Matters,
   Demographics & Demand Drivers, Amenity & Access, Market Positioning,
   Property Fit, Risk Dashboard, Due Diligence Checklist, Final Recommendation.
   They now say `FOR THE WHOLE REPORT` and name risk registers, checklists and
   verdicts, because that is where the contradictions landed.
3. **A web search is not a retrieval, and the rules say so.** This model
   searches. Silence about that is what let a portal's "not detected" become
   this report's finding about the land. Both rule sets now state that a
   listing site, a news page, a budget page or an agency media release is not
   an entry in the table, and rule 4 extends to risk-register rows and
   checklists rather than prose alone.

And the tables themselves are now **in the document**, appended verbatim after
the post-processor under *"Planning controls and development registers"*, on
property reports only. Asking a model to reproduce a table is how a table comes
back paraphrased; this is the same composed markdown the prompt carries, and no
word cap can trim a row of evidence out of it. The one consequence worth
knowing is that it lands after `runQAValidation`, so the page estimate QA files
is the prose's rather than the document's — the deliberate order, because the
alternative is letting a word cap cut evidence.

**Still not closed by this.** The narrative's market claims (a "0.6% vacancy
rate", "double-digit annual growth") come from the same live search and are
governed by a different control — `auditMarketClaims` — which is outside this
document's scope. And the risk register's own **Verified / Unverified** column
is written by the model: nothing yet derives it from whether the platform
retrieved the underlying fact, so a desktop reading can still be labelled
`Verified` by the writer. That is named here rather than left to be discovered,
and it is the next piece of work in this area.

---

## 7. What the rendered pages showed

The regenerated report (`4640d10a`) was drawn through the Investment Compass
*Chancery* master with the pinned WeasyPrint 69.0 and every one of its 29 pages
was looked at. Three things the record now gets right, and four the pages
found.

**Right.** Page 5's cash-flow table foots on the page — rental income $26,000,
loan repayments $34,890, **council and water rates $5,000** (3,400 + 1,600, in
the row that names both), insurance $2,800, **management $2,580** (2,080 + 500
letting fees), maintenance $2,500, net position **−$21,770**, which is the
figure the rest of the document quotes. The audit's $2,100 gap is closed. Page
3 prints `Council — Fraser Coast Regional` where the 16 Sep report had null.
Page 6 states the assumptions the audit asked about in the open: capital growth
9.70%, **vacancy allowance 0.00%, occupancy 52 weeks a year** — the zero-vacancy
assumption is now disclosed rather than buried. And page 4 draws three scored
dimensions (Growth 77, Yield 53, Demand 35) with Location and Risk simply
absent rather than printed as zeros.

**Found.**

1. **A dial the record cannot back, drawn large.** Page 9 is a gauge reading
   **85 · /100 · STRONG** under the title *Land Appeal*; page 18 is a second
   one, **82 · STRONG**, titled *Large-block lifestyle appeal*; page 20 is a
   five-value risk `{{wheel}}` (25, 45, 30, 40, 35). Eight numbers, none in
   `investment_score`, on a record that issues no grade. The prompt asked for
   them in as many words — *"Investment Score, Affordability, Risk,
   Suitability, Confidence, and similar 0-100 ratings MUST use `{{gauge}}`"* —
   so the line is narrowed at the source and `suppressUnrecordedVerdictVisuals`
   is the check that it was obeyed. It is deliberately narrow: `gauge` and
   `wheel` are rating primitives, while `bars`, `tiles`, `heatmap`, `donut` and
   `pictograph` carry measured series and dropping those on a number match
   would take real data off the page.
2. **A prompt directive printed as the property's attribute.** Page 9, in the
   report's own prose: *"The property type is recorded as "Not stated in the
   record — if the property documents name the dwelling type, use that exact
   type in every section, never write 'Residential Property'"".* That string
   WAS `propertyTypeLabel` when nothing resolved, and it was interpolated into
   `| Property Type | … |` cells and a `- Property Type: …` line. **An
   instruction must never occupy a value slot**: the slot now carries the fact
   or nothing, and the instruction lives in the rules.
3. **And the type was known all along.** `rawPropertyType` read
   `propertyDetails?.propertyType` alone. Every Compass report is finished by
   the resume worker, which calls back with `{reportId, propertyAddress,
   continueFrom}` and no `propertyDetails` — so on the run that writes the
   document it was always `''`. The operator had recorded `propertyType:
   'house'`; `property_specs.property_type` stored it and page 3 printed it,
   while the model was told it was not stated and wrote a paragraph about the
   record not stating it. It reads `sourcePropertyType` now, which is the one
   answer the module already resolves (request first, then the overrides).
   The same read also stopped the rent-comparison row printing `X-Bed`.

**Named, not fixed.** Four residuals, with where they show:

- **Labels are clipped in three primitives.** A tile title on page 19
  (`OUTER MARYBOROUGH POCKETS…`), the timeline's only labelled stop on page 13
  (`Manufacturing Centre of Excellence – Maryborough…`), and a gauge caption on
  page 18. `fitLines` wraps a label into the units a drawing may use; these
  three call sites truncate instead.
- **The timeline draws empty horizons.** Page 13 has stops at `3-5Y` and `5Y+`
  with nothing at them, which reads as a pipeline at those horizons. A horizon
  no item reaches should not be drawn.
- **`Evidence Chip: Verified` is written by the model, and the rule it breaks
  is already written down.** `compass.riskDashboard`'s own `purpose` says
  *"'Verified' only where a dated, parcel-level source is cited; 'Unverified'
  while the required check is still to be done"* — and pages 21–23 stamp
  `Verified` on overlay readings whose cited source is a listing portal's
  "flood risk — not detected". The instruction exists; what does not is
  anything that checks it, because "a dated, parcel-level source" is a
  judgement handed to the writer. The chip is a candidate for the same
  treatment the gauges got: derive it from what the platform retrieved rather
  than from what the prose cites.
- **Two sections are drawn twice** (Due Diligence Checklist on pages 24–25 and
  25–26, Final Recommendation on pages 25 and 26), and one checklist item is
  cut mid-sentence — *"8. Ask a local property manager"* — on page 26. The
  registry is **not** the cause: `compass.riskDashboard` (ordinal 9),
  `compass.dueDiligenceChecklist` (10) and `compass.finalRecommendation` (11)
  are three distinct entries with no shared `sourceHeadings`. The model wrote
  the latter two inside the Risk Dashboard's own chunk and again as their own
  sections. A heading belonging to a LATER registry entry appearing inside an
  earlier chunk is detectable — `partitionByRegistry` already knows the
  ordinals — but handing it forward rather than dropping it is the part that
  needs care, so it is named here rather than half-done.

---

## 8. The registers were answering the whole time (17 Sep 2026)

Until this section, §3 of this document was true of the code and false of the
world. `planningFacts.pure.ts` carried one honest sentence for overlays:

> Overlay mapping (heritage, flood, bushfire, character, acoustic) is held in
> the council scheme and is not retrieved by this platform. Nothing here
> states that the property carries no overlay — only that none was looked up.

The premise underneath it — *"No integrated layer publishes overlays at a
point yet"* — had never been measured. It is wrong for four of the eight
jurisdictions, including the two that carry most of the corpus.

### 8.1 What was measured

Probed from the **production egress** on 17 Sep 2026 (pg_net request ids
263970–263976, 263992–263998, 264009–264016; the local sandbox's proxy refuses
these hosts, which is why the measurement had to be taken from the deployment).
Every one answered **HTTP 200** with a parseable body, under an open licence,
with no key:

| Jurisdiction | Service | What it answers at a point |
|---|---|---|
| NSW | `ePlanning/Planning_Portal_Principal_Planning` | The LEP and its amendment, the zone, **maximum building height in metres**, **floor space ratio**, **minimum lot size**, **heritage** (item number, type, significance), land reservation acquisition, foreshore building line, minimum dwelling density — each with the **legislative clause** that creates it and its **own currency date** |
| NSW | `ePlanning/Planning_Portal_Hazard` | Bushfire Prone Land, Flood Planning Map, Landslide Risk Land |
| NSW | `ePlanning/Planning_Portal_Protection` | Acid sulfate soils, airport noise, drinking-water catchment, groundwater vulnerability, riparian land, salinity, terrestrial biodiversity, wetlands, scenic protection, environmentally sensitive land |
| VIC | Vicmap `plan_overlay` (WFS) | Every overlay at the point, with its schedule and gazettal date |
| QLD | `PlanningCadastre/StatePlanning` | Regional plan (name, **legal status**, version), priority living areas, PDAs, SDAs, coordinated projects, infrastructure designations |
| QLD | `FloodCheck/RapidHazardAssessment` | Flood hazard |
| QLD | `Environment/MattersOfStateEnvironmentalSignificance` | 26 layers: regulated vegetation, wildlife habitat, wetlands, watercourses, koala habitat |
| TAS | `Public/PlanningOnline` layers 14, 15 | The Code Overlay and the General Overlay, with the Local Provisions Schedule that carries them |

Two real answers, verbatim:

**Muswellbrook, NSW** — one `identify` call returned six controls:
`Muswellbrook Local Environmental Plan 2009` (Amendment No 7), R1 General
Residential, **8.5 m** maximum height under **cl. 4.3** current 18 Nov 2022,
**0.5:1** floor space ratio under **cl. 4.4**, **600 m²** minimum lot size
under **cl. 4.1** current 2 Jul 2021, and a **Residential Heritage
Conservation Area (item C2, local significance)** under **cl. 5.10** current
1 Mar 2024.

**262 Pallas Street, Maryborough QLD** — `Maryborough Priority Living Area`,
inside the `Wide Bay Burnett Regional Plan`, **Legal status: Statutory,
Version: December 2023**.

Every one of those is a fact this report had nothing to say about.

### 8.2 The four rules

**A constraint is named only where a layer named it.** Nothing infers a
control from a zone code, a suburb or a neighbouring parcel.

**A layer that was never asked is evidence of nothing.** `askedFamilies`
travels with the answer, an unreachable register contributes no coverage at
all, and "checked and not mapped at this coordinate" is a different sentence
from "nobody looked". Measured: `layers=all` on the NSW Hazard service answers
`{"results":[]}` at any point, because ArcGIS reads `all` as *all VISIBLE* and
that service's group carries `defaultVisibility: false`. An empty answer to a
question nobody asked is the worst shape this codebase knows — it reads as a
property with no bushfire and no flood — so the explicit layer ids in
`NSW_HAZARD_LAYERS` are required rather than a refinement.

**A value carries its unit, its instrument and its clause.** `8.5` is not a
fact. `8.5 m maximum building height, Muswellbrook LEP 2009 cl. 4.3, current
18 Nov 2022` is one, and it is the difference between a number a client can
take to a town planner and a number they cannot. Each layer publishes its own
currency and the report keeps them apart, because the maps amend separately.

**A retrieval is not information.** `planningControlGuide.pure.ts` explains
what each control IS, what it obliges, and what to obtain — about the
CONTROL, never about the property, which is what lets it be written in advance
and still be true. `planningConstraints.spec.ts` rejects any currency amount,
percentage, measurement or BAL rating in it, and any sentence that could read
as a clearance.

### 8.3 Why the legacy report is the wrong model for this section

The owner's 17 Sep review asked for the legacy long-form report as a benchmark
of substance. Its zoning section is fluent, specific and structured — a
controls table with an Implications column, future rezoning potential,
overlays and risks, investment implications, and a genuinely useful paragraph
telling the reader to obtain a Section 32.

It is also fabricated, and one file proves it. `df813535` carries **three
copies of its own zoning section**, on **one lot**, in **one document**, and
they disagree on every material control:

| | Copy 1 | Copy 2 | Copy 3 |
|---|---|---|---|
| Flood overlay | Moderate, 1% AEP near Werribee River | **Minimal — outside the 1-in-100 floodplain** | Moderate, affects 5% of the lot |
| Bushfire overlay | **High**, BAL-19 required | **Low risk** | BAL-12.5 to BAL-29 |
| Contributions | $45,000+ per lot | $15,000–$20,000 | $52,000 per lot |
| Height limit | 9 m | 9 m | 9.5 m |
| PSP approved | 2018 | 2018 | 2022 |
| Dwellings | 6,500 by 2036 | 13,000 by 2036 | 2,500 by 2031 |
| Subdivision | **High upside** | **No subdivision potential** | Two 200 m² lots, +$250,000 |

Copy 2 cites **Wyong Shire Council** flood mapping — a New South Wales
council, 900 km away — for a Victorian property. It is the same class as the
`450 m²` and the NSW instrument names on a Queensland property that §1 of this
document records.

So the legacy report is the benchmark for **structure, depth, educational
scaffolding and register**, and the opposite of the benchmark for
**provenance**. What it did well needed no retrieval at all: the paragraph
naming the document to obtain. `VERIFICATION_DOCUMENT` now carries that for
all eight jurisdictions, named precisely — asking a Queensland council for a
"Section 32" gets nowhere, and asking a Victorian vendor for a "planning and
development certificate" gets nowhere either.

### 8.4 Also fixed here

`Parcel area: 0 m² (surveyed)` printed on 262 Pallas Street — a surveyed
measurement of nothing — because the guard was `facts.parcelAreaSqm !== null`
and `num()` admits zero as a finite number. A parcel area of zero is the layer
declining to publish one.


### 8.5 What rendering the real section caught

The section above was written, tested against captured fixtures, and wrong — and
the way it was found is the point. Rendering the actual Planning section for
262 Pallas Street from LIVE production responses (pg_net 263994, 264598, 264599)
produced this row:

> | Strategic context | Lower Mary River | Queensland FloodCheck rapid hazard assessment | — |

Queensland's FloodCheck Rapid Hazard Assessment answers at that coordinate with
the value `Lower Mary River` — the sub-basin's own name. `familyFromLabel`
scans the label for a keyword, finds no flood word in "Lower Mary River", and
files it as `other` / `context`.

**A flood hazard reading, on a Mary River property, presented as strategic
context.** Four statements went wrong from that one classification:

1. it was drawn as context rather than as a hazard;
2. it lost the hazard-first ordering a reader triages by;
3. it appeared in the **Infrastructure & Development Outlook**, which is for
   what is planned nearby;
4. the coverage line read *"Checked and not mapped at this coordinate: … flood
   …"* — a clearance, on a property inside the mapping.

The rule: **a single-purpose register states its own family.** A register that
answers ONE question knows the answer's kind better than a keyword scan of what
the feature happens to be called, so the caller declares it and
`familyFromLabel` is used only where a register genuinely publishes many kinds
under descriptive names (Queensland's 26 MSES layers, Tasmania's codes). On a
single-purpose register the LAYER is also the finding and the feature is the
place, so the label reads *"Rapid Hazard Assessment — Lower Mary River"* rather
than a river's name on its own.

With that fixed, the section leads with:

> | Hazard | Rapid Hazard Assessment — Lower Mary River | Queensland FloodCheck rapid hazard assessment |
>
> **Flood.** Flood mapping or a flood planning control, made from modelled
> flood behaviour rather than from whether the property has flooded before. It
> typically sets a minimum floor level, restricts what can be built at ground
> level, and can require flood-compatible materials. It materially affects
> insurance: some insurers decline, and premiums can differ by a multiple.
>
> *Before you proceed:* Ask the council for the flood level and the flood
> planning level for this lot — a designation without a level tells you nothing
> about depth. Obtain an insurance quote in writing before exchange.

None of which the report said before this work, on any property, anywhere.

### 8.6 Two more the same render caught, read as a document

The flood fix was found by reading the rendered section rather than the code.
Reading it again afterwards found two more, and both are the same mistake in
different places: **a value taken from a field that means something else.**

**A region printed as a project's status.** The Infrastructure Outlook drew

> | Maryborough Priority Living Area | Growth / priority area | Wide Bay Burnett | No date stated | Priority Living Area | — |

against the headers `Project or instrument · Type · Status · Date recorded ·
Where · Stated cost`. So the **Status** cell said `Wide Bay Burnett` — a
region — and the **Where** cell said `Priority Living Area`, which is the name
of a spatial layer and not a place; on the regional-plan row the same cell
simply repeated the project's own name.

The cause is that `detail` on a constraint reading is a JOIN of everything the
layer published — legal status, version, region, hazard class. That is correct
for the planning register's *"What the register returned"* column, which is
explicitly a summary of what came back, and it is not a status. A reading now
carries `standingLabel` (the publisher's own word for the instrument's
standing, `Statutory instrument · version December 2023`) and `region`
separately, `detail` is composed from them so the register table is unchanged
byte for byte, and the Outlook reads the two fields that mean what its columns
mean. Where the register stated no standing the cell is empty and the renderer
prints the em dash — a designation with no published standing is a real state,
and filling that cell from the nearest available string is how the defect
started.

**A count that contradicted the table under it.** The Overlays row read

> 1 mapped control applies at this point

directly above a three-row table. Excluding the strategic designations from the
count is right — a regional plan does not control what is built on one lot, and
counting it as a mapped control would say it does — but a reader resolves a
contradiction like that by distrusting one of the two, and cannot tell which.
The cell names them instead: *"1 mapped control applies at this point, plus 2
strategic designations"*, and the none-at-point wording gains the same tail
(*"returned no mapped control, plus 1 strategic designation, listed below"*),
because that is the form in which the contradiction is sharpest — nothing
controls the lot, and the table still has rows in it.

**The method, not just the findings.** All three came from rendering the
section from verbatim production responses and reading it as a client would,
which no unit test does. And the empty-string fallthrough in the Victorian
overlay classifier (`(scheme && MAP[scheme]) ?? …`, where `??` does not catch
the `''` that `&&` carries through) came from `deno check` over the pure
planning modules: `tsc` covers `src` only, so these modules are type-checked
by nothing in a local run and by the ratcheted edge gate in CI.
