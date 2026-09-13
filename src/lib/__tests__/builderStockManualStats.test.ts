import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  MANUAL_STAT_FIELDS,
  applyManualStats,
  applyManualStatsToAll,
  manualStatFields,
  parseManualStats,
  readManualStats,
} from '../../../supabase/functions/_shared/builderStock/manualStats.pure';
import { STOCK_ITEM_SELECT } from '../../../supabase/functions/_shared/builderStock/projection.pure';
import { describeManualStats, type BuilderStockItem } from '@/lib/builderStock';

/**
 * THE FIGURES A BUILDER STATES THEMSELVES.
 *
 * `LOT 324 - NEX 20 - V002.pdf` imported with bedrooms, bathrooms, car spaces
 * and home size all null. The extraction had not failed — it had REFUSED: a
 * dual-key home is two self-contained dwellings, the brochure states two sets
 * of figures, and the model obeyed its first rule rather than inventing one
 * number. Measured on the prime, 54 of 57 PDF-sourced properties carry
 * bed/bath/car and all three that do not are that same shape.
 *
 * These tests pin the rules that make stating it safe.
 */

const CONTEXT = { recordedAt: '2026-09-13T02:00:00.000Z', recordedBy: 'user-1' };

describe('parsing what a builder typed', () => {
  it('takes the five figures, as numbers or as the text a form sends', () => {
    const { stats, errors } = parseManualStats(
      { bedrooms: 3, bathrooms: '2.5', car_spaces: ' 2 ', land_size_sqm: 350 },
      CONTEXT,
    );
    expect(errors).toEqual([]);
    expect(stats?.values).toEqual({
      bedrooms: 3, bathrooms: 2.5, car_spaces: 2, land_size_sqm: 350,
    });
    expect(stats?.recorded_by).toBe('user-1');
  });

  it('keeps ZERO, because a studio has no bedroom', () => {
    /*
     * The importer's own `set()` treats '' as absent, and inheriting that here
     * would make "no car space" unstateable — a townhouse with none would be
     * indistinguishable from one nobody had counted.
     */
    const { stats } = parseManualStats({ bedrooms: 0, car_spaces: 0 }, CONTEXT);
    expect(stats?.values).toEqual({ bedrooms: 0, car_spaces: 0 });
  });

  it('treats an empty box as withdrawing that correction, not as a zero', () => {
    const { stats } = parseManualStats(
      { bedrooms: 3, bathrooms: '', car_spaces: null, land_size_sqm: undefined },
      CONTEXT,
    );
    expect(stats?.values).toEqual({ bedrooms: 3 });
  });

  it('withdraws the whole override when every field is cleared', () => {
    const { stats, errors } = parseManualStats({ bedrooms: '', bathrooms: '' }, CONTEXT);
    expect(stats).toBeNull();
    expect(errors).toEqual([]);
  });

  it('REFUSES an out-of-range figure rather than clamping it', () => {
    // Clamping 3000 to 99 records a bedroom count nobody typed, on a card a
    // client reads — the same class as a fabricated price.
    const { stats, errors } = parseManualStats({ bedrooms: 3000 }, CONTEXT);
    expect(stats).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('bedrooms');
    expect(errors[0].message).toMatch(/between 0 and 99/);
  });

  it('admits half a bathroom and refuses half a bedroom', () => {
    // A powder room is 0.5 in an Australian listing; half a bedroom is a slip.
    expect(parseManualStats({ bathrooms: 2.5 }, CONTEXT).errors).toEqual([]);
    const rooms = parseManualStats({ bedrooms: 2.5 }, CONTEXT);
    expect(rooms.errors[0].message).toMatch(/whole number/);
  });

  it('refuses text that is not a number', () => {
    const { errors } = parseManualStats({ bedrooms: 'four' }, CONTEXT);
    expect(errors[0].message).toMatch(/must be a number/);
  });
});

describe('reading a stored override back', () => {
  it('drops a key that is not one of the five', () => {
    // The column is JSONB: an older version of this code, or a hand-run
    // statement, can put anything there. An arbitrary string must never reach
    // a card as a bedroom count.
    const stats = readManualStats({ values: { bedrooms: 3, price: 999, nonsense: 'x' } });
    expect(stats?.values).toEqual({ bedrooms: 3 });
  });

  it('drops a value that is not a finite number, and keeps zero', () => {
    const stats = readManualStats({ values: { bedrooms: 0, bathrooms: 'two', car_spaces: null } });
    expect(stats?.values).toEqual({ bedrooms: 0 });
  });

  it('answers null for anything that is not an override', () => {
    for (const stored of [null, undefined, 'x', 42, {}, { values: {} }]) {
      expect(readManualStats(stored)).toBeNull();
    }
  });
});

describe('laying the builder’s figures over the document’s', () => {
  const row = () => ({
    id: 'item-1', bedrooms: null, bathrooms: null, car_spaces: null,
    building_size_sqm: null, land_size_sqm: 350,
    manual_stats: { values: { bedrooms: 3, bathrooms: 2 }, recorded_at: null, recorded_by: null },
  });

  it('fills what the document left empty', () => {
    const applied = applyManualStats(row());
    expect(applied.bedrooms).toBe(3);
    expect(applied.bathrooms).toBe(2);
    // Untouched fields keep the document's reading.
    expect(applied.land_size_sqm).toBe(350);
    expect(applied.car_spaces).toBeNull();
  });

  it('KEEPS what the document said, so the override is reversible and visible', () => {
    const applied = applyManualStats({ ...row(), bedrooms: 4 });
    expect(applied.bedrooms).toBe(3);
    // The extraction is not destroyed — a surface shows a builder the reading
    // they disagreed with, and clearing the override returns to it.
    expect((applied as Record<string, unknown>).stated_bedrooms).toBe(4);
  });

  it('names which figures were stated', () => {
    expect(manualStatFields(row())).toEqual(['bedrooms', 'bathrooms']);
    expect(manualStatFields({ ...row(), manual_stats: null })).toEqual([]);
  });

  it('leaves a row with no override exactly as it arrived', () => {
    const plain = { id: 'x', bedrooms: 4, manual_stats: null };
    expect(applyManualStatsToAll([plain])[0]).toEqual({ ...plain, manual_stats: null });
  });
});

/**
 * THE RULE THE WHOLE FEATURE RESTS ON.
 *
 * `writablePatch` names bedrooms, bathrooms, car_spaces, building_size_sqm and
 * land_size_sqm, and writes each whenever the incoming file states anything at
 * all. A figure typed into those columns would survive a silent stock list and
 * be destroyed by the next one that speaks — the builder's deliberate
 * correction losing to the document it was correcting, which is exactly what a
 * repaired image used to suffer against a re-upload (#2347).
 */
describe('a re-import cannot reach a builder’s own figures', () => {
  const importer = () => readFileSync(
    join(process.cwd(), 'supabase/functions/_shared/builderStock/importStock.ts'), 'utf8',
  );
  const stripComments = (source: string) => source
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('writablePatch still names every column the override exists to outlive', () => {
    // A guard on the guard: if these stop being patched, the override column
    // is no longer load-bearing and this whole design should be revisited
    // rather than silently kept.
    const code = stripComments(importer());
    for (const field of MANUAL_STAT_FIELDS) {
      expect(code).toContain(`set('${field}'`);
    }
  });

  it('and never names manual_stats', () => {
    expect(stripComments(importer())).not.toContain('manual_stats');
  });
});

/**
 * The overlay happens in the ONE place both audiences pass through. A read
 * path that selects the projection without applying it serves the document's
 * reading to one screen while the other shows the builder's — two screens
 * disagreeing about one house.
 */
describe('every read path applies the overlay', () => {
  const READ_PATHS = [
    'supabase/functions/builder-portal-stock/index.ts',
    'supabase/functions/builder-stock-marketplace/index.ts',
  ];

  it('the projection publishes the column, in a select list of NOTHING BUT columns', () => {
    /*
     * `toContain('manual_stats')` is what this asserted first, and it PASSED
     * on a broken literal. The explanatory note had been written INSIDE the
     * template, which breaks two ways at once: a `/* … *\/` in a template
     * literal is TEXT that PostgREST receives as part of the select list, and
     * the backticks around a symbol name inside it terminated the string and
     * turned the rest into parsed code. Every stock read would have failed.
     * `check-edge-functions.mjs` caught it on TS2304; this catches the half
     * that is not a type error at all.
     */
    expect(STOCK_ITEM_SELECT).toContain('manual_stats');
    for (const entry of STOCK_ITEM_SELECT.split(',').map((part) => part.trim())) {
      expect(entry).not.toBe('');
      // A column, or a PostgREST alias like `house_design:source_row->>x`.
      expect(entry).toMatch(/^[a-z_]+(:[a-z_]+->>[a-z_]+)?$/);
    }
    // And the five the overlay needs are all still asked for.
    for (const field of MANUAL_STAT_FIELDS) {
      expect(STOCK_ITEM_SELECT.split(',').map((p) => p.trim())).toContain(field);
    }
  });

  it.each(READ_PATHS)('%s selects the projection and applies the overlay', (path) => {
    const source = readFileSync(join(process.cwd(), path), 'utf8');
    expect(source).toContain('STOCK_ITEM_SELECT');
    expect(source).toContain('applyManualStatsToAll(items)');
  });


});

/**
 * A CHECK CONSTRAINT PASSES ON NULL AND FAILS ONLY ON FALSE.
 *
 * The first version of the column's constraint opened with
 * `jsonb_typeof(manual_stats -> 'values') = 'object'`. On an object with no
 * `values` key, `->` is SQL NULL, so that comparison is NULL rather than
 * false, the whole `and` chain evaluates to NULL, and Postgres ACCEPTS the
 * row — every test after it skipped for the same reason. Probed against the
 * live constraint, `{"recorded_at":"x"}` stored without complaint.
 *
 * No reader was fooled (`readManualStats` answers null for it, which the cases
 * above pin), but a constraint that does not enforce what its own comment
 * claims is the shape this repo has been burned by before: asserted by
 * configuration rather than by effect.
 *
 * This pins the fix at the source, because the effect can only be measured
 * against a live database and CI has none.
 */
describe('the column\u2019s own constraint cannot be satisfied by a NULL', () => {
  /*
   * THE SQL, NOT THE PROSE ABOUT THE SQL. The migration's header quotes the
   * broken expression verbatim in order to explain it, so a check over the
   * raw file finds that quotation and reports the defect it documents — which
   * is how the ordering case below failed on correct SQL the first time it
   * ran. `--` comments go before anything is judged.
   */
  const migration = () => readFileSync(
    join(process.cwd(),
      'supabase/migrations/20261119170000_builder_stock_manual_stats.sql'),
    'utf8',
  ).replace(/^\s*--.*$/gm, '');

  it('asserts the `values` KEY is present, not merely that its type is object', () => {
    const sql = migration();
    // `?` is strictly true or false, so it cannot leak a NULL into the chain.
    expect(sql).toContain("manual_stats ? 'values'");
  });

  it('asserts presence BEFORE any expression that dereferences it', () => {
    const sql = migration();
    const presence = sql.indexOf("manual_stats ? 'values'");
    const firstDeref = sql.indexOf("jsonb_typeof(manual_stats -> 'values')");
    expect(presence).toBeGreaterThan(-1);
    expect(firstDeref).toBeGreaterThan(-1);
    // Order matters: `and` short-circuits left to right, so a dereference
    // above the presence test is a NULL reaching the chain again.
    expect(presence).toBeLessThan(firstDeref);
  });

  it('still admits a null column, which is what every existing row holds', () => {
    expect(migration()).toContain('manual_stats is null');
  });
});

describe('what the plate says about the figures', () => {
  const item = (over: Partial<BuilderStockItem> = {}) => ({
    id: 'item-1', bedrooms: null, bathrooms: null, car_spaces: null,
    building_size_sqm: null, land_size_sqm: 350, manual_stats: null, ...over,
  } as unknown as BuilderStockItem);

  it('names the figures the stock list did not state', () => {
    const reading = describeManualStats(item());
    expect(reading.missing).toEqual(['bedrooms', 'bathrooms', 'car_spaces', 'building_size_sqm']);
    // Named, never counted: "three figures are missing" sends somebody to
    // compare two lists to find out which three.
    expect(reading.note).toBe(
      'Not specified in your stock list: bedrooms, bathrooms, car spaces and home size.',
    );
    expect(reading.action).toBe('Complete the schedule');
  });

  it('names the figures the builder stated, and offers to edit', () => {
    const reading = describeManualStats(item({
      bedrooms: 3, bathrooms: 2, car_spaces: 2, building_size_sqm: 174,
      manual_stats: { values: { bedrooms: 3, bathrooms: 2 }, recorded_at: null, recorded_by: null },
    }));
    expect(reading.note).toBe('Supplied by you: bedrooms and bathrooms.');
    expect(reading.action).toBe('Update the schedule');
  });

  it('says both, where some are stated and some are still absent', () => {
    const reading = describeManualStats(item({
      bedrooms: 3,
      manual_stats: { values: { bedrooms: 3 }, recorded_at: null, recorded_by: null },
    }));
    // Two conditions, two sentences — never one run-on joined by a middot.
    expect(reading.note).toBe(
      'Not specified in your stock list: bathrooms, car spaces and home size.'
      + ' Supplied by you: bedrooms.',
    );
  });

  it('says nothing where the stock list stated everything', () => {
    const reading = describeManualStats(item({
      bedrooms: 3, bathrooms: 2, car_spaces: 2, building_size_sqm: 174,
    }));
    expect(reading.note).toBeNull();
    expect(reading.action).toBe('Update the schedule');
  });

  it('counts a stated ZERO as stated', () => {
    // The reason this is its own test: `0` is falsy, and a reading that used
    // truthiness would tell a studio's owner their bedroom count is missing
    // every time they looked at it.
    const reading = describeManualStats(item({
      bedrooms: 0, bathrooms: 1, car_spaces: 0, building_size_sqm: 52,
    }));
    expect(reading.missing).toEqual([]);
    expect(reading.note).toBeNull();
  });
});
