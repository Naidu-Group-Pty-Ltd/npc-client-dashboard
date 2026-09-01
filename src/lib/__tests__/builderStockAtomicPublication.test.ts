/**
 * BUILDER STOCK — THE PUBLISHED DATASET STAYS THE PUBLISHED DATASET.
 *
 * WHAT THE FIRST CUT OF SAFE PUBLICATION GOT WRONG. Staging the new rows makes
 * MEMBERSHIP safe: an added property is invisible until cutover, a removed one
 * keeps standing. It does nothing at all about VALUES.
 *
 * #2347 updates a matched property IN PLACE, which is exactly what preserves
 * its earned imagery — and `writablePatch` writes price, availability,
 * description, land and building size, bedrooms, everything, onto a row whose
 * `lifecycle_status` is `active`. The Marketplace serves that row. So the
 * instant a replacement list is imported, a client sees:
 *
 *     Property A   NEW price, NEW availability     (from the replacement)
 *     Property B   still present                   (old membership)
 *     Property C   absent                          (old membership)
 *
 * A HYBRID DATASET. Some new values, some old membership, published, while the
 * replacement is still being processed and might never finish. The product rule
 * is not "current photographs remain visible" — it is that the current
 * published dataset remains the current dataset until the replacement is ready.
 *
 * THE FIX IS A PENDING PATCH, NOT A SECOND INVENTORY. A matched row's new
 * values are written to `pending_patch` — a jsonb column nothing serves — and
 * the row's own columns are left exactly as they are. The cutover applies every
 * patch, promotes the staged rows and archives the removed ones in one
 * statement. The row id never changes, so image attribution is untouched and
 * the property's earned imagery never has to be rebuilt.
 */
import { describe, expect, it } from 'vitest';
import {
  importStockRecords,
} from '../../../supabase/functions/_shared/builderStock/importStock';

const ORG = 'org-a';

// ---------------------------------------------------------------------------
// A store, so the Marketplace's own read can be run against the result
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function stockDb(seed: Row[]) {
  const items: Row[] = seed.map((row) => ({ ...row }));
  const uploads: Row[] = [
    { id: 'upload-1', organisation_id: ORG, replaces_upload_ids: [] },
    { id: 'upload-2', organisation_id: ORG, replaces_upload_ids: [] },
  ];
  /*
   * The imagery A and B have already earned. Seeded because the import settles
   * primaries for real — imagery is deliberately NOT deferred, so a builder
   * photograph arriving before the cutover becomes the card's picture. Without
   * these rows the selection would find nothing and write null, and the test
   * would be measuring a starved fake rather than the rule.
   */
  const images: Row[] = [
    { id: 'image-A', stock_item_id: 'item-A', organisation_id: ORG,
      source_stage: 'uploaded_document', verification_status: 'source_supplied',
      processing_status: 'ready', position: 0, storage_path: 'a.jpg', external_url: null,
      source_detail: { role: 'primary_property', marketplace_eligibility_state: 'eligible',
        marketplace_eligibility_version: 99 } },
    { id: 'image-B', stock_item_id: 'item-B', organisation_id: ORG,
      source_stage: 'uploaded_document', verification_status: 'source_supplied',
      processing_status: 'ready', position: 0, storage_path: 'b.jpg', external_url: null,
      source_detail: { role: 'primary_property', marketplace_eligibility_state: 'eligible',
        marketplace_eligibility_version: 99 } },
  ];
  let nextId = items.length + 1;

  const table = (name: string) => (name === 'builder_stock_items' ? items
    : name === 'builder_stock_item_images' ? images : uploads);

  const db: any = {
    items, uploads, images,
    /** The Marketplace's own visibility gate, and nothing else. */
    marketplace() {
      return items.filter((row) => row.lifecycle_status === 'active');
    },
    /*
     * The anchor as the SCHEMA holds it. Seeded rows carry it as a column for
     * readability; a row the importer inserts carries it inside `source_row`,
     * because `builder_stock_items` has no `source_anchor` column — which is
     * exactly why #2347 has to project it out of the JSON.
     */
    anchorOf(row: Row): string | null {
      const stored = (row.source_row ?? {}) as Record<string, unknown>;
      return (row.source_anchor as string | null) ?? (stored.source_anchor as string | null) ?? null;
    },
    card(anchor: string) {
      return db.marketplace().find((row: Row) => db.anchorOf(row) === anchor) ?? null;
    },
    row(anchor: string) {
      return db.items.find((row: Row) => db.anchorOf(row) === anchor) ?? null;
    },
    from(name: string) {
      const state: any = { filters: [] as Array<[string, string, unknown]> };
      /*
       * `is` IS A FILTER, and a double that ignores one lets a write reach
       * rows the server would never have handed it. This one returned the
       * builder unchanged, so an `.is('primary_image_id', null)` narrowed
       * nothing and the test agreed with code the database would have
       * disagreed with — the exact shape this repository has already paid for
       * once, with an `.or()` emulated by a regex.
       */
      const matches = (row: Row) => state.filters.every(([op, column, value]: [string, string, unknown]) => {
        if (op === 'in') return (value as unknown[]).includes(row[column]);
        if (op === 'is') return (row[column] ?? null) === value;
        return row[column] === value;
      });
      const builder: any = {
        select() { return builder; },
        eq(c: string, v: unknown) { state.filters.push(['eq', c, v]); return builder; },
        in(c: string, v: unknown) { state.filters.push(['in', c, v]); return builder; },
        or() { return builder; }, not() { return builder; }, neq() { return builder; },
        is(c: string, v: unknown) { state.filters.push(['is', c, v]); return builder; },
        order() { return builder; }, limit() { return builder; },
        // A paged read asks for one page at a time, because the API caps every
        // response at `db-max-rows` however large a `.limit()` it is given.
        range(from: number, to: number) {
          return Promise.resolve(builder as any).then((page: any) => ({ data: (page?.data ?? []).slice(from, to + 1), error: page?.error ?? null }));
        },
        maybeSingle() { return Promise.resolve({ data: table(name).find(matches) ?? null, error: null }); },
        insert(payload: Row) { state.insert = payload; return builder; },
        update(payload: Row) { state.update = payload; return builder; },
        upsert() { return builder; },
        delete() { return builder; },
        single() {
          if (state.update) {
            const row = table(name).find(matches);
            if (row) Object.assign(row, state.update);
            return Promise.resolve({ data: row ?? null, error: null });
          }
          const row: Row = { id: `new-${nextId++}`, ...(state.insert ?? {}) };
          table(name).push(row);
          return Promise.resolve({ data: row, error: null });
        },
        then(resolve: any, reject?: any) {
          if (state.update) {
            for (const row of table(name).filter(matches)) Object.assign(row, state.update);
            return Promise.resolve({ data: null, error: null }).then(resolve, reject);
          }
          return Promise.resolve({ data: table(name).filter(matches), error: null })
            .then(resolve, reject);
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

/** The published dataset before the replacement arrives. */
const PUBLISHED: Row[] = [
  {
    id: 'item-A', organisation_id: ORG, upload_id: 'upload-1', first_upload_id: 'upload-1',
    lifecycle_status: 'active', source_anchor: 'notion:A',
    address_line: 'Lot 43 - Tringa Street, Sandpiper Estate NSW',
    development_name: 'Sandpiper Estate', project_name: null,
    suburb: null, lot_number: null, unit_number: null, external_reference: null,
    building_size_sqm: '180.00', price: 800000, availability_status: 'available',
    description: 'The original description.',
    primary_image_id: 'image-A', pending_patch: null, pending_upload_id: null,
  },
  {
    id: 'item-B', organisation_id: ORG, upload_id: 'upload-1', first_upload_id: 'upload-1',
    lifecycle_status: 'active', source_anchor: 'notion:B',
    address_line: 'Lot 44 - Tringa Street, Sandpiper Estate NSW',
    development_name: 'Sandpiper Estate', project_name: null,
    suburb: null, lot_number: null, unit_number: null, external_reference: null,
    building_size_sqm: '190.00', price: 700000, availability_status: 'available',
    description: 'B as published.',
    primary_image_id: 'image-B', pending_patch: null, pending_upload_id: null,
  },
];

/**
 * The replacement list: A repriced and reserved, C brand new, B gone.
 */
const REPLACEMENT = [
  {
    Property: 'Lot 43 - Tringa Street, Sandpiper Estate NSW',
    Development: 'Sandpiper Estate', 'Building Size': '180',
    Price: '850000', Status: 'Reserved',
    Description: 'The replacement description.',
    npc_source_anchor: 'notion:A',
  },
  {
    Property: 'Lot 99 - Tringa Street, Sandpiper Estate NSW',
    Development: 'Sandpiper Estate', 'Building Size': '200',
    Price: '910000', Status: 'Available',
    npc_source_anchor: 'notion:C',
  },
];

function importReplacement(db: unknown) {
  return importStockRecords(db as never, {
    organisationId: ORG, uploadId: 'upload-2', builderUserId: 'builder-1',
    rows: REPLACEMENT as never, media: [], filename: 'replacement.csv',
    imageDeadlineAt: Date.now() - 1,
  } as never);
}

/**
 * The cutover, as `publish_builder_stock_upload` performs it — one statement,
 * modelled here so the AFTER state can be asserted without a database.
 */
function publish(db: ReturnType<typeof stockDb>, uploadId: string) {
  const replaces = (db.uploads.find((row: Row) => row.id === uploadId)
    ?.replaces_upload_ids ?? []) as string[];
  // 1. Apply every pending patch. Order matters: this re-points `upload_id`,
  //    which is what makes step 3 able to tell a removed property from a kept
  //    one.
  for (const row of db.items) {
    if (row.pending_upload_id !== uploadId || !row.pending_patch) continue;
    Object.assign(row, row.pending_patch as Row);
    // The three the SQL sets explicitly rather than reading from the patch.
    // `upload_id` is the load-bearing one: it is the membership change, and
    // step 3 archives by it, so a kept property that did not get re-pointed
    // here would be archived as though the new list had dropped it.
    row.upload_id = uploadId;
    row.last_seen_at = new Date().toISOString();
    row.pending_patch = null;
    row.pending_upload_id = null;
  }
  // 2. Promote this upload's staged rows.
  for (const row of db.items) {
    if (row.upload_id === uploadId && row.lifecycle_status === 'staged') {
      row.lifecycle_status = 'active';
    }
  }
  // 3. Archive what the superseded uploads still supply.
  for (const row of db.items) {
    if (row.lifecycle_status === 'active'
      && replaces.includes(row.upload_id as string)
      && row.upload_id !== uploadId) row.lifecycle_status = 'archived';
  }
}

// ---------------------------------------------------------------------------

describe('before publication, the Marketplace still serves the OLD dataset', () => {
  it('1. a matched property\'s new PRICE does not leak', async () => {
    const db = stockDb(PUBLISHED);
    await importReplacement(db);
    expect(db.card('notion:A')?.price).toBe(800000);
  });

  it('2. a matched property\'s new AVAILABILITY does not leak', async () => {
    const db = stockDb(PUBLISHED);
    await importReplacement(db);
    expect(db.card('notion:A')?.availability_status).toBe('available');
  });

  it('3. no other replacement scalar leaks either', async () => {
    const db = stockDb(PUBLISHED);
    await importReplacement(db);
    const a = db.card('notion:A');
    expect(a?.description).toBe('The original description.');
    expect(a?.building_size_sqm).toBe('180.00');
    // Membership is a value too: A is still supplied by the OLD upload until
    // the cutover, which is what lets the cutover tell removed from kept.
    expect(a?.upload_id).toBe('upload-1');
  });

  it('4. an ADDED property is invisible', async () => {
    const db = stockDb(PUBLISHED);
    await importReplacement(db);
    expect(db.card('notion:C')).toBeNull();
    // It exists, staged, and the image engine will work on it.
    expect(db.row('notion:C')?.lifecycle_status).toBe('staged');
  });

  it('5. a REMOVED property is still served', async () => {
    const db = stockDb(PUBLISHED);
    await importReplacement(db);
    expect(db.card('notion:B')).not.toBeNull();
    expect(db.card('notion:B')?.price).toBe(700000);
  });

  it('the published dataset is byte-for-byte what it was', async () => {
    /*
     * Compared over the columns the Marketplace actually reads. Four are
     * excluded, and each for a stated reason rather than to make this pass:
     *
     *   `pending_patch`, `pending_upload_id`  where the replacement's values
     *      are kept. Nothing serves them and their whole purpose is to change
     *      while the served row does not.
     *
     *   `source_row`, `enrichment_status`     the IMAGERY levers. They are
     *      deliberately applied at once, because a builder photograph arriving
     *      before the cutover should become the card's picture — an image
     *      appearing on a card that had none is the ladder doing its job, and
     *      `chooseCardImage` guarantees it can only ever be an improvement.
     *
     * Asserted below rather than merely dropped, so this cannot quietly become
     * the place a real leak hides.
     */
    const served = (row: Row) => {
      const {
        pending_patch: _p, pending_upload_id: _u,
        source_row: _s, enrichment_status: _e, ...rest
      } = row;
      return rest;
    };
    const before = JSON.stringify(stockDb(PUBLISHED).marketplace().map(served));
    const db = stockDb(PUBLISHED);
    await importReplacement(db);
    expect(JSON.stringify(db.marketplace().map(served))).toBe(before);

    // The four excluded fields, checked rather than assumed.
    const a = db.card('notion:A');
    expect(a?.pending_upload_id).toBe('upload-2');
    expect((a?.pending_patch as Row)?.price).toBe(850000);
    // The imagery levers DID move — that is the point of excluding them.
    expect((a?.source_row as Row)?.price).toBe(850000);
    expect(a?.enrichment_status).toBe('pending');
    // And not one served scalar did.
    expect(a?.price).toBe(800000);
    expect(a?.availability_status).toBe('available');
    expect(a?.primary_image_id).toBe('image-A');
  });

  /*
   * A RE-IMPORT MAKES AN IMAGE-LESS PROPERTY VISIBLE TO THE LADDER AGAIN.
   *
   * `enrichment_status` was never the only latch. `image_work_stage` is, and a
   * property that has been through the ladder once is left `settled` — which
   * the settler reads as "there is nothing further to try". So a re-import
   * that handed a property a document the reader had only just learned to see
   * updated its price and its sizes and then never looked at the document.
   *
   * The rule is the link recovery's own, in its own words: reopened only where
   * there is something to gain. A property that came through the import
   * holding a picture — its own, or one carried forward from the row it
   * matched — is left alone, because re-running the source stage for it would
   * spend a claim to reach the answer it already has.
   *
   * This is pipeline state and never property data, which is what the
   * byte-for-byte assertion above is for.
   */
  it('reopens the image ladder for a property with no picture, and only that one', async () => {
    const db = stockDb(PUBLISHED);
    for (const row of db.items) row.image_work_stage = 'settled';
    await importReplacement(db);

    // `notion:C` is new: it has no picture and nothing to carry one from.
    const added = db.row('notion:C');
    expect(added.primary_image_id ?? null).toBeNull();
    expect(added.image_work_stage).toBe('source');
    expect(added.image_work_claim_until).toBeNull();
    expect(added.image_work_next_attempt_at).toBeTruthy();

    // `notion:A` is re-stated by the new list and keeps the picture it had, so
    // nothing is re-asked about it.
    expect(db.row('notion:A').primary_image_id).toBe('image-A');
    expect(db.row('notion:A').image_work_stage).toBe('settled');

    // `notion:B` is absent from the new list — untouched, and not put back
    // into any queue by an import that never mentioned it.
    expect(db.row('notion:B').image_work_stage).toBe('settled');
  });
});

describe('6. a replacement that never becomes ready changes nothing, ever', () => {
  it('leaves every published value and the whole membership alone', async () => {
    const db = stockDb(PUBLISHED);
    await importReplacement(db);
    // Readiness is never reached: `publish` is simply never called, which is
    // what a stalled, killed or abandoned replacement looks like.
    expect(db.marketplace().map((row: Row) => db.anchorOf(row))).toEqual([
      'notion:A', 'notion:B',
    ]);
    expect(db.card('notion:A')?.price).toBe(800000);
    expect(db.card('notion:A')?.availability_status).toBe('available');
    expect(db.card('notion:C')).toBeNull();
  });
});

describe('7. publication changes values, additions and removals TOGETHER', () => {
  it('switches the whole dataset in one act', async () => {
    const db = stockDb(PUBLISHED);
    await importReplacement(db);
    publish(db, 'upload-2');

    const a = db.card('notion:A');
    expect(a?.price).toBe(850000);
    expect(a?.availability_status).toBe('reserved');
    expect(a?.description).toBe('The replacement description.');
    expect(a?.upload_id).toBe('upload-2');

    expect(db.card('notion:C')).not.toBeNull();
    expect(db.card('notion:B')).toBeNull();
    expect(db.marketplace().map((row: Row) => db.anchorOf(row)).sort())
      .toEqual(['notion:A', 'notion:C']);
  });

  it('8. and the matched property keeps the exact image it had earned', async () => {
    /*
     * The row id never changes, so nothing about image attribution moves: the
     * pending patch is applied to the SAME row that already holds
     * `primary_image_id`. That is the whole reason this is a patch rather than
     * a replacement row — a swap would strand the imagery on the old id and the
     * property would have to rebuild it.
     */
    const db = stockDb(PUBLISHED);
    await importReplacement(db);
    publish(db, 'upload-2');
    expect(db.card('notion:A')?.id).toBe('item-A');
    expect(db.card('notion:A')?.primary_image_id).toBe('image-A');
  });
});

describe('9. a changed exact identity never inherits the old imagery', () => {
  it('becomes a new staged property instead of patching the old one', async () => {
    const db = stockDb(PUBLISHED);
    await importStockRecords(db as never, {
      organisationId: ORG, uploadId: 'upload-2', builderUserId: 'builder-1',
      rows: [{
        // Same anchor, DIFFERENT lot. #2347 refuses the carry-forward.
        Property: 'Lot 77 - Tringa Street, Sandpiper Estate NSW',
        Development: 'Sandpiper Estate', 'Building Size': '180',
        Price: '850000', npc_source_anchor: 'notion:A',
      }] as never,
      media: [], filename: 'replacement.csv', imageDeadlineAt: Date.now() - 1,
    } as never);

    // The published A is untouched — no patch, no promotion, no imagery moved.
    expect(db.card('notion:A')?.price).toBe(800000);
    expect(db.card('notion:A')?.primary_image_id).toBe('image-A');
    // And the replacement is a separate, staged, image-less property.
    const replacement = db.items.find((row: Row) =>
      row.lifecycle_status === 'staged'
      && row.address_line === 'Lot 77 - Tringa Street, Sandpiper Estate NSW');
    expect(replacement).toBeTruthy();
    expect(replacement?.primary_image_id ?? null).toBeNull();
  });
});
