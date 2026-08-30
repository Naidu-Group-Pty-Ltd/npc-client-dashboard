/**
 * BUILDER STOCK — SOME OF A SOURCE BEING UNREADABLE IS NOT THE SOURCE BEING
 * UNREADABLE.
 *
 * A Google Sheets import asks two questions with nothing to do with each
 * other: can we read the property ROWS, and can we also recover the LINK
 * TARGETS. Measured on a live builder list, a document shared so anyone with
 * the link may view it answers the first and refuses the second — `gviz` 200,
 * every `export?format=…` 401.
 *
 * Treating those as one question has two bad answers available and this takes
 * neither: failing an upload whose rows are all present, or telling a builder
 * to go and change their Drive sharing before the product will work for them.
 * The rows were readable, so the link they pasted was sufficient.
 *
 * ROWS READABLE  → a successful import
 * LINKS UNREADABLE → a NON-BLOCKING source-access error, shown and recorded
 * UNAVAILABLE    → TERMINAL; nothing waits for a URL that cannot be reached
 */
import { describe, expect, it } from 'vitest';

import {
  SOURCE_LINKS_UNAVAILABLE, isNonBlockingSourceNotice, sourceAccessNoticeFor,
} from '../../../supabase/functions/_shared/builderStock/sourceAccessNotice.pure';
import { sourcesFullyEnumerable } from '../../../supabase/functions/_shared/builderStock/sheetHyperlinks.pure';
import { rowSourceBranches, allBranchesTerminal } from '../../../supabase/functions/_shared/builderStock/sourceBranches.pure';

const readSource = (relative: string): string => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { resolve } = require('node:path') as typeof import('node:path');
  return readFileSync(resolve(__dirname, '../../../', relative), 'utf8');
};

describe('A and D — everything readable says nothing', () => {
  it('links recovered raises no notice', () => {
    expect(sourceAccessNoticeFor('resolved')).toBeNull();
  });

  it('a tab that genuinely carries no links raises no notice', () => {
    // A fact about the spreadsheet, not about our access to it.
    expect(sourceAccessNoticeFor('none_present')).toBeNull();
  });

  it('a source that is not a spreadsheet at all raises no notice', () => {
    expect(sourceAccessNoticeFor(undefined)).toBeNull();
    expect(sourceAccessNoticeFor(null)).toBeNull();
  });
});

describe('B, C and E — rows in, links out, and the builder is told', () => {
  const reasons = [
    'unavailable_source_sharing',
    'unavailable_no_worksheet_match',
    'unavailable_ambiguous_worksheet',
  ] as const;

  it('every access failure raises the notice — 401, 403 and the rest alike', () => {
    // The transport code is diagnostics; what the builder needs to know is the
    // same sentence whichever way the workbook refused.
    for (const reason of reasons) {
      const notice = sourceAccessNoticeFor(reason);
      expect(notice?.code).toBe(SOURCE_LINKS_UNAVAILABLE);
      expect(notice?.detail).toEqual({ reason });
    }
  });

  it('the message says all three things', () => {
    const message = sourceAccessNoticeFor('unavailable_source_sharing')!.message;
    // 1 — something could not be reached.
    expect(message).toMatch(/could not be accessed/i);
    // 2 — the import still succeeded.
    expect(message).toMatch(/imported successfully/i);
    // 3 — processing is continuing by itself.
    expect(message).toMatch(/continuing/i);
  });

  it('and never asks anyone to change a sharing setting', () => {
    /*
     * The rows were readable, so the link the builder pasted was sufficient.
     * Demanding a Drive change for optional metadata is the behaviour this
     * whole change exists to prevent.
     */
    const message = sourceAccessNoticeFor('unavailable_source_sharing')!.message;
    for (const forbidden of [/shar/i, /permission/i, /access setting/i, /anyone with the link/i]) {
      expect(message).not.toMatch(forbidden);
    }
  });

  it('behaviour keys on the code, never on the sentence', () => {
    expect(isNonBlockingSourceNotice(SOURCE_LINKS_UNAVAILABLE)).toBe(true);
    expect(isNonBlockingSourceNotice('duplicate_file')).toBe(false);
    expect(isNonBlockingSourceNotice('sheet_tab_not_found')).toBe(false);
    expect(isNonBlockingSourceNotice(null)).toBe(false);
  });

  it('the upload is NOT failed, and the counts still publish', () => {
    const fn = readSource('supabase/functions/builder-portal-stock/index.ts');
    const block = fn.slice(fn.indexOf('const sourceNotice = sourceAccessNoticeFor('),
      fn.indexOf('processing_completed_at: new Date().toISOString(),',
        fn.indexOf('const sourceNotice = sourceAccessNoticeFor(')));
    // `status` carries `result.uploadStatus`, exactly as it did.
    expect(block).toContain('status: result.uploadStatus,');
    expect(block).not.toContain("status: 'failed'");
    expect(block).toContain('records_imported: result.summary.imported,');
    // The code and the reason are persisted for the portal to read.
    expect(block).toContain('sourceNotice?.code ?? null');
    expect(block).toContain('sourceNotice ? sourceNotice.detail : null');
    expect(block).toContain('sourceNotice?.message ?? null');
  });

  it('a row-level failure still wins the message — it is the graver of the two', () => {
    const fn = readSource('supabase/functions/builder-portal-stock/index.ts');
    expect(fn).toContain('result.summary.failures.length\n          ? `${result.summary.failed} row(s) could not be saved.`');
  });
});

describe('I — unavailable is TERMINAL, so nothing waits for it', () => {
  it('zero recovered links is zero branches, not a pending branch', () => {
    /*
     * "There may have been a brochure URL we could not reach" is not pending
     * work: nothing the system can do turns it into a URL. A row of labels is
     * arithmetically identical to a row with no links at all.
     */
    const labelsOnly = {
      'Aa': 'Brochure', 'Bb': 'Masterplan', 'Cc': 'Stage plan',
      'Dd': 'Estate map', 'Ee': 'Rental appraisal',
    };
    expect(rowSourceBranches(labelsOnly)).toEqual([]);
    expect(allBranchesTerminal(null, rowSourceBranches(labelsOnly), 5, 'src:x')).toBe(true);
  });

  it('no imaginary branch is invented from a label', () => {
    const branches = rowSourceBranches({ 'Aa': 'Brochure' });
    expect(branches).toHaveLength(0);
  });

  it('H — the links that WERE recovered are still each their own branch', () => {
    // #2382 is untouched: recovery changes how many branches exist, never the
    // rule that each one is independent.
    const five = {
      'Aa': 'https://example.test/a.pdf', 'Bb': 'https://example.test/b.pdf',
      'Cc': 'https://example.test/c.pdf', 'Dd': 'https://example.test/d.pdf',
      'Ee': 'https://example.test/e.pdf',
    };
    expect(rowSourceBranches(five)).toHaveLength(5);
    const two = { 'Aa': 'https://example.test/a.pdf', 'Bb': 'Masterplan',
      'Cc': 'https://example.test/c.pdf', 'Dd': 'Estate map', 'Ee': 'Appraisal' };
    expect(rowSourceBranches(two)).toHaveLength(2);
  });

  it('an access failure is never counted as having seen the sources', () => {
    expect(sourcesFullyEnumerable('unavailable_source_sharing')).toBe(false);
    expect(sourcesFullyEnumerable('none_present')).toBe(true);
  });
});

describe('F and G — the rows themselves are a different question', () => {
  it('an unreadable tab fails the import, and never substitutes another', () => {
    const fetch = readSource('supabase/functions/_shared/builderStock/fetchSource.ts');
    // A gid that does not resolve refuses the whole read.
    expect(fetch).toContain("'sheet_tab_not_found'");
    expect(fetch).toContain('That link names a tab this spreadsheet does not have.');
    // And a document that will not answer at all is a blocking refusal.
    expect(fetch).toContain("'sheet_unreadable'");
  });

  it('the blocking refusals are not the non-blocking code', () => {
    for (const blocking of ['sheet_tab_not_found', 'sheet_unreadable', 'source_forbidden']) {
      expect(isNonBlockingSourceNotice(blocking)).toBe(false);
    }
  });
});

describe('K and J — one property\'s inaccessible documents are its own', () => {
  it('the notice is a fact about the SOURCE, and carries no property in it', () => {
    const notice = sourceAccessNoticeFor('unavailable_source_sharing')!;
    expect(JSON.stringify(notice)).not.toMatch(/lot|estate|address|item_id/i);
  });

  it('branches stay per-row whatever the recovery produced', () => {
    const small = rowSourceBranches({ 'Aa': 'https://example.test/small.pdf' });
    const large = rowSourceBranches({ 'Aa': 'https://example.test/large.pdf' });
    expect(small[0].url).not.toBe(large[0].url);
  });
});

describe('L and M — the portal shows it, and shows it as an error', () => {
  const page = () => readSource('src/pages/builder/BuilderStockList.tsx');

  it('appears in the upload history, persisted rather than as a toast', () => {
    // It renders from the stored row, so it survives a reload and a revisit.
    expect(page()).toContain('upload.error_message');
    expect(page()).toContain('isNonBlockingSourceNotice(upload.error_code)');
  });

  it('is presented as an error, not as a muted footnote', () => {
    const block = page().slice(page().indexOf('{upload.error_message ? ('));
    expect(block).toContain('text-destructive');
    expect(block).toContain('border-destructive/30');
    expect(block).toContain('AlertTriangle');
  });

  it('a blocking failure looks different from the non-blocking notice', () => {
    /*
     * The status badge is what separates them: a failed upload says so and
     * imported nothing, while this one carries its counts and its badge.
     */
    const block = page().slice(page().indexOf('{upload.error_message ? ('));
    expect(block).toContain('text-muted-foreground');
    expect(block).toMatch(/isNonBlockingSourceNotice\(upload\.error_code\)\s*\n\s*\?/);
  });

  it('no spreadsheet id, gid, tab or column name anywhere in the notice', () => {
    const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const code = strip(readSource(
      'supabase/functions/_shared/builderStock/sourceAccessNotice.pure.ts'));
    for (const forbidden of ['gid=', 'Sheet1', 'Brochure', 'Masterplan', 'docs.google.com']) {
      expect(code).not.toContain(forbidden);
    }
  });
});
