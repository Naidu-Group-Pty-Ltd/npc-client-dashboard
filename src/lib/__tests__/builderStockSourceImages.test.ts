/**
 * Builder stock — the builder's OWN photograph reaching the right property.
 *
 * THE DEFECT THIS FILE PINS. Seventy properties imported from a public Notion
 * stock list showed Street View and satellite stills badged "Location
 * imagery", while twenty-five builder-supplied renders sat on the covers of
 * the very rows they came from. Nothing was broken in the enrichment stages:
 * stage 1 simply never produced anything, because the Notion decoder flattened
 * every property value to text — and a Notion file value's text is the
 * FILENAME, with the file itself hidden in a link decoration. A render that is
 * never extracted cannot outrank a Street View that is.
 *
 * The fixtures below are the SHAPE of the live payload, taken from it: the
 * double `value.value` wrapping, `format.page_cover` carrying
 * `attachment:<id>:<name>`, punctuation-heavy schema keys, and the real column
 * names (`Deal`, `Estate Tag`, `Package Status`).
 */
import { describe, expect, it } from 'vitest';

import {
  ANNOTATED_VERDICT, CLEAN_VERDICT, cleanPicture, jpegOf, pngOf,
} from './fixtures/builderStockPictures';

import {
  attributeDocumentMedia, sniffImageContentType, sourceImageObjectPath,
  SOURCE_ANCHOR_HEADER, validateSourceImageBytes,
} from '../../../supabase/functions/_shared/builderStock/sourceAssets.pure';
import {
  notionAssetUrl, notionCollectionTable, notionRowAssetRefs, withNotionRowAnchors,
} from '../../../supabase/functions/_shared/builderStock/notionRecordMap.pure';
import { normaliseStockRow } from '../../../supabase/functions/_shared/builderStock/normalise.pure';
import { keyRowsByHeader, parseDelimited } from '../../../supabase/functions/_shared/builderStock/table.pure';
import { matrixToCsv } from '../../../supabase/functions/_shared/builderStock/notionRecordMap.pure';
import {
  parseDrawingAnchors, parseRelationships, parseWorkbookSheets, relsPathFor,
  resolveOoxmlPath, sheetRowAnchor,
} from '../../../supabase/functions/_shared/builderStock/documentAnchors.pure';
import { extractStockFile } from '../../../supabase/functions/_shared/builderStock/extract';
import { storeSourceImages } from '../../../supabase/functions/_shared/builderStock/sourceImages';
import {
  chooseAndStorePrimaryImage, isDisplayableSourceImage,
} from '../../../supabase/functions/_shared/builderStock/primaryImage';
import { repairSourceImagesForUpload } from '../../../supabase/functions/_shared/builderStock/repairSourceImages';
import { PROVENANCE_VERSION } from '../../../supabase/functions/_shared/builderStock/sourceImages';
import {
  roleDetail, roleFromStructuralContainer, secondaryRole,
} from '../../../supabase/functions/_shared/builderStock/sourceImageRole.pure';

/**
 * A role a SOURCE stated, for fixtures that are about something else.
 *
 * Every asset now carries what the source presented it as, because
 * "the builder supplied these bytes" and "the builder supplied them as this
 * property's listing image" are different facts and only the second may reach a
 * card. Tests that are about fetching, hashing or storage say so once here.
 */
const PRIMARY_ASSET_ROLE = roleFromStructuralContainer({
  container: 'the Notion row for this property',
  designation: 'page cover',
});
/**
 * A settled image: what the source designated it as, AND what the marketplace
 * measured on the picture. The second half is not optional — an image with no
 * verdict has never been judged, and the display rule refuses it.
 */
const PRIMARY_ROLE_DETAIL = { ...roleDetail(PRIMARY_ASSET_ROLE), ...CLEAN_VERDICT };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SPACE_ID = '2b0cabf9-2010-8111-92c9-000329d94f98';
const COLLECTION_ID = '30ccabf9-2010-80b2-b004-000b94db2627';
const VIEW_ID = '30ccabf9-2010-80e6-9dd6-000c26da7c45';
const ROW_A = '374cabf9-2010-8059-b681-c9aa84ff8b0d';
const ROW_B = '3accabf9-2010-81b7-9168-f2eb55ecc559';
const PAGE_URL = 'https://ionized-chalk-a63.notion.site/30ccabf920108099b502d7ac23995def';

/**
 * A real, DECODABLE PNG of a clean photograph.
 *
 * It used to be a signature followed by a fill byte, which was enough for
 * everything that only sniffs a container. It is not enough any more: display
 * eligibility decodes the picture it is about to allow onto a card and fails
 * closed, so an undecodable file is `pending` and draws nothing. The `size`
 * argument survives for the callers that pass one; the picture is sized to
 * clear the "too small to be a photograph" floor either way.
 */
const PNG_BYTES = await pngOf(cleanPicture(320, 166));
function pngBytes(_size = 4096): Uint8Array {
  return PNG_BYTES;
}

function wrap(record: Record<string, unknown>) {
  // The chunk endpoint's shape: `{ spaceId, value: { value: <record>, role } }`.
  return { spaceId: SPACE_ID, value: { value: record, role: 'reader' } };
}

function collectionRecordMap(options: {
  coverA?: string | null;
  filePropertyA?: string | null;
  contentA?: string[];
  imageBlock?: { id: string; source: string };
} = {}) {
  const {
    coverA = 'attachment:21ef423c-9428-4c6d-bf8d-7211a2fe0a83:Cloverton_Registered_2.png',
    filePropertyA = null,
    contentA = [],
    imageBlock,
  } = options;

  const blocks: Record<string, unknown> = {
    [ROW_A]: wrap({
      id: ROW_A,
      type: 'page',
      parent_id: COLLECTION_ID,
      properties: {
        title: [['Lot 60434 - Cloverton Estate, Kalkallo VIC 3064']],
        'G^bL': [['Cloverton Estate Kalkallo VIC 3064 - Stocklands']],
        'mlCu': [['Available']],
        'ZVPn': [['643000']],
        ...(filePropertyA
          ? { 'O^yH': [[filePropertyA.split(':').slice(2).join(':') || filePropertyA, [['a', filePropertyA]]]] }
          : {}),
      },
      format: coverA ? { page_cover: coverA, page_cover_position: 0.5 } : {},
      content: contentA,
    }),
    [ROW_B]: wrap({
      id: ROW_B,
      type: 'page',
      parent_id: COLLECTION_ID,
      properties: {
        title: [['Lot 43 - Tringa Street, Sandpiper Estate, Tweed Heads South']],
        'G^bL': [['Sandpiper Estate']],
        'mlCu': [['Available']],
        'ZVPn': [['812000']],
      },
      format: {},
      content: [],
    }),
  };

  if (imageBlock) {
    blocks[imageBlock.id] = wrap({
      id: imageBlock.id,
      type: 'image',
      parent_id: ROW_A,
      properties: { source: [[imageBlock.source]] },
      format: { display_source: imageBlock.source },
    });
  }

  return {
    block: blocks,
    collection: {
      [COLLECTION_ID]: wrap({
        id: COLLECTION_ID,
        name: [['LIVE STOCK LIST - August 2026 ']],
        schema: {
          title: { name: 'Deal', type: 'title' },
          'G^bL': { name: 'Estate Tag', type: 'select' },
          'mlCu': { name: 'Package Status', type: 'select' },
          'ZVPn': { name: 'Package Price', type: 'number' },
          'O^yH': { name: 'Complete Package Pack', type: 'file' },
        },
      }),
    },
    collection_view: {
      [VIEW_ID]: wrap({
        id: VIEW_ID,
        format: {
          table_properties: [
            { property: 'title', visible: true },
            { property: 'G^bL', visible: true },
            { property: 'mlCu', visible: true },
            { property: 'ZVPn', visible: true },
          ],
        },
      }),
    },
  } as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// An in-memory stand-in for the service-role client
// ---------------------------------------------------------------------------

interface FakeRow { [key: string]: unknown }

function fakeDb(seed: {
  images?: FakeRow[];
  items?: FakeRow[];
  uploads?: FakeRow[];
  objects?: Record<string, Uint8Array>;
  /**
   * Make one table's updates fail, so a persistence fault can be exercised.
   * A settlement that cannot write down what it learned must not let its
   * caller record the upload as finished.
   */
  failUpdatesOn?: string;
} = {}) {
  const tables: Record<string, FakeRow[]> = {
    builder_stock_item_images: [...(seed.images ?? [])],
    builder_stock_items: [...(seed.items ?? [])],
    builder_stock_uploads: [...(seed.uploads ?? [])],
  };
  const stored: Record<string, { bytes: Uint8Array; contentType: string }> = {};
  const sourceObjects = seed.objects ?? {};
  let autoId = 0;

  const matches = (row: FakeRow, filters: Array<[string, string, unknown]>) =>
    filters.every(([op, column, value]) => {
      if (op === 'eq') return row[column] === value;
      if (op === 'is') return row[column] === value || (value === null && row[column] == null);
      if (op === 'in') return Array.isArray(value) && value.includes(row[column]);
      return true;
    });

  const selectBuilder = (table: string) => {
    const filters: Array<[string, string, unknown]> = [];
    const builder: any = {
      eq(column: string, value: unknown) { filters.push(['eq', column, value]); return builder; },
      is(column: string, value: unknown) { filters.push(['is', column, value]); return builder; },
      in(column: string, value: unknown) { filters.push(['in', column, value]); return builder; },
      limit() { return builder; },
      order() { return builder; },
      maybeSingle() {
        const rows = (tables[table] ?? []).filter((row) => matches(row, filters));
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      then(resolve: (value: { data: FakeRow[]; error: null }) => unknown, reject?: unknown) {
        const rows = (tables[table] ?? []).filter((row) => matches(row, filters));
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject as never);
      },
    };
    return builder;
  };

  const db: any = {
    tables,
    stored,
    from(table: string) {
      return {
        select: () => selectBuilder(table),
        upsert(row: FakeRow) {
          const list = tables[table] ?? (tables[table] = []);
          const index = list.findIndex((existing) =>
            existing.stock_item_id === row.stock_item_id
            && existing.source_stage === row.source_stage
            && existing.source_reference === row.source_reference);
          if (index >= 0) list[index] = { ...list[index], ...row };
          else list.push({ id: `image-${++autoId}`, ...row });
          return Promise.resolve({ data: null, error: null });
        },
        update(patch: FakeRow) {
          const filters: Array<[string, string, unknown]> = [];
          const builder: any = {
            eq(column: string, value: unknown) { filters.push(['eq', column, value]); return builder; },
            then(resolve: (value: unknown) => unknown, reject?: unknown) {
              if (seed.failUpdatesOn === table) {
                return Promise.resolve({
                  data: null, error: { message: 'update refused' },
                }).then(resolve, reject as never);
              }
              for (const row of tables[table] ?? []) {
                if (matches(row, filters)) Object.assign(row, patch);
              }
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
          download(path: string) {
            const bytes = sourceObjects[path];
            if (!bytes) return Promise.resolve({ data: null, error: { message: 'not found' } });
            return Promise.resolve({
              data: { arrayBuffer: () => Promise.resolve(bytes.buffer.slice(0)) },
              error: null,
            });
          },
        };
      },
    },
  };
  return db;
}

/** A fetcher that answers with real image bytes, and records what was asked. */
function imageFetcher(bytes: Uint8Array = pngBytes()) {
  const requested: string[] = [];
  return {
    requested,
    fetchImage: async (url: string) => {
      requested.push(url);
      return { bytes, finalUrl: 'https://img.notionusercontent.com/s3/prod-files-secure/signed' };
    },
  };
}

// ---------------------------------------------------------------------------
// TEST A — a Notion file property belongs to the row that carries it
// ---------------------------------------------------------------------------

describe('Notion file and media properties', () => {
  it('takes the file out of a files property and keeps it on that row', () => {
    const recordMap = collectionRecordMap({
      coverA: null,
      filePropertyA: 'attachment:aaa11111-2222-3333-4444-555566667777:Lot60434_Facade.png',
    });

    const refs = notionRowAssetRefs(recordMap, ROW_A);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ origin: 'file_property', blockId: ROW_A });
    expect(refs[0].source).toContain('Lot60434_Facade.png');

    // And nothing leaks onto the row beside it.
    expect(notionRowAssetRefs(recordMap, ROW_B)).toHaveLength(0);
  });

  it('ignores a file property holding something that is not an image', () => {
    const recordMap = collectionRecordMap({
      coverA: null,
      // The live list's "Complete Package Pack" column: a contract pack, and on
      // most rows a Google Drive folder. Neither is a photograph of a house.
      filePropertyA: 'attachment:1cd875b8-14cf-42fa-8f95-a58ae98a3344:shops_Now_open_Cloverton_estate.pdf',
    });
    expect(notionRowAssetRefs(recordMap, ROW_A)).toHaveLength(0);
  });

  it('reads the page cover, which is where the live stock list keeps its renders', () => {
    const refs = notionRowAssetRefs(collectionRecordMap(), ROW_A);
    expect(refs).toHaveLength(1);
    expect(refs[0].origin).toBe('page_cover');
    expect(refs[0].source).toBe(
      'attachment:21ef423c-9428-4c6d-bf8d-7211a2fe0a83:Cloverton_Registered_2.png');
  });

  it('does not treat a Notion gallery texture as builder imagery', () => {
    const recordMap = collectionRecordMap({ coverA: '/images/page-cover/woodgrain_dark.png' });
    expect(notionRowAssetRefs(recordMap, ROW_A)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// TEST B — an image block inside a row's own page belongs to that row
// ---------------------------------------------------------------------------

describe('Notion image blocks inside a database row', () => {
  it('attributes an image block to the row whose page holds it', () => {
    const blockId = '3f1cabf9-2010-4000-9000-0000000000aa';
    const recordMap = collectionRecordMap({
      coverA: null,
      contentA: [blockId],
      imageBlock: { id: blockId, source: 'attachment:bbb22222-3333-4444-5555-666677778888:Render.jpg' },
    });

    const refs = notionRowAssetRefs(recordMap, ROW_A);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ origin: 'image_block', blockId });

    // The URL is signed against the IMAGE block, not the row — which is what
    // Notion's public endpoint requires.
    const url = notionAssetUrl(PAGE_URL, refs[0]);
    expect(url).toContain(`id=${blockId}`);
    expect(notionRowAssetRefs(recordMap, ROW_B)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Row identity survives the CSV the pipeline actually imports
// ---------------------------------------------------------------------------

describe('the anchor column', () => {
  it('carries the Notion row id through the snapshot and into the record', () => {
    const recordMap = collectionRecordMap();
    const table = notionCollectionTable(recordMap, {
      collectionId: COLLECTION_ID, viewId: VIEW_ID, blockIds: [ROW_A, ROW_B],
    });
    expect(table.rowIds).toEqual([ROW_A, ROW_B]);

    const matrix = withNotionRowAnchors(table.matrix, table.rowIds, SOURCE_ANCHOR_HEADER);
    // Round-trip through exactly what gets stored and re-read.
    const keyed = keyRowsByHeader(parseDelimited(matrixToCsv(matrix)));
    expect(keyed).not.toBeNull();

    const first = normaliseStockRow(keyed!.rows[0]);
    expect(first?.source_anchor).toBe(`notion:${ROW_A}`);
    expect(first?.address_line).toContain('Lot 60434');
    // The reserved column is lifted off the row, not reported as a column we
    // failed to understand.
    expect(Object.keys(first?.unmapped ?? {})).not.toContain(SOURCE_ANCHOR_HEADER);
  });

  it('is not by itself evidence that a row describes a property', () => {
    expect(normaliseStockRow({ [SOURCE_ANCHOR_HEADER]: 'notion:abc' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TEST C — an external image URL is fetched, stored and attributed
// TEST D — a Notion-hosted file is snapshotted so expiry cannot break the card
// ---------------------------------------------------------------------------

describe('bringing the source image inside', () => {
  it('stores an externally hosted image against the exact property', async () => {
    const db = fakeDb();
    const fetcher = imageFetcher();

    const outcome = await storeSourceImages(db, {
      organisationId: 'org-1',
      uploadId: 'upload-1',
      stockItemId: 'item-1',
      assets: [{
        url: 'https://cdn.builder.example/renders/lot-60434.png',
        reference: 'https://cdn.builder.example/renders/lot-60434.png',
        origin: 'notion_file_property',
        provider: 'notion',
        pageUrl: PAGE_URL,
        position: 0,
        linkFallback: false,
        role: PRIMARY_ASSET_ROLE,
      }],
    }, { fetchImage: fetcher.fetchImage });

    expect(outcome.stored).toBe(1);
    const row = db.tables.builder_stock_item_images[0];
    expect(row).toMatchObject({
      stock_item_id: 'item-1',
      source_stage: 'uploaded_document',
      verification_status: 'source_supplied',
      processing_status: 'ready',
      source_provider: 'notion',
      content_type: 'image/png',
    });
    expect(row.storage_bucket).toBe('builder-stock-images');
    expect(db.stored[row.storage_path as string].bytes.length).toBe(pngBytes().length);
  });

  it('snapshots a Notion-hosted file and never keeps its expiring URL', async () => {
    const refs = notionRowAssetRefs(collectionRecordMap(), ROW_A);
    const url = notionAssetUrl(PAGE_URL, refs[0])!;
    // The public image endpoint on the page's own host, which re-signs the
    // attachment on every request.
    expect(url).toContain('https://ionized-chalk-a63.notion.site/image/');
    expect(url).toContain(encodeURIComponent(refs[0].source));
    expect(url).toContain(`id=${ROW_A}`);

    const db = fakeDb();
    const fetcher = imageFetcher();
    await storeSourceImages(db, {
      organisationId: 'org-1',
      uploadId: 'upload-1',
      stockItemId: 'item-1',
      assets: [{
        url,
        // Keyed on Notion's own name, so a re-import refreshes one row rather
        // than writing a new one for every signature.
        reference: refs[0].source,
        origin: 'notion_page_cover',
        provider: 'notion',
        pageUrl: PAGE_URL,
        position: 0,
        linkFallback: false,
        role: PRIMARY_ASSET_ROLE,
      }],
    }, { fetchImage: fetcher.fetchImage });

    const row = db.tables.builder_stock_item_images[0];
    expect(row.storage_path).toBeTruthy();
    expect(row.external_url).toBeNull();
    expect(row.source_reference).toBe(refs[0].source);
    expect(db.stored[row.storage_path as string]).toBeTruthy();
  });

  it('refuses an access page dressed up as an image, and says so', async () => {
    const db = fakeDb();
    const html = new TextEncoder().encode('<!doctype html><html><body>Sign in</body></html>'.repeat(40));

    const outcome = await storeSourceImages(db, {
      organisationId: 'org-1',
      uploadId: null,
      stockItemId: 'item-1',
      assets: [{
        url: 'https://example.invalid/render.png',
        reference: 'render.png',
        origin: 'notion_page_cover',
        provider: 'notion',
        pageUrl: null,
        position: 0,
        linkFallback: false,
        role: PRIMARY_ASSET_ROLE,
      }],
    }, { fetchImage: async () => ({ bytes: html, finalUrl: 'https://example.invalid/render.png' }) });

    expect(outcome.stored).toBe(0);
    expect(outcome.failed).toBe(1);
    const row = db.tables.builder_stock_item_images[0];
    expect(row.processing_status).toBe('failed');
    expect(row.storage_path).toBeUndefined();
    // The URL is kept for the audit trail, and the row stays un-displayable:
    // bytes we do not hold cannot be shown as the builder's exact image.
    expect(row.external_url).toBe('https://example.invalid/render.png');
    expect(isDisplayableSourceImage(row as never)).toBe(false);
  });

  it('never displays a link whose bytes could not be fetched', async () => {
    const db = fakeDb();
    await storeSourceImages(db, {
      organisationId: 'org-1',
      uploadId: null,
      stockItemId: 'item-1',
      assets: [{
        url: 'https://builder.example/lot-1.jpg',
        reference: 'https://builder.example/lot-1.jpg',
        origin: 'stock_list_column',
        provider: 'stock_list_column',
        pageUrl: null,
        position: 0,
        linkFallback: true,
        role: PRIMARY_ASSET_ROLE,
      }],
    }, { fetchImage: async () => { throw new Error('That address could not be reached.'); } });

    /**
     * The link IS the builder's, but we hold none of its bytes and can hash
     * none of them — so it is recorded and refused rather than hot-linked to
     * somebody else's server and called provenance.
     */
    const row = db.tables.builder_stock_item_images[0];
    expect(row.processing_status).toBe('failed');
    expect(row.external_url).toBe('https://builder.example/lot-1.jpg');
    expect(row.verification_status).toBe('source_supplied');
    expect(isDisplayableSourceImage(row as never)).toBe(false);
  });

  it('reads the bytes, not the promise', () => {
    expect(sniffImageContentType(pngBytes())).toBe('image/png');
    expect(validateSourceImageBytes(new TextEncoder().encode('<svg/>'.repeat(200))).ok).toBe(false);
    expect(validateSourceImageBytes(pngBytes().subarray(0, 64)).ok).toBe(false);
    expect(sourceImageObjectPath('org', 'item', 'attachment:x:Cover.png', 'png'))
      .toBe('org/items/item/source/attachment-x-Cover.png.png');
  });
});

// ---------------------------------------------------------------------------
// TEST E — an HTML row's own image follows that row
// ---------------------------------------------------------------------------

describe('an ordinary web page', () => {
  const html = `<!doctype html><html><body><table>
    <tr><th>Lot</th><th>Estate</th><th>Price</th><th>Photo</th></tr>
    <tr><td>101</td><td>Riverbank</td><td>$640,000</td><td><img src="/img/lot-101.jpg"></td></tr>
    <tr><td>102</td><td>Riverbank</td><td>$655,000</td><td><img src="/img/lot-102.jpg"></td></tr>
  </table></body></html>`;

  it('keeps each card image with the row that contains it', async () => {
    const extraction = await extractStockFile(
      new TextEncoder().encode(html),
      'stock.html',
      { kind: 'markup', extension: 'html' },
      { baseUrl: 'https://builder.example/stock' },
    );

    expect(extraction.rows).toHaveLength(2);
    const anchors = extraction.rows.map((row) => row[SOURCE_ANCHOR_HEADER]);
    expect(new Set(anchors).size).toBe(2);

    // Row 101's anchor carries row 101's photograph, and no other.
    const first = extraction.rowAssets.find((entry) => entry.anchor === anchors[0]);
    expect(first?.assets.map((asset) => asset.url))
      .toEqual(['https://builder.example/img/lot-101.jpg']);
    const second = extraction.rowAssets.find((entry) => entry.anchor === anchors[1]);
    expect(second?.assets.map((asset) => asset.url))
      .toEqual(['https://builder.example/img/lot-102.jpg']);
    expect(first?.assets[0]).toMatchObject({ provider: 'source_page', linkFallback: true });
  });
});

// ---------------------------------------------------------------------------
// TEST F — a document image is attributed structurally, not by counting
// ---------------------------------------------------------------------------

describe('embedded document imagery', () => {
  it('resolves a spreadsheet drawing to the sheet row it is anchored to', () => {
    const workbook = '<workbook><sheets><sheet name="Stock" sheetId="1" r:id="rId1"/></sheets></workbook>';
    expect(parseWorkbookSheets(workbook)).toEqual([{ name: 'Stock', rid: 'rId1' }]);

    const workbookRels = '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>';
    const sheetPart = resolveOoxmlPath('xl/workbook.xml', parseRelationships(workbookRels).rId1);
    expect(sheetPart).toBe('xl/worksheets/sheet1.xml');
    expect(relsPathFor(sheetPart)).toBe('xl/worksheets/_rels/sheet1.xml.rels');

    const drawingPart = resolveOoxmlPath(sheetPart, '../drawings/drawing1.xml');
    expect(drawingPart).toBe('xl/drawings/drawing1.xml');

    const drawing = `<xdr:wsDr>
      <xdr:twoCellAnchor><xdr:from><xdr:col>3</xdr:col><xdr:row>7</xdr:row></xdr:from>
        <xdr:pic><xdr:blipFill><a:blip r:embed="rId4"/></xdr:blipFill></xdr:pic>
      </xdr:twoCellAnchor></xdr:wsDr>`;
    expect(parseDrawingAnchors(drawing)).toEqual([{ rid: 'rId4', row: 7 }]);
    expect(resolveOoxmlPath(drawingPart, '../media/image2.png')).toBe('xl/media/image2.png');
    expect(sheetRowAnchor('Stock', 7)).toBe('sheet:Stock#7');
  });

  it('prefers the anchor over the ordering the counts would have allowed', () => {
    const attributions = attributeDocumentMedia({
      anchors: ['sheet:Stock#7', 'sheet:Stock#5'],
      itemIdByAnchor: { 'sheet:Stock#5': 'item-lot-5', 'sheet:Stock#7': 'item-lot-7' },
      itemIdsInOrder: ['item-lot-5', 'item-lot-7'],
    });
    // Counting would have given image 0 to item-lot-5. The document says
    // otherwise, and the document decides.
    expect(attributions[0]).toMatchObject({ stockItemId: 'item-lot-7', structural: true });
    expect(attributions[1]).toMatchObject({ stockItemId: 'item-lot-5', structural: true });
  });

  it('stops attributing by order once the document has shown it anchors images', () => {
    const attributions = attributeDocumentMedia({
      anchors: ['sheet:Stock#7', null],
      itemIdByAnchor: { 'sheet:Stock#7': 'item-lot-7' },
      itemIdsInOrder: ['item-lot-5', 'item-lot-7'],
    });
    expect(attributions[0].stockItemId).toBe('item-lot-7');
    // A letterhead the spreadsheet never anchored is kept against the upload.
    expect(attributions[1].stockItemId).toBeNull();
    expect(attributions[1].reason).toContain('did not anchor this one');
  });

  it('still counts when the format stated nothing at all', () => {
    const attributions = attributeDocumentMedia({
      anchors: [null, null],
      itemIdByAnchor: {},
      itemIdsInOrder: ['item-a', 'item-b'],
    });
    expect(attributions.map((entry) => entry.stockItemId)).toEqual(['item-a', 'item-b']);
    expect(attributions[0].structural).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TEST G — the source-supplied image always wins the card
// ---------------------------------------------------------------------------

describe('which image the marketplace shows', () => {
  it('chooses the builder image over ready Google and search imagery', async () => {
    const db = fakeDb({
      items: [{ id: 'item-1', primary_image_id: 'google-1' }],
      images: [
        {
          id: 'google-1', stock_item_id: 'item-1', source_stage: 'google_maps',
          processing_status: 'ready', position: 0, storage_path: 'org/items/item-1/google-streetview.jpg',
        },
        {
          id: 'search-1', stock_item_id: 'item-1', source_stage: 'internet_search',
          processing_status: 'ready', position: 0, external_url: 'https://example.com/found.jpg',
        },
        {
          id: 'source-1', stock_item_id: 'item-1', source_stage: 'uploaded_document',
          verification_status: 'source_supplied', source_detail: PRIMARY_ROLE_DETAIL,
          processing_status: 'ready', position: 3, storage_path: 'org/items/item-1/source/cover.png',
        },
      ],
    });

    const primary = await chooseAndStorePrimaryImage(db, 'item-1');
    expect(primary).toBe('source-1');
    expect(db.tables.builder_stock_items[0].primary_image_id).toBe('source-1');
  });

  it('never lets a lower position on Google outrank the builder image', async () => {
    const db = fakeDb({
      items: [{ id: 'item-1', primary_image_id: null }],
      images: [
        {
          id: 'google-1', stock_item_id: 'item-1', source_stage: 'google_maps',
          processing_status: 'ready', position: 0, storage_path: 'g.jpg',
        },
        {
          id: 'source-1', stock_item_id: 'item-1', source_stage: 'uploaded_document',
          verification_status: 'source_supplied', source_detail: PRIMARY_ROLE_DETAIL,
          processing_status: 'ready', position: 9, storage_path: 's.png',
        },
      ],
    });
    expect(await chooseAndStorePrimaryImage(db, 'item-1')).toBe('source-1');
  });

  // No builder image: the card shows NOTHING. Location imagery and a search
  // result are not photographs of the property, so neither may be the card.
  it('shows no image at all when the source supplied nothing', async () => {
    const db = fakeDb({
      items: [{ id: 'item-2', primary_image_id: null }],
      images: [
        {
          id: 'search-2', stock_item_id: 'item-2', source_stage: 'internet_search',
          processing_status: 'ready', position: 0, external_url: 'https://example.com/x.jpg',
        },
        {
          id: 'google-2', stock_item_id: 'item-2', source_stage: 'google_maps',
          processing_status: 'ready', position: 0, storage_path: 'g.jpg',
        },
      ],
    });
    expect(await chooseAndStorePrimaryImage(db, 'item-2')).toBeNull();
    expect(db.tables.builder_stock_items[0].primary_image_id).toBeNull();
  });

  it('leaves a card empty when the only source image failed to come inside', async () => {
    const db = fakeDb({
      items: [{ id: 'item-3', primary_image_id: null }],
      images: [
        {
          id: 'source-3', stock_item_id: 'item-3', source_stage: 'uploaded_document',
          processing_status: 'failed', position: 0,
        },
        {
          id: 'google-3', stock_item_id: 'item-3', source_stage: 'google_maps',
          processing_status: 'ready', position: 0, storage_path: 'g.jpg',
        },
      ],
    });
    expect(await chooseAndStorePrimaryImage(db, 'item-3')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TEST I — existing stock is repaired, not recreated
// TEST J — and one builder's imagery can never reach another's stock
// ---------------------------------------------------------------------------

describe('repairing stock that is already imported', () => {
  const csv = [
    'Reference,Development,Lot,Package Price,Photo',
    'NPC-101,Riverbank,101,640000,https://builder.example/img/lot-101.jpg',
  ].join('\r\n');

  const upload = {
    id: 'upload-1',
    organisation_id: 'org-a',
    source_type: 'file',
    source_url: null,
    final_url: null,
    original_filename: 'stock.csv',
    storage_bucket: 'builder-stock-lists',
    storage_path: 'stock-lists/org-a/upload-1/stock.csv',
    deleted_at: null,
  };

  it('attaches the source image to the existing item and re-points the card', async () => {
    const db = fakeDb({
      uploads: [upload],
      items: [{
        id: 'item-101', organisation_id: 'org-a', lifecycle_status: 'active',
        external_reference: 'NPC-101', development_name: 'Riverbank',
        project_name: null, unit_number: null, lot_number: '101',
        primary_image_id: 'google-101',
      }],
      images: [{
        id: 'google-101', stock_item_id: 'item-101', source_stage: 'google_maps',
        processing_status: 'ready', position: 0, storage_path: 'g.jpg',
      }],
      objects: { [upload.storage_path]: new TextEncoder().encode(csv) },
    });

    const before = db.tables.builder_stock_items.length;
    const outcome = await repairSourceImagesForUpload(
      db,
      { organisationId: 'org-a', uploadId: 'upload-1' },
      // The row's own image column: the bytes are fetched, hashed and stored,
      // exactly as production does behind the SSRF guard.
      { fetchImage: async () => ({ bytes: pngBytes(), finalUrl: 'https://builder.example/img/lot-101.jpg' }) },
    );

    expect(outcome.error).toBeUndefined();
    expect(outcome.rowsRead).toBe(1);
    expect(outcome.matched).toBe(1);
    // The stock item is not duplicated, recreated or edited.
    expect(db.tables.builder_stock_items).toHaveLength(before);
    expect(db.tables.builder_stock_items[0].id).toBe('item-101');
    expect(db.tables.builder_stock_items[0].external_reference).toBe('NPC-101');

    const sourceRow = db.tables.builder_stock_item_images
      .find((row: FakeRow) => row.source_stage === 'uploaded_document'
        && row.processing_status === 'ready');
    expect(sourceRow).toMatchObject({
      stock_item_id: 'item-101',
      verification_status: 'source_supplied',
      processing_status: 'ready',
    });
    // And the card now shows it. The Google row is left where it is.
    expect(db.tables.builder_stock_items[0].primary_image_id).toBe(sourceRow!.id);
    expect(outcome.primaryUpdated).toBe(1);
    expect(db.tables.builder_stock_item_images
      .some((row: FakeRow) => row.id === 'google-101')).toBe(true);
  });

  /*
   * TEST AR — the sweep has to CONVERGE, and for hours it did not.
   *
   * `storeSourceImages` fetches, validates, hashes and re-uploads every asset
   * unconditionally. The row-asset branch had neither of the guards the package
   * branch has, so every tick began at the first row and spent the whole worker
   * allowance re-storing pictures that were already at the current version.
   * Production upload f7e0d4d1 sat at 13 of 25 for hours: not slow, nil.
   */
  describe('and the repair converges instead of redoing itself', () => {
    const manyCsv = [
      'Reference,Development,Lot,Package Price,Photo',
      ...Array.from({ length: 6 }, (_, i) =>
        `NPC-2${i},Riverbank,2${i},640000,https://builder.example/img/lot-2${i}.jpg`),
    ].join('\r\n');

    const manyUpload = {
      ...upload, id: 'upload-many',
      storage_path: 'stock-lists/org-a/upload-many/stock.csv',
    };

    const manyItems = Array.from({ length: 6 }, (_, i) => ({
      id: `item-2${i}`, organisation_id: 'org-a', lifecycle_status: 'active',
      external_reference: `NPC-2${i}`, development_name: 'Riverbank',
      project_name: null, unit_number: null, lot_number: `2${i}`,
      primary_image_id: null,
    }));

    /** A property already re-derived under the current rules. */
    const settledImage = (index: number) => ({
      id: `settled-2${index}`,
      stock_item_id: `item-2${index}`,
      organisation_id: 'org-a',
      source_stage: 'uploaded_document',
      source_reference: `https://builder.example/img/lot-2${index}.jpg`,
      processing_status: 'ready',
      verification_status: 'source_supplied',
      position: 0,
      storage_path: `s/lot-2${index}.jpg`,
      source_detail: { ...PRIMARY_ROLE_DETAIL, provenance_version: PROVENANCE_VERSION },
    });

    it('does not re-fetch a property already at the current provenance version', async () => {
      // Four of the six are already current; only two have work outstanding.
      const db = fakeDb({
        uploads: [manyUpload],
        items: manyItems,
        images: [0, 1, 2, 3].map(settledImage),
        objects: { [manyUpload.storage_path]: new TextEncoder().encode(manyCsv) },
      });

      const fetched: string[] = [];
      const outcome = await repairSourceImagesForUpload(
        db, { organisationId: 'org-a', uploadId: 'upload-many' },
        {
          fetchImage: async (url: string) => {
            fetched.push(url);
            return { bytes: pngBytes(), finalUrl: url };
          },
        },
      );

      expect(outcome.rowsRead).toBe(6);
      // The four already current were not downloaded again...
      expect(fetched).toEqual([
        'https://builder.example/img/lot-24.jpg',
        'https://builder.example/img/lot-25.jpg',
      ]);
      // ...and the run finished, because there was nothing left to do.
      expect(outcome.incomplete).toBe(false);
    });

    /*
     * The other half of the same rule. Skipping the DOWNLOAD must not skip the
     * PROOF: attribution comes from the row, which this run re-read from the
     * builder's own stored source, so an image it deliberately did not re-fetch
     * is not an image it failed to prove. Demoting those would empty exactly the
     * cards the repair exists to fill.
     */
    it('still proves a skipped property, so nothing is demoted for being current', async () => {
      const db = fakeDb({
        uploads: [manyUpload],
        items: manyItems,
        images: [0, 1, 2, 3, 4, 5].map(settledImage),
        objects: { [manyUpload.storage_path]: new TextEncoder().encode(manyCsv) },
      });

      const outcome = await repairSourceImagesForUpload(
        db, { organisationId: 'org-a', uploadId: 'upload-many' },
        { fetchImage: async () => { throw new Error('nothing should be fetched'); } },
      );

      expect(outcome.demoted).toBe(0);
      expect(outcome.incomplete).toBe(false);
      for (const row of db.tables.builder_stock_item_images) {
        expect(row.processing_status).toBe('ready');
      }
    });

    /*
     * And a run that cannot finish stops ITSELF rather than being killed. The
     * wall clock never fired in production — the work is CPU-bound and the edge
     * worker's resource limit hit first, which returns no response, writes no
     * marker and logs nothing. A count is the bound that holds.
     */
    it('stops at the work cap and reports incomplete rather than running on', async () => {
      const wideCsv = [
        'Reference,Development,Lot,Package Price,Photo',
        ...Array.from({ length: 20 }, (_, i) =>
          `NPC-3${i},Riverbank,3${i},640000,https://builder.example/img/lot-3${i}.jpg`),
      ].join('\r\n');
      const wideUpload = {
        ...upload, id: 'upload-wide',
        storage_path: 'stock-lists/org-a/upload-wide/stock.csv',
      };
      const db = fakeDb({
        uploads: [wideUpload],
        items: Array.from({ length: 20 }, (_, i) => ({
          id: `item-3${i}`, organisation_id: 'org-a', lifecycle_status: 'active',
          external_reference: `NPC-3${i}`, development_name: 'Riverbank',
          project_name: null, unit_number: null, lot_number: `3${i}`,
          primary_image_id: null,
        })),
        objects: { [wideUpload.storage_path]: new TextEncoder().encode(wideCsv) },
      });

      let fetches = 0;
      const outcome = await repairSourceImagesForUpload(
        db, { organisationId: 'org-a', uploadId: 'upload-wide' },
        {
          fetchImage: async (url: string) => {
            fetches += 1;
            return { bytes: pngBytes(), finalUrl: url };
          },
        },
      );

      expect(outcome.incomplete).toBe(true);
      // Bounded, and bounded by the CAP rather than by the row count.
      expect(fetches).toBe(4);
      expect(fetches).toBeLessThan(20);
    });

    /*
     * The property that matters most: repeated ticks REACH THE END. Each run
     * permanently retires what it reached, so the queue drains instead of the
     * same first rows being re-done for ever.
     */
    it('drains a backlog larger than one run over successive ticks', async () => {
      const wideCsv = [
        'Reference,Development,Lot,Package Price,Photo',
        ...Array.from({ length: 20 }, (_, i) =>
          `NPC-4${i},Riverbank,4${i},640000,https://builder.example/img/lot-4${i}.jpg`),
      ].join('\r\n');
      const wideUpload = {
        ...upload, id: 'upload-drain',
        storage_path: 'stock-lists/org-a/upload-drain/stock.csv',
      };
      const db = fakeDb({
        uploads: [wideUpload],
        items: Array.from({ length: 20 }, (_, i) => ({
          id: `item-4${i}`, organisation_id: 'org-a', lifecycle_status: 'active',
          external_reference: `NPC-4${i}`, development_name: 'Riverbank',
          project_name: null, unit_number: null, lot_number: `4${i}`,
          primary_image_id: null,
        })),
        objects: { [wideUpload.storage_path]: new TextEncoder().encode(wideCsv) },
      });

      const perTick: number[] = [];
      let ticks = 0;
      let outcome = { incomplete: true } as { incomplete: boolean };
      while (outcome.incomplete && ticks < 10) {
        ticks += 1;
        let fetches = 0;
        outcome = await repairSourceImagesForUpload(
          db, { organisationId: 'org-a', uploadId: 'upload-drain' },
          {
            fetchImage: async (url: string) => {
              fetches += 1;
              return { bytes: pngBytes(), finalUrl: url };
            },
          },
        );
        perTick.push(fetches);
      }

      // It ENDS, and in the number of ticks the cap implies — not the 10 the
      // loop would allow, and never the "for ever" this replaces.
      expect(outcome.incomplete).toBe(false);
      expect(ticks).toBe(5);
      expect(perTick).toEqual([4, 4, 4, 4, 4]);
      // Every property ended up with its builder image.
      const stored = db.tables.builder_stock_item_images.filter(
        (row: FakeRow) => row.source_stage === 'uploaded_document'
          && row.processing_status === 'ready');
      expect(stored).toHaveLength(20);
    });
  });

  it('cannot attach one builder\'s source image to another builder\'s stock', async () => {
    const db = fakeDb({
      uploads: [upload],
      items: [
        // The SAME reference, owned by a different organisation.
        {
          id: 'item-other', organisation_id: 'org-b', lifecycle_status: 'active',
          external_reference: 'NPC-101', development_name: 'Riverbank',
          project_name: null, unit_number: null, lot_number: '101',
          primary_image_id: null,
        },
      ],
      objects: { [upload.storage_path]: new TextEncoder().encode(csv) },
    });

    const outcome = await repairSourceImagesForUpload(db, {
      organisationId: 'org-a', uploadId: 'upload-1',
    });

    expect(outcome.rowsRead).toBe(1);
    expect(outcome.matched).toBe(0);
    expect(db.tables.builder_stock_item_images).toHaveLength(0);
    expect(db.tables.builder_stock_items[0].primary_image_id).toBeNull();
  });

  it('recovers a render from the row\'s own linked package when the row itself has none', async () => {
    const packageCsv = [
      'Deal,Estate Tag,Package Price,Complete Package Pack',
      '"Lot 43 - Tringa Street, Sandpiper Estate, Tweed Heads South NSW 2486 [Stradbroke 180]",'
        + 'Sandpiper Estate,1307585,https://drive.google.com/drive/folders/pack-root-0001',
    ].join('\r\n');

    // A real render: the package designates it, so it is the one the display
    // rule decodes and measures before a card may draw it.
    const jpeg = jpegOf(cleanPicture(340, 191), 160_000);

    const encoder = new TextEncoder();
    const listing = (entries: Array<[string, string, string]>) => {
      const json = JSON.stringify([entries.map(([id, label, mime]) => [id, ['p'], label, mime]), null]);
      const escaped = json.replace(/[[\]"\\/]/g, (character) =>
        `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`);
      return encoder.encode(`<script>window['_DRIVE_ivd'] = '${escaped}';</script>`);
    };
    const FOLDER = 'application/vnd.google-apps.folder';
    const pdfBytes = (() => {
      // A real page: a MediaBox, and a content stream that DRAWS the render.
      const draw = 'q 516 0 0 290 40 480 cm /Im0 Do Q';
      const head = encoder.encode('%PDF-1.4\n'
        + '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
        + '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
        + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox [0 0 595 842]'
        + '/Resources<</XObject<</Im0 4 0 R>>>>/Contents 5 0 R>>endobj\n'
        + `4 0 obj<</Type/XObject/Subtype/Image/Width 1700/Height 956/Filter/DCTDecode/Length ${jpeg.length}>>stream\n`);
      const tail = encoder.encode('\nendstream\nendobj\n'
        + `5 0 obj<</Length ${draw.length}>>stream\n${draw}\nendstream\nendobj\n`
        + 'trailer<</Root 1 0 R>>\n');
      const out = new Uint8Array(head.length + jpeg.length + tail.length);
      out.set(head, 0); out.set(jpeg, head.length); out.set(tail, head.length + jpeg.length);
      return out;
    })();

    const fetchPackage = async (url: string) => {
      if (url.includes('/folders/pack-root-0001')) {
        return { bytes: listing([['packages-0001', 'Tweed Heads Packages', FOLDER]]), finalUrl: url };
      }
      if (url.includes('/folders/packages-0001')) {
        return { bytes: listing([['lot43-0001', 'Lot 43', FOLDER]]), finalUrl: url };
      }
      if (url.includes('/folders/lot43-0001')) {
        return {
          bytes: listing([['doc-strad-0001', 'Lot 43 - Stradbroke 180 - Property Package.pdf', 'application/pdf']]),
          finalUrl: url,
        };
      }
      if (url.includes('id=doc-strad-0001')) return { bytes: pdfBytes, finalUrl: url };
      return { bytes: encoder.encode('<html>Sign in</html>'), finalUrl: url };
    };

    const packUpload = { ...upload, id: 'upload-2', storage_path: 'stock-lists/org-a/upload-2/stock.csv' };
    const db = fakeDb({
      uploads: [packUpload],
      items: [{
        id: 'item-43', organisation_id: 'org-a', lifecycle_status: 'active',
        external_reference: null, development_name: 'Sandpiper Estate',
        project_name: null, unit_number: null, lot_number: null,
        primary_image_id: 'google-43',
        source_row: {
          address_line: 'Lot 43 - Tringa Street, Sandpiper Estate, Tweed Heads South NSW 2486 [Stradbroke 180]',
          development_name: 'Sandpiper Estate', price: 1307585,
        },
      }],
      images: [{
        id: 'google-43', stock_item_id: 'item-43', source_stage: 'google_maps',
        processing_status: 'ready', position: 0, storage_path: 'g.jpg',
      }],
      objects: { [packUpload.storage_path]: encoder.encode(packageCsv) },
    });

    /**
     * The package's own cover page, as a person reads it: this property's
     * identity together with its package information. That — and not the
     * picture's size — is what makes the render on it the property's image.
     */
    const readPageTexts = async () => [
      'Lot 43 - Tringa Street, Sandpiper Estate, Tweed Heads South NSW 2486 [Stradbroke 180]\n'
      + 'FIXED PRICE CONTRACT\n$1,307,585\nLand Size 350 m2\n4 bed 2 bath 2 car',
    ];

    const outcome = await repairSourceImagesForUpload(
      db, { organisationId: 'org-a', uploadId: 'upload-2' }, { fetchPackage, readPageTexts },
    );

    expect(outcome.error).toBeUndefined();
    expect(outcome.fromPackage).toBe(1);
    expect(outcome.imagesStored).toBe(1);
    expect(outcome.packageNotIdentified).toBe(0);

    const stored = db.tables.builder_stock_item_images
      .find((row: FakeRow) => row.source_stage === 'uploaded_document');
    expect(stored).toMatchObject({
      stock_item_id: 'item-43',
      verification_status: 'source_supplied',
      processing_status: 'ready',
      source_provider: 'linked_package',
      content_type: 'image/jpeg',
    });
    expect(stored!.source_reference)
      .toBe('Lot 43 - Stradbroke 180 - Property Package.pdf#page1:Im0');
    // Provenance enough to prove it: the document, the page, the object and
    // the hash of the bytes we are serving.
    expect(stored!.source_detail).toMatchObject({
      document: 'Lot 43 - Stradbroke 180 - Property Package.pdf',
      page: 1,
      extraction_method: 'embedded_raster',
      pdf_resource: 'Im0',
      transformation: null,
    });
    expect(String((stored!.source_detail as Record<string, unknown>).stored_sha256))
      .toHaveLength(64);
    // The card now shows the builder's render; the property itself is untouched.
    expect(db.tables.builder_stock_items[0].primary_image_id).toBe(stored!.id);
    expect(db.tables.builder_stock_items).toHaveLength(1);
    expect(db.tables.builder_stock_items[0].id).toBe('item-43');
  });

  it('leaves the fallback alone when the package names nothing for that property', async () => {
    const packageCsv = [
      'Deal,Estate Tag,Package Price,Complete Package Pack',
      '"Lot 914 - Covella Estate, Greenbank QLD 4124",Covella,900000,'
        + 'https://drive.google.com/drive/folders/covella-folder-01',
    ].join('\r\n');
    const encoder = new TextEncoder();
    const listing = (entries: Array<[string, string, string]>) => {
      const json = JSON.stringify([entries.map(([id, label, mime]) => [id, ['p'], label, mime]), null]);
      const escaped = json.replace(/[[\]"\\/]/g, (character) =>
        `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`);
      return encoder.encode(`<script>window['_DRIVE_ivd'] = '${escaped}';</script>`);
    };

    const covellaUpload = { ...upload, id: 'upload-3', storage_path: 'stock-lists/org-a/upload-3/stock.csv' };
    const db = fakeDb({
      uploads: [covellaUpload],
      items: [{
        id: 'item-914', organisation_id: 'org-a', lifecycle_status: 'active',
        external_reference: null, development_name: 'Covella', project_name: null,
        unit_number: null, lot_number: null, primary_image_id: 'google-914',
        source_row: {
          address_line: 'Lot 914 - Covella Estate, Greenbank QLD 4124',
          development_name: 'Covella', price: 900000,
        },
      }],
      images: [{
        id: 'google-914', stock_item_id: 'item-914', source_stage: 'google_maps',
        processing_status: 'ready', position: 0, storage_path: 'g.jpg',
      }],
      objects: { [covellaUpload.storage_path]: encoder.encode(packageCsv) },
    });

    const outcome = await repairSourceImagesForUpload(
      db, { organisationId: 'org-a', uploadId: 'upload-3' },
      {
        // Three documents, every one of them naming lot 914: the folder does
        // not say which is the property's photograph, so neither do we.
        fetchPackage: async (url: string) => ({
          bytes: listing([
            ['a', 'LOT 914 • COVELLA • GREENBANK QLD.pdf', 'application/pdf'],
            ['b', 'OTP_Land_Contract_P1_-_Rana_-_Lot_914_Covella.pdf', 'application/pdf'],
            ['c', 'Rental Appraisal_ Lot 914, Covella Estate.pdf', 'application/pdf'],
          ]),
          finalUrl: url,
        }),
      },
    );

    expect(outcome.fromPackage).toBe(0);
    expect(outcome.packageNotIdentified).toBe(1);
    expect(db.tables.builder_stock_item_images
      .some((row: FakeRow) => row.source_stage === 'uploaded_document')).toBe(false);
    // The existing location image stays exactly where it was.
    expect(db.tables.builder_stock_items[0].primary_image_id).toBe('google-914');
  });

  it('refuses a source that belongs to another organisation outright', async () => {
    const db = fakeDb({ uploads: [upload] });
    const outcome = await repairSourceImagesForUpload(db, {
      organisationId: 'org-b', uploadId: 'upload-1',
    });
    expect(outcome.error).toBe('That source could not be found.');
  });
});

// ---------------------------------------------------------------------------
// TESTS A–L — a package that was READ and named nothing is a finished answer
//
// The repair had three outcomes for a linked package and wrote down only one.
// "Read it, and it names no image for this property" is knowledge, and throwing
// it away is what made the sweep immortal: it could not tell an answered
// property from an unlooked-at one, so it re-fetched and re-parsed the same
// Drive document every five minutes. Production upload f7e0d4d1 is 70 rows, 13
// already current and the rest already answered — `rows_read: 70, matched: 13,
// images_stored: 0`, for ever.
// ---------------------------------------------------------------------------

describe('a package that named no image is not read again', () => {
  const FOLDER_A = 'https://drive.google.com/drive/folders/folder-aaa';
  const FOLDER_B = 'https://drive.google.com/drive/folders/folder-bbb';

  /** A Drive folder listing that loads and names one unrelated document. */
  const listingHtml = (name: string) =>
    `<html><script>window['_DRIVE_ivd'] = '`
    + JSON.stringify([[['doc-1', 'x', name, 'application/pdf']]])
        .replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    + `';</script></html>`;

  const upload = {
    id: 'upload-pkg', organisation_id: 'org-a', source_type: 'file',
    source_url: null, final_url: null, original_filename: 'stock.csv',
    storage_bucket: 'builder-stock-lists',
    storage_path: 'stock-lists/org-a/upload-pkg/stock.csv',
    deleted_at: null,
  };

  const csvFor = (rows: Array<{ ref: string; lot: string; pkg: string }>) => [
    'Reference,Development,Lot,Package Price,Complete Package Pack',
    ...rows.map((r) => `${r.ref},Riverbank,${r.lot},640000,${r.pkg}`),
  ].join('\r\n');

  const itemFor = (ref: string, lot: string, extra: FakeRow = {}) => ({
    id: `item-${ref}`, organisation_id: 'org-a', lifecycle_status: 'active',
    external_reference: ref, development_name: 'Riverbank',
    project_name: null, unit_number: null, lot_number: lot,
    primary_image_id: null, ...extra,
  });

  /**
   * A world where the folder loads and names a document for nobody. The
   * package is READ — the listing costs a fetch — and answers "nothing here".
   */
  const readableButEmpty = () => {
    const fetched: string[] = [];
    return {
      fetched,
      fetchPackage: async (url: string) => {
        fetched.push(url);
        return {
          bytes: new TextEncoder().encode(listingHtml('Someone Elses Brochure.pdf')),
          finalUrl: url,
        };
      },
    };
  };

  const run = (db: unknown, deps: Record<string, unknown>) =>
    repairSourceImagesForUpload(
      db as never, { organisationId: 'org-a', uploadId: 'upload-pkg' }, deps as never);

  // ── B ────────────────────────────────────────────────────────────────────
  it('B — records a terminal negative result when the package names no image', async () => {
    const db = fakeDb({
      uploads: [upload],
      items: [itemFor('NPC-1', '1')],
      objects: {
        [upload.storage_path]: new TextEncoder().encode(
          csvFor([{ ref: 'NPC-1', lot: '1', pkg: FOLDER_A }])),
      },
    });
    const drive = readableButEmpty();

    const outcome = await run(db, { fetchPackage: drive.fetchPackage });

    expect(outcome.packageNotIdentified).toBe(1);
    expect(outcome.imagesStored).toBe(0);
    // The package WAS read — this is an answer, not an assumption.
    expect(drive.fetched.length).toBeGreaterThan(0);

    const item = db.tables.builder_stock_items[0];
    expect(item.source_provenance_result).toMatchObject({
      result: 'no_deterministic_image',
      provenance_version: PROVENANCE_VERSION,
      package_reference: FOLDER_A,
    });
    // Nothing was invented to show: no image row exists for this property.
    expect(db.tables.builder_stock_item_images).toHaveLength(0);
    // And the pass reached the end, so the caller may write the marker.
    expect(outcome.incomplete).toBe(false);
  });

  // ── C ────────────────────────────────────────────────────────────────────
  it('C — does not fetch or parse that package again on the next tick', async () => {
    const db = fakeDb({
      uploads: [upload],
      items: [itemFor('NPC-1', '1')],
      objects: {
        [upload.storage_path]: new TextEncoder().encode(
          csvFor([{ ref: 'NPC-1', lot: '1', pkg: FOLDER_A }])),
      },
    });

    const first = readableButEmpty();
    await run(db, { fetchPackage: first.fetchPackage });
    expect(first.fetched.length).toBeGreaterThan(0);

    // Second tick, same everything. The answer is already banked.
    const second = readableButEmpty();
    const outcome = await run(db, { fetchPackage: second.fetchPackage });

    expect(second.fetched).toEqual([]);
    expect(outcome.packageAlreadyAnswered).toBe(1);
    expect(outcome.incomplete).toBe(false);
  });

  // ── D ────────────────────────────────────────────────────────────────────
  it('D — a PROVENANCE_VERSION bump re-opens the question', async () => {
    const db = fakeDb({
      uploads: [upload],
      // An answer banked by the PREVIOUS version of the extractor.
      items: [itemFor('NPC-1', '1', {
        source_provenance_result: {
          result: 'no_deterministic_image',
          provenance_version: PROVENANCE_VERSION - 1,
          package_reference: FOLDER_A,
          source_anchor: null,
          detail: 'nothing found',
          checked_at: '2026-01-01T00:00:00.000Z',
        },
      })],
      objects: {
        [upload.storage_path]: new TextEncoder().encode(
          csvFor([{ ref: 'NPC-1', lot: '1', pkg: FOLDER_A }])),
      },
    });
    const drive = readableButEmpty();

    const outcome = await run(db, { fetchPackage: drive.fetchPackage });

    // A better extractor may find what the old one could not, so it looks.
    expect(drive.fetched.length).toBeGreaterThan(0);
    expect(outcome.packageAlreadyAnswered).toBe(0);
    expect(db.tables.builder_stock_items[0].source_provenance_result)
      .toMatchObject({ provenance_version: PROVENANCE_VERSION });
  });

  // ── E ────────────────────────────────────────────────────────────────────
  it('E — a changed package is checked, and the old answer does not suppress it', async () => {
    const db = fakeDb({
      uploads: [upload],
      items: [itemFor('NPC-1', '1', {
        source_provenance_result: {
          result: 'no_deterministic_image',
          provenance_version: PROVENANCE_VERSION,
          package_reference: FOLDER_A,
          source_anchor: null,
          detail: 'nothing found',
          checked_at: '2026-01-01T00:00:00.000Z',
        },
      })],
      // The builder has swapped the row's package for a different one.
      objects: {
        [upload.storage_path]: new TextEncoder().encode(
          csvFor([{ ref: 'NPC-1', lot: '1', pkg: FOLDER_B }])),
      },
    });
    const drive = readableButEmpty();

    const outcome = await run(db, { fetchPackage: drive.fetchPackage });

    expect(drive.fetched.length).toBeGreaterThan(0);
    expect(outcome.packageAlreadyAnswered).toBe(0);
    // The banked answer now names the package actually checked.
    expect(db.tables.builder_stock_items[0].source_provenance_result)
      .toMatchObject({ package_reference: FOLDER_B });
  });

  // ── F ────────────────────────────────────────────────────────────────────
  it('F — a package that cannot be read writes NO answer and stays retryable', async () => {
    const db = fakeDb({
      uploads: [upload],
      items: [itemFor('NPC-1', '1')],
      objects: {
        [upload.storage_path]: new TextEncoder().encode(
          csvFor([{ ref: 'NPC-1', lot: '1', pkg: FOLDER_A }])),
      },
    });

    // A folder behind a sign-in wall lists nothing.
    const outcome = await run(db, {
      fetchPackage: async (url: string) => ({
        bytes: new TextEncoder().encode('<html>Sign in</html>'), finalUrl: url,
      }),
    });

    expect(outcome.packageUnreachable).toBe(1);
    // "We could not look" is not "there is nothing to find".
    expect(db.tables.builder_stock_items[0].source_provenance_result).toBeUndefined();
    expect(outcome.incomplete).toBe(true);
  });

  // ── G ────────────────────────────────────────────────────────────────────
  it('G — a parser or runtime failure writes NO answer and stays retryable', async () => {
    const db = fakeDb({
      uploads: [upload],
      items: [itemFor('NPC-1', '1')],
      objects: {
        [upload.storage_path]: new TextEncoder().encode(
          csvFor([{ ref: 'NPC-1', lot: '1', pkg: FOLDER_A }])),
      },
    });

    const outcome = await run(db, {
      fetchPackage: async () => { throw new Error('parser exploded'); },
    });

    expect(db.tables.builder_stock_items[0].source_provenance_result).toBeUndefined();
    expect(outcome.incomplete).toBe(true);
  });

  // ── H ────────────────────────────────────────────────────────────────────
  it('H — a failed write does not let the upload be marked settled', async () => {
    const db = fakeDb({
      uploads: [upload],
      items: [itemFor('NPC-1', '1')],
      objects: {
        [upload.storage_path]: new TextEncoder().encode(
          csvFor([{ ref: 'NPC-1', lot: '1', pkg: FOLDER_A }])),
      },
      failUpdatesOn: 'builder_stock_items',
    });
    const drive = readableButEmpty();

    const outcome = await run(db, { fetchPackage: drive.fetchPackage });

    // The answer was reached and could not be persisted, so as far as anything
    // reading this property is concerned it was never reached.
    expect(db.tables.builder_stock_items[0].source_provenance_result).toBeUndefined();
    expect(outcome.incomplete).toBe(true);
  });

  // ── J ────────────────────────────────────────────────────────────────────
  //
  // The production shape, to scale: 70 rows, 13 already holding a current
  // image, 57 whose packages read successfully and name nothing. Before the
  // terminal answer this ran for ever; the assertion is that it ENDS, and ends
  // without ever exceeding the per-run work bound that the edge worker's CPU
  // limit forced.
  it('J — 70 rows, 13 current, 57 answered: converges and never exceeds the bound', async () => {
    const rows = Array.from({ length: 70 }, (_, i) => ({
      ref: `NPC-${i}`, lot: `${i}`, pkg: FOLDER_A,
    }));
    const current = rows.slice(0, 13);

    const db = fakeDb({
      uploads: [upload],
      items: rows.map((r) => itemFor(r.ref, r.lot)),
      // The 13 that already hold a current builder image.
      images: current.map((r) => ({
        id: `img-${r.ref}`, stock_item_id: `item-${r.ref}`, organisation_id: 'org-a',
        source_stage: 'uploaded_document', source_reference: `ref-${r.ref}`,
        processing_status: 'ready', verification_status: 'source_supplied',
        position: 0, storage_path: `s/${r.ref}.jpg`,
        source_detail: { ...PRIMARY_ROLE_DETAIL, provenance_version: PROVENANCE_VERSION },
      })),
      objects: { [upload.storage_path]: new TextEncoder().encode(csvFor(rows)) },
    });

    const perTick: number[] = [];
    let ticks = 0;
    let outcome = { incomplete: true } as { incomplete: boolean };
    while (outcome.incomplete && ticks < 200) {
      ticks += 1;
      const drive = readableButEmpty();
      outcome = await run(db, { fetchPackage: drive.fetchPackage });
      // One listing serves every row in a tick, so count properties answered.
      perTick.push((outcome as unknown as { packageNotIdentified: number }).packageNotIdentified);
    }

    // It ENDS. That is the whole point.
    expect(outcome.incomplete).toBe(false);
    // And never did more per run than the CPU bound allows.
    // A package recovery parses a whole PDF, so it carries the tighter of the
    // two bounds: four in one invocation is what still logged `CPU Time
    // exceeded` in production after 44 of these rows had been answered.
    for (const answered of perTick) expect(answered).toBeLessThanOrEqual(1);
    // It took a tick per outstanding package and no more — the banked answers
    // are what stop it re-reading, so the count is the backlog, not a loop.
    expect(ticks).toBe(57);
    // Every one of the 57 is now a banked answer, and none of the 13 was touched.
    const answeredRows = db.tables.builder_stock_items
      .filter((row: FakeRow) => row.source_provenance_result);
    expect(answeredRows).toHaveLength(57);
    expect(db.tables.builder_stock_item_images).toHaveLength(13);
  });

  // ── A ────────────────────────────────────────────────────────────────────
  //
  // The other half of the rule: an answer of "there IS a picture" must not
  // leave a "there is none" behind it. A direct file link is used so the whole
  // extractor runs — find, fetch, read the cover, take the picture — rather
  // than a stub standing in for it.
  it('A — a recovered package image stores the image and leaves no negative result', async () => {
    const FILE_LINK = 'https://drive.google.com/file/d/doc-lot-7-aaaa/view';
    const LABEL_LOT = '7';
    const jpeg = (() => {
      const bytes = new Uint8Array(160_000);
      bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
      bytes.fill(0x42, 4, bytes.length - 2);
      bytes.set([0xff, 0xd9], bytes.length - 2);
      return bytes;
    })();
    const cat = (parts: Array<Uint8Array | string>) => {
      const enc = new TextEncoder();
      const chunks = parts.map((part) => typeof part === 'string' ? enc.encode(part) : part);
      const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
      return out;
    };
    const draw = 'q 516 0 0 290 40 480 cm /Im0 Do Q';
    const packageBytes = cat([
      '%PDF-1.4\n',
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n',
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n',
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox [0 0 595 842]'
        + '/Resources<</XObject<</Im0 4 0 R>>>>/Contents 5 0 R>>endobj\n',
      `4 0 obj<</Type/XObject/Subtype/Image/Width 1700/Height 956/Filter/DCTDecode/Length ${jpeg.length}>>stream\n`,
      jpeg,
      '\nendstream\nendobj\n',
      `5 0 obj<</Length ${draw.length}>>stream\n${draw}\nendstream\nendobj\n`,
      'trailer<</Root 1 0 R>>\n%%EOF\n',
    ]);

    const db = fakeDb({
      uploads: [upload],
      // It starts holding a STALE answer, so the clearing is exercised too.
      items: [itemFor('NPC-7', LABEL_LOT, {
        source_provenance_result: {
          result: 'no_deterministic_image',
          provenance_version: PROVENANCE_VERSION - 1,
          package_reference: FILE_LINK,
          source_anchor: null,
          detail: 'an older extractor found nothing',
          checked_at: '2026-01-01T00:00:00.000Z',
        },
      })],
      objects: {
        [upload.storage_path]: new TextEncoder().encode(
          csvFor([{ ref: 'NPC-7', lot: LABEL_LOT, pkg: FILE_LINK }])),
      },
    });

    const outcome = await run(db, {
      fetchPackage: async (url: string) => ({ bytes: packageBytes, finalUrl: url }),
      // The cover names this property, which is what admits the picture.
      // The same cover shape the package fixtures use: the row's own label,
      // then the package information that makes it a cover rather than a page.
      readPageTexts: async () => [
        'Lot 7\nFIXED PRICE CONTRACT\n$640,000\nLand Size 350 m2\n4 bed 2 bath 2 car',
      ],
    });

    expect(outcome.fromPackage).toBe(1);
    expect(outcome.imagesStored).toBe(1);
    expect(outcome.packageNotIdentified).toBe(0);
    // The stale answer is gone rather than sitting beside the picture.
    expect(db.tables.builder_stock_items[0].source_provenance_result).toBeNull();
    expect(outcome.incomplete).toBe(false);
  });

  // ── I ────────────────────────────────────────────────────────────────────
  it('I — a mix of current images, banked answers and fresh answers completes', async () => {
    const rows = [
      { ref: 'NPC-A', lot: '1', pkg: FOLDER_A },
      { ref: 'NPC-B', lot: '2', pkg: FOLDER_A },
      { ref: 'NPC-C', lot: '3', pkg: FOLDER_A },
    ];
    const db = fakeDb({
      uploads: [upload],
      items: [
        itemFor('NPC-A', '1'),
        // Already answered at the current version.
        itemFor('NPC-B', '2', {
          source_provenance_result: {
            result: 'no_deterministic_image',
            provenance_version: PROVENANCE_VERSION,
            package_reference: FOLDER_A,
            source_anchor: null,
            detail: 'nothing found',
            checked_at: '2026-01-01T00:00:00.000Z',
          },
        }),
        itemFor('NPC-C', '3'),
      ],
      // Already holds a current image.
      images: [{
        id: 'img-C', stock_item_id: 'item-NPC-C', organisation_id: 'org-a',
        source_stage: 'uploaded_document', source_reference: 'ref-C',
        processing_status: 'ready', verification_status: 'source_supplied',
        position: 0, storage_path: 's/c.jpg',
        source_detail: { ...PRIMARY_ROLE_DETAIL, provenance_version: PROVENANCE_VERSION },
      }],
      objects: { [upload.storage_path]: new TextEncoder().encode(csvFor(rows)) },
    });
    const drive = readableButEmpty();

    const outcome = await run(db, { fetchPackage: drive.fetchPackage });

    expect(outcome.incomplete).toBe(false);
    expect(outcome.packageAlreadyAnswered).toBe(1);
    expect(outcome.packageNotIdentified).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// WHAT THE CARD ACTUALLY SHOWS
//
// The settlement machinery is not the requirement. The requirement is that a
// clean builder photograph of THIS property appears, an ugly marketing tile
// does not, and nothing else is ever substituted for either. These assert the
// outcome the Marketplace renders, through the same predicate the card and the
// bytes endpoint both use.
// ---------------------------------------------------------------------------

describe('what the Builder Stock card displays', () => {
  const sourceImage = (over: FakeRow = {}): FakeRow => ({
    id: 'img', stock_item_id: 'item-1', organisation_id: 'org-a',
    source_stage: 'uploaded_document', verification_status: 'source_supplied',
    processing_status: 'ready', storage_path: 's/img.jpg', position: 0,
    source_detail: { ...PRIMARY_ROLE_DETAIL },
    ...over,
  });

  /** A verdict the classifier actually produced, not a hand-written literal. */
  const cleanDetail = { ...roleDetail(PRIMARY_ASSET_ROLE), ...CLEAN_VERDICT };
  // The classifier's OWN verdict on an annotated picture, not a literal: a
  // hand-written 'ineligible' would pass these tests even if the classifier
  // stopped producing one.
  const rejectedDetail = { ...roleDetail(PRIMARY_ASSET_ROLE), ...ANNOTATED_VERDICT };

  // ── 1 ────────────────────────────────────────────────────────────────────
  it('1 — a clean exact builder primary displays', async () => {
    const db = fakeDb({
      items: [{ id: 'item-1', primary_image_id: null }],
      images: [sourceImage({ id: 'clean', source_detail: cleanDetail })],
    });
    expect(await chooseAndStorePrimaryImage(db, 'item-1')).toBe('clean');
  });

  // ── 3 ────────────────────────────────────────────────────────────────────
  //
  // Rejecting the tile must not blank a property that HAS a clean primary. The
  // clean one is chosen because it is a source-designated primary in its own
  // right, never because it was the only thing left standing.
  it('3 — a rejected marketing tile does not hide a separate clean primary', async () => {
    const db = fakeDb({
      items: [{ id: 'item-1', primary_image_id: 'tile' }],
      images: [
        sourceImage({ id: 'tile', position: 0, source_detail: rejectedDetail }),
        sourceImage({ id: 'clean', position: 1, source_detail: cleanDetail }),
      ],
    });
    expect(await chooseAndStorePrimaryImage(db, 'item-1')).toBe('clean');
  });

  // ── 4 ────────────────────────────────────────────────────────────────────
  it('4 — a rejected tile beside only an interior leaves the card blank', async () => {
    // `roleFromStructuralContainer` is the constructor for "the source SAYS
    // this is the hero", so it always yields primary_property — an interior is
    // a secondary role, which is exactly why it can never reach a card.
    const interior = {
      ...roleDetail(secondaryRole('interior', 'a gallery photograph of a bedroom')),
      ...CLEAN_VERDICT,
    };
    const db = fakeDb({
      items: [{ id: 'item-1', primary_image_id: 'tile' }],
      images: [
        sourceImage({ id: 'tile', position: 0, source_detail: rejectedDetail }),
        // Perfectly clean, perfectly useless: it is not this property's hero.
        sourceImage({ id: 'interior', position: 1, source_detail: interior }),
      ],
    });
    expect(await chooseAndStorePrimaryImage(db, 'item-1')).toBeNull();
    expect(db.tables.builder_stock_items[0].primary_image_id).toBeNull();
  });

  // ── 5 ────────────────────────────────────────────────────────────────────
  it('5 — a clean facade carrying a small builder mark still displays', async () => {
    // The real Cloverton cover: a corner "HOUSE & LAND" mark and a footer
    // disclaimer strip. Normal presentation, not a marketing tile.
    const db = fakeDb({
      items: [{ id: 'item-1', primary_image_id: null }],
      images: [sourceImage({ id: 'marked', source_detail: cleanDetail })],
    });
    expect(await chooseAndStorePrimaryImage(db, 'item-1')).toBe('marked');
  });

  // ── 7 ────────────────────────────────────────────────────────────────────
  it('7 — an image belonging to another property is never shown here', async () => {
    const db = fakeDb({
      items: [{ id: 'item-1', primary_image_id: null }],
      images: [sourceImage({
        id: 'other-house', stock_item_id: 'item-2', source_detail: cleanDetail,
      })],
    });
    expect(await chooseAndStorePrimaryImage(db, 'item-1')).toBeNull();
  });

  // ── 6 ────────────────────────────────────────────────────────────────────
  it('6 — an unjudged candidate is not displayed', async () => {
    const db = fakeDb({
      items: [{ id: 'item-1', primary_image_id: null }],
      images: [sourceImage({
        id: 'unjudged',
        // Role proven, verdict never reached. Fail closed.
        source_detail: { ...roleDetail(PRIMARY_ASSET_ROLE) },
      })],
    });
    expect(await chooseAndStorePrimaryImage(db, 'item-1')).toBeNull();
  });

  // ── 8 ────────────────────────────────────────────────────────────────────
  //
  // The builder replaces the tile with a clean render. Nobody presses anything:
  // the new verdict is written by the ordinary sweep and the pointer follows.
  it('8 — when the source stops being a tile, the card fills automatically', async () => {
    const db = fakeDb({
      items: [{ id: 'item-1', primary_image_id: null }],
      images: [sourceImage({ id: 'was-a-tile', source_detail: rejectedDetail })],
    });
    expect(await chooseAndStorePrimaryImage(db, 'item-1')).toBeNull();

    // The same row, re-assessed after the builder swapped the artwork.
    db.tables.builder_stock_item_images[0].source_detail = cleanDetail;
    expect(await chooseAndStorePrimaryImage(db, 'item-1')).toBe('was-a-tile');
  });
});
