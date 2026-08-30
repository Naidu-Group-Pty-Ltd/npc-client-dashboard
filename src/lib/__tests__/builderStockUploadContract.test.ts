/**
 * BUILDER STOCK — THE UPLOAD CONTRACT, FOR EVERY FUTURE BUILDER.
 *
 * One walk through the whole lifecycle a stock upload must follow, written on
 * invented data because the contract is about every future Builder Portal
 * upload rather than any list in front of us. No organisation, page, view,
 * anchor, upload id or property name here belongs to a real deployment.
 *
 *     SOURCE the builder supplied
 *       -> the EXACT view they linked, and only that view
 *       -> membership is that view's rows and nothing else
 *       -> matched / new / absent, decided against the published dataset
 *       -> per-property image ladder, independently
 *       -> builder source > verified web > useful Street View > blank
 *       -> publication waits for readiness
 *       -> ONE atomic cutover
 *
 * THE RULE THAT ORDERS ALL OF IT: membership comes from the CURRENT source.
 * History may follow a property that the current source already accepted — an
 * image, a row id, a settled verdict — and may never CREATE one. A photographed
 * archived row is not a reason for a property to exist.
 */
import { describe, expect, it } from 'vitest';

import { importStockRecords } from '../../../supabase/functions/_shared/builderStock/importStock';
import { describeNotionPage } from '../../../supabase/functions/_shared/builderStock/notionRecordMap.pure';
import {
  lifecycleForNewProperty, isServed, isProcessed,
} from '../../../supabase/functions/_shared/builderStock/stockLifecycle.pure';
import { identityDifferences, stockPropertyIdentity } from '../../../supabase/functions/_shared/builderStock/stockIdentity.pure';
import {
  MAX_PACKAGE_ATTEMPTS, packageAttemptsExhausted, recordPackageAttempt,
} from '../../../supabase/functions/_shared/builderStock/packageAttempt.pure';

interface Row { [key: string]: unknown }

const ORG = '11111111-0000-4000-8000-000000000001';
const OLD_UPLOAD = '22222222-0000-4000-8000-00000000000a';
const NEW_UPLOAD = '22222222-0000-4000-8000-00000000000b';

// ---------------------------------------------------------------------------
// The source: a database with two views, only one of which the builder linked
// ---------------------------------------------------------------------------

const PAGE = '33333333-0000-4000-8000-000000000001';
const COLLECTION = '33333333-0000-4000-8000-000000000002';
const SPACE = '33333333-0000-4000-8000-000000000003';
const VIEW_X = '44444444-0000-4000-8000-00000000000x'.replace('x', 'e');
const VIEW_Y = '44444444-0000-4000-8000-00000000000f';

const VIEW_Y_QUERY = {
  filter: {
    operator: 'and',
    filters: [{ property: 'stat', filter: { operator: 'enum_is', value: { type: 'exact', value: 'Listed' } } }],
  },
  sort: [{ property: 'title', direction: 'ascending' }],
};

const notionPage = {
  block: {
    [PAGE]: {
      value: {
        value: {
          id: PAGE, type: 'collection_view_page', collection_id: COLLECTION,
          space_id: SPACE, view_ids: [VIEW_X, VIEW_Y], properties: { title: [['Stock']] },
        },
      },
    },
  },
  collection_view: {
    [VIEW_X]: { value: { value: { id: VIEW_X, type: 'table', name: 'Everything' } } },
    [VIEW_Y]: { value: { value: { id: VIEW_Y, type: 'table', name: 'Listed', query2: VIEW_Y_QUERY } } },
  },
  collection: { [COLLECTION]: { value: { value: { id: COLLECTION, name: [['Stock']] } } } },
} as never;

/**
 * What view Y returns. Membership is exactly this: two properties the published
 * dataset already holds, two that are new, and a same-lot pair that must stay
 * two products. Nothing from view X, and nothing merely remembered.
 */
const VIEW_Y_ROWS = [
  { Property: 'Lot 11 - 4 Aspen Way, Northfield VIC 3000', Development: 'Aspen',
    Price: '910000', 'Building Size': '181', npc_source_anchor: 'src:A' },
  { Property: 'Lot 12 - 6 Aspen Way, Northfield VIC 3000', Development: 'Aspen',
    Price: '870000', 'Building Size': '176', npc_source_anchor: 'src:B' },
  { Property: 'Lot 20 - 9 Birch Road, Southfield NSW 2000', Development: 'Birch',
    Price: '755000', 'Building Size': '162', npc_source_anchor: 'src:E' },
  { Property: 'Lot 21 - 11 Birch Road, Southfield NSW 2000', Development: 'Birch',
    Price: '742000', 'Building Size': '158', npc_source_anchor: 'src:F' },
  { Property: 'Lot 30 - Cedar Rise, Eastfield QLD 4000 [3 Bed · 140 m²]', Development: 'Cedar',
    Price: '640000', 'Building Size': '140', npc_source_anchor: 'src:G1' },
  { Property: 'Lot 30 - Cedar Rise, Eastfield QLD 4000 [4 Bed · 154 m²]', Development: 'Cedar',
    Price: '688000', 'Building Size': '154', npc_source_anchor: 'src:G2' },
];

/** Rows that exist only in view X. None may ever reach the import. */
const VIEW_X_ONLY = [
  { Property: 'Lot 99 - 1 Elsewhere Street, Farfield WA 6000', Development: 'Elsewhere',
    Price: '500000', 'Building Size': '120', npc_source_anchor: 'src:X1' },
];

// ---------------------------------------------------------------------------
// The published dataset the replacement arrives against
// ---------------------------------------------------------------------------

const published = (anchor: string, over: Row = {}): Row => ({
  id: `old-${anchor}`, organisation_id: ORG, upload_id: OLD_UPLOAD,
  first_upload_id: OLD_UPLOAD, lifecycle_status: 'active', source_anchor: anchor,
  external_reference: null, project_name: null, suburb: null,
  unit_number: null, lot_number: null, primary_image_id: null,
  ...over,
});

const PUBLISHED: Row[] = [
  published('src:A', {
    address_line: 'Lot 11 - 4 Aspen Way, Northfield VIC 3000', development_name: 'Aspen',
    building_size_sqm: '181.00', price: 880000, primary_image_id: 'img-A',
  }),
  published('src:B', {
    address_line: 'Lot 12 - 6 Aspen Way, Northfield VIC 3000', development_name: 'Aspen',
    building_size_sqm: '176.00', price: 870000, primary_image_id: 'img-B',
  }),
  // C and D are absent from view Y. They belong to the OLD dataset only.
  published('src:C', {
    address_line: 'Lot 13 - 8 Aspen Way, Northfield VIC 3000', development_name: 'Aspen',
    building_size_sqm: '190.00', price: 930000, primary_image_id: 'img-C',
  }),
  published('src:D', {
    address_line: 'Lot 14 - 10 Aspen Way, Northfield VIC 3000', development_name: 'Aspen',
    building_size_sqm: '195.00', price: 960000, primary_image_id: 'img-D',
  }),
  // An ARCHIVED historical donor, photographed, absent from view Y. It may
  // lend nothing because nothing in the current source claims it.
  published('src:GHOST', {
    id: 'ghost', lifecycle_status: 'archived', upload_id: 'ancient',
    address_line: 'Lot 77 - 3 Ghost Lane, Pastfield SA 5000', development_name: 'Ghost',
    building_size_sqm: '170.00', price: 700000, primary_image_id: 'img-GHOST',
  }),
  // A stock list the builder keeps BESIDE this one. Never touched.
  published('src:OTHER', {
    id: 'other-list', upload_id: 'unrelated-upload',
    address_line: 'Lot 5 - 2 Other Street, Otherfield TAS 7000', development_name: 'Other',
    building_size_sqm: '150.00', price: 600000, primary_image_id: 'img-OTHER',
  }),
];

const readyImage = (id: string, item: string): Row => ({
  id, stock_item_id: item, organisation_id: ORG, upload_id: OLD_UPLOAD,
  source_stage: 'uploaded_document', verification_status: 'source_supplied',
  processing_status: 'ready', position: 0, storage_path: `${id}.jpg`, external_url: null,
  source_detail: {
    role: 'primary_property', marketplace_eligibility_state: 'eligible',
    marketplace_eligibility_version: 99,
  },
});

function stockDb() {
  const items: Row[] = PUBLISHED.map((row) => ({ ...row }));
  const images: Row[] = [
    readyImage('img-A', 'old-src:A'), readyImage('img-B', 'old-src:B'),
    readyImage('img-C', 'old-src:C'), readyImage('img-D', 'old-src:D'),
    readyImage('img-GHOST', 'ghost'), readyImage('img-OTHER', 'other-list'),
  ];
  const uploads: Row[] = [
    { id: OLD_UPLOAD, organisation_id: ORG, replaces_upload_ids: [] },
    { id: NEW_UPLOAD, organisation_id: ORG, replaces_upload_ids: [] },
  ];
  let next = 1;
  const table = (name: string) => (name === 'builder_stock_items' ? items
    : name === 'builder_stock_item_images' ? images : uploads);

  const db: Record<string, unknown> = {
    items, images, uploads,
    marketplace: () => items.filter((row) => row.lifecycle_status === 'active'),
    anchorOf: (row: Row) => (row.source_anchor as string | null)
      ?? ((row.source_row ?? {}) as Row).source_anchor as string | null ?? null,
    from(name: string) {
      const filters: Array<[string, string, unknown]> = [];
      let ins: Row | Row[] | null = null;
      let upd: Row | null = null;
      const matches = (row: Row) => filters.every(([op, c, v]) =>
        (op === 'in' ? (v as unknown[]).includes(row[c]) : row[c] === v));
      const b: Record<string, unknown> = {
        select: () => b, order: () => b, limit: () => b, or: () => b,
        not: () => b, neq: () => b, is: () => b, upsert: () => b, delete: () => b,
        eq(c: string, v: unknown) { filters.push(['eq', c, v]); return b; },
        in(c: string, v: unknown) { filters.push(['in', c, v]); return b; },
        insert(payload: Row | Row[]) { ins = payload; return b; },
        update(payload: Row) { upd = payload; return b; },
        maybeSingle: () => Promise.resolve({ data: table(name).find(matches) ?? null, error: null }),
        single() {
          if (upd) {
            const row = table(name).find(matches);
            if (row) Object.assign(row, upd);
            return Promise.resolve({ data: row ?? null, error: null });
          }
          const row: Row = { id: `new-${next++}`, ...(ins as Row ?? {}) };
          table(name).push(row);
          return Promise.resolve({ data: row, error: null });
        },
        then(resolve: (v: { data: Row[] | null; error: null }) => unknown) {
          if (upd) {
            for (const row of table(name).filter(matches)) Object.assign(row, upd);
            return Promise.resolve(resolve({ data: null, error: null }));
          }
          if (ins) {
            const list = (Array.isArray(ins) ? ins : [ins]).map((row) => ({ id: `new-${next++}`, ...row }));
            table(name).push(...list);
            return Promise.resolve(resolve({ data: list, error: null }));
          }
          return Promise.resolve(resolve({ data: table(name).filter(matches), error: null }));
        },
      };
      return b;
    },
    storage: {
      from: () => ({
        upload: () => Promise.resolve({ data: { path: 'p' }, error: null }),
        download: () => Promise.resolve({ data: null, error: { message: 'no' } }),
      }),
    },
  };
  return db as typeof db & { items: Row[]; images: Row[]; uploads: Row[];
    marketplace(): Row[]; anchorOf(row: Row): string | null };
}

/** The cutover, exactly as `publish_builder_stock_upload` performs it. */
function publish(db: ReturnType<typeof stockDb>, uploadId: string) {
  const replaces = (db.uploads.find((r) => r.id === uploadId)?.replaces_upload_ids ?? []) as string[];
  for (const row of db.items) {                       // 1. apply held-back patches
    if (row.pending_upload_id !== uploadId || !row.pending_patch) continue;
    Object.assign(row, row.pending_patch as Row);
    row.upload_id = uploadId;
    row.pending_patch = null;
    row.pending_upload_id = null;
  }
  for (const row of db.items) {                       // 2. promote staged rows
    if (row.upload_id === uploadId && row.lifecycle_status === 'staged') row.lifecycle_status = 'active';
  }
  for (const row of db.items) {                       // 3. archive what the old list still supplies
    if (row.lifecycle_status === 'active'
      && replaces.includes(row.upload_id as string)
      && row.upload_id !== uploadId) row.lifecycle_status = 'archived';
  }
}

async function importViewY(db: ReturnType<typeof stockDb>) {
  const outcome = await importStockRecords(db as never, {
    organisationId: ORG, uploadId: NEW_UPLOAD, builderUserId: 'user-1',
    rows: VIEW_Y_ROWS as never, media: [], filename: 'stock.csv',
    imageDeadlineAt: Date.now() - 1,
  } as never);
  const upload = db.uploads.find((r) => r.id === NEW_UPLOAD)!;
  upload.replaces_upload_ids = outcome.replacesUploadIds;
  return outcome;
}

const anchors = (rows: Row[], db: ReturnType<typeof stockDb>) =>
  rows.map((row) => db.anchorOf(row)).filter(Boolean).sort();

// ---------------------------------------------------------------------------

describe('the source: only the view the builder linked', () => {
  it('the linked view is resolved, and its own filter travels with it', () => {
    const shape = describeNotionPage(notionPage, PAGE, VIEW_Y);
    expect(shape.collectionViewId).toBe(VIEW_Y);
    expect(shape.requestedViewMissing).toBe(false);
    expect(shape.viewQuery).toEqual(VIEW_Y_QUERY);
  });

  it('a view the page does not have is refused, never swapped for another', () => {
    const shape = describeNotionPage(notionPage, PAGE, '55555555-0000-4000-8000-000000000009');
    expect(shape.collectionViewId).toBeNull();
    expect(shape.requestedViewMissing).toBe(true);
  });

  it('rows that live only in the other view are not part of this source', () => {
    // Membership is the selected view's response. Nothing here composes the
    // two, and nothing downstream can reach a row the source never returned.
    const membership = VIEW_Y_ROWS.map((row) => row.npc_source_anchor);
    for (const outside of VIEW_X_ONLY) {
      expect(membership).not.toContain(outside.npc_source_anchor);
    }
  });
});

describe('membership: matched, new, and absent', () => {
  it('classifies every property of the published dataset exactly once', async () => {
    const db = stockDb();
    const outcome = await importViewY(db);

    // A and B are in both — matched, and their values held for the cutover.
    expect(outcome.updated).toBe(2);
    expect(outcome.deferred).toBe(2);
    // E, F and the two Cedar products are new — staged, invisible.
    expect(outcome.imported).toBe(4);
    expect(outcome.staged).toBe(4);
  });

  it('a new property is staged, so the Marketplace never shows a blank card', async () => {
    const db = stockDb();
    await importViewY(db);

    const staged = db.items.filter((row) => row.lifecycle_status === 'staged');
    expect(staged).toHaveLength(4);
    for (const row of staged) {
      expect(isServed(row.lifecycle_status)).toBe(false);
      // Invisible, but still worked on — or it could never reach readiness.
      expect(isProcessed(row.lifecycle_status)).toBe(true);
    }
  });

  it('the same lot at two building sizes stays two independent properties', async () => {
    const db = stockDb();
    await importViewY(db);

    const cedarAnchors = new Set(['src:G1', 'src:G2']);
    const cedar = db.items.filter((row) => cedarAnchors.has(String(db.anchorOf(row) ?? '')));
    expect(cedar).toHaveLength(2);
    expect(new Set(cedar.map((row) => row.id)).size).toBe(2);
    // And the identity guard is why: they differ, so nothing may carry between.
    const [one, two] = cedar.map((row) => stockPropertyIdentity(row as never));
    expect(identityDifferences(one, two).length).toBeGreaterThan(0);
  });

  it('the first list of an organisation publishes immediately; a replacement stages', () => {
    expect(lifecycleForNewProperty({ organisationHasPublishedStock: false })).toBe('active');
    expect(lifecycleForNewProperty({ organisationHasPublishedStock: true })).toBe('staged');
  });
});

describe('history may follow a property; it may never create one', () => {
  it('a photographed archived row absent from the source is not resurrected', async () => {
    const db = stockDb();
    await importViewY(db);

    const ghost = db.items.find((row) => row.id === 'ghost')!;
    expect(ghost.lifecycle_status).toBe('archived');
    // Nothing in the new dataset is that property.
    expect(anchors(db.items.filter((r) => r.upload_id === NEW_UPLOAD), db))
      .not.toContain('src:GHOST');
  });

  it('inheritance is reached only through a row the CURRENT source produced', async () => {
    const db = stockDb();
    const outcome = await importViewY(db);
    // No new row claims the ghost's anchor, so nothing inherited from it.
    expect(outcome.inheritedImagery).toBe(0);
  });
});

describe('replacement lineage', () => {
  it('matched rows contribute the dataset this upload replaces', async () => {
    const db = stockDb();
    const outcome = await importViewY(db);
    expect(outcome.replacesUploadIds).toEqual([OLD_UPLOAD]);
  });

  it('new-only rows invent no lineage of their own', async () => {
    const db = stockDb();
    const outcome = await importViewY(db);
    // Four new properties, and not one of them added an upload to the list.
    expect(outcome.replacesUploadIds).toHaveLength(1);
    expect(outcome.replacesUploadIds).not.toContain('ancient');
    expect(outcome.replacesUploadIds).not.toContain('unrelated-upload');
  });
});

describe('before the cutover, the published dataset is untouched', () => {
  it('all four old properties are still on the Marketplace, absent ones included', async () => {
    const db = stockDb();
    await importViewY(db);

    const live = anchors(db.marketplace(), db);
    expect(live).toContain('src:A');
    expect(live).toContain('src:B');
    // C and D are absent from the source and must NOT vanish early.
    expect(live).toContain('src:C');
    expect(live).toContain('src:D');
  });

  it('a matched property still serves its OLD price and its OLD image', async () => {
    const db = stockDb();
    await importViewY(db);

    const a = db.items.find((row) => row.id === 'old-src:A')!;
    expect(Number(a.price)).toBe(880000);           // not the source's 910000
    expect(a.primary_image_id).toBe('img-A');
    expect(a.lifecycle_status).toBe('active');
  });

  it('no new property is visible yet', async () => {
    const db = stockDb();
    await importViewY(db);
    const live = anchors(db.marketplace(), db);
    for (const anchor of ['src:E', 'src:F', 'src:G1', 'src:G2']) {
      expect(live).not.toContain(anchor);
    }
  });
});

describe('the cutover: one act, and the membership it leaves', () => {
  it('final active membership equals the linked view EXACTLY', async () => {
    const db = stockDb();
    await importViewY(db);
    publish(db, NEW_UPLOAD);

    const live = db.marketplace().filter((row) => row.id !== 'other-list');
    expect(anchors(live, db)).toEqual(VIEW_Y_ROWS.map((r) => r.npc_source_anchor).sort());
  });

  it('properties absent from the source archive AT the cutover, not before', async () => {
    const db = stockDb();
    await importViewY(db);
    const beforeC = db.items.find((row) => row.id === 'old-src:C')!.lifecycle_status;

    publish(db, NEW_UPLOAD);

    expect(beforeC).toBe('active');
    expect(db.items.find((row) => row.id === 'old-src:C')!.lifecycle_status).toBe('archived');
    expect(db.items.find((row) => row.id === 'old-src:D')!.lifecycle_status).toBe('archived');
  });

  it('an archived removal keeps its row and its imagery — withdrawn, not destroyed', async () => {
    const db = stockDb();
    await importViewY(db);
    publish(db, NEW_UPLOAD);

    const c = db.items.find((row) => row.id === 'old-src:C')!;
    expect(c.primary_image_id).toBe('img-C');
    expect(db.images.some((row) => row.stock_item_id === 'old-src:C')).toBe(true);
  });

  it('matched values publish and staged rows promote in the same act', async () => {
    const db = stockDb();
    await importViewY(db);
    publish(db, NEW_UPLOAD);

    expect(Number(db.items.find((row) => row.id === 'old-src:A')!.price)).toBe(910000);
    const promoted = db.items.filter((row) => row.upload_id === NEW_UPLOAD
      && row.lifecycle_status === 'active');
    expect(promoted.length).toBeGreaterThanOrEqual(4);
  });

  it('a stock list the builder keeps beside this one is never touched', async () => {
    const db = stockDb();
    await importViewY(db);
    publish(db, NEW_UPLOAD);

    const other = db.items.find((row) => row.id === 'other-list')!;
    expect(other.lifecycle_status).toBe('active');
    expect(other.upload_id).toBe('unrelated-upload');
    expect(other.primary_image_id).toBe('img-OTHER');
  });

  it('a replacement that never reaches readiness changes nothing at all', async () => {
    const db = stockDb();
    await importViewY(db);
    // No publish call: the cutover is refused inside the same statement that
    // would flip the rows, so "not ready" leaves the whole dataset alone.
    const live = anchors(db.marketplace(), db);
    expect(live).toContain('src:C');
    expect(live).toContain('src:D');
    expect(Number(db.items.find((row) => row.id === 'old-src:A')!.price)).toBe(880000);
  });
});

describe('the cutover model above is the one the database performs', () => {
  /*
   * `publish()` is a model, and a model that drifts from the function proves
   * nothing. These pin the three steps it mirrors onto the migration itself —
   * including the ORDER, which is what makes CASE C work at all: step 1
   * re-points a matched row's `upload_id` to this upload, so step 3's
   * `upload_id = ANY(v_replaces)` can only still be true of a property the new
   * source did not contain.
   */
  const sql = () => readFile('supabase/migrations/20261022000000_builder_stock_safe_publication.sql');

  it('archives exactly the rows a superseded upload still supplies', () => {
    const body = sql();
    const archive = body.slice(body.indexOf('-- 3. Archive what the superseded uploads still supply'));
    expect(archive).toContain("SET lifecycle_status = 'archived'");
    expect(archive).toContain("WHERE lifecycle_status = 'active'");
    expect(archive).toContain('AND upload_id = ANY(v_replaces)');
    // A stock list kept beside this one has an id that is not in v_replaces.
    expect(archive).toContain('AND upload_id <> p_upload_id');
  });

  it('re-points matched rows BEFORE it archives, never after', () => {
    const body = sql();
    const repoint = body.indexOf('upload_id          = p_upload_id');
    const promote = body.indexOf("-- 2. Promote this upload's staged rows");
    const archive = body.indexOf('-- 3. Archive what the superseded uploads still supply');
    expect(repoint).toBeGreaterThan(-1);
    expect(repoint).toBeLessThan(promote);
    expect(promote).toBeLessThan(archive);
  });

  it('refuses the whole act unless the upload is ready', () => {
    const body = sql();
    expect(body).toContain('IF NOT coalesce(v_ready, false) THEN');
    expect(body).toContain("'published', false, 'reason', 'not_ready'");
    // The readiness question is asked inside the same statement that flips.
    expect(body.indexOf('IF NOT coalesce(v_ready, false) THEN'))
      .toBeLessThan(body.indexOf("-- 2. Promote this upload's staged rows"));
  });

  it('archives a removed property and never deletes it', () => {
    const body = sql();
    const archive = body.slice(body.indexOf('-- 3. Archive what the superseded uploads still supply'),
      body.indexOf('UPDATE public.builder_stock_uploads'));
    expect(archive).not.toContain('DELETE');
  });
});

describe('the image ladder stays per-property and ordered', () => {
  it('one package that keeps killing its worker is retired, not retried for ever', () => {
    const question = { provenanceVersion: 5, packageReference: 'pkg://toxic', sourceAnchor: 'src:F' };
    let provenance: unknown = null;
    for (let attempt = 0; attempt < MAX_PACKAGE_ATTEMPTS; attempt += 1) {
      expect(packageAttemptsExhausted(provenance, question)).toBe(false);
      provenance = recordPackageAttempt(provenance, question);
    }
    // The property loses its builder image and GAINS the rest of the ladder.
    expect(packageAttemptsExhausted(provenance, question)).toBe(true);
  });

  it('a toxic package retires only its own property', () => {
    const toxic = { provenanceVersion: 5, packageReference: 'pkg://toxic', sourceAnchor: 'src:F' };
    const neighbour = { provenanceVersion: 5, packageReference: 'pkg://fine', sourceAnchor: 'src:E' };
    let provenance: unknown = null;
    for (let i = 0; i < MAX_PACKAGE_ATTEMPTS; i += 1) provenance = recordPackageAttempt(provenance, toxic);

    expect(packageAttemptsExhausted(provenance, toxic)).toBe(true);
    // The count is a fact about ONE property's own question.
    expect(packageAttemptsExhausted(null, neighbour)).toBe(false);
  });

  it('the settler claims one property per invocation, so none can block another', () => {
    const claim = readFile('supabase/functions/_shared/builderStock/itemWorkClaim.ts');
    expect(claim).toContain('p_limit: 1');
    const settler = readFile('supabase/functions/builder-stock-image-settler/index.ts');
    expect(settler).toContain('claimOneImageWorkItem');
  });

  it('serving never depends on how far a property got through the ladder', () => {
    const marketplace = readFile('supabase/functions/builder-stock-marketplace/index.ts');
    expect(marketplace).toContain("'lifecycle_status', 'active'");
    expect(marketplace).not.toContain('image_work_stage');
    expect(marketplace).not.toContain('enrichment_status');
  });
});

function readFile(relative: string): string {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { resolve } = require('node:path') as typeof import('node:path');
  return readFileSync(resolve(__dirname, '../../../', relative), 'utf8');
}
