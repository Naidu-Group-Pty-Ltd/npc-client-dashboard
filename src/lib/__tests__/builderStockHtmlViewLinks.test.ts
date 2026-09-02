/**
 * BUILDER STOCK — THE SHEET THAT SERVES ITS ROWS AND LOCKS ITS EXPORTS.
 *
 * THE REAL DOCUMENT THESE FIXTURES ARE. `vg-master-*` is the live "[VG]
 * MASTER STOCKLIST - V002", a public Google Sheet ("anyone with the link can
 * view") whose owner has disabled download: every `export?format=…` answers
 * 401 while `gviz/tq` serves the rows. Its fourteen property rows each carry
 * FOUR builder documents — Brochure, Siting/Masterplan, Estate Brochure,
 * Stage Plan/POS, all Google Drive files — and every one of them used to
 * vanish, because the only hyperlink source the reader knew was the workbook
 * export that answers 401. The rows imported; the evidence did not. The
 * `luxton-*` pair is the Luxton list, whose exports are open — the case that
 * already worked, pinned so the new source cannot regress it.
 *
 * WHAT IS UNDER TEST IS THE WHOLE CHAIN, ON REAL BYTES. `parseHtmlViewGrid`
 * turns the one public representation that carries targets —
 * `htmlview/sheet?gid=N` — into the same `WorkbookSheet` shape the workbook
 * reader produces, and then the EXISTING merge proves the tab
 * (`matchWorksheet`), proves each row (`alignWorksheetRows`, content, never
 * position — the grid omits empty spreadsheet rows, so row 23 of the table is
 * row 126 of the sheet) and lays each row's own targets beside it
 * (`mergeHyperlinkColumns`). One merge for both sources; a second one is how
 * two link sources would attribute a brochure to different rows.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  htmlViewSheetUrl, parseHtmlViewGrid, unwrapGoogleRedirect,
} from '../../../supabase/functions/_shared/builderStock/googleSheetsHtmlGrid.pure';
import {
  matchWorksheet, mergeHyperlinkColumns,
} from '../../../supabase/functions/_shared/builderStock/sheetHyperlinks.pure';
import {
  parseDelimited,
} from '../../../supabase/functions/_shared/builderStock/table.pure';

const FIXTURES = join(__dirname, 'fixtures', 'sheets');
const read = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');

describe('the htmlview grid parses into an ordinary worksheet', () => {
  it('reads the locked-export sheet: every row, every link, correct columns', () => {
    const sheet = parseHtmlViewGrid(read('vg-master-htmlview.html'));
    expect(sheet).not.toBeNull();

    const linked = sheet!.links.flatMap((row) => row.filter(Boolean));
    // Fourteen property rows x four documents each. Measured on the live
    // document; the fixture is that response verbatim.
    expect(linked).toHaveLength(56);
    // Every target is the BUILDER's address, with Google's interstitial
    // redirector unwrapped — never `google.com/url?q=…`.
    for (const url of linked) {
      expect(url).toMatch(/^https:\/\/drive\.google\.com\/file\/d\//);
    }

    // The links sit in the columns the sheet gives them: Brochure V002 is
    // column 14, and the three document columns follow it.
    const aDataRow = sheet!.links.find((row) => row.some(Boolean))!;
    expect([14, 15, 16, 17]).toEqual(
      aDataRow.map((link, index) => (link ? index : -1)).filter((index) => index >= 0));
  });

  it('reads the open-export sheet identically, so one reader serves both', () => {
    const sheet = parseHtmlViewGrid(read('luxton-htmlview.html'));
    expect(sheet).not.toBeNull();
    const linked = sheet!.links.flatMap((row) => row.filter(Boolean));
    // Thirteen brochure rows, one Dropbox link each.
    expect(linked).toHaveLength(13);
    for (const url of linked) {
      expect(url).toMatch(/^https:\/\/www\.dropbox\.com\/scl\/fi\//);
      // The q-parameter decode restored the builder's own query string.
      expect(url).toContain('rlkey=');
      expect(url).not.toContain('%3D');
    }
  });

  it('answers null for a payload with no grid — the JS shell, an error page', () => {
    expect(parseHtmlViewGrid('<!DOCTYPE html><html><body><script>x()</script></body></html>'))
      .toBeNull();
    expect(parseHtmlViewGrid('')).toBeNull();
    expect(parseHtmlViewGrid('<table></table>')).toBeNull();
  });

  it('names the endpoint with the tab, and defaults an unnamed tab to gid 0', () => {
    expect(htmlViewSheetUrl('SHEET', '42'))
      .toBe('https://docs.google.com/spreadsheets/d/SHEET/htmlview/sheet?gid=42');
    expect(htmlViewSheetUrl('SHEET', null))
      .toBe('https://docs.google.com/spreadsheets/d/SHEET/htmlview/sheet?gid=0');
  });
});

describe('the redirector unwrap', () => {
  it('takes the builder\'s address out of google.com/url and nothing else', () => {
    expect(unwrapGoogleRedirect(
      'https://www.google.com/url?q=https://drive.google.com/file/d/AB/view%3Fusp%3Dsharing&sa=D'))
      .toBe('https://drive.google.com/file/d/AB/view?usp=sharing');
    // Not the redirector: returned as written.
    expect(unwrapGoogleRedirect('https://www.dropbox.com/scl/fi/x/y.pdf?dl=0'))
      .toBe('https://www.dropbox.com/scl/fi/x/y.pdf?dl=0');
    // The redirector with a non-http target proves nothing and is kept as-is.
    expect(unwrapGoogleRedirect('https://www.google.com/url?q=javascript:alert(1)'))
      .toBe('https://www.google.com/url?q=javascript:alert(1)');
  });
});

describe('the EXISTING merge attributes the recovered links, row by row', () => {
  it('locked-export sheet: gviz membership + htmlview targets = 56 links on 14 rows', () => {
    const matrix = parseDelimited(read('vg-master-gviz.csv'));
    const sheet = parseHtmlViewGrid(read('vg-master-htmlview.html'))!;

    const match = matchWorksheet(matrix, [sheet]);
    expect(match.ok).toBe(true);

    const merged = mergeHyperlinkColumns(matrix, sheet);
    expect(merged.linksResolved).toBe(56);
    expect(merged.columnsAdded.length).toBe(4);

    // Row identity, spot-checked against the live document: lot 102 at
    // Watsons Reach carries the brochure the sheet's own row carries, not a
    // neighbour's. (Content alignment, never position — the html grid omits
    // empty spreadsheet rows entirely.)
    const header = merged.matrix[0].length;
    const lot102 = merged.matrix.find((row) => row[4] === '102');
    expect(lot102).toBeDefined();
    expect(lot102!.slice(header - 4).join(' ')).toContain('https://drive.google.com/file/d/1S8zpI0xejenQEsLROgPqh3U0cLSE3JcD');
  });

  it('open-export sheet through the same path, so the new source cannot regress it', () => {
    const matrix = parseDelimited(read('luxton-export.csv'));
    const sheet = parseHtmlViewGrid(read('luxton-htmlview.html'))!;
    const match = matchWorksheet(matrix, [sheet]);
    expect(match.ok).toBe(true);
    const merged = mergeHyperlinkColumns(matrix, sheet);
    expect(merged.linksResolved).toBe(13);
    const lot824 = merged.matrix.find((row) => row[2] === '824');
    expect(lot824?.join(' ')).toContain('Lot-824-Verve.pdf');
  });
});
