/**
 * Builder stock tests — pictures that are actually pictures.
 *
 * WHY THIS EXISTS. Display eligibility is decided by DECODING the bytes and
 * measuring what is drawn on them, and it fails closed: an image no decoder
 * here can read is `pending`, which is not displayable. Every pipeline test in
 * this directory used to hand the importer a PNG signature followed by four
 * kilobytes of zeroes, or `FFD8FFE0` followed by a fill byte — enough to be
 * sniffed as an image, nothing like one. Those fixtures now measure exactly
 * what they are: unreadable. A test that wants to assert a card RENDERS has to
 * supply a picture, so this module draws one.
 *
 * Two pictures, and the difference between them is the whole feature:
 *
 *   clean       a facade under a sky, grain everywhere, nothing laid over it
 *   annotated   the same picture with a status ribbon and a word set on it
 *
 * Neither names a suburb, a state, a builder or a status: the letterforms are
 * chosen for their shapes, and the classifier reads no words. They come out as
 * real PNG and real baseline JPEG so the production decoders read them by the
 * production path, which is also what keeps this from drifting away from the
 * thing it stands in for.
 */
import { encodePng } from '../../../../supabase/functions/_shared/builderStock/rasterPng';
import { readMarketingOverlay } from '../../../../supabase/functions/_shared/builderStock/marketingOverlay.pure';
import {
  decideMarketplaceEligibility, marketplaceEligibilityDetail,
} from '../../../../supabase/functions/_shared/builderStock/marketplaceEligibility.pure';

export interface Picture { width: number; height: number; pixels: Uint8Array }

/**
 * A photograph: a graded sky, a roofline cutting it off, and grain in both.
 *
 * The grain is the point. A flat synthetic gradient reads as a drawn graphic
 * to a flat-colour detector, which would make every fixture here a false
 * positive and prove nothing.
 */
export function photograph(width = 400, height = 200, variant = 0): Picture {
  const pixels = new Uint8Array(width * height * 3);
  let seed = 12345 + variant * 7919;
  const grain = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return ((seed >> 8) % 21) - 10;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3;
      const roof = Math.round(height * 0.3)
        + Math.round(height * 0.18 * Math.sin((x / width) * Math.PI * 2));
      if (y < roof) {
        pixels[at] = clamp(120 + Math.floor(y / 2) + grain());
        pixels[at + 1] = clamp(165 + Math.floor(y / 2) + grain());
        pixels[at + 2] = clamp(215 + Math.min(30, Math.floor(y / 2)) + grain());
      } else {
        /*
         * SMOOTH VARIATION PLUS GRAIN, NOT A MODULO RAMP.
         *
         * This used to be `(x * 11 + y * 5) % 40`, which is a sawtooth: it
         * wraps, and every wrap is a hard diagonal edge repeating on a fixed
         * period. That is a regular striped pattern in a quiet part of the
         * frame, which is exactly the shape the faint-typography pass looks
         * for — so the fixture that stands in for "an ordinary photograph"
         * behaved like drawn lettering. Nothing photographic has a discontinuity
         * on a fixed period, so neither does this.
         */
        const wash = Math.sin(x * 0.031 + y * 0.017) * 14
          + Math.sin(x * 0.007 - y * 0.053) * 9;
        pixels[at] = clamp(150 + Math.round(wash) + grain());
        pixels[at + 1] = clamp(140 + Math.round(wash * 0.8) + grain());
        pixels[at + 2] = clamp(130 + Math.round(wash * 0.6) + grain());
      }
    }
  }
  return { width, height, pixels };
}

/**
 * A plate, the way a ribbon or a status pill is drawn.
 *
 * `alpha` below 1 is a scrim: the photograph's own texture shows through it,
 * so nothing about it is a flat colour and only the typography signal can
 * find it. That is a shape the classifier has to catch, so it is a shape the
 * fixtures have to be able to draw.
 */
export function withPlate(base: Picture, box: { x: number; y: number; w: number; h: number },
  colour: [number, number, number], alpha = 1): Picture {
  const pixels = new Uint8Array(base.pixels);
  for (let y = box.y; y < box.y + box.h && y < base.height; y++) {
    for (let x = box.x; x < box.x + box.w && x < base.width; x++) {
      const at = (y * base.width + x) * 3;
      for (let c = 0; c < 3; c++) {
        pixels[at + c] = Math.round(pixels[at + c] * (1 - alpha) + colour[c] * alpha);
      }
    }
  }
  return { width: base.width, height: base.height, pixels };
}

/** Six letterforms. Shapes, not language — nothing here reads them. */
const FONT: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  E: ['11111', '10000', '11110', '10000', '10000', '10000', '11111'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  R: ['11110', '10001', '11110', '10100', '10010', '10001', '10001'],
  S: ['01111', '10000', '01110', '00001', '00001', '10001', '01110'],
};

/** Set a word over the picture, anti-aliased the way rendered type is. */
export function withCaption(base: Picture, text: string,
  options: { x: number; y: number; scale: number; ink: [number, number, number] }): Picture {
  const pixels = new Uint8Array(base.pixels);
  const coverage = new Float32Array(base.width * base.height);
  let cursor = options.x;
  for (const character of text) {
    const glyph = FONT[character];
    if (glyph) {
      for (let row = 0; row < 7; row++) {
        for (let column = 0; column < 5; column++) {
          if (glyph[row][column] !== '1') continue;
          for (let dy = 0; dy < options.scale; dy++) {
            for (let dx = 0; dx < options.scale; dx++) {
              const x = cursor + column * options.scale + dx;
              const y = options.y + row * options.scale + dy;
              if (x < 0 || y < 0 || x >= base.width || y >= base.height) continue;
              coverage[y * base.width + x] = 1;
            }
          }
        }
      }
    }
    cursor += 6 * options.scale;
  }
  for (let y = 0; y < base.height; y++) {
    for (let x = 0; x < base.width; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ny = y + dy;
          const nx = x + dx;
          if (ny < 0 || ny >= base.height || nx < 0 || nx >= base.width) continue;
          sum += coverage[ny * base.width + nx];
          n += 1;
        }
      }
      const alpha = sum / n;
      if (alpha <= 0) continue;
      const at = (y * base.width + x) * 3;
      for (let c = 0; c < 3; c++) {
        pixels[at + c] = Math.round(pixels[at + c] * (1 - alpha) + options.ink[c] * alpha);
      }
    }
  }
  return { width: base.width, height: base.height, pixels };
}

/**
 * Set a word over the picture FAINTLY — visible, but below the strict pass's
 * ink floor.
 *
 * Drawn as a fixed LIFT above whatever is underneath rather than toward an
 * absolute ink, so the local contrast is the lift itself wherever the caption
 * lands: above `measureFaintOverlayText`'s quiet-ground floor — the ground's
 * own dispersion × 2.4, which on the grained sky fixtures lands around 31 —
 * and below the strict pass's `INK_CONTRAST` of 40. The default of 34 sits in
 * that window on the shared sky fixtures; a caller drawing on other ground
 * should assert the mark is measured, not assume it. This is the shape of the
 * pale "artist impression" strip a repair can leave behind — the mark only
 * the faint pass can see, which is exactly why a gate that reads a suppressed
 * faint count instead of measuring one misses it.
 */
export function withFaintCaption(base: Picture, text: string,
  options: { x: number; y: number; scale: number; lift?: number }): Picture {
  const lift = options.lift ?? 34;
  const pixels = new Uint8Array(base.pixels);
  const coverage = new Float32Array(base.width * base.height);
  let cursor = options.x;
  for (const character of text) {
    const glyph = FONT[character];
    if (glyph) {
      for (let row = 0; row < 7; row++) {
        for (let column = 0; column < 5; column++) {
          if (glyph[row][column] !== '1') continue;
          for (let dy = 0; dy < options.scale; dy++) {
            for (let dx = 0; dx < options.scale; dx++) {
              const x = cursor + column * options.scale + dx;
              const y = options.y + row * options.scale + dy;
              if (x < 0 || y < 0 || x >= base.width || y >= base.height) continue;
              coverage[y * base.width + x] = 1;
            }
          }
        }
      }
    }
    cursor += 6 * options.scale;
  }
  for (let y = 0; y < base.height; y++) {
    for (let x = 0; x < base.width; x++) {
      const alpha = coverage[y * base.width + x];
      if (alpha <= 0) continue;
      const at = (y * base.width + x) * 3;
      for (let c = 0; c < 3; c++) {
        pixels[at + c] = clamp(pixels[at + c] + Math.round(lift * alpha));
      }
    }
  }
  return { width: base.width, height: base.height, pixels };
}

/**
 * A diagonal corner ribbon — the promotional shape the flat-colour arm's
 * rectangle assumption exempts. Drawn as the band of pixels within half a
 * thickness of the line from (x1,y1) to (x2,y2).
 */
export function withDiagonalRibbon(base: Picture,
  line: { x1: number; y1: number; x2: number; y2: number; thickness: number },
  colour: [number, number, number]): Picture {
  const pixels = new Uint8Array(base.pixels);
  const dx = line.x2 - line.x1;
  const dy = line.y2 - line.y1;
  const length = Math.hypot(dx, dy) || 1;
  const half = line.thickness / 2;
  for (let y = 0; y < base.height; y++) {
    for (let x = 0; x < base.width; x++) {
      const t = ((x - line.x1) * dx + (y - line.y1) * dy) / (length * length);
      if (t < 0 || t > 1) continue;
      const px = line.x1 + t * dx;
      const py = line.y1 + t * dy;
      if (Math.hypot(x - px, y - py) > half) continue;
      const at = (y * base.width + x) * 3;
      pixels[at] = colour[0];
      pixels[at + 1] = colour[1];
      pixels[at + 2] = colour[2];
    }
  }
  return { width: base.width, height: base.height, pixels };
}

/** A circular price roundel — the other shape the rectangle assumption exempts. */
export function withDisc(base: Picture,
  disc: { cx: number; cy: number; r: number },
  colour: [number, number, number]): Picture {
  const pixels = new Uint8Array(base.pixels);
  for (let y = 0; y < base.height; y++) {
    for (let x = 0; x < base.width; x++) {
      if (Math.hypot(x - disc.cx, y - disc.cy) > disc.r) continue;
      const at = (y * base.width + x) * 3;
      pixels[at] = colour[0];
      pixels[at + 1] = colour[1];
      pixels[at + 2] = colour[2];
    }
  }
  return { width: base.width, height: base.height, pixels };
}

/**
 * The clean picture. `variant` re-seeds the grain, so two calls give two
 * genuinely different pictures — which is what stops a document's images
 * deduplicating on their content hash.
 */
export const cleanPicture = (width?: number, height?: number, variant = 0) =>
  photograph(width, height, variant);

/** The same picture under a status ribbon with a word set on it. */
export function annotatedPicture(width = 400, height = 200, variant = 0): Picture {
  const base = photograph(width, height, variant);
  const plated = withPlate(base, {
    x: Math.round(width * 0.035), y: Math.round(height * 0.05),
    w: Math.round(width * 0.575), h: Math.round(height * 0.17),
  }, [193, 255, 114]);
  return withCaption(plated, 'SOLERA', {
    x: Math.round(width * 0.05), y: Math.round(height * 0.08),
    scale: Math.max(1, Math.round(height * 0.015)), ink: [10, 10, 10],
  });
}

const clamp = (value: number) => value < 0 ? 0 : value > 255 ? 255 : value;

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

/** The picture as a real PNG, through the same encoder the crop path uses. */
export function pngOf(picture: Picture): Promise<Uint8Array> {
  return encodePng(picture.pixels, {
    width: picture.width, height: picture.height, components: 3,
  });
}

/**
 * The picture as a real baseline JPEG.
 *
 * Written here rather than taken from a checked-in binary so a fixture is a
 * function of its arguments, and deliberately INDEPENDENT of the decoder it
 * feeds: an encoder and a decoder written from the same specification and not
 * from each other is the only round trip worth having.
 *
 * 4:4:4, one quality, no restart intervals. `padTo` appends bytes AFTER the
 * end-of-image marker, where a decoder stops reading — it exists only so a
 * test can order two images by file size the way the live documents do.
 */
export function jpegOf(picture: Picture, padTo = 0): Uint8Array {
  const body = encodeBaselineJpeg(picture);
  if (padTo <= body.length) return body;
  const out = new Uint8Array(padTo);
  out.set(body, 0);
  return out;
}

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

/** The specification's example luminance table, used for both components. */
const BASE_QUANT = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];

/** The specification's example Huffman tables, as (bits, values) pairs. */
const DC_BITS = [0, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_BITS = [0, 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_VALUES = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61,
  0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52,
  0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25,
  0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45,
  0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64,
  0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83,
  0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99,
  0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
  0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3,
  0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8,
  0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];

/** (code, length) per value, built the way the specification builds them. */
function huffmanCodes(bits: number[], values: number[]): Map<number, [number, number]> {
  const table = new Map<number, [number, number]>();
  let code = 0;
  let k = 0;
  for (let length = 1; length <= 16; length++) {
    for (let n = 0; n < bits[length]; n++) table.set(values[k++], [code++, length]);
    code <<= 1;
  }
  return table;
}

function encodeBaselineJpeg(picture: Picture): Uint8Array {
  const { width, height, pixels } = picture;
  const quant = BASE_QUANT.slice();
  const dc = huffmanCodes(DC_BITS, DC_VALUES);
  const ac = huffmanCodes(AC_BITS, AC_VALUES);

  const out: number[] = [];
  const byte = (value: number) => out.push(value & 0xff);
  const word = (value: number) => { byte(value >> 8); byte(value); };
  const marker = (value: number) => { byte(0xff); byte(value); };

  marker(0xd8);

  marker(0xdb);
  word(2 + 1 + 64);
  byte(0);
  for (let i = 0; i < 64; i++) byte(quant[ZIGZAG[i]]);

  marker(0xc0);
  word(8 + 3 * 3);
  byte(8);
  word(height);
  word(width);
  byte(3);
  for (let component = 1; component <= 3; component++) {
    byte(component);
    byte(0x11); // 4:4:4 — no subsampling, so nothing here depends on upsampling
    byte(0);
  }

  const huffmanSegment = (klass: number, id: number, bits: number[], values: number[]) => {
    marker(0xc4);
    word(2 + 1 + 16 + values.length);
    byte((klass << 4) | id);
    for (let length = 1; length <= 16; length++) byte(bits[length]);
    for (const value of values) byte(value);
  };
  huffmanSegment(0, 0, DC_BITS, DC_VALUES);
  huffmanSegment(1, 0, AC_BITS, AC_VALUES);

  marker(0xda);
  word(6 + 2 * 3);
  byte(3);
  for (let component = 1; component <= 3; component++) { byte(component); byte(0x00); }
  byte(0);
  byte(63);
  byte(0);

  // ── entropy-coded data ────────────────────────────────────────────────────
  let bitBuffer = 0;
  let bitCount = 0;
  const writeBits = (code: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) {
      bitBuffer = (bitBuffer << 1) | ((code >> i) & 1);
      bitCount += 1;
      if (bitCount === 8) {
        byte(bitBuffer);
        if ((bitBuffer & 0xff) === 0xff) byte(0x00); // byte stuffing
        bitBuffer = 0;
        bitCount = 0;
      }
    }
  };
  const magnitude = (value: number) => {
    let bits = 0;
    let magnitudeOf = Math.abs(value);
    while (magnitudeOf) { bits += 1; magnitudeOf >>= 1; }
    return bits;
  };

  const block = new Float64Array(64);
  const coefficients = new Int32Array(64);
  const previousDc = [0, 0, 0];

  for (let blockY = 0; blockY < Math.ceil(height / 8); blockY++) {
    for (let blockX = 0; blockX < Math.ceil(width / 8); blockX++) {
      for (let component = 0; component < 3; component++) {
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            const sx = Math.min(width - 1, blockX * 8 + x);
            const sy = Math.min(height - 1, blockY * 8 + y);
            const at = (sy * width + sx) * 3;
            const r = pixels[at];
            const g = pixels[at + 1];
            const b = pixels[at + 2];
            const value = component === 0
              ? 0.299 * r + 0.587 * g + 0.114 * b
              : component === 1
                ? -0.168736 * r - 0.331264 * g + 0.5 * b + 128
                : 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
            block[y * 8 + x] = value - 128;
          }
        }
        forwardDct(block);
        for (let i = 0; i < 64; i++) {
          coefficients[i] = Math.round(block[ZIGZAG[i]] / quant[ZIGZAG[i]]);
        }

        const diff = coefficients[0] - previousDc[component];
        previousDc[component] = coefficients[0];
        const dcSize = magnitude(diff);
        const [dcCode, dcLength] = dc.get(dcSize)!;
        writeBits(dcCode, dcLength);
        if (dcSize) writeBits(diff < 0 ? diff + (1 << dcSize) - 1 : diff, dcSize);

        let end = 63;
        while (end > 0 && coefficients[end] === 0) end -= 1;
        let run = 0;
        for (let i = 1; i <= end; i++) {
          if (coefficients[i] === 0) { run += 1; continue; }
          while (run > 15) {
            const [code, length] = ac.get(0xf0)!;
            writeBits(code, length);
            run -= 16;
          }
          const size = magnitude(coefficients[i]);
          const [code, length] = ac.get((run << 4) | size)!;
          writeBits(code, length);
          writeBits(coefficients[i] < 0
            ? coefficients[i] + (1 << size) - 1 : coefficients[i], size);
          run = 0;
        }
        if (end < 63) {
          const [code, length] = ac.get(0x00)!;
          writeBits(code, length);
        }
      }
    }
  }
  // Pad the last byte with 1 bits, which is what the specification requires
  // and what stops a decoder reading the EOI marker as coefficient data.
  while (bitCount) writeBits(1, 1);

  marker(0xd9);
  return Uint8Array.from(out);
}

/** The separable forward DCT, in place. */
function forwardDct(block: Float64Array): void {
  const temporary = new Float64Array(64);
  for (let y = 0; y < 8; y++) {
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let x = 0; x < 8; x++) sum += block[y * 8 + x] * COS[u * 8 + x];
      temporary[y * 8 + u] = sum * (u === 0 ? SQRT_HALF : 1) * 0.5;
    }
  }
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let sum = 0;
      for (let y = 0; y < 8; y++) sum += temporary[y * 8 + u] * COS[v * 8 + y];
      block[v * 8 + u] = sum * (v === 0 ? SQRT_HALF : 1) * 0.5;
    }
  }
}

const SQRT_HALF = Math.SQRT1_2;
const COS = (() => {
  const table = new Float64Array(64);
  for (let u = 0; u < 8; u++) {
    for (let x = 0; x < 8; x++) table[u * 8 + x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
  return table;
})();

// ---------------------------------------------------------------------------
// Verdicts, for tests that work on rows rather than on bytes
// ---------------------------------------------------------------------------

/**
 * The `source_detail` keys a settled image carries, MEASURED rather than typed.
 *
 * A test about which of several rows a card draws does not want to decode
 * anything, but it must not hand-write `marketplace_display_eligible: true`
 * either — a literal would keep passing after the classifier stopped agreeing
 * with it. These run the real measurement over the real fixture picture and
 * store what it says, so a fixture that stopped being clean would fail the
 * tests that depend on it being clean.
 */
export const measuredDetail = (picture: Picture): Record<string, unknown> =>
  marketplaceEligibilityDetail(decideMarketplaceEligibility(readMarketingOverlay(picture)));

/** A measured, unannotated picture: the only verdict a card may draw. */
export const CLEAN_VERDICT = measuredDetail(cleanPicture());
/** A measured picture carrying a ribbon and a word: refused. */
export const ANNOTATED_VERDICT = measuredDetail(annotatedPicture());

// ---------------------------------------------------------------------------
// WebP
// ---------------------------------------------------------------------------

/**
 * The picture as a real lossless WebP (VP8L).
 *
 * WRITTEN HERE RATHER THAN CHECKED IN, and deliberately not written against the
 * decoder it feeds: an encoder and a decoder built from the same specification
 * and not from each other is the only round trip worth having. It is the
 * simplest legal VP8L bitstream — no transforms, no colour cache, no
 * meta-Huffman, one Huffman group whose literal codes are all eight bits — which
 * is exactly what makes it useful: it exercises the container, the bit order,
 * the code-length descriptor and the literal path without depending on any of
 * the encoder's own cleverness.
 *
 * The two LOSSY fixtures beside this are checked-in files produced by libwebp,
 * because nothing here can encode VP8 and interoperating with the real encoder
 * is better evidence than interoperating with our own.
 */
export function losslessWebpOf(picture: Picture): Uint8Array {
  const bits = new BitWriter();

  // ── VP8L header ──────────────────────────────────────────────────────────
  bits.write(0x2f, 8);
  bits.write(picture.width - 1, 14);
  bits.write(picture.height - 1, 14);
  bits.write(0, 1); // no alpha
  bits.write(0, 3); // version

  bits.write(0, 1); // no transforms
  bits.write(0, 1); // no colour cache
  bits.write(0, 1); // no meta-Huffman

  // Four literal codes (green, red, blue, alpha), then the distance code.
  for (let i = 0; i < 4; i++) writeFlatLiteralCode(bits);
  // Distance: the "simple" form with a single symbol, which costs no bits to
  // read and is never used, because nothing here emits a backward reference.
  bits.write(1, 1); // simple
  bits.write(0, 1); // one symbol
  bits.write(0, 1); // stated in one bit rather than eight
  bits.write(0, 1); // symbol 0

  // ── pixels, as literals ──────────────────────────────────────────────────
  const { width, height, pixels } = picture;
  for (let i = 0; i < width * height; i++) {
    writeFlatSymbol(bits, pixels[i * 3 + 1]); // green
    writeFlatSymbol(bits, pixels[i * 3]);     // red
    writeFlatSymbol(bits, pixels[i * 3 + 2]); // blue
    writeFlatSymbol(bits, 255);               // alpha
  }

  return riff('VP8L', bits.bytes());
}

/**
 * A complete 256-symbol code in which every literal is eight bits.
 *
 * Declared through the code-length code rather than as a literal list: the
 * code-length code itself is given exactly one symbol (the value 8), which the
 * format reads as costing no bits, and a maximum-symbol count of 256 stops the
 * run. It is the shortest legal way to say "all 256 literals, eight bits each".
 */
function writeFlatLiteralCode(bits: BitWriter): void {
  bits.write(0, 1);  // not the simple form
  bits.write(8, 4);  // 8 + 4 = 12 code-length symbols follow, in the fixed order
  // The fixed order is [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, ...]; only the
  // twelfth of those, the value 8, is given a length.
  for (let i = 0; i < 11; i++) bits.write(0, 3);
  bits.write(1, 3);
  bits.write(1, 1);   // a maximum symbol count follows
  bits.write(3, 3);   // stated in 2 + 2 * 3 = 8 bits
  bits.write(254, 8); // 2 + 254 = 256 symbols
}

/** An eight-bit canonical code is its own symbol, written most significant first. */
function writeFlatSymbol(bits: BitWriter, symbol: number): void {
  for (let bit = 7; bit >= 0; bit--) bits.write((symbol >> bit) & 1, 1);
}

/** VP8L's bit order: least significant first, within bytes in address order. */
class BitWriter {
  private readonly out: number[] = [];
  private current = 0;
  private used = 0;

  write(value: number, count: number): void {
    for (let i = 0; i < count; i++) {
      this.current |= ((value >> i) & 1) << this.used;
      if (++this.used === 8) {
        this.out.push(this.current);
        this.current = 0;
        this.used = 0;
      }
    }
  }

  bytes(): Uint8Array {
    const finished = this.used ? [...this.out, this.current] : this.out;
    return Uint8Array.from(finished);
  }
}

/** Wrap a bitstream in the RIFF container a `.webp` file is. */
function riff(fourcc: string, body: Uint8Array): Uint8Array {
  const padded = body.length + (body.length & 1);
  const out = new Uint8Array(12 + 8 + padded);
  const view = new DataView(out.buffer);
  const put = (offset: number, text: string) => {
    for (let i = 0; i < 4; i++) out[offset + i] = text.charCodeAt(i);
  };
  put(0, 'RIFF');
  view.setUint32(4, 4 + 8 + padded, true);
  put(8, 'WEBP');
  put(12, fourcc);
  view.setUint32(16, body.length, true);
  out.set(body, 20);
  return out;
}
