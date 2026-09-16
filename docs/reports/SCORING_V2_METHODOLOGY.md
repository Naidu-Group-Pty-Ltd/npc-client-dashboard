# Scoring V2 — the methodology, in one place

**Methodology version `2.1.0` · the production grade engine since `2026-09-15`
(activation ME-8, recorded in `scoringV2Production.pure.ts`).** A spec test
(`src/lib/reports/__tests__/scoringMethodology.spec.ts`) pins every
load-bearing number in this document to the modules that enforce it, and
asserts the engine is reached by exactly one production entrypoint
(`investment-scoring-service`) through the activation module and nothing else
— so this document cannot quietly disagree with the code, and no second
caller can quietly reach the engine.

The governing doctrine, unchanged: **a figure the system record can produce is
never asked of a model**, absent is absent (never 0, never 50, never neutral),
and configuration is not reachability. This scoring engine is deterministic
end to end: same inputs, same output, no HTTP, no model, no clock beyond an
injected `now`.

Status honestly stated: the methodology below is **complete on synthetic
proof and unvalidated against real market evidence**. The genuine historical
backtest (ME-7) still waits on real QLD + WA Growth evidence; every threshold
here is subject to evidence-based calibration under the calibration rules
(defects only, never grade-distribution targets), and any change bumps a
version. Activation did not close ME-7 — it made the first real evidence the
engine scores a production reading rather than a shadow one, which is why the
activation condition below is conservative.

**SCORING V2 CORE FROZEN (2026-09-11, audit §68).** The structure this
document describes survived its closure review and is settled; edits require
a demonstrated defect and a version bump. The `-shadow` suffix came off the
version at activation; the composition did not change.

## Activation — ME-8, 15 September 2026

On 15 September 2026 the platform owner instructed that the grading system be
rectified: since 11 September every new report had read *"Grade withheld — no
scoring system is currently authorised to issue an overall grade"*, because
`PRODUCTION_SCORING_AUTHORITY` is `unavailable` (V1 is not trusted to grade)
and this engine was frozen but never wired. The activation is
`SCORING_V2_ACTIVATION` in
`supabase/functions/_shared/reports/market/scoringV2Production.pure.ts` —
a constant, not configuration, because activating an engine is a decision
with a review behind it and an environment variable is not that decision.

What it does: `investment-scoring-service` answers every property scoring
request by running this engine through `scoreForProduction`, which projects
the canonical output (§8) onto the record every reader already understands —
`totalScore`, `grade`, `breakdown`, `coverage`, the SWOT lists — under a stamp
whose `authority` is `v2` and whose `scoringSystem` is `scoring-v2`. The
legacy V1 path stays in the service as the recorded methodology of the stored
corpus and for area scoring; it is never reached for a property while the
activation is approved, and it still cannot spell `v2`
(`LegacyScoringAuthority`).

What it does not change: no weight, anchor, ceiling or rule in this document;
nothing about the forward-only input policy (Location's three inputs stay
`requires_repair` and are refused until a caller declares them verified, so
Location is null today and disclosed); and no stored row — a score issued
under V1 keeps its stamp, a withholding keeps its stamp, and the next run of a
report is the first to carry `v2`.

**Growth is required.** The engine's own floor is three measured dimensions,
and on the evidence this deployment holds today three can be reached without
Growth (Yield from the record's own rent and price, Demand from Domain's
market readings and the ABS population series, Location once repaired). A
grade formed that way answers to the delivered-points ceiling (§3): with
Growth's 40 points unmeasured the best deliverable is 60 of 100, so the
printed letter would be a B at most and typically a C — a statement about
missing data wearing the shape of a statement about the property, which a
client cannot tell from a poor property. `requiredDimensions: ['growth']`
therefore withholds the grade until suburb capital growth has been measured,
and names the gap. The owner may relax it by editing the activation record.

**Absence is named.** A withheld grade carries `gradeGaps` — one entry per
unmeasured dimension with the client sentence (`NOT_ASSESSED_REASON`), the
operator detail (which provider refused and what it said, which input is
unrepaired, or that the geography never resolved to a trusted suburb and
postcode) and the remedy. The Generated Reports card and the report page
render the same list.

**Where the evidence comes from.** Domain's v2 suburb-performance series
(`domain-data-service`, `domainEvidence.pure.ts`: the growth horizons are
computed from twelve annual medians, never read from a growth field; days on
market, sales, listings, rent and clearance from the latest period) and the
ABS estimated resident population series for the property's SA2
(`populationGrowthEvidence.pure.ts`, a demand driver). Both are asked for the
subject the boundary service resolved from the verified coordinate — never
the typed suburb or the parsed postcode — so an unresolved geography seeks no
evidence and says so. Domain's licensing for client documents is `unverified`
(`DOMAIN_SUBURB_PERFORMANCE_LICENSING`) until the rights follow-up in
`docs/integrations/DOMAIN_ACTIVATION_REQUEST.md` is answered: the engine
scores on the points and the client-facing evidence statement withholds their
provenance, exactly as §7 has always said.

---

### Growth providers, 15 September 2026 (evening)

Domain's suburb-performance series answers 403 on this key (the project has
no API package attached), so the growth evidence the activation requires
comes from the open-data sales registers loaded by `market-sales-ingest`
and adapted by `openDataSalesEvidence.pure.ts`: the Queensland Government
Statistician's dwelling-sales series by local government area (quarterly
since June 2008) and the NSW DCJ Rent and Sales Report by postcode and LGA
(one workbook a quarter since 2017), both CC BY 4.0, both measured
reachable from the production egress. Every point carries the publisher's
grain (`lga` or `postcode`), which the Growth confidence's geography factor
prices at 55 and 80 against 100 for a suburb, `licensingStatus: 'open'`
and `acquisition: 'open_public'`. Domain remains a provider: when its
package is attached, `mergeEvidence` prefers its suburb-grain points per
measure and the register becomes the second, corroborating source
(`sourceIndependence` 55 → 85). Western Australia has no open series and
withholds; Victoria's is walled to scripted clients. The measurements,
licences and what remains are in `OPEN_DATA_GROWTH_EVIDENCE.md`.

## 1. The composite

One composition function: `scoreInvestmentV2Shadow`
(`supabase/functions/_shared/reports/market/shadowScorer.pure.ts`).

| dimension | nominal weight | scorer | version |
| --- | ---: | --- | --- |
| Growth | **0.40** | `growthScoring.pure.ts` | `3.1.0` |
| Location | **0.25** | `locationScoring.pure.ts` | `1.0.0` |
| Yield | **0.15** | `yieldScoring.pure.ts` | `3.0.0` |
| Demand | **0.15** | `demandScoring.pure.ts` | `3.0.0` |
| Risk | **0.05** | `riskModelD.pure.ts` (Model D, variant D2) | `1.0.0` |

Weights are the live composite's, unchanged on purpose: this release fixes
what each dimension *measures*, and re-weighting at the same time would make a
backtest unable to attribute any change to either.

**Composition rules, each pinned by test:**

- A dimension that could not be measured is **absent, never zero** — it leaves
  the composite entirely; the remaining weights renormalise, and the
  renormalisation is published (`effectiveWeight` per dimension,
  `evidenceCoverage` overall).
- Fewer than **3** measured dimensions → no composite, no grade, a stated
  reason (`MIN_DIMENSIONS_FOR_GRADE`).
- `nominalMeasuredScore` — Σ (measured score × nominal weight), the points the
  evidence actually **delivered** over the full 100 — is computed and
  published beside the renormalised composite. The printed grade answers to it
  (§3), so a missing dimension can disclose and cap but never lift.
- The buyer never scores into the property (§5).

## 2. Grades

`gradeEligibility.pure.ts`, version `2.0.0`.

| grade | floor |
| --- | ---: |
| A+ | **85** |
| A | **75** |
| B+ | 65 |
| B | 55 |
| C+ | 50 |
| C | 40 |
| D | 30 |
| F | 0 |

These thresholds are not this programme's to move, and no calibration may
target a grade distribution.

## 3. A/A+ evidence eligibility — the two ceilings

A grade is a claim; the score says how strong, eligibility says whether the
evidence can carry it. Eligibility **never changes the score** — it caps the
printed grade and states why. Deliberately not "N of 5 dimensions": a missing
vacancy rate and a missing five-year growth series are nothing alike.

**Ceiling one — Growth-centred** (`ELIGIBILITY_RULES`):

| rule | A | A+ |
| --- | ---: | ---: |
| minimum Growth confidence | **45** | **70** |
| minimum Growth coverage | **0.45** | **0.70** |
| minimum overall evidence coverage | **0.55** | **0.70** |

Growth confidence is itself six measured factors (§4.1): geography precision,
dwelling-type match, sample size, history depth, source independence,
freshness — the checklist a client-facing A/A+ must survive.

**Ceiling two — delivered points** (2.0.0): the printed grade may not exceed
`gradeFor(nominalMeasuredScore)`. Rationale, found by fixture before any real
evidence was scored: the renormalised composite *rises* when a weak dimension
drops out (growth 90 / location 80 / yield 85 / demand 55 composites ≈ 81
with Demand and ≈ 86 without it), so absence could buy a badge. Under this
ceiling missing evidence still never scores — composite, coverage and
disclosure are untouched — but it cannot lift: a dimension that was not
measured contributes nothing toward a higher grade's floor, and adding a
measured score (≥ 0) can only raise the ceiling. Measured consequence today,
with Risk structurally unmeasurable (§4.5): the maximum deliverable is ≈ 89 of
100 (growth saturates at 91, location reaches 95, yield 100, demand 93), so
**A+ remains mathematically reachable — on genuinely exceptional evidence
across all four live dimensions**, which is what the badge is supposed to
mean.

Whenever the printed grade is capped, at least one reason is stated, in the
operator's words.

## 4. The dimensions

Ownership is exclusive and enforced: every input has exactly one owner
(`dimensionOwnership.pure.ts`), a forbidden list, and one declared exception —
`growth1Year`, which Growth rewards and Risk prices the reversal of, moving
the composite in **opposite** directions (measured ≈ 4:1 in Growth's favour).

### 4.1 Growth (0.40) — capital movement, and only capital movement

- **Permitted**: subject CAGRs over 1/3/5/10 years, the price series (path
  consistency), suburb-vs-benchmark relative movement.
- **Prohibited**: population growth (a demand driver), any demand or yield
  measure, `state`.
- **Missing**: no growth evidence → dimension null; partial horizons → scored
  on what exists with `weightCovered` published.
- **Confidence** (separate from performance, weights in
  `growthScoring.pure.ts`): geography, dwellingType, sample, history,
  sourceIndependence, freshness. Another horizon from one provider raises
  *history*, never *source independence*.
- **Benchmark rule**: ABS regional/state series are benchmark context and are
  refused as subject growth by name (`me7EntryGate.pure.ts`); a benchmark
  swing moves the score by a bounded, published amount and cannot promote a
  whole region.

### 4.2 Location (0.25) — where it is, not how its market performed

- **Permitted**: walkability, commute to the **nearest employment centre**
  (polycentric centre selection, audit §58 — a regional hub commutes to its
  own centre, not to a capital CBD), schools.
- **Prohibited**: `state` (owned by nobody — the 15-point state premium is
  removed and pinned), any market-performance measure.
- **Missing**: no location inputs → null, never a default; the old scorer's
  32-points-for-three-absent-inputs is the recorded defect.

### 4.3 Yield (0.15) — the rental return, measured once

- **Permitted**: weekly rent against a **declared basis** (purchase price or
  current value — never defaulted), outgoings for the net figure, market rent.
- **Prohibited**: holding cash flow (disclosed via `holdingCashFlowSignal`,
  never scored — the V1 double-count of negative gearing is the recorded
  defect: 78% of reports scored exactly 10).
- **Missing**: absent rent is absent — null, never the bottom band.

### 4.4 Demand (0.15) — whether the market wants it

- **Permitted**: vacancy, days on market, vendor discount, auction clearance,
  sales count, listing activity, population growth (a demand *driver*).
- **Prohibited to others**: Risk may not re-read vacancy or days on market
  (the V1 double-count); Growth may not read population growth.
- **Missing**: partial measures score with published coverage; none → null.

### 4.5 Risk (0.05) — Model D: what could go wrong that nothing else counted

`riskModelD.pure.ts` (variant `D2_requires_a_peer`), adopted into the
composition at `2.1.0`. Status: **provisional / uncalibrated** — its
own module says so, because no property-risk evidence yet exists to calibrate
against.

- **The property type selects the schema and contributes zero points.** An
  asset-type score was a type bonus wearing a risk label; the placeholder
  `"Residential Property"` resolves to no schema and is reported as a gap in
  the record, not a finding about the property.
- **Buyer LVR and buyer cash flow contribute zero points anywhere** (§5).
- **Permitted**: answered property-risk questions from the per-class schema
  (site hazard, planning, condition, strata, local supply concentration,
  delivery), grouped into independent categories; twelve-month growth as
  overheating, under the declared exception, as a **bounded deduction** (max
  25) that may score only beside a measured property-risk peer.
- **One observation is never the dimension**: fewer than
  `MINIMUM_INDEPENDENT_CATEGORIES = 2` independent categories → Risk is null
  with the observation still reported as evidence. Today no property-risk
  question is answerable from the record, so **Risk is structurally null
  platform-wide** — disclosed on every result, and the door opens by itself
  the moment hazard or strata evidence lands.

## 5. Finance Suitability — beside the score, structurally outside it

`financeSuitability.pure.ts`, version `1.0.0`. The buyer's stated position
(LVR, weekly cash flow) is a reading about **this purchase scenario, not the
property**: 1 Boxer Drive, Wyndham Vale carries two same-day reports at the
same price, one at 80% LVR and one at 90% — under the old model that was 12.8
points of Risk for a number an operator typed. The reading returns no field a
composite can read, takes the worst band rather than an average, and absent
financing means no reading, not a neutral one.

## 6. Missing-data contract

For every dimension, *performance unavailable* is distinguishable from
*performance genuinely poor*:

- unavailable → `score: null`, listed in `unavailable`, `effectiveWeight 0`, a
  printable reason;
- poor → a low number with its evidence.

Missing evidence is never 0, never 50, never neutral, never inferred; it is
never punished as poor performance (the score renormalises over what was
measured) and never rewarded through renormalisation (the delivered-points
ceiling, §3). Coverage is separately visible from performance at every level.

## 7. Evidence sources and provenance

- Subject Growth precedence: Domain (existing licence at $0) → PropTrack
  trial (shadow-only) → open state suburb series → **unavailable**. ABS is
  benchmark-only, refused as subject growth by name. In production the first
  tier is what `domain-data-service` fetches on the v2 route with the trusted
  postcode; the ABS resident-population series enters Demand as the
  population driver and never Growth.
- Every evidence point carries provider, geography level, as-of date, sample,
  method, **acquisition footing** and licensing status; an undeclared footing
  is `licensing_unverified` and is not production evidence. Trial evidence may
  be shadow-scored and can never reach a client report.
- The canonical output (§8) carries a provenance row per observation.

## 8. The canonical output

`scoreOutputContract.pure.ts`, contract version `1.0.0` — one object every
consumer reads and none recalculates: methodology + component versions, score,
both grades and every cap reason, eligibility ceiling, evidence coverage,
per-dimension `{performance, confidence, nominalWeight, effectiveWeight,
contributionPoints, coverage, reason}`, provenance, unavailable dimensions,
the evidence statement, Finance Suitability and the holding-cash-flow signal.
Contributions reconcile to the composite within rounding, by test.

`overallConfidence` is **deliberately null**: a blended overall confidence is
a methodology decision that belongs to calibration against real evidence, and
the field says where it will be defined instead of carrying a number nobody
has justified.

## 9. Change control

Every module carries its own version; the composition version (`2.1.0`)
bumps whenever composition, weights or component versions change, and is
persisted with every score so a stored result can be reproduced exactly. No
silent changes: a calibration requires the demonstrated defect, the
correction, and the re-run, on the record. The engine is reached by one
production entrypoint through the activation module and by nothing else —
asserted by the guard in the pin spec, not promised — and the activation
record itself (`SCORING_V2_ACTIVATION`) is the one place the conditions under
which a grade is issued may be changed.

### Growth providers, 16 September 2026

Two more register sources and a floor. Victoria (suburb, annual and
quarterly) and South Australia (suburb, quarterly) load through the
Internet Archive's captures of their walled publishers; the ABS state
series (`abs_res_dwell`, the MEAN price of the dwelling stock, `state`
grain) is read only where nothing finer answered and is priced at the
bottom of the geography ladder. The state floor supplies growth and a
series and never a median, so `medianPrice` and `salesCount` stay absent
on a floor-only reading. `docs/reports/OPEN_DATA_GROWTH_EVIDENCE.md` §10.
