/**
 * Builder stock — the exact builder-supplied image, or no image at all.
 *
 * THE RULE THIS FILE PINS. A Builder Stock card may show the photograph the
 * builder supplied. It may not show a Street View of the street, a satellite
 * still of the lot, or a search result that might be the development — none of
 * those is a photograph of the property, and a card that shows one tells a
 * client something untrue about a house they are being asked to buy. When the
 * builder supplied nothing, the card shows nothing.
 *
 * The earlier rule was a priority list — source-supplied, then Google, then a
 * search — so every property whose builder gave us nothing still showed a
 * picture, badged "Location imagery", which reads as a photograph of the
 * property to everyone who is not reading the badge.
 *
 * The brochure fixtures are the shape of the live packages: a facade render
 * drawn large on page one, a floorplan, a logo, and the ESTATE MASTERPLAN on a
 * later page.
 */
import { describe, expect, it } from 'vitest';

import { CLEAN_VERDICT } from './fixtures/builderStockPictures';

import {
  chooseDisplayableImage, isDisplayableSourceImage,
} from '../../../supabase/functions/_shared/builderStock/primaryImage';
import { primaryStockImage } from '../../lib/builderStock';
import {
  flattenedPageImage, parseImagePlacements, readFirstPage, selectPropertyPhotograph,
} from '../../../supabase/functions/_shared/builderStock/pdfPageImages.pure';
import {
  isolatePhotographBand,
} from '../../../supabase/functions/_shared/builderStock/pdfFlattenedPhoto.pure';
import {
  cropRows, encodePng, sha256Hex,
} from '../../../supabase/functions/_shared/builderStock/rasterPng';
import { recoverPackageImage } from '../../../supabase/functions/_shared/builderStock/packageImages';
import type { BuilderStockImage, BuilderStockItem } from '../../lib/builderStock';
import {
  roleDetail, roleFromStructuralContainer,
} from '../../../supabase/functions/_shared/builderStock/sourceImageRole.pure';

/**
 * The package's own COVER PAGE, as a person reads it.
 *
 * A picture is this property's image because the document presented it on the
 * page stating this property's identity and its package information — not
 * because it is the biggest raster in the file. These fixtures are built as
 * bare page trees with no text layer, so the cover text is supplied the way
 * production reads it, through the injected reader.
 */
const coverTextFor = (label: string) => async () => [
  `${label}\nFIXED PRICE CONTRACT\n$1,307,585\nLand Size 350 m2\n4 bed 2 bath 2 car`,
];


// ---------------------------------------------------------------------------
// Fixtures
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
 * A JPEG with real markers, distinguishable by its fill byte.
 *
 * Sized the way a real render of these dimensions is. A lossy encoding carries
 * roughly a tenth of a byte per pixel, and one that carries far less is a flat
 * decorative wash rather than a photograph — a distinction
 * `selectPropertyPhotograph` now makes, and a 4 KB "1700×956 render" would not
 * survive it.
 */
function jpeg(fill: number, size = 160_000): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  bytes.fill(fill, 4, size - 2);
  bytes.set([0xff, 0xd9], size - 2);
  return bytes;
}

interface FixtureImage {
  name: string;
  width: number;
  height: number;
  data: Uint8Array;
  filter: 'DCTDecode' | 'FlateDecode';
  /** The `cm` the page draws it with: [width, 0, 0, height, x, y] in points. */
  cm: [number, number, number, number, number, number];
}

/**
 * A PDF whose pages draw the given images.
 *
 * `/Resources` deliberately nests `/ExtGState` BEFORE `/XObject`: a lazy
 * `<<…?>>` stops at the first `>>` and never sees the images, which is exactly
 * how a brochure full of pictures reads as empty.
 */
function buildPdf(pages: FixtureImage[][]): Uint8Array {
  const parts: Array<Uint8Array | string> = ['%PDF-1.4\n'];
  let next = 3 + pages.length;
  const pageObjects: number[] = [];
  const bodies: Array<Uint8Array | string> = [];

  pages.forEach((images, index) => {
    const pageNumber = 3 + index;
    pageObjects.push(pageNumber);
    const entries: string[] = [];
    const content: string[] = [];

    for (const image of images) {
      const objectNumber = next++;
      entries.push(`/${image.name} ${objectNumber} 0 R`);
      content.push(`q ${image.cm.join(' ')} cm /${image.name} Do Q`);
      bodies.push(
        `${objectNumber} 0 obj<</Type/XObject/Subtype/Image/Width ${image.width}`
        + `/Height ${image.height}/ColorSpace/DeviceRGB/BitsPerComponent 8`
        + `/Filter/${image.filter}/Length ${image.data.length}>>stream\n`,
        image.data,
        '\nendstream\nendobj\n',
      );
    }

    const stream = content.join('\n');
    const contentNumber = next++;
    bodies.push(
      `${pageNumber} 0 obj<</Type/Page/Parent 2 0 R/MediaBox [0 0 595 842]`
      + `/Resources <</ProcSet [/PDF /ImageC]/ExtGState <</G3 99 0 R>>`
      + `/XObject <<${entries.join(' ')}>>>>/Contents ${contentNumber} 0 R>>endobj\n`,
      `${contentNumber} 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream\nendobj\n`,
    );
  });

  parts.push('1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n');
  parts.push(`2 0 obj<</Type/Pages/Kids[${pageObjects.map((n) => `${n} 0 R`).join(' ')}]`
    + `/Count ${pageObjects.length}>>endobj\n`);
  parts.push(...bodies);
  parts.push('trailer<</Root 1 0 R>>\n%%EOF\n');
  return concat(parts);
}

/** The whole page as one raster, the way an exported brochure page arrives. */
function flattenedPdf(pixels: Uint8Array, width: number, height: number): Uint8Array {
  return buildPdf([[{
    name: 'Im1', width, height, data: pixels, filter: 'FlateDecode',
    cm: [595, 0, 0, 842, 0, 0],
  }]]);
}

/** A page of flat background with a colourful band across it. */
function pageWithBand(options: {
  width: number; height: number; bandTop: number; bandBottom: number;
  /** A second colourful band, for the "cannot be isolated" case. */
  secondBand?: { top: number; bottom: number };
}): Uint8Array {
  const { width, height, bandTop, bandBottom } = options;
  const pixels = new Uint8Array(width * height * 3);
  pixels.fill(0xf5);                                   // flat page

  const paint = (top: number, bottom: number, seed: number) => {
    for (let y = top; y < bottom; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 3;
        // Deterministic and colourful: hundreds of quantised colours.
        pixels[offset] = (x * 7 + y * 13 + seed) & 0xff;
        pixels[offset + 1] = (x * 3 + y * 29 + seed) & 0xff;
        pixels[offset + 2] = (x * 11 + y * 5 + seed) & 0xff;
      }
    }
  };
  paint(bandTop, bandBottom, 0);
  if (options.secondBand) paint(options.secondBand.top, options.secondBand.bottom, 91);
  return pixels;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const transform = new CompressionStream('deflate');
  const writer = transform.writable.getWriter();
  const closed = writer.write(bytes as unknown as BufferSource).then(() => writer.close());
  const chunks: Uint8Array[] = [];
  const reader = transform.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  await closed;
  return concat(chunks);
}

async function readPage(bytes: Uint8Array) {
  const page = readFirstPage(bytes)!;
  let content = '';
  for (const slice of page.contents) {
    content += new TextDecoder('latin1').decode(bytes.slice(slice.start, slice.end));
  }
  return { page, placements: parseImagePlacements(content) };
}

const image = (over: Partial<BuilderStockImage>): BuilderStockImage => ({
  id: 'image-1',
  stock_item_id: 'item-1',
  source_stage: 'uploaded_document',
  source_reference: null,
  source_provider: null,
  source_page_url: null,
  external_url: null,
  storage_path: 'org/items/item-1/source/render.jpg',
  content_type: 'image/jpeg',
  verification_status: 'source_supplied',
  confidence: 1,
  processing_status: 'ready',
  error_message: null,
  position: 0,
  // What the SOURCE presented it as, and what the marketplace made of the
  // picture itself. Both are needed: designation is not permission to display,
  // and an image with no verdict has not been judged, which is not the same
  // fact as having been judged clean.
  source_detail: {
    ...roleDetail(roleFromStructuralContainer({
      container: 'the Notion row for this property',
      designation: 'page cover',
    })),
    ...CLEAN_VERDICT,
  },
  created_at: '2026-08-15T00:00:00Z',
  ...over,
});

const googleImage = image({
  id: 'google-1', source_stage: 'google_maps',
  verification_status: 'location_derived',
  storage_path: 'org/items/item-1/google-streetview.jpg',
});

const searchImage = image({
  id: 'search-1', source_stage: 'internet_search',
  verification_status: 'unverified',
  storage_path: null, external_url: 'https://example.com/found.jpg',
});

const item = (images: BuilderStockImage[], primary: string | null = null) =>
  ({ id: 'item-1', primary_image_id: primary, images } as unknown as BuilderStockItem);

// ---------------------------------------------------------------------------
// TEST A–D, M — what the card may show
// ---------------------------------------------------------------------------

describe('what a Builder Stock card may show', () => {
  it('A — shows the builder\'s image when a Google image is also present', () => {
    const source = image({ id: 'source-1' });
    expect(chooseDisplayableImage([googleImage, source])?.id).toBe('source-1');
    expect(primaryStockImage(item([googleImage, source]))?.id).toBe('source-1');
  });

  it('B — shows the builder\'s image when an internet result is also present', () => {
    const source = image({ id: 'source-1' });
    expect(chooseDisplayableImage([searchImage, source])?.id).toBe('source-1');
    expect(primaryStockImage(item([searchImage, source]))?.id).toBe('source-1');
  });

  it('C — shows NO image when only a Google image exists', () => {
    expect(chooseDisplayableImage([googleImage])).toBeNull();
    expect(primaryStockImage(item([googleImage]))).toBeNull();
  });

  it('D — shows NO image when only an internet result exists', () => {
    expect(chooseDisplayableImage([searchImage])).toBeNull();
    expect(primaryStockImage(item([searchImage]))).toBeNull();
  });

  it('M — a stored primary pointing at Google is ignored, not honoured', () => {
    // The state production is in today: `primary_image_id` names a Street View.
    expect(primaryStockImage(item([googleImage, searchImage], 'google-1'))).toBeNull();
    // And with a real source image present, the stale pointer cannot win.
    const source = image({ id: 'source-1' });
    expect(primaryStockImage(item([googleImage, source], 'google-1'))?.id).toBe('source-1');
  });

  it('refuses a stage-1 row that is not ready, or has no bytes', () => {
    expect(isDisplayableSourceImage(image({ processing_status: 'failed' }))).toBe(false);
    expect(isDisplayableSourceImage(image({ processing_status: 'unavailable' }))).toBe(false);
    expect(isDisplayableSourceImage(image({ storage_path: null, external_url: null }))).toBe(false);
    // Stage and verification must agree: a mislabelled row is not displayable.
    expect(isDisplayableSourceImage(image({ verification_status: 'location_derived' }))).toBe(false);
    expect(isDisplayableSourceImage(image({ source_stage: 'google_maps' }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TEST E–H — which picture in the brochure
// ---------------------------------------------------------------------------

describe('which picture in the brochure is the property', () => {
  const render = jpeg(0x11);
  const floorplan = jpeg(0x22);
  const logo = jpeg(0x33);
  const masterplan = jpeg(0x44);

  it('E — the extracted raster is the document\'s own bytes, unchanged', async () => {
    const pdf = buildPdf([[{
      name: 'X13', width: 1700, height: 956, data: render, filter: 'DCTDecode',
      cm: [516, 0, 0, 290, 40, 480],
    }]]);
    const { page, placements } = await readPage(pdf);
    const chosen = selectPropertyPhotograph(page, placements)!;
    const extracted = pdf.slice(chosen.image.start, chosen.image.end);

    expect(extracted.length).toBe(render.length);
    expect(await sha256Hex(extracted)).toBe(await sha256Hex(render));
  });

  it('F — a floorplan is not the property photograph', async () => {
    const pdf = buildPdf([[
      // The floorplan is line art: bigger on the page, but not photographic.
      { name: 'Plan', width: 1700, height: 2400, data: floorplan, filter: 'FlateDecode',
        cm: [500, 0, 0, 700, 40, 100] },
      { name: 'Hero', width: 1700, height: 956, data: render, filter: 'DCTDecode',
        cm: [516, 0, 0, 290, 40, 480] },
    ]]);
    const { page, placements } = await readPage(pdf);
    const chosen = selectPropertyPhotograph(page, placements)!;
    expect(chosen.image.name).toBe('Hero');
  });

  it('G — an estate masterplan on a later page is never reached', async () => {
    const pdf = buildPdf([
      [{ name: 'Hero', width: 1700, height: 956, data: render, filter: 'DCTDecode',
        cm: [516, 0, 0, 290, 40, 480] }],
      [{ name: 'Masterplan', width: 2000, height: 1414, data: masterplan, filter: 'DCTDecode',
        cm: [580, 0, 0, 820, 5, 10] }],
    ]);
    const { page, placements } = await readPage(pdf);
    expect(page.images.map((entry) => entry.name)).toEqual(['Hero']);
    expect(selectPropertyPhotograph(page, placements)?.image.name).toBe('Hero');
  });

  it('H — a logo drawn small is not the property photograph', async () => {
    const pdf = buildPdf([[
      { name: 'Logo', width: 900, height: 600, data: logo, filter: 'DCTDecode',
        cm: [60, 0, 0, 40, 20, 780] },
      { name: 'Hero', width: 1700, height: 956, data: render, filter: 'DCTDecode',
        cm: [516, 0, 0, 290, 40, 480] },
    ]]);
    const { page, placements } = await readPage(pdf);
    expect(selectPropertyPhotograph(page, placements)?.image.name).toBe('Hero');
  });

  it('refuses a page that draws nothing photographic', async () => {
    const pdf = buildPdf([[
      { name: 'Logo', width: 900, height: 600, data: logo, filter: 'DCTDecode',
        cm: [60, 0, 0, 40, 20, 780] },
    ]]);
    const { page, placements } = await readPage(pdf);
    expect(selectPropertyPhotograph(page, placements)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TEST I, J — a flattened brochure page
// ---------------------------------------------------------------------------

describe('a flattened brochure page', () => {
  const WIDTH = 620;
  const HEIGHT = 880;

  it('I — cuts the photograph out of the builder\'s own pixels', async () => {
    const pixels = pageWithBand({ width: WIDTH, height: HEIGHT, bandTop: 60, bandBottom: 360 });
    const pdf = flattenedPdf(await deflate(pixels), WIDTH, HEIGHT);

    const { page, placements } = await readPage(pdf);
    expect(selectPropertyPhotograph(page, placements)).toBeNull();
    const flattened = flattenedPageImage(page, placements)!;
    expect(flattened.image.name).toBe('Im1');

    const band = isolatePhotographBand(pixels,
      { width: WIDTH, height: HEIGHT, components: 3 })!;
    expect(band.top).toBeLessThanOrEqual(60);
    expect(band.bottom).toBeGreaterThanOrEqual(356);

    const cropped = cropRows(pixels, { width: WIDTH, height: HEIGHT, components: 3 }, band);
    // EVERY pixel out is a pixel in: the crop is a slice of the source raster.
    const sourceSlice = pixels.slice(band.top * WIDTH * 3, band.bottom * WIDTH * 3);
    expect(await sha256Hex(cropped.pixels)).toBe(await sha256Hex(sourceSlice));

    const png = await encodePng(cropped.pixels,
      { width: cropped.width, height: cropped.height, components: 3 })!;
    expect(png).not.toBeNull();
    expect([...png!.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('J — attaches nothing when two pictures share the page', () => {
    const pixels = pageWithBand({
      width: WIDTH, height: HEIGHT,
      bandTop: 60, bandBottom: 360,
      secondBand: { top: 460, bottom: 760 },
    });
    // The page shows more than one picture and says nothing about which is the
    // property, so nothing is taken from it at all.
    expect(isolatePhotographBand(pixels, { width: WIDTH, height: HEIGHT, components: 3 }))
      .toBeNull();
  });

  it('J — attaches nothing when the page is type rather than a photograph', () => {
    const pixels = new Uint8Array(WIDTH * HEIGHT * 3);
    pixels.fill(0xf5);
    // A block of black type: two colours, however tall it is.
    for (let y = 100; y < 400; y += 2) {
      for (let x = 0; x < WIDTH; x++) {
        const offset = (y * WIDTH + x) * 3;
        pixels[offset] = 0x10; pixels[offset + 1] = 0x10; pixels[offset + 2] = 0x10;
      }
    }
    expect(isolatePhotographBand(pixels, { width: WIDTH, height: HEIGHT, components: 3 }))
      .toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TEST K — two lots, one design
// ---------------------------------------------------------------------------

describe('two properties that share a house design', () => {
  const render = jpeg(0x55);
  const DRIVE = 'https://drive.google.com/drive/folders/1isIaQ8qqqDUYICn6q9fyVu_z1kl5PvId';
  const FOLDER = 'application/vnd.google-apps.folder';

  function listing(entries: Array<[string, string, string]>): Uint8Array {
    const json = JSON.stringify([entries.map(([id, name, mime]) => [id, ['p'], name, mime]), null]);
    const escaped = json.replace(/[[\]"\\/]/g, (character) =>
      `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`);
    return encoder.encode(`<script>window['_DRIVE_ivd'] = '${escaped}';</script>`);
  }

  const pdf = buildPdf([[{
    name: 'X13', width: 1700, height: 956, data: render, filter: 'DCTDecode',
    cm: [516, 0, 0, 290, 40, 480],
  }]]);

  /** Lot 42's folder holds Lot 42's documents. Lot 43's holds Lot 43's. */
  const fetchPackage = async (url: string) => {
    if (url.includes('/folders/1isIaQ')) {
      return { bytes: listing([['packages', 'Tweed Heads Packages', FOLDER]]), finalUrl: url };
    }
    if (url.includes('/folders/packages')) {
      return {
        bytes: listing([['lot42', 'Lot 42', FOLDER], ['lot43', 'Lot 43', FOLDER]]),
        finalUrl: url,
      };
    }
    if (url.includes('/folders/lot42')) {
      return {
        bytes: listing([['doc42', 'Lot 42 - Stradbroke 180 - Property Package.pdf', 'application/pdf']]),
        finalUrl: url,
      };
    }
    if (url.includes('/folders/lot43')) {
      return {
        bytes: listing([['doc43', 'Lot 43 - Stradbroke 180 - Property Package.pdf', 'application/pdf']]),
        finalUrl: url,
      };
    }
    if (url.includes('id=doc42') || url.includes('id=doc43')) {
      return { bytes: pdf, finalUrl: url };
    }
    return { bytes: encoder.encode('<html>Sign in</html>'), finalUrl: url };
  };

  it('K — each proves the image from ITS OWN linked document', async () => {
    const lot42 = await recoverPackageImage(
      { packageUrl: DRIVE, label: 'Lot 42 - Tringa Street … [Stradbroke 180]' },
      { fetchPackage, readPageTexts: coverTextFor('Lot 42 - Tringa Street … [Stradbroke 180]') },
    );
    const lot43 = await recoverPackageImage(
      { packageUrl: DRIVE, label: 'Lot 43 - Tringa Street … [Stradbroke 180]' },
      { fetchPackage, readPageTexts: coverTextFor('Lot 43 - Tringa Street … [Stradbroke 180]') },
    );

    expect(lot42.status).toBe('recovered');
    expect(lot43.status).toBe('recovered');
    if (lot42.status !== 'recovered' || lot43.status !== 'recovered') return;

    // Same design, so the same bytes — but each was taken out of the document
    // its OWN row's folder names, and each says so.
    expect(lot42.image.documentName).toBe('Lot 42 - Stradbroke 180 - Property Package.pdf');
    expect(lot43.image.documentName).toBe('Lot 43 - Stradbroke 180 - Property Package.pdf');
    expect(lot42.image.provenance.storedSha256).toBe(lot43.image.provenance.storedSha256);
    expect(lot42.image.provenance.storedSha256).toBe(await sha256Hex(render));
  });

  it('K — a lot whose own folder holds no matching document gets nothing', async () => {
    const outcome = await recoverPackageImage(
      { packageUrl: DRIVE, label: 'Lot 51 - Tringa Street … [Stradbroke 180]' },
      { fetchPackage, readPageTexts: coverTextFor('Lot 51 - Tringa Street … [Stradbroke 180]') },
    );
    expect(outcome.status).toBe('not_identified');
  });

  it('records the page, the object and both hashes', async () => {
    const outcome = await recoverPackageImage(
      { packageUrl: DRIVE, label: 'Lot 43 - Tringa Street … [Stradbroke 180]' },
      { fetchPackage, readPageTexts: coverTextFor('Lot 43 - Tringa Street … [Stradbroke 180]') },
    );
    expect(outcome.status).toBe('recovered');
    if (outcome.status !== 'recovered') return;
    expect(outcome.image.provenance).toMatchObject({
      page: 1,
      method: 'embedded_raster',
      resourceName: 'X13',
      sourceWidth: 1700,
      sourceHeight: 956,
      crop: null,
      transformation: null,
    });
    expect(outcome.image.provenance.sourceSha256)
      .toBe(outcome.image.provenance.storedSha256);
    expect(outcome.image.reference).toContain('#page1:X13');
  });
});

// ---------------------------------------------------------------------------
// A recovery that hangs is answered for, not reaped
// ---------------------------------------------------------------------------

/**
 * MEASURED, 6 SEPTEMBER 2026, LOT 709 VERVE. The brochure elects in seconds
 * on the same bytes, and the production claim that started it died ~85s in
 * with no error, no kill status and no verdict — the isolate was shut down
 * mid-item and the standing attempt read as a destroyed worker. Every step
 * is individually bounded and the sum was not. The deadline turns any hang —
 * an import that never settles, a response stalled between chunks, a stream
 * that neither ends nor errors — into the `unreachable` answer the branch
 * machinery already retries and retires honestly.
 */
describe('a recovery that hangs is answered for, not reaped', () => {
  it('a fetch that never settles resolves as unreachable at the deadline', async () => {
    const outcome = await recoverPackageImage(
      { packageUrl: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view', label: 'Lot 1 Example St' },
      { fetchPackage: () => new Promise(() => {/* never settles */}), deadlineMs: 120 },
    );
    expect(outcome.status).toBe('unreachable');
    expect(outcome.status === 'unreachable' && outcome.detail).toContain('records nothing');
  });

  it('a recovery that finishes on time is untouched by the deadline', async () => {
    const outcome = await recoverPackageImage(
      { packageUrl: 'https://example.com/not-a-drive-page', label: 'Lot 1 Example St' },
      { fetchPackage: async () => { throw new Error('refused'); }, deadlineMs: 5_000 },
    );
    // The prompt outcome (whatever it is) wins the race; the timer must not
    // replace a real answer that arrived first.
    expect(outcome.status).not.toBe('recovered');
    expect(outcome.status === 'unreachable' ? outcome.detail : '').not.toContain('records nothing about the document');
  });
});
