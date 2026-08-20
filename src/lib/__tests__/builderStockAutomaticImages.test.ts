/**
 * Builder stock — the builder's photograph must arrive WITHOUT anybody asking.
 *
 * WHAT WAS WRONG, MEASURED IN PRODUCTION. Lot 537 Kirramingly Avenue's card
 * read "No image found" while the correct facade sat in the builder's own PDF
 * and the extractor could identify it byte for byte. The only way to get the
 * picture onto the card was the Builder Portal's "Source images" button, which
 * runs `reprocess_source_images`. That is a maintenance operation, and normal
 * operation had come to depend on it.
 *
 * THE PIPELINE STOPPED IN TWO PLACES, both of them after extraction:
 *
 *   1. THE IMPORT NEVER SETTLED A PRIMARY. `importStockRecords` stored the
 *      image rows and stopped. `primary_image_id` was only ever written by
 *      `enrichStockItem` — a stage-2/3 provider loop — and by the manual
 *      repair. Storing an image nobody points at is the same as not storing it.
 *   2. THAT LOOP SKIPS MOST OF THE WORK IT IS ASKED TO DO. `enrich_images`
 *      selects `enrichment_status in ('pending','enriching')`, and an import
 *      never put a property back into that state. So re-importing a source
 *      updated the property, attached a better image, and left the pointer
 *      alone; and an item that once ended `failed` — which is what every
 *      pre-role property became the moment the role rule shipped — was never
 *      looked at again by anything automatic.
 *
 * These pin the end-to-end contract: import → stored bytes → role →
 * `primary_image_id` → displayable, with no operator step anywhere in it.
 */
import { describe, expect, it } from 'vitest';

import {
  annotatedPicture, cleanPicture, jpegOf, pngOf,
} from './fixtures/builderStockPictures';

import { importStockRecords } from '../../../supabase/functions/_shared/builderStock/importStock';
import { extractStockFile } from '../../../supabase/functions/_shared/builderStock/extract';
import { classifyStockFile } from '../../../supabase/functions/_shared/builderStock/fileTypes.pure';
import {
  chooseDisplayableImage,
} from '../../../supabase/functions/_shared/builderStock/primaryImage';
import { SOURCE_ANCHOR_HEADER } from '../../../supabase/functions/_shared/builderStock/sourceAssets.pure';
import { PROVENANCE_VERSION } from '../../../supabase/functions/_shared/builderStock/sourceImages';
import { MARKETPLACE_ELIGIBILITY_VERSION } from '../../../supabase/functions/_shared/builderStock/marketplaceEligibility.pure';
import { SANITIZATION_VERSION } from '../../../supabase/functions/_shared/builderStock/sanitizedDerivative.pure';
import {
  runSettlementTick, settleUploadSourceImages, uploadsNeedingSettlement,
  type SettlementCandidate,
} from '../../../supabase/functions/_shared/builderStock/settleSourceImages';
import {
  roleFromStructuralContainer,
} from '../../../supabase/functions/_shared/builderStock/sourceImageRole.pure';

// ---------------------------------------------------------------------------
// An in-memory stand-in for the service-role client
// ---------------------------------------------------------------------------

interface Row { [key: string]: unknown }

function fakeDb(seed: { items?: Row[]; uploads?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    builder_stock_items: [...(seed.items ?? [])],
    builder_stock_item_images: [],
    builder_stock_uploads: [...(seed.uploads ?? [])],
    builder_projects: [],
    builder_units: [],
  };
  const stored: Record<string, { bytes: Uint8Array; contentType: string }> = {};
  let autoId = 0;

  const matches = (row: Row, filters: Array<[string, string, unknown]>) =>
    filters.every(([op, column, value]) => {
      if (op === 'eq') return row[column] === value;
      if (op === 'neq') return row[column] !== value;
      if (op === 'is') return row[column] === value || (value === null && row[column] == null);
      if (op === 'in') return Array.isArray(value) && value.includes(row[column]);
      return true;
    });

  const query = (table: string) => {
    const filters: Array<[string, string, unknown]> = [];
    const builder: any = {
      eq(c: string, v: unknown) { filters.push(['eq', c, v]); return builder; },
      neq(c: string, v: unknown) { filters.push(['neq', c, v]); return builder; },
      is(c: string, v: unknown) { filters.push(['is', c, v]); return builder; },
      in(c: string, v: unknown) { filters.push(['in', c, v]); return builder; },
      or() { return builder; },
      limit() { return builder; },
      order() { return builder; },
      rows() { return (tables[table] ?? []).filter((row) => matches(row, filters)); },
      maybeSingle() { return Promise.resolve({ data: builder.rows()[0] ?? null, error: null }); },
      single() { return Promise.resolve({ data: builder.rows()[0] ?? null, error: null }); },
      then(resolve: (v: { data: Row[]; error: null }) => unknown, reject?: unknown) {
        return Promise.resolve({ data: builder.rows(), error: null }).then(resolve, reject as never);
      },
    };
    return builder;
  };

  const db: any = {
    tables,
    stored,
    from(table: string) {
      const list = tables[table] ?? (tables[table] = []);
      return {
        select: () => query(table),
        insert(row: Row) {
          const created = { id: `item-${++autoId}`, enrichment_status: 'pending', ...row };
          list.push(created);
          return {
            select: () => ({ single: () => Promise.resolve({ data: created, error: null }) }),
          };
        },
        upsert(row: Row) {
          const index = list.findIndex((existing) =>
            existing.stock_item_id === row.stock_item_id
            && existing.source_stage === row.source_stage
            && existing.source_reference === row.source_reference);
          if (index >= 0) list[index] = { ...list[index], ...row };
          else list.push({ id: `image-${++autoId}`, ...row });
          return Promise.resolve({ data: null, error: null });
        },
        update(patch: Row) {
          const filters: Array<[string, string, unknown]> = [];
          const builder: any = {
            eq(c: string, v: unknown) { filters.push(['eq', c, v]); return builder; },
            in(c: string, v: unknown) { filters.push(['in', c, v]); return builder; },
            select: () => ({
              single: () => {
                const hit = list.filter((row) => matches(row, filters));
                for (const row of hit) Object.assign(row, patch);
                return Promise.resolve({ data: hit[0] ?? null, error: null });
              },
            }),
            then(resolve: (v: unknown) => unknown, reject?: unknown) {
              for (const row of list) if (matches(row, filters)) Object.assign(row, patch);
              return Promise.resolve({ data: null, error: null }).then(resolve, reject as never);
            },
          };
          return builder;
        },
      };
    },
    storage: {
      from() {
        return {
          upload(path: string, bytes: Uint8Array, options: { contentType: string }) {
            stored[path] = { bytes, contentType: options.contentType };
            return Promise.resolve({ data: { path }, error: null });
          },
        };
      },
    },
  };
  return db;
}

// ---------------------------------------------------------------------------
// A PDF in the live Lot 537 contract's shape
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

/**
 * A real, decodable baseline JPEG at a stated file size.
 *
 * It has to be a real picture. Display eligibility DECODES what it is about to
 * put on a card and fails closed, so `FFD8FFE0` followed by a fill byte — what
 * this fixture used to be — is now measured as exactly what it is: something no
 * decoder can read, which is not displayable. `padTo` only sets the file size,
 * so the two images in the document still order by size the way the live
 * contract's do.
 */
function jpeg(seed: number, bytes: number): Uint8Array {
  return jpegOf(seed === CLEAN_SEED ? cleanPicture(320, 166) : annotatedPicture(320, 166), bytes);
}

/** The fill byte the cover used to carry, kept so the call sites still read. */
const CLEAN_SEED = 0x11;

const COVER_TEXT = 'LOT 537 KIRRAMINGLY AVENUE DONNYBROOK - BALMAIN ESTATE '
  + 'FIXED PRICE CONTRACT $941,990 Land Size 350 m2 Build Size 209.7 m2 6 bed 2 bath 2 car';

/** A two-page package: the cover facade, then an inclusions interior. */
function packagePdf(): Uint8Array {
  const facade = jpeg(0x11, 224_541);
  const interior = jpeg(0x55, 116_978);
  const parts: Array<string | Uint8Array> = ['%PDF-1.4\n'];

  const coverDraw = 'q 595 0 0 300 0 500 cm /Im0 Do Q';
  const interiorDraw = 'q 595 0 0 842 0 0 cm /Im0 Do Q';

  parts.push('1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n');
  parts.push('2 0 obj<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>endobj\n');
  parts.push('3 0 obj<</Type/Page/Parent 2 0 R/MediaBox [0 0 595 842]'
    + '/Resources<</XObject<</Im0 10 0 R>>>>/Contents 11 0 R>>endobj\n');
  parts.push('4 0 obj<</Type/Page/Parent 2 0 R/MediaBox [0 0 595 842]'
    + '/Resources<</XObject<</Im0 12 0 R>>>>/Contents 13 0 R>>endobj\n');
  parts.push(`10 0 obj<</Type/XObject/Subtype/Image/Width 960/Height 497/ColorSpace/DeviceRGB`
    + `/BitsPerComponent 8/Filter/DCTDecode/Length ${facade.length}>>stream\n`, facade,
    '\nendstream\nendobj\n');
  parts.push(`11 0 obj<</Length ${coverDraw.length}>>stream\n${coverDraw}\nendstream\nendobj\n`);
  parts.push(`12 0 obj<</Type/XObject/Subtype/Image/Width 2202/Height 1229/ColorSpace/DeviceRGB`
    + `/BitsPerComponent 8/Filter/DCTDecode/Length ${interior.length}>>stream\n`, interior,
    '\nendstream\nendobj\n');
  parts.push(`13 0 obj<</Length ${interiorDraw.length}>>stream\n${interiorDraw}\nendstream\nendobj\n`);
  parts.push(`%%PAGETEXT:${COVER_TEXT}\n`);
  parts.push('%%PAGETEXT:INCLUSIONS\n');
  parts.push('trailer<</Root 1 0 R>>\n%%EOF\n');

  const chunks = parts.map((p) => typeof p === 'string' ? encoder.encode(p) : p);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

const ORG = 'org-a';
const UPLOAD = 'upload-1';

async function importPdf(db: any, rows: Array<Record<string, unknown>>) {
  const bytes = packagePdf();
  const extraction = await extractStockFile(bytes, 'contract.pdf',
    classifyStockFile('contract.pdf', 'application/pdf', 'magic'));
  return await importStockRecords(db, {
    organisationId: ORG,
    uploadId: UPLOAD,
    builderUserId: 'builder-1',
    rows,
    media: extraction.media,
    rowAssets: extraction.rowAssets,
    pageTexts: extraction.pageTexts,
    pageOrderAuthoritative: extraction.pageOrderAuthoritative,
    filename: 'contract.pdf',
  });
}

const LOT_537_ROW = {
  lot_number: '537',
  address_line: 'Lot 537 Kirramingly Avenue',
  suburb: 'Donnybrook',
  development_name: 'Balmain Estate',
  price: 941_990,
};

/** What the marketplace would draw, from the rows the import wrote. */
function cardImage(db: any, itemId: string) {
  const item = db.tables.builder_stock_items.find((row: Row) => row.id === itemId);
  const images = db.tables.builder_stock_item_images
    .filter((row: Row) => row.stock_item_id === itemId);
  const displayable = chooseDisplayableImage(images as any);
  return {
    primaryImageId: item?.primary_image_id ?? null,
    displayable,
    /** True only when the stored pointer and the display rule agree. */
    renders: !!displayable && item?.primary_image_id === (displayable as any)?.id,
  };
}

// ---------------------------------------------------------------------------
// TEST A / TEST J — a direct PDF upload, with no operator step
// ---------------------------------------------------------------------------

describe('A/J — a PDF upload settles its own image', () => {
  it('stores the cover facade, roles it, and points the property at it', async () => {
    const db = fakeDb();
    const outcome = await importPdf(db, [LOT_537_ROW]);

    expect(outcome.imported).toBe(1);
    const itemId = outcome.itemIds[0];

    // The bytes are actually in the bucket, not merely detected in memory.
    const image = db.tables.builder_stock_item_images
      .find((row: Row) => row.source_stage === 'uploaded_document'
        && (row.source_detail as Row)?.role === 'primary_property');
    expect(image).toBeDefined();
    expect(image!.storage_bucket).toBe('builder-stock-images');
    expect(db.stored[String(image!.storage_path)]).toBeDefined();
    expect(db.stored[String(image!.storage_path)].bytes.length).toBeGreaterThan(1000);
    expect(image!.verification_status).toBe('source_supplied');
    expect(image!.processing_status).toBe('ready');
    expect((image!.source_detail as Row).provenance_version).toBe(PROVENANCE_VERSION);
    // The cover facade, not the larger interior on the inclusions page.
    expect((image!.source_detail as Row).source_width).toBe(960);
    expect((image!.source_detail as Row).page).toBe(1);

    // AND the property points at it — without `reprocess_source_images`.
    const card = cardImage(db, itemId);
    expect(card.primaryImageId).toBe(image!.id);
    expect(card.renders).toBe(true);
  });

  it('leaves the interior stored but never pointed at', async () => {
    const db = fakeDb();
    const outcome = await importPdf(db, [LOT_537_ROW]);
    const interior = db.tables.builder_stock_item_images
      .find((row: Row) => (row.source_detail as Row)?.source_width === 2202);
    expect(interior).toBeDefined();
    expect((interior!.source_detail as Row).role).not.toBe('primary_property');
    expect(db.tables.builder_stock_items[0].primary_image_id).not.toBe(interior!.id);
    expect(outcome.itemIds).toHaveLength(1);
  });

  it('puts the property back in the image queue so the loop revisits it', async () => {
    const db = fakeDb();
    await importPdf(db, [LOT_537_ROW]);
    // The automatic loop selects `pending`/`enriching`. An import that leaves a
    // property in any other state is an import whose images nothing will finish.
    expect(db.tables.builder_stock_items[0].enrichment_status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// The re-import case, which is how Lot 537 actually reached production
// ---------------------------------------------------------------------------

describe('re-importing a source that already produced the property', () => {
  it('settles the primary on the EXISTING property without recreating it', async () => {
    const db = fakeDb({
      items: [{
        id: 'item-existing', organisation_id: ORG, upload_id: 'upload-0',
        lifecycle_status: 'active', enrichment_status: 'failed',
        primary_image_id: null,
        external_reference: null, development_name: 'Balmain Estate', project_name: null,
        unit_number: null, lot_number: '537',
        address_line: 'Lot 537 Kirramingly Avenue', suburb: 'Donnybrook',
        price: 941_990, availability_status: 'available',
      }],
    });

    const outcome = await importPdf(db, [LOT_537_ROW]);

    // Matched, not duplicated.
    expect(outcome.updated).toBe(1);
    expect(outcome.imported).toBe(0);
    expect(db.tables.builder_stock_items).toHaveLength(1);
    expect(db.tables.builder_stock_items[0].id).toBe('item-existing');
    // Property data untouched.
    expect(db.tables.builder_stock_items[0]).toMatchObject({
      price: 941_990, availability_status: 'available',
    });

    const card = cardImage(db, 'item-existing');
    expect(card.renders).toBe(true);
    expect((card.displayable as any).source_detail.role).toBe('primary_property');
    // `failed` is not terminal any more: the import re-queues what it touched.
    expect(db.tables.builder_stock_items[0].enrichment_status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// TEST H — a source that designates nothing shows nothing
// ---------------------------------------------------------------------------

describe('H — a source with no designated primary', () => {
  it('imports the property and points at no image at all', async () => {
    const db = fakeDb();
    const bytes = packagePdf();
    const extraction = await extractStockFile(bytes, 'contract.pdf',
      classifyStockFile('contract.pdf', 'application/pdf', 'magic'));

    // A property the document never names: no page can be its cover.
    const outcome = await importStockRecords(db, {
      organisationId: ORG, uploadId: UPLOAD, builderUserId: 'builder-1',
      rows: [{ address_line: 'Lot 99 Somewhere Else', suburb: 'Elsewhere' }],
      media: extraction.media,
      rowAssets: extraction.rowAssets,
      pageTexts: extraction.pageTexts,
      pageOrderAuthoritative: extraction.pageOrderAuthoritative,
      filename: 'contract.pdf',
    });

    const card = cardImage(db, outcome.itemIds[0]);
    expect(card.primaryImageId).toBeNull();
    expect(card.displayable).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TEST D/F/G — a source that states the relationship in a row
// ---------------------------------------------------------------------------

describe('D/F/G — row-stated imagery settles automatically', () => {
  it('takes an explicit property-image column and points the property at it', async () => {
    const db = fakeDb();
    const png = await pngOf(cleanPicture(320, 166));

    const outcome = await importStockRecords(db, {
      organisationId: ORG, uploadId: UPLOAD, builderUserId: 'builder-1',
      rows: [{
        'Address': 'Lot 12 Example Street',
        'Suburb': 'Werribee',
        'Facade': 'https://builder.example/lot12.png',
        [SOURCE_ANCHOR_HEADER]: 'sheet:Stock!A2',
      }],
      media: [],
      rowAssets: [],
      filename: 'stock.xlsx',
    }, { fetchImage: async () => ({ bytes: png, finalUrl: 'https://builder.example/lot12.png' }) });

    const card = cardImage(db, outcome.itemIds[0]);
    expect(card.renders).toBe(true);
    expect((card.displayable as any).source_detail.role).toBe('primary_property');
    expect((card.displayable as any).source_detail.role_evidence_level).toBe(1);
  });

  /**
   * TEST B — a Notion row's own page cover.
   *
   * The covers arrive as `rowAssets` keyed on the row's block id, which is the
   * same anchor the CSV the collection becomes carries. This is the path all 25
   * of the live Notion properties take, so it is the one that has to settle its
   * own pointer without anybody pressing anything.
   */
  it('takes a Notion row cover and points the property at it', async () => {
    const db = fakeDb();
    const png = await pngOf(cleanPicture(320, 166));
    const anchor = 'notion:30ccabf9-2010-8099-b502-d7ac23995def';

    const outcome = await importStockRecords(db, {
      organisationId: ORG, uploadId: UPLOAD, builderUserId: 'builder-1',
      rows: [{
        'Deal': 'Lot 13 - Hummock Rise, Werribee, VIC - 3030',
        'Estate Tag': 'Harpley Estate',
        [SOURCE_ANCHOR_HEADER]: anchor,
      }],
      media: [],
      rowAssets: [{
        anchor,
        assets: [{
          url: 'https://ionized-chalk-a63.notion.site/image/attachment%3Acover',
          reference: 'attachment:7ac27898-b7dc-478a-a3f6-73213c4054d9:Completed_(1).jpg',
          origin: 'notion_page_cover',
          provider: 'notion',
          pageUrl: 'https://ionized-chalk-a63.notion.site/30ccabf9',
          position: 0,
          linkFallback: false,
          role: roleFromStructuralContainer({
            container: 'the Notion row for this property',
            designation: 'page cover',
          }),
        }],
      }],
      filename: '30ccabf9.csv',
    }, { fetchImage: async () => ({ bytes: png, finalUrl: 'https://img.notionusercontent.com/signed' }) });

    const card = cardImage(db, outcome.itemIds[0]);
    expect(card.renders).toBe(true);
    expect((card.displayable as any).source_detail.role).toBe('primary_property');
    expect((card.displayable as any).source_detail.role_evidence_level).toBe(3);
    // The bytes are in the bucket, and the expiring delivery URL is not kept.
    expect(db.stored[String((card.displayable as any).storage_path)]).toBeDefined();
    expect((card.displayable as any).external_url).toBeNull();
    expect(outcome.withSourceImage).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The settlement marker — how stock imported under older rules catches up
// ---------------------------------------------------------------------------

describe('settlement brings existing sources up to the current rules', () => {
  const uploads = (over: Row = {}) => ([{
    id: UPLOAD, organisation_id: ORG, deleted_at: null,
    created_at: '2026-08-01T00:00:00Z',
    source_images_settled_version: null,
    marketplace_eligibility_settled_version: null,
    image_sanitization_settled_version: null,
    ...over,
  }]);

  it('lists an upload written under older rules as outstanding', async () => {
    const db = fakeDb({ uploads: uploads() });
    expect(await uploadsNeedingSettlement(db, { organisationId: ORG })).toEqual([UPLOAD]);
  });

  it('lists nothing once the upload is at the current version', async () => {
    const db = fakeDb({
      uploads: uploads({
        source_images_settled_version: PROVENANCE_VERSION,
        marketplace_eligibility_settled_version: MARKETPLACE_ELIGIBILITY_VERSION,
        image_sanitization_settled_version: SANITIZATION_VERSION,
      }),
    });
    expect(await uploadsNeedingSettlement(db, { organisationId: ORG })).toEqual([]);
  });

  /**
   * The THREE markers are separate questions and any one alone is unfinished
   * work. An upload whose sources were re-read under the current provenance
   * rules has still never had its pictures JUDGED, and until they are, its
   * cards show nothing — so the sweep has to keep picking it up.
   */
  it('still lists an upload whose images have never been judged', async () => {
    const db = fakeDb({
      uploads: uploads({ source_images_settled_version: PROVENANCE_VERSION }),
    });
    expect(await uploadsNeedingSettlement(db, { organisationId: ORG })).toEqual([UPLOAD]);
  });

  it('and one judged under an older eligibility algorithm', async () => {
    const db = fakeDb({
      uploads: uploads({
        source_images_settled_version: PROVENANCE_VERSION,
        marketplace_eligibility_settled_version: MARKETPLACE_ELIGIBILITY_VERSION - 1,
        image_sanitization_settled_version: SANITIZATION_VERSION,
      }),
    });
    expect(await uploadsNeedingSettlement(db, { organisationId: ORG })).toEqual([UPLOAD]);
  });

  /**
   * And the third, which is the newest: a picture the display gate refused for
   * carrying a laid-over graphic can have the graphic taken off, and an upload
   * that has never been offered to that repair is outstanding however current
   * its other two markers are.
   */
  it('and one whose images have never been offered to the overlay repair', async () => {
    const db = fakeDb({
      uploads: uploads({
        source_images_settled_version: PROVENANCE_VERSION,
        marketplace_eligibility_settled_version: MARKETPLACE_ELIGIBILITY_VERSION,
        image_sanitization_settled_version: null,
      }),
    });
    expect(await uploadsNeedingSettlement(db, { organisationId: ORG })).toEqual([UPLOAD]);
  });

  it('and one repaired by an older overlay algorithm', async () => {
    const db = fakeDb({
      uploads: uploads({
        source_images_settled_version: PROVENANCE_VERSION,
        marketplace_eligibility_settled_version: MARKETPLACE_ELIGIBILITY_VERSION,
        image_sanitization_settled_version: SANITIZATION_VERSION - 1,
      }),
    });
    expect(await uploadsNeedingSettlement(db, { organisationId: ORG })).toEqual([UPLOAD]);
  });

  /**
   * The trap this marker exists to avoid: "has properties with no picture" is
   * true for ever of a source that carries no imagery, so a sweep keyed on it
   * would re-read every document on every pass and never converge.
   */
  it('settles a source that yields no image at all, and does not come back', async () => {
    const db = fakeDb({ uploads: uploads() });
    const outcome = await settleUploadSourceImages(db, {
      organisationId: ORG, uploadId: UPLOAD,
    });
    expect(outcome.settled).toBe(true);
    expect(db.tables.builder_stock_uploads[0].source_images_settled_version)
      .toBe(PROVENANCE_VERSION);
    expect(await uploadsNeedingSettlement(db, { organisationId: ORG })).toEqual([]);
  });

  it('treats a deployment without the column as having nothing outstanding', async () => {
    const db = fakeDb({ uploads: uploads() });
    // A database that cannot answer for the marker must not be swept blindly.
    db.from = ((table: string) => {
      const real = Object.getPrototypeOf(db) === null ? null : null;
      void real;
      return {
        select: () => ({
          eq: () => ({ is: () => ({ order: () => ({ limit: () =>
            Promise.resolve({ data: null, error: { message: 'column does not exist' } }) }) }) }),
        }),
      };
    }) as any;
    expect(await uploadsNeedingSettlement(db, { organisationId: ORG })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Two pictures on one page must not become one row
// ---------------------------------------------------------------------------

describe('a page that draws two rasters with the same resource name', () => {
  /**
   * A resource name means whatever the resources that drew it say it means, so
   * `/Im0` inside one form and `/Im0` inside another are two different
   * pictures — and a real exporter emits exactly that. The reference is both
   * the storage key and the upsert key, so naming both `page3:Im0` made them
   * one row and silently lost a discovered asset.
   */
  it('keeps them apart by object number', async () => {
    const db = fakeDb();
    await importPdf(db, [LOT_537_ROW]);
    const references = db.tables.builder_stock_item_images
      .filter((row: Row) => row.source_stage === 'uploaded_document')
      .map((row: Row) => String(row.source_reference));
    expect(new Set(references).size).toBe(references.length);
    for (const reference of references) expect(reference).toMatch(/#\d+$/);
  });
});

// ---------------------------------------------------------------------------
// The marker must mean "finished", and only that
// ---------------------------------------------------------------------------

describe('settlement resumability and scope', () => {
  const upload = (over: Row = {}) => ([{
    id: UPLOAD, organisation_id: ORG, deleted_at: null,
    created_at: '2026-08-01T00:00:00Z', source_images_settled_version: null,
    storage_bucket: 'builder-stock-lists', storage_path: 'missing.pdf',
    source_type: 'file', original_filename: 'stock.pdf', source_url: null, final_url: null,
    ...over,
  }]);

  /**
   * A source that cannot be re-read produces the same answer on every future
   * pass, so it settles. Leaving the marker clear would make the sweep re-fetch
   * a deleted Notion page or a revoked Drive share until somebody noticed.
   */
  it('settles an upload whose source can no longer be read', async () => {
    const db = fakeDb({ uploads: upload() });
    const outcome = await settleUploadSourceImages(db, {
      organisationId: ORG, uploadId: UPLOAD,
    });
    expect(outcome.repair?.error).toBeTruthy();
    expect(outcome.settled).toBe(true);
    expect(await uploadsNeedingSettlement(db, { organisationId: ORG })).toEqual([]);
  });

  /** An upload belonging to somebody else is not this organisation's work. */
  it('never lists another organisation\'s upload', async () => {
    const db = fakeDb({ uploads: upload({ organisation_id: 'org-other' }) });
    expect(await uploadsNeedingSettlement(db, { organisationId: ORG })).toEqual([]);
  });

  /** A soft-deleted source is not swept, however unsettled it looks. */
  it('never lists a deleted upload', async () => {
    const db = fakeDb({ uploads: upload({ deleted_at: '2026-08-02T00:00:00Z' }) });
    expect(await uploadsNeedingSettlement(db, { organisationId: ORG })).toEqual([]);
  });

  /**
   * The marker records the version it was settled AT. A later provenance bump
   * has to make every upload outstanding again, or a rules change would only
   * ever reach stock imported after it.
   */
  it('treats an upload settled at an older version as outstanding', async () => {
    const db = fakeDb({
      uploads: upload({ source_images_settled_version: PROVENANCE_VERSION - 1 }),
    });
    expect(await uploadsNeedingSettlement(db, { organisationId: ORG })).toEqual([UPLOAD]);
  });
});

// ---------------------------------------------------------------------------
// The sweep's own tick — it must CONVERGE, and it must not starve
// ---------------------------------------------------------------------------

/**
 * The cron sweep is a deployment repair that unschedules itself, so the one
 * thing it must not do is fail to finish. A tick always begins at the oldest
 * outstanding upload, which is what makes the difference between capping
 * attempts and capping settlements load-bearing rather than stylistic.
 */
describe('Y — one tick of the settlement sweep', () => {
  const candidates = (count: number, organisation = ORG): SettlementCandidate[] =>
    Array.from({ length: count }, (_, index) => ({
      id: `upload-${index + 1}`, organisation_id: organisation,
    }));

  const settles = async (candidate: SettlementCandidate) => ({
    uploadId: candidate.id, settled: true, eligibilitySettled: true,
  });

  it('stops once a tick\'s worth of uploads have been settled', async () => {
    const seen: string[] = [];
    const outcome = await runSettlementTick(
      candidates(10),
      { maxSettled: 3, deadlineAt: Date.now() + 60_000 },
      async (candidate) => { seen.push(candidate.id); return settles(candidate); },
    );
    expect(outcome.settled).toBe(3);
    expect(outcome.attempted).toBe(3);
    expect(seen).toEqual(['upload-1', 'upload-2', 'upload-3']);
  });

  /**
   * THE STARVATION CASE, and the reason the cap counts settlements.
   *
   * The first three sources here can never settle — bytes that no longer parse,
   * a document too large for one wall clock. Capping ATTEMPTS at three meant
   * every tick spent itself on exactly those three for ever: the uploads behind
   * them were never read, and the sweep never reached the empty queue that
   * unschedules it.
   */
  it('reaches the uploads behind ones that can never settle', async () => {
    const seen: string[] = [];
    const outcome = await runSettlementTick(
      candidates(10),
      { maxSettled: 3, deadlineAt: Date.now() + 60_000 },
      async (candidate) => {
        seen.push(candidate.id);
        const stuck = ['upload-1', 'upload-2', 'upload-3'].includes(candidate.id);
        return { uploadId: candidate.id, settled: !stuck, eligibilitySettled: !stuck };
      },
    );
    expect(outcome.settled).toBe(3);
    expect(outcome.attempted).toBe(6);
    expect(seen).toEqual([
      'upload-1', 'upload-2', 'upload-3', 'upload-4', 'upload-5', 'upload-6',
    ]);
  });

  /** The wall clock bounds the tick even when nothing at all is settling. */
  it('stops on its deadline rather than walking the whole queue', async () => {
    let clock = 1_000;
    const seen: string[] = [];
    const outcome = await runSettlementTick(
      candidates(500),
      { maxSettled: 6, deadlineAt: 1_000 + 30, now: () => clock },
      async (candidate) => {
        seen.push(candidate.id);
        clock += 10;
        return { uploadId: candidate.id, settled: false, eligibilitySettled: false };
      },
    );
    expect(outcome.settled).toBe(0);
    expect(seen.length).toBe(4);
    expect(outcome.attempted).toBe(4);
  });

  /**
   * Primaries are enforced per organisation, and only for the ones a tick got
   * to: a tick that stops on its wall clock used to enforce for organisations
   * it had never read, which is work charged against a budget it already spent.
   */
  it('names only the organisations it actually reached', async () => {
    const outcome = await runSettlementTick(
      [
        { id: 'a', organisation_id: 'org-1' },
        { id: 'b', organisation_id: 'org-1' },
        { id: 'c', organisation_id: 'org-2' },
      ],
      { maxSettled: 2, deadlineAt: Date.now() + 60_000 },
      settles,
    );
    expect(outcome.organisations).toEqual(['org-1']);
  });

  /** Nothing outstanding is the terminal state, and it does no work at all. */
  it('does nothing when the queue is empty', async () => {
    let called = 0;
    const outcome = await runSettlementTick(
      [], { maxSettled: 6, deadlineAt: Date.now() + 60_000 },
      async (candidate) => { called += 1; return settles(candidate); },
    );
    expect(called).toBe(0);
    expect(outcome).toEqual({ attempted: 0, settled: 0, organisations: [] });
  });
});
