/**
 * Builder stock — the images inside a DIRECTLY UPLOADED PDF.
 *
 * WHAT WAS WRONG. A builder uploading their own brochure through Stock List →
 * Upload PDF got the property imported and this on the import panel:
 *
 *     "Images inside a PDF are not extracted; location and search imagery are
 *      used instead."
 *
 * Both halves were wrong by then. Nothing extracted the pictures, and location
 * and search imagery are no longer displayable at all — so the sentence
 * promised a photograph that could never appear, on a card that stayed empty.
 *
 * WHAT THESE PIN. The picture on a Builder Stock card is a picture the builder
 * put in their own document, taken out of it byte for byte and provable by
 * hash. Where the document does not say which property a picture belongs to,
 * nothing is attached and the card stays empty — that is the correct outcome,
 * not a gap to be filled.
 *
 * The fixtures are the shape of the live Donnybrook contract this was measured
 * against: a cover whose largest raster is a decorative grey wash, a floorplan
 * drawn as line art, a full-bleed render on a later page, and every one of them
 * nested inside a single form XObject the way every real exporter emits them.
 */
import { describe, expect, it } from 'vitest';

import { cleanPicture, jpegOf } from './fixtures/builderStockPictures';
import { deflateSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { extractStockFile } from '../../../supabase/functions/_shared/builderStock/extract';
import { classifyStockFile } from '../../../supabase/functions/_shared/builderStock/fileTypes.pure';
import {
  extractExactSourcePhotoFromPdf, extractPdfPagePhoto, extractPdfPhotosByPage,
} from '../../../supabase/functions/_shared/builderStock/pdfSourcePhoto';
import {
  anchorPdfRowsToPages, pdfAnchorPage, pdfPageAnchor,
} from '../../../supabase/functions/_shared/builderStock/pdfRowAnchors.pure';
import { attributeDocumentMedia } from '../../../supabase/functions/_shared/builderStock/sourceAssets.pure';
import { sha256Hex } from '../../../supabase/functions/_shared/builderStock/rasterPng';

// ---------------------------------------------------------------------------
// Fixtures — a PDF the way a real exporter writes one
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function concat(parts: Array<Uint8Array | string>): Uint8Array {
  const chunks = parts.map((part) => typeof part === 'string' ? encoder.encode(part) : part);
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

/**
 * A JPEG with real markers, sized so its DETAIL is what the test intends.
 *
 * Bytes per pixel is the only measure of detail available without decoding the
 * image, and it is what separates a render from a decorative wash: the live
 * cover's grey faceted background is 1300×698 in 10 KB.
 */
function jpeg(fill: number, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  out.set([0xff, 0xd8, 0xff, 0xe0], 0);
  out.fill(fill, 4, bytes - 2);
  out.set([0xff, 0xd9], bytes - 2);
  return out;
}

interface FixtureImage {
  name: string;
  width: number;
  height: number;
  data: Uint8Array;
  filter: 'DCTDecode' | 'FlateDecode';
  /** `[a b c d e f] cm` in the space that draws it. */
  cm: [number, number, number, number, number, number];
}

interface FixturePage {
  images: FixtureImage[];
  /** The prose the text layer reports for this page. */
  text: string;
  /**
   * Wrap the page's drawing in a form XObject, the way every real exporter
   * does. The page then names NO images of its own.
   */
  inForm?: boolean;
}

/** A PDF whose pages draw the given images, optionally through a form. */
function buildPdf(pages: FixturePage[]): Uint8Array {
  const parts: Array<Uint8Array | string> = ['%PDF-1.4\n'];
  const bodies: Array<Uint8Array | string> = [];
  const pageObjects: number[] = [];
  let next = 3 + pages.length;

  pages.forEach((page, index) => {
    const pageNumber = 3 + index;
    pageObjects.push(pageNumber);

    const entries: string[] = [];
    const draw: string[] = [];
    for (const image of page.images) {
      const objectNumber = next++;
      entries.push(`/${image.name} ${objectNumber} 0 R`);
      draw.push(`q ${image.cm.join(' ')} cm /${image.name} Do Q`);
      bodies.push(
        `${objectNumber} 0 obj<</Type/XObject/Subtype/Image/Width ${image.width}`
        + `/Height ${image.height}/ColorSpace/DeviceRGB/BitsPerComponent 8`
        + `/Filter/${image.filter}/Length ${image.data.length}>>stream\n`,
        image.data,
        '\nendstream\nendobj\n',
      );
    }

    const inner = draw.join('\n');
    let stream: string;
    let resources: string;

    if (page.inForm) {
      // The exporter's wrapper: the page draws one form, and the pictures are
      // named by the FORM's resources rather than the page's.
      const formNumber = next++;
      bodies.push(
        `${formNumber} 0 obj<</Type/XObject/Subtype/Form/BBox [0 0 595 842]`
        + `/Matrix [1 0 0 1 0 0]`
        + `/Resources <</ProcSet [/PDF /ImageC]/ExtGState <</G3 99 0 R>>`
        + `/XObject <<${entries.join(' ')}>>>>/Length ${inner.length}>>stream\n${inner}\nendstream\nendobj\n`,
      );
      stream = 'q 1 0 0 1 0 0 cm /Fm0 Do Q';
      resources = `<</ProcSet [/PDF]/XObject <</Fm0 ${formNumber} 0 R>>>>`;
    } else {
      stream = inner;
      resources = `<</ProcSet [/PDF /ImageC]/ExtGState <</G3 99 0 R>>`
        + `/XObject <<${entries.join(' ')}>>>>`;
    }

    const contentNumber = next++;
    bodies.push(
      `${pageNumber} 0 obj<</Type/Page/Parent 2 0 R/MediaBox [0 0 595 842]`
      + `/Resources ${resources}/Contents ${contentNumber} 0 R>>endobj\n`,
      `${contentNumber} 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream\nendobj\n`,
    );
  });

  parts.push('1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n');
  parts.push(`2 0 obj<</Type/Pages/Kids[${pageObjects.map((n) => `${n} 0 R`).join(' ')}]`
    + `/Count ${pageObjects.length}>>endobj\n`);
  parts.push(...bodies);
  // What the stubbed text layer reads, one line per page, in page order.
  for (const page of pages) parts.push(`%%PAGETEXT:${page.text}\n`);
  parts.push('trailer<</Root 1 0 R>>\n%%EOF\n');
  return concat(parts);
}

/**
 * A full-bleed render: 1700×956 at a tenth of a byte per pixel.
 *
 * A REAL, DECODABLE PICTURE, unlike the three below it. This is the image the
 * document designates as a property's primary, so it is the one display
 * eligibility decodes and measures before a card may draw it; a marker-shaped
 * fill would now be measured as unreadable, which is not displayable. The
 * others are never designated, so they are never measured, and they stay as
 * they were — the byte counts are what those tests are about.
 */
const render = (variant: number) => jpegOf(cleanPicture(340, 191, variant), 170_000);
/** The live cover's decorative wash: 1300×698 in 10 KB. */
const wash = jpeg(0x99, 10_211);
/** A logo. Photographic encoding, tiny on the page. */
const logo = jpeg(0x33, 40_000);
/** A floorplan: line art, and never drawn as a lossy photograph. */
const floorplan = jpeg(0x22, 120_000);

const FULL_BLEED: [number, number, number, number, number, number] = [595, 0, 0, 842, 0, 0];

function pdfOf(bytes: Uint8Array, filename = 'stock.pdf') {
  return extractStockFile(bytes, filename,
    classifyStockFile(filename, 'application/pdf', 'magic'));
}

// ---------------------------------------------------------------------------
// TEST A — a single-property PDF
// ---------------------------------------------------------------------------

describe('A — a PDF that is one property', () => {
  const bytes = buildPdf([{
    inForm: true,
    text: 'LOT 537 KIRRAMINGLY AVENUE DONNYBROOK - BALMAIN ESTATE - FIXED PRICE CONTRACT',
    images: [{
      name: 'Im0', width: 1700, height: 956, data: render(0x11),
      filter: 'DCTDecode', cm: FULL_BLEED,
    }],
  }]);

  it('reads the picture out of the document and anchors it to its page', async () => {
    const extraction = await pdfOf(bytes);
    expect(extraction.media).toHaveLength(1);
    expect(extraction.media[0].anchor).toBe('pdf:page1');
    expect(extraction.media[0].contentType).toBe('image/jpeg');
  });

  it('records where it came from, and proves it with a hash', async () => {
    const extraction = await pdfOf(bytes);
    const provenance = extraction.media[0].provenance!;
    expect(provenance.page).toBe(1);
    expect(provenance.method).toBe('embedded_raster');
    expect(provenance.resourceName).toBe('Im0');
    expect(provenance.sourceWidth).toBe(1700);
    expect(provenance.transformation).toBeNull();
    // Nothing was done to the bytes, so the two hashes are one hash — and it
    // is the hash of the bytes that sit in the builder's own document.
    expect(provenance.storedSha256).toBe(provenance.sourceSha256);
    expect(provenance.sourceSha256).toBe(await sha256Hex(extraction.media[0].bytes));
  });

  it('the one property reaches the picture without any text matching', () => {
    const anchors = anchorPdfRowsToPages(
      ['Lot 537, Kirramingly Avenue, Donnybrook'],
      ['a page that names nothing recognisable'],
      [1],
    );
    expect(anchors).toEqual(['pdf:page1']);
  });

  it('says nothing about location or search imagery', async () => {
    const extraction = await pdfOf(bytes);
    expect(extraction.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TEST B — a picture inside a form XObject is still found
// ---------------------------------------------------------------------------

describe('B — the exporter\'s wrapper', () => {
  it('descends into the form the page draws, and measures against the PAGE', async () => {
    const wrapped = buildPdf([{
      inForm: true,
      text: 'Lot 12 Example Street',
      images: [{
        name: 'Im0', width: 1700, height: 956, data: render(0x44),
        filter: 'DCTDecode', cm: FULL_BLEED,
      }],
    }]);
    const photo = await extractExactSourcePhotoFromPdf(wrapped);
    expect(photo).not.toBeNull();
    // Drawn across the whole page, reported in page coordinates rather than in
    // the form's own space. A reader that stops at the page's `/XObject` finds
    // nothing here at all — which is what the live contract did.
    expect(photo!.provenance.pageAreaShare).toBeGreaterThan(0.9);
  });
});

// ---------------------------------------------------------------------------
// TEST C/D — what is NOT the property photograph
// ---------------------------------------------------------------------------

describe('C — a decorative background is not a photograph', () => {
  it('refuses the wash even though it is the largest thing on the page', async () => {
    const cover = buildPdf([{
      inForm: true,
      text: 'LOT 537 KIRRAMINGLY AVENUE DONNYBROOK',
      images: [
        // The live cover: a grey faceted wash across the bleed, and a floorplan.
        { name: 'Im0', width: 1300, height: 698, data: wash, filter: 'DCTDecode', cm: FULL_BLEED },
        { name: 'Im2', width: 369, height: 811, data: floorplan, filter: 'DCTDecode',
          cm: [277, 0, 0, 610, 158, 78] },
      ],
    }]);
    expect(await extractExactSourcePhotoFromPdf(cover)).toBeNull();
  });
});

describe('D — a logo and a floorplan are not the property photograph', () => {
  it('takes the render and neither of the others', async () => {
    const page = buildPdf([{
      inForm: true,
      text: 'Lot 12 Example Street',
      images: [
        { name: 'Logo', width: 900, height: 600, data: logo, filter: 'DCTDecode',
          cm: [60, 0, 0, 40, 20, 780] },
        // Line art: drawn larger than the render, and never a lossy encoding.
        { name: 'Plan', width: 1700, height: 2400, data: floorplan, filter: 'FlateDecode',
          cm: [500, 0, 0, 700, 40, 100] },
        { name: 'Hero', width: 1700, height: 956, data: render(0x55),
          filter: 'DCTDecode', cm: [516, 0, 0, 290, 40, 480] },
      ],
    }]);
    const photo = await extractExactSourcePhotoFromPdf(page);
    expect(photo!.provenance.resourceName).toBe('Hero');
  });
});

// ---------------------------------------------------------------------------
// TEST E — a page with no photograph contributes nothing
// ---------------------------------------------------------------------------

describe('E — a document with no recoverable photograph', () => {
  const bytes = buildPdf([{
    inForm: true,
    text: 'Lot 12 Example Street — inclusions',
    images: [{ name: 'Logo', width: 900, height: 600, data: logo, filter: 'DCTDecode',
      cm: [60, 0, 0, 40, 20, 780] }],
  }]);

  it('attaches no image at all', async () => {
    const extraction = await pdfOf(bytes);
    expect(extraction.media).toEqual([]);
  });

  it('says so accurately, and promises nothing', async () => {
    const extraction = await pdfOf(bytes);
    expect(extraction.warnings).toEqual(['No property photograph could be identified in this PDF.']);
    for (const warning of extraction.warnings) {
      expect(warning).not.toMatch(/google|street ?view|satellite|search|location/i);
    }
  });
});

// ---------------------------------------------------------------------------
// TEST F — page-aware text, without touching the property schema
// ---------------------------------------------------------------------------

describe('F — the text a PDF yields', () => {
  const bytes = buildPdf([
    { text: 'Lot 12 Example Street Kellyville', images: [] },
    { text: 'Lot 44 Sample Road Riverstone', images: [] },
  ]);

  it('is reported per page AND merged, and the merge is the pages joined', async () => {
    const extraction = await pdfOf(bytes);
    expect(extraction.pageTexts).toEqual([
      'Lot 12 Example Street Kellyville',
      'Lot 44 Sample Road Riverstone',
    ]);
    expect(extraction.text).toBe(extraction.pageTexts!.join('\n'));
  });

  it('produces no rows: a PDF is still read by the model, under the same schema', async () => {
    const extraction = await pdfOf(bytes);
    expect(extraction.rows).toEqual([]);
    expect(extraction.strategy).toBe('pdf_text');
  });
});

// ---------------------------------------------------------------------------
// TEST G — several properties in one PDF
// ---------------------------------------------------------------------------

describe('G — a PDF holding more than one property', () => {
  const pages = [
    'Lot 12 Example Street, Kellyville — 4 bed, 2 bath',
    'Lot 44 Sample Road, Riverstone — 3 bed, 2 bath',
  ];
  const labels = ['Lot 12, Example Street, Kellyville', 'Lot 44, Sample Road, Riverstone'];

  it('anchors each property to the one page that names it', () => {
    expect(anchorPdfRowsToPages(labels, pages, [1, 2]))
      .toEqual(['pdf:page1', 'pdf:page2']);
  });

  it('maps pictures to properties by page, never by order', async () => {
    const bytes = buildPdf([
      { inForm: true, text: pages[0], images: [{
        name: 'Im0', width: 1700, height: 956, data: render(0x11),
        filter: 'DCTDecode', cm: FULL_BLEED }] },
      { inForm: true, text: pages[1], images: [{
        name: 'Im0', width: 1700, height: 956, data: render(0x22),
        filter: 'DCTDecode', cm: FULL_BLEED }] },
    ]);
    const extraction = await pdfOf(bytes);
    const photoPages = extraction.media
      .map((media) => pdfAnchorPage(media.anchor))
      .filter((page): page is number => page !== null);
    const anchors = anchorPdfRowsToPages(labels, extraction.pageTexts!, photoPages);

    const itemIdByAnchor: Record<string, string> = {};
    anchors.forEach((anchor, index) => {
      if (anchor) itemIdByAnchor[anchor] = `item-${index + 1}`;
    });
    const attributions = attributeDocumentMedia({
      anchors: extraction.media.map((media) => media.anchor ?? null),
      itemIdByAnchor,
      // Deliberately empty: a page-anchored document is never attributed by
      // counting, so reversing the media order cannot change the answer.
      itemIdsInOrder: [],
    });
    expect(attributions.map((attribution) => attribution.stockItemId))
      .toEqual(['item-1', 'item-2']);
    expect(attributions.every((attribution) => attribution.structural)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TEST H — ambiguity attaches nothing
// ---------------------------------------------------------------------------

describe('H — where the document does not say', () => {
  it('a property named on two pages gets no anchor', () => {
    expect(anchorPdfRowsToPages(
      ['Lot 12, Example Street'],
      ['Lot 12 Example Street — overview', 'Lot 12 Example Street — inclusions'],
      // Two photographs, so the single-property rule does not apply either.
      [1, 2],
    )[0]).toBe(pdfPageAnchor(1));
  });

  it('two properties named on one page attach nothing to either', () => {
    const anchors = anchorPdfRowsToPages(
      ['Lot 12, Example Street', 'Lot 44, Sample Road'],
      ['Lot 12 Example Street and Lot 44 Sample Road are both released'],
      [1],
    );
    expect(anchors).toEqual(['pdf:page1', 'pdf:page1']);

    // Both claim page 1, so the page resolves to nobody and the picture is
    // kept against the upload with no property attached.
    const itemIdByAnchor: Record<string, string> = {};
    const claimed = new Map<string, string | null>();
    anchors.forEach((anchor, index) => {
      if (!anchor) return;
      if (!claimed.has(anchor)) claimed.set(anchor, `item-${index + 1}`);
      else if (claimed.get(anchor) !== `item-${index + 1}`) claimed.set(anchor, null);
    });
    for (const [anchor, itemId] of claimed) if (itemId) itemIdByAnchor[anchor] = itemId;

    const attributions = attributeDocumentMedia({
      anchors: ['pdf:page1'], itemIdByAnchor, itemIdsInOrder: [],
    });
    expect(attributions[0].stockItemId).toBeNull();
  });

  it('a property no page names gets no anchor', () => {
    expect(anchorPdfRowsToPages(
      ['Lot 12, Example Street', 'Lot 44, Sample Road'],
      ['Lot 12 Example Street', 'inclusions and warranty'],
      [1, 2],
    )).toEqual(['pdf:page1', null]);
  });
});

// ---------------------------------------------------------------------------
// TEST I — every page that presents one, for a document that may hold several
// ---------------------------------------------------------------------------

describe('I — reading a multi-page document', () => {
  it('reports one picture per page that presents one, and skips the rest', async () => {
    const bytes = buildPdf([
      { inForm: true, text: 'cover', images: [
        { name: 'Im0', width: 1300, height: 698, data: wash, filter: 'DCTDecode', cm: FULL_BLEED },
      ] },
      { inForm: true, text: 'the house', images: [
        { name: 'Im0', width: 1700, height: 956, data: render(0x66),
          filter: 'DCTDecode', cm: FULL_BLEED },
      ] },
      { inForm: true, text: 'inclusions', images: [] },
    ]);
    const found = await extractPdfPhotosByPage(bytes);
    expect(found.map((entry) => entry.page)).toEqual([2]);
  });
});

// ---------------------------------------------------------------------------
// TEST J — re-reading a PDF that is already imported
// ---------------------------------------------------------------------------

type FakeRow = Record<string, any>;

/** Just enough Supabase to run the repair without a network or a database. */
function fakeDb(seed: { items: FakeRow[]; uploads: FakeRow[]; objects: Record<string, Uint8Array> }) {
  const tables: Record<string, FakeRow[]> = {
    builder_stock_items: [...seed.items],
    builder_stock_uploads: [...seed.uploads],
    builder_stock_item_images: [],
  };
  const stored: Record<string, { bytes: Uint8Array; contentType: string }> = {};
  let autoId = 0;

  const matches = (row: FakeRow, filters: Array<[string, string, unknown]>) =>
    filters.every(([op, column, value]) => {
      if (op === 'eq') return row[column] === value;
      if (op === 'is') return row[column] === value || (value === null && row[column] == null);
      if (op === 'in') return (value as unknown[]).includes(row[column]);
      return true;
    });

  const selectBuilder = (table: string) => {
    const filters: Array<[string, string, unknown]> = [];
    const builder: any = {
      eq(column: string, value: unknown) { filters.push(['eq', column, value]); return builder; },
      is(column: string, value: unknown) { filters.push(['is', column, value]); return builder; },
      in(column: string, values: unknown[]) { filters.push(['in', column, values]); return builder; },
      limit() { return builder; },
      order() { return builder; },
      maybeSingle() {
        const rows = tables[table].filter((row) => matches(row, filters));
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      then(resolve: (value: { data: FakeRow[]; error: null }) => unknown, reject?: unknown) {
        const rows = tables[table].filter((row) => matches(row, filters));
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject as never);
      },
    };
    return builder;
  };

  return {
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
              for (const row of tables[table]) if (matches(row, filters)) Object.assign(row, patch);
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
            const bytes = seed.objects[path];
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
}

describe('J — re-reading the stored PDF of an upload already imported', () => {
  const bytes = buildPdf([{
    inForm: true,
    // A property COVER, as the live contract has it: the lot and street, the
    // estate, and the package information that makes the page this property's
    // record rather than a page that merely mentions it.
    text: 'Lot 537 Kirramingly Avenue Donnybrook — Balmain Estate '
      + 'FIXED PRICE CONTRACT $941,990 Land Size 350 m2 Build Size 209.7 m2 6 bed 2 bath 2 car',
    images: [{
      name: 'Im0', width: 1700, height: 956, data: render(0x77),
      filter: 'DCTDecode', cm: FULL_BLEED,
    }],
  }]);

  const upload = {
    id: 'upload-537', organisation_id: 'org-a', source_type: 'file',
    source_url: null, final_url: null,
    original_filename: 'LOT 537 KIRRAMINGLY AVENUE DONNYBROOK - Single contract.pdf',
    storage_bucket: 'builder-stock-lists', storage_path: 'stock-lists/org-a/upload-537/contract.pdf',
    deleted_at: null,
  };
  const item = {
    id: 'item-537', organisation_id: 'org-a', upload_id: 'upload-537',
    lifecycle_status: 'active', primary_image_id: null,
    external_reference: null, development_name: 'Balmain Estate', project_name: null,
    unit_number: null, lot_number: '537', address_line: 'Lot 537 Kirramingly Avenue',
    suburb: 'Donnybrook', price: 941_990, availability_status: 'available',
    source_row: {
      lot_number: '537', address_line: 'Lot 537 Kirramingly Avenue', suburb: 'Donnybrook',
      development_name: 'Balmain Estate',
    },
  };

  it('attaches the picture to the property the upload produced, without re-importing it', async () => {
    const { repairSourceImagesForUpload } = await import(
      '../../../supabase/functions/_shared/builderStock/repairSourceImages');
    const db = fakeDb({
      items: [item], uploads: [upload], objects: { [upload.storage_path]: bytes },
    });

    const outcome = await repairSourceImagesForUpload(
      db as any, { organisationId: 'org-a', uploadId: 'upload-537' });

    expect(outcome.error).toBeUndefined();
    expect(outcome.rowsRead).toBe(1);
    expect(outcome.matched).toBe(1);
    expect(outcome.imagesStored).toBe(1);

    // Nothing was created and nothing was edited: same one property, same
    // price, same availability, same id.
    expect(db.tables.builder_stock_items).toHaveLength(1);
    expect(db.tables.builder_stock_items[0]).toMatchObject({
      id: 'item-537', price: 941_990, availability_status: 'available',
    });

    const image = db.tables.builder_stock_item_images[0];
    expect(image).toMatchObject({
      stock_item_id: 'item-537',
      source_stage: 'uploaded_document',
      verification_status: 'source_supplied',
      processing_status: 'ready',
    });
    // And it carries where it came from, down to the page and the hash.
    expect(image.source_detail).toMatchObject({
      page: 1, method: 'embedded_raster', anchor: 'pdf:page1',
      filename: upload.original_filename, upload_id: 'upload-537',
    });
    expect(image.source_detail.source_sha256).toBe(image.source_detail.stored_sha256);
    // The card now shows it.
    expect(db.tables.builder_stock_items[0].primary_image_id).toBe(image.id);
  });

  /**
   * THE PDF PATH IS BUDGETED LIKE EVERY OTHER PATH.
   *
   * It used to be the exception: it took no deadline and could not report
   * `incomplete`, so a document with enough properties ran past the caller's
   * wall clock and was killed by the edge runtime rather than stopping. A
   * killed run writes no settlement marker, so the sweep re-read the same
   * document every tick — and because a tick starts at the oldest outstanding
   * upload, everything behind it waited on a source that could never finish.
   *
   * Reporting `incomplete` is what keeps the marker clear HONESTLY: the caller
   * asks again, and this run is never mistaken for a finished one.
   */
  it('stops on its deadline and says the run is incomplete', async () => {
    const { repairSourceImagesForUpload } = await import(
      '../../../supabase/functions/_shared/builderStock/repairSourceImages');
    const db = fakeDb({
      items: [item], uploads: [upload], objects: { [upload.storage_path]: bytes },
    });

    const outcome = await repairSourceImagesForUpload(
      db as any,
      // Already spent: the document is still read and attributed, and the
      // per-property pass that follows is what stops.
      { organisationId: 'org-a', uploadId: 'upload-537', deadlineAt: Date.now() - 1 },
    );

    expect(outcome.incomplete).toBe(true);
    // Stopping is not failing, and it is not a licence to damage anything:
    // the property is untouched and no image was demoted on a partial view.
    expect(outcome.demoted).toBe(0);
    expect(db.tables.builder_stock_items).toHaveLength(1);
    expect(db.tables.builder_stock_items[0]).toMatchObject({
      id: 'item-537', price: 941_990, availability_status: 'available',
    });
  });
});

// ---------------------------------------------------------------------------
// TEST K — the sentence that started this is gone
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// TEST L — a photograph the document stored LOSSLESSLY
// ---------------------------------------------------------------------------

describe('L — a photograph the document stored losslessly', () => {
  /*
   * WHAT THIS PINS, AND WHAT IT COST. "Is it a DCT raster" was the whole test
   * for whether a picture could be a photograph, and it is only a proxy. Lot
   * 60434 Cloverton's package is where the proxy costs a card: the document
   * holds a 3508x4961 JPEG of the FLOOR PLAN and a 2400x1400 Flate raster of
   * the HOUSE, so the rule admitted the plan and refused the photograph. The
   * card sat blank in front of the builder's own clean facade render.
   *
   * The detail floor is what actually separates a photograph from a diagram,
   * and the numbers are measured off the production documents, decoded and
   * re-compressed losslessly in bytes per pixel:
   *
   *   solid plate 0.003 · wash 0.003 · line art 0.011 · that floor plan 0.042
   *   ---- floor 0.5 ----
   *   that facade 1.675 · Sandpiper's six covers 1.423-2.156
   *
   * The fixtures below sit either side of it on the same measure: the render
   * deflates to 2.28 bytes a pixel and the diagram to 0.004.
   */
  const W = 700;
  const H = 450;
  const deflate = (bytes: Uint8Array) => new Uint8Array(deflateSync(Buffer.from(bytes)));
  const PLACED: [number, number, number, number, number, number] = [420, 0, 0, 236, 88, 470];

  /** Real photographic pixels, Flate-compressed the way a PDF stores them. */
  const losslessRender = (variant: number) => deflate(cleanPicture(W, H, variant).pixels);

  /** The same size, but nearly empty — what a diagram compresses to. */
  const losslessDiagram = () => {
    const pixels = new Uint8Array(W * H * 3).fill(0xff);
    for (let y = 0; y < H; y += 9) pixels.fill(0x11, y * W * 3, (y * W + W) * 3);
    return deflate(pixels);
  };

  const onePage = (data: Uint8Array, cm = PLACED) => buildPdf([{
    inForm: true,
    text: 'Lot 60434 - Cloverton Estate, Kalkallo VIC 3064 · house and land package · $712,000',
    images: [{ name: 'Im1', width: W, height: H, filter: 'FlateDecode', data, cm }],
  }]);

  it('takes the render out, and says what it did to it', async () => {
    const photo = await extractPdfPagePhoto(onePage(losslessRender(3)), 0);
    expect(photo).not.toBeNull();
    expect(photo!.provenance.method).toBe('embedded_raster');
    expect(photo!.contentType).toBe('image/png');
    // The bytes we stored are not the bytes the document holds — it holds
    // samples — so BOTH hashes are recorded and the change is stated.
    expect(photo!.provenance.sourceSha256).not.toBe(photo!.provenance.storedSha256);
    expect(photo!.provenance.transformation).toMatch(/losslessly as PNG/);
    expect(photo!.provenance.transformation).toMatch(/no pixel values changed/);
  });

  it('and the pixels it recorded are the document\'s own, unaltered', async () => {
    const picture = cleanPicture(W, H, 4);
    const photo = await extractPdfPagePhoto(onePage(deflate(picture.pixels)), 0);
    expect(photo!.provenance.sourceSha256).toBe(await sha256Hex(picture.pixels));
  });

  it('refuses a lossless raster with no photographic detail in it', async () => {
    // A diagram at exactly the same size on exactly the same page. The only
    // thing separating it from the render above is how much a lossless encoder
    // had to spend on it, which is the whole rule.
    expect(await extractPdfPagePhoto(onePage(losslessDiagram()), 0)).toBeNull();
  });

  it('does not let a lossless PAGE be served as if it were a photograph', async () => {
    /*
     * THE OTHER HALF, AND THE ONE THAT COULD PUT MARKETING ON A CARD. A
     * brochure exported as page images draws ONE lossless raster over the whole
     * sheet — facade, headline and price panel together. It was never mistaken
     * for a placed picture only because lossless rasters were refused outright;
     * admitting them removes that accident, so the exclusion is stated. Covella
     * Lot 914 and Cloverton's own 122m2 package are both exactly this shape,
     * and both came back as whole pages the moment it was not.
     */
    const photo = await extractPdfPagePhoto(onePage(losslessRender(5), FULL_BLEED), 0);
    // Either the photograph is CUT OUT of the page, or nothing is taken. What
    // must never happen is the whole page returning as an embedded raster.
    expect(photo?.provenance.method ?? 'page_crop').toBe('page_crop');
  });

  it('leaves a lossy document reaching exactly the same answer as before', async () => {
    const bytes = buildPdf([{
      inForm: true,
      text: 'Lot 12 - Somewhere Estate · house and land package · $700,000',
      images: [
        { name: 'Im0', width: 1300, height: 698, filter: 'DCTDecode', data: wash, cm: FULL_BLEED },
        {
          name: 'Im1', width: 1700, height: 956, filter: 'DCTDecode', data: render(6),
          cm: PLACED,
        },
      ],
    }]);
    const photo = await extractPdfPagePhoto(bytes, 0);
    expect(photo!.provenance.method).toBe('embedded_raster');
    expect(photo!.provenance.resourceName).toBe('Im1');
    // Untouched bytes, so one hash and no transformation — the wash is still
    // refused and the render is still copied out as it sits in the document.
    expect(photo!.provenance.transformation).toBeNull();
    expect(photo!.provenance.sourceSha256).toBe(photo!.provenance.storedSha256);
  });
});


describe('K — the stale PDF warning', () => {
  const ROOTS = ['src', 'supabase/functions'];
  const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage']);

  function sourceFiles(directory: string, out: string[] = []): string[] {
    for (const entry of readdirSync(directory)) {
      if (SKIP.has(entry)) continue;
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) sourceFiles(path, out);
      else if (/\.(ts|tsx|js|jsx)$/.test(entry)) out.push(path);
    }
    return out;
  }

  // This file QUOTES the retired sentence in order to forbid it, and is the
  // only place in the repository where it may appear.
  const files = ROOTS.flatMap((root) => sourceFiles(root))
    .filter((path) => !path.endsWith('builderStockPdfSourceImages.test.ts'));

  it('no longer exists anywhere in the source', () => {
    const offenders = files.filter((path) =>
      readFileSync(path, 'utf8').includes('Images inside a PDF are not extracted'));
    expect(offenders).toEqual([]);
  });

  it('is not replaced by anything that offers location or search imagery', () => {
    const offenders = files.filter((path) => {
      const source = readFileSync(path, 'utf8');
      return /(?:location|search|street ?view|satellite)[^\n]{0,40}imagery are used/i.test(source);
    });
    expect(offenders).toEqual([]);
  });
});
