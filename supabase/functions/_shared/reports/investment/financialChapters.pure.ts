/**
 * The Financial tier's chapters, composed from the recorded calculation.
 *
 * The "Client Investment Feasibility & Financial Performance Report" is a
 * deterministic fork of the Compass — and the Compass tier deliberately
 * carries no financial prose, so the fork's substring routing produced a
 * financial report whose entire narrative held ONE dollar sign while its own
 * row carried a complete `financial_calculations` block: seven key metrics,
 * eleven annual-cost lines, ten loan details, three projection scenarios and
 * a sensitivity grid (measured on row c21ed1fa, 2026-09-04; audit
 * REPORTING_ENGINE_AUDIT_2026_09.md).
 *
 * This module writes those chapters from the record itself. The rules it
 * lives by are the framework's laws (docs/reports/TIER_FRAMEWORK.md):
 *
 *  - every figure is typed from the record — the input is reconciled through
 *    `reconcileStoredFinancials`, the same heal `reportBindingProjection`
 *    applies before the KPI tiles bind, so a chapter here and a tile on the
 *    verdict page cannot disagree about a number;
 *  - a labelled row is a promise that a figure follows it — an absent value
 *    loses its row, a table that loses every row is not drawn, and a chapter
 *    with nothing to say is not emitted. Nothing in this module can write
 *    "N/A";
 *  - chapter headings and ordinals are the split registry's FIN section
 *    titles, so the composed chapters and the routed prose read as one
 *    declared document.
 *
 * Key names below are measured from production rows, not guessed: scenario
 * keys `conservative`/`moderate`/`optimistic`; series rows carry
 * `year`/`propertyValue`/`annualRent`/`cashFlow`/`cumulativeCashFlow`/
 * `equity`/`loanBalance`/`roi`; sensitivity carries `rentChanges`
 * (`minus10Percent`/`plus10Percent`/`plus20Percent`) and
 * `interestRateChanges` (`minus1Percent`/`plus1Percent`/`plus2Percent`).
 */

import { money, num, pct, str } from './figures.pure.ts';
import {
  operatingExpensesFrom,
  reconcileStoredFinancials,
} from './financialEngine.pure.ts';
import { readAnnualRent } from './rentBasis.pure.ts';
import { rentIsEstablished } from './rentalEvidence.pure.ts';
import {
  composeScoreBreakdownSection,
  composeSwotSection,
} from './scoreSections.pure.ts';

export interface ComposedChapter {
  /** 1-based ordinal in the FIN report layout (reportSplitRegistry). */
  ordinal: number;
  /** The FIN section heading, verbatim from the split registry's order. */
  heading: string;
  /** Markdown body including its own `## heading` line. */
  markdown: string;
}

export interface FinancialChapterSource {
  financialCalculations?: unknown;
  investmentScore?: unknown;
}

export interface FinancialChapterOptions {
  /** 'all' renders every stored projection scenario; 'primary' just the base case. */
  scenarios?: 'all' | 'primary';
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const obj = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

/** Two-column table from labelled values; rows with no value are omitted. */
function twoCol(
  headers: [string, string],
  rows: Array<[string, string | undefined]>,
): string[] {
  const present = rows.filter((r): r is [string, string] => r[1] !== undefined);
  if (!present.length) return [];
  return [
    `| ${headers[0]} | ${headers[1]} |`,
    '| --- | --- |',
    ...present.map(([label, value]) => `| ${label} | ${value} |`),
  ];
}

/**
 * A chapter exists only when at least one of its TABLES could be drawn — the
 * lead sentence is furniture, and a heading over a sentence promising tables
 * that never come is the empty-section defect in a new coat.
 */
const chapter = (
  ordinal: number,
  heading: string,
  lead: string,
  tables: string[][],
): ComposedChapter | null => {
  const drawn = tables.filter((b) => b.length > 0);
  if (!drawn.length) return null;
  const markdown = [`## ${heading}`, lead, ...drawn.map((b) => b.join('\n'))].join('\n\n') + '\n';
  return { ordinal, heading, markdown };
};

// ── Chapter 4 · Purchase Costs & Annual Holding Cost Breakdown ──────────────

function purchaseAndHolding(fin: Record<string, unknown>): ComposedChapter | null {
  const initial = obj(fin.initialCosts);
  const costs = obj(fin.annualCosts);

  const acquisition = twoCol(['Acquisition item', 'Amount'], [
    ['Purchase price', money(initial.propertyValue)],
    ['Deposit', money(initial.deposit)],
    ['Stamp duty', money(initial.stampDuty)],
    ['Lenders mortgage insurance', money(initial.lmi)],
    ['Conveyancing & legal', money(initial.legalFees)],
    ['Building & pest inspections', money(initial.inspectionFees)],
    ['**Total upfront**', money(initial.totalUpfront) && `**${money(initial.totalUpfront)}**`],
  ]);

  const managementPct = num(costs.propertyManagementPercent);
  const lineTotal = operatingExpensesFrom(costs);
  const holding = twoCol(['Annual cost', 'Amount'], [
    ['Council rates', money(costs.councilRates)],
    ['Water rates', money(costs.waterRates)],
    ['Strata fees', money(costs.strataFees)],
    ['Landlord insurance', money(costs.landlordInsurance)],
    [
      managementPct !== undefined
        ? `Property management (${pct(managementPct)} of rent)`
        : 'Property management',
      money(costs.propertyManagement),
    ],
    ['Letting fees', money(costs.lettingFees)],
    ['Repairs & maintenance', money(costs.maintenance)],
    ['Land tax', money(costs.landTax)],
    ['**Total annual holding costs**', lineTotal > 0 ? `**${money(lineTotal)}**` : undefined],
  ]);

  return chapter(4, 'Purchase Costs & Annual Holding Cost Breakdown',
    'Acquisition and annual holding costs as recorded for this property.',
    [acquisition, holding]);
}

// ── Chapter 5 · Rental Assessment, Gross Yield & Net Yield ──────────────────

function rentalAndYield(fin: Record<string, unknown>): ComposedChapter | null {
  const income = obj(fin.income);
  const metrics = obj(fin.keyMetrics);
  const assumptions = obj(fin.assumptions);

  const weeklyRent = num(income.weeklyRent);
  // Both annual rents, from the one module the binding projection also asks —
  // so this table and the verdict page's tiles state the same figures under
  // the same names. They used to share a derivation instead of a module, and
  // it was the occupancy-adjusted one published bare as "Annual rent": on
  // `1/27D Mitchell Street` this table read $30,000 two rows above a 5.67%
  // yield that rests on $31,200.
  const rent = readAnnualRent(income, assumptions);

  // A yield is the rent divided by the price. Where the record establishes no
  // rent, the rent rows above suppress themselves and these two must follow —
  // otherwise the section reads "Recorded rental income and the yields it
  // produces" over a table containing yields and no income, which is a return
  // asserted on an income the record does not hold. One rule, asked here and
  // in the two other renderers that print a yield.
  const founded = rentIsEstablished(income);

  const table = twoCol(['Metric', 'Value'], [
    ['Weekly rent', money(weeklyRent)],
    // The contractual rent, which is what the yields two rows below rest on.
    ['Annual rent', money(rent.contractual)],
    // The occupancy assumption, as its own row rather than as a quieter
    // definition of the row above it. `twoCol` drops a row with no value, so a
    // report assuming a full year adds nothing here.
    [rent.occupancyLabel ?? 'Annual rent at assumed occupancy', money(rent.atOccupancy)],
    ['Gross rental yield', founded ? pct(metrics.grossRentalYield) : undefined],
    ['Net rental yield', founded ? pct(metrics.netRentalYield) : undefined],
  ]);

  return chapter(5, 'Rental Assessment, Gross Yield & Net Yield',
    'Recorded rental income and the yields it produces against the purchase price.',
    [table]);
}

// ── Chapter 6 · Loan Structure, Repayments & Cashflow Impact ────────────────

const LOAN_TYPE_LABELS: Readonly<Record<string, string>> = {
  interest_only: 'Interest only',
  principal_and_interest: 'Principal & interest',
  pi: 'Principal & interest',
  io: 'Interest only',
};

function loanStructure(fin: Record<string, unknown>): ComposedChapter | null {
  const loan = obj(fin.loanDetails);
  const monthly = num(loan.monthlyPayment);
  const loanTypeRaw = str(loan.loanType);
  const loanType = loanTypeRaw
    ? (LOAN_TYPE_LABELS[loanTypeRaw.toLowerCase()] ?? loanTypeRaw.replace(/_/g, ' '))
    : undefined;
  const lvr = num(loan.lvr);
  const rateSource = str(loan.rateSource);

  const table = twoCol(['Item', 'Value'], [
    ['Loan amount', money(loan.loanAmount)],
    ['Loan-to-value ratio', lvr !== undefined ? pct(lvr) : undefined],
    ['Loan type', loanType],
    [
      rateSource ? `Interest rate (${rateSource})` : 'Interest rate',
      pct(loan.interestRate),
    ],
    ['Monthly repayment', money(monthly)],
    ['Weekly repayment', money(loan.weeklyPayment)],
    ['Annual repayments', monthly !== undefined ? money(monthly * 12) : undefined],
    ['Total interest over the term', money(loan.totalInterest)],
  ]);

  return chapter(6, 'Loan Structure, Repayments & Cashflow Impact',
    'The recorded lending structure behind the cashflow position.',
    [table]);
}

// ── Chapter 8 · Sensitivity & Scenario Testing ──────────────────────────────

const RATE_LABELS: Readonly<Record<string, string>> = {
  minus2Percent: 'Interest rate −2%',
  minus1Percent: 'Interest rate −1%',
  plus1Percent: 'Interest rate +1%',
  plus2Percent: 'Interest rate +2%',
  plus3Percent: 'Interest rate +3%',
};

const RENT_LABELS: Readonly<Record<string, string>> = {
  minus20Percent: 'Rent −20%',
  minus10Percent: 'Rent −10%',
  plus10Percent: 'Rent +10%',
  plus20Percent: 'Rent +20%',
};

function sensitivity(fin: Record<string, unknown>): ComposedChapter | null {
  const metrics = obj(fin.keyMetrics);
  const sens = obj(fin.sensitivityAnalysis);
  const rates = obj(sens.interestRateChanges);
  const rents = obj(sens.rentChanges);

  const position = twoCol(['Year-1 position', 'Value'], [
    ['Annual net cashflow (pre-tax)', money(metrics.annualNet)],
    ['Weekly net position', money(metrics.weeklyNet)],
    ['Total cash invested', money(metrics.totalInvestment)],
    ['Cash-on-cash return', pct(metrics.cashOnCashReturn)],
  ]);

  const scenarioRows = (
    source: Record<string, unknown>,
    labels: Readonly<Record<string, string>>,
  ): Array<[string, string | undefined]> =>
    Object.entries(labels)
      .filter(([key]) => key in source)
      .map(([key, label]) => [label, money(source[key])]);

  const rateTable = twoCol(['Scenario', 'Annual cashflow'], scenarioRows(rates, RATE_LABELS));
  const rentTable = twoCol(['Scenario', 'Annual cashflow'], scenarioRows(rents, RENT_LABELS));

  return chapter(8, 'Sensitivity & Scenario Testing',
    'How the recorded year-1 position moves as the interest rate and the rent move.',
    [position, rateTable, rentTable]);
}

// ── Chapter 9 · 10-Year Cashflow, Equity & Growth Projection ────────────────

const SCENARIO_LABELS: Readonly<Record<string, string>> = {
  conservative: 'Conservative',
  moderate: 'Base case',
  optimistic: 'Optimistic',
};

const PROJECTION_YEARS = new Set([1, 3, 5, 7, 10]);

function projectionTable(rows: unknown): string[] {
  if (!Array.isArray(rows)) return [];
  const selected = rows.filter((r) => {
    const year = num(obj(r).year);
    return year !== undefined && PROJECTION_YEARS.has(year);
  });
  if (!selected.length) return [];

  // A column is drawn only when every selected row can fill it — a table
  // must stay rectangular and no cell may hold a placeholder.
  const colDefs: Array<{ header: string; value: (r: Record<string, unknown>) => string | undefined }> = [
    { header: 'Year', value: (r) => { const y = num(r.year); return y !== undefined ? String(y) : undefined; } },
    { header: 'Property value', value: (r) => money(r.propertyValue) },
    { header: 'Annual rent', value: (r) => money(r.annualRent) },
    { header: 'Cashflow', value: (r) => money(r.cashFlow) },
    { header: 'Cumulative', value: (r) => money(r.cumulativeCashFlow) },
    { header: 'Equity', value: (r) => money(r.equity) },
    {
      header: 'LVR',
      value: (r) => {
        const balance = num(r.loanBalance);
        const value = num(r.propertyValue);
        if (balance === undefined || value === undefined || value <= 0) return undefined;
        return pct(Math.round((balance / value) * 1000) / 10);
      },
    },
  ];
  const cols = colDefs.filter((c) => selected.every((r) => c.value(obj(r)) !== undefined));
  if (cols.length < 2) return [];

  return [
    `| ${cols.map((c) => c.header).join(' | ')} |`,
    `| ${cols.map(() => '---').join(' | ')} |`,
    ...selected.map((r) => `| ${cols.map((c) => c.value(obj(r))!).join(' | ')} |`),
  ];
}

function projections(
  fin: Record<string, unknown>,
  opts: FinancialChapterOptions,
): ComposedChapter | null {
  const stored = obj(fin.projections);
  const assumptions = obj(fin.assumptions);
  const tax = obj(fin.taxBenefits);

  const order = opts.scenarios === 'primary'
    ? ['moderate']
    : ['conservative', 'moderate', 'optimistic'];
  const blocks: string[][] = [];
  for (const key of order) {
    const table = projectionTable(stored[key]);
    if (!table.length) continue;
    blocks.push([`### ${SCENARIO_LABELS[key] ?? key}`, '', ...table]);
  }
  if (!blocks.length) return null;

  const assumptionTable = twoCol(['Modelling assumption', 'Value'], [
    ['Capital growth', pct(assumptions.capitalGrowth)],
    ['CPI growth', pct(assumptions.cpiGrowth)],
    [
      'Occupancy',
      num(assumptions.occupancyWeeks) !== undefined
        ? `${num(assumptions.occupancyWeeks)} weeks a year`
        : undefined,
    ],
    ['Depreciation allowance', money(tax.depreciation)],
  ]);

  return chapter(9, '10-Year Cashflow, Equity & Growth Projection',
    'The recorded ten-year modelling, shown at years 1, 3, 5, 7 and 10.',
    [...blocks, assumptionTable]);
}

// ── Public entrypoint ───────────────────────────────────────────────────────

/**
 * Compose every FIN chapter the record can support, in FIN ordinal order.
 * Chapters the record cannot fill are absent from the result — the caller
 * renders what comes back and adds nothing.
 */
export function composeFinancialChapters(
  source: FinancialChapterSource,
  opts: FinancialChapterOptions = {},
): ComposedChapter[] {
  const fin = obj(reconcileStoredFinancials(source.financialCalculations).fin);

  const chapters: Array<ComposedChapter | null> = [
    purchaseAndHolding(fin),
    rentalAndYield(fin),
    loanStructure(fin),
    sensitivity(fin),
    projections(fin, opts),
  ];

  const scorecard = composeScoreBreakdownSection(
    source.investmentScore,
    'Financial Investment Scorecard',
  );
  if (scorecard) chapters.push({ ordinal: 12, heading: 'Financial Investment Scorecard', markdown: scorecard });

  const swot = composeSwotSection(
    source.investmentScore,
    'Financial SWOT: Returns, Risk & Holding Capacity',
  );
  if (swot) chapters.push({ ordinal: 14, heading: 'Financial SWOT: Returns, Risk & Holding Capacity', markdown: swot });

  return chapters
    .filter((c): c is ComposedChapter => c !== null)
    .sort((a, b) => a.ordinal - b.ordinal);
}

/**
 * The Snapshot's `Financial Snapshot` — one short table from the same healed
 * record the chapters above are built from.
 *
 * The Snapshot was the only member of the Compass family composing NOTHING:
 * briefing 7 sections from the record, financial 8, snapshot 0 — while four of
 * its nine model-authored sections were numeric. Its guide named six metrics to
 * "choose from" and the recorded-facts block carried five of them; the sixth,
 * `10-Year Projected Value`, had no authority in the block at all, so a model
 * asked for it had to compute one.
 *
 * This is deliberately NOT the briefing's five financial chapters. A Snapshot
 * is five pages and its financial section is one table; composing the long form
 * into it would blow the tier's budget, which is a different defect rather than
 * a fix. The rules are the chapters': every figure typed from the record, a
 * labelled row is a promise, and a yield is withheld where no rent is
 * established.
 */
export function composeFinancialSnapshotSection(
  financialCalculations: unknown,
  heading: string,
): string | null {
  const fin = obj(reconcileStoredFinancials(financialCalculations).fin);
  const income = obj(fin.income);
  const metrics = obj(fin.keyMetrics);
  const initial = obj(fin.initialCosts);
  const projectionRows = obj(fin.projections);

  const rent = readAnnualRent(income, obj(fin.assumptions));
  const founded = rentIsEstablished(income);

  // The tenth year of the base-case series, which the record holds and the
  // facts block never carried — so this is the one figure the guide asked for
  // that a model could only have produced by projecting it itself.
  const moderate = Array.isArray(projectionRows.moderate) ? projectionRows.moderate : [];
  const finalYear = moderate.length ? obj(moderate[moderate.length - 1]) : {};
  const horizonYear = num(finalYear.year);

  const table = twoCol(['Metric', 'Value'], [
    ['Purchase price', money(initial.propertyValue)],
    ['Weekly rent', money(income.weeklyRent)],
    ['Annual rent', money(rent.contractual)],
    ['Gross yield', founded ? pct(metrics.grossRentalYield) : undefined],
    ['Net yield', founded ? pct(metrics.netRentalYield) : undefined],
    ['Annual cash position (pre-tax)', money(metrics.annualNet)],
    [
      horizonYear !== undefined ? `Projected value, year ${horizonYear}` : 'Projected value',
      money(finalYear.propertyValue),
    ],
  ]);

  return table.length ? [`## ${heading}`, '', ...table].join('\n') + '\n' : null;
}
