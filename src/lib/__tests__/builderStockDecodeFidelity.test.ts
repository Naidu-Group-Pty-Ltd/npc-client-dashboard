/**
 * Builder stock — the decode is faithful to what a person would see.
 *
 * Two classes of silent divergence between "the bytes the builder stored"
 * and "the picture a browser shows", both found by reading the decoders:
 *
 * ORIENTATION. A phone photograph is usually stored sideways with an EXIF
 * orientation tag, and every browser honours the tag. The decoders ignored
 * it — so the builder's ORIGINAL rendered upright while a derivative made
 * from the stored pixels rendered rotated, because a derivative is served as
 * its own PNG with no EXIF to correct it. The decode is now oriented once,
 * for measurement and repair alike.
 *
 * ALPHA. The PNG decoder read the alpha sample for its stride and dropped
 * it, so a transparent background — which most encoders store over black —
 * decoded as a large flat BLACK region: exactly the substrate the
 * flat-colour detector convicts, on a picture whose browser rendering never
 * showed it. Alpha now composites onto white, matching what the marketplace
 * card paints behind an image and what the WebP lossless path already did;
 * palette transparency (tRNS) and GIF transparency get the same answer.
 * The lossy-WebP ALPH plane remains deliberately unread, and `webp.ts` now
 * says so instead of claiming a compositing that never happened.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  decodeFullRaster, decodeThumbnailResult,
} from '../../../supabase/functions/_shared/builderStock/sourceImageRaster';
import { encodePng } from '../../../supabase/functions/_shared/builderStock/rasterPng';
import { jpegOf, photograph } from './fixtures/builderStockPictures';

/** An APP1 EXIF segment carrying only the orientation tag. */
function exifApp1(orientation: number): Uint8Array {
  const tiff = new Uint8Array([
    0x4d, 0x4d,             // 'MM' big-endian
    0x00, 0x2a,             // 42
    0x00, 0x00, 0x00, 0x08, // IFD0 at offset 8
    0x00, 0x01,             // one entry
    0x01, 0x12,             // tag 0x0112 orientation
    0x00, 0x03,             // type SHORT
    0x00, 0x00, 0x00, 0x01, // count 1
    0x00, orientation, 0x00, 0x00, // value, padded
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ]);
  const body = new Uint8Array(6 + tiff.length);
  body.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 0); // 'Exif\0\0'
  body.set(tiff, 6);
  const segment = new Uint8Array(4 + body.length);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment[2] = (body.length + 2) >> 8;
  segment[3] = (body.length + 2) & 0xff;
  segment.set(body, 4);
  return segment;
}

/** The same JPEG bytes with an EXIF orientation spliced in after SOI. */
function withOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
  const app1 = exifApp1(orientation);
  const out = new Uint8Array(jpeg.length + app1.length);
  out.set(jpeg.subarray(0, 2), 0);       // SOI
  out.set(app1, 2);
  out.set(jpeg.subarray(2), 2 + app1.length);
  return out;
}

const px = (
  raster: { width: number; pixels: Uint8Array }, x: number, y: number,
): [number, number, number] => {
  const at = (y * raster.width + x) * 3;
  return [raster.pixels[at], raster.pixels[at + 1], raster.pixels[at + 2]];
};

describe('EXIF orientation is honoured, once, at decode', () => {
  it('orientation 6 decodes rotated a quarter turn, pixel for pixel', async () => {
    const picture = photograph(64, 40, 7);
    const jpeg = await jpegOf(picture);
    const stored = await decodeFullRaster(jpeg);
    const oriented = await decodeFullRaster(withOrientation(jpeg, 6));
    expect(stored).not.toBeNull();
    expect(oriented).not.toBeNull();
    if (!stored || !oriented) return;

    expect(oriented.width).toBe(stored.height);
    expect(oriented.height).toBe(stored.width);
    // display(x, y) = stored(y, H-1-x): the JPEG entropy decode is
    // deterministic, so the mapping holds to the byte.
    for (const [x, y] of [[0, 0], [5, 3], [stored.height - 1, stored.width - 1]]) {
      expect(px(oriented, x, y)).toEqual(px(stored, y, stored.height - 1 - x));
    }
  });

  it('orientations 3 and 8 map the way a browser displays them', async () => {
    const picture = photograph(64, 40, 8);
    const jpeg = await jpegOf(picture);
    const stored = (await decodeFullRaster(jpeg))!;

    const upsideDown = (await decodeFullRaster(withOrientation(jpeg, 3)))!;
    expect(upsideDown.width).toBe(stored.width);
    expect(px(upsideDown, 2, 3))
      .toEqual(px(stored, stored.width - 3, stored.height - 4));

    const anticlockwise = (await decodeFullRaster(withOrientation(jpeg, 8)))!;
    expect(anticlockwise.width).toBe(stored.height);
    expect(px(anticlockwise, 2, 3)).toEqual(px(stored, stored.width - 4, 2));
  });

  it('both decode paths agree — the thumbnail turns with the full raster', async () => {
    // The failure mode worth pinning: orientation added to one decode path
    // and not the other, so the verdict and the repair read different grids.
    const picture = photograph(300, 100, 9);
    const jpeg = withOrientation(await jpegOf(picture), 6);
    const full = await decodeFullRaster(jpeg);
    const thumb = await decodeThumbnailResult(jpeg);
    expect(full?.width).toBe(100);
    expect(full?.height).toBe(300);
    expect(thumb.ok).toBe(true);
    if (thumb.ok !== true) return;
    expect(thumb.thumbnail.width).toBeLessThanOrEqual(100);
    expect(thumb.thumbnail.width / thumb.thumbnail.height)
      .toBeCloseTo((full?.width ?? 1) / (full?.height ?? 1), 1);
  });

  it('a JPEG with no EXIF decodes exactly as it always did', async () => {
    const picture = photograph(64, 40, 10);
    const jpeg = await jpegOf(picture);
    const raster = await decodeFullRaster(jpeg);
    expect(raster?.width).toBe(64);
    expect(raster?.height).toBe(40);
  });
});

describe('alpha composites onto white, whatever the container', () => {
  it('a transparent PNG border over black decodes white, not black', async () => {
    // Most encoders store (0,0,0) under fully-transparent pixels: dropped
    // alpha turned that into a flat black region for the detector.
    const edge = 32;
    const rgba = new Uint8Array(edge * edge * 4);
    for (let y = 0; y < edge; y++) {
      for (let x = 0; x < edge; x++) {
        const at = (y * edge + x) * 4;
        const inner = x >= 8 && x < 24 && y >= 8 && y < 24;
        rgba[at] = inner ? 200 : 0;
        rgba[at + 1] = inner ? 120 : 0;
        rgba[at + 2] = inner ? 40 : 0;
        rgba[at + 3] = inner ? 255 : 0;
      }
    }
    const png = (await encodePng(rgba, { width: edge, height: edge, components: 4 }))!;
    const raster = await decodeFullRaster(png);
    expect(raster).not.toBeNull();
    if (!raster) return;
    expect(px(raster, 0, 0)).toEqual([255, 255, 255]);
    expect(px(raster, 16, 16)).toEqual([200, 120, 40]);
  });

  it('half-transparent pixels blend toward white, arithmetically', async () => {
    const rgba = new Uint8Array([0, 0, 0, 128]);
    const png = (await encodePng(rgba, { width: 1, height: 1, components: 4 }))!;
    const raster = await decodeFullRaster(png);
    // (0 * 128 + 255 * 127) / 255 = 127
    expect(raster && px(raster, 0, 0)).toEqual([127, 127, 127]);
  });

  it('palette transparency (tRNS) gets the same answer', async () => {
    // Hand-built: 2x1, colour type 3, palette [red, green], entry 0
    // transparent. The decoder verifies no CRCs, so the chunks carry zeros.
    const chunk = (type: string, data: number[]): number[] => {
      const length = data.length;
      return [
        (length >> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff,
        ...[...type].map((c) => c.charCodeAt(0)),
        ...data,
        0, 0, 0, 0,
      ];
    };
    // Raw scanline: filter 0, indices [0, 1]; stored deflate: one static
    // block. Compress with the platform's own deflate for honesty.
    const raw = new Uint8Array([0, 0, 1]);
    const transform = new CompressionStream('deflate');
    const writer = transform.writable.getWriter();
    void writer.write(raw).then(() => writer.close());
    const deflated = new Uint8Array(
      await new Response(transform.readable).arrayBuffer());

    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ...chunk('IHDR', [0, 0, 0, 2, 0, 0, 0, 1, 8, 3, 0, 0, 0]),
      ...chunk('PLTE', [255, 0, 0, 0, 255, 0]),
      ...chunk('tRNS', [0, 255]),
      ...chunk('IDAT', [...deflated]),
      ...chunk('IEND', []),
    ]);
    const raster = await decodeFullRaster(png);
    expect(raster).not.toBeNull();
    if (!raster) return;
    expect(px(raster, 0, 0)).toEqual([255, 255, 255]);
    expect(px(raster, 1, 0)).toEqual([0, 255, 0]);
  });

  it('a GIF\'s transparent index shows the white page, not its palette colour', async () => {
    // 2x1, global palette [red, blue], GCE naming index 0 transparent.
    const bits: number[] = [];
    const put = (code: number, width: number) => {
      for (let i = 0; i < width; i++) bits.push((code >> i) & 1);
    };
    // min code size 2: clear=4, end=5, codes are 3 bits wide to start.
    put(4, 3); put(0, 3); put(1, 3); put(5, 3);
    const packed: number[] = [];
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let b = 0; b < 8 && i + b < bits.length; b++) byte |= bits[i + b] << b;
      packed.push(byte);
    }
    const gif = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61,   // GIF89a
      2, 0, 1, 0,                            // 2x1 screen
      0x80, 0, 0,                            // global palette, 2 entries
      255, 0, 0, 0, 0, 255,                  // red, blue
      0x21, 0xf9, 4, 0x01, 0, 0, 0, 0,       // GCE: transparent, index 0
      0x2c, 0, 0, 0, 0, 2, 0, 1, 0, 0,       // image descriptor
      2,                                     // min LZW code size
      packed.length, ...packed, 0,           // one data sub-block
      0x3b,
    ]);
    const raster = await decodeFullRaster(gif);
    expect(raster).not.toBeNull();
    if (!raster) return;
    expect(px(raster, 0, 0)).toEqual([255, 255, 255]);
    expect(px(raster, 1, 0)).toEqual([0, 0, 255]);
  });
});

/**
 * And the repair reads the picture ONCE.
 *
 * A pure-TypeScript JPEG decode of a 1819x1223 render is the most expensive
 * thing in the repair, and the sanitizer used to do it twice on the same bytes
 * — once for the 400px measurement, once for the full-size pixels it hands
 * back. Production found the cost on 4 September 2026: every repair attempt on
 * Lot 1731 Hornsea Street died `CPU Time exceeded` (02:17, 02:25, 02:31,
 * 02:42) where the same picture had repaired in 13.4s the day before.
 *
 * Pinned as a source check because the property is otherwise invisible: two
 * decodes and one decode produce identical pixels, identical verdicts and
 * identical output, and differ only in whether the invocation survives.
 */
describe('the sanitizer decodes its input once', () => {
  const source = readFileSync(
    join(process.cwd(), 'supabase', 'functions', '_shared', 'builderStock', 'sanitizeImage.ts'),
    'utf8');

  it('takes both readings from one decode', () => {
    expect(source).toContain('decodeRasterBoth(bytes)');
    expect(source).toContain('thumbnail.full()');
  });

  it('never decodes the input a second time at full size', () => {
    expect(source).not.toContain('decodeFullRaster');
  });

  /*
   * The one read-back that stays. It reads the artefact that will be STORED,
   * which is a check of the encoder rather than a second reading of the input,
   * and removing it would take a control away rather than a cost.
   */
  it('still reads back the picture it encoded', () => {
    expect(source).toContain('decodeThumbnailResult(bytes)');
    expect(source).toContain('the repaired picture could not be read back');
  });
});
