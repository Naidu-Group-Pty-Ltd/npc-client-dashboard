/**
 * BUILDER STOCK — ONE PIECE OF LAND, SEVERAL HOUSES, SEVERAL PROPERTIES.
 *
 * THE REPORT, VERBATIM: "there was 125 in the list why is there only 95
 * showing up? If 125 is uploaded all 125 needs to be uploaded with their
 * photos."
 *
 * PRODUCTION, 4 SEPTEMBER 2026. Upload `96902003` recorded
 * `records_detected: 125`, `records_updated: 125`, `records_failed: 0` — and
 * owned ninety-five properties. Nothing errored, nothing was archived and
 * nothing was reported: thirty rows were written on top of another row and
 * ceased to exist.
 *
 * A HOUSE-AND-LAND LIST SELLS PACKAGES, NOT LOTS. The master stocklist offers
 * the same land with a choice of house, and those rows are different things a
 * buyer can buy:
 *
 *     Harlow 801    Cura 20B  $808,170  ·  Nex 20 $859,520  ·  Elara 18 $796,545
 *     Oaklands 117  Nex 20    $891,200  ·  Cura 20B $847,400 · Elara 18 $836,675
 *     Austin 1731   Vanta 20  $835,250  ·  Vanta 23 $882,050
 *
 * The importer's last match key is development + lot, so all three Harlow rows
 * keyed to `harlow|801`: the second updated the first, the third updated the
 * second, and which package survived on the marketplace was decided by nothing
 * better than its position in the file.
 *
 * THE SECOND HALF, AND THE MORE DANGEROUS ONE. `stockPropertyIdentity` has
 * always carried a `design` part — its own comment calls it "the part that
 * distinguishes seven rows sharing one lot" — but filled it only from the
 * brackets in a row's LABEL. This file states the design in a column, so the
 * identity read an empty design on both sides and the anchor guard could not
 * tell a Vanta 20 from a Vanta 23 either. That guard is what stops a
 * builder's photograph appearing on the wrong house, and against this file it
 * was blind: Lot 1731's brochure is the VANTA 23, and the row it would have
 * been attributed to was whichever of the two the file happened to end on.
 *
 * So the design joins the key and the identity, read from the column first and
 * the label second — the rule the identity already applies to the lot.
 *
 * Estates and lot numbers are the live file's; prices are as published.
 */
import { describe, expect, it } from 'vitest';

import { importStockRecords } from '../../../supabase/functions/_shared/builderStock/importStock';
import {
  designToken, developmentUnitMatchKey, normaliseStockRow, stockMatchKeys,
  storedRowDevelopmentUnitKey,
} from '../../../supabase/functions/_shared/builderStock/normalise.pure';
import {
  identityDifferences, stockPropertyIdentity,
} from '../../../supabase/functions/_shared/builderStock/stockIdentity.pure';

interface Row { [key: string]: unknown }

function fakeDb(seed: { items?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    builder_stock_items: [...(seed.items ?? [])],
    builder_stock_item_images: [],
    builder_stock_uploads: [],
  };
  let ids = 0;
  const nextId = () => `generated-${(ids += 1)}`;

  function from(table: string) {
    const rows = () => (tables[table] ??= []);
    const filters: Array<(row: Row) => boolean> = [];
    let pending:
      | { kind: 'update'; patch: Row }
      | { kind: 'insert'; written: Row[] }
      | null = null;
    /**
     * The JSON projections the read asked for, as `alias:source_row->>field`.
     *
     * THE FAKE HAS TO DO THIS OR THE TEST CANNOT SEE THE DEFECT. A stored row
     * carries its house design inside `source_row`, and the importer reads it
     * back the way it already reads the anchor — a scalar projected out of the
     * JSON by PostgREST. A fake that ignores the projection hands the matcher
     * an undefined design for every stored row, so a re-import of the very
     * same file matches nothing and inserts duplicates — which is a bug in the
     * fake that looks exactly like a bug in the importer.
     */
    let projections: Array<[string, string]> = [];

    const settle = (): Row[] => {
      const matched = rows().filter((row) => filters.every((f) => f(row)));
      if (pending?.kind === 'update') {
        for (const row of matched) Object.assign(row, pending.patch);
        return matched;
      }
      if (pending?.kind === 'insert') return pending.written;
      if (!projections.length) return matched;
      return matched.map((row) => {
        const projected: Row = { ...row };
        for (const [alias, field] of projections) {
          const source = row.source_row as Row | null | undefined;
          projected[alias] = source && typeof source === 'object' ? source[field] ?? null : null;
        }
        return projected;
      });
    };

    const api: Record<string, unknown> = {
      select(columns?: unknown) {
        projections = [...String(columns ?? '')
          .matchAll(/(\w+):source_row->>(\w+)/g)]
          .map((match) => [match[1], match[2]] as [string, string]);
        return api;
      },
      order() { return api; },
      range(from: number, to: number) {
        return Promise.resolve(api as never).then((page: { data?: Row[]; error?: unknown }) => ({
          data: (page?.data ?? []).slice(from, to + 1), error: page?.error ?? null,
        }));
      },
      limit() { return api; },
      in() { return api; },
      or() { return api; },
      not() { return api; },
      is() { return api; },
      eq(column: string, value: unknown) {
        filters.push((row) => row[column] === value);
        return api;
      },
      insert(payload: Row | Row[]) {
        const list = Array.isArray(payload) ? payload : [payload];
        const written = list.map((row) => ({ id: nextId(), ...row }));
        rows().push(...written);
        pending = { kind: 'insert', written };
        return api;
      },
      update(patch: Row) {
        pending = { kind: 'update', patch };
        return api;
      },
      single() { return Promise.resolve({ data: settle()[0] ?? null, error: null }); },
      maybeSingle() { return Promise.resolve({ data: settle()[0] ?? null, error: null }); },
      then(onResolved: (value: { data: Row[]; error: null }) => unknown) {
        return Promise.resolve(onResolved({ data: settle(), error: null }));
      },
    };
    return api;
  }
  return { from, tables };
}

const ORG = 'org-a';

/** A row of the master stocklist, in its own column names. */
function packageRow(over: Row = {}) {
  return {
    Estate: 'Harlow',
    'Lot #': '801',
    Location: 'Tarneit',
    'House Design': 'Cura 20B',
    'Land Size (m2)': '350',
    'Package Price': '808170',
    ...over,
  };
}

function runImport(db: ReturnType<typeof fakeDb>, rows: Row[], uploadId = 'upload-1') {
  return importStockRecords(db as never, {
    organisationId: ORG,
    uploadId,
    builderUserId: 'user-1',
    rows,
    media: [],
  });
}

const itemsIn = (db: ReturnType<typeof fakeDb>) => db.tables.builder_stock_items;

describe('the match key', () => {
  it('separates the three houses offered on Harlow 801', () => {
    const keys = ['Cura 20B', 'Nex 20', 'Elara 18'].map((design) => {
      const record = normaliseStockRow(packageRow({ 'House Design': design }));
      const key = stockMatchKeys(record!).developmentUnit;
      expect(key).not.toBeNull();
      return developmentUnitMatchKey(key!);
    });

    expect(new Set(keys).size).toBe(3);
  });

  it('keys a row that names no design exactly as a list without the column does', () => {
    const withColumn = normaliseStockRow(packageRow({ 'House Design': '' }));
    const withoutColumn = normaliseStockRow({
      Estate: 'Harlow', 'Lot #': '801', Location: 'Tarneit', 'Land Size (m2)': '350',
    });

    const a = stockMatchKeys(withColumn!).developmentUnit;
    const b = stockMatchKeys(withoutColumn!).developmentUnit;

    expect(a).not.toBeNull();
    expect(developmentUnitMatchKey(a!)).toBe(developmentUnitMatchKey(b!));
  });

  it('reads a hand-typed design and its double space as one house', () => {
    expect(designToken('Vanta  23')).toBe(designToken('Vanta 23'));
    expect(designToken(' VANTA 23 ')).toBe('vanta 23');
    expect(designToken(null)).toBe('');
  });

  it('builds the key in one place, so no caller can spell it differently', () => {
    expect(developmentUnitMatchKey({ development: 'harlow', unit: '801', design: 'nex 20' }))
      .toBe('harlow|801|nex 20');
  });
});

/*
 * THE KEY FOR A ROW WE ALREADY HOLD.
 *
 * Two modules build it: the importer, which decides whether a row is a new
 * property, and the image-attachment path, which decides whose photograph a
 * document's picture is. They had a copy each, and a mutation that dropped
 * the design from the second one alone was killed by NOTHING — which is the
 * shape of the wrong-house defect this repository fears most. One function
 * now, and these are its terms.
 */
describe('the key for a stored row', () => {
  const harlow = { development_name: 'Harlow', lot_number: '801' };

  it('separates the packages held on one lot', () => {
    const cura = storedRowDevelopmentUnitKey({ ...harlow, house_design: 'Cura 20B' });
    const nex = storedRowDevelopmentUnitKey({ ...harlow, house_design: 'Nex 20' });

    expect(cura).not.toBeNull();
    expect(cura).not.toBe(nex);
  });

  it('reads the design from the projected alias OR the stored record', () => {
    // The importer projects the scalar and never reads the blob; the repair
    // path reads the record whole. One function has to serve both.
    const projected = storedRowDevelopmentUnitKey({ ...harlow, house_design: 'Nex 20' });
    const fromRecord = storedRowDevelopmentUnitKey({
      ...harlow, source_row: { house_design: 'Nex 20' },
    });

    expect(projected).toBe(fromRecord);
  });

  it('agrees with the key built from the row the file states', () => {
    const record = normaliseStockRow(packageRow({ 'House Design': 'Nex 20' }));
    const fromFile = developmentUnitMatchKey(stockMatchKeys(record!).developmentUnit!);
    const fromStore = storedRowDevelopmentUnitKey({
      development_name: 'Harlow', lot_number: '801', source_row: { house_design: 'Nex 20' },
    });

    // The two sides of every re-import. If they disagree the importer inserts
    // duplicates for ever and the repair path attributes to the wrong row.
    expect(fromStore).toBe(fromFile);
  });

  it('still refuses a row missing either half', () => {
    expect(storedRowDevelopmentUnitKey({ development_name: 'Harlow' })).toBeNull();
    expect(storedRowDevelopmentUnitKey({ lot_number: '801' })).toBeNull();
  });
});

describe('the property identity', () => {
  it('takes the design from the column, which is where this file states it', () => {
    const vanta20 = stockPropertyIdentity(
      normaliseStockRow(packageRow({
        Estate: 'Austin Estate', 'Lot #': '1731', 'House Design': 'Vanta 20',
      }))!,
    );
    const vanta23 = stockPropertyIdentity(
      normaliseStockRow(packageRow({
        Estate: 'Austin Estate', 'Lot #': '1731', 'House Design': 'Vanta 23',
      }))!,
    );

    expect(vanta20.design).toBeTruthy();
    expect(vanta20.design).not.toBe(vanta23.design);
    /*
     * The guard that keeps a builder's photograph on the right house. Before
     * the column was read, both identities carried an empty design and this
     * answered "same property" — which is how the Vanta 23 brochure could
     * have been attributed to the Vanta 20.
     */
    expect(identityDifferences(vanta20, vanta23)).toContain('design');
  });

  it('still reads the design out of a label when there is no column', () => {
    const identity = stockPropertyIdentity(
      normaliseStockRow({ Property: 'Lot 60941 - Cloverton Estate [Vanta 23]' })!,
    );
    expect(identity.design).toBeTruthy();
  });

  it('treats a design the new file stops stating as absent, never as changed', () => {
    const stated = stockPropertyIdentity(normaliseStockRow(packageRow())!);
    const silent = stockPropertyIdentity(
      normaliseStockRow(packageRow({ 'House Design': '' }))!,
    );
    // "Absence is not a difference" — a thinner file has not moved the house.
    expect(identityDifferences(stated, silent)).toEqual([]);
  });
});

describe('importing the packages on one lot', () => {
  it('writes a property per package rather than one that overwrites the rest', async () => {
    const db = fakeDb();

    const outcome = await runImport(db, [
      packageRow({ 'House Design': 'Cura 20B', 'Package Price': '808170' }),
      packageRow({ 'House Design': 'Nex 20', 'Package Price': '859520' }),
      packageRow({ 'House Design': 'Elara 18', 'Package Price': '796545' }),
    ]);

    expect(outcome.imported).toBe(3);
    expect(outcome.updated).toBe(0);
    expect(itemsIn(db)).toHaveLength(3);

    // And each one keeps its own price, which is what a buyer is choosing between.
    const prices = itemsIn(db).map((row) => Number(row.price)).sort((a, b) => a - b);
    expect(prices).toEqual([796545, 808170, 859520]);
  });

  it('counts every row it claims to have written', async () => {
    const db = fakeDb();

    const outcome = await runImport(db, [
      packageRow({ 'House Design': 'Cura 20B' }),
      packageRow({ 'House Design': 'Nex 20' }),
      packageRow({ 'House Design': 'Elara 18' }),
    ]);

    /*
     * THE COUNTER IS WHAT MADE THIS INVISIBLE. `updated` is incremented per
     * ROW, so three rows landing on one property reported three writes and
     * left one. Detected must equal what the table actually holds.
     */
    expect(outcome.imported + outcome.updated).toBe(itemsIn(db).length);
  });

  it('matches each package to itself when the same file is uploaded again', async () => {
    const db = fakeDb();
    await runImport(db, [
      packageRow({ 'House Design': 'Cura 20B', 'Package Price': '808170' }),
      packageRow({ 'House Design': 'Nex 20', 'Package Price': '859520' }),
    ]);
    const firstIds = itemsIn(db).map((row) => row.id).sort();

    const outcome = await runImport(db, [
      packageRow({ 'House Design': 'Cura 20B', 'Package Price': '812000' }),
      packageRow({ 'House Design': 'Nex 20', 'Package Price': '859520' }),
    ], 'upload-2');

    // Updated in place: the row id is what a property's photographs point at,
    // so a re-import that inserted instead would strand every one of them.
    expect(outcome.updated).toBe(2);
    expect(outcome.imported).toBe(0);
    expect(itemsIn(db).map((row) => row.id).sort()).toEqual(firstIds);

    /*
     * The repriced package is matched to ITS OWN row, and the new price waits
     * in `pending_patch` for the cutover rather than being served beside the
     * other package's old membership — the staging rule, working as designed.
     * What matters here is WHICH row it landed on.
     */
    const cura = itemsIn(db).find(
      (row) => (row.source_row as Row | undefined)?.house_design === 'Cura 20B',
    );
    const nex = itemsIn(db).find(
      (row) => (row.source_row as Row | undefined)?.house_design === 'Nex 20',
    );
    expect(Number((cura?.pending_patch as Row | undefined)?.price)).toBe(812000);
    expect(Number((nex?.pending_patch as Row | undefined)?.price)).toBe(859520);
  });

  it('leaves a list that names no design matching exactly as it did', async () => {
    const db = fakeDb();
    const plain = { Estate: 'Timbarra', 'Lot #': '521', Location: 'Beveridge', Price: '640000' };

    await runImport(db, [plain]);
    const outcome = await runImport(db, [{ ...plain, Price: '645000' }], 'upload-2');

    expect(outcome.updated).toBe(1);
    expect(itemsIn(db)).toHaveLength(1);
  });
});
