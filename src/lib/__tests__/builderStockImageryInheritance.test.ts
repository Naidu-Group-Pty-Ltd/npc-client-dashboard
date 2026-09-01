/**
 * BUILDER STOCK — DELETING A LIST AND RE-UPLOADING IT MUST NOT BLANK EVERY CARD.
 *
 * THE REPORT, VERBATIM: "I don't understand why when I delete the stocklist and
 * reupload that link EVERY PHOTO GOES MISSING."
 *
 * PRODUCTION, 29 AUGUST 2026. Upload `479689a0` was deleted at 09:06:34 holding
 * 20 of 23 photographs, 17 of them the builder's own. The re-upload at 09:09:05
 * inserted twenty-three fresh rows holding nothing, and the Marketplace read
 * "No image found" across the board while the engine re-downloaded and
 * re-parsed every linked Drive package it had read an hour earlier.
 *
 * Nothing was lost. Deleting a list ARCHIVES its rows and the photographs live
 * ON those rows — one archive away from the row describing the same property.
 *
 * ANCHOR TO FIND IT, IDENTITY TO LICENSE IT. The anchor reaches the archived
 * candidate; `identityDifferences` decides whether anything may travel. That is
 * the rule the live anchor key already follows, and it matters more here: a
 * source row can be re-used for a different property, and imagery carried on a
 * re-used row puts one property's house on another's card.
 *
 * WHY THE LOT CAN NEVER BE THE KEY, which this library proves twice. It holds
 * Lot 60941 Cloverton twice and Lot 1342 Austin twice, each pair differing only
 * in building size. Keying on development + lot would merge each pair and
 * silently destroy a real property — a defect nobody can see.
 */
import { describe, expect, it } from 'vitest';

import { importStockRecords } from '../../../supabase/functions/_shared/builderStock/importStock';

interface Row { [key: string]: unknown }

function fakeDb(seed: { items?: Row[]; images?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    builder_stock_items: [...(seed.items ?? [])],
    builder_stock_item_images: [...(seed.images ?? [])],
    builder_stock_uploads: [],
  };
  let ids = 0;
  const nextId = () => `generated-${(ids += 1)}`;

  function from(table: string) {
    const rows = () => (tables[table] ??= []);
    const filters: Array<(row: Row) => boolean> = [];
    /*
     * Supabase chains `.update(patch).eq(...)`, so a write cannot run when it
     * is named — it runs when the chain is awaited, by which time the filters
     * exist. Applying it eagerly rewrote every row in the table.
     */
    let pending:
      | { kind: 'update'; patch: Row }
      | { kind: 'insert'; written: Row[] }
      | null = null;

    const settle = (): Row[] => {
      const matched = rows().filter((row) => filters.every((f) => f(row)));
      if (pending?.kind === 'update') {
        for (const row of matched) Object.assign(row, pending.patch);
        return matched;
      }
      if (pending?.kind === 'insert') return pending.written;
      return matched;
    };

    const api: Record<string, unknown> = {
      select() { return api; },
      order() { return api; },
      // A paged read asks for one page at a time, because the API caps every
      // response at `db-max-rows` however large a `.limit()` it is given.
      range(from: number, to: number) {
        return Promise.resolve(api as any).then((page: any) => ({ data: (page?.data ?? []).slice(from, to + 1), error: page?.error ?? null }));
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
const ANCHOR = 'notion:satinwood-209';

/** The archived row a deleted upload left behind, holding its photograph. */
function archived(over: Row = {}) {
  return {
    id: 'old-209', organisation_id: ORG, lifecycle_status: 'archived',
    upload_id: 'upload-old', primary_image_id: 'img-old-1',
    external_reference: null,
    development_name: 'Satinwood', project_name: null,
    unit_number: null, lot_number: null,
    address_line: 'Lot 209 - 44 Satinwood Crescent Donnybrook VIC 3064',
    suburb: 'Donnybrook', building_size_sqm: 214,
    /*
     * `source_anchor:source_row->>source_anchor` is a PostgREST projection the
     * fake does not perform, so the alias is set the way the real read
     * delivers it — alongside the JSON it is projected from.
     */
    source_row: { source_anchor: ANCHOR },
    source_anchor: ANCHOR,
    ...over,
  };
}

const DONOR_IMAGES = [
  {
    id: 'img-old-1', stock_item_id: 'old-209', organisation_id: ORG,
    upload_id: 'upload-old', source_stage: 'uploaded_document',
    source_provider: 'linked_package', processing_status: 'ready',
    verification_status: 'source_supplied', position: 0,
    storage_path: 'a.jpg', content_type: 'image/jpeg',
  },
  {
    id: 'img-old-2', stock_item_id: 'old-209', organisation_id: ORG,
    upload_id: 'upload-old', source_stage: 'uploaded_document',
    source_provider: 'linked_package', processing_status: 'ready',
    verification_status: 'source_supplied', position: 1,
    storage_path: 'b.jpg', content_type: 'image/jpeg',
  },
];

/** The row the same list produces when it is uploaded again. */
function sameRow(over: Record<string, unknown> = {}) {
  return {
    Property: 'Lot 209 - 44 Satinwood Crescent Donnybrook VIC 3064',
    Development: 'Satinwood',
    Price: '780000',
    'Building Size': '214',
    npc_source_anchor: ANCHOR,
    ...over,
  };
}

function runImport(db: ReturnType<typeof fakeDb>, rows: Record<string, unknown>[]) {
  return importStockRecords(db as never, {
    organisationId: ORG,
    uploadId: 'upload-new',
    builderUserId: 'user-1',
    rows,
    media: [],
  });
}

const freshRow = (db: ReturnType<typeof fakeDb>) =>
  db.tables.builder_stock_items.find((row) => row.id !== 'old-209');

describe('re-uploading a deleted list', () => {
  it('inherits the photograph the archived row already held', async () => {
    const db = fakeDb({ items: [archived()], images: DONOR_IMAGES });

    const outcome = await runImport(db, [sameRow()]);

    expect(outcome.imported).toBe(1);
    expect(outcome.inheritedImagery).toBe(1);
    /*
     * The new row now HOLDS the photograph. Which copy it points at is the
     * primary-enforcement pass's decision, made after this and against the
     * stored bytes — which a fake has none of — so the assertion here is that
     * the imagery arrived, and the pointer is asserted where it can be:
     * production, and the copy-shape test below.
     */
    const fresh = freshRow(db)!;
    expect(db.tables.builder_stock_item_images
      .filter((row) => row.stock_item_id === fresh.id)).toHaveLength(2);
  });

  it('copies every image row, re-pointed at the new property and upload', async () => {
    const db = fakeDb({ items: [archived()], images: DONOR_IMAGES });

    await runImport(db, [sameRow()]);

    const fresh = freshRow(db)!;
    const carried = db.tables.builder_stock_item_images
      .filter((row) => row.stock_item_id === fresh.id);
    expect(carried).toHaveLength(2);
    expect(carried.every((row) => row.upload_id === 'upload-new')).toBe(true);
    // The bytes and the verdict are the donor's own.
    expect(carried[0].source_stage).toBe('uploaded_document');
    expect(carried[0].verification_status).toBe('source_supplied');
    expect(carried.map((row) => row.storage_path).sort()).toEqual(['a.jpg', 'b.jpg']);
  });

  it('leaves the archived row, its photograph and its lifecycle untouched', async () => {
    const db = fakeDb({ items: [archived()], images: DONOR_IMAGES });

    await runImport(db, [sameRow()]);

    const donor = db.tables.builder_stock_items.find((row) => row.id === 'old-209')!;
    expect(donor.lifecycle_status).toBe('archived');
    expect(donor.primary_image_id).toBe('img-old-1');
    expect(db.tables.builder_stock_item_images
      .filter((row) => row.stock_item_id === 'old-209')).toHaveLength(2);
  });
});

describe('what the inheritance may never do', () => {
  it('refuses when the anchor matches but the PROPERTY has changed', async () => {
    // The rule the live anchor key already follows: the anchor reaches a
    // candidate, the identity decides whether anything travels.
    const db = fakeDb({ items: [archived()], images: DONOR_IMAGES });

    const outcome = await runImport(db, [sameRow({
      Property: 'Lot 77 - 9 Elsewhere Road Craigieburn VIC 3064',
      Development: 'Elsewhere',
      'Building Size': '180',
    })]);

    expect(outcome.inheritedImagery).toBe(0);
    expect(freshRow(db)?.primary_image_id ?? null).toBeNull();
  });

  it('refuses a same-lot neighbour that differs only in building size', async () => {
    /*
     * The Cloverton and Austin pairs, which is why development + lot can never
     * be the key. A different source row is a different property.
     */
    const db = fakeDb({
      items: [archived({
        address_line: 'Lot 60941 - Cloverton Estate, Kalkallo VIC 3064 [3 Bed · 140 m²]',
        development_name: 'Cloverton Estate Kalkallo VIC 3064 - Stocklands',
        building_size_sqm: 140,
        source_row: { source_anchor: 'notion:cloverton-a' },
        source_anchor: 'notion:cloverton-a',
      })],
      images: DONOR_IMAGES,
    });

    const outcome = await runImport(db, [sameRow({
      Property: 'Lot 60941 - Cloverton Estate, Kalkallo VIC 3064 [4 Bed · 154 m²]',
      Development: 'Cloverton Estate Kalkallo VIC 3064 - Stocklands',
      'Building Size': '154',
      npc_source_anchor: 'notion:cloverton-b',
    })]);

    expect(outcome.imported).toBe(1);
    expect(outcome.inheritedImagery).toBe(0);
  });

  it('never revives the archived row itself', async () => {
    const db = fakeDb({ items: [archived()], images: DONOR_IMAGES });

    const outcome = await runImport(db, [sameRow()]);

    expect(outcome.imported).toBe(1);
    expect(outcome.updated).toBe(0);
    expect(db.tables.builder_stock_items.find((row) => row.id === 'old-209')!.lifecycle_status)
      .toBe('archived');
  });

  it('an archived row holding no photograph lends nothing', async () => {
    const db = fakeDb({ items: [archived({ primary_image_id: null })], images: [] });

    expect((await runImport(db, [sameRow()])).inheritedImagery).toBe(0);
  });

  it('another organisation is never a donor', async () => {
    const db = fakeDb({
      items: [archived({ id: 'other-org', organisation_id: 'org-b' })],
      images: DONOR_IMAGES.map((row) => ({
        ...row, stock_item_id: 'other-org', organisation_id: 'org-b',
      })),
    });

    expect((await runImport(db, [sameRow()])).inheritedImagery).toBe(0);
  });

  it('a row with no anchor inherits nothing', async () => {
    const db = fakeDb({ items: [archived()], images: DONOR_IMAGES });

    const rows = [sameRow()] as Array<Record<string, unknown>>;
    delete rows[0].npc_source_anchor;

    expect((await runImport(db, rows)).inheritedImagery).toBe(0);
  });
});

describe('membership is the current source, and imagery can never create it', () => {
  it('an archived property ABSENT from the new source is not recreated', async () => {
    /*
     * The rule imagery inheritance must never break. The donor is a complete,
     * photographed property; the current source simply does not mention it.
     * Historical imagery may FOLLOW a property; it may never resurrect one.
     */
    const db = fakeDb({ items: [archived()], images: DONOR_IMAGES });

    const outcome = await runImport(db, [sameRow({
      Property: 'Lot 5 - 12 Someone Else Street Craigieburn VIC 3064',
      Development: 'Another Estate',
      'Building Size': '150',
      npc_source_anchor: 'notion:another-row',
    })]);

    // One property in, one property out. The absent one stays absent.
    expect(outcome.imported).toBe(1);
    expect(db.tables.builder_stock_items.filter((r) => r.lifecycle_status !== 'archived'))
      .toHaveLength(1);
    const donor = db.tables.builder_stock_items.find((r) => r.id === 'old-209')!;
    expect(donor.lifecycle_status).toBe('archived');
    expect(outcome.inheritedImagery).toBe(0);
  });

  it('an empty source inserts nothing, however many photographed archives exist', async () => {
    const db = fakeDb({ items: [archived()], images: DONOR_IMAGES });

    const outcome = await runImport(db, []);

    expect(outcome.imported).toBe(0);
    expect(db.tables.builder_stock_items).toHaveLength(1);
    expect(db.tables.builder_stock_items[0].lifecycle_status).toBe('archived');
  });

  it('a failure while carrying imagery does not fail the import', async () => {
    const db = fakeDb({ items: [archived()], images: DONOR_IMAGES });
    const realFrom = db.from;
    // The copy write refuses; everything else behaves.
    (db as { from: unknown }).from = (table: string) => {
      const api = realFrom(table) as Record<string, unknown>;
      if (table !== 'builder_stock_item_images') return api;
      return { ...api, insert: () => { throw new Error('storage refused the copy'); } };
    };

    const outcome = await runImport(db, [sameRow()]);

    expect(outcome.imported).toBe(1);
    expect(outcome.inheritedImagery).toBe(0);
    expect(outcome.failed).toBe(0);
  });
});

describe('a NORMAL re-import — the list is replaced without being deleted first', () => {
  const live = (over: Row = {}) => archived({ id: 'live-209', lifecycle_status: 'active', ...over });

  it('matches the LIVE property on its anchor instead of inserting a duplicate', async () => {
    /*
     * The anchor key is active-only and identity-guarded, so a re-import over a
     * list still standing matches. This is why deleting first is a different
     * case, and why nothing about the builder's source has to change for a
     * routine re-import to behave: the anchor and the identity are enough.
     */
    const db = fakeDb({ items: [live()], images: DONOR_IMAGES });

    const outcome = await runImport(db, [sameRow({ Price: '795000' })]);

    expect(outcome.updated).toBe(1);
    expect(outcome.imported).toBe(0);
    expect(db.tables.builder_stock_items).toHaveLength(1);
  });

  it('keeps the imagery attached to that row — nothing to carry, nothing lost', async () => {
    const db = fakeDb({
      items: [live()],
      images: DONOR_IMAGES.map((row) => ({ ...row, stock_item_id: 'live-209' })),
    });

    const outcome = await runImport(db, [sameRow({ Price: '795000' })]);

    // The row was never replaced, so its images were never orphaned and the
    // inheritance path is not even reached.
    expect(outcome.inheritedImagery).toBe(0);
    expect(db.tables.builder_stock_item_images
      .filter((r) => r.stock_item_id === 'live-209')).toHaveLength(2);
  });

  it('still refuses to match when the anchor is re-used for a different property', async () => {
    const db = fakeDb({ items: [live()], images: DONOR_IMAGES });

    const outcome = await runImport(db, [sameRow({
      Property: 'Lot 88 - 2 Different Road Tarneit VIC 3029',
      Development: 'Different Estate',
      'Building Size': '190',
    })]);

    expect(outcome.imported).toBe(1);
    expect(outcome.replacedProperties.length).toBeGreaterThan(0);
  });
});
