/**
 * BUILDER STOCK — A CELL CAN SAY "Brochure" AND MEAN A URL.
 *
 * A stock list kept in a spreadsheet carries its documents as HYPERLINKS: the
 * cell displays a label and the address lives underneath it. Every CSV export,
 * Google's own included, writes the label and throws the target away. Measured
 * on a real builder list: five link-bearing columns, 119 rows, and ZERO
 * plain-text URLs anywhere in the tab. Read as CSV alone, not one property has
 * a builder source for stage 1 to follow.
 *
 * XLSX keeps them — proved by round-trip, `cell.l.Target` beside `cell.v`,
 * with a labelled `N/A` cell carrying none — so the workbook is asked for the
 * same tab's links.
 *
 * TWO THINGS THIS MAY NEVER DO. It may not move membership: the requested gid's
 * CSV stays the whole of which properties exist, and a workbook export is the
 * WHOLE document, so letting it near membership is how another tab's rows
 * become a builder's stock. And it may not guess which worksheet is the tab —
 * position is not identity, the workbook records no gid, and lending a
 * near-identical tab's links to this one is the failure the matching exists to
 * prevent.
 *
 * Invented workbooks throughout. No spreadsheet id, gid, tab name or property
 * from any deployment appears here or in the modules under test.
 */
import { describe, expect, it } from 'vitest';

import {
  LINK_COLUMN_SUFFIX, MATCH_FLOOR, matchWorksheet, mergeHyperlinkColumns,
  normaliseCell, sourcesFullyEnumerable, worksheetScore,
  type WorkbookSheet,
} from '../../../supabase/functions/_shared/builderStock/sheetHyperlinks.pure';
import { parseDelimited } from '../../../supabase/functions/_shared/builderStock/table.pure';

/** The tab the gid named, as its CSV export renders it. */
const SELECTED_CSV = parseDelimited([
  'Lot,Estate,Design,Build Size,Brochure,Masterplan',
  '90,Sample Rise,Pico 8,140,Brochure,Masterplan',
  '90,Sample Rise,Enzo 10,154,Brochure,N/A',
  '91,Other Reach,Pico 8,140,Brochure,Masterplan',
].join('\n'));

const sheet = (
  name: string,
  values: (string | null)[][],
  links: (string | null)[][] = [],
): WorkbookSheet => ({
  name,
  values,
  links: values.map((_row, r) => links[r] ?? []),
});

const SELECTED_VALUES = SELECTED_CSV.map((row) => [...row]);

/** The same tab inside the workbook, carrying its links. */
const SELECTED_SHEET = sheet('anything at all', SELECTED_VALUES, [
  [],
  [null, null, null, null, 'https://drive.google.com/file/d/ROW1/view',
    'https://drive.google.com/drive/folders/ROW1F'],
  [null, null, null, null, 'https://drive.google.com/file/d/ROW2/view', null],
  [null, null, null, null, 'https://drive.google.com/file/d/ROW3/view',
    'https://drive.google.com/drive/folders/ROW3F'],
]);

/** A different tab in the same workbook. Its links may never travel. */
const OTHER_SHEET = sheet('another tab', [
  ['Heading'],
  ['Marketing pack'],
], [[], ['https://drive.google.com/drive/folders/SOMEWHERE-ELSE']]);

describe('membership never moves', () => {
  it('the merge adds columns and not one row', () => {
    const merged = mergeHyperlinkColumns(SELECTED_CSV, SELECTED_SHEET);
    expect(merged.matrix).toHaveLength(SELECTED_CSV.length);
    // Every original cell survives, in place.
    for (let r = 0; r < SELECTED_CSV.length; r += 1) {
      expect(merged.matrix[r].slice(0, SELECTED_CSV[r].length)).toEqual(SELECTED_CSV[r]);
    }
  });

  it('the order of the rows is the order the CSV had', () => {
    const merged = mergeHyperlinkColumns(SELECTED_CSV, SELECTED_SHEET);
    expect(merged.matrix.slice(1).map((row) => row[0]))
      .toEqual(SELECTED_CSV.slice(1).map((row) => row[0]));
  });

  it('a workbook tab with extra rows cannot add a property', () => {
    // The merge walks the CSV, never the worksheet, so rows the worksheet has
    // and the selected tab does not are unreachable by construction.
    const longer = sheet('anything', [...SELECTED_VALUES, ['99', 'Ghost Estate', '', '', '', '']],
      [[], [], [], [], [null, null, null, null, 'https://drive.google.com/file/d/GHOST/view']]);
    const merged = mergeHyperlinkColumns(SELECTED_CSV, longer);
    expect(merged.matrix).toHaveLength(SELECTED_CSV.length);
    expect(JSON.stringify(merged.matrix)).not.toContain('GHOST');
    expect(JSON.stringify(merged.matrix)).not.toContain('Ghost Estate');
  });

  it('a sheet of plain labels changes nothing at all', () => {
    const noLinks = sheet('anything', SELECTED_VALUES);
    const merged = mergeHyperlinkColumns(SELECTED_CSV, noLinks);
    expect(merged.columnsAdded).toEqual([]);
    expect(merged.linksResolved).toBe(0);
    expect(merged.matrix).toEqual(SELECTED_CSV);
  });
});

describe('the worksheet is identified by content, never by position', () => {
  it('matches the tab wherever it sits in the workbook', () => {
    const match = matchWorksheet(SELECTED_CSV, [OTHER_SHEET, SELECTED_SHEET]);
    expect(match.ok).toBe(true);
    if (match.ok) {
      expect(match.sheet.name).toBe(SELECTED_SHEET.name);
      expect(match.score).toBeGreaterThanOrEqual(MATCH_FLOOR);
    }
  });

  it('never takes the first worksheet just because it is first', () => {
    const match = matchWorksheet(SELECTED_CSV, [OTHER_SHEET]);
    expect(match).toMatchObject({ ok: false, reason: 'no_match' });
  });

  it('refuses when two worksheets are equally like the tab', () => {
    /*
     * A duplicated tab — a copy kept for last month's prices — scores the same
     * as the real one. Taking either would attach a stranger's links to this
     * builder's properties, so neither may lend them.
     */
    const twin = sheet('a copy', SELECTED_VALUES, [
      [], [null, null, null, null, 'https://drive.google.com/file/d/WRONG/view'],
    ]);
    const match = matchWorksheet(SELECTED_CSV, [SELECTED_SHEET, twin]);
    expect(match).toMatchObject({ ok: false, reason: 'ambiguous' });
  });

  it('a near-miss is not a match', () => {
    const almost = sheet('almost', SELECTED_VALUES.map((row, r) =>
      (r === 0 ? row : ['different', ...row.slice(1)])));
    expect(matchWorksheet(SELECTED_CSV, [almost]).ok).toBe(false);
  });

  it('an empty workbook resolves to nothing rather than to something', () => {
    expect(matchWorksheet(SELECTED_CSV, [])).toMatchObject({ ok: false, reason: 'no_match' });
  });

  it('rendering differences are not a different worksheet', () => {
    // A CSV writes 640000 where the grid shows $640,000. Same tab.
    expect(normaliseCell('$640,000')).toBe(normaliseCell('640000'));
    expect(normaliseCell('  Sample   Rise ')).toBe('sample rise');
    // But nothing that could tell two real tabs apart is normalised away.
    expect(normaliseCell('Pico 8')).not.toBe(normaliseCell('Enzo 10'));
  });

  it('empty cells measure nothing, so a blank tab cannot score', () => {
    const blank = sheet('blank', SELECTED_VALUES.map((row) => row.map(() => '')));
    expect(worksheetScore(SELECTED_CSV, blank)).toBe(0);
  });
});

describe('a link belongs to its own row and to no other', () => {
  const merged = mergeHyperlinkColumns(SELECTED_CSV, SELECTED_SHEET);
  const header = merged.matrix[0];
  const col = (name: string) => header.indexOf(name);

  it('names the column it came from', () => {
    expect(merged.columnsAdded).toEqual([
      `Brochure${LINK_COLUMN_SUFFIX}`, `Masterplan${LINK_COLUMN_SUFFIX}`,
    ]);
  });

  it('each row carries its OWN target, and the displayed label survives', () => {
    expect(merged.matrix[1][col('Brochure')]).toBe('Brochure');
    expect(merged.matrix[1][col(`Brochure${LINK_COLUMN_SUFFIX}`)])
      .toBe('https://drive.google.com/file/d/ROW1/view');
    expect(merged.matrix[2][col(`Brochure${LINK_COLUMN_SUFFIX}`)])
      .toBe('https://drive.google.com/file/d/ROW2/view');
    expect(merged.matrix[3][col(`Brochure${LINK_COLUMN_SUFFIX}`)])
      .toBe('https://drive.google.com/file/d/ROW3/view');
  });

  it('a labelled cell with no link stays empty rather than borrowing one', () => {
    // Row 2's Masterplan reads `N/A` and has no target. The row above it does.
    expect(merged.matrix[2][col('Masterplan')]).toBe('N/A');
    expect(merged.matrix[2][col(`Masterplan${LINK_COLUMN_SUFFIX}`)]).toBe('');
  });

  it('the same lot at two configurations keeps two separate chains', () => {
    /*
     * Rows 1 and 2 are one lot, two products — 140 m² and 154 m². They differ
     * in design and build size and they carry different documents. Nothing
     * here looks a link up by lot, address or anything else two rows share:
     * a link is read at THIS row and written at THIS row, which is what makes
     * them safe by construction rather than by a rule.
     */
    expect(merged.matrix[1][col('Lot')]).toBe(merged.matrix[2][col('Lot')]);
    expect(merged.matrix[1][col('Build Size')]).not.toBe(merged.matrix[2][col('Build Size')]);
    expect(merged.matrix[1][col(`Brochure${LINK_COLUMN_SUFFIX}`)])
      .not.toBe(merged.matrix[2][col(`Brochure${LINK_COLUMN_SUFFIX}`)]);
  });

  it('another worksheet\'s links are nowhere in the result', () => {
    expect(JSON.stringify(merged.matrix)).not.toContain('SOMEWHERE-ELSE');
  });
});

describe('a label nobody resolved is not an absent source', () => {
  it('only a reading of the SPREADSHEET counts as having looked', () => {
    /*
     * The distinction that matters. A link-bearing cell whose target was never
     * resolved is a source nobody opened — recording it as "this property has
     * no builder imagery" is how a package one unread hyperlink away becomes a
     * blank card.
     */
    expect(sourcesFullyEnumerable('resolved')).toBe(true);
    expect(sourcesFullyEnumerable('none_present')).toBe(true);

    for (const unavailable of [
      'unavailable_source_sharing',
      'unavailable_no_worksheet_match',
      'unavailable_ambiguous_worksheet',
    ] as const) {
      expect(sourcesFullyEnumerable(unavailable)).toBe(false);
    }
  });
});

describe('the resolved links enter the pipeline that already exists', () => {
  const source = () => readSource('supabase/functions/_shared/builderStock/fetchSource.ts');

  it('the gid CSV is still the only thing that decides membership', () => {
    // The workbook is fetched AFTER the tab is resolved and proven, and its
    // only use is `mergeHyperlinkColumns`, which walks the CSV.
    const fn = source();
    expect(fn.indexOf('const resolved = resolveSheetsPayload'))
      .toBeLessThan(fn.indexOf('const enriched = await enrichWithHyperlinks'));
    expect(fn).toContain('mergeHyperlinkColumns(matrix, match.sheet)');
  });

  it('the workbook export carries no gid, which is why the tab is matched', () => {
    const fn = source().slice(source().indexOf('async function enrichWithHyperlinks'));
    expect(fn).toContain('export?format=xlsx');
    expect(fn).toContain('matchWorksheet(matrix, sheets)');
    expect(fn).not.toContain('SheetNames[0]');
  });

  it('every refusal is an availability reading, never a failed import', () => {
    const fn = source().slice(source().indexOf('async function enrichWithHyperlinks'));
    for (const reading of [
      "'unavailable_source_sharing'",
      "'unavailable_ambiguous_worksheet'",
      "'unavailable_no_worksheet_match'",
      "'none_present'",
      "'resolved'",
    ]) {
      expect(fn).toContain(reading);
    }
    // The CSV is returned unchanged on every one of them.
    expect(fn).toContain('return { csv, availability:');
  });

  it('it goes back out as CSV, so no second importer is created', () => {
    expect(source()).toContain('matrixToCsv(merged.matrix)');
    expect(source()).toContain("declaredContentType: 'text/csv'");
  });

  it('the spreadsheet reader is the one the runtime already loads', () => {
    expect(source()).toContain("import('https://esm.sh/xlsx@0.18.5')");
    const extract = readSource('supabase/functions/_shared/builderStock/extract.ts');
    expect(extract).toContain("import('https://esm.sh/xlsx@0.18.5')");
  });

  it('no spreadsheet id, gid, tab name or property is written into the code', () => {
    const strip = (text: string) => text
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const relative of [
      'supabase/functions/_shared/builderStock/sheetHyperlinks.pure.ts',
      'supabase/functions/_shared/builderStock/fetchSource.ts',
    ]) {
      const code = strip(readSource(relative));
      for (const [, literal] of code.matchAll(/'([^']*)'/g)) {
        // A Google spreadsheet id is a long opaque token: mixed case AND
        // digits. Our own snake_case reason codes are neither, which is why
        // the test asks for both rather than for length alone.
        const idShaped = /^[A-Za-z0-9_-]{25,}$/.test(literal)
          && /[A-Z]/.test(literal) && /\d/.test(literal);
        expect(idShaped, `id-shaped literal ${literal}`).toBe(false);
      }
      for (const forbidden of ['Brochure', 'Masterplan', 'MASTER STOCKLIST', 'Sheet1', 'gid=0']) {
        expect(code).not.toContain(forbidden);
      }
    }
  });
});

function readSource(relative: string): string {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { resolve } = require('node:path') as typeof import('node:path');
  return readFileSync(resolve(__dirname, '../../../', relative), 'utf8');
}
