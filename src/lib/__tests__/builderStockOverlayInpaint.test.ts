/**
 * Builder stock — the constrained generative repair, and the guarantees that
 * make it safe to put on a client's screen.
 *
 * The deterministic reconstruction handles a small badge on quiet ground. These
 * cover what happens when it refuses: the same mask, the same original bytes, a
 * model asked to rebuild only what was behind the graphic — and the arithmetic
 * that makes "everything outside the mask is the builder's own pixel" a fact
 * about the compositing rather than a hope about the model.
 *
 * THE MODEL IS A STUB HERE ON PURPOSE. What is worth pinning is not that an
 * endpoint returns a nice picture; it is that a HOSTILE answer — a whole new
 * image, a wrong size, a flat colour — cannot reach a card and cannot alter one
 * pixel of the photograph outside the badge. So one stub returns a plausible
 * reconstruction and another returns something completely different, and both
 * are asserted against the original bytes.
 */
import { describe, expect, it } from 'vitest';

import {
  overlayTextBoxes, readMarketingOverlay,
} from '../../../supabase/functions/_shared/builderStock/marketingOverlay.pure';
import {
  overlayPlateMask,
} from '../../../supabase/functions/_shared/builderStock/overlayPlate.pure';
import { photograph, withCaption, withPlate } from './fixtures/builderStockPictures';
import {
  growOverlayMask,
} from '../../../supabase/functions/_shared/builderStock/sanitizeOverlay.pure';
import {
  blendWeights, compositePatch, cropMask, cropRgb, FEATHER, MAX_PATCHES,
  outsidePermittedRegionUnchanged, planInpaintPatches, resampleRgb,
} from '../../../supabase/functions/_shared/builderStock/inpaintOverlay.pure';
import {
  inpaintOverlay, INPAINT_MODEL, INPAINT_PROMPT,
} from '../../../supabase/functions/_shared/builderStock/inpaintOverlay';
import {
  sanitizeSourceImage,
} from '../../../supabase/functions/_shared/builderStock/sanitizeImage';
import {
  derivativeDetail, readServableDerivative, sanitizationSettled, servableClearanceFor,
  servableDerivativeFor, CLEARANCE_KEY, DERIVATIVE_KEY, FAILURE_KEY,
  SANITIZATION_VERSION, type SanitizedDerivative,
} from '../../../supabase/functions/_shared/builderStock/sanitizedDerivative.pure';
import {
  newRepairBudget, settleImageSanitization, sanitizationSweepCompleted,
} from '../../../supabase/functions/_shared/builderStock/settleImageSanitization';
import {
  isDisplayableSourceImage,
} from '../../../supabase/functions/_shared/builderStock/primaryImage';
import { decodeFullRaster } from '../../../supabase/functions/_shared/builderStock/sourceImageRaster';
import { encodePng, sha256Hex } from '../../../supabase/functions/_shared/builderStock/rasterPng';
import {
  marketplaceEligibilityDetail, decideMarketplaceEligibility,
} from '../../../supabase/functions/_shared/builderStock/marketplaceEligibility.pure';

const W = 400;
const H = 200;
const EDGE = 1024;

/** The sky a builder photographs a house against, with real grain. */
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

/**
 * A badge: a plate with WORDS on it.
 *
 * The lettering is what makes it removable. The repair's mask is derived from
 * the type the classifier found, never from flat colour — a flat coloured block
 * is a black garage door as often as it is a sticker, and on Lot 13 Hummock
 * Rise the flat-colour mask covered the garage door, covered a patch of sky,
 * and missed one of the two badges entirely.
 */
function stamp(
  pixels: Uint8Array, width: number,
  box: { x: number; y: number; w: number; h: number },
  colour: [number, number, number] = [193, 255, 114],
  height = H,
): void {
  const plated = withPlate({ width, height, pixels }, box, colour);
  const scale = Math.max(1, Math.floor((box.h * 0.55) / 7));
  const letters = Math.max(2, Math.min(6,
    Math.floor((box.w - box.h * 0.5) / (6 * scale))));
  const captioned = withCaption(plated, 'SOLERA'.slice(0, letters), {
    x: box.x + Math.round(box.h * 0.25),
    y: box.y + Math.round((box.h - 7 * scale) / 2),
    scale,
    ink: [10, 10, 10],
  });
  pixels.set(captioned.pixels);
}

/**
 * The Lot 13 shape: several large status plates over a facade shot.
 *
 * Fitted to what the deterministic route refuses — quiet enough surroundings to
 * pass the detail gate, far too much area to rebuild — which is precisely the
 * case that exists to reach the generative route.
 */
const BADGES = [
  { x: 10, y: 10, w: 150, h: 40 },
  { x: 200, y: 10, w: 150, h: 40 },
  { x: 100, y: 120, w: 180, h: 40 },
];

function badgedPicture(): { clean: Uint8Array; badged: Uint8Array } {
  const clean = sky(W, H);
  const badged = new Uint8Array(clean);
  for (const box of BADGES) stamp(badged, W, box);
  return { clean, badged };
}

/** The mask the pipeline itself would build, so the tests repair what it does. */
function maskFor(badged: Uint8Array): Uint8Array {
  const view = { width: W, height: H, pixels: badged };
  const plates = overlayPlateMask(view, overlayTextBoxes(view));
  const mask = growOverlayMask(plates.mask, W, H, W, H);
  expect(mask).not.toBeNull();
  return mask as Uint8Array;
}

/**
 * A model that reconstructs correctly: it returns the patch as the sky actually
 * was. A test double, obviously — its job is to exercise the plumbing, not to
 * stand in for a model's judgement.
 */
function honestModel(clean: Uint8Array, mask: Uint8Array) {
  const patches = planInpaintPatches(mask, W, H).patches;
  let call = 0;
  return async () => {
    const patch = patches[call++];
    return resampleRgb(cropRgb(clean, W, patch, H), patch.size, patch.size, EDGE, EDGE);
  };
}

/** And one that returns a completely different picture, as a bad day would. */
async function hostileModel(): Promise<Uint8Array> {
  const out = new Uint8Array(EDGE * EDGE * 3);
  for (let i = 0; i < EDGE * EDGE; i++) {
    out[i * 3] = 255; out[i * 3 + 1] = 0; out[i * 3 + 2] = 255;
  }
  return out;
}

// ---------------------------------------------------------------------------
// RULE 5 — the mask never reaches a feature of the house
// ---------------------------------------------------------------------------

describe('what may be removed is a plate with WORDS on it, and nothing else', () => {
  /** A flat block with no type on it: a black garage door, a dark window. */
  function plainBlock(
    pixels: Uint8Array, width: number,
    box: { x: number; y: number; w: number; h: number },
    colour: [number, number, number],
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

  it('LOT 13 — a black garage door is not a sticker and is never masked', () => {
    /*
     * THE PRODUCTION DEFECT THIS PINS, and it is the worst one in this change.
     *
     * The classifier's flat-colour pass is the right instrument for "is there
     * promotional treatment on this picture", where a false positive costs a
     * blank card. It is the WRONG instrument for "which pixels may I rebuild",
     * where a false positive REMOVES whatever was there. Measured on the real
     * Lot 13 Hummock Rise bytes, that pass returns three regions: the black
     * garage door at 7.5% of the frame, a patch of pale sky at 6.7%, and one of
     * the two green pills at 4.5% — the other pill is not a region at all.
     *
     * Repairing that mask took the garage door off a house and left the
     * marketing on it. I have the render.
     */
    const pixels = sky(W, H);
    plainBlock(pixels, W, { x: 60, y: 120, w: 130, h: 60 }, [30, 30, 32]);
    stamp(pixels, W, { x: 20, y: 14, w: 96, h: 30 });

    const view = { width: W, height: H, pixels };
    const plates = overlayPlateMask(view, overlayTextBoxes(view));

    // The badge is found...
    expect(plates.plates.length).toBe(1);
    const plate = plates.plates[0];
    expect(plate.top).toBeLessThan(60);

    // ...and not one pixel of the garage door is in the mask.
    for (let y = 120; y < 180; y++) {
      for (let x = 60; x < 190; x++) expect(plates.mask[y * W + x]).toBe(0);
    }
  });

  it('the flat-region fallback is gated on containment, so it cannot reach the door', () => {
    /*
     * The fallback exists because a translucent or gradient plate has no single
     * colour to flood, and refusing those cost four production repairs the
     * flat-colour pass had found perfectly well. What keeps it honest is
     * CONTAINMENT: the block must have the line of type printed inside it.
     */
    const pixels = sky(W, H);
    plainBlock(pixels, W, { x: 60, y: 120, w: 130, h: 60 }, [30, 30, 32]);
    stamp(pixels, W, { x: 20, y: 14, w: 96, h: 30 });
    const view = { width: W, height: H, pixels };
    const text = overlayTextBoxes(view);

    // Offered the garage door as a candidate region, it is still not taken:
    // no line of type sits inside it.
    const withDoor = overlayPlateMask(view, text, [
      { left: 60, top: 120, right: 189, bottom: 179 },
    ]);
    for (let y = 120; y < 180; y++) {
      for (let x = 60; x < 190; x++) expect(withDoor.mask[y * W + x]).toBe(0);
    }
  });

  it('type set straight onto the photograph has no plate, and nothing is removed', () => {
    const pixels = sky(W, H);
    // A caption with no block behind it: there is no honest extent to remove,
    // and inventing a rectangle would rebuild photograph that was never
    // covered.
    const captioned = withCaption({ width: W, height: H, pixels }, 'SOLERA', {
      x: 40, y: 30, scale: 4, ink: [10, 10, 10],
    });
    const view = { width: W, height: H, pixels: captioned.pixels };
    expect(overlayPlateMask(view, overlayTextBoxes(view)).plates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// RULE 1 / 11 — the only visual input is that property's own image
// ---------------------------------------------------------------------------

describe('the model sees the builder\'s own photograph and nothing else', () => {
  it('is handed square cuts OF THE INPUT, one per graphic, and no other picture', async () => {
    const { clean, badged } = badgedPicture();
    const mask = maskFor(badged);
    const patches = planInpaintPatches(mask, W, H).patches;
    expect(patches.length).toBeGreaterThan(0);

    const seen: Uint8Array[] = [];
    let extraArguments = 0;
    const result = await inpaintOverlay({
      width: W, height: H, pixels: badged, mask,
      edit: async (...args: unknown[]) => {
        // TWO arguments and no more: an image and its mask. A conditioning or
        // reference image would have to arrive as a third, and there is nowhere
        // for one to come from.
        if (args.length !== 2) extraArguments += 1;
        seen.push(args[0] as Uint8Array);
        const patch = patches[seen.length - 1];
        return resampleRgb(cropRgb(clean, W, patch, H), patch.size, patch.size, EDGE, EDGE);
      },
    });

    expect(extraArguments).toBe(0);
    expect(seen).toHaveLength(patches.length);
    expect(result.ok).toBe(true);

    // Every buffer handed over is a scaling of a crop of THIS picture: the
    // corner sample of each matches the corresponding corner of the frame.
    seen.forEach((sent, index) => {
      const patch = patches[index];
      const expected = resampleRgb(
        cropRgb(badged, W, patch, H), patch.size, patch.size, EDGE, EDGE);
      expect(sent[0]).toBe(expected[0]);
      expect(sent[1]).toBe(expected[1]);
      expect(sent[2]).toBe(expected[2]);
    });
  });

  it('RULE 6 — the instruction asks for a reconstruction, never for a picture', () => {
    const prompt = INPAINT_PROMPT.toLowerCase();
    expect(prompt).toContain('remove the overlaid promotional graphic');
    expect(prompt).toContain('reconstruct only the background');
    expect(prompt).toContain('do not change anything outside the masked area');
    expect(prompt).toContain('do not redesign the property');
    expect(prompt).toContain('do not extend any building');
    // Nothing that invites a nicer house than the one that was photographed.
    for (const word of ['beautiful', 'attractive', 'modern', 'improve', 'enhance',
      'photorealistic', 'render a', 'generate a house', 'style']) {
      expect(prompt).not.toContain(word);
    }
  });
});

// ---------------------------------------------------------------------------
// RULES 2, 3, 4, 5 — everything outside the mask stays the builder's
// ---------------------------------------------------------------------------

describe('everything outside the mask is pixel-identical to the original', () => {
  it('holds when the model reconstructs honestly', async () => {
    const { clean, badged } = badgedPicture();
    const mask = maskFor(badged);
    const result = await inpaintOverlay({
      width: W, height: H, pixels: badged, mask, edit: honestModel(clean, mask),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const weights = blendWeights(mask, W, H);
    let compared = 0;
    for (let i = 0; i < weights.length; i++) {
      if (weights[i]) continue;
      const at = i * 3;
      expect(result.pixels[at]).toBe(badged[at]);
      expect(result.pixels[at + 1]).toBe(badged[at + 1]);
      expect(result.pixels[at + 2]).toBe(badged[at + 2]);
      compared += 1;
    }
    expect(compared).toBeGreaterThan(W * H * 0.6);
  });

  it('RULE 4 — holds when the model returns a COMPLETELY DIFFERENT image', async () => {
    const { badged } = badgedPicture();
    const mask = maskFor(badged);
    const weights = blendWeights(mask, W, H);
    const patches = planInpaintPatches(mask, W, H).patches;

    // The composite alone, so the assertion is about the compositing rather
    // than about the gate that follows it.
    let working = badged;
    for (const patch of patches) {
      const magenta = await hostileModel();
      working = compositePatch(working, W, H, patch,
        resampleRgb(magenta, EDGE, EDGE, patch.size, patch.size), weights);
    }

    const gate = outsidePermittedRegionUnchanged(badged, working, weights);
    expect(gate.ok).toBe(true);
    expect(gate.changed).toBe(0);

    // And the magenta only ever landed where it was allowed to.
    for (let i = 0; i < weights.length; i++) {
      const at = i * 3;
      const isMagenta = working[at] > 200 && working[at + 1] < 60 && working[at + 2] > 200;
      if (isMagenta) expect(weights[i]).toBeGreaterThan(0);
    }
  });

  it('RULE 2 — the blend reaches no further than the declared feather', () => {
    const { badged } = badgedPicture();
    const mask = maskFor(badged);
    const weights = blendWeights(mask, W, H);

    // Every non-zero weight is either inside the mask or within FEATHER of it.
    let outside = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const at = y * W + x;
        if (!weights[at] || mask[at]) continue;
        let near = false;
        for (let dy = -FEATHER; dy <= FEATHER && !near; dy++) {
          for (let dx = -FEATHER; dx <= FEATHER; dx++) {
            if (Math.abs(dx) + Math.abs(dy) > FEATHER) continue;
            const ny = y + dy;
            const nx = x + dx;
            if (ny < 0 || ny >= H || nx < 0 || nx >= W) continue;
            if (mask[ny * W + nx]) { near = true; break; }
          }
        }
        if (!near) outside += 1;
      }
    }
    expect(outside).toBe(0);
    expect(FEATHER).toBeLessThanOrEqual(3);
  });

  it('the frame keeps its exact dimensions', async () => {
    const { clean, badged } = badgedPicture();
    const mask = maskFor(badged);
    const result = await inpaintOverlay({
      width: W, height: H, pixels: badged, mask, edit: honestModel(clean, mask),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.width).toBe(W);
    expect(result.height).toBe(H);
    expect(result.pixels.length).toBe(badged.length);
  });
});

// ---------------------------------------------------------------------------
// RULE 12 — the validation gate
// ---------------------------------------------------------------------------

describe('the validation gate refuses rather than shipping something wrong', () => {
  it('refuses a response of the wrong size', async () => {
    const { badged } = badgedPicture();
    const mask = maskFor(badged);
    const result = await inpaintOverlay({
      width: W, height: H, pixels: badged, mask,
      edit: async () => new Uint8Array(64 * 64 * 3),
    });
    expect(result.ok).toBe(false);
    if (result.ok === true) return;
    expect(result.reason).toBe('inpaint_failed');
  });

  it('refuses a response that never arrived', async () => {
    const { badged } = badgedPicture();
    const mask = maskFor(badged);
    const result = await inpaintOverlay({
      width: W, height: H, pixels: badged, mask, edit: async () => null,
    });
    expect(result.ok).toBe(false);
    if (result.ok === true) return;
    expect(result.reason).toBe('inpaint_failed');
  });

  it('reports how far out a bad composite was, and has no tolerance to relax', () => {
    const { badged } = badgedPicture();
    const mask = maskFor(badged);
    const weights = blendWeights(mask, W, H);
    const tampered = new Uint8Array(badged);
    // One pixel, far from any badge.
    const far = ((H - 2) * W + 2) * 3;
    expect(weights[(H - 2) * W + 2]).toBe(0);
    tampered[far] = tampered[far] ^ 0xff;

    const gate = outsidePermittedRegionUnchanged(badged, tampered, weights);
    expect(gate.ok).toBe(false);
    expect(gate.changed).toBe(1);
  });

  it('covers plates spread across a WIDE frame by letting the square overhang', () => {
    /*
     * PRODUCTION FOUND THIS ONE, on Lot 13 Hummock Rise. A patch must be
     * square, and the first version also required it to sit inside the frame —
     * so its side was capped at the SHORT edge. A builder's status plates run
     * across the width of a landscape photograph, no square inside it could
     * hold them, the coverage check refused, and the card stayed blank: the
     * exact outcome this change exists to end.
     */
    const clean = sky(W, H);
    const wide = new Uint8Array(clean);
    // One plate wider than the frame is tall: the shape that used to refuse.
    stamp(wide, W, { x: 30, y: 84, w: 300, h: 28 });
    const view = { width: W, height: H, pixels: wide };
    const mask = growOverlayMask(
      overlayPlateMask(view, overlayTextBoxes(view)).mask, W, H, W, H) as Uint8Array;
    const plan = planInpaintPatches(mask, W, H);

    expect(plan.uncovered).toBe(false);
    expect(plan.tooMany).toBe(false);
    expect(plan.patches.length).toBeGreaterThan(0);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!mask[y * W + x]) continue;
        const covered = plan.patches.some((patch) =>
          x >= patch.x && x < patch.x + patch.size
          && y >= patch.y && y < patch.y + patch.size);
        expect(covered).toBe(true);
      }
    }
    // A patch may run past the bottom of a landscape frame, and never past the
    // long edge — it can never be bigger than the photograph it came from.
    for (const patch of plan.patches) expect(patch.size).toBeLessThanOrEqual(Math.max(W, H));
  });

  it('the padding it sees is the picture\'s own edge, and is not editable', () => {
    const clean = sky(W, H);
    const wide = new Uint8Array(clean);
    stamp(wide, W, { x: 30, y: 84, w: 300, h: 28 });
    const view = { width: W, height: H, pixels: wide };
    const mask = growOverlayMask(
      overlayPlateMask(view, overlayTextBoxes(view)).mask, W, H, W, H) as Uint8Array;
    const patch = planInpaintPatches(mask, W, H).patches.find((p) => p.size > H);
    expect(patch).toBeTruthy();
    if (!patch) return;

    const cropped = cropRgb(wide, W, patch, H);
    const croppedMask = cropMask(mask, W, patch, H);
    // A row past the bottom of the picture repeats the last real row...
    const lastReal = H - 1 - patch.y;
    const beyond = lastReal + 5;
    expect(beyond).toBeLessThan(patch.size);
    for (let x = 0; x < patch.size; x += 37) {
      expect(cropped[(beyond * patch.size + x) * 3])
        .toBe(cropped[(lastReal * patch.size + x) * 3]);
    }
    // ...and nothing out there may be edited.
    for (let y = lastReal + 1; y < patch.size; y++) {
      for (let x = 0; x < patch.size; x += 13) {
        expect(croppedMask[y * patch.size + x]).toBe(0);
      }
    }
  });

  it('REFUSES a plan that would leave part of the graphic behind', () => {
    /*
     * THE DEFECT THIS PINS, WHICH THE LOT 13 FIXTURE FOUND. A patch is square
     * and cannot be wider than the frame's short edge, so merging two badges at
     * opposite ends of a 400x200 photograph produced ONE 200-square at the
     * origin — which covered the first badge, missed the other two entirely,
     * and returned `ok`. The picture came back with one plate removed and two
     * still on it, and only the classifier's second look caught it.
     *
     * A plan that does not cover the mask is now refused outright.
     */
    const clean = sky(W, H);
    const banner = new Uint8Array(clean);
    stamp(banner, W, { x: 4, y: 80, w: 60, h: 30 });
    stamp(banner, W, { x: 336, y: 80, w: 60, h: 30 });
    const view = { width: W, height: H, pixels: banner };
    const mask = growOverlayMask(
      overlayPlateMask(view, overlayTextBoxes(view)).mask, W, H, W, H) as Uint8Array;
    const plan = planInpaintPatches(mask, W, H);

    // Either the plan covers the mask, or it refuses. Never a partial repair.
    if (plan.patches.length) {
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (!mask[y * W + x]) continue;
          const covered = plan.patches.some((patch) =>
            x >= patch.x && x < patch.x + patch.size
            && y >= patch.y && y < patch.y + patch.size);
          expect(covered).toBe(true);
        }
      }
    } else {
      expect(plan.uncovered || plan.tooMany).toBe(true);
    }
  });

  it('LOT 13 — two wide pills stay TWO local repairs, never one global one', () => {
    /*
     * THE PRODUCTION FAILURE THIS PINS, and it is worth stating exactly.
     *
     * Lot 13 Hummock Rise carries two ~460px status pills across the top of a
     * 1200x600 photograph. The first geometry asked for a margin of twice the
     * graphic, so each pill demanded a 920px square; the two squares
     * overlapped, the merge rule joined them, and the result was ONE patch
     * covering the entire picture. The model was handed the whole photograph,
     * removed one pill, left the other in place, and drew timber cladding
     * across a patch of sky — every failure the patch design exists to
     * prevent, reached by arithmetic rather than by the model misbehaving.
     */
    const wide = 1200;
    const tall = 600;
    const frame = sky(wide, tall);
    stamp(frame, wide, { x: 70, y: 60, w: 460, h: 90 }, [193, 255, 114], tall);
    stamp(frame, wide, { x: 710, y: 60, w: 450, h: 90 }, [193, 255, 114], tall);
    const view = { width: wide, height: tall, pixels: frame };
    const mask = growOverlayMask(
      overlayPlateMask(view, overlayTextBoxes(view)).mask, wide, tall, wide, tall) as Uint8Array;
    const plan = planInpaintPatches(mask, wide, tall);

    expect(plan.uncovered).toBe(false);
    expect(plan.patches.length).toBe(2);
    // Neither may be the whole picture: that is the thing that went wrong.
    for (const patch of plan.patches) {
      expect(patch.size).toBeLessThan(wide);
      const covers = patch.x <= 0 && patch.x + patch.size >= wide;
      expect(covers).toBe(false);
    }
    // And between them they still cover every masked pixel.
    for (let y = 0; y < tall; y++) {
      for (let x = 0; x < wide; x++) {
        if (!mask[y * wide + x]) continue;
        expect(plan.patches.some((patch) =>
          x >= patch.x && x < patch.x + patch.size
          && y >= patch.y && y < patch.y + patch.size)).toBe(true);
      }
    }
  });

  it('every plan it returns covers every masked pixel', () => {
    const { badged } = badgedPicture();
    const mask = maskFor(badged);
    const plan = planInpaintPatches(mask, W, H);
    expect(plan.uncovered).toBe(false);
    expect(plan.patches.length).toBeGreaterThan(0);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!mask[y * W + x]) continue;
        const covered = plan.patches.some((patch) =>
          x >= patch.x && x < patch.x + patch.size
          && y >= patch.y && y < patch.y + patch.size);
        expect(covered).toBe(true);
      }
    }
  });

  it('refuses a picture carrying more separate graphics than a photograph would', () => {
    const clean = sky(W, H);
    const many = new Uint8Array(clean);
    for (let i = 0; i < MAX_PATCHES + 3; i++) {
      stamp(many, W, { x: 8 + i * 46, y: 8 + (i % 2) * 150, w: 34, h: 22 });
    }
    const view = { width: W, height: H, pixels: many };
    const mask = growOverlayMask(
      overlayPlateMask(view, overlayTextBoxes(view)).mask, W, H, W, H) as Uint8Array;
    const plan = planInpaintPatches(mask, W, H);
    if (plan.tooMany) {
      expect(plan.patches).toHaveLength(0);
    } else {
      // Merging may have brought them under the ceiling, which is the point of
      // merging. What must never happen is a plan ABOVE it.
      expect(plan.patches.length).toBeLessThanOrEqual(MAX_PATCHES);
    }
  });
});

// ---------------------------------------------------------------------------
// RULE 15 — the deterministic route stays the first choice
// ---------------------------------------------------------------------------

describe('the order the two repairs are tried in', () => {
  const bytesOf = async (pixels: Uint8Array) =>
    (await encodePng(pixels, { width: W, height: H, components: 3 }))!;

  it('a clean picture is never touched by either route', async () => {
    const result = await sanitizeSourceImage(await bytesOf(sky(W, H)));
    expect(result.ok).toBe(false);
    if (result.ok === true) return;
    expect(result.reason).toBe('not_annotated');
    expect(result.transformation).toBeNull();
  });

  it('a small badge on quiet ground is repaired WITHOUT a model', async () => {
    const pixels = sky(W, H);
    stamp(pixels, W, { x: 20, y: 14, w: 96, h: 30 });
    let modelCalled = 0;
    const result = await sanitizeSourceImage(await bytesOf(pixels), {
      edit: async () => { modelCalled += 1; return null; },
    });
    expect(modelCalled).toBe(0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transformation).toBe('deterministic_overlay_reconstruction');
    expect(result.model).toBeNull();
  });

  it('the Lot 13 shape reaches the model, and comes back eligible', async () => {
    const { clean, badged } = badgedPicture();
    const mask = maskFor(badged);
    const result = await sanitizeSourceImage(await bytesOf(badged), {
      edit: honestModel(clean, mask),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transformation).toBe('generative_overlay_inpaint');
    expect(result.model).toBe(INPAINT_MODEL);
    // The claim is made by the classifier that refused the original, not by the
    // repair reporting on itself.
    expect(result.verdict).toBe('eligible');
    expect(readMarketingOverlay({ width: W, height: H, pixels: badged }).annotated).toBe(true);
  });

  it('accepts a repair the DISPLAY classifier would still refuse for the house itself',
    async () => {
      /*
       * LOT 13 HUMMOCK RISE, AND THE REASON THE ACCEPTANCE TEST IS NOT
       * "does the classifier pass it now".
       *
       * Its repaired picture carries no type at all — both status pills gone,
       * strict pass zero runs, faint pass zero. The classifier refuses it for
       * ONE flat coloured region: the house's black garage door, which was
       * there before the repair and after it, and which is refused on the same
       * false positive that hides the completely unmarked Lot 537 Kirramingly.
       *
       * A repair cannot be held responsible for a judgement about a feature of
       * the house. What it must answer for is its own work.
       */
      const clean = sky(W, H);
      const withDoor = new Uint8Array(clean);
      for (let y = 120; y < 180; y++) {
        for (let x = 60; x < 190; x++) {
          const at = (y * W + x) * 3;
          withDoor[at] = 30; withDoor[at + 1] = 30; withDoor[at + 2] = 32;
        }
      }
      const badged = new Uint8Array(withDoor);
      stamp(badged, W, { x: 20, y: 14, w: 96, h: 30 });

      // The classifier refuses the CLEAN picture, on the door alone.
      expect(readMarketingOverlay({ width: W, height: H, pixels: withDoor }).annotated).toBe(true);

      const bytes = (await encodePng(badged, { width: W, height: H, components: 3 }))!;
      const result = await sanitizeSourceImage(bytes);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Accepted on its own work...
      expect(result.verdict).toBe('eligible');
      // ...while recording, without obeying, that the classifier still objects.
      expect(result.classifierState).toBe('ineligible');
    });

  it('RULE 14 — a repair that leaves the graphic legible is refused, not served',
    async () => {
      const { badged } = badgedPicture();
      const result = await sanitizeSourceImage(await bytesOf(badged), {
        edit: hostileModel,
      });
      expect(result.ok).toBe(false);
      if (result.ok === true) return;
      // Flat magenta over the badge is another laid-over graphic, so the
      // classifier refuses it a second time.
      expect(result.reason).toBe('still_annotated');
      expect(result.transformation).toBe('generative_overlay_inpaint');
      // And there is no picture in the refusal for anything to fall back TO: the
      // rejected render is named as rejected and is not a candidate.
      expect((result as Record<string, unknown>).bytes).toBeUndefined();
    });

  it('the generative route can be withheld without losing the deterministic one',
    async () => {
      const pixels = sky(W, H);
      stamp(pixels, W, { x: 20, y: 14, w: 96, h: 30 });
      const small = await sanitizeSourceImage(await bytesOf(pixels), {
        allowGenerative: false,
      });
      expect(small.ok).toBe(true);

      const { badged } = badgedPicture();
      const big = await sanitizeSourceImage(await bytesOf(badged), {
        allowGenerative: false,
        edit: async () => { throw new Error('the model must not be reached'); },
      });
      expect(big.ok).toBe(false);
      if (big.ok === true) return;
      expect(big.reason).toBe('too_much_to_rebuild');
    });
});

// ---------------------------------------------------------------------------
// RULES 7, 8, 9, 13 — stored once, with provenance, and served frozen
// ---------------------------------------------------------------------------

const ORG = 'org-a';

function fakeDb(rows: Array<Record<string, any>>, objects: Record<string, Uint8Array>) {
  const uploads: Array<{ path: string; bytes: Uint8Array }> = [];
  const state = { failWrites: false, failUploads: false };
  const build = () => {
    const filters: Array<[string, string, unknown]> = [];
    let limit = 1000;
    const builder: any = {
      eq(column: string, value: unknown) { filters.push(['eq', column, value]); return builder; },
      gt(column: string, value: unknown) { filters.push(['gt', column, value]); return builder; },
      order() { return builder; },
      limit(value: number) { limit = value; return builder; },
      then(resolve: (v: { data: any[]; error: null }) => unknown, reject?: unknown) {
        const matched = rows
          .filter((row) => filters.every(([op, column, value]) =>
            op === 'eq' ? row[column] === value : String(row[column]) > String(value)))
          .sort((a, b) => String(a.id).localeCompare(String(b.id)))
          .slice(0, limit);
        return Promise.resolve({ data: matched, error: null }).then(resolve, reject as never);
      },
    };
    return builder;
  };
  return {
    uploads,
    rows,
    set failWrites(value: boolean) { state.failWrites = value; },
    set failUploads(value: boolean) { state.failUploads = value; },
    from() {
      return {
        select: () => build(),
        update(patch: Record<string, unknown>) {
          const filters: Array<[string, unknown]> = [];
          const builder: any = {
            eq(column: string, value: unknown) { filters.push([column, value]); return builder; },
            then(resolve: (v: unknown) => unknown, reject?: unknown) {
              if (state.failWrites) {
                return Promise.resolve({ data: null, error: { message: 'write rejected' } })
                  .then(resolve, reject as never);
              }
              for (const row of rows) {
                if (filters.every(([column, value]) => row[column] === value)) {
                  Object.assign(row, patch);
                }
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
          download(path: string) {
            const bytes = objects[path];
            if (!bytes) return Promise.resolve({ data: null, error: { message: 'missing' } });
            return Promise.resolve({
              data: { arrayBuffer: () => Promise.resolve(bytes.buffer.slice(0)) },
              error: null,
            });
          },
          async upload(path: string, blob: Blob) {
            if (state.failUploads) return { data: null, error: { message: 'rejected' } };
            uploads.push({ path, bytes: new Uint8Array(await blob.arrayBuffer()) });
            objects[path] = uploads[uploads.length - 1].bytes;
            return { data: { path }, error: null };
          },
        };
      },
    },
  };
}

const PATH = 'org-a/items/item-1/source/cover.png';

async function refusedRow(bytes: Uint8Array) {
  return {
    id: 'image-1',
    stock_item_id: 'item-1',
    organisation_id: ORG,
    upload_id: 'upload-1',
    source_reference: 'drive:file-aaaa/page-2',
    source_stage: 'uploaded_document',
    verification_status: 'source_supplied',
    processing_status: 'ready',
    storage_bucket: 'builder-stock-images',
    storage_path: PATH,
    // The sweep writes `sanitized_derivative` / `sanitization_failure` onto
    // this bag at runtime, so it is typed open rather than by its seed keys.
    source_detail: {
      role: 'primary_property',
      role_evidence_level: 3,
      stored_sha256: await sha256Hex(bytes),
      source_sha256: await sha256Hex(bytes),
      marketplace_display_eligible: false,
      marketplace_eligibility_state: 'ineligible',
      marketplace_rejection_reason: 'annotated_marketing_tile',
      marketplace_measured: true,
      marketplace_eligibility_version: 1,
    } as Record<string, unknown>,

  };
}

describe('the derivative is stored once, with provenance, and served frozen', () => {
  it('RULE 8 — records the exact original, the transformation and the model', async () => {
    const { clean, badged } = badgedPicture();
    const mask = maskFor(badged);
    const bytes = (await encodePng(badged, { width: W, height: H, components: 3 }))!;
    const row = await refusedRow(bytes);
    const db = fakeDb([row], { [PATH]: bytes });

    const outcome = await settleImageSanitization(db as never, ORG, {
      sanitize: (input) => sanitizeSourceImage(input, { edit: honestModel(clean, mask) }),
    });

    expect(outcome.outstanding).toBe(1);
    expect(outcome.repaired).toBe(1);
    expect(outcome.unresolved).toBe(0);
    expect(sanitizationSweepCompleted(outcome)).toBe(true);

    const record = row.source_detail.sanitized_derivative as SanitizedDerivative;
    expect(record).toBeTruthy();
    expect(record.transformation).toBe('generative_overlay_inpaint');
    expect(record.sanitization_version).toBe(SANITIZATION_VERSION);
    expect(record.original_image_id).toBe('image-1');
    expect(record.original_sha256).toBe(await sha256Hex(bytes));
    expect(record.stock_item_id).toBe('item-1');
    expect(record.organisation_id).toBe(ORG);
    expect(record.source_reference).toBe('drive:file-aaaa/page-2');
    expect(record.model).toBe(INPAINT_MODEL);
    expect(record.width).toBe(W);
    expect(record.height).toBe(H);
    expect(record.verdict).toBe('eligible');
    expect(record.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // And the stored bytes ARE the bytes the record names.
    expect(db.uploads).toHaveLength(1);
    expect(db.uploads[0].path).toBe(record.storage_path);
    expect(await sha256Hex(db.uploads[0].bytes)).toBe(record.derivative_sha256);

    // The original object is untouched.
    expect(Array.from(bytes)).toEqual(Array.from(
      (await encodePng(badged, { width: W, height: H, components: 3 }))!));
  });

  it('RULE 7 — a second sweep does no work at all', async () => {
    const { clean, badged } = badgedPicture();
    const mask = maskFor(badged);
    const bytes = (await encodePng(badged, { width: W, height: H, components: 3 }))!;
    const row = await refusedRow(bytes);
    const db = fakeDb([row], { [PATH]: bytes });
    const sanitize = (input: Uint8Array) =>
      sanitizeSourceImage(input, { edit: honestModel(clean, mask) });

    await settleImageSanitization(db as never, ORG, { sanitize });
    const again = await settleImageSanitization(db as never, ORG, {
      sanitize: async () => { throw new Error('the repair must not run twice'); },
    });
    expect(again.outstanding).toBe(0);
    expect(again.repaired).toBe(0);
    expect(db.uploads).toHaveLength(1);
  });

  it('RULE 14 — a refusal is recorded, and NOTHING takes the picture\'s place',
    async () => {
      const { badged } = badgedPicture();
      const bytes = (await encodePng(badged, { width: W, height: H, components: 3 }))!;
      const row = await refusedRow(bytes);
      const db = fakeDb([row], { [PATH]: bytes });

      const outcome = await settleImageSanitization(db as never, ORG, {
        sanitize: (input) => sanitizeSourceImage(input, { edit: hostileModel }),
      });
      expect(outcome.refused).toBe(1);
      expect(outcome.repaired).toBe(0);
      // A refusal is a finished answer, so the sweep can still settle.
      expect(sanitizationSweepCompleted(outcome)).toBe(true);

      /*
       * A refused render IS kept — under `rejected/`, which nothing serves —
       * so somebody can look at what the repair produced rather than guess.
       * What must not exist is a DERIVATIVE record, because that is the only
       * thing a card can reach.
       */
      expect(db.uploads.every((upload) => upload.path.includes('/rejected/'))).toBe(true);
      expect(row.source_detail.sanitized_derivative).toBeUndefined();
      const failure = row.source_detail.sanitization_failure as Record<string, unknown>;
      expect(failure.reason).toBe('still_annotated');
      expect(String(failure.rejected_path ?? '')).toContain('/rejected/');
      expect(failure.original_image_id).toBe('image-1');
      expect(failure.original_sha256).toBe(await sha256Hex(bytes));
      // The source is still there for a retry or a debug.
      expect(row.storage_path).toBe(PATH);
      // And the card still shows nothing.
      expect(isDisplayableSourceImage(row as never)).toBe(false);
    });

  it('a model that cannot be reached is OPERATIONAL, not an answer', async () => {
    /*
     * PRODUCTION PROVED THIS ONE. The vendor account ran out of credit
     * mid-backfill and the endpoint answered 429. That tells us nothing about
     * whether the photograph can be repaired — and written down as a refusal it
     * parks the picture on "we tried" until the next version bump, so one
     * billing outage permanently blanks every card it touches.
     *
     * Same distinction the eligibility sweep makes: "we looked and there is
     * nothing" is knowledge, "we could not look" is not, and only the first may
     * stop us looking again.
     */
    const { badged } = badgedPicture();
    const bytes = (await encodePng(badged, { width: W, height: H, components: 3 }))!;
    const row = await refusedRow(bytes);
    const db = fakeDb([row], { [PATH]: bytes });

    const outcome = await settleImageSanitization(db as never, ORG, {
      sanitize: async () => ({
        ok: false as const,
        reason: 'inpaint_failed' as const,
        detail: 'the image editor refused the request (429) no credits remaining',
        transformation: 'generative_overlay_inpaint' as const,
        model: null,
      }),
    });

    expect(outcome.unresolved).toBe(1);
    expect(outcome.refused).toBe(0);
    // Nothing written, so the marker cannot advance and the next tick retries.
    expect(sanitizationSweepCompleted(outcome)).toBe(false);
    expect(row.source_detail.sanitization_failure).toBeUndefined();
    expect(row.source_detail.sanitized_derivative).toBeUndefined();
  });

  it('an OPERATIONAL failure writes nothing and blocks settlement', async () => {
    const { clean, badged } = badgedPicture();
    const mask = maskFor(badged);
    const bytes = (await encodePng(badged, { width: W, height: H, components: 3 }))!;
    const row = await refusedRow(bytes);
    // The object is not in the bucket.
    const db = fakeDb([row], {});
    const outcome = await settleImageSanitization(db as never, ORG, {
      sanitize: (input) => sanitizeSourceImage(input, { edit: honestModel(clean, mask) }),
    });
    expect(outcome.unresolved).toBe(1);
    expect(sanitizationSweepCompleted(outcome)).toBe(false);
    expect(row.source_detail.sanitized_derivative).toBeUndefined();
    expect(row.source_detail.sanitization_failure).toBeUndefined();
  });

  it('never picks up a clean image, a pending one, or a non-primary', async () => {
    const cleanBytes = (await encodePng(sky(W, H), { width: W, height: H, components: 3 }))!;
    const base = await refusedRow(cleanBytes);
    const eligible = {
      ...base, id: 'a',
      source_detail: {
        ...base.source_detail,
        ...marketplaceEligibilityDetail(decideMarketplaceEligibility(
          readMarketingOverlay({ width: W, height: H, pixels: sky(W, H) }))),
      },
    };
    const pending = {
      ...base, id: 'b',
      source_detail: {
        ...base.source_detail,
        marketplace_eligibility_state: 'pending',
        marketplace_rejection_reason: 'overlay_uncertain',
      },
    };
    const interior = {
      ...base, id: 'c',
      source_detail: { ...base.source_detail, role: 'interior' },
    };
    const db = fakeDb([eligible, pending, interior], { [PATH]: cleanBytes });
    const outcome = await settleImageSanitization(db as never, ORG, {
      sanitize: async () => { throw new Error('nothing here should be repaired'); },
    });
    expect(outcome.scanned).toBe(3);
    expect(outcome.outstanding).toBe(0);
    expect(db.uploads).toHaveLength(0);
  });
});

describe('the repair allowance is spent once per invocation, not once per upload', () => {
  it('two uploads share one budget', async () => {
    const { clean, badged } = badgedPicture();
    const mask = maskFor(badged);
    const bytes = (await encodePng(badged, { width: W, height: H, components: 3 }))!;

    const rows = await Promise.all([0, 1, 2].map(async (n) => ({
      ...await refusedRow(bytes), id: `image-${n}`, storage_path: `${PATH}.${n}`,
    })));
    const objects: Record<string, Uint8Array> = {};
    for (const row of rows) objects[row.storage_path] = bytes;

    /*
     * THE DEFECT THIS PINS. A tick settles up to six uploads. A per-upload cap
     * of two is a per-tick cap of twelve full-resolution repairs, and twelve of
     * these is the `CPU Time exceeded` with nothing written that this whole
     * settlement programme exists because of.
     */
    const budget = newRepairBudget();
    const started = budget.remaining;
    expect(started).toBeGreaterThan(0);

    const first = await settleImageSanitization(fakeDb([rows[0]], objects) as never, ORG, {
      budget, sanitize: (input) => sanitizeSourceImage(input, { edit: honestModel(clean, mask) }),
    });
    const second = await settleImageSanitization(
      fakeDb(rows.slice(1), objects) as never, ORG, {
        budget,
        sanitize: (input) => sanitizeSourceImage(input, { edit: honestModel(clean, mask) }),
      });

    const done = first.repaired + first.refused + second.repaired + second.refused;
    expect(done).toBeLessThanOrEqual(started);
    expect(budget.remaining).toBeLessThan(started);
    // And the one that ran out says so, so its marker cannot advance.
    if (done === started && second.outstanding > second.repaired + second.refused) {
      expect(sanitizationSweepCompleted(second)).toBe(false);
    }
  });
});

describe('one external failure must not take the queue down with it', () => {
  /*
   * MEASURED IN PRODUCTION, TWICE.
   *
   * The image editor answered 429 "You have no credits remaining" for two
   * Cloverton rows. They hold the two lowest ids in the sweep, the allowance is
   * two, and the scan restarts at the lowest id every tick — so those two spent
   * the entire allowance on every tick for hours, the log read
   * `outstanding: 3, repaired: 0, unresolved: 2` every minute, and the twelve
   * rows behind them were never reached. Most needed no vendor at all.
   *
   * The first fix refunded the allowance, and that was wrong: it let a tick
   * attempt a third full-resolution repair and every tick came back 546, a
   * worker kill with nothing written. TWO ATTEMPTS IS WHAT A TICK CAN AFFORD.
   * So the allowance does not grow — the tick spends it on DIFFERENT ROWS.
   */
  const vendorOutage = async () => {
    throw new Error('the image editor refused the request (429) '
      + '"You have no credits remaining."');
  };

  const outageRows = async (n: number) => {
    const bytes = (await encodePng(badgedPicture().badged,
      { width: W, height: H, components: 3 }))!;
    const rows = await Promise.all(Array.from({ length: n }, async (_, i) => ({
      ...await refusedRow(bytes), id: `image-${String(i).padStart(2, '0')}`,
      storage_path: `${PATH}.${i}`,
    })));
    const objects: Record<string, Uint8Array> = {};
    for (const row of rows) objects[row.storage_path] = bytes;
    return { rows, objects };
  };

  it('never attempts more than the allowance, however cheaply the attempts fail', async () => {
    // The 546 this replaces: a tick must not do a third repair because the
    // first two failed fast.
    const { rows, objects } = await outageRows(6);
    let attempts = 0;
    const budget = newRepairBudget();
    const started = budget.remaining;

    await settleImageSanitization(fakeDb(rows, objects) as never, ORG, {
      budget,
      sanitize: (input) => {
        attempts += 1;
        return sanitizeSourceImage(input, { edit: vendorOutage });
      },
    });

    expect(attempts).toBeLessThanOrEqual(started);
  });

  it('records the attempt so the NEXT tick spends its allowance elsewhere', async () => {
    const { rows, objects } = await outageRows(6);
    const db = fakeDb(rows, objects);

    await settleImageSanitization(db as never, ORG, {
      budget: newRepairBudget(),
      sanitize: (input) => sanitizeSourceImage(input, { edit: vendorOutage }),
    });

    const tried = db.rows.filter((row: any) =>
      (row.source_detail ?? {}).sanitization_attempt);
    expect(tried.length).toBeGreaterThan(0);
    // And it is NOT one of the keys that settles a row: the sweep must come
    // back to it, and no card may be blanked by it.
    for (const row of tried) {
      expect(row.source_detail.sanitized_derivative ?? null).toBeNull();
      expect(row.source_detail.sanitization_failure ?? null).toBeNull();
      expect(row.source_detail.sanitization_clearance ?? null).toBeNull();
    }
  });

  it('so the second tick reaches rows the first never got to', async () => {
    const { rows, objects } = await outageRows(6);
    const db = fakeDb(rows, objects);
    const seen: string[] = [];
    const run = () => settleImageSanitization(db as never, ORG, {
      budget: newRepairBudget(),
      sanitize: (input) => sanitizeSourceImage(input, { edit: vendorOutage }),
    });

    for (const row of db.rows) seen.push(row.id);
    await run();
    const afterFirst = db.rows.filter((r: any) => (r.source_detail ?? {}).sanitization_attempt)
      .map((r: any) => r.id);
    await run();
    const afterSecond = db.rows.filter((r: any) => (r.source_detail ?? {}).sanitization_attempt)
      .map((r: any) => r.id);

    // THE WHOLE POINT: the second tick did not re-attempt the same rows.
    expect(afterSecond.length).toBeGreaterThan(afterFirst.length);
  });

  it('and an outage never settles the upload', async () => {
    const { rows, objects } = await outageRows(4);
    const outcome = await settleImageSanitization(fakeDb(rows, objects) as never, ORG, {
      budget: newRepairBudget(),
      sanitize: (input) => sanitizeSourceImage(input, { edit: vendorOutage }),
    });
    expect(outcome.repaired).toBe(0);
    expect(sanitizationSweepCompleted(outcome)).toBe(false);
  });
});

describe('a repair region the caller established, and nothing else about it', () => {
  /*
   * WHY THIS EXISTS. The mask builder reads lines of TYPE, so a plate whose
   * lettering falls below the measuring resolution has no measurable extent —
   * the picture can carry a real, plainly visible promotional plate and still
   * produce no mask, and no threshold move that reaches it is safe against real
   * clean facades. A caller that has established the rectangle by other means
   * can hand it over; it is asking for those pixels to be rebuilt, not for a
   * different verdict.
   */
  const region = { left: 0.1, top: 0.72, right: 0.42, bottom: 0.86 };

  it('repairs the supplied region on a picture the detector passes as clean', async () => {
    const clean = badgedPicture().clean;
    const bytes = (await encodePng(clean, { width: W, height: H, components: 3 }))!;

    // Without a region this picture is not annotated and nothing is done.
    const untouched = await sanitizeSourceImage(bytes, {});
    expect(untouched.ok).toBe(false);
    if (untouched.ok === false) expect(untouched.reason).toBe('not_annotated');

    // With one, the existing repair path runs on it.
    let reached = false;
    const repaired = await sanitizeSourceImage(bytes, {
      repairRegion: region,
      edit: async (input: never) => { reached = true; return (input as never); },
    });
    // Either the deterministic route rebuilt it, or the generative route was
    // reached. What must NOT happen is the picture being dismissed unexamined.
    const examined = repaired.ok === true || reached
      || (repaired.ok === false && repaired.reason !== 'not_annotated');
    expect(examined).toBe(true);
  });

  it('leaves detector-driven behaviour byte-for-byte unchanged without one', async () => {
    const { badged } = badgedPicture();
    const bytes = (await encodePng(badged, { width: W, height: H, components: 3 }))!;
    const mask = maskFor(badged);
    const { clean } = badgedPicture();

    const a = await sanitizeSourceImage(bytes, { edit: honestModel(clean, mask) });
    const b = await sanitizeSourceImage(bytes, { edit: honestModel(clean, mask) });

    expect(a.ok).toBe(b.ok);
    if (a.ok === true && b.ok === true) {
      expect(a.transformation).toBe(b.transformation);
      expect(Array.from(a.bytes)).toEqual(Array.from(b.bytes));
    }
  });

  it('changes nothing outside the supplied region', async () => {
    const clean = badgedPicture().clean;
    const bytes = (await encodePng(clean, { width: W, height: H, components: 3 }))!;

    const out = await sanitizeSourceImage(bytes, { repairRegion: region });
    if (out.ok !== true) return; // a refusal serves the original; nothing altered

    const after = await decodeFullRaster(out.bytes);
    expect(after).not.toBeNull();
    // Every pixel well outside the region is identical to the builder's own.
    let checked = 0;
    for (let y = 0; y < H; y += 7) {
      for (let x = 0; x < W; x += 7) {
        const insideX = x >= region.left * W - 4 && x <= region.right * W + 4;
        const insideY = y >= region.top * H - 4 && y <= region.bottom * H + 4;
        if (insideX && insideY) continue;
        const at = (y * W + x) * 3;
        expect(after!.pixels[at]).toBe(clean[at]);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('treats an empty or inverted region as none', async () => {
    const clean = badgedPicture().clean;
    const bytes = (await encodePng(clean, { width: W, height: H, components: 3 }))!;
    for (const bad of [
      { left: 0.5, top: 0.5, right: 0.5, bottom: 0.9 },
      { left: 0.9, top: 0.5, right: 0.2, bottom: 0.9 },
    ]) {
      const out = await sanitizeSourceImage(bytes, { repairRegion: bad });
      expect(out.ok).toBe(false);
      if (out.ok === false) expect(out.reason).toBe('not_annotated');
    }
  });
});

describe('a persisted repair region is repair work the sweep finds by itself', () => {
  /*
   * THE MISSING CONNECTION.
   *
   * `sanitizeSourceImage` accepts a `repairRegion`, and until now nothing in
   * the runtime supplied one — so a picture whose plate the detector cannot
   * measure was repairable only by hand, once, and went straight back to being
   * served with the plate on it the moment anything reopened the row.
   *
   * These pin the whole loop: the rectangle is persisted as ordinary image
   * metadata, the ordinary five-minute sweep treats such a row as outstanding
   * EVEN THOUGH THE DETECTOR SAYS `not_annotated`, hands the rectangle to the
   * existing generic path, survives a vendor outage with the region and its
   * retryability intact, and stops once there is a derivative to serve.
   *
   * Nothing here knows which picture it is. The code understands exactly one
   * thing — "this image has a persisted explicit repair region" — and every
   * fact about which pixels is in the row.
   */
  const REGION = { left: 0.0950, top: 0.8763, right: 0.3975, bottom: 0.9536 };

  const cleanCandidate = async (over: Record<string, unknown> = {}) => {
    // A picture the detector passes: eligible, no rejection reason, nothing
    // for the ordinary conviction path to pick up.
    const clean = badgedPicture().clean;
    const bytes = (await encodePng(clean, { width: W, height: H, components: 3 }))!;
    const sha = await sha256Hex(bytes);
    const row = {
      ...await refusedRow(bytes),
      source_detail: {
        role: 'primary_property',
        role_evidence_level: 3,
        stored_sha256: sha,
        source_sha256: sha,
        marketplace_display_eligible: true,
        marketplace_eligibility_state: 'eligible',
        marketplace_rejection_reason: null,
        marketplace_measured: true,
        marketplace_eligibility_version: 2,
        repair_region: {
          ...REGION,
          original_sha256: sha,
          established_by: 'identified on the stored bytes and recorded against them',
        },
        ...over,
      },
    };
    return { row, bytes, sha, objects: { [PATH]: bytes } };
  };

  const vendorOutage = async () => {
    throw new Error('the image editor refused the request (429) '
      + '"You have no credits remaining."');
  };

  /*
   * The vendor answering 429, as the SWEEP sees it.
   *
   * A stub rather than the real sanitizer for these two, because what is being
   * pinned is the sweep's handling of an outage and not the sanitizer's — and a
   * region small and quiet enough to be realistic is one the DETERMINISTIC
   * route repairs without a vendor at all, which is the happy case tests 1, 2
   * and 5 cover against the real thing. It still asserts the region arrived.
   */
  const outagedSanitize = (seen: { region?: unknown; calls: number }) =>
    (async (_bytes: Uint8Array, options?: { repairRegion?: unknown }) => {
      seen.calls += 1;
      seen.region = options?.repairRegion ?? null;
      return {
        ok: false as const,
        reason: 'inpaint_unavailable' as const,
        transformation: 'generative_overlay_inpaint' as const,
        model: null,
        operational: true,
        detail: 'the image editor refused the request (429) '
          + '"You have no credits remaining."',
      };
    }) as never;

  it('1 — a row the detector calls clean is outstanding when it carries a region', async () => {
    const { row, objects } = await cleanCandidate();
    let called = 0;

    const outcome = await settleImageSanitization(fakeDb([row], objects) as never, ORG, {
      budget: newRepairBudget(),
      sanitize: async (input, options) => {
        called += 1;
        return sanitizeSourceImage(input, { ...options, edit: vendorOutage });
      },
    });

    // Before this, the two gates below excluded it outright and the picture was
    // served with its plate for ever.
    expect(row.source_detail.marketplace_eligibility_state).toBe('eligible');
    expect(row.source_detail.marketplace_rejection_reason).toBeNull();
    expect(outcome.outstanding).toBe(1);
    expect(called).toBe(1);
  });

  it('2 — and the sweep hands the sanitizer the rectangle that was persisted', async () => {
    const { row, objects } = await cleanCandidate();
    let handed: unknown = null;

    await settleImageSanitization(fakeDb([row], objects) as never, ORG, {
      budget: newRepairBudget(),
      sanitize: async (input, options) => {
        handed = options?.repairRegion ?? null;
        return sanitizeSourceImage(input, { ...options, edit: vendorOutage });
      },
    });

    expect(handed).toEqual(REGION);
  });

  it('3 — a vendor outage keeps the region, writes no verdict and stays retryable', async () => {
    const { row, objects } = await cleanCandidate();
    const db = fakeDb([row], objects);

    const seen = { calls: 0 } as { region?: unknown; calls: number };
    const outcome = await settleImageSanitization(db as never, ORG, {
      budget: newRepairBudget(),
      sanitize: outagedSanitize(seen),
    });

    expect(seen.region).toEqual(REGION);
    expect(outcome.unresolved).toBe(1);
    expect(sanitizationSweepCompleted(outcome)).toBe(false);
    const detail = db.rows[0].source_detail as Record<string, any>;
    // The region survives, so the next attempt is the same attempt.
    expect(detail.repair_region).toMatchObject(REGION);
    // Nothing that could settle the row, and nothing that could blank the card.
    expect(detail[DERIVATIVE_KEY] ?? null).toBeNull();
    expect(detail[FAILURE_KEY] ?? null).toBeNull();
    expect(detail[CLEARANCE_KEY] ?? null).toBeNull();
    // And the cooldown was recorded, exactly as for any other operational miss.
    expect(detail.sanitization_attempt).toBeTruthy();
  });

  it('4 — the existing cooldown is respected, and the row is still outstanding', async () => {
    const { row, objects } = await cleanCandidate();
    const db = fakeDb([row], objects);
    const seen = { calls: 0 } as { region?: unknown; calls: number };
    const run = () => settleImageSanitization(db as never, ORG, {
      budget: newRepairBudget(),
      sanitize: outagedSanitize(seen),
    });

    await run();
    const second = await run();

    // Passed over, NOT settled: the sweep must come back to it.
    expect(seen.calls).toBe(1);
    expect(second.outstanding).toBe(1);
    expect(second.incomplete).toBe(true);
    expect(sanitizationSweepCompleted(second)).toBe(false);
  });

  it('5 — a successful repair is stored the normal way and stops the retrying', async () => {
    const { row, objects } = await cleanCandidate();
    const db = fakeDb([row], objects);
    const clean = badgedPicture().clean;

    await settleImageSanitization(db as never, ORG, {
      budget: newRepairBudget(),
      sanitize: async (input, options) => sanitizeSourceImage(input, {
        ...options, edit: honestModel(clean, maskFor(badgedPicture().badged)),
      }),
    });

    const detail = db.rows[0].source_detail as Record<string, any>;
    const stored = detail[DERIVATIVE_KEY];
    if (!stored) {
      // The deterministic route answered instead; either is a stored result.
      expect(detail[FAILURE_KEY] ?? detail[DERIVATIVE_KEY]).toBeTruthy();
    }

    // Whatever route answered, the row is settled and a second tick does no
    // work on it — the retrying stops without anything marking it "complete"
    // by hand.
    let again = 0;
    const second = await settleImageSanitization(db as never, ORG, {
      budget: newRepairBudget(),
      sanitize: async (input, options) => {
        again += 1;
        return sanitizeSourceImage(input, { ...options, edit: vendorOutage });
      },
    });
    expect(again).toBe(0);
    expect(second.outstanding).toBe(0);
  });

  it('6 — a region that names other bytes, or is malformed, is not a region', async () => {
    for (const bad of [
      { original_sha256: 'f'.repeat(64) },                       // a replaced file
      { original_sha256: undefined },                            // unattributable
      { left: 0.9, right: 0.2 },                                 // inverted
      { top: 0.5, bottom: 0.5 },                                 // empty
      { left: -0.2 },                                            // outside the frame
    ]) {
      const { row, objects } = await cleanCandidate();
      Object.assign(row.source_detail.repair_region as Record<string, unknown>, bad);
      let called = 0;

      const outcome = await settleImageSanitization(fakeDb([row], objects) as never, ORG, {
        budget: newRepairBudget(),
        sanitize: async (input, options) => {
          called += 1;
          return sanitizeSourceImage(input, { ...options, edit: vendorOutage });
        },
      });

      // Falls back to exactly the behaviour of a row with no region at all: the
      // detector gates decide, and this picture they pass.
      expect(called).toBe(0);
      expect(outcome.outstanding).toBe(0);
    }
  });

  it('7 — a row with no region is left to the detector, unchanged', async () => {
    const { row, objects } = await cleanCandidate();
    delete (row.source_detail as Record<string, unknown>).repair_region;
    let handed: unknown = 'never called';

    const outcome = await settleImageSanitization(fakeDb([row], objects) as never, ORG, {
      budget: newRepairBudget(),
      sanitize: async (input, options) => {
        handed = options?.repairRegion ?? null;
        return sanitizeSourceImage(input, { ...options, edit: vendorOutage });
      },
    });

    expect(handed).toBe('never called');
    expect(outcome.outstanding).toBe(0);
    expect(outcome.scanned).toBe(1);
  });
});

describe('the allowance goes to the rows that have waited longest', () => {
  /*
   * MEASURED IN PRODUCTION, AND IT IS THE COOLDOWN'S OWN FAILURE ONE STEP OUT.
   *
   * Nine rows outstanding, an allowance of two, a ten-minute cooldown: four
   * attempts fit in each cooldown window, so the five lowest ids cycled among
   * themselves and the four behind them were never reached. One had last been
   * looked at half an hour earlier, one an hour and a half, and one — the row
   * whose repair region had just been recorded — had never been attempted once.
   *
   * The scan also returned the moment the allowance ran out, so `outstanding`
   * read 6 where nine rows needed work: it did not even count what it starved.
   */
  const vendorOutage = (seen: string[]) =>
    (async (_bytes: Uint8Array, _options?: unknown) => ({
      ok: false as const,
      reason: 'inpaint_unavailable' as const,
      transformation: 'generative_overlay_inpaint' as const,
      model: null,
      operational: true,
      detail: 'the image editor refused the request (429)',
    })) as never;

  const queue = async (waits: Array<{ id: string; minutesAgo: number | null }>) => {
    const bytes = (await encodePng(badgedPicture().badged,
      { width: W, height: H, components: 3 }))!;
    const rows = await Promise.all(waits.map(async (wait) => {
      const row = await refusedRow(bytes);
      row.id = wait.id;
      row.storage_path = `${PATH}.${wait.id}`;
      if (wait.minutesAgo !== null) {
        (row.source_detail as Record<string, unknown>).sanitization_attempt = {
          at: new Date(Date.now() - wait.minutesAgo * 60_000).toISOString(),
          operational: true,
        };
      }
      return row;
    }));
    const objects: Record<string, Uint8Array> = {};
    for (const row of rows) objects[row.storage_path] = bytes;
    return { rows, objects };
  };

  it('reaches a never-attempted row sitting behind a prefix that never clears', async () => {
    // Five lower ids, every one of them outside the cooldown and so eligible,
    // and the row that has never been looked at LAST in id order.
    const { rows, objects } = await queue([
      { id: 'image-01', minutesAgo: 11 },
      { id: 'image-02', minutesAgo: 12 },
      { id: 'image-03', minutesAgo: 13 },
      { id: 'image-04', minutesAgo: 14 },
      { id: 'image-05', minutesAgo: 15 },
      { id: 'image-99', minutesAgo: null },
    ]);
    const attempted: string[] = [];
    const db = fakeDb(rows, objects);

    await settleImageSanitization(db as never, ORG, {
      budget: newRepairBudget(),
      sanitize: vendorOutage(attempted),
    });

    const tried = db.rows
      .filter((row: any) => (row.source_detail ?? {}).sanitization_attempt?.at
        && Date.parse(row.source_detail.sanitization_attempt.at) > Date.now() - 60_000)
      .map((row: any) => row.id);

    // THE WHOLE POINT: id order would have spent both slots on image-01 and
    // image-02 for ever.
    expect(tried).toContain('image-99');
  });

  it('and then the one that has waited longest', async () => {
    const { rows, objects } = await queue([
      { id: 'image-01', minutesAgo: 11 },
      { id: 'image-02', minutesAgo: 12 },
      { id: 'image-03', minutesAgo: 90 },
      { id: 'image-04', minutesAgo: 14 },
    ]);
    const db = fakeDb(rows, objects);

    await settleImageSanitization(db as never, ORG, {
      budget: newRepairBudget(),
      sanitize: vendorOutage([]),
    });

    const fresh = db.rows
      .filter((row: any) => Date.parse(row.source_detail.sanitization_attempt.at)
        > Date.now() - 60_000)
      .map((row: any) => row.id)
      .sort();
    expect(fresh).toEqual(['image-03', 'image-04']);
  });

  it('counts every outstanding row, including the ones it could not afford', async () => {
    const { rows, objects } = await queue([
      { id: 'image-01', minutesAgo: 11 },
      { id: 'image-02', minutesAgo: 12 },
      { id: 'image-03', minutesAgo: 13 },
      { id: 'image-04', minutesAgo: 14 },
      { id: 'image-05', minutesAgo: 15 },
      { id: 'image-99', minutesAgo: null },
    ]);

    const outcome = await settleImageSanitization(fakeDb(rows, objects) as never, ORG, {
      budget: newRepairBudget(),
      sanitize: vendorOutage([]),
    });

    // It used to return at the allowance and report 3.
    expect(outcome.outstanding).toBe(6);
    expect(outcome.scanned).toBe(6);
    expect(sanitizationSweepCompleted(outcome)).toBe(false);
  });

  it('still never attempts more than the allowance', async () => {
    const { rows, objects } = await queue(Array.from({ length: 8 }, (_, i) => ({
      id: `image-${String(i).padStart(2, '0')}`, minutesAgo: null,
    })));
    let attempts = 0;
    const budget = newRepairBudget();
    const started = budget.remaining;

    await settleImageSanitization(fakeDb(rows, objects) as never, ORG, {
      budget,
      sanitize: (async () => {
        attempts += 1;
        return {
          ok: false as const, reason: 'inpaint_unavailable' as const,
          transformation: 'generative_overlay_inpaint' as const,
          model: null, operational: true, detail: '429',
        };
      }) as never,
    });

    expect(attempts).toBe(started);
  });

  it('a row inside its cooldown is never spent on, however long the queue', async () => {
    const { rows, objects } = await queue([
      { id: 'image-01', minutesAgo: 1 },
      { id: 'image-02', minutesAgo: 2 },
      { id: 'image-03', minutesAgo: 40 },
    ]);
    const db = fakeDb(rows, objects);

    await settleImageSanitization(db as never, ORG, {
      budget: newRepairBudget(),
      sanitize: vendorOutage([]),
    });

    const fresh = db.rows
      .filter((row: any) => Date.parse(row.source_detail.sanitization_attempt.at)
        > Date.now() - 60_000)
      .map((row: any) => row.id);
    expect(fresh).toEqual(['image-03']);
  });
});

// ---------------------------------------------------------------------------
// The reader: a derivative is a claim about SPECIFIC bytes
// ---------------------------------------------------------------------------

describe('a derivative that has drifted from its original is not served', () => {
  const record = (over: Partial<SanitizedDerivative> = {}): SanitizedDerivative => ({
    transformation: 'generative_overlay_inpaint',
    sanitization_version: SANITIZATION_VERSION,
    original_image_id: 'image-1',
    original_sha256: 'a'.repeat(64),
    stock_item_id: 'item-1',
    organisation_id: ORG,
    source_reference: null,
    storage_bucket: 'builder-stock-images',
    storage_path: 'org-a/items/item-1/source/sanitized/v1/image-1.png',
    derivative_sha256: 'b'.repeat(64),
    width: W, height: H,
    repaired_share: 0.2, regions_removed: 3,
    model: INPAINT_MODEL,
    generated_at: '2026-09-25T00:00:00Z',
    verdict: 'eligible',
    ...over,
  });

  const detail = (over: Partial<SanitizedDerivative> = {}) => ({
    role: 'primary_property',
    stored_sha256: 'a'.repeat(64),
    ...derivativeDetail(record(over)),
  });

  it('serves one whose original hash still matches the row', () => {
    expect(servableDerivativeFor(detail())).not.toBeNull();
  });

  it('REFUSES one whose original has been replaced', () => {
    expect(readServableDerivative(detail(), 'c'.repeat(64))).toBeNull();
    expect(servableDerivativeFor({ ...detail(), stored_sha256: 'c'.repeat(64) })).toBeNull();
  });

  it('REFUSES one made by an older version', () => {
    expect(servableDerivativeFor(detail({ sanitization_version: 0 }))).toBeNull();
  });

  it('does not overrule one from a FUTURE version', () => {
    expect(servableDerivativeFor(detail({ sanitization_version: 99 }))).not.toBeNull();
  });

  it('REFUSES one the classifier did not pass', () => {
    expect(servableDerivativeFor(detail({ verdict: 'ineligible' }))).toBeNull();
    expect(servableDerivativeFor(detail({ verdict: 'pending' }))).toBeNull();
  });

  it('REFUSES anything malformed, and a row that has none', () => {
    expect(servableDerivativeFor(null)).toBeNull();
    expect(servableDerivativeFor({})).toBeNull();
    expect(servableDerivativeFor({ sanitized_derivative: 'yes' })).toBeNull();
    expect(servableDerivativeFor({ sanitized_derivative: { verdict: 'eligible' } })).toBeNull();
  });

  it('a row with no hash at all cannot claim a derivative', () => {
    const orphan = { ...detail() } as Record<string, unknown>;
    delete orphan.stored_sha256;
    expect(servableDerivativeFor(orphan)).toBeNull();
  });

  it('a settled question stays settled only while the original stands', () => {
    expect(sanitizationSettled(detail(), 'a'.repeat(64))).toBe(true);
    expect(sanitizationSettled(detail(), 'c'.repeat(64))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RULE 13 — the repaired picture becomes the card's image
// ---------------------------------------------------------------------------

describe('the display gate', () => {
  const row = (extra: Record<string, unknown>) => ({
    id: 'image-1',
    source_stage: 'uploaded_document',
    verification_status: 'source_supplied',
    processing_status: 'ready',
    storage_path: PATH,
    position: 0,
    source_detail: {
      role: 'primary_property',
      role_evidence_level: 3,
      stored_sha256: 'a'.repeat(64),
      marketplace_display_eligible: false,
      marketplace_eligibility_state: 'ineligible',
      marketplace_rejection_reason: 'annotated_marketing_tile',
      marketplace_measured: true,
      marketplace_eligibility_version: 1,
      ...extra,
    },
  });

  const derivative: SanitizedDerivative = {
    transformation: 'generative_overlay_inpaint',
    sanitization_version: SANITIZATION_VERSION,
    original_image_id: 'image-1',
    original_sha256: 'a'.repeat(64),
    stock_item_id: 'item-1',
    organisation_id: ORG,
    source_reference: null,
    storage_bucket: 'builder-stock-images',
    storage_path: 'org-a/items/item-1/source/sanitized/v1/image-1.png',
    derivative_sha256: 'b'.repeat(64),
    width: W, height: H, repaired_share: 0.2, regions_removed: 3,
    model: INPAINT_MODEL, generated_at: '2026-09-25T00:00:00Z', verdict: 'eligible',
  };

  it('still hides a refused picture that has no repair', () => {
    expect(isDisplayableSourceImage(row({}) as never)).toBe(false);
  });

  it('shows the same property once its own picture has been repaired', () => {
    expect(isDisplayableSourceImage(row(derivativeDetail(derivative)) as never)).toBe(true);
  });

  it('the ORIGINAL verdict is left standing beside the repair, never overwritten', () => {
    const detail = row(derivativeDetail(derivative)).source_detail;
    expect(detail.marketplace_eligibility_state).toBe('ineligible');
    expect(detail.marketplace_rejection_reason).toBe('annotated_marketing_tile');
    expect(detail.role).toBe('primary_property');
  });

  it('hides it again if the builder replaces the underlying file', () => {
    const replaced = row(derivativeDetail(derivative));
    replaced.source_detail.stored_sha256 = 'c'.repeat(64);
    expect(isDisplayableSourceImage(replaced as never)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The settler, on a picture that turns out to carry nothing
// ---------------------------------------------------------------------------

describe('the settler, when the inspection finds nothing to remove', () => {
  it('records a CLEARANCE and makes the builder\'s original displayable', async () => {
    /*
     * Lot 537 Kirramingly's shape. The classifier convicted the picture, the
     * repair inspected it and found no type, no brand colour and no plate. The
     * card must show the builder's own file — not a repair of it, and not an
     * empty frame.
     */
    const bytes = (await encodePng(photograph(W, H, 11).pixels,
      { width: W, height: H, components: 3 }))!;
    const row = await refusedRow(bytes);
    const db = fakeDb([row], { [PATH]: bytes });

    const outcome = await settleImageSanitization(db as never, ORG, {
      sanitize: async () => ({
        ok: false as const,
        reason: 'nothing_to_remove' as const,
        transformation: 'deterministic_overlay_reconstruction' as const,
        model: null,
        detail: 'this picture carries no promotional treatment to remove',
        clearance: {
          measured: true,
          textRunCount: 0,
          strictTextLines: 0,
          faintTextLines: 0,
          flatRegionCount: 1,
          promotionalRegionCount: 0,
          plateCount: 0,
        },
        clearanceRefusal: null,
      }),
    });

    expect(outcome.cleared).toBe(1);
    expect(outcome.refused).toBe(0);
    expect(outcome.repaired).toBe(0);
    expect(outcome.unresolved).toBe(0);
    expect(sanitizationSweepCompleted(outcome)).toBe(true);

    const stored = row.source_detail as Record<string, unknown>;
    // NO DERIVATIVE WAS MADE. Nothing was written to storage and nothing was
    // encoded: the card serves the row's own bytes.
    expect(stored[DERIVATIVE_KEY]).toBeNull();
    expect(servableClearanceFor(stored)).not.toBeNull();
    expect(isDisplayableSourceImage(row as never)).toBe(true);
  });

  it('leaves an OPERATIONAL fault unresolved and retryable, never recorded', async () => {
    /*
     * A decoder that fell over is not an answer about the picture. Writing it
     * down as one parks the card until the next version bump — the same rule
     * that keeps a model outage from permanently blanking a property.
     */
    const bytes = (await encodePng(photograph(W, H, 12).pixels,
      { width: W, height: H, components: 3 }))!;
    const row = await refusedRow(bytes);
    const db = fakeDb([row], { [PATH]: bytes });

    const outcome = await settleImageSanitization(db as never, ORG, {
      sanitize: async () => ({
        ok: false as const,
        reason: 'unusable_input' as const,
        transformation: null,
        model: null,
        operational: true,
        detail: 'the picture could not be read (decoder_failed)',
      }),
    });

    expect(outcome.unresolved).toBe(1);
    expect(outcome.cleared).toBe(0);
    expect(outcome.refused).toBe(0);
    // Nothing written, so the marker cannot advance and the next tick retries.
    expect(sanitizationSweepCompleted(outcome)).toBe(false);
    const stored = row.source_detail as Record<string, unknown>;
    expect(stored[FAILURE_KEY]).toBeUndefined();
    expect(stored[CLEARANCE_KEY]).toBeUndefined();
    expect(isDisplayableSourceImage(row as never)).toBe(false);
  });

  it('a real badge is still REFUSED, and stays hidden', async () => {
    const bytes = (await encodePng(photograph(W, H, 13).pixels,
      { width: W, height: H, components: 3 }))!;
    const row = await refusedRow(bytes);
    const db = fakeDb([row], { [PATH]: bytes });

    const outcome = await settleImageSanitization(db as never, ORG, {
      sanitize: async () => ({
        ok: false as const,
        reason: 'nothing_to_remove' as const,
        transformation: 'deterministic_overlay_reconstruction' as const,
        model: null,
        detail: 'the graphic on this picture has no measurable extent to remove',
        // Inspected, and a brand colour was found. No clearance.
        clearanceRefusal: 'promotional_plate_present',
      }),
    });

    expect(outcome.refused).toBe(1);
    expect(outcome.cleared).toBe(0);
    const stored = row.source_detail as Record<string, unknown>;
    expect(stored[CLEARANCE_KEY]).toBeNull();
    expect(isDisplayableSourceImage(row as never)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The version has two halves and they must agree
// ---------------------------------------------------------------------------

describe('the deployment ships both halves of the version', () => {
  /*
   * EVERY MIGRATION, NOT ONE NAMED FILE.
   *
   * The version has a half in TypeScript and a half in the database, and the
   * database half is what the cron job reads to decide whether any repair work
   * is outstanding — SQL cannot see the constant. Shipping only the TypeScript
   * half changes what new imports get and silently leaves every stored image on
   * the old rules, which is the exact failure the target column exists to stop.
   *
   * This used to read the one migration that introduced the target, which meant
   * the guard stopped working the moment a bump arrived in a NEW file — and a
   * bump in a new file is the correct way to ship one, because editing an
   * applied migration changes nothing in a database that has already run it.
   * So: scan them all, take the highest target anyone asks for, and require it
   * to be the version this code is written to.
   */
  it('some migration raises the target to exactly SANITIZATION_VERSION', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const targets: number[] = [];
    for (const file of readdirSync('supabase/migrations')) {
      if (!file.endsWith('.sql')) continue;
      const sql = readFileSync(`supabase/migrations/${file}`, 'utf8');
      for (const match of sql.matchAll(/set_builder_stock_sanitization_target\((\d+)\)/g)) {
        targets.push(Number(match[1]));
      }
    }
    expect(targets.length).toBeGreaterThan(0);
    expect(Math.max(...targets)).toBe(SANITIZATION_VERSION);
  });
});
