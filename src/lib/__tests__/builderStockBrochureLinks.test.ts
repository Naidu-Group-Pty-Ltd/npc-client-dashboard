/**
 * BUILDER STOCK — STAGE A: THE BROCHURE LINK IN THE SPREADSHEET.
 *
 * A stock list carries its documents as hyperlinks: the cell reads "Brochure"
 * and the address is underneath it. Stage A is supposed to open that document
 * and take the builder's own photograph of the property from it. On a live
 * import it took nothing, and the cards fell all the way to a Street View of
 * the road.
 *
 * TWO INDEPENDENT REASONS, and only one of them is ours.
 *
 * ONE — A HYPERLINK FORMULA IS A HYPERLINK. A spreadsheet stores "this text
 * points somewhere" two different ways: as a link RELATIONSHIP on the cell
 * (`cell.l.Target`, what Insert > Link writes), or as the cell BEING
 * `=HYPERLINK("…","Brochure")`, where there is no relationship at all and the
 * target is an argument inside `cell.f`. The reader knew only the first, so
 * every brochure typed as a formula was dropped silently — from a workbook it
 * had read perfectly well. Proved by round-trip below.
 *
 * TWO — THE DOCUMENT REFUSED TO BE EXPORTED. Measured against a live sheet,
 * every documented public representation: `/export` (xlsx and csv) 401,
 * `/pubhtml` 401, and `gviz` in all three output modes plus `/htmlview` and
 * `/preview` answering 200 with zero anchors and zero file ids. Only the
 * export carries link targets. That is not a failed extraction — the address
 * never reaches this product — and it is reported as its own condition with
 * the one remedy that asks nothing of the document.
 *
 * Written on invented data. No spreadsheet, estate, lot, builder or URL here
 * belongs to any deployment.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';

import {
  hyperlinkTargetOf, mergeHyperlinkColumns, sourcesFullyEnumerable,
} from '../../../supabase/functions/_shared/builderStock/sheetHyperlinks.pure';
import {
  sourceAccessNoticeFor, isNonBlockingSourceNotice,
} from '../../../supabase/functions/_shared/builderStock/sourceAccessNotice.pure';

const LINK = 'https://example.invalid/drive/brochure-605.pdf';
const FORMULA_LINK = 'https://example.invalid/drive/master-605.pdf';

/** A workbook built and read back through the library the runtime loads. */
function roundTrip(): Record<string, { w?: string; v?: unknown; l?: { Target?: string }; f?: string }> {
  const ws = XLSX.utils.aoa_to_sheet([
    ['Lot #', 'Estate', 'Brochure', 'Siting', 'Plan'],
    ['605', 'Sample Rise', 'Brochure', 'Masterplan', 'Stage 1 - POS'],
  ]);
  (ws as never as Record<string, { l?: unknown }>)['C2'].l = { Target: LINK };
  (ws as never as Record<string, unknown>)['D2'] = {
    t: 's', v: 'Masterplan', f: `HYPERLINK("${FORMULA_LINK}","Masterplan")`,
  };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Stock');
  const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return XLSX.read(new Uint8Array(bytes as ArrayBuffer), { type: 'array', cellDates: true })
    .Sheets.Stock as never;
}

describe('a spreadsheet says "points somewhere" in more than one way', () => {
  const sheet = roundTrip();

  it('11 — a link relationship survives the round trip', () => {
    expect(sheet.C2?.l?.Target).toBe(LINK);
    expect(hyperlinkTargetOf({ link: sheet.C2?.l?.Target, formula: sheet.C2?.f })).toBe(LINK);
  });

  it('12 — a HYPERLINK() formula carries NO relationship, and is read anyway', () => {
    // The defect in one assertion: the reader used to take `l.Target` only.
    expect(sheet.D2?.l?.Target).toBeUndefined();
    expect(sheet.D2?.f).toContain('HYPERLINK');
    expect(hyperlinkTargetOf({ link: sheet.D2?.l?.Target, formula: sheet.D2?.f }))
      .toBe(FORMULA_LINK);
  });

  it('13 — the displayed text and the target stay distinct', () => {
    expect(sheet.C2?.w ?? sheet.C2?.v).toBe('Brochure');
    expect(sheet.D2?.v).toBe('Masterplan');
    // A label is never mistaken for an address…
    expect(hyperlinkTargetOf({ link: null, formula: null })).toBeNull();
    // …and plain text carries neither.
    expect(sheet.E2?.l?.Target).toBeUndefined();
    expect(hyperlinkTargetOf({ link: sheet.E2?.l?.Target, formula: sheet.E2?.f })).toBeNull();
  });

  it('a formula naming something that is not a document answers nothing', () => {
    for (const target of ['file:///c:/brochure.pdf', 'mailto:someone@example.invalid',
      '#Sheet1!A1', 'javascript:alert(1)', '']) {
      expect(hyperlinkTargetOf({ link: null, formula: `HYPERLINK("${target}","Brochure")` }))
        .toBeNull();
      expect(hyperlinkTargetOf({ link: target, formula: null })).toBeNull();
    }
  });

  it('a doubled quote inside the target is unescaped, not truncated', () => {
    expect(hyperlinkTargetOf({
      link: null, formula: 'HYPERLINK("https://example.invalid/a""b.pdf","Brochure")',
    })).toBe('https://example.invalid/a"b.pdf');
  });

  it('the relationship wins where a cell somehow carries both', () => {
    expect(hyperlinkTargetOf({ link: LINK, formula: `HYPERLINK("${FORMULA_LINK}","x")` }))
      .toBe(LINK);
  });

  it('the reader asks the one module that knows, rather than reading `l` itself', () => {
    const source = readFileSync(
      'supabase/functions/_shared/builderStock/fetchSource.ts', 'utf8');
    expect(source).toContain('hyperlinkTargetOf({');
    expect(source).toContain('formula: cell?.f ?? null');
  });
});

describe('14/15 — a link belongs to its own row and to no other', () => {
  const csv = [['Lot #', 'Estate', 'Brochure'], ['605', 'Sample Rise', 'Brochure'],
    ['606', 'Sample Rise', 'Brochure']];

  it('14 — this row\'s brochure is attached to this row', () => {
    const merged = mergeHyperlinkColumns(csv, {
      name: 'Stock',
      values: [['Lot #', 'Estate', 'Brochure'], ['605', 'Sample Rise', 'Brochure'],
        ['606', 'Sample Rise', 'Brochure']],
      links: [[null, null, null], [null, null, LINK], [null, null, FORMULA_LINK]],
    });
    expect(merged.linksResolved).toBe(2);
    const flat = merged.matrix.map((row) => row.join('|'));
    expect(flat[1]).toContain(LINK);
    expect(flat[2]).toContain(FORMULA_LINK);
    // 15 — and the other row's document is nowhere near it.
    expect(flat[1]).not.toContain(FORMULA_LINK);
    expect(flat[2]).not.toContain(LINK);
  });

  it('15 — a labelled cell with no link of its own borrows nobody else\'s', () => {
    const merged = mergeHyperlinkColumns(csv, {
      name: 'Stock',
      values: [['Lot #', 'Estate', 'Brochure'], ['605', 'Sample Rise', 'Brochure'],
        ['606', 'Sample Rise', 'Brochure']],
      links: [[null, null, null], [null, null, LINK], [null, null, null]],
    });
    const flat = merged.matrix.map((row) => row.join('|'));
    expect(flat[2]).not.toContain(LINK);
    expect(flat[2]).not.toContain('http');
  });
});

describe('17/18 — inaccessible is not the same as absent', () => {
  it('17 — a document that refuses export says so, honestly and non-blockingly', () => {
    const notice = sourceAccessNoticeFor('unavailable_source_export')!;
    expect(notice.detail.reason).toBe('unavailable_source_export');
    expect(isNonBlockingSourceNotice(notice.code)).toBe(true);
    // It names what was actually observed — the FILE would not export — rather
    // than blaming the linked documents, which may be perfectly reachable.
    expect(notice.message).toMatch(/exported/i);
    // And offers the route that asks nothing of the document.
    expect(notice.message).toMatch(/\.xlsx/i);
    // Never a permission demand. Unchanged rule.
    for (const forbidden of [/shar/i, /permission/i, /anyone with the link/i]) {
      expect(notice.message).not.toMatch(forbidden);
    }
  });

  it('a workbook we DID get and could not read is a different reading', () => {
    // Our fault, not the document's, and it points somewhere else.
    const notice = sourceAccessNoticeFor('unavailable_workbook_unreadable')!;
    expect(notice.detail.reason).toBe('unavailable_workbook_unreadable');
    expect(notice.message).not.toMatch(/does not allow/i);
  });

  it('18 — no link present at all is a reading of the SPREADSHEET, and silent', () => {
    expect(sourceAccessNoticeFor('none_present')).toBeNull();
    expect(sourceAccessNoticeFor('resolved')).toBeNull();
    // Which is the whole distinction: only these two mean stage 1 truly looked.
    expect(sourcesFullyEnumerable('none_present')).toBe(true);
    expect(sourcesFullyEnumerable('resolved')).toBe(true);
    for (const unread of ['unavailable_source_export', 'unavailable_workbook_unreadable',
      'unavailable_no_worksheet_match', 'unavailable_ambiguous_worksheet'] as const) {
      expect(sourcesFullyEnumerable(unread)).toBe(false);
      expect(sourceAccessNoticeFor(unread)).not.toBeNull();
    }
  });

  it('every reading has its own sentence — none falls through to a generic one', () => {
    const seen = new Set<string>();
    for (const unread of ['unavailable_source_export', 'unavailable_workbook_unreadable',
      'unavailable_no_worksheet_match', 'unavailable_ambiguous_worksheet'] as const) {
      const message = sourceAccessNoticeFor(unread)!.message;
      expect(seen.has(message)).toBe(false);
      seen.add(message);
      // All three obligatory statements, on every one of them.
      expect(message).toMatch(/could not be accessed/i);
      expect(message).toMatch(/imported successfully/i);
      expect(message).toMatch(/continuing/i);
    }
  });

  it('nothing here names a spreadsheet, a tab, a builder or a property', () => {
    const source = readFileSync(
      'supabase/functions/_shared/builderStock/sourceAccessNotice.pure.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    expect(source).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
    expect(source).not.toMatch(/https?:\/\//);
  });
});
