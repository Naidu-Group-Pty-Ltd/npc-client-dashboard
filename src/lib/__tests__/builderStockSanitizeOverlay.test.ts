/**
 * Builder stock — taking the marketing sticker off, and refusing to when the
 * result would be a guess.
 *
 * These run the real detector and the real reconstruction over generated
 * pictures whose ground truth is known, so an assertion about "the badge is
 * gone" is an assertion about pixels rather than about a flag.
 */
import { describe, expect, it } from 'vitest';

import {
  overlayTextBoxes,
} from '../../../supabase/functions/_shared/builderStock/marketingOverlay.pure';
import {
  overlayPlateMask,
} from '../../../supabase/functions/_shared/builderStock/overlayPlate.pure';
import { withCaption, withPlate } from './fixtures/builderStockPictures';
import {
  sanitizeOverlay,
} from '../../../supabase/functions/_shared/builderStock/sanitizeOverlay.pure';
import {
  SANITIZATION_VERSION,
} from '../../../supabase/functions/_shared/builderStock/sanitizedDerivative.pure';

/**
 * A sky-like gradient with grain: the ground a badge is normally stuck onto.
 *
 * The grain is not decoration. A mathematically perfect gradient is smoother
 * than any photograph, and the detector's flood — which admits neighbours close
 * to the SEED — walks straight through it and claims the whole sky as one flat
 * region. Real sensor and render noise is what stops that, so the fixture has
 * to have some, deterministically.
 */
function sky(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3;
      const t = y / height;
      const grain = ((x * 29 + y * 71) % 13) - 6;
      pixels[at] = Math.max(0, Math.min(255, Math.round(120 + 90 * t + grain)));
      pixels[at + 1] = Math.max(0, Math.min(255, Math.round(160 + 70 * t + grain)));
      pixels[at + 2] = Math.max(0, Math.min(255, Math.round(210 + 40 * t + grain)));
    }
  }
  return pixels;
}

/** Busy foliage-like ground, where a reconstruction would be inventing. */
function foliage(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3;
      // Deterministic, high-frequency, and nothing like a gradient.
      const n = ((x * 37 + y * 61) % 97) + ((x * 13 + y * 7) % 53);
      pixels[at] = 40 + (n % 90);
      pixels[at + 1] = 70 + (n % 120);
      pixels[at + 2] = 30 + (n % 60);
    }
  }
  return pixels;
}

/** Stamp a flat coloured plate. */
function stamp(
  pixels: Uint8Array, width: number,
  box: { x: number; y: number; w: number; h: number }, colour: [number, number, number],
): void {
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      const at = (y * width + x) * 3;
      pixels[at] = colour[0];
      pixels[at + 1] = colour[1];
      pixels[at + 2] = colour[2];
    }
  }
}

/**
 * A badge: a plate with WORDS on it.
 *
 * The lettering is not decoration. The repair's mask is derived from the type
 * the classifier found — see `overlayPlate.pure.ts` — so a plate with nothing
 * written on it is, correctly, not something this may remove: a flat coloured
 * block is a black garage door as often as it is a sticker, and Lot 13 Hummock
 * Rise is the production case where the difference mattered.
 *
 * Drawn with the shared caption fixture, so what these tests stamp is the same
 * shape the classifier's own tests are written against.
 */
function badge(
  pixels: Uint8Array, width: number,
  box: { x: number; y: number; w: number; h: number },
  colour: [number, number, number] = [193, 255, 114],
): void {
  const plated = withPlate({ width, height: H, pixels }, box, colour);
  const scale = Math.max(1, Math.floor((box.h * 0.55) / 7));
  const captioned = withCaption(plated, 'SOLERA'.slice(0, Math.max(2,
    Math.floor((box.w - box.h * 0.5) / (6 * scale)))), {
    x: box.x + Math.round(box.h * 0.25),
    y: box.y + Math.round((box.h - 7 * scale) / 2),
    scale,
    ink: [10, 10, 10],
  });
  pixels.set(captioned.pixels);
}

const W = 400;
const H = 200;

/**
 * The mask the pipeline builds, on the same pixels.
 *
 * Derived from the TYPE the badge carries — see `overlayPlate.pure.ts` — which
 * is why every fixture below stamps lettering on its badge rather than a plain
 * rectangle. A plain coloured block is a garage door as often as it is a
 * sticker, and the repair may not remove one.
 */
const run = (pixels: Uint8Array) => {
  const plates = overlayPlateMask(
    { width: W, height: H, pixels }, overlayTextBoxes({ width: W, height: H, pixels }));
  return {
    plates,
    // Same size for mask and picture here: the scaling is exercised separately.
    result: sanitizeOverlay({
      width: W, height: H, pixels, mask: plates.mask, regions: plates.plates.length,
      maskWidth: W, maskHeight: H,
    }),
  };
};

describe('removing a marketing badge from the builder\'s own photograph', () => {
  it('leaves a clean picture completely alone', () => {
    const clean = sky(W, H);
    const { plates, result } = run(clean);

    expect(plates.plates).toHaveLength(0);
    // Not "cleaned to the same thing" — never touched at all.
    expect(result.ok).toBe(false);
    if (result.ok === true) return;
    expect(result.reason).toBe('nothing_to_remove');
  });

  it('removes a badge from open sky and leaves the rest byte-identical', () => {
    const original = sky(W, H);
    const badged = new Uint8Array(original);
    const box = { x: 20, y: 14, w: 96, h: 30 };
    badge(badged, W, box);

    const { plates, result } = run(badged);
    expect(plates.plates.length).toBeGreaterThan(0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The badge is gone: no pixel in its box is still the badge colour.
    for (let y = box.y; y < box.y + box.h; y++) {
      for (let x = box.x; x < box.x + box.w; x++) {
        const at = (y * W + x) * 3;
        const isBadge = result.pixels[at] === 180
          && result.pixels[at + 1] === 240 && result.pixels[at + 2] === 60;
        expect(isBadge).toBe(false);
      }
    }

    /*
     * And the photograph outside the repair is the builder's, to the byte.
     * This is the promise that makes the derivative honest: it is their picture
     * with a sticker taken off, not a picture of ours that resembles theirs.
     */
    const margin = 40;
    let compared = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const farFromBadge = x < box.x - margin || x > box.x + box.w + margin
          || y < box.y - margin || y > box.y + box.h + margin;
        if (!farFromBadge) continue;
        const at = (y * W + x) * 3;
        expect(result.pixels[at]).toBe(original[at]);
        expect(result.pixels[at + 1]).toBe(original[at + 1]);
        expect(result.pixels[at + 2]).toBe(original[at + 2]);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(1000);
  });

  it('reconstructs the sky it covered rather than filling it flat', () => {
    const original = sky(W, H);
    const badged = new Uint8Array(original);
    badge(badged, W, { x: 20, y: 14, w: 96, h: 30 });

    const { result } = run(badged);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The gradient continues through the patch: the top of the repaired area is
    // measurably darker than the bottom, as the sky above and below it are.
    const sample = (x: number, y: number) => result.pixels[(y * W + x) * 3];
    expect(sample(60, 40)).toBeGreaterThan(sample(60, 18));
  });

  it('REFUSES a badge lying across two very different colours', () => {
    /*
     * THE MEASURE THAT MATTERS, AND IT TOOK A BAD RENDER TO FIND IT.
     *
     * Laplace's equation interpolates between the boundary values, so a hole
     * whose ring is all one colour fills invisibly and a hole with two very
     * different colours on opposite sides fills with a RAMP between them — a
     * visible streak exactly the shape of the hole. Both rings can be locally
     * smooth, so the neighbour-difference test says nothing about it: on the
     * real bytes Lot 13 Hummock Rise scores 2.46 there and the Brownsplains
     * badge scores 3.18, and Lot 13 is the one that came out as two grey smears.
     * On the spread measure they are 41.8 and 22.0.
     */
    const split = sky(W, H);
    // A dark band across the lower half: sky above, something very dark below.
    for (let y = 60; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const at = (y * W + x) * 3;
        split[at] = 34; split[at + 1] = 30; split[at + 2] = 28;
      }
    }
    // The badge straddles the join.
    badge(split, W, { x: 40, y: 44, w: 120, h: 32 });

    const { result } = run(split);
    expect(result.ok).toBe(false);
    if (result.ok === true) return;
    expect(result.reason).toBe('background_too_detailed');
  });

  it('REFUSES a badge sitting on detail, rather than smearing it', () => {
    const busy = foliage(W, H);
    badge(busy, W, { x: 40, y: 40, w: 70, h: 26 });

    const { result } = run(busy);
    expect(result.ok).toBe(false);
    if (result.ok === true) return;
    expect(result.reason).toBe('background_too_detailed');
  });

  it('REFUSES a single hole too wide to fill', () => {
    const original = sky(W, H);
    const badged = new Uint8Array(original);
    // ONE plate covering more than a tenth of the frame: the distance from the
    // middle of that hole to the nearest real pixel is what makes a diffusion
    // read as a smear.
    badge(badged, W, { x: 40, y: 40, w: 300, h: 40 });

    const { result } = run(badged);
    expect(result.ok).toBe(false);
    if (result.ok === true) return;
    expect(result.reason).toBe('too_much_to_rebuild');
  });

  it('and does NOT refuse two small holes merely because they add up', () => {
    /*
     * THE FITTING ERROR THIS PINS. The cap was on the TOTAL, on the evidence
     * that Lot 13 Hummock Rise "covers 23% of the frame between its badges" —
     * and that 23% was measured against a mask since shown to be wrong, one
     * that included the house's black garage door and a patch of sky. Its two
     * real badges are 6.2% each. Two small holes at opposite ends of a
     * photograph are two small reconstructions; summing them describes neither.
     */
    const badged = sky(W, H);
    badge(badged, W, { x: 12, y: 14, w: 130, h: 34 });
    badge(badged, W, { x: 250, y: 14, w: 130, h: 34 });

    const { plates, result } = run(badged);
    expect(plates.plates.length).toBe(2);
    expect(result.ok).toBe(true);
  });

  it('is deterministic — the same picture always cleans to the same bytes', () => {
    const make = () => {
      const p = sky(W, H);
      badge(p, W, { x: 20, y: 14, w: 96, h: 30 });
      return p;
    };
    const a = run(make()).result;
    const b = run(make()).result;
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(Array.from(a.pixels)).toEqual(Array.from(b.pixels));
  });

  it('carries a version, so a better reconstruction can re-make what it stored', () => {
    expect(SANITIZATION_VERSION).toBeGreaterThanOrEqual(1);
  });
});
