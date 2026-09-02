/**
 * Project a stored `investment_reports` row into the binding vocabulary the
 * seeded template catalogue actually uses.
 *
 * ## Why this exists
 *
 * The catalogue and the adapter disagreed about names, and nothing said so.
 * Measured against the 50 Investment Compass masters and 1,182 production
 * reports: **79 of their 80 bindings resolved to nothing**. The only survivor
 * was `property.zoning`, because that is the one key whose spelling happened to
 * match. Three independent causes:
 *
 *  - **Case.** Templates bind `property.yearBuilt`, `property.type`,
 *    `property.landArea`; `property_specs` stores `year_built`,
 *    `property_type`, `land_size_sqm`.
 *  - **Depth.** Templates bind `financials.grossYield` and
 *    `financials.weeklyRent`; the stored object nests those under
 *    `keyMetrics.grossRentalYield` and `income.weeklyRent`. The adapter's
 *    `flatten()` is `{ ...obj }` — a shallow spread that never flattened a path.
 *  - **Location.** Templates bind `property.address`; the adapter publishes it
 *    as `report.address`.
 *
 * This is why `docs/reports/COVERAGE.md` records **zero of 1,162 investment
 * reports** rendered by this system: the templates were never wrong-looking in
 * preview, because preview runs on `SAMPLE_REPORT_DATA`, which is written in
 * the catalogue's vocabulary rather than the database's.
 *
 * The projection is **additive**. Callers merge it over the raw namespaces, so
 * `property.year_built` and `financials.keyMetrics` keep working for anything
 * already bound to them.
 *
 * ## The rule this module is built on
 *
 * **Project what exists; leave absent what does not.** A key is emitted only
 * when its source is present, so an unmapped binding renders empty exactly as
 * it does today rather than printing a fabricated number. "A misread number in
 * a client's financial report is this programme's top risk" — inventing one is
 * strictly worse than leaving the line blank.
 *
 * Deliberately NOT projected, because no source exists in the row (verified
 * against production, not assumed — do not "helpfully" fill these in):
 *
 *  - `financials.breakEvenRent` — derivable in principle, but it is a NEW
 *    financial claim rather than a restatement of a stored one. It belongs in
 *    the calculator that owns the numbers, not in a display projection.
 *  - `financials.narrative`, `financials.fundingNote`, `summary.narrative`,
 *    `property.rationale` — prose with no dedicated column.
 *  - `market.*` — `location_intelligence` holds amenities, commute,
 *    coordinates, healthcare, lifestyle, schools, transport and walkScore. It
 *    carries no postcode, state, suburb count or market narrative.
 *  - `assumptions.rentalGrowth` — `assumptions` holds capitalGrowth, cpiGrowth
 *    and occupancyWeeks. CPI is not rental growth and must not stand in for it.
 *  - `assumptions.taxRate` — `cashFlow.taxRate` is null across the sample.
 *  - `assumptions.sellingCosts`, `financials.loanFees` — no source. (LMI is not
 *    a loan fee.)
 *  - `risks.N.why`, `risks.N.action`, `recommendation.rationale` —
 *    `investment_score.risks` is an array of plain **strings** and
 *    `investment_score.recommendation` is a single **string**. There is no
 *    second field to put in those columns.
 *  - `property.suburb`, `property.condition`, `property.tenancy` — no column.
 *    Suburb is parseable from the address string, and that is exactly the kind
 *    of guess that puts the wrong suburb on a client's report.
 *  - `author.*`, `client.*` — there is no `profiles` table for an adviser and
 *    no client-name column on this row (`client_property_id` is set on 2 of the
 *    1,182). The masters no longer bind either.
 *  - `property.images.*` — no adapter emits photographs; see
 *    `docs/template-library/07-investment-compass-families.md`.
 *
 * `org.*` was on that list until August 2026 and should not have been. The
 * sentence "organisation data lives outside this row" is true of the *row* and
 * was read for four months as though it meant no source existed. One does —
 * `whitelabel_settings`, the table the Branding page writes — and every adapter
 * now merges it. See `organisationProjection.pure.ts`.
 *
 * ## What the templates stopped binding
 *
 * The list above was, for most of its entries, a list of things the catalogue
 * bound anyway. Measured against a report taken verbatim from production, **49
 * of the masters' 80 paths resolved to nothing** — and an unresolved binding
 * renders as the empty string, so a page of them is a page of labels with
 * nothing beside them, not a page that looks broken.
 *
 * The masters were re-pointed rather than the projection widened, because the
 * entries above genuinely have no source and inventing one is the worse
 * outcome. Two got a real source instead:
 *
 *  - `assessment` — `investment_score.breakdown`, five weighted dimensions with
 *    a score and a `details` sentence each. It replaced a three-row risk
 *    register bound to `risks.0..2` when `risks` never holds more than one, and
 *    a narrative page whose four paragraphs all bound `market.*`.
 *  - `tenYear.equitySeries` — `financial_calculations.projections.moderate`, on
 *    162 reports. The projection page's chart bound it and nothing published
 *    it, so the one chart in the format drew an empty plot on every report.
 *
 * ## Units
 *
 * Percentages are stored as whole-number percent (gross yield 0–7.51, interest
 * rate 3.0–6.5, capital growth 0–26.6 across 400 sampled reports), and the
 * `percent` filter formats without multiplying (`6.5` → `"6.50%"`). So
 * percentages pass through untouched. Getting this backwards is a 100× error on
 * a client's financial report, which is why it was measured rather than
 * inferred.
 *
 * Weekly figures are `annual / 52` — a unit conversion, not a model. The one
 * modelled value is `annualRent`, which uses the report's own stated
 * `occupancyWeeks` rather than assuming 52.
 */
import { renderMarkdown } from './reports/markdown.pure.ts';
import {
  DEFAULT_LINES_PER_PAGE,
  packMarkdownPages,
  packNarrativePages,
  resolveNarrativeProfile,
} from './reports/markdownPaging.pure.ts';
import { stripBakedCover } from './reports/investment/narrativeClean.pure.ts';
import { reconcileStoredFinancials } from './reports/investment/financialEngine.pure.ts';

/** Loose row shape — the caller passes the `investment_reports` row as stored. */
export interface InvestmentReportRowLike {
  property_address?: string | null;
  property_specs?: Record<string, unknown> | null;
  financial_calculations?: Record<string, unknown> | null;
  investment_score?: Record<string, unknown> | null;
  updated_at?: string | null;
  created_at?: string | null;
  [k: string]: unknown;
}

const WEEKS_PER_YEAR = 52;

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** A finite number, or undefined. Strings are accepted because jsonb numerics arrive as either. */
function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** A non-empty trimmed string, or undefined. */
function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s ? s : undefined;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => str(x)).filter((x): x is string => !!x) : [];
}

/** Per-week from a per-year figure. Undefined in, undefined out. */
function weekly(annual: number | undefined): number | undefined {
  return annual === undefined ? undefined : annual / WEEKS_PER_YEAR;
}

/**
 * Assign only defined values.
 *
 * This is the whole "absent stays absent" rule in one function: writing
 * `undefined` onto the object would still create the key, and a template that
 * finds the key renders whatever it holds rather than falling through to empty.
 */
function put(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined && value !== null && value !== '') target[key] = value;
}

/** `3 bed · 2 bath · 1 car`, from whichever parts are present. */
function configuration(spec: (...keys: string[]) => unknown): string | undefined {
  const parts: string[] = [];
  const bed = num(spec('bedrooms'));
  const bath = num(spec('bathrooms'));
  const car = num(spec('parking', 'carSpaces', 'car_spaces'));
  if (bed !== undefined) parts.push(`${bed} bed`);
  if (bath !== undefined) parts.push(`${bath} bath`);
  if (car !== undefined) parts.push(`${car} car`);
  return parts.length ? parts.join(' · ') : undefined;
}

/**
 * The verdict as a figure: `HOLD`, not the sentence that explains it.
 *
 * `investment_score.recommendation` is one string carrying both — "HOLD -
 * Above average investment with some positive indicators, monitor closely",
 * 69 characters on average and 78 at its longest. A KPI cell is a quarter of
 * the cover's measure, about 28mm, and a sentence that long needs five lines
 * in it: rendered through WeasyPrint the cover's VERDICT cell ran past the
 * band's bottom rule, which struck through its last line.
 *
 * The split is exact rather than a guess. Every one of the 988 scored reports
 * is either `ACTION - sentence` or the bare action, and the vocabulary is four
 * words:
 *
 * | action | with a sentence | bare |
 * | --- | ---: | ---: |
 * | `HOLD` | 799 | 56 |
 * | `CAUTION` | 98 | 1 |
 * | `HOLD/BUY` | 24 | 9 |
 * | `BUY` | 1 | 0 |
 *
 * The longest action is eight characters. A string that does not match the
 * pattern is returned whole — the caller gets the same thing `headline` would
 * have given it, which is what it printed before this existed.
 *
 * `headline` is untouched, and the page-3 verdict block still sets the whole
 * sentence, where there is a full measure to set it in.
 */
function recommendationAction(headline: string | undefined): string | undefined {
  if (!headline) return undefined;
  const match = /^([A-Z][A-Za-z/ ]{1,20}?)\s+-\s+\S/.exec(headline);
  return match ? match[1].trim() : headline;
}

/**
 * The specification, read from the two columns it actually lives in.
 *
 * This mirrors `reports/investment/normalise.pure.ts`'s `toSpecs`, which took
 * the same fallback when the flowing report was measured against production —
 * and it had to be mirrored here because the templated path is a different
 * reader of the same two columns, and it was still reading only one of them.
 * Counted on the whole table, 2026-08-16:
 *
 * | field | `property_specs` | `financial_calculations.propertySpecs` |
 * | --- | ---: | ---: |
 * | land size | **0** of 1,187 | 114, as `landSizeSqm` |
 * | building size | **0** | 114, as `buildSizeSqm` |
 * | parking | **0** | 34, as `carSpaces` |
 * | property type | 1,059 | 34, as `propertyType` |
 * | year built / zoning / council | **0** | absent |
 *
 * So `property.landArea` and `property.buildingArea` were unresolvable on every
 * one of the 1,187 rows through this projection, while the record held both on
 * 114 of them. Note `buildSizeSqm`: not `building_size_sqm`, not
 * `buildingSizeSqm` — both of which read naturally and neither of which exists
 * on any row.
 *
 * `property_specs` wins wherever it holds a value: it is the column the intake
 * writes, and the other is a by-product of the finance run.
 */
function specReader(
  specs: Record<string, unknown>,
  fallback: Record<string, unknown>,
): (...keys: string[]) => unknown {
  return (...keys: string[]): unknown => {
    for (const key of keys) {
      if (specs[key] !== undefined && specs[key] !== null) return specs[key];
    }
    for (const key of keys) {
      if (fallback[key] !== undefined && fallback[key] !== null) return fallback[key];
    }
    return undefined;
  };
}

export interface ProjectedNamespaces {
  property: Record<string, unknown>;
  financials: Record<string, unknown>;
  assumptions: Record<string, unknown>;
  recommendation: Record<string, unknown>;
  summary: Record<string, unknown>;
  risks: Record<string, unknown>[];
  /** The five weighted score dimensions, where the row carries a score. */
  assessment: Record<string, unknown>[];
  opportunities: string[];
  /** `{ label, value }` per year, for the projection page's chart. */
  equitySeries: Array<{ label: string; value: number }>;
  report: Record<string, unknown>;
  /**
   * The report the model actually wrote — its own sections, in its own order.
   *
   * See `projectReportNarrative`. `source` is Markdown for `markdown-block`;
   * `pages` is how many pages it needs at the master's line budget, computed
   * with the same `packMarkdownPages` the block uses.
   */
  narrative: Record<string, unknown>;
}

/**
 * `report_content` as a bindable body, and the pages it needs.
 *
 * ## What was missing
 *
 * Every namespace above comes from a jsonb column the calculator wrote —
 * `investment_score`, `financial_calculations`, `property_specs`. None of them
 * is the report. The report is `report_content`: the document the model writes
 * against the configured `report_structure_templates` guide, and the thing an
 * operator means by "the report structure".
 *
 * Measured 2026-08-16 on one address generated at all five tiers, the model
 * writes a full document every time —
 *
 * | tier | headings | opens with |
 * | --- | ---: | --- |
 * | `snapshot` | 9 | Property Summary |
 * | `briefing` | 39 | Location Overview |
 * | `financial` | 42 | Client Investment Decision Summary |
 * | `strategic` | 80 | Property & Location Due Diligence Report |
 * | `compass` | 107 | Executive Verdict |
 *
 * — and **not one of those sections reached a page**. `{{sections.*}}` is bound
 * by 0 of the 13 active `report_templates` rows, and this projection published
 * nothing from `report_content` at all, so a template rendered the scorecard on
 * a fixed page sequence and the report itself was simply absent.
 *
 * ## Why the whole body rather than per-section bindings
 *
 * A section-per-binding shape needs the template to know the section ids, and
 * they are not knowable: they come from whichever guide is configured, they
 * differ per tier, and the guides are edited in the product. A master binding
 * `{{sections.executive_verdict.body}}` is a master that breaks when somebody
 * renames a heading.
 *
 * The body is carried whole instead, by the mechanism this programme already
 * uses for the two other model-authored formats: conditional pages, each
 * holding one bucket of the same source, sized by `packMarkdownPages`. See
 * `markdownPaging.pure.ts` for why the block and this function must be the same
 * arithmetic.
 */
export function projectReportNarrative(
  content: unknown,
  linesPerPage: number = DEFAULT_LINES_PER_PAGE,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const raw = typeof content === 'string' ? content.trim() : '';
  if (!raw) return out;

  // The baked masthead and "Cover Page" section come out before anything else
  // reads this narrative — every surface draws its own cover now, and the
  // baked one rendered as a second cover inside the body of a templated
  // document. See `narrativeClean.pure.ts` for what is (and is not) matched.
  const source = stripBakedCover(raw).text.trim();
  if (!source) return out;

  // The chart directives the generator's prompt demands are an instruction to
  // the renderer, and `markdown.pure.ts` drops one it cannot draw rather than
  // printing its source. Nothing to strip here: a directive that survives to
  // the block is drawn or dropped there, in one place.
  put(out, 'source', source);

  // The calibrated narrative profile — the SAME resolution the markdown block
  // makes, so the page count this publishes and the buckets the block draws
  // cannot disagree. `linesPerPage` doubles as the schema sentinel: the value
  // deployed masters bake (34) resolves to the calibrated budgets.
  const profile = resolveNarrativeProfile('investment');
  const blocks = renderMarkdown(source, { charging: profile?.charging }).blocks;
  const pages = (profile
    ? packNarrativePages(blocks, profile, linesPerPage)
    : packMarkdownPages(blocks, linesPerPage)).length;
  put(out, 'pages', pages || undefined);
  return out;
}

/**
 * Build the catalogue-vocabulary view of one stored report.
 *
 * Every namespace returned is partial by design; merge it over the raw ones.
 */
export function projectInvestmentReport(row: InvestmentReportRowLike): ProjectedNamespaces {
  const specs = obj(row.property_specs);
  // Stored financials are reconciled before anything reads them: historic
  // rows carry the pre-fix fold's inflated series and totals that do not
  // foot against their own lines. See reconcileStoredFinancials — exact,
  // component-derived, and a no-op on a post-fix row.
  const fin = obj(reconcileStoredFinancials(obj(row.financial_calculations)).fin);
  const score = obj(row.investment_score);

  const initial = obj(fin.initialCosts);
  const income = obj(fin.income);
  const metrics = obj(fin.keyMetrics);
  const loan = obj(fin.loanDetails);
  const costs = obj(fin.annualCosts);
  const assumptions = obj(fin.assumptions);

  // ── property ──────────────────────────────────────────────────────────────
  const spec = specReader(specs, obj(fin.propertySpecs));
  const property: Record<string, unknown> = {};
  put(property, 'address', str(row.property_address));
  put(property, 'type', str(spec('property_type', 'propertyType')));
  put(property, 'yearBuilt', num(spec('year_built', 'yearBuilt')) ?? str(spec('year_built', 'yearBuilt')));
  put(property, 'landArea', num(spec('land_size_sqm', 'landSizeSqm')));
  put(property, 'buildingArea', num(spec('building_size_sqm', 'buildingSizeSqm', 'buildSizeSqm')));
  put(property, 'zoning', str(spec('zoning')));
  put(property, 'council', str(spec('council_area', 'councilArea')));
  put(property, 'configuration', configuration(spec));

  // ── financials ────────────────────────────────────────────────────────────
  const annualRates = num(costs.councilRates);
  const annualInsurance = num(costs.landlordInsurance);
  const annualManagement = num(costs.propertyManagement);
  const annualMaintenance = num(costs.maintenance);
  const weeklyRent = num(income.weeklyRent);
  const occupancyWeeks = num(assumptions.occupancyWeeks);
  const monthlyPayment = num(loan.monthlyPayment);

  const financials: Record<string, unknown> = {};
  put(financials, 'purchasePrice', num(initial.propertyValue));
  put(financials, 'stampDuty', num(initial.stampDuty));
  put(financials, 'legalFees', num(initial.legalFees));
  put(financials, 'inspectionFees', num(initial.inspectionFees));
  // Published so a page listing the upfront lines can foot to `totalCost`,
  // which the reconciliation derives from exactly these lines.
  put(financials, 'lmi', num(initial.lmi));
  put(financials, 'totalCost', num(initial.totalUpfront));
  put(financials, 'deposit', num(initial.deposit));
  put(financials, 'loanAmount', num(loan.loanAmount) ?? num(initial.loanAmount));
  put(financials, 'weeklyRent', weeklyRent);
  // The report's own occupancy assumption, not a flat 52 weeks.
  put(financials, 'annualRent', weeklyRent !== undefined && occupancyWeeks !== undefined
    ? weeklyRent * occupancyWeeks
    : undefined);
  put(financials, 'grossYield', num(metrics.grossRentalYield));
  put(financials, 'netYield', num(metrics.netRentalYield));
  put(financials, 'cashOnCash', num(metrics.cashOnCashReturn));
  put(financials, 'weeklyNet', num(metrics.weeklyNet));
  put(financials, 'annualNet', num(metrics.annualNet));
  put(financials, 'lvr', num(metrics.lvr) ?? num(loan.lvr));
  put(financials, 'totalInvestment', num(metrics.totalInvestment));
  put(financials, 'weeklyRepayment', num(loan.weeklyPayment));
  put(financials, 'annualRepayment', monthlyPayment === undefined ? undefined : monthlyPayment * 12);
  put(financials, 'annualRates', annualRates);
  put(financials, 'weeklyRates', weekly(annualRates));
  put(financials, 'annualInsurance', annualInsurance);
  put(financials, 'weeklyInsurance', weekly(annualInsurance));
  put(financials, 'annualManagement', annualManagement);
  put(financials, 'weeklyManagement', weekly(annualManagement));
  put(financials, 'annualMaintenance', annualMaintenance);
  put(financials, 'weeklyMaintenance', weekly(annualMaintenance));
  put(financials, 'annualCosts', num(costs.totalAnnual));

  // ── assumptions ───────────────────────────────────────────────────────────
  const assumptionsOut: Record<string, unknown> = {};
  put(assumptionsOut, 'capitalGrowth', num(assumptions.capitalGrowth));
  put(assumptionsOut, 'interestRate', num(loan.interestRate));
  put(assumptionsOut, 'occupancyWeeks', occupancyWeeks);
  // Vacancy as whole-number percent, matching how every other rate is stored.
  put(assumptionsOut, 'vacancy', occupancyWeeks === undefined
    ? undefined
    : ((WEEKS_PER_YEAR - occupancyWeeks) / WEEKS_PER_YEAR) * 100);

  // ── verdict, risks, summary ───────────────────────────────────────────────
  // `investment_score.recommendation` is one string; there is no rationale
  // field, so `recommendation.rationale` stays absent rather than echoing the
  // headline back at the reader.
  const recommendation: Record<string, unknown> = {};
  put(recommendation, 'headline', str(score.recommendation));
  put(recommendation, 'action', recommendationAction(str(score.recommendation)));
  put(recommendation, 'grade', str(score.grade));
  put(recommendation, 'score', num(score.totalScore));

  const strengths = strArray(score.strengths);
  const weaknesses = strArray(score.weaknesses);
  const summary: Record<string, unknown> = {};
  if (strengths.length) summary.strength = strengths;
  if (weaknesses.length) summary.watch = weaknesses;

  // Objects rather than bare strings, because the catalogue binds `risks.N.risk`.
  //
  // There is never more than ONE. Measured across all 1,182 reports:
  // `investment_score.risks` is an array on 985 of them and its length runs
  // **0 to 1** — never 2, never 3. The catalogue drew a three-row register, so
  // rows two and three were blank on every report ever produced, and the `why`
  // and `ddAction` columns were blank on all three because a risk is a plain
  // string with no such fields. The register now reads `assessment` below.
  const risks = strArray(score.risks).map((risk) => ({ risk }));

  // ── the scored breakdown, which is what this report actually computed ──────
  //
  // `investment_score.breakdown` holds five weighted dimensions — growth (40),
  // location (25), yield (15), demand (15), risk (5) — each with a `score`, its
  // `weight` and a `details` sentence explaining the score. That `details` is
  // the only per-dimension prose the record carries, and nothing bound it.
  //
  // It is published under its own key rather than folded into `risks` because
  // it is not a risk register: it is the scorecard the grade is computed from,
  // and `riskScore` is one row of five. `details` is empty on the dimensions the
  // scorer had no data for — `demandScore` and `growthScore` on the sampled
  // rows — so each entry is only emitted where it says something.
  const breakdown = obj(score.breakdown);
  const DIMENSIONS: Array<{ key: string; label: string }> = [
    { key: 'growthScore', label: 'Growth' },
    { key: 'locationScore', label: 'Location' },
    { key: 'yieldScore', label: 'Yield' },
    { key: 'demandScore', label: 'Demand' },
    { key: 'riskScore', label: 'Risk' },
  ];
  /**
   * A dimension the engine did not score prints as such, not as 50.
   *
   * `investment_score.breakdown.<dim>` carries `excluded: true`,
   * `hasData: false` and `weight: 0` when the engine had nothing to score with
   * — and a **placeholder `score` of 50 sitting in the field regardless**. The
   * scorecard bound `score` and `weight` straight through, so the page printed
   *
   *     Growth   50   0%
   *     Demand   50   0%
   *
   * which is a fabricated figure against a weight that says it counted for
   * nothing. Measured 2026-08-16: 9 of the 988 scored reports are in that
   * state, on `growthScore` and `demandScore`, and on every one of the 9 the
   * placeholder is exactly 50 and the weight exactly 0. Small, and a number a
   * client would read as an assessment.
   *
   * `normalise.pure.ts`'s `toScore` already refuses to plot it — "the engine is
   * saying it had no data, and plotting it would put a fabricated point on the
   * wheel". This is the same refusal for the templated path.
   *
   * The row stays. A four-row table where the reader was told there are five
   * dimensions reads as a table cut for space; "Not assessed" says what
   * happened. So the numeric `score`/`weight` are withheld — nothing can plot
   * a placeholder — and the table binds the composed labels instead.
   */
  /**
   * The engine writes its thresholds into its own explanation — "Good
   * walkability (50-69)", "Moderate LVR (70-80%)" — and those parenthetical
   * scoring bands are the engine talking to itself, not to a client. A reader
   * outside the industry gets the words; the band edges belong to the
   * methodology page, not a scorecard cell.
   */
  const humaniseScoreDetail = (detail: string | undefined): string | undefined => {
    if (!detail) return detail;
    const cleaned = detail
      .replace(/\s*\((?:[<>~≤≥]?\s*\d+[\d.,]*\s*(?:[-–—]|to)\s*\d+[\d.,]*\s*%?|\d+[\d.,]*\s*\+?\s*%?)\)/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return cleaned || detail;
  };

  const assessment = DIMENSIONS.map(({ key, label }) => {
    const d = obj(breakdown[key]);
    const score = num(d.score);
    const weight = num(d.weight);
    const scored = !(d.excluded === true || d.hasData === false);
    const entry: Record<string, unknown> = {};
    put(entry, 'label', label);
    put(entry, 'scored', scored);
    if (scored) {
      put(entry, 'score', score);
      put(entry, 'weight', weight);
    }
    put(entry, 'scoreLabel', scored && score !== undefined ? String(Math.round(score)) : 'Not assessed');
    put(entry, 'weightLabel', scored && weight !== undefined ? `${Math.round(weight)}%` : '—');
    put(entry, 'details', humaniseScoreDetail(str(d.details)));
    return entry;
    // A dimension the record does not carry at all has no score AND no
    // exclusion flag; it is absent from the engine's output rather than
    // withheld by it, so it is not a row.
  }).filter((e) => e.score !== undefined || e.scored === false);

  const opportunities = strArray(score.opportunities);

  // ── the ten-year equity curve the chart page has always asked for ─────────
  //
  // `scenarioChart` on the projection page binds `tenYear.equitySeries`, and
  // **nothing published `tenYear`** — so the one chart in the Investment
  // Compass drew an empty plot on every report.
  //
  // The series is right here, in the same column the financials come from:
  // `financial_calculations.projections.moderate`, ten years of
  // `{ year, equity }`, on 162 of the 1,182 reports. The other 1,020 store no
  // projection at all, and for those the key stays absent and the chart renders
  // as it does today rather than as a flat line at zero — which would be a
  // forecast, and a wrong one.
  //
  // Equity rather than value or cash flow: it is what the block's own caption
  // says ("property value less loan balance"), it is positive on all 4,860
  // stored elements, and every chart primitive a family resolves to can draw
  // it. See `cashFlowProjection.pure.ts` for the rest of that series.
  const projections = obj(fin.projections);
  const moderate = Array.isArray(projections.moderate) ? projections.moderate : [];
  const equitySeries = moderate
    .map((y) => {
      const year = num(obj(y).year);
      const equity = num(obj(y).equity);
      return year !== undefined && equity !== undefined
        ? { label: `Yr ${year}`, value: equity }
        : null;
    })
    .filter((p): p is { label: string; value: number } => p !== null);

  const report: Record<string, unknown> = {};
  put(report, 'generatedDate', str(row.updated_at) ?? str(row.created_at));

  return {
    property, financials, assumptions: assumptionsOut, recommendation,
    summary, risks, assessment, opportunities, equitySeries, report,
    narrative: projectReportNarrative(row.report_content),
  };
}

/**
 * Merge the projection over an existing binding-context `data` object.
 *
 * Raw namespaces win nothing and lose nothing: existing keys are preserved and
 * projected keys are layered on top, so `property.year_built` and
 * `property.yearBuilt` both resolve afterwards.
 */
export function applyInvestmentProjection(
  data: Record<string, any>,
  row: InvestmentReportRowLike,
): Record<string, any> {
  const p = projectInvestmentReport(row);
  const merge = (key: string, extra: Record<string, unknown>) => {
    if (!Object.keys(extra).length) return;
    data[key] = { ...obj(data[key]), ...extra };
  };
  merge('property', p.property);
  merge('financials', p.financials);
  merge('assumptions', p.assumptions);
  merge('recommendation', p.recommendation);
  merge('summary', p.summary);
  merge('report', p.report);
  // The report the model wrote. Absent — not empty — when the row carries no
  // content, so the narrative pages are conditional on something real: 4 of the
  // 1,187 stored reports have no body at all.
  merge('narrative', p.narrative);
  if (p.risks.length) data.risks = p.risks;
  // Absent rather than empty, so a template can make the block conditional.
  if (p.assessment.length) data.assessment = p.assessment;
  if (p.opportunities.length) data.opportunities = p.opportunities;
  // Absent on the 1,020 reports that store no projection, so the chart is empty
  // rather than flat at zero.
  if (p.equitySeries.length) {
    data.tenYear = { ...obj(data.tenYear), equitySeries: p.equitySeries };
  }
  return data;
}
