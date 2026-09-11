# Scoring V2 — the methodology, in one place

**Methodology version `2.1.0-shadow` · shadow-only · not wired into any report,
stored row or client surface.** A spec test
(`src/lib/reports/__tests__/scoringMethodology.spec.ts`) pins every
load-bearing number in this document to the modules that enforce it, and
asserts no production entrypoint imports the engine — so this document cannot
quietly disagree with the code, and the code cannot quietly reach a client.

The governing doctrine, unchanged: **a figure the system record can produce is
never asked of a model**, absent is absent (never 0, never 50, never neutral),
and configuration is not reachability. This scoring engine is deterministic
end to end: same inputs, same output, no HTTP, no model, no clock beyond an
injected `now`.

Status honestly stated: the methodology below is **complete on synthetic
proof and unvalidated against real market evidence**. The genuine historical
backtest (ME-7) waits on real QLD + WA Growth evidence; every threshold here
is subject to evidence-based calibration under the calibration rules (defects
only, never grade-distribution targets), and any change bumps a version.

---

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
composition at `2.1.0-shadow`. Status: **provisional / uncalibrated** — its
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
  benchmark-only, refused as subject growth by name.
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

Every module carries its own version; the composition version
(`2.1.0-shadow`) bumps whenever composition, weights or component versions
change, and is persisted with every score so a stored result can be reproduced
exactly. No silent changes: a calibration requires the demonstrated defect,
the correction, and the re-run, on the record. The engine stays unwired from
production until ME-7 passes and activation (ME-8) is explicitly approved —
asserted by the guard in the pin spec, not promised.
