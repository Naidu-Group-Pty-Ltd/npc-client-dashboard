/**
 * Builder stock — pictures too large to decode where the document is read.
 *
 * THE CASUALTY. The Lumina lots' brochures (17.9 MB) elect one 3556×2000
 * baseline JPEG — 7.1 megapixels, measured at 3.1 seconds to decode in the
 * pure-TypeScript decoder — and the settler worker is killed at around three
 * seconds of CPU. The election never finished, the eligibility detail was
 * never written, and the rows burned their whole attempts budget on a decode
 * that could not end. Two guards fix it and this file pins both:
 *
 *   INLINE GATE   `documentVisualKinds` and `eligibilityDetailFor` run inside
 *                 the invocation that is walking the document, so a picture
 *                 whose HEADER states more than `MAX_INLINE_DECODE_PIXELS`
 *                 is not decoded there at all. The kind stays null ("nothing
 *                 is known") and the eligibility verdict is deferred to the
 *                 sweep, which judges the same bytes in an invocation of its
 *                 own.
 *
 *   COARSE DECODE a JPEG at least 8×TARGET_EDGE on its long side is decoded
 *                 at block resolution — each 8×8 block's DC coefficient IS
 *                 its average, i.e. the very sample the box filter takes —
 *                 so the sweep's measurement of the 7.1 MP hero costs ~0.9 s
 *                 instead of 3.1 s and produces the same-resolution
 *                 thumbnail it always did.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  decodeFullRaster, decodeRasterBoth, decodeThumbnailResult, imageHeaderPixels,
} from '../../../supabase/functions/_shared/builderStock/sourceImageRaster';
import {
  documentVisualKinds, eligibilityDetailFor,
} from '../../../supabase/functions/_shared/builderStock/assessSourceImage';
import { encodePng } from '../../../supabase/functions/_shared/builderStock/rasterPng';
import { jpegOf, photograph } from './fixtures/builderStockPictures';

/** Long side ≥ 3200 (8 × TARGET_EDGE) triggers the coarse reading; the strip
 *  keeps the pixel count small so the test's own encode stays cheap. */
const strip = photograph(3200, 240);
const stripJpeg = jpegOf(strip);

/** A header that STATES more pixels than the inline gate affords, with no
 *  decodable body behind it — the gate must refuse it before any decode. */
function oversizedHeaderOnly(width = 2400, height = 1800): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,                                     // SOI
    0xff, 0xc0, 0x00, 0x11,                         // SOF0, length 17
    0x08,                                           // precision
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03,                                           // 3 components
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,                                     // EOI
  ]);
}

/** The same strip with an EXIF orientation-6 APP1 spliced in after SOI, so
 *  the decoder displays it rotated a quarter turn. */
function withOrientationSix(jpeg: Uint8Array): Uint8Array {
  const exif = new Uint8Array([
    0xff, 0xe1, 0x00, 0x20,                          // APP1, length 32
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,              // 'Exif\0\0'
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,  // TIFF, little-endian, IFD at 8
    0x01, 0x00,                                      // one entry
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00,  // tag 0x0112, SHORT, count 1
    0x06, 0x00, 0x00, 0x00,                          // value 6
    0x00, 0x00, 0x00, 0x00,                          // next IFD: none
  ]);
  const out = new Uint8Array(jpeg.length + exif.length);
  out.set(jpeg.subarray(0, 2), 0);
  out.set(exif, 2);
  out.set(jpeg.subarray(2), 2 + exif.length);
  return out;
}

const meanOf = (pixels: Uint8Array): number => {
  let sum = 0;
  for (const value of pixels) sum += value;
  return sum / pixels.length;
};

// ---------------------------------------------------------------------------
// What a header states, read without decoding
// ---------------------------------------------------------------------------

describe('imageHeaderPixels reads the container header and decodes nothing', () => {
  it('reads a baseline JPEG frame header', () => {
    expect(imageHeaderPixels(jpegOf(photograph(400, 200)))).toBe(400 * 200);
    expect(imageHeaderPixels(oversizedHeaderOnly(2400, 1800))).toBe(2400 * 1800);
  });

  it('reads a PNG IHDR', async () => {
    const picture = photograph(48, 32);
    const png = await encodePng(
      picture.pixels, { width: picture.width, height: picture.height, components: 3 });
    if (!png) throw new Error('the fixture must encode');
    expect(imageHeaderPixels(png)).toBe(48 * 32);
  });

  it('answers null for what it cannot read, so the caller decodes as before', () => {
    expect(imageHeaderPixels(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(imageHeaderPixels(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
    expect(imageHeaderPixels(new Uint8Array(0))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The inline gate
// ---------------------------------------------------------------------------

describe('the invocation that walks a document never decodes an oversized picture', () => {
  it('documentVisualKinds leaves the kind unknown', async () => {
    const kinds = await documentVisualKinds([
      { bytes: oversizedHeaderOnly(), placement: { placementsOnPage: 1, pagesDrawnOn: 1 } },
    ]);
    expect(kinds).toEqual([null]);
  });

  it('the gate stands BEFORE the decode in the source, for both callers', () => {
    // The guard-order idiom: a gate that ran after the decode would spend the
    // very cost it exists to refuse. `documentVisualKinds`'s loop and
    // `eligibilityDetailFor` must each consult the header gate before any
    // decode call.
    const source = readFileSync(join(
      process.cwd(), 'supabase/functions/_shared/builderStock/assessSourceImage.ts',
    ), 'utf8');

    const visionBody = source.slice(source.indexOf('function documentVisualKinds'));
    expect(visionBody.indexOf('oversizedForInlineDecode(')).toBeGreaterThan(-1);
    expect(visionBody.indexOf('oversizedForInlineDecode('))
      .toBeLessThan(visionBody.indexOf('await decodeThumbnailResult('));

    const detailBody = source.slice(
      source.indexOf('function eligibilityDetailFor'),
      source.indexOf('function documentVisualKinds'));
    expect(detailBody.indexOf('oversizedForInlineDecode(')).toBeGreaterThan(-1);
    expect(detailBody.indexOf('oversizedForInlineDecode('))
      .toBeLessThan(detailBody.indexOf('assessMarketplaceEligibility('));
  });

  it('eligibilityDetailFor DEFERS an oversized primary rather than judging it', async () => {
    // Nothing was measured, so nothing may be written: an empty detail is the
    // state `needsEligibilityAssessment` finds, and the sweep — which runs in
    // an invocation of its own — writes the verdict there. Were the gate
    // removed, the failed decode would write a `pending` verdict here, which
    // records a judgement nobody could re-make from these keys.
    const detail = await eligibilityDetailFor(oversizedHeaderOnly(), 'primary_property');
    expect(detail).toEqual({});
  });

  it('a primary the inline budget affords is still judged exactly as before', async () => {
    const detail = await eligibilityDetailFor(jpegOf(photograph(400, 200)), 'primary_property');
    expect(Object.keys(detail)).toContain('marketplace_eligibility_state');
  });
});

// ---------------------------------------------------------------------------
// The coarse decode
// ---------------------------------------------------------------------------

describe('a JPEG past 8×TARGET_EDGE is read at block resolution, losing nothing it reports', () => {
  it('produces the same-resolution thumbnail stating the TRUE source size', async () => {
    const result = await decodeThumbnailResult(stripJpeg);
    if (!result.ok) throw new Error('the strip must decode');
    expect(result.thumbnail.sourceWidth).toBe(3200);
    expect(result.thumbnail.sourceHeight).toBe(240);
    expect(result.thumbnail.width).toBe(400);
    expect(result.thumbnail.height).toBe(30);
  });

  it('its pixels are the block averages the full decode reduces to', async () => {
    // DC-only reconstruction IS the 8×8 box filter, so the coarse thumbnail
    // and the full raster must agree in brightness — overall and in each
    // half, which catches a wrong scale factor, a missing level shift and a
    // mismapped chroma plane alike.
    const result = await decodeThumbnailResult(stripJpeg);
    if (!result.ok) throw new Error('the strip must decode');
    const full = await decodeFullRaster(stripJpeg);
    if (!full) throw new Error('the full decode must still work');
    expect(full.width).toBe(3200);
    expect(full.height).toBe(240);

    const half = (pixels: Uint8Array, width: number, height: number, right: boolean) => {
      const out: number[] = [];
      const from = right ? Math.floor(width / 2) : 0;
      const to = right ? width : Math.floor(width / 2);
      for (let y = 0; y < height; y++) {
        for (let x = from; x < to; x++) {
          const at = (y * width + x) * 3;
          out.push(pixels[at], pixels[at + 1], pixels[at + 2]);
        }
      }
      return meanOf(Uint8Array.from(out));
    };
    for (const right of [false, true]) {
      const coarse = half(
        result.thumbnail.pixels, result.thumbnail.width, result.thumbnail.height, right);
      const exact = half(full.pixels, full.width, full.height, right);
      expect(Math.abs(coarse - exact)).toBeLessThan(6);
    }
  });

  it('the camera orientation still turns the reported source size', async () => {
    const result = await decodeThumbnailResult(withOrientationSix(stripJpeg));
    if (!result.ok) throw new Error('the oriented strip must decode');
    expect(result.thumbnail.sourceWidth).toBe(240);
    expect(result.thumbnail.sourceHeight).toBe(3200);
    expect(result.thumbnail.width).toBe(30);
    expect(result.thumbnail.height).toBe(400);
  });

  it('decodeRasterBoth measures coarsely and refuses to hand back full pixels', async () => {
    // Handing the block-resolution raster back as "full" would let a repair
    // store a 400-pixel rendition of a 3200-pixel photograph. Null is the
    // answer an over-ceiling picture has always given, and every caller
    // treats it as "cannot be repaired here", never as a verdict.
    const both = await decodeRasterBoth(stripJpeg);
    if (!both.ok) throw new Error('the strip must decode');
    expect(both.thumbnail.sourceWidth).toBe(3200);
    expect(both.full()).toBeNull();
  });

  it('a picture below the bound still decodes in full everywhere', async () => {
    const small = jpegOf(photograph(400, 200));
    const both = await decodeRasterBoth(small);
    if (!both.ok) throw new Error('the small picture must decode');
    expect(both.thumbnail.sourceWidth).toBe(400);
    const full = both.full();
    expect(full?.width).toBe(400);
    expect(full?.height).toBe(200);
  });

  it('the thumbnail readers ASK for the coarse reading; the full reader never does', () => {
    // The coarse path is deliberately transparent — same thumbnail, same
    // reported size — so no behavioural assertion can notice a caller
    // quietly dropping back to the full decode. That regression is invisible
    // here and fatal in the worker, so the request itself is pinned.
    const source = readFileSync(join(
      process.cwd(), 'supabase/functions/_shared/builderStock/sourceImageRaster.ts',
    ), 'utf8');
    const bodyOf = (name: string) => {
      const from = source.indexOf(`export async function ${name}`);
      return source.slice(from, source.indexOf('\n}', from));
    };
    expect(bodyOf('decodeThumbnailResult')).toContain('decodeRaster(bytes, true)');
    expect(bodyOf('decodeRasterBoth')).toContain('decodeRaster(bytes, true)');
    expect(bodyOf('decodeFullRaster')).not.toContain('decodeRaster(bytes, true)');
  });
});
