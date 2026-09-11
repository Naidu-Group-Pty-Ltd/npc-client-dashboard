/**
 * Builder stock — "deleting a stock list left its properties behind".
 *
 * MEASURED 11 SEPTEMBER 2026 on the live deployment. Kopi Jantan Builders
 * holds thirteen active properties. Every one of them was first imported by
 * `a0f8dfe4` and is CURRENTLY supplied by `85f2b0bf`. Deleting the older list
 * therefore archives nothing and retains all thirteen — which is the rule in
 * this module working exactly as designed.
 *
 * What the builder was told was:
 *
 *     Stock list deleted
 *     0 properties were removed from the marketplace.
 *
 * …while thirteen properties stayed on the page. The outcome message was
 * composed inline at the call site and reported `archived` alone;
 * `describeSourceDeletion`, which was written for precisely this and already
 * knew about the retained ones, HAD NO CALLER ANYWHERE. Same shape as
 * `archive_stock_item` and `revoke_grant`: the rule exists, nothing asks it.
 *
 * So a correct delete read as a broken one, and the only thing missing was
 * the sentence explaining it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  describeSourceDeletion, itemsToArchiveOnSourceDelete, shouldArchiveOnSourceDelete,
} from '../../../supabase/functions/_shared/builderStock/sourceDeletion.pure';

const PAGE = readFileSync(join(process.cwd(),
  'src/pages/builder/BuilderStockList.tsx'), 'utf8');

/** The live shape: thirteen properties, older list deleted. */
const KOPI_JANTAN = Array.from({ length: 13 }, (_, i) => ({
  id: `item-${i}`,
  upload_id: '85f2b0bf',      // the list currently supplying them
  first_upload_id: 'a0f8dfe4', // the list being deleted
  lifecycle_status: 'active',
}));

describe('the rule itself is right and stays right', () => {
  it('archives nothing when a newer list supplies the stock', () => {
    expect(itemsToArchiveOnSourceDelete(KOPI_JANTAN, 'a0f8dfe4')).toEqual([]);
  });

  it('archives all thirteen when the CURRENT supplier is deleted', () => {
    expect(itemsToArchiveOnSourceDelete(KOPI_JANTAN, '85f2b0bf')).toHaveLength(13);
  });

  it('never archives on first_upload_id alone, which is the whole distinction', () => {
    expect(shouldArchiveOnSourceDelete(KOPI_JANTAN[0], 'a0f8dfe4')).toBe(false);
  });
});

describe('and the builder is now TOLD why nothing moved', () => {
  it('names the retained properties instead of reporting a bare zero', () => {
    const said = describeSourceDeletion(
      { archived: 0, retainedBecauseResupplied: 13, affectedSelections: 0 }, 'past');
    expect(said).toContain('0 properties were removed from the marketplace');
    // The half that was missing, and the reason the delete looked broken.
    expect(said).toContain('13 properties stayed because a newer stock list supplies them');
  });

  it('reads as an outcome after the act and a warning before it', () => {
    const summary = { archived: 2, retainedBecauseResupplied: 1, affectedSelections: 0 };
    expect(describeSourceDeletion(summary, 'past')).toContain('2 properties were removed');
    expect(describeSourceDeletion(summary)).toContain('2 properties will be removed');
    // Default is unchanged, so the confirmation copy cannot shift under it.
    expect(describeSourceDeletion(summary)).toBe(describeSourceDeletion(summary, 'future'));
  });

  it('still counts a single property in the singular', () => {
    const said = describeSourceDeletion(
      { archived: 1, retainedBecauseResupplied: 1, affectedSelections: 1 }, 'past');
    expect(said).toContain('1 property was removed');
    expect(said).toContain('1 property stayed because a newer stock list supplies it');
    expect(said).toContain('1 property has already been selected for a buyer');
  });

  it('says nothing about selections or retention when there are none', () => {
    const said = describeSourceDeletion(
      { archived: 4, retainedBecauseResupplied: 0, affectedSelections: 0 }, 'past');
    expect(said).toBe('4 properties were removed from the marketplace.');
  });
});

describe('the page asks the rule rather than composing its own sentence', () => {
  it('calls describeSourceDeletion for the outcome', () => {
    expect(PAGE).toContain('describeSourceDeletion({');
    expect(PAGE).toContain("}, 'past')");
  });

  it('no longer writes the archived-only sentence inline', () => {
    // The exact string that hid the retained count.
    expect(PAGE).not.toContain('properties were removed from the marketplace.`');
    expect(PAGE).not.toContain("'1 property was removed from the marketplace.'");
  });

  it('passes every count the rule needs, so none can be silently dropped', () => {
    const start = PAGE.indexOf('describeSourceDeletion({');
    const call = PAGE.slice(start, PAGE.indexOf("'past')", start));
    for (const field of ['archived', 'retainedBecauseResupplied', 'affectedSelections']) {
      expect(call, `the toast must pass ${field}`).toContain(field);
    }
  });
});
