/**
 * Governed narrative authority — a withheld fact may not be re-sourced.
 *
 * ## The defect this closes, measured in production
 *
 * RF-7.2B.1's Client-Safe Gate withholds demographics, SEIFA and employment
 * when no trusted geography is available. Two reports generated on 2026-09-11
 * through the real pipeline (`09f8569e…` Cowra, `3fbbcfe6…` Muswellbrook) had
 * `market.demographics` recorded `absent` in `market_fact_snapshot` — and both
 * documents then stated demographic figures anyway:
 *
 *   "According to the Australian Bureau of Statistics 2021 Census,
 *    Muswellbrook township recorded 12,272 residents, with a median age of 35"
 *
 * `abs_census_poa` for POA 2333 holds **13,795** and median age **36**. The
 * figures are not the platform's; they came from the section generator, which
 * is Perplexity `sonar-pro` — a SEARCH-GROUNDED model. Withholding the
 * authoritative number did not remove the claim, it removed the source: the
 * prompt still asked for a demographics section, so the model searched, and
 * wrote what it found under an ABS citation at a geography nobody asked for
 * (township, SA2, LGA, ERP — never the subject postal area).
 *
 * Three things were true at once and each was necessary:
 *
 *  1. **The withholding never reached the prompt.** `safeGeneration.removed`
 *     was `console.log`ged and nothing else, so the model was never told a
 *     category was unavailable, only handed a context without it.
 *  2. **The post-generation audit could not see it.** `auditMarketClaims` is
 *     VALUE-anchored — it finds a number it already holds and checks the prose
 *     around it (`if (fact.status !== 'present') continue`). A withheld fact
 *     has no value to anchor on, so nothing was checked.
 *  3. **Each half assumed the other covered it.** `marketClaimAudit`'s header
 *     said a mention of a withheld figure was "a different defect that the
 *     fact reconciliation already looks for". It does not:
 *     `factReconciliation.pure.ts` contains no occurrence of `withheld`,
 *     `absent`, `demographic` or `population`. Neither module covered it.
 *
 * ## The invariant
 *
 * **A governed market fact may be narrated quantitatively only when an
 * admissible corresponding fact exists in `market_fact_snapshot`.**
 *
 * This module is both halves of that, deliberately in ONE file: the directive
 * the prompt carries and the audit that checks the result read the same
 * category table. Two copies of "which categories are governed" is exactly how
 * the two modules above drifted apart.
 *
 * ## Why detection is sentence-scoped
 *
 * A governed TERM alone is not a claim — "tenants are typically local workers,
 * families and retirees rather than transient short-stay populations" says
 * nothing quantitative and must pass. A NUMBER alone is not a claim either —
 * "the near-1,000 m² land size" is the property's own fact. The claim is the
 * two together, in one sentence. Scoping to the sentence rather than a
 * character window is what stops a land size three clauses away from being
 * read as a population count.
 *
 * Bare four-digit years are excluded from what counts as quantitative, because
 * "the 2021 Census" beside the word "population" is an attribution, not a
 * figure. A genuine population of exactly 2,021 people written without its
 * separator would be missed; that is the conservative side of the trade and it
 * is preferred to blocking a report for citing a census year.
 *
 * Pure: no Deno, no DOM, no network, no clock.
 */

import type { MarketFactSnapshot, SnapshotFact } from './safeGenerationInputs.pure.ts';

export const GOVERNED_NARRATIVE_AUTHORITY_VERSION = '1.0.0';

export type GovernedCategory = 'demographics' | 'seifa' | 'employment';

/** How a category stands for one report. */
export type CategoryStanding = 'admissible' | 'withheld';

export type GovernedFaultKind =
  | 'substituted_figure'
  | 'false_attribution'
  | 'cross_grain_substitution';

export interface GovernedClaimFault {
  readonly category: GovernedCategory;
  /** The specific figure, so two missing figures in one category both report. */
  readonly topic: string;
  readonly kind: GovernedFaultKind;
  /** The sentence the claim was found in, trimmed for a reviewer. */
  readonly excerpt: string;
  readonly message: string;
}

/**
 * Authority is per FACT, not per category — proved from the gate, not assumed.
 *
 * `activateSafeGenerationInputs` emits one snapshot fact per narrated metric:
 *
 *     for (const metric of SNAPSHOT_ABS_METRICS)
 *       facts.push(gateFact({ name: metric.name,
 *                             value: readPath(demographics, metric.path), … }))
 *
 * A path the ABS row does not carry yields an ABSENT fact standing beside
 * present siblings, so `population` present with `medianAge` absent is a state
 * the gate can really produce. SEIFA is looser still — `if (!isRecord(
 * seifa[index])) continue` emits NO fact for a missing index — and industry
 * shares are capped at `SNAPSHOT_INDUSTRY_ROWS`, so an unlisted industry has
 * no fact either.
 *
 * The categories are therefore NOT atomic, and a category-level reading would
 * let one present figure authorise every absent one beside it: exactly the
 * substitution this module exists to refuse, performed with the module's own
 * blessing. Standing is resolved per topic, against the facts that topic owns.
 *
 * A topic with `owns: null` has no fact of its own in the snapshot vocabulary
 * — average household size is narrated but never snapshotted individually — so
 * it is evidenced by the category roll-up instead. That keeps a healthy report
 * free to state it while a withheld one still cannot invent it.
 */
interface TopicSpec {
  readonly topic: string;
  readonly category: GovernedCategory;
  readonly label: string;
  /** Snapshot facts that evidence this topic; null = the category roll-up does. */
  readonly owns: ((factName: string) => boolean) | null;
  /** Governed labels as they appear in prose. */
  readonly terms: RegExp;
}

/** The roll-up each category carries, used only by `owns: null` topics. */
const UMBRELLA: Record<GovernedCategory, string> = {
  demographics: 'market.demographics',
  seifa: 'market.demographics',
  employment: 'market.demographics',
};

const TOPICS: readonly TopicSpec[] = [
  {
    topic: 'population',
    category: 'demographics',
    label: 'resident population',
    owns: (n) => n === 'market.population' || n === 'abs.population',
    terms: /\b(population|residents?)\b/gi,
  },
  {
    topic: 'medianAge',
    category: 'demographics',
    label: 'median age',
    owns: (n) => n === 'market.medianAge' || n === 'abs.medianAge',
    terms: /\bmedian age\b/gi,
  },
  {
    topic: 'income',
    category: 'demographics',
    label: 'median income',
    owns: (n) =>
      n === 'market.medianHouseholdIncomeWeekly'
      || n === 'abs.medianHouseholdIncomeAnnual'
      || n === 'abs.medianWeeklyIncome',
    terms: /\bmedian (?:weekly |annual )?(?:household |personal |family )?income\b/gi,
  },
  {
    topic: 'medianRent',
    category: 'demographics',
    label: 'median rent',
    owns: (n) => n === 'market.medianRentWeekly',
    terms: /\bmedian rent\b/gi,
  },
  {
    topic: 'medianMortgage',
    category: 'demographics',
    label: 'median mortgage repayment',
    owns: (n) => n === 'market.medianMortgageMonthly',
    terms: /\bmedian mortgage\b/gi,
  },
  {
    topic: 'tenure',
    category: 'demographics',
    label: 'tenure split',
    owns: (n) => n === 'market.ownerOccupierRate' || n === 'market.renterRate',
    // Plurals matter: the defect corpus contains a model-drawn occupier-mix
    // chart reading `Local owner-occupiers 35`, which asserts an
    // owner-occupier RATE, and `owner[- ]occupier` alone does not match it.
    terms: /\b(owner[- ]occupiers?|renters?|rented dwellings?|tenure)\b/gi,
  },
  {
    topic: 'householdSize',
    category: 'demographics',
    label: 'average household size',
    owns: null,
    terms: /\bhousehold size\b/gi,
  },
  {
    topic: 'seifaIrsd',
    category: 'seifa',
    label: 'the IRSD index',
    owns: (n) => n === 'abs.seifa.irsd' || n === 'abs.seifa.irsdDecile',
    terms: /\birsd\b/gi,
  },
  {
    topic: 'seifaIrsad',
    category: 'seifa',
    label: 'the IRSAD index',
    owns: (n) => n === 'abs.seifa.irsad' || n === 'abs.seifa.irsadDecile',
    terms: /\birsad\b/gi,
  },
  {
    topic: 'seifaIer',
    category: 'seifa',
    label: 'the IER index',
    owns: (n) => n === 'abs.seifa.ier' || n === 'abs.seifa.ierDecile',
    terms: /\bier\b/gi,
  },
  {
    topic: 'seifaIeo',
    category: 'seifa',
    label: 'the IEO index',
    owns: (n) => n === 'abs.seifa.ieo' || n === 'abs.seifa.ieoDecile',
    terms: /\bieo\b/gi,
  },
  {
    topic: 'seifaGeneral',
    category: 'seifa',
    label: 'SEIFA socio-economic ranking',
    owns: (n) => n.startsWith('abs.seifa.'),
    terms: /\b(seifa|socio[- ]economic (?:index|advantage|disadvantage)|decile)\b/gi,
  },
  {
    topic: 'unemployment',
    category: 'employment',
    label: 'the unemployment rate',
    owns: (n) => n === 'abs.unemploymentRate' || n === 'market.unemploymentRate',
    terms: /\bunemployment rate\b/gi,
  },
  {
    topic: 'participation',
    category: 'employment',
    label: 'the labour-force participation rate',
    owns: (n) => n === 'abs.labourForceParticipation' || n === 'market.participationRate',
    terms: /\bparticipation rate\b/gi,
  },
  {
    topic: 'labourForce',
    category: 'employment',
    label: 'the labour force',
    owns: (n) => n === 'abs.labourForce' || n === 'abs.employmentRate',
    terms: /\b(labour force|labor force|employed residents?|employment rate)\b/gi,
  },
  {
    topic: 'industryShare',
    category: 'employment',
    label: 'workforce composition by industry',
    owns: (n) => n.startsWith('abs.industryShare.'),
    terms: /\b(industry share|workforce|largest (?:single )?industry|employing)\b/gi,
  },
];

/** What each category's directive forbids, named rather than gestured at. */
const CATEGORY_BANNED: Record<GovernedCategory, readonly string[]> = {
  demographics: [
    'a population or resident count',
    'a median age',
    'a median household, personal or family income',
    'a median rent or mortgage figure',
    'an owner-occupier, renter or tenure percentage',
  ],
  seifa: [
    'a SEIFA score or decile',
    'an IRSD, IRSAD, IER or IEO figure',
    'a socio-economic ranking expressed as a number',
  ],
  employment: [
    'an unemployment or participation rate',
    'a labour-force or employed-persons count',
    'an industry share or workforce percentage',
  ],
};

const CATEGORY_LABEL: Record<GovernedCategory, string> = {
  demographics: 'resident demographics',
  seifa: 'SEIFA socio-economic indexes',
  employment: 'workforce and employment composition',
};

const ALL_CATEGORIES: readonly GovernedCategory[] = ['demographics', 'seifa', 'employment'];

/** Attribution to an official statistical source. */
const ATTRIBUTION =
  /\b(australian bureau of statistics|\babs\b|census|\bnema\b|areasearch|id\.community|profile\.id)\b/i;

/** A geography that is not the subject postal area. */
const OTHER_GRAIN =
  /\b(sa2|sa3|sa4|\blga\b|local government area|township|shire|erp|estimated resident population|statistical area)\b/i;

/**
 * A quantitative token. Currency, percentages and separated thousands are
 * always quantitative; a bare integer counts too, except where it is a plain
 * four-digit year (see the header for why that trade is taken this way).
 */
const QUANT = /\$\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?%|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\b\d+(?:\.\d+)?\b/g;

/**
 * A figure this sentence has already attributed to something that is NOT a
 * governed category — the property's own facts and the deal's finance.
 *
 * Checked against the text immediately BEFORE each figure, because that is
 * where the attribution sits: "the local tenant population and was purchased
 * for $555,000" carries a governed term and a figure in one sentence, and the
 * figure is the purchase price. Without this the detector blocks a report for
 * quoting what the customer paid.
 *
 * Deliberately absent from this list: income, rent as a MEDIAN, tenure and
 * anything else that is itself a governed category — `median rent` and
 * `median household income` must keep firing.
 */
const NON_GOVERNED_ATTRIBUTION =
  /\b(purchased|purchase price|bought|sold|sale price|price|valued at|valuation|stamp duty|solicitor|conveyanc|loan|deposit|lvr|loan[- ]to[- ]value|interest rate|repayment|land size|block of|build size|floor area|bedrooms?|bathrooms?|car spaces?|settlement|occupancy|insurance|council rates|water rates|strata|body corporate|management fee|letting fee|depreciation|yield|cash flow|per week|per annum|m²|sqm|square metres)\b[^.]{0,34}$/i;

/** Characters of preceding context examined for that attribution. */
const ATTRIBUTION_LOOKBEHIND = 46;

function hasQuantitativeAssertion(sentence: string): boolean {
  QUANT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = QUANT.exec(sentence)) !== null) {
    const token = match[0].trim();
    const bare = token.replace(/[\s,$%]/g, '');
    const decorated = /[$%]/.test(token) || /,/.test(token);
    if (!decorated && /^(?:19|20)\d{2}$/.test(bare)) continue; // a year, not a figure
    const before = sentence.slice(Math.max(0, match.index - ATTRIBUTION_LOOKBEHIND), match.index);
    if (NON_GOVERNED_ATTRIBUTION.test(before)) continue; // the deal's figure, not the area's
    return true;
  }
  return false;
}

/**
 * Split into claim-sized units. Sentences, but newlines end a unit too: a
 * markdown table row and a `{{bars: …}}` visual directive each assert on their
 * own line without a full stop, and both carry figures.
 */
function claimUnits(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const trim = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 240);

/**
 * Where ONE topic stands: admissible only where the snapshot holds a PRESENT
 * fact that evidences that topic specifically.
 *
 * A topic with no fact of its own in the snapshot at all reads `withheld`,
 * not `admissible` — absence of evidence is the whole condition this guards.
 */
function standingOf(spec: TopicSpec, facts: readonly SnapshotFact[]): CategoryStanding {
  if (spec.owns === null) {
    const umbrella = UMBRELLA[spec.category];
    for (const fact of facts) {
      if (fact.name === umbrella && fact.status === 'present') return 'admissible';
    }
    return 'withheld';
  }
  for (const fact of facts) {
    if (!spec.owns(fact.name)) continue;
    if (fact.status === 'present') return 'admissible';
  }
  return 'withheld';
}

/** Every governed topic and where it stands for this report. */
export function governedTopicStanding(
  snapshot: Pick<MarketFactSnapshot, 'facts'> | null | undefined,
): Record<string, CategoryStanding> {
  const facts = snapshot?.facts ?? [];
  const out: Record<string, CategoryStanding> = {};
  for (const spec of TOPICS) out[spec.topic] = standingOf(spec, facts);
  return out;
}

/**
 * Category standing, kept for the directive and for reporting.
 *
 * A category is `admissible` only when EVERY topic in it is — because the
 * directive it drives says "this category is not available", and saying that
 * while one of its figures is genuinely held would be false. Enforcement does
 * not read this: the audit resolves per topic, so a partially-present category
 * still refuses exactly the figures it cannot evidence.
 */
export function governedCategoryStanding(
  snapshot: Pick<MarketFactSnapshot, 'facts'> | null | undefined,
): Record<GovernedCategory, CategoryStanding> {
  const facts = snapshot?.facts ?? [];
  const out = {} as Record<GovernedCategory, CategoryStanding>;
  for (const category of ALL_CATEGORIES) {
    const topics = TOPICS.filter((t) => t.category === category);
    out[category] = topics.every((t) => standingOf(t, facts) === 'admissible')
      ? 'admissible'
      : 'withheld';
  }
  return out;
}

/**
 * The directive the prompt carries when a governed category is unavailable.
 *
 * Returns '' when every category is admissible, so a healthy report's prompt
 * is byte-identical to what it is today. Modelled on `absentRentDirective`,
 * which already establishes the shape: name the absence, forbid the
 * substitution specifically, and keep qualitative discussion open — a
 * prohibition with no permitted action is one a model routes around.
 */
export function governedCategoryDirective(
  snapshot: Pick<MarketFactSnapshot, 'facts'> | null | undefined,
): string {
  const topicStanding = governedTopicStanding(snapshot);
  const withheldTopics = TOPICS.filter((t) => topicStanding[t.topic] === 'withheld');
  if (withheldTopics.length === 0) return '';

  const lines: string[] = [
    '',
    '**GOVERNED DATA UNAVAILABLE FOR THIS PROPERTY.** The figures below could not',
    'be established for the subject property from an authoritative source, so this',
    'report does NOT have them. They are unavailable, not merely missing from the',
    'context above.',
    '',
  ];

  // Named per CATEGORY where the whole category is gone, and per FIGURE where
  // only some of it is: "demographics are unavailable" is misleading on a
  // report that genuinely holds the population and is missing only the median
  // age, and a directive that misdescribes the data is one a model discounts.
  const categoryStanding = governedCategoryStanding(snapshot);
  for (const category of ALL_CATEGORIES) {
    const missing = withheldTopics.filter((t) => t.category === category);
    if (missing.length === 0) continue;
    if (categoryStanding[category] === 'withheld'
        && missing.length === TOPICS.filter((t) => t.category === category).length) {
      lines.push(`- **${CATEGORY_LABEL[category]} — NOT AVAILABLE.** Do not state:`);
      for (const banned of CATEGORY_BANNED[category]) lines.push(`    - ${banned};`);
    } else {
      lines.push(`- **${CATEGORY_LABEL[category]} — PARTLY AVAILABLE.** These specific`);
      lines.push('  figures are NOT held for this property and must not be stated:');
      for (const t of missing) lines.push(`    - ${t.label};`);
      lines.push('  Figures in this category that ARE supplied above may be used normally.');
    }
  }

  lines.push(
    '',
    'For every category listed above, in this report:',
    '',
    '- Do NOT search for, look up, recall or derive a replacement figure. A figure',
    '  obtained from a web search, a statistical publication, an encyclopaedia, a',
    '  council or agency profile, or your own knowledge is NOT a substitute and must',
    '  not appear.',
    '- Do NOT substitute a different geography. A figure for an SA2, an SA3, an LGA,',
    '  a shire, a township, an urban centre, an ERP series or any area other than the',
    '  subject property\'s own postal area is NOT a substitute and must not appear.',
    '- Do NOT attribute any figure to the ABS, the Census, or any statistical agency',
    '  in this report for these categories. No such figure is held for this property.',
    '- Where such a figure would have appeared, write "Not available" and state in one',
    '  sentence that the data could not be established for this property.',
    '- You MAY still discuss the area qualitatively — its role, its amenity, the kind',
    '  of tenant it attracts, the character of local demand — provided you attach NO',
    '  number to any category listed above.',
    '',
  );
  return lines.join('\n');
}

/**
 * Audit the finished prose for governed claims the snapshot cannot support.
 *
 * Category-anchored, where `auditMarketClaims` is value-anchored: it asks
 * whether the text asserts a category for which no admissible fact exists,
 * which is precisely the question a withheld fact makes unanswerable by
 * looking for its value.
 */
export function auditGovernedNarrativeAuthority(
  reportText: unknown,
  snapshot: Pick<MarketFactSnapshot, 'facts'> | null | undefined,
): GovernedClaimFault[] {
  if (typeof reportText !== 'string' || reportText.trim() === '') return [];
  const standing = governedTopicStanding(snapshot);
  const withheld = TOPICS.filter((t) => standing[t.topic] === 'withheld');
  if (withheld.length === 0) return [];

  const faults: GovernedClaimFault[] = [];
  const units = claimUnits(reportText);

  for (const unit of units) {
    if (!hasQuantitativeAssertion(unit)) continue;
    for (const spec of withheld) {
      spec.terms.lastIndex = 0;
      if (!spec.terms.test(unit)) continue;

      if (ATTRIBUTION.test(unit)) {
        faults.push({
          category: spec.category,
          topic: spec.topic,
          kind: 'false_attribution',
          excerpt: trim(unit),
          message:
            `A figure for ${spec.label} is attributed to an official statistical source, `
            + 'but no such figure is held for this property — the category was withheld '
            + 'because trusted geography was unavailable. The attribution cannot be honoured.',
        });
        continue;
      }

      if (OTHER_GRAIN.test(unit)) {
        faults.push({
          category: spec.category,
          topic: spec.topic,
          kind: 'cross_grain_substitution',
          excerpt: trim(unit),
          message:
            `A figure for ${spec.label} is stated for a different geography (an SA2, LGA, `
            + 'township, shire or ERP series) in place of the subject property\'s own postal '
            + 'area. A neighbouring grain is not a substitute for the area that was withheld.',
        });
        continue;
      }

      faults.push({
        category: spec.category,
        topic: spec.topic,
        kind: 'substituted_figure',
        excerpt: trim(unit),
        message:
          `A quantitative claim about ${spec.label} appears in the report, but the snapshot `
          + 'holds no admissible fact for that category. A governed fact may be narrated '
          + 'quantitatively only where the report actually holds it.',
      });
    }
  }

  // One fault of each kind per category is enough to send a reviewer to the
  // text; the same finding twenty times is how a flag list stops being read.
  const seen = new Set<string>();
  return faults.filter((f) => {
    const key = `${f.topic}|${f.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Does this set of faults block the report from being treated as client-ready?
 *
 * Every fault of this class blocks. The category exists because the claim is
 * unsupported by anything the platform holds, and an unsupported factual claim
 * about a customer's property is not a disclosure-grade finding.
 */
export function governedAuthorityBlocks(faults: readonly GovernedClaimFault[]): boolean {
  return faults.length > 0;
}

/** Named once: both writers and the delivery gate must agree on this string. */
export const GOVERNED_AUTHORITY_FLAG_TYPE = 'governed_authority';

/**
 * Is this report blocked, read from its STORED `validation_flags`?
 *
 * The delivery gate cannot re-run the audit — it holds a row, not a snapshot
 * and a draft — so it reads the verdict the generator recorded. Same rule,
 * one spelling of the flag type, so a gate and a writer cannot drift.
 *
 * Unreadable or absent flags are NOT a block: this refuses a report that
 * demonstrably asserts what it does not hold, and every report generated
 * before this existed has no such flag. Failing open here is deliberate —
 * failing closed would withhold 1,190 stored reports on no evidence.
 */
export function governedAuthorityBlockFromFlags(flags: unknown): {
  blocked: boolean;
  categories: string[];
} {
  if (!Array.isArray(flags)) return { blocked: false, categories: [] };
  const categories: string[] = [];
  for (const flag of flags) {
    if (typeof flag !== 'object' || flag === null) continue;
    const row = flag as Record<string, unknown>;
    if (row.type !== GOVERNED_AUTHORITY_FLAG_TYPE) continue;
    const value = typeof row.value === 'object' && row.value !== null
      ? row.value as Record<string, unknown>
      : {};
    if (value.blocking !== true) continue;
    const category = typeof value.category === 'string' ? value.category : 'unknown';
    if (!categories.includes(category)) categories.push(category);
  }
  return { blocked: categories.length > 0, categories };
}

/** The shape `validation_flags` already carries, so these sit beside the rest. */
export function governedFaultToFlag(fault: GovernedClaimFault): {
  type: string;
  severity: string;
  field: string;
  message: string;
  value: Record<string, unknown>;
} {
  return {
    type: GOVERNED_AUTHORITY_FLAG_TYPE,
    // `critical`, and blocking with it. `high` is the band `market_claim` uses
    // for a fact that is real but described wrongly; this band is for a fact
    // the report does not have at all.
    severity: 'critical',
    field: `governed.${fault.category}`,
    message: fault.message,
    value: {
      kind: fault.kind,
      category: fault.category,
      topic: fault.topic,
      excerpt: fault.excerpt,
      blocking: true,
      readiness: 'blocked',
      version: GOVERNED_NARRATIVE_AUTHORITY_VERSION,
    },
  };
}
