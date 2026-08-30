/**
 * BUILDER STOCK — A GOOGLE SHEETS LINK IS A SPREADSHEET, NOT A WEB PAGE.
 *
 * A builder pastes what their browser shows:
 *
 *     https://docs.google.com/spreadsheets/d/<ID>/edit?gid=0#gid=0
 *
 * Fetched as an ordinary URL that returns 675 KB of `text/html` — the Google
 * Sheets APPLICATION. Run through this repository's own generic table
 * extractor it yields two tables: a 101 x 27 grid whose header is the
 * spreadsheet's COLUMN LETTERS (`"", "A", "B", "C" …`) with the row-number
 * gutter as its first column, and a Google Finance disclaimer. Not one
 * property row. The import does not fail — it succeeds at reading the wrong
 * thing, which is worse, because nothing anywhere reports it.
 *
 * AND THE GID IS THE DANGEROUS PART. Measured against a live document,
 * `gviz/tq` answers an UNKNOWN gid with HTTP 200, `status: "ok"`, and a
 * different worksheet entirely — five impossible gids all returned the same
 * byte-identical substitute tab while the real one returned the stock list. A
 * reader that trusts the status line replaces a builder's stock with whatever
 * tab Google felt like.
 *
 * Written on invented spreadsheet ids and invented tab contents. No document
 * this repository has ever been pointed at appears here or in the module.
 */
import { describe, expect, it } from 'vitest';

import {
  SENTINEL_GID, googleSheetsReadAttempts, googleSheetsRef, isGoogleSheetsUrl,
  resolveSheetsPayload, sentinelReadUrl,
} from '../../../supabase/functions/_shared/builderStock/googleSheetsSource.pure';

const ID = 'aBcDeF0123456789_xyzQRS-tuv';
const link = (path: string) => `https://docs.google.com/spreadsheets/d/${ID}/${path}`;

const REAL_TAB = '"Lot","Estate","Price"\n"7","Sample Rise","640000"\n';
const SUBSTITUTE_TAB = '"","AGENT PORTAL — BROCHURES"\n"","Marketing"\n';

describe('what a link names', () => {
  it('reads the document and the tab out of an ordinary browser address', () => {
    expect(googleSheetsRef(link('edit?gid=0#gid=0')))
      .toEqual({ spreadsheetId: ID, gid: '0' });
  });

  it('takes the gid from the FRAGMENT when the query has none', () => {
    // A fragment never reaches a server, so it has to be read before the fetch
    // or the tab instruction is silently lost.
    expect(googleSheetsRef(link('edit#gid=8842'))?.gid).toBe('8842');
  });

  it('the query wins over the fragment — it is the half a redirect keeps', () => {
    expect(googleSheetsRef(link('edit?gid=5#gid=9'))?.gid).toBe('5');
  });

  it('a link with no gid names no tab', () => {
    expect(googleSheetsRef(link('edit'))?.gid).toBeNull();
    expect(googleSheetsRef(link('view'))?.gid).toBeNull();
  });

  it('handles the account-scoped and published forms of the path', () => {
    expect(googleSheetsRef(`https://docs.google.com/spreadsheets/u/2/d/${ID}/edit?gid=3`))
      .toEqual({ spreadsheetId: ID, gid: '3' });
    expect(googleSheetsRef(`https://docs.google.com/spreadsheets/d/e/${ID}/pubhtml`)?.spreadsheetId)
      .toBe(ID);
  });

  it('a non-numeric gid is no gid at all, never a tab name', () => {
    expect(googleSheetsRef(link('edit?gid=Sheet1'))?.gid).toBeNull();
  });

  it('is not fooled by a lookalike host', () => {
    for (const bad of [
      'https://docs.google.com.evil.test/spreadsheets/d/x/edit',
      'https://notdocs.google.com/spreadsheets/d/x/edit',
      'https://docs.google.com/document/d/x/edit',
      'https://example.test/spreadsheets/d/x/edit',
    ]) {
      expect(isGoogleSheetsUrl(bad)).toBe(false);
    }
    expect(isGoogleSheetsUrl(link('edit?gid=0'))).toBe(true);
  });
});

describe('which endpoints are asked, and in what order', () => {
  const ref = googleSheetsRef(link('edit?gid=42'))!;

  it('the documented export comes first, and carries the tab', () => {
    const [first] = googleSheetsReadAttempts(ref);
    expect(first.endpoint).toBe('export_csv');
    expect(first.url).toContain('/export?format=csv');
    expect(first.url).toContain('gid=42');
    // It refuses an unknown gid rather than substituting, so it needs no probe.
    expect(first.substitutes).toBe(false);
  });

  it('gviz is the fallback, because a shared document can still refuse export', () => {
    const [, second] = googleSheetsReadAttempts(ref);
    expect(second.endpoint).toBe('gviz_csv');
    expect(second.url).toContain('/gviz/tq?tqx=out:csv');
    expect(second.url).toContain('gid=42');
    // And it is the one that has to be policed.
    expect(second.substitutes).toBe(true);
  });

  it('asks for CSV, never for rendered HTML and never for the application page', () => {
    for (const attempt of googleSheetsReadAttempts(ref)) {
      expect(attempt.url).not.toContain('/edit');
      expect(attempt.url).not.toContain('htmlview');
      expect(attempt.url).toMatch(/format=csv|out:csv/);
    }
  });

  it('a link with no gid asks for no tab, which is the documented default', () => {
    const none = googleSheetsRef(link('edit'))!;
    for (const attempt of googleSheetsReadAttempts(none)) {
      expect(attempt.url).not.toContain('gid=');
    }
  });

  it('the probe asks the same endpoint for a tab that cannot exist', () => {
    const [, gviz] = googleSheetsReadAttempts(ref);
    expect(sentinelReadUrl(ref, gviz)).toContain(`gid=${SENTINEL_GID}`);
    expect(sentinelReadUrl(ref, gviz)).toContain('/gviz/tq');
  });
});

describe('the requested tab is served, or the read fails closed', () => {
  const ref = googleSheetsRef(link('edit?gid=0'))!;
  const [exportCsv, gviz] = googleSheetsReadAttempts(ref);

  it('the requested gid is honoured when it answers with its own tab', () => {
    const out = resolveSheetsPayload({
      ref, attempt: gviz, body: REAL_TAB, sentinelBody: SUBSTITUTE_TAB,
    });
    expect(out).toMatchObject({ ok: true, csv: REAL_TAB, tabProven: true });
  });

  it('FAILS CLOSED when the gid answers with the substitute tab', () => {
    /*
     * The whole reason this module exists. HTTP 200, `status: "ok"`, and a
     * different worksheet — indistinguishable from success by every signal
     * except this one.
     */
    expect(resolveSheetsPayload({
      ref, attempt: gviz, body: SUBSTITUTE_TAB, sentinelBody: SUBSTITUTE_TAB,
    })).toEqual({ ok: false, reason: 'gid_unresolved' });
  });

  it('trailing whitespace is not a different worksheet', () => {
    expect(resolveSheetsPayload({
      ref, attempt: gviz, body: `${SUBSTITUTE_TAB}\r\n`, sentinelBody: SUBSTITUTE_TAB,
    })).toEqual({ ok: false, reason: 'gid_unresolved' });
  });

  it('no probe answer is not proof, so it refuses', () => {
    // Nothing to compare against decides nothing, and deciding nothing must
    // never resolve to "import it anyway".
    expect(resolveSheetsPayload({
      ref, attempt: gviz, body: REAL_TAB, sentinelBody: null,
    })).toEqual({ ok: false, reason: 'gid_unresolved' });
  });

  it('an endpoint that refuses an unknown gid needs no probe', () => {
    const out = resolveSheetsPayload({
      ref, attempt: exportCsv, body: REAL_TAB, sentinelBody: null,
    });
    expect(out).toMatchObject({ ok: true, tabProven: true });
  });

  it('a link with no gid takes the first tab and says the tab was not pinned', () => {
    const none = googleSheetsRef(link('edit'))!;
    const out = resolveSheetsPayload({
      ref: none, attempt: gviz, body: REAL_TAB, sentinelBody: null,
    });
    // No instruction was given, so there is nothing to fail closed about — and
    // it is the same tab a person opening the link would land on.
    expect(out).toMatchObject({ ok: true, tabProven: true });
  });

  it('an empty answer is not a stock list', () => {
    expect(resolveSheetsPayload({
      ref, attempt: gviz, body: '   \n', sentinelBody: SUBSTITUTE_TAB,
    })).toEqual({ ok: false, reason: 'empty' });
  });
});

describe('the resolved data enters the pipeline that already exists', () => {
  const source = () => readSource(
    'supabase/functions/_shared/builderStock/fetchSource.ts');

  it('every retrieval gets it, not only the import', () => {
    // `fetchStockSource` is what the import, the source-image repair and
    // anything added later all call, and a builder may paste a Sheets link
    // into any of them.
    expect(source()).toContain('const sheets = googleSheetsRef(startUrl);');
    expect(source()).toContain('if (sheets) return await fetchGoogleSheet(sheets, startUrl);');
  });

  it('the answer is declared CSV, so no second stock parser is created', () => {
    expect(source()).toContain("declaredContentType: 'text/csv'");
  });

  it('the existing SSRF guard, redirect policy and caps still apply', () => {
    // Every candidate goes through the same retrieval; this chooses addresses,
    // it does not fetch differently.
    const fn = source().slice(source().indexOf('async function fetchGoogleSheet'));
    expect(fn.slice(0, fn.indexOf('function decodeUtf8'))).toContain('await fetchOrdinaryUrl(attempt.url)');
    expect(source()).toContain('async function fetchOrdinaryUrl');
    expect(source()).toContain('assertPublicUrl');
  });

  it('an unresolved tab refuses the whole read with a reason a builder can act on', () => {
    expect(source()).toContain("'sheet_tab_not_found'");
    expect(source()).toContain('That link names a tab this spreadsheet does not have.');
  });

  it('a document that refuses one endpoint may still serve another', () => {
    const fn = source().slice(source().indexOf('async function fetchGoogleSheet'));
    expect(fn).toContain('lastRefusal = error; continue;');
    expect(fn).toContain('if (lastRefusal) throw lastRefusal;');
  });

  it('no spreadsheet id or real gid is written into the code', () => {
    /*
     * The measurements that motivated this are recorded in the comments, where
     * naming a gid is evidence rather than behaviour. What must contain
     * neither is the code, so the comments come out before the check.
     */
    const strip = (text: string) => text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    for (const relative of [
      'supabase/functions/_shared/builderStock/googleSheetsSource.pure.ts',
      'supabase/functions/_shared/builderStock/fetchSource.ts',
    ]) {
      const code = strip(readSource(relative));
      // The sentinel is the one literal gid, and it is the one that resolves
      // to nothing anywhere.
      for (const [, gid] of code.matchAll(/gid=(\d+)/g)) expect(gid).toBe(SENTINEL_GID);
      // A Google spreadsheet id is a long opaque token. No string literal here
      // may look like one.
      for (const [, literal] of code.matchAll(/'([^']*)'/g)) {
        // Mixed case AND digits: what a spreadsheet id looks like, and what
        // this module's own snake_case reason codes are not.
        const idShaped = /^[A-Za-z0-9_-]{25,}$/.test(literal)
          && /[A-Z]/.test(literal) && /\d/.test(literal);
        expect(idShaped, `id-shaped literal ${literal}`).toBe(false);
      }
    }
  });
});

function readSource(relative: string): string {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { resolve } = require('node:path') as typeof import('node:path');
  return readFileSync(resolve(__dirname, '../../../', relative), 'utf8');
}
