/**
 * BUILDER STOCK — A PROPERTY ROW MAY OWN SEVERAL BUILDER SOURCES.
 *
 * WHAT THIS REPLACES, VERBATIM:
 *
 *     return links.size === 1 ? [...links][0] : null;
 *
 * "Two different package links on one row is a row that does not say which
 * package is its own, and the answer to that is no image." That is true of a
 * source whose rows carry at most one link, where a second really does mean
 * ambiguity. It is false of a spreadsheet, where a stock row legitimately
 * carries a brochure, a siting plan, an estate map, a plan of subdivision and
 * a rental appraisal — and the rule declined ALL FIVE. A property with five
 * builder documents was treated as a property with none, and stage 1 began at
 * its second rung.
 *
 * The correction is not a better choice between them. It is to stop choosing.
 *
 * NOTHING BELOW READS A COLUMN NAME, and the headings here are deliberately
 * nothing like any real spreadsheet's: the next builder will call the same
 * thing `Package`, `Downloads`, `Property Documents` or `Plans`, and a rule
 * keyed on any of those is one spreadsheet's structure compiled into the
 * product. The heading travels as provenance and decides nothing.
 */
import { describe, expect, it } from 'vitest';

import {
  allBranchesTerminal, branchQuestion, branchRecord, branchTerminal, classifyBranch,
  openBranches, readBranchState, rowSourceBranches, writeBranchState,
} from '../../../supabase/functions/_shared/builderStock/sourceBranches.pure';
import {
  MAX_PACKAGE_ATTEMPTS, recordPackageAttempt, recordPackageUnprocessable,
} from '../../../supabase/functions/_shared/builderStock/packageAttempt.pure';
import { recordNoDeterministicImage } from '../../../supabase/functions/_shared/builderStock/negativeProvenance.pure';

const V = 5;
const ANCHOR = 'src:row-1';

/** One row's cells, under headings invented for this test. */
const FIVE_LINK_ROW = {
  'Zeta Doc': 'https://drive.google.com/file/d/FILE-invented-0001/view',
  'Alpha Plan': 'https://drive.google.com/drive/folders/FOLDER-invented-01',
  'Mid Map': 'https://example.test/estate/map.pdf',
  'Nu Sub': 'https://example.test/plans/stage.pdf',
  'Beta Appraisal': 'https://example.test/appraisal.docx',
  'Not A Link': 'Available',
  'Prose': 'Contact the sales team',
};

const branchesOf = (row: Record<string, string>) => rowSourceBranches(row);
const urls = (list: { url: string }[]) => list.map((b) => b.url);

describe('A — every supported link on the row is its own branch', () => {
  const branches = branchesOf(FIVE_LINK_ROW);

  it('keeps all five rather than declining them', () => {
    expect(branches).toHaveLength(5);
  });

  it('classifies each by its URL, never by its heading', () => {
    const byUrl = new Map(branches.map((b) => [b.url, b.kind]));
    expect(byUrl.get('https://drive.google.com/file/d/FILE-invented-0001/view')).toBe('drive_file');
    expect(byUrl.get('https://drive.google.com/drive/folders/FOLDER-invented-01')).toBe('drive_folder');
    expect(byUrl.get('https://example.test/estate/map.pdf')).toBe('document');
    expect(byUrl.get('https://example.test/appraisal.docx')).toBe('document');
    expect(classifyBranch('https://example.test/render.jpg')).toBe('direct_image');
  });

  it('drops what nothing here can take a photograph out of', () => {
    expect(classifyBranch('https://example.test/about-us')).toBe('unsupported');
    expect(classifyBranch('mailto:sales@example.test')).toBe('unsupported');
    expect(classifyBranch('not a url')).toBe('unsupported');
    expect(urls(branches)).not.toContain('Available');
  });

  it('a row with no links has no branches, and that is not a failure', () => {
    expect(branchesOf({ Status: 'Available' })).toEqual([]);
  });

  it('the same document in two columns is one branch', () => {
    const twice = branchesOf({
      'Aa': 'https://example.test/one.pdf', 'Bb': 'https://example.test/one.pdf',
    });
    expect(twice).toHaveLength(1);
  });

  it('carries the heading as provenance', () => {
    const found = branches.find((b) => b.url.endsWith('appraisal.docx'));
    expect(found?.column).toBe('Beta Appraisal');
  });
});

describe('B — one branch answering ends stage 1; a failing one does not', () => {
  const branches = branchesOf(FIVE_LINK_ROW);
  const q = (i: number) => branchQuestion(branches[i], V, ANCHOR);

  it('a branch that failed leaves every sibling open', () => {
    let state: unknown = writeBranchState(null, branches[0].url,
      recordNoDeterministicImage(q(0), 'read it; nothing for this property'));
    expect(branchTerminal(state, branches[0], q(0))).toBe(true);
    // And the other four are untouched.
    expect(openBranches(state, branches, V, ANCHOR)).toHaveLength(4);
    expect(allBranchesTerminal(state, branches, V, ANCHOR)).toBe(false);
  });

  it('stage 2 may not start while one applicable branch is unresolved', () => {
    let state: unknown = null;
    for (const branch of branches.slice(0, 4)) {
      state = writeBranchState(state, branch.url,
        recordNoDeterministicImage(branchQuestion(branch, V, ANCHOR), 'nothing'));
    }
    expect(allBranchesTerminal(state, branches, V, ANCHOR)).toBe(false);
    expect(urls(openBranches(state, branches, V, ANCHOR))).toEqual([branches[4].url]);
  });
});

describe('C — only when ALL branches are terminal may stage 1 answer', () => {
  const branches = branchesOf(FIVE_LINK_ROW);

  it('every branch answered, by any of the three routes', () => {
    let state: unknown = null;
    // Read, and named nothing.
    state = writeBranchState(state, branches[0].url,
      recordNoDeterministicImage(branchQuestion(branches[0], V, ANCHOR), 'nothing'));
    // Retired after exhausting its attempts.
    state = writeBranchState(state, branches[1].url,
      recordPackageUnprocessable(branchQuestion(branches[1], V, ANCHOR)));
    for (const branch of branches.slice(2)) {
      state = writeBranchState(state, branch.url,
        recordNoDeterministicImage(branchQuestion(branch, V, ANCHOR), 'nothing'));
    }
    expect(allBranchesTerminal(state, branches, V, ANCHOR)).toBe(true);
  });

  it('a row with only unsupported links is trivially finished', () => {
    const none = branchesOf({ 'Aa': 'https://example.test/about' });
    expect(allBranchesTerminal(null, none, V, ANCHOR)).toBe(true);
  });

  it('a version bump re-opens every branch', () => {
    let state: unknown = null;
    for (const branch of branches) {
      state = writeBranchState(state, branch.url,
        recordNoDeterministicImage(branchQuestion(branch, V, ANCHOR), 'nothing'));
    }
    expect(allBranchesTerminal(state, branches, V, ANCHOR)).toBe(true);
    expect(allBranchesTerminal(state, branches, V + 1, ANCHOR)).toBe(false);
  });

  it('a changed anchor re-opens them too — it is a different property', () => {
    let state: unknown = null;
    for (const branch of branches) {
      state = writeBranchState(state, branch.url,
        recordNoDeterministicImage(branchQuestion(branch, V, ANCHOR), 'nothing'));
    }
    expect(allBranchesTerminal(state, branches, V, 'src:somebody-else')).toBe(false);
  });
});

describe('D — a branch that keeps killing the worker retires alone', () => {
  const branches = branchesOf(FIVE_LINK_ROW);
  const heavy = branches[1];
  const q = branchQuestion(heavy, V, ANCHOR);

  it('exhausts its own attempts without spending anybody else\'s', () => {
    let state: unknown = null;
    for (let i = 0; i < MAX_PACKAGE_ATTEMPTS; i += 1) {
      expect(branchTerminal(state, heavy, q)).toBe(false);
      state = writeBranchState(state, heavy.url,
        recordPackageAttempt(branchRecord(state, heavy.url), q));
    }
    expect(branchTerminal(state, heavy, q)).toBe(true);

    // The other four have spent nothing and are still owed a look. This is the
    // whole point: one toxic branch must not retire the property.
    const open = openBranches(state, branches, V, ANCHOR);
    expect(open).toHaveLength(4);
    expect(urls(open)).not.toContain(heavy.url);
  });

  it('an attempt on one branch never appears on another', () => {
    const state = writeBranchState(null, heavy.url, recordPackageAttempt(null, q));
    for (const other of branches.filter((b) => b.url !== heavy.url)) {
      expect(branchRecord(state, other.url)).toBeNull();
    }
  });
});

describe('E and H — a link belongs to its row and to no other', () => {
  /** Two products on one lot. Same estate, same lot, different everything else. */
  const SMALL = {
    'Zz Doc': 'https://example.test/small-brochure.pdf',
    'Aa Plan': 'https://drive.google.com/drive/folders/FOLDER-small-001',
  };
  const LARGE = {
    'Zz Doc': 'https://example.test/large-brochure.pdf',
    'Aa Plan': 'https://drive.google.com/drive/folders/FOLDER-large-001',
  };

  it('two same-lot configurations share no branch', () => {
    const small = urls(branchesOf(SMALL));
    const large = urls(branchesOf(LARGE));
    expect(small.some((u) => large.includes(u))).toBe(false);
  });

  it('one row\'s state says nothing about another\'s', () => {
    const smallBranches = branchesOf(SMALL);
    let smallState: unknown = null;
    for (const branch of smallBranches) {
      smallState = writeBranchState(smallState, branch.url,
        recordNoDeterministicImage(branchQuestion(branch, V, 'src:small'), 'nothing'));
    }
    expect(allBranchesTerminal(smallState, smallBranches, V, 'src:small')).toBe(true);

    // The large product's own branches are untouched by any of it — a branch is
    // looked up by URL, and its URLs are not in that map.
    const largeBranches = branchesOf(LARGE);
    expect(allBranchesTerminal(smallState, largeBranches, V, 'src:large')).toBe(false);
    expect(openBranches(smallState, largeBranches, V, 'src:large')).toHaveLength(2);
  });

  it('a hundred-row shape cannot cross-attribute, because nothing is shared', () => {
    // Every row is read from its own cells; there is no index by lot, address
    // or estate for a link to travel through.
    const rows = Array.from({ length: 100 }, (_, i) => ({
      'Aa': `https://example.test/row-${i}.pdf`,
    }));
    const all = rows.map((row) => urls(branchesOf(row)));
    expect(new Set(all.flat()).size).toBe(100);
    for (let i = 0; i < rows.length; i += 1) {
      expect(all[i]).toEqual([`https://example.test/row-${i}.pdf`]);
    }
  });
});

describe('F — a document with no photograph exhausts a branch, not a property', () => {
  const branches = branchesOf(FIVE_LINK_ROW);

  it('an honest "read it, nothing here" is terminal for that branch only', () => {
    const q = branchQuestion(branches[2], V, ANCHOR);
    const state = writeBranchState(null, branches[2].url,
      recordNoDeterministicImage(q, 'a location map; no photograph of this property'));
    expect(branchTerminal(state, branches[2], q)).toBe(true);
    expect(openBranches(state, branches, V, ANCHOR)).toHaveLength(4);
  });
});

describe('the stored shape carries every branch, and the old one still reads', () => {
  it('a record written before branches existed answers for its own link', () => {
    // Nothing has to be migrated: the legacy record names the branch it
    // belongs to, so it is read under that key and its attempts are kept.
    const legacy = {
      result: 'no_deterministic_image',
      provenance_version: V,
      package_reference: 'https://example.test/estate/map.pdf',
      source_anchor: ANCHOR,
      detail: 'nothing',
      checked_at: '2026-01-01T00:00:00.000Z',
    };
    const branch = branchesOf(FIVE_LINK_ROW)
      .find((b) => b.url === 'https://example.test/estate/map.pdf')!;
    expect(branchTerminal(legacy, branch, branchQuestion(branch, V, ANCHOR))).toBe(true);
    expect(readBranchState(legacy)[branch.url]).toEqual(legacy);
  });

  it('writing one branch leaves every other exactly as it was', () => {
    const first = writeBranchState(null, 'https://example.test/a.pdf', { keep: 'me' });
    const second = writeBranchState(first, 'https://example.test/b.pdf', { and: 'me' });
    expect(branchRecord(second, 'https://example.test/a.pdf')).toEqual({ keep: 'me' });
    expect(branchRecord(second, 'https://example.test/b.pdf')).toEqual({ and: 'me' });
  });

  it('clearing one branch clears only that one', () => {
    let state: unknown = writeBranchState(null, 'https://example.test/a.pdf', { keep: 'me' });
    state = writeBranchState(state, 'https://example.test/b.pdf', { drop: 'me' });
    state = writeBranchState(state, 'https://example.test/b.pdf', null);
    expect(branchRecord(state, 'https://example.test/a.pdf')).toEqual({ keep: 'me' });
    expect(branchRecord(state, 'https://example.test/b.pdf')).toBeNull();
  });

  it('nothing stored at all means every branch is open', () => {
    expect(readBranchState(null)).toEqual({});
    expect(openBranches(null, branchesOf(FIVE_LINK_ROW), V, ANCHOR)).toHaveLength(5);
  });
});

describe('the traversal walks branches, and the old rule is gone', () => {
  const source = () => readSource(
    'supabase/functions/_shared/builderStock/repairSourceImages.ts');

  it('the singular-link rule no longer exists', () => {
    // Quoted in a comment as the evidence for why it went; gone from the code.
    const code = stripComments(source());
    expect(code).not.toContain('links.size === 1');
    expect(code).not.toContain('solePackageUrl');
  });

  it('one branch per tick, and the property comes back for the rest', () => {
    const body = source();
    expect(body).toContain('const openNow = openBranches(');
    expect(body).toContain('const branch = openNow[0];');
    // More than one left means the property is not done, whatever this branch
    // answers, so the run may not report itself finished on its behalf.
    expect(body).toContain('if (openNow.length > 1) outcome.incomplete = true;');
  });

  it('state is written per branch, never over the whole property', () => {
    const body = source();
    for (const write of [
      'writeBranchState(\n          negativeBefore.get(itemId), packageUrl, recordPackageUnprocessable(question))',
      'writeBranchState(negativeBefore.get(itemId), packageUrl,\n            provenanceAfterAttempt(branchBefore, question))',
      'writeBranchState(negativeBefore.get(itemId), packageUrl,\n          recordPackageAttempt(branchBefore, question))',
    ]) {
      expect(body).toContain(write);
    }
    // And a recovered photograph clears this branch alone.
    expect(body).toContain('writeBranchState(\n                negativeBefore.get(itemId), packageUrl, null)');
  });

  it('the heading travels onto the stored image as provenance', () => {
    expect(source()).toContain('source_column: branch.column');
    expect(source()).toContain('source_branch_kind: branch.kind');
  });

  it('no column name decides anything', () => {
    /*
     * String LITERALS are what a behavioural rule would be keyed on; the
     * imported `MAX_PACKAGE_ATTEMPTS` and friends are identifiers naming the
     * attempt policy this shares with the single-package path, and mean
     * nothing about a spreadsheet's headings.
     */
    const code = stripComments(readSource(
      'supabase/functions/_shared/builderStock/sourceBranches.pure.ts'));
    const literals = [...code.matchAll(/'([^']*)'/g)].map(([, l]) => l.toLowerCase());
    for (const forbidden of [
      'brochure', 'masterplan', 'package', 'plan of subdivision', 'rental appraisal',
      'downloads', 'property documents', 'plans', 'siting',
    ]) {
      expect(literals).not.toContain(forbidden);
    }
  });
});

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function readSource(relative: string): string {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { resolve } = require('node:path') as typeof import('node:path');
  return readFileSync(resolve(__dirname, '../../../', relative), 'utf8');
}
