import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_SIZE,
  classifyVisual,
  visualFeatures,
  visualSignature,
  type VisualFeatures,
} from '../../supabase/functions/_shared/listingImageVision.pure';

/**
 * The vectors below are not invented. Each row is the output of running
 * `visualFeatures` over an image pulled from `public.listing_images` on
 * 2026-08-19, labelled by looking at it. Seven floor plans, two marketing
 * graphics and twelve photographs — the sample that fixed the thresholds.
 *
 * If a threshold moves, these fail. That is the point: they are the measurement,
 * not an illustration of it.
 */

interface Sample {
  label: 'photo' | 'floorplan' | 'graphic';
  what: string;
  aspect: number;
  features: VisualFeatures;
}

const f = (white: number, colour: number, dark: number, palette: number, edge: number): VisualFeatures => ({
  white,
  colour,
  dark,
  palette,
  edge,
});

const CORPUS: Sample[] = [
  // ── Floor plans ────────────────────────────────────────────────────────────
  { label: 'floorplan', what: 'site plan with pool, portrait', aspect: 0.71, features: f(0.867, 0.032, 0.003, 37, 5.89) },
  { label: 'floorplan', what: 'coloured floor + site plan', aspect: 0.71, features: f(0.788, 0.024, 0.003, 105, 11.01) },
  { label: 'floorplan', what: 'two-storey plan, landscape', aspect: 1.42, features: f(0.749, 0.016, 0.006, 73, 15.52) },
  { label: 'floorplan', what: 'black and white plan', aspect: 1.42, features: f(0.955, 0.003, 0.012, 20, 8.04) },
  { label: 'floorplan', what: 'plan with lawn fills', aspect: 1.42, features: f(0.742, 0.040, 0.001, 70, 16.39) },
  { label: 'floorplan', what: 'Yaltara Rd, portrait', aspect: 0.71, features: f(0.759, 0.005, 0.011, 52, 18.46) },
  { label: 'floorplan', what: 'Challenger Pde', aspect: 1.42, features: f(0.731, 0.051, 0.009, 69, 17.91) },

  // ── Marketing graphics ─────────────────────────────────────────────────────
  { label: 'graphic', what: '"coming soon" text card', aspect: 1.50, features: f(0.512, 0.160, 0.012, 213, 18.75) },
  { label: 'graphic', what: 'agency banner strip, on 20 listings', aspect: 10.93, features: f(0.000, 0.104, 0.823, 18, 9.85) },

  // ── Photographs ────────────────────────────────────────────────────────────
  { label: 'photo', what: 'house, dry lawn', aspect: 1.33, features: f(0.111, 0.519, 0.014, 335, 17.47) },
  { label: 'photo', what: 'living room, white walls', aspect: 1.33, features: f(0.002, 0.048, 0.014, 243, 14.91) },
  { label: 'photo', what: 'brick house', aspect: 1.50, features: f(0.012, 0.437, 0.033, 469, 21.26) },
  { label: 'photo', what: 'black-and-white aerial', aspect: 1.33, features: f(0.000, 0.000, 0.037, 46, 19.23) },
  { label: 'photo', what: 'white house, driveway', aspect: 1.33, features: f(0.118, 0.315, 0.005, 347, 21.32) },
  { label: 'photo', what: 'modern house at dusk', aspect: 1.50, features: f(0.000, 0.559, 0.240, 332, 17.67) },
  { label: 'photo', what: 'house with boundary overlay', aspect: 1.50, features: f(0.068, 0.292, 0.013, 320, 25.94) },
  { label: 'photo', what: 'stock interior render (17 listings)', aspect: 2.00, features: f(0.045, 0.227, 0.062, 132, 32.48) },
  { label: 'photo', what: 'house with palms', aspect: 1.50, features: f(0.027, 0.634, 0.052, 525, 38.13) },
  { label: 'photo', what: 'apartments and pool', aspect: 1.50, features: f(0.020, 0.433, 0.013, 356, 25.41) },
  { label: 'photo', what: 'interior, muted', aspect: 1.50, features: f(0.001, 0.077, 0.080, 223, 22.57) },
  { label: 'photo', what: 'garden exterior', aspect: 1.50, features: f(0.029, 0.496, 0.013, 556, 28.14) },
];

describe('classifyVisual — against the corpus it was fitted to', () => {
  it.each(CORPUS)('reads $what as $label', ({ label, aspect, features }) => {
    expect(classifyVisual(features, aspect)).toBe(label);
  });

  it('separates the two populations by a wide margin, not a hair', () => {
    // The whole approach rests on this gap. If a future corpus closes it, the
    // thresholds need refitting rather than nudging.
    const plans = CORPUS.filter((s) => s.label === 'floorplan').map((s) => s.features.white);
    const photos = CORPUS.filter((s) => s.label === 'photo').map((s) => s.features.white);
    expect(Math.min(...plans)).toBeGreaterThan(0.7);
    expect(Math.max(...photos)).toBeLessThan(0.15);
  });

  it('gives a bright, colourful exterior the benefit of the doubt', () => {
    // A white render against an overcast sky: plenty of near-white, but the
    // landscaping keeps it colourful and its palette large. Demoting it would
    // bury the best photograph of the listing — much the worse mistake.
    expect(classifyVisual(f(0.5, 0.4, 0.01, 400, 20), 1.5)).toBe('photo');
  });

  it('says nothing about aspect when it is not known', () => {
    expect(classifyVisual(f(0.02, 0.4, 0.02, 300, 20), null)).toBe('photo');
    expect(classifyVisual(f(0.02, 0.4, 0.02, 300, 20))).toBe('photo');
  });
});

/** Build a `size`×`size` RGBA buffer from a per-pixel colour function. */
function square(size: number, at: (x: number, y: number) => [number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const [r, g, b] = at(x, y);
      const i = (y * size + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return data;
}

describe('visualFeatures', () => {
  it('measures white ground and real chroma separately', () => {
    // Top half paper, then line-work, then lawn fill.
    const px = square(ANALYSIS_SIZE, (_x, y) => {
      if (y < ANALYSIS_SIZE * 0.6) return [250, 250, 250];
      if (y < ANALYSIS_SIZE * 0.8) return [40, 40, 40];
      return [80, 160, 60];
    });
    const features = visualFeatures(px, ANALYSIS_SIZE);
    expect(features.white).toBeCloseTo(0.6, 1);
    expect(features.colour).toBeCloseTo(0.2, 1);
    // Three flat bands: a tiny palette, which is what marks artwork.
    expect(features.palette).toBeLessThan(8);
  });
});

describe('visualSignature', () => {
  it('is 16 hex characters', () => {
    const px = square(ANALYSIS_SIZE, (x) => [x * 4, x * 2, 255 - x * 3]);
    expect(visualSignature(px, ANALYSIS_SIZE)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is unchanged by a uniform brightness shift — the same photograph, re-encoded', () => {
    const scene = (x: number, y: number): [number, number, number] => [
      (x * 7 + y * 3) % 256,
      (x * 3 + y * 11) % 256,
      (x * 5 + y * 2) % 256,
    ];
    const original = square(ANALYSIS_SIZE, scene);
    const brighter = square(ANALYSIS_SIZE, (x, y) => {
      const [r, g, b] = scene(x, y);
      return [Math.min(255, r + 12), Math.min(255, g + 12), Math.min(255, b + 12)];
    });
    expect(visualSignature(brighter, ANALYSIS_SIZE)).toBe(visualSignature(original, ANALYSIS_SIZE));
  });

  it('differs between two different scenes', () => {
    // Both need horizontal structure: a hash of "is this cell brighter than the
    // one to its right" is all zeros for any image that only varies vertically,
    // and for any left-to-right ramp. Two such images are genuinely
    // indistinguishable to this descriptor, which is why the caller also
    // requires a checksum or an asset key before it merges anything.
    const a = square(ANALYSIS_SIZE, (x, y) => [(x * 37 + y * 11) % 256, 90, 140]);
    const b = square(ANALYSIS_SIZE, (x, y) => [(x * 13 + y * 53) % 256, 140, 90]);
    expect(visualSignature(a, ANALYSIS_SIZE)).not.toBe(visualSignature(b, ANALYSIS_SIZE));
  });
});
