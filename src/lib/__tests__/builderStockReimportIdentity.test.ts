/**
 * BUILDER STOCK — A RE-IMPORT MUST NOT EMPTY THE MARKETPLACE, AND MUST NOT
 * MOVE A PHOTOGRAPH ONTO A DIFFERENT HOUSE.
 *
 * PRODUCTION, 16-29 AUGUST 2026. The same Notion stock list was imported eight
 * times. Every single time, `updated` was ZERO and twenty-three brand-new rows
 * were inserted — because `stockMatchKeys` can only match on a builder
 * reference, or on a development AND a lot/unit column, and not one row of that
 * list carries any of the three: the lot lives inside the title, "Lot 60941 -
 * Cloverton Estate, Kalkallo VIC 3064". So no key existed, everything inserted,
 * and when the operator then deleted the previous upload, every photograph the
 * pipeline had spent hours earning was archived with the rows that held it.
 * That is what "all the images disappeared again" was, every time.
 *
 * `source_anchor` was there the whole while: 69 of 69 rows across the last
 * three uploads carry one, 23 distinct values, exactly 3 copies each. It is a
 * complete and stable identity for a property across re-imports.
 *
 * BUT AN ANCHOR NAMES A ROW, NOT A PROPERTY. A person can edit that row in
 * Notion, or re-use it for the next lot in the estate. Updating in place purely
 * because a row id matched would hand the new property every photograph the old
 * one earned — shown on a client's card, badged "Builder supplied", of a
 * different house. That is the worst defect this pipeline could ship, so the
 * anchor gets us to a candidate and the property identity decides whether to
 * keep it.
 *
 * The identity is built from rules this repository ALREADY uses to attribute a
 * builder's package to a property — `lotAndDesignFrom`, `streetAddressFrom` —
 * never a new heuristic.
 */
import { describe, expect, it } from 'vitest';
import {
  normaliseStockRow, stockMatchKeys,
} from '../../../supabase/functions/_shared/builderStock/normalise.pure';
import {
  describeIdentityChange, identityDifferences, sameProperty, stockPropertyIdentity,
} from '../../../supabase/functions/_shared/builderStock/stockIdentity.pure';
import {
  importStockRecords,
} from '../../../supabase/functions/_shared/builderStock/importStock';

const ORG = 'org-a';

// ---------------------------------------------------------------------------
// The identity itself
// ---------------------------------------------------------------------------

/** A row as the live Notion list actually writes one. */
function liveRow(overrides: Record<string, unknown> = {}) {
  return {
    address_line: 'Lot 13 - Hummock Rise, Werribee, VIC',
    development_name: 'Hummock Rise',
    project_name: null,
    suburb: null,
    lot_number: null,
    unit_number: null,
    external_reference: null,
    building_size_sqm: 231,
    ...overrides,
  };
}

describe('what makes two rows the same property', () => {
  it('reads the lot out of the label when the columns are empty, as the live list requires', () => {
    const identity = stockPropertyIdentity(liveRow());
    expect(identity.lot).toBe('13');
    // `streetAddressFrom` knows a house-and-land row states its street number
    // AS its lot number. That rule is reused here, not re-invented.
    expect(identity.street).toBe('13 hummock rise');
  });

  it('prefers an explicit lot column over the label when the file fills one', () => {
    expect(stockPropertyIdentity(liveRow({ lot_number: '77' })).lot).toBe('77');
  });

  it('treats a repriced, resized-land, newly-reserved row as the same property', () => {
    // None of these is identity. A builder editing them must never cost a
    // property its photographs — that is the failure this change exists to end.
    const before = stockPropertyIdentity(liveRow());
    const after = stockPropertyIdentity(liveRow());
    expect(sameProperty(liveRow(), liveRow())).toBe(true);
    expect(identityDifferences(before, after)).toEqual([]);
  });

  it('does NOT treat a different lot as the same property', () => {
    const before = stockPropertyIdentity(liveRow());
    const after = stockPropertyIdentity(liveRow({
      address_line: 'Lot 14 - Hummock Rise, Werribee, VIC',
    }));
    expect(identityDifferences(before, after)).toContain('lot');
    expect(samePropertyOf(before, after)).toBe(false);
  });

  it('does NOT treat a different street address as the same property', () => {
    const before = stockPropertyIdentity(liveRow({
      address_line: 'Lot 208 - 46 Satinwood Crescent Donnybrook VIC',
    }));
    const after = stockPropertyIdentity(liveRow({
      address_line: 'Lot 208 - 44 Satinwood Crescent Donnybrook VIC',
    }));
    expect(identityDifferences(before, after)).toContain('street');
  });

  it('does NOT treat a different house design as the same property', () => {
    // The design is exactly what `selectPackageDocument` matches a PDF on, so a
    // changed design means the package we attributed is the wrong document.
    const before = stockPropertyIdentity(liveRow({
      address_line: 'Lot 51 - Tringa Street, Sandpiper Estate NSW [Bishop 258]',
    }));
    const after = stockPropertyIdentity(liveRow({
      address_line: 'Lot 51 - Tringa Street, Sandpiper Estate NSW [Stradbroke 180]',
    }));
    expect(before.design).toBe('bishop 258');
    expect(after.design).toBe('stradbroke 180');
    expect(identityDifferences(before, after)).toContain('design');
  });

  it('separates the two production rows that share one lot and differ only by size', () => {
    /*
     * THE CASE THAT PUT BUILDING SIZE IN THE IDENTITY. Both of these are live:
     * same estate, same lot 60941, same land size, and the bracket carries a
     * bed count and an area rather than a design name — which the design regex
     * correctly declines to read as a design. Without the floor area they are
     * one property, and one of them inherits the other's photograph.
     */
    const a = stockPropertyIdentity(liveRow({
      address_line: 'Lot 60941 - Cloverton Estate, Kalkallo VIC 3064 [3 Bed · 140 m²]',
      development_name: 'Cloverton Estate Kalkallo VIC 3064 - Stocklands',
      building_size_sqm: '140.00',
    }));
    const b = stockPropertyIdentity(liveRow({
      address_line: 'Lot 60941 - Cloverton Estate, Kalkallo VIC 3064 [4 Bed · 154 m²]',
      development_name: 'Cloverton Estate Kalkallo VIC 3064 - Stocklands',
      building_size_sqm: '154.00',
    }));
    expect(a.design).toBe('');
    expect(b.design).toBe('');
    expect(identityDifferences(a, b)).toEqual(['buildingSize']);
  });

  it('reads 140 and "140.00" as one building size, because PostgREST returns the second', () => {
    expect(stockPropertyIdentity(liveRow({ building_size_sqm: 140 })).buildingSize)
      .toBe(stockPropertyIdentity(liveRow({ building_size_sqm: '140.00' })).buildingSize);
  });

  it('treats a part only ONE side states as agreement, not as a difference', () => {
    /*
     * A thinner file is the case the importer's whole patch rule is built
     * around — "an update never erases". A source that stopped printing the
     * design in its title has not moved the house, and requiring both sides to
     * state all five parts would re-derive every photograph in the marketplace
     * on every upload: the original disaster, reached the long way round.
     */
    const withDesign = stockPropertyIdentity(liveRow({
      address_line: 'Lot 51 - Tringa Street, Sandpiper Estate NSW [Bishop 258]',
    }));
    const without = stockPropertyIdentity(liveRow({
      address_line: 'Lot 51 - Tringa Street, Sandpiper Estate NSW',
    }));
    expect(identityDifferences(withDesign, without)).toEqual([]);
  });

  it('says what changed, in words an operator can act on', () => {
    expect(describeIdentityChange(['lot'])).toBe('a different lot or unit');
    expect(describeIdentityChange(['lot', 'street'])).toBe('a different lot or unit and street address');
    expect(describeIdentityChange([])).toBe('the same property');
  });
});

function samePropertyOf(a: ReturnType<typeof stockPropertyIdentity>, b: typeof a): boolean {
  return identityDifferences(a, b).length === 0;
}

// ---------------------------------------------------------------------------
// The match key
// ---------------------------------------------------------------------------

describe('the anchor as a match key', () => {
  it('is the only key the live list carries', () => {
    const record = normaliseStockRow({
      Property: 'Lot 13 - Hummock Rise, Werribee, VIC',
      Price: '850000',
      npc_source_anchor: 'notion:32ecabf9-2010-802d-bed3-fae241e875c1',
    } as never);
    const keys = stockMatchKeys(record!);
    // Both of the older keys are null for every row of the live list. That is
    // the whole reason eight imports produced eight fresh sets.
    expect(keys.reference).toBeNull();
    expect(keys.developmentUnit).toBeNull();
    expect(keys.anchor).toBe('notion:32ecabf9-2010-802d-bed3-fae241e875c1');
  });

  it('is null where the source stated no row id, so nothing is invented', () => {
    const record = normaliseStockRow({
      Property: 'Lot 13 - Hummock Rise, Werribee, VIC', Price: '850000',
    } as never);
    expect(stockMatchKeys(record!).anchor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The importer
// ---------------------------------------------------------------------------

interface StoredItem extends Record<string, unknown> {
  id: string;
  lifecycle_status: string;
  source_anchor: string | null;
}

/**
 * A database holding an organisation's existing stock, which records whether
 * each write was an UPDATE of a row (imagery survives) or an INSERT of a new
 * one (imagery does not exist yet).
 */
function dbHolding(existing: StoredItem[]) {
  const updated: Array<{ id: string; payload: Record<string, unknown> }> = [];
  const inserted: Array<Record<string, unknown>> = [];
  let nextId = existing.length + 1;

  const db: any = {
    updated, inserted,
    from(table: string) {
      const state: any = { filters: [] as Array<[string, unknown]> };
      const builder: any = {
        select() { return builder; },
        eq(column: string, value: unknown) { state.filters.push([column, value]); return builder; },
        or() { return builder; }, not() { return builder; }, neq() { return builder; },
        in() { return builder; }, is() { return builder; },
        order() { return builder; }, limit() { return builder; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        insert(payload: Record<string, unknown>) { state.insert = payload; return builder; },
        update(payload: Record<string, unknown>) { state.update = payload; return builder; },
        upsert() { return builder; },
        delete() { return builder; },
        single() {
          if (table !== 'builder_stock_items') return Promise.resolve({ data: { id: 'x' }, error: null });
          if (state.update) {
            const id = String(state.filters.find(([c]: [string, unknown]) => c === 'id')?.[1] ?? '');
            updated.push({ id, payload: state.update });
            return Promise.resolve({ data: { id }, error: null });
          }
          const row = { id: `new-${nextId++}`, ...(state.insert ?? {}) };
          inserted.push(row);
          return Promise.resolve({ data: row, error: null });
        },
        then(resolve: any, reject?: any) {
          const rows = table === 'builder_stock_items' ? existing : [];
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
    storage: {
      from: () => ({
        upload: () => Promise.resolve({ data: { path: 'p' }, error: null }),
        download: () => Promise.resolve({ data: null, error: { message: 'no' } }),
      }),
    },
  };
  return db;
}

const HELD: StoredItem = {
  id: 'item-1',
  lifecycle_status: 'active',
  source_anchor: 'notion:lot-13',
  external_reference: null,
  development_name: 'Hummock Rise',
  project_name: null,
  unit_number: null,
  lot_number: null,
  address_line: 'Lot 13 - Hummock Rise, Werribee, VIC',
  suburb: null,
  building_size_sqm: '231.00',
};

function importOne(db: unknown, row: Record<string, unknown>) {
  return importStockRecords(db as never, {
    organisationId: ORG, uploadId: 'upload-2', builderUserId: 'builder-1',
    rows: [row] as never, media: [], filename: 'stock.csv',
    imageDeadlineAt: Date.now() - 1,
  } as never);
}

describe('re-importing the same list', () => {
  it('UPDATES the property in place when the anchor and the property both match', async () => {
    const db = dbHolding([HELD]);
    const outcome = await importOne(db, {
      Property: 'Lot 13 - Hummock Rise, Werribee, VIC',
      Price: '865000',
      'Building Size': '231',
      npc_source_anchor: 'notion:lot-13',
    });

    // The row survives, so its image rows, its `primary_image_id` and its
    // provenance survive with it. THIS is the fix.
    expect(outcome.updated).toBe(1);
    expect(outcome.imported).toBe(0);
    expect(db.updated[0].id).toBe('item-1');
    expect(db.inserted).toHaveLength(0);
    expect(outcome.replacedProperties).toEqual([]);
    /*
     * And the new upload becomes the one supplying it, so deleting the OLD
     * upload archives nothing — `shouldArchiveOnSourceDelete` matches on
     * `upload_id` alone.
     *
     * SAFE PUBLICATION HOLDS THAT CHANGE BACK. `upload_id` is membership, and
     * membership is part of the published dataset: re-pointing it the instant
     * the file is imported would publish half a replacement. It travels in
     * `pending_patch` and is applied by the cutover — which is also what lets
     * the cutover tell a removed property from a kept one. The row itself
     * still survives, which is what this test is for.
     */
    expect(db.updated[0].payload.pending_upload_id).toBe('upload-2');
    expect(db.updated[0].payload.upload_id).toBeUndefined();
  });

  it('does NOT carry the old property forward when the LOT changed under the anchor', async () => {
    const db = dbHolding([HELD]);
    const outcome = await importOne(db, {
      Property: 'Lot 14 - Hummock Rise, Werribee, VIC',
      Price: '865000',
      'Building Size': '231',
      npc_source_anchor: 'notion:lot-13',
    });

    expect(outcome.updated).toBe(0);
    expect(outcome.imported).toBe(1);
    expect(db.updated).toHaveLength(0);
    // Both the lot AND the street number moved, because on a house-and-land row
    // the lot IS the street number — `streetAddressFrom`'s rule, reused here.
    expect(outcome.replacedProperties).toEqual([
      {
        label: expect.stringContaining('Lot 14'),
        reason: 'a different lot or unit and street address',
      },
    ]);
    // The row the anchor pointed at is untouched: it keeps its own
    // photographs. Whether it should still be offered is a question for
    // deleting its upload, not for a file that stopped mentioning it.
    expect(db.updated.map((u: { id: string }) => u.id)).not.toContain('item-1');
  });

  it('does NOT carry the old property forward when the ADDRESS changed under the anchor', async () => {
    const db = dbHolding([{
      ...HELD,
      address_line: 'Lot 208 - 46 Satinwood Crescent Donnybrook VIC',
      development_name: 'Peppercorn Hill',
    }]);
    const outcome = await importOne(db, {
      Property: 'Lot 208 - 44 Satinwood Crescent Donnybrook VIC',
      Development: 'Peppercorn Hill',
      Price: '920000',
      'Building Size': '231',
      npc_source_anchor: 'notion:lot-13',
    });

    expect(outcome.imported).toBe(1);
    expect(outcome.updated).toBe(0);
    expect(outcome.replacedProperties[0].reason).toBe('a different street address');
  });

  it('does NOT reuse an incompatible package when the DESIGN changed under the anchor', async () => {
    // A design change means `selectPackageDocument` would now match a
    // different PDF. Keeping the old row would keep the wrong document's
    // photograph.
    const db = dbHolding([{
      ...HELD,
      address_line: 'Lot 51 - Tringa Street, Sandpiper Estate NSW 2486 [Bishop 258]',
      development_name: 'Sandpiper Estate',
    }]);
    const outcome = await importOne(db, {
      Property: 'Lot 51 - Tringa Street, Sandpiper Estate NSW 2486 [Stradbroke 180]',
      Development: 'Sandpiper Estate',
      Price: '920000',
      'Building Size': '231',
      npc_source_anchor: 'notion:lot-13',
    });

    expect(outcome.imported).toBe(1);
    expect(outcome.updated).toBe(0);
    expect(outcome.replacedProperties[0].reason).toBe('a different house design');
  });

  it('never merges two properties that carry DIFFERENT anchors', async () => {
    // The two live Cloverton rows: same estate, same lot, same land, different
    // Notion rows. Nothing here may bring them together.
    const db = dbHolding([{
      ...HELD,
      source_anchor: 'notion:cloverton-a',
      address_line: 'Lot 60941 - Cloverton Estate, Kalkallo VIC 3064 [3 Bed · 140 m²]',
      development_name: 'Cloverton Estate Kalkallo VIC 3064 - Stocklands',
      building_size_sqm: '140.00',
    }]);
    const outcome = await importOne(db, {
      Property: 'Lot 60941 - Cloverton Estate, Kalkallo VIC 3064 [4 Bed · 154 m²]',
      Development: 'Cloverton Estate Kalkallo VIC 3064 - Stocklands',
      Price: '672000',
      'Building Size': '154',
      npc_source_anchor: 'notion:cloverton-b',
    });

    expect(outcome.imported).toBe(1);
    expect(outcome.updated).toBe(0);
    // Not an identity CHANGE — a different row entirely. Nothing to report.
    expect(outcome.replacedProperties).toEqual([]);
  });

  it('keeps the anchor pointed at the row a changed property became', async () => {
    /*
     * Two rows carrying one anchor inside a single file. The first replaces the
     * held property; the SECOND must be compared against what the anchor names
     * now, not against the property nobody is describing any more. Without the
     * bookkeeping this would insert twice and leave the file's own last word on
     * that anchor unrepresented.
     */
    const db = dbHolding([HELD]);
    const outcome = await importStockRecords(db as never, {
      organisationId: ORG, uploadId: 'upload-2', builderUserId: 'builder-1',
      rows: [
        {
          Property: 'Lot 14 - Hummock Rise, Werribee, VIC',
          Price: '865000', 'Building Size': '231',
          npc_source_anchor: 'notion:lot-13',
        },
        {
          Property: 'Lot 14 - Hummock Rise, Werribee, VIC',
          Price: '870000', 'Building Size': '231',
          npc_source_anchor: 'notion:lot-13',
        },
      ] as never,
      media: [], filename: 'stock.csv', imageDeadlineAt: Date.now() - 1,
    } as never);

    expect(outcome.imported).toBe(1);
    expect(outcome.updated).toBe(1);
    expect(db.updated[0].id).toBe(db.inserted[0].id);
    // Reported once — the second row is not a second replacement.
    expect(outcome.replacedProperties).toHaveLength(1);
  });

  it('does not revive a property somebody archived', async () => {
    const db = dbHolding([{ ...HELD, lifecycle_status: 'archived' }]);
    const outcome = await importOne(db, {
      Property: 'Lot 13 - Hummock Rise, Werribee, VIC',
      Price: '865000',
      'Building Size': '231',
      npc_source_anchor: 'notion:lot-13',
    });

    // An archived row is stock somebody deliberately removed. A later file
    // mentioning the same source row is not a reason to put it back.
    expect(outcome.imported).toBe(1);
    expect(outcome.updated).toBe(0);
  });

  it('prefers the NEWEST active row when the pre-fix history left several', async () => {
    /*
     * Eight uploads inserted eight sets, and only the sets whose upload was
     * deleted are archived — so an anchor can legitimately have several active
     * rows today. Refusing to match on that ambiguity would permanently
     * disable the key for exactly the properties it exists to rescue, so the
     * newest wins; the identity guard is what makes that safe.
     */
    const db = dbHolding([
      { ...HELD, id: 'item-old' },
      { ...HELD, id: 'item-new' },
    ]);
    const outcome = await importOne(db, {
      Property: 'Lot 13 - Hummock Rise, Werribee, VIC',
      Price: '865000',
      'Building Size': '231',
      npc_source_anchor: 'notion:lot-13',
    });

    expect(outcome.updated).toBe(1);
    expect(db.updated[0].id).toBe('item-new');
  });
});

describe('reading the organisation\'s existing stock', () => {
  it('refuses the import when the existing-stock read FAILS', async () => {
    /*
     * A READ THAT FAILED IS NOT AN ORGANISATION WITH NO STOCK. Every match key
     * is built from that one query, so an error swallowed here matches nothing
     * and inserts a duplicate of everything — the exact outcome this change
     * exists to end, reached by a different route.
     */
    const db = dbHolding([]);
    const inner = db.from;
    db.from = (table: string) => {
      const builder = inner(table);
      if (table !== 'builder_stock_items') return builder;
      builder.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: null, error: { message: 'connection reset' } }).then(resolve);
      return builder;
    };

    await expect(importOne(db, {
      Property: 'Lot 13 - Hummock Rise, Werribee, VIC',
      Price: '865000',
      npc_source_anchor: 'notion:lot-13',
    })).rejects.toThrow(/could not be read/i);
  });
});
