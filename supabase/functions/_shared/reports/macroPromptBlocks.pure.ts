/**
 * Compose the Current Economic Context block from the measured macro
 * reading — replacing a template whose every cell had a hardcoded fallback
 * (`|| '4.10'` on the cash rate, `|| '2.4'` on CPI, `|| '4.1'` on a
 * national unemployment rate) under a heading that read "VERIFIED ECONOMIC
 * DATA (use these exact figures)". When the service refused honestly, the
 * fallbacks printed a year-stale rate as verified.
 *
 * Rules:
 *  - a row renders only where a figure was measured, and carries the
 *    figure's own reference period and the table it came from (law 2: a
 *    labelled row promises a figure — absent means omitted);
 *  - GDP, unemployment and participation are NOT in the RBA statistical
 *    tables this reading is built from, so no such row exists and the
 *    instruction forbids inventing one;
 *  - the cash-rate figure is a monthly average and is never presented as a
 *    board decision or dated to one;
 *  - with nothing measured, the block is one honest line plus the
 *    no-invention instruction.
 */

interface Numericish { [key: string]: unknown }

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;

export interface MacroPromptInput {
  economics?: Numericish | null;
}

/** "4.35% (monthly average, August 2026)" — a figure with its period. */
function figureCell(fig: Numericish | null | undefined, prefixNote?: string): string | null {
  const value = num(fig?.['value']);
  const label = str(fig?.['periodLabel']);
  if (value === null || !label) return null;
  return `${value}% (${prefixNote ? `${prefixNote}, ` : ''}${label})`;
}

function sourceCell(source: string | null, publicationDate: string | null): string {
  if (!source) return '';
  return publicationDate ? `${source}, published ${publicationDate}` : source;
}

export function macroEconomicBlock(input: MacroPromptInput): string {
  const e = input.economics;
  const rows: string[] = [];

  const cash = e?.['cashRate'] as Numericish | null | undefined;
  const cashCell = figureCell(cash?.['current'] as Numericish, 'monthly average');
  const cashSource = sourceCell(str(cash?.['source']), str(cash?.['publicationDate']));
  if (cashCell) rows.push(`| RBA cash rate target | ${cashCell} | ${cashSource} |`);

  const infl = e?.['inflation'] as Numericish | null | undefined;
  const inflSource = sourceCell(str(infl?.['source']), str(infl?.['publicationDate']));
  const yearEnded = figureCell(infl?.['yearEnded'] as Numericish);
  if (yearEnded) rows.push(`| Inflation — headline CPI, year-ended | ${yearEnded} | ${inflSource} |`);
  const trimmed = figureCell(infl?.['trimmedMeanYearEnded'] as Numericish);
  if (trimmed) rows.push(`| Inflation — trimmed mean, year-ended | ${trimmed} | ${inflSource} |`);
  const quarterlyInfl = figureCell(infl?.['quarterly'] as Numericish);
  if (quarterlyInfl) rows.push(`| Inflation — quarterly (seasonally adjusted) | ${quarterlyInfl} | ${inflSource} |`);
  if (yearEnded || trimmed) {
    const band = str(infl?.['targetBand']);
    if (band) rows.push(`| RBA inflation target | ${band} band | RBA's published medium-term target |`);
  }

  const lend = e?.['lendingRates'] as Numericish | null | undefined;
  const lendSource = sourceCell(str(lend?.['source']), str(lend?.['publicationDate']));
  const oo = lend?.['ownerOccupier'] as Numericish | null | undefined;
  const inv = lend?.['investor'] as Numericish | null | undefined;
  const ooStd = figureCell(oo?.['standardVariable'] as Numericish);
  if (ooStd) rows.push(`| Standard variable housing rate (owner-occupier, banks) | ${ooStd} | ${lendSource} |`);
  const ooDisc = figureCell(oo?.['discountedVariable'] as Numericish);
  if (ooDisc) rows.push(`| Discounted variable housing rate (owner-occupier, banks) | ${ooDisc} | ${lendSource} |`);
  const invStd = figureCell(inv?.['standardVariable'] as Numericish);
  if (invStd) rows.push(`| Standard variable housing rate (investor, banks) | ${invStd} | ${lendSource} |`);
  const invFixed = figureCell(inv?.['threeYearFixed'] as Numericish);
  if (invFixed) rows.push(`| 3-year fixed housing rate (investor, banks) | ${invFixed} | ${lendSource} |`);

  if (rows.length === 0) {
    return 'No measured macro-economic reading is available for this report. State that in one sentence; ' +
      'do NOT print an economic indicators table, and do NOT state a cash rate, inflation figure, GDP growth, ' +
      'unemployment rate or any other macro figure from memory.';
  }

  return [
    `**Measured economic indicators (each with its own reference period):**\n\n| Indicator | Value | Source |\n|---|---|---|\n${rows.join('\n')}`,
    'Write 2–3 paragraphs in plain English explaining how the cash rate, inflation and housing lending rates above ' +
    'affect mortgage costs, borrowing capacity and property demand, connecting them to this property’s local market. ' +
    'Use only the figures in the table, with their stated periods. Do NOT state GDP growth, unemployment, participation, ' +
    'consumer confidence or any other macro figure — none is measured here. Do NOT present the cash rate month as a ' +
    'board decision date (the figure is a monthly average), and do NOT attribute any projection to the RBA or Treasury. ' +
    'Do NOT put a "What This Means" heading or any other commentary label above the paragraphs.',
  ].join('\n\n');
}
