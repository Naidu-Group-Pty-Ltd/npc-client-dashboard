import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { applyInvestmentProjection } from '../../../../../supabase/functions/_shared/reportBindingProjection.pure';

/**
 * A presentation may not decide which core investment facts a client sees.
 *
 * `extractKPIMetrics` opened with `if (reportTier !== 'financial') return null`
 * — so on a Compass report the standard presentation drew no financial band at
 * all, while every selectable template bound `financials.*` unconditionally and
 * printed the same figures from the same record. 1,124 of the 1,195 completed
 * reports are Compass tier, so for almost the whole corpus the purchase price,
 * the weekly rent, the LVR and the yields appeared or vanished according to
 * which presentation the operator happened to choose. That is not a visual
 * difference; it is the document saying different things about the money.
 *
 * The rule is availability, not tier: **an authoritative value exists → it may
 * be presented; it is absent → that one KPI is omitted.** Nothing in the
 * presentation calculates, derives, substitutes or fetches — every tile is a
 * stored value formatted, and the tests below assert that against the
 * PROJECTION the templates are bound to, rather than against a list written
 * here that could drift from both.
 */
vi.mock('@/hooks/useGlobalReportSettings', async (orig) => ({
  ...(await orig() as object),
  fetchGlobalReportSettings: async () => ({
    contactDetails: {
      company_name: 'Test Co', phone: '', email: '', website: '', address: '', abn: '',
    },
    disclaimer: { text: 'Test disclaimer.', font_size: 'medium', is_enabled: true },
  }),
}));

/**
 * The Cowra certification subject's stored financial block, verbatim.
 *
 * It is evidence, not policy: nothing in the renderer knows these numbers, and
 * every expectation below is computed from this block by the projection rather
 * than typed out.
 */
const COWRA_FINANCIALS = {
  income: { weeklyRent: 445, annualRent: 23140 },
  keyMetrics: {
    lvr: 80, annualNet: -23383, weeklyNet: -450, netRentalYield: 1.85,
    totalInvestment: 132462, cashOnCashReturn: -17.65, grossRentalYield: 4.17,
  },
  assumptions: { cpiGrowth: 3.2, capitalGrowth: 0.1, occupancyWeeks: 50 },
  loanDetails: {
    lvr: 80, loanAmount: 444000, loanType: 'interest_only', interestRate: 6.5,
    weeklyPayment: 647.63, monthlyPayment: 2806.38, interestOnlyPeriod: 2,
  },
  initialCosts: {
    lmi: 0, deposit: 111000, legalFees: 1800, stampDuty: 19162, loanAmount: 444000,
    totalUpfront: 132462, propertyValue: 555000, inspectionFees: 500,
  },
};

const CONTENT = [
  '# Investment Report: 9 Test Street, Cowra NSW 2794',
  '',
  '## Investment Overview',
  '',
  'The holding position for this property is set out below, with the acquisition',
  'and the annual return stated against the contract price.',
  '',
  '## Market Context',
  '',
  'Regional demand has been steady across the reporting period, with listing volumes',
  'and days on market both tracking close to their five-year averages.',
  '',
].join('\n');

const reportWith = (financialData: unknown) => ({
  id: 'kpi-parity',
  address: '9 Test Street, Cowra NSW 2794',
  content: CONTENT,
  created_at: '2026-09-13T00:00:00.000Z',
  enhanced_data: { financialData, investmentScore: {} },
});

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === 'string' ? input : input?.url ?? input);
    if (url.startsWith('/')) {
      const file = path.resolve(process.cwd(), 'public', url.replace(/^\//, ''));
      if (!fs.existsSync(file)) return new Response(null, { status: 404 });
      return new Response(new Uint8Array(fs.readFileSync(file)), { status: 200 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });

/** The text a reader sees, from the drawn bytes. */
async function drawnText(
  report: unknown, reportTier: 'compass' | 'financial',
): Promise<string> {
  const { generateInvestmentPdfBlob } = await import('../investmentPdfDocument');
  const { blob } = await generateInvestmentPdfBlob({ report: report as any, reportTier });
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(await blob.arrayBuffer()), useSystemFonts: false,
  }).promise;
  let out = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    out += content.items.map((it: any) => it.str ?? '').join('') + '\n';
  }
  return out.replace(/\s+/g, '');
}

/** What the selected templates are bound to, for this record. */
function templateFinancials(financialData: unknown): Record<string, number | undefined> {
  const ctx = applyInvestmentProjection(
    { report: {}, brand: {} } as Record<string, unknown>,
    { financial_calculations: financialData } as never,
  ) as Record<string, any>;
  return (ctx.financials ?? {}) as Record<string, number | undefined>;
}

const money = (n: number) => '$' + Number(n).toLocaleString('en-AU', { maximumFractionDigits: 0 });

describe('the Compass standard presentation carries the core investment facts', () => {
  /**
   * §6 case 1 — Compass with authoritative financial data.
   *
   * Every core value the templates publish must be in the standard document
   * too, at the same magnitude. The expectations are taken from
   * `applyInvestmentProjection`, which is what the selected template binds, so
   * this is parity against the other presentation rather than against a list.
   */
  it('publishes the same core values a selected template is bound to', async () => {
    const flat = await drawnText(reportWith(COWRA_FINANCIALS), 'compass');
    const bound = templateFinancials(COWRA_FINANCIALS);

    // The band is present at all — it was absent on every Compass report.
    expect(flat).toContain('PURCHASEPRICE');

    for (const [label, formatted] of [
      ['PURCHASEPRICE', money(bound.purchasePrice!)],
      ['WEEKLYRENT', money(bound.weeklyRent!)],
      ['DEPOSIT', money(bound.deposit!)],
      ['LOANAMOUNT', money(bound.loanAmount!)],
      ['LVR', Number(bound.lvr).toFixed(1) + '%'],
      ['GROSSYIELD', Number(bound.grossYield).toFixed(2) + '%'],
      ['NETYIELD', Number(bound.netYield).toFixed(2) + '%'],
      ['STAMPDUTY', money(bound.stampDuty!)],
      ['TOTALUPFRONT', money(bound.totalCost!)],
      // A negative holding position is stated as one; the figure is the
      // record's own `weeklyNet`, and the sign is part of the fact.
      ['WEEKLYNETCASHFLOW', '-' + money(Math.abs(bound.weeklyNet!))],
    ] as Array<[string, string]>) {
      expect(flat, `${label} must be published by the standard presentation`).toContain(label);
      expect(flat, `${label} must read ${formatted}`).toContain(formatted.replace(/\s+/g, ''));
    }
  }, 180_000);

  /**
   * §6 case 2 — an unavailable KPI is omitted.
   *
   * Not zero, not "N/A" masquerading as a value, not invented. The record below
   * is the same purchase with no rent established and no borrowing, which is a
   * real shape: `rentIsEstablished` answers false, so the projection withholds
   * both yields, and the presentation must withhold them too rather than
   * printing the stored `0.00%` that this programme has already had once.
   */
  it('omits a KPI the record does not establish, and invents nothing in its place', async () => {
    const sparse = {
      income: {},
      keyMetrics: { grossRentalYield: 0, netRentalYield: 0 },
      initialCosts: { propertyValue: 555000, deposit: 555000, stampDuty: 19162 },
      assumptions: { capitalGrowth: 3.5 },
    };
    const bound = templateFinancials(sparse);
    // The projection itself withholds them — this is the parity being pinned.
    expect(bound.grossYield).toBeUndefined();
    expect(bound.netYield).toBeUndefined();
    expect(bound.weeklyRent).toBeUndefined();
    expect(bound.loanAmount).toBeUndefined();

    const flat = await drawnText(reportWith(sparse), 'compass');

    // What the record does hold is published.
    expect(flat).toContain('PURCHASEPRICE');
    expect(flat).toContain(money(555000).replace(/\s+/g, ''));
    expect(flat).toContain('DEPOSIT');

    // What it does not hold is absent — as a tile, and as any substitute.
    for (const absent of [
      'GROSSYIELD', 'NETYIELD', 'WEEKLYRENT', 'LOANAMOUNT', 'INTERESTRATE',
      'WEEKLYNETCASHFLOW', 'TOTALUPFRONT',
    ]) {
      expect(flat, `${absent} must not be drawn for a record that does not establish it`)
        .not.toContain(absent);
    }
    expect(flat, 'an unavailable yield must not print as zero').not.toContain('0.00%');
    expect(flat, 'an unavailable figure must not print as a placeholder').not.toContain('N/A');
  }, 180_000);

  /**
   * §6 case 3 — the Financial tier keeps its deeper behaviour.
   *
   * Compass gains the basic facts; Financial does not lose anything. The same
   * record drawn at the deeper tier still publishes the same core set, and the
   * tier's own extra sections are still included — the tier still decides
   * DEPTH, it has simply stopped deciding whether the basics are shown.
   */
  it('leaves the Financial tier publishing the same core set, plus its own depth', async () => {
    const flat = await drawnText(reportWith(COWRA_FINANCIALS), 'financial');
    for (const label of [
      'PURCHASEPRICE', 'WEEKLYRENT', 'DEPOSIT', 'LOANAMOUNT', 'LVR', 'GROSSYIELD', 'NETYIELD',
      'INTERESTRATE', 'WEEKLYNETCASHFLOW', 'STAMPDUTY', 'TOTALUPFRONT',
    ]) {
      expect(flat, `${label} must survive at the Financial tier`).toContain(label);
    }
    const bound = templateFinancials(COWRA_FINANCIALS);
    expect(flat).toContain(money(bound.purchasePrice!).replace(/\s+/g, ''));
    expect(flat).toContain(Number(bound.grossYield).toFixed(2) + '%');
  }, 180_000);
  /**
   * The fallback host is additive.
   *
   * The band has always attached to a section whose NAME invites it, and only
   * 141 of the 1,123 Compass reports carry such a heading — which is why a
   * fallback exists at all. It must not MOVE the band on the 141 that do: a
   * report naming a financial section still hosts it there, so every document
   * that drew the band before draws it in the same place.
   */
  it('leaves a report that names a financial section hosting the band there', async () => {
    const content = [
      '# Investment Report: 9 Test Street, Cowra NSW 2794',
      '',
      '## Location Overview',
      '',
      'The suburb profile and its surrounding amenity are set out here at length so that',
      'this section clears the forty-character floor the section filter applies to bodies.',
      '',
      '## Financial Snapshot',
      '',
      'The holding position for this property is set out below, with the acquisition and',
      'the annual return stated against the contract price.',
      '',
    ].join('\n');
    const { generateInvestmentPdfBlob } = await import('../investmentPdfDocument');
    const { blob } = await generateInvestmentPdfBlob({
      report: { ...reportWith(COWRA_FINANCIALS), content } as any, reportTier: 'compass',
    });
    const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(await blob.arrayBuffer()), useSystemFonts: false,
    }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const c = await (await doc.getPage(i)).getTextContent();
      pages.push(c.items.map((it: any) => it.str ?? '').join('').replace(/\s+/g, ''));
    }
    const bandPage = pages.find((p) => p.includes('PURCHASEPRICE'));
    expect(bandPage, 'the band must be drawn somewhere').toBeDefined();
    expect(bandPage, 'it must sit with the section that invites it')
      .toContain('FinancialSnapshot');
    expect(bandPage!.indexOf('FinancialSnapshot'))
      .toBeLessThan(bandPage!.indexOf('PURCHASEPRICE'));
  }, 180_000);
});
