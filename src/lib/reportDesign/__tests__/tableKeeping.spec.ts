/**
 * How a memo keeps its tables (`tableKeeping.pure.ts`).
 *
 * Written for the Intelligence Hub's memo and shared with the Portfolio
 * Performance Review (PORTFOLIO.md §10). The Hub's own cases stay in
 * `reportQa/__tests__/memoPresentation.spec.ts`, through its re-export, so the
 * Hub's behaviour is pinned where the Hub is; these pin the two options the
 * Portfolio asked for and that the Hub's defaults are exactly what they were.
 */
import { describe, expect, it } from 'vitest';
import {
  estimatedTableLines,
  groupTableRows,
  keptTable,
  KEEP_WHOLE_TABLE_LINES,
} from '../tableKeeping.pure';
import {
  estimatedTableLines as hubEstimatedTableLines,
  groupTableRows as hubGroupTableRows,
} from '../../reports/reportQa/render.pure';
import { renderDataTable, type TableColumn, type TableRow } from '../primitives.pure';

const cols: TableColumn[] = [
  { key: 'rank', label: '#', align: 'left' },
  { key: 'address', label: 'Property', align: 'left' },
  { key: 'rating', label: 'Analysis', align: 'left' },
  { key: 'review', label: 'Review', align: 'left' },
  { key: 'score', label: 'Review score', align: 'right' },
];
const ranking: TableRow[] = [1, 2, 3, 4].map((n) => ({
  rank: String(n),
  address: `${n} Cahill Street, East Innisfail QLD 4860`,
  rating: 'Good',
  review: 'Average',
  score: '66 / 100',
}));

const rowHtml = (n: number) => `<tr><th scope="row">r${n}</th><td>v${n}</td></tr>`;
const tableHtml = (n: number) => '<div class="table-block"><table class="data"><thead><tr><th scope="col">a</th>'
  + `<th scope="col">b</th></tr></thead><tbody>${Array.from({ length: n }, (_, i) => rowHtml(i + 1)).join('')}</tbody></table></div>`;

/** Each visible row with its position in its own group, as `nth-child` counts. */
const bands = (html: string) => [...html.matchAll(/<tbody[^>]*>([\s\S]*?)<\/tbody>/g)].flatMap((g) =>
  (g[1].match(/<tr[\s\S]*?<\/tr>/g) ?? [])
    .map((tr, i) => ({ tr, child: i + 1 }))
    .filter(({ tr }) => !tr.includes('class="parity"'))
    .map(({ tr, child }) => ({ row: Number(/r(\d+)</.exec(tr)?.[1]), odd: child % 2 === 1 })));

describe('the Hub’s defaults are what they were', () => {
  it('is the implementation the Hub re-exports, not a copy of it', () => {
    expect(hubEstimatedTableLines).toBe(estimatedTableLines);
    expect(hubGroupTableRows).toBe(groupTableRows);
  });

  it('shares the measure equally between columns unless asked otherwise', () => {
    expect(estimatedTableLines({ cols, rows: ranking })).toBe(estimatedTableLines({ cols, rows: ranking }, { widths: 'equal' }));
  });
});

describe('a table sized by its content is estimated that way', () => {
  it('sets a rank, an address and three short verdicts on one line a row', () => {
    // The equal split charged each forty-character address three lines of a
    // twenty-character column, and set four rows apart as thirteen lines.
    expect(estimatedTableLines({ cols, rows: ranking })).toBeGreaterThan(KEEP_WHOLE_TABLE_LINES);
    expect(estimatedTableLines({ cols, rows: ranking }, { widths: 'content' })).toBe(5);
  });

  it('still wraps a column whose cells outrun their share of the measure', () => {
    const wordy: TableRow[] = [{
      rank: '1',
      address: '17 Cahill Street, East Innisfail QLD 4860',
      rating: 'A sentence long enough to need more than one line in any reasonable share of the measure.',
      review: 'Good',
      score: '78 / 100',
    }];
    expect(estimatedTableLines({ cols, rows: wordy }, { widths: 'content' })).toBeGreaterThan(2);
  });
});

describe('a long table leaves at least three rows at a page foot when asked', () => {
  it('sets each of two lead rows as its own group, because the engine keeps the break after a group', () => {
    const grouped = groupTableRows(tableHtml(9), 2);
    const leads = [...grouped.matchAll(/<tbody class="lead">([\s\S]*?)<\/tbody>/g)].map((m) => m[1]);
    expect(leads).toHaveLength(2);
    expect(leads[0]).toContain('>r1<');
    expect(leads[1]).toContain('>r2<');
    for (const lead of leads) expect(lead.match(/<tr>/g)).toHaveLength(1);
  });

  it.each([5, 6, 7, 9, 12])('keeps every row on the band it had — %i rows, two lead rows', (n) => {
    const read = bands(groupTableRows(tableHtml(n), 2));
    expect(read.map((r) => r.row)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    for (const r of read) expect(r.odd, `row ${r.row}`).toBe(r.row % 2 === 1);
  });

  it('leaves a table too short for its groups exactly as it was', () => {
    expect(groupTableRows(tableHtml(4), 2)).toBe(tableHtml(4));
  });

  it('writes the one-lead markup it always wrote when no count is asked for', () => {
    expect(groupTableRows(tableHtml(7))).toBe(groupTableRows(tableHtml(7), 1));
  });
});

describe('keptTable', () => {
  it('keeps a table of three rows whole whatever its height', () => {
    const three = ranking.slice(0, 3);
    expect(keptTable(renderDataTable(cols, three), { cols, rows: three }))
      .toMatch(/^<div class="table-block keep-together">/);
  });

  it('keeps a short table whole by its estimated height, and groups a tall one', () => {
    const html = renderDataTable(cols, ranking);
    expect(keptTable(html, { cols, rows: ranking }, { widths: 'content' })).toMatch(/^<div class="table-block keep-together">/);
    expect(keptTable(html, { cols, rows: ranking })).toContain('<tbody class="tail">');
  });

  it('returns an empty table as it came', () => {
    expect(keptTable('', { cols, rows: [] })).toBe('');
  });
});
