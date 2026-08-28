/**
 * Builder stock — the residue a repair can leave, and the questions the gates
 * now ask about it.
 *
 * WHAT THIS FILE PINS, AND WHY IT EXISTS AT ALL. A visual census of every
 * served derivative found nine of seventeen rows carrying residue the
 * platform's own instruments measure as nothing: a white plate the neutral
 * floor cannot see, a pale strip below the faint pass's size floors, a corner
 * wedge where a removed pill met the frame. Some of that is structurally
 * below measured thresholds and stays a documented `repair_region` case — but
 * two parts of it were GATES READING ANSWERS NOBODY ASKED FOR, and those are
 * fixed and pinned here:
 *
 *   the post-repair check read a faint-text count that `readMarketingOverlay`
 *   structurally suppresses whenever a flat region survives — so every
 *   derivative served over a surviving flat region had, by construction,
 *   never been asked the faint question;
 *
 *   and nothing after a repair looked for a brand-coloured plate AWAY from
 *   the repaired area, which a supplied `repair_region` makes reachable: the
 *   operator's rectangle replaces the derived mask entirely.
 *
 * The rest of the file pins the detector's documented exemptions AS
 * exemptions — a diagonal ribbon, a price roundel, a full-bleed band, a
 * neutral plate below the floor — so each stays a decision with a fixture
 * rather than an accident nobody can name, and pins the mask-growth geometry
 * at production scale, which no test exercised.
 */
import { describe, expect, it } from 'vitest';

import {
  measureFaintOverlayText, measureFlatColourRegions, overlayTextBoxes, readMarketingOverlay,
} from '../../../supabase/functions/_shared/builderStock/marketingOverlay.pure';
import {
  overlayPlateMask, promotionalRegions,
} from '../../../supabase/functions/_shared/builderStock/overlayPlate.pure';
import {
  decideOverlayClearance,
} from '../../../supabase/functions/_shared/builderStock/overlayClearance.pure';
import {
  growOverlayMask, sanitizeOverlay,
} from '../../../supabase/functions/_shared/builderStock/sanitizeOverlay.pure';
import {
  MAX_REPAIRED_SHARE,
} from '../../../supabase/functions/_shared/builderStock/repairRegion.pure';
import {
  sanitizeSourceImage,
} from '../../../supabase/functions/_shared/builderStock/sanitizeImage';
import { encodePng } from '../../../supabase/functions/_shared/builderStock/rasterPng';
import {
  photograph, withCaption, withDiagonalRibbon, withDisc, withFaintCaption, withPlate,
  type Picture,
} from './fixtures/builderStockPictures';

const W = 400;
const H = 200;

const view = (picture: Picture) =>
  ({ width: picture.width, height: picture.height, pixels: picture.pixels });

/**
 * The sky a builder photographs a house against, with real grain — the same
 * ground the other repair suites stamp their badges onto. `photograph()`'s
 * roofline rises into the top band of the frame, and a badge across a roofline
 * is exactly what the deterministic route refuses; the E2E constructions here
 * need repairs that SUCCEED, so their ground is open sky.
 */
function skyPicture(variant = 0): Picture {
  const pixels = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const at = (y * W + x) * 3;
      const t = y / H;
      const grain = ((x * 29 + y * 71 + variant * 5) % 13) - 6;
      pixels[at] = Math.max(0, Math.min(255, Math.round(120 + 90 * t + grain)));
      pixels[at + 1] = Math.max(0, Math.min(255, Math.round(160 + 70 * t + grain)));
      pixels[at + 2] = Math.max(0, Math.min(255, Math.round(210 + 40 * t + grain)));
    }
  }
  return { width: W, height: H, pixels };
}

const bytesOf = async (picture: Picture) => {
  const bytes = await encodePng(picture.pixels, {
    width: picture.width, height: picture.height, components: 3,
  });
  expect(bytes).not.toBeNull();
  return bytes as Uint8Array;
};

/** The Lot 13 door: a neutral flat block that is a feature of the house. */
const withDoor = (base: Picture) =>
  withPlate(base, { x: 60, y: 120, w: 130, h: 60 }, [30, 30, 32]);

/** A removable badge: a chromatic plate with legible words, on quiet sky. */
const withBadge = (base: Picture) => withCaption(
  withPlate(base, { x: 20, y: 14, w: 96, h: 30 }, [193, 255, 114]),
  // Scale 2 keeps all six glyphs inside the plate: 6 × 6 × 2 = 72px from
  // x=28 ends at 100, inside the plate's right edge at 115.
  'SOLERA', { x: 28, y: 22, scale: 2, ink: [10, 10, 10] });

describe('the post-repair gate asks the faint question instead of reading a suppressed zero', () => {
  it('a repair that leaves faint type beside a surviving flat region is refused', async () => {
    /*
     * The construction the served production residue proved reachable: the
     * badge is repaired, the house's own neutral door survives as a flat
     * region — which sets `annotated` and used to suppress the faint pass —
     * and a pale mark sits on quiet sky, visible to `measureFaintOverlayText`
     * and to nobody else.
     */
    // Lift 34: above the faint pass's quiet-ground floor on this sky
    // (dispersion × 2.4 ≈ 31), below the strict pass's ink floor of 40 —
    // measured, not guessed; the sanity assertions below hold the window.
    const picture = withFaintCaption(
      withBadge(withDoor(skyPicture(41))),
      'ROSE', { x: 252, y: 30, scale: 2, lift: 34 });

    // Fixture sanity, so a silent change to the faint pass fails loudly HERE:
    // the mark is measurable by the faint pass and invisible to the strict one.
    const verdict = readMarketingOverlay(view(picture));
    expect(verdict.annotated).toBe(true);
    expect(verdict.textLineCount).toBeGreaterThan(0); // the badge's own caption
    const faint = measureFaintOverlayText(view(picture));
    expect(faint.lineCount).toBeGreaterThan(0);
    // And the suppression this gate used to inherit: the verdict's own faint
    // reading is a structural zero on a convicted picture.
    expect(verdict.faintTextLineCount).toBe(0);

    const result = await sanitizeSourceImage(await bytesOf(picture));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('still_annotated');
  });

  it('the same repair with no faint residue keeps the Lot 13 allowance', async () => {
    // The twin: identical construction minus the pale mark. The door still
    // makes the display classifier object, and the repair is still accepted on
    // its own work — the allowance the faint fix must not cost.
    const picture = withBadge(withDoor(skyPicture(41)));

    const result = await sanitizeSourceImage(await bytesOf(picture));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.verdict).toBe('eligible');
    expect(result.classifierState).toBe('ineligible');
  });
});

describe('a brand-coloured plate surviving anywhere refuses the repair', () => {
  /*
   * The reachable route: a supplied `repair_region` replaces the derived mask
   * entirely, so a wordless chromatic pill the detector CAN see is left
   * unmasked. Its own flat region used to set `annotated`, suppressing the
   * faint pass; it carries no type for the strict pass; and it sits away from
   * the repaired area, which was all the flat-block test looked at. Verdict:
   * eligible, served with a marketing pill on it.
   */
  const REGION = { left: 20 / W, top: 14 / H, right: 116 / W, bottom: 44 / H };

  it('a wordless chromatic pill outside a supplied repair region is refused', async () => {
    const picture = withPlate(
      withBadge(skyPicture(42)),
      { x: 300, y: 10, w: 80, h: 26 }, [19, 193, 109]);

    // Fixture sanity: the pill is exactly what `promotionalRegions` exists to
    // name — a flat region filled with a brand colour.
    const flat = measureFlatColourRegions(view(picture));
    const promotional = promotionalRegions(
      view(picture), flat.regions.map((region) => region.box));
    expect(promotional.length).toBeGreaterThan(0);

    const result = await sanitizeSourceImage(await bytesOf(picture), {
      repairRegion: REGION,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('still_annotated');
    expect(result.detail).toContain('promotional colour block');
  });

  it('a neutral door outside the same supplied region is not a refusal', async () => {
    // The counter-case that keeps this from re-importing the Lot 13 false
    // positive: the same picture with the house's own neutral block instead of
    // a pill is accepted — `isPromotionalFill` excludes every garage door.
    const picture = withDoor(withBadge(skyPicture(42)));

    const result = await sanitizeSourceImage(await bytesOf(picture), {
      repairRegion: REGION,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.verdict).toBe('eligible');
  });
});

describe('the captioned wall — the fallback plate is held to the ratio the flood always was', () => {
  // A small run of type and the flat regions offered as its plate. The view is
  // an ordinary photograph, so `plateAround`'s flood cannot settle a plate
  // colour and the flat-region fallback is the path under test.
  const TEXT = { left: 180, top: 90, right: 219, bottom: 99 }; // 40×10 = 400 px²

  it('refuses a flat region ten times its type, whatever the share ceiling says', () => {
    const picture = photograph(W, H, 43);
    // 120×100 = 12,000 px² — 15% of the frame, under MAX_PLATE_SHARE, but
    // 30× the type it contains. Accepting it is how a fifth of a house gets
    // rebuilt with every gate reporting success.
    const wall = { left: 140, top: 40, right: 259, bottom: 139 };
    const { plates } = overlayPlateMask(view(picture), [TEXT], [wall]);
    expect(plates).toHaveLength(0);
  });

  it('still accepts a pill-sized region around its own caption', () => {
    const picture = photograph(W, H, 43);
    // 56×20 = 1,120 px² — 2.8× the type. The four production repairs the
    // fallback exists for are this shape, and the ratio gate must not cost them.
    const pill = { left: 172, top: 85, right: 227, bottom: 104 };
    const { plates } = overlayPlateMask(view(picture), [TEXT], [pill]);
    expect(plates).toHaveLength(1);
    expect(plates[0]).toEqual(pill);
  });
});

describe('the deterministic route answers to the same total ceiling as every other route', () => {
  const quiet = () => {
    // Flat mid-grey with deterministic grain: quiet enough that boundary
    // gates pass, so the only thing under test is the total-share ceiling.
    const pixels = new Uint8Array(W * H * 3);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const at = (y * W + x) * 3;
        const grain = ((x * 29 + y * 71) % 13) - 6;
        pixels[at] = 150 + grain;
        pixels[at + 1] = 148 + grain;
        pixels[at + 2] = 145 + grain;
      }
    }
    return pixels;
  };

  const maskOf = (blobs: Array<{ x: number; y: number; w: number; h: number }>) => {
    const mask = new Uint8Array(W * H);
    for (const blob of blobs) {
      for (let y = blob.y; y < blob.y + blob.h; y++) {
        for (let x = blob.x; x < blob.x + blob.w; x++) mask[y * W + x] = 1;
      }
    }
    return mask;
  };

  it('refuses five modest holes that sum past the ceiling, before doing the work', () => {
    // Five 8% regions: each passes the per-region cap, together they are 40%
    // of the frame — past MAX_REPAIRED_SHARE. Without this gate the smear is
    // computed, written to storage, and only refused at serve time.
    // Gaps of 12 columns between blobs: EDGE_GROW dilates each side by 3, so
    // the holes stay separate and the per-region cap cannot be what refuses.
    const blobs = [
      { x: 4, y: 4, w: 120, h: 50 },
      { x: 136, y: 4, w: 120, h: 50 },
      { x: 268, y: 4, w: 120, h: 50 },
      { x: 4, y: 120, w: 120, h: 50 },
      { x: 136, y: 120, w: 120, h: 50 },
    ];
    const result = sanitizeOverlay({
      width: W, height: H, pixels: quiet(), mask: maskOf(blobs),
      regions: blobs.length, maskWidth: W, maskHeight: H,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('too_much_to_rebuild');
  });

  it('still fills the same holes when they stay inside the ceiling', () => {
    const blobs = [
      { x: 4, y: 4, w: 120, h: 50 },
      { x: 136, y: 4, w: 120, h: 50 },
      { x: 4, y: 120, w: 120, h: 50 },
    ];
    const result = sanitizeOverlay({
      width: W, height: H, pixels: quiet(), mask: maskOf(blobs),
      regions: blobs.length, maskWidth: W, maskHeight: H,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.repairedShare).toBeLessThanOrEqual(MAX_REPAIRED_SHARE);
  });
});

describe('the detector\'s documented exemptions, pinned as decisions', () => {
  /*
   * Each of these is a promotional shape the flat-colour arm deliberately does
   * NOT convict, because every accepting geometry tried admits real
   * architecture with it — and a false positive here does not hide a card, it
   * puts the region in the repair mask and serves a diffused piece of a clean
   * render. The remedy for each is a recorded `repair_region`. These fixtures
   * exist so the exemptions stay decisions: if a detector change starts
   * convicting one of these shapes, that is a deliberate step someone must
   * take knowingly, with the false-positive analysis in the constant's
   * docstring in front of them.
   */
  it('a diagonal corner ribbon is exempt — doubly, by row fill and edge spread', () => {
    const picture = withDiagonalRibbon(
      photograph(W, H, 44), { x1: 0, y1: 70, x2: 70, y2: 0, thickness: 22 },
      [235, 60, 60]);
    expect(measureFlatColourRegions(view(picture)).regions).toHaveLength(0);
    expect(readMarketingOverlay(view(picture)).annotated).toBe(false);
  });

  it('a circular price roundel is exempt by edge spread', () => {
    const picture = withDisc(
      photograph(W, H, 45), { cx: 320, cy: 44, r: 40 }, [235, 60, 60]);
    expect(measureFlatColourRegions(view(picture)).regions).toHaveLength(0);
    expect(readMarketingOverlay(view(picture)).annotated).toBe(false);
  });

  it('a full-bleed band is exempt by span — and the same band inset is not', () => {
    const bled = withPlate(photograph(W, H, 46), { x: 0, y: 0, w: W, h: 36 }, [235, 60, 60]);
    expect(readMarketingOverlay(view(bled)).annotated).toBe(false);

    // The control that proves the exemption is the SPAN and nothing else.
    const inset = withPlate(photograph(W, H, 46), { x: 30, y: 0, w: 340, h: 36 }, [235, 60, 60]);
    expect(readMarketingOverlay(view(inset)).annotated).toBe(true);
  });

  it('a neutral plate below the floor is invisible — and is affirmatively cleared', () => {
    /*
     * The census case: a white plate at 4.1% of the frame, below the 4.5%
     * neutral floor that sits 1.1 points above a real disclaimer bar. Both
     * arms are silent, and the clearance — measuring everything there is to
     * measure — certifies the picture clean. Four served derivatives carry
     * exactly this residue. Pinned so the hole has a name and a shape; the
     * remedy is a recorded `repair_region`, never a lower floor.
     */
    const picture = withPlate(photograph(W, H, 47), { x: 24, y: 12, w: 150, h: 22 }, [240, 240, 242]);
    const verdict = readMarketingOverlay(view(picture));
    expect(verdict.annotated).toBe(false);

    const flat = measureFlatColourRegions(view(picture));
    const clearance = decideOverlayClearance({
      measured: true,
      textRunCount: overlayTextBoxes(view(picture)).length,
      strictTextLines: verdict.textLineCount,
      faintTextLines: measureFaintOverlayText(view(picture)).lineCount,
      flatRegionCount: flat.regions.length,
      promotionalRegionCount: promotionalRegions(
        view(picture), flat.regions.map((region) => region.box)).length,
      plateCount: 0,
    });
    expect(clearance.cleared).toBe(true);
  });
});

describe('mask growth at production scale, which no test exercised', () => {
  it('grows by EDGE_GROW times the thumbnail-to-frame scale', () => {
    // One thumbnail pixel at (100, 50) on a 400×200 mask, applied to a
    // 1200×600 frame: spread = 3, so the scaled 3×3 block is dilated by
    // 9 full-resolution pixels of Manhattan radius — not by the 3 the
    // constant's name suggests.
    const mask = new Uint8Array(W * H);
    mask[50 * W + 100] = 1;
    const grown = growOverlayMask(mask, W, H, 1200, 600);
    expect(grown).not.toBeNull();
    if (!grown) return;

    // The thumbnail pixel maps to x ∈ [300, 302], y ∈ [150, 152].
    expect(grown[150 * 1200 + 300]).toBe(1);
    // Manhattan distance 9 from the block's left edge: reached.
    expect(grown[150 * 1200 + (300 - 9)]).toBe(1);
    expect(grown[(150 - 9) * 1200 + 300]).toBe(1);
    // Distance 10: not reached. The dilation is 3 × spread, exactly.
    expect(grown[150 * 1200 + (300 - 10)]).toBe(0);
    expect(grown[(150 - 10) * 1200 + 300]).toBe(0);
  });
});
