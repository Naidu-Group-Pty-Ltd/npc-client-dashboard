/**
 * Builder stock — the disagreement between "there is marketing here" and
 * "there is nothing to remove", and which one gets to decide the card.
 *
 * TWO INSTRUMENTS LOOK AT ONE PHOTOGRAPH. The coarse classifier reads a 400px
 * reduction and refuses anything with a flat coloured block or a line of type
 * on it; it is tuned so that being wrong costs a blank card rather than a
 * marketing tile on one. The precise inspection decodes the picture properly
 * and works out which pixels a badge actually occupies. When the first convicts
 * and the second finds nothing, one of them is wrong, and until this existed
 * the card stayed blank either way.
 *
 * BOTH WAYS OF RESOLVING THAT ARE DANGEROUS, WHICH IS WHY THESE TESTS EXIST.
 * Always believing the classifier hides clean photographs — Lot 537 Kirramingly
 * Avenue is an unmarked builder render whose WHITE GARAGE DOOR is a flat
 * coloured block. Always believing the inspection puts marketing on cards —
 * Cloverton Registered carries "Registered" in 60px type on a green pill that
 * the type detector cannot read at any resolution, so a mask derived from type
 * alone comes out empty on a picture with an obvious badge on it.
 *
 * The measurements below are the real ones, taken on the production bytes of
 * both, and they are what the rule is fitted to.
 */
import { describe, expect, it } from 'vitest';

import {
  decideOverlayClearance,
} from '../../../supabase/functions/_shared/builderStock/overlayClearance.pure';
import {
  isPromotionalFill, overlayPlateMask, promotionalRegions, regionFill,
} from '../../../supabase/functions/_shared/builderStock/overlayPlate.pure';
import {
  measureFlatColourRegions, overlayTextBoxes,
} from '../../../supabase/functions/_shared/builderStock/marketingOverlay.pure';
import {
  CLEARANCE_KEY, DERIVATIVE_KEY, FAILURE_KEY, SANITIZATION_VERSION,
  clearanceDetail, derivativeDetail, failureDetail, servableClearanceFor,
  type SanitizationClearance,
} from '../../../supabase/functions/_shared/builderStock/sanitizedDerivative.pure';
import {
  isDisplayableSourceImage,
} from '../../../supabase/functions/_shared/builderStock/primaryImage';
import { photograph, withCaption, withPlate } from './fixtures/builderStockPictures';

/** The inspection of a picture with nothing on it but the house. */
const CLEAN = {
  measured: true,
  textRunCount: 0,
  strictTextLines: 0,
  faintTextLines: 0,
  /* One, and it is why the classifier refused: the garage door. */
  flatRegionCount: 1,
  promotionalRegionCount: 0,
  plateCount: 0,
} as const;

describe('deciding a picture carries nothing to remove', () => {
  it('clears a picture whose only flat region is part of the house', () => {
    // Lot 537 Kirramingly, measured: no type of any kind, one flat region, and
    // that region is a white garage door at 0.045 saturation.
    expect(decideOverlayClearance({ ...CLEAN })).toEqual({ cleared: true, refusal: null });
  });

  it('REFUSES to clear a picture carrying a brand colour, even with no readable words', () => {
    /*
     * CLOVERTON REGISTERED, AND THE REASON THIS MODULE IS NOT A ONE-LINER.
     *
     * Its evidence is identical to Lot 537's on every count the type detector
     * produces — zero runs, zero strict lines, zero faint lines — because
     * "Registered" is set on a green pill it cannot read. The ONLY thing that
     * separates the two is the colour of the region, and four production cards
     * would have been given a marketing tile if this test did not exist.
     */
    expect(decideOverlayClearance({ ...CLEAN, promotionalRegionCount: 1 }))
      .toEqual({ cleared: false, refusal: 'promotional_plate_present' });
  });

  it('REFUSES to clear a picture the mask builder found something on', () => {
    expect(decideOverlayClearance({ ...CLEAN, plateCount: 1 }))
      .toEqual({ cleared: false, refusal: 'removable_plate_present' });
  });

  it('REFUSES to clear a picture carrying laid-over type', () => {
    expect(decideOverlayClearance({ ...CLEAN, strictTextLines: 2 }))
      .toEqual({ cleared: false, refusal: 'type_present' });
    expect(decideOverlayClearance({ ...CLEAN, textRunCount: 1 }))
      .toEqual({ cleared: false, refusal: 'type_present' });
  });

  it('REFUSES to clear a picture the faint pass saw the shape of type on', () => {
    // Pale type over a pale sky. Not proof of a badge; proof that nobody may
    // call this picture clean.
    expect(decideOverlayClearance({ ...CLEAN, faintTextLines: 1 }))
      .toEqual({ cleared: false, refusal: 'faint_type_present' });
  });

  it('NEVER clears a picture nothing could inspect', () => {
    /*
     * THE SEMANTIC THAT MATTERS MOST. "We could not look" is not "we looked and
     * it was clean". An unreadable container, a decoder that fell over, a
     * resource ceiling — every one of them leaves the picture exactly as
     * unexamined as before, and a clearance is a POSITIVE finding.
     */
    expect(decideOverlayClearance({ ...CLEAN, measured: false }))
      .toEqual({ cleared: false, refusal: 'not_inspected' });
  });
});

describe('telling a brand colour from a building material', () => {
  /* Every number here is measured on production bytes. */
  const PROMOTIONAL: Array<[string, [number, number, number]]> = [
    ['Lot 13 green pill', [19, 193, 109]],
    ['Lot 13 second pill', [54, 201, 130]],
    ['Lot 1663 green pill', [179, 235, 107]],
    ['Lot 1663 red pill', [250, 77, 77]],
    ['Brownsplains blue plate', [49, 71, 161]],
    ['Coridale blue plate', [74, 183, 242]],
    ['Cloverton green pill', [163, 215, 98]],
  ];
  const ARCHITECTURAL: Array<[string, [number, number, number]]> = [
    ['Lot 537 white garage door', [227, 224, 217]],
    ['a black garage door', [24, 24, 26]],
    ['a charcoal roof', [58, 60, 62]],
    ['a beige rendered wall', [214, 203, 186]],
    ['a grey driveway', [128, 128, 130]],
    ['a pale sky', [198, 214, 232]],
  ];

  const fillOf = (rgb: [number, number, number]) => {
    const pixels = new Uint8Array(4 * 4 * 3);
    for (let i = 0; i < 16; i++) {
      pixels[i * 3] = rgb[0];
      pixels[i * 3 + 1] = rgb[1];
      pixels[i * 3 + 2] = rgb[2];
    }
    return regionFill({ width: 4, height: 4, pixels },
      { left: 0, top: 0, right: 3, bottom: 3 });
  };

  for (const [name, rgb] of PROMOTIONAL) {
    it(`calls ${name} a badge`, () => {
      expect(isPromotionalFill(fillOf(rgb))).toBe(true);
    });
  }

  for (const [name, rgb] of ARCHITECTURAL) {
    it(`calls ${name} part of the house`, () => {
      expect(isPromotionalFill(fillOf(rgb))).toBe(false);
    });
  }

  it('will not call a near-black pixel a badge on saturation alone', () => {
    // (3,0,0) is saturation 1.0 and chroma 3. Requiring both is what stops an
    // arithmetic artefact of a dark pixel reading as a brand colour.
    expect(isPromotionalFill(fillOf([3, 0, 0]))).toBe(false);
  });
});

describe('the mask, on pictures whose badges carry no readable words', () => {
  const W = 400;
  const H = 200;

  it('removes a wordless coloured pill, which used to be nothing_to_remove', () => {
    const base = photograph(W, H, 3);
    const badged = withPlate(base, { x: 24, y: 18, w: 96, h: 26 }, [163, 215, 98]);
    const flat = measureFlatColourRegions(badged).regions.map((region) => region.box);
    const plates = overlayPlateMask(badged, overlayTextBoxes(badged), flat);

    expect(promotionalRegions(badged, flat).length).toBeGreaterThan(0);
    expect(plates.plates.length).toBeGreaterThan(0);
    // And the mask is ON the pill.
    expect(plates.mask[30 * W + 60]).toBe(1);
  });

  it('leaves a neutral block of the same size and place completely alone', () => {
    /*
     * THE CONTROL, AND IT IS THE WHOLE SAFETY ARGUMENT. Same fixture, same
     * geometry, same position — only the colour differs. A garage door is not
     * removed from a house because it is rectangular.
     */
    const base = photograph(W, H, 3);
    const doored = withPlate(base, { x: 24, y: 18, w: 96, h: 26 }, [227, 224, 217]);
    const flat = measureFlatColourRegions(doored).regions.map((region) => region.box);
    const plates = overlayPlateMask(doored, overlayTextBoxes(doored), flat);

    expect(promotionalRegions(doored, flat)).toHaveLength(0);
    expect(plates.plates).toHaveLength(0);
    expect(Array.from(plates.mask).some((v) => v === 1)).toBe(false);
  });

  it('does not count one badge twice when both routes find it', () => {
    // A pill WITH words on it is reachable by the flood and by the colour. The
    // deterministic route sizes its work from the count, so a duplicate would
    // make one badge look like two.
    const base = photograph(W, H, 5);
    const plated = withPlate(base, { x: 30, y: 20, w: 120, h: 30 }, [19, 193, 109]);
    const badged = withCaption(plated, 'SOLAR',
      { x: 40, y: 28, scale: 3, ink: [10, 10, 10] });
    const flat = measureFlatColourRegions(badged).regions.map((region) => region.box);
    const plates = overlayPlateMask(badged, overlayTextBoxes(badged), flat);

    const onThePill = plates.plates.filter((box) =>
      box.left <= 60 && box.right >= 60 && box.top <= 35 && box.bottom >= 35);
    expect(onThePill.length).toBeLessThanOrEqual(2);
  });
});

describe('what a stored clearance licenses', () => {
  const clearance: SanitizationClearance = {
    sanitization_version: SANITIZATION_VERSION,
    original_image_id: 'image-1',
    original_sha256: 'abc123',
    stock_item_id: 'item-1',
    organisation_id: 'org-1',
    source_reference: null,
    evidence: {
      text_run_count: 0,
      strict_text_lines: 0,
      faint_text_lines: 0,
      flat_region_count: 1,
      promotional_region_count: 0,
      plate_count: 0,
    },
    cleared_at: '2026-08-19T00:00:00.000Z',
  };

  const row = (detail: Record<string, unknown>) => ({
    id: 'image-1',
    source_stage: 'uploaded_document',
    verification_status: 'source_supplied',
    processing_status: 'ready',
    storage_path: 'org/items/item-1/source/photo.png',
    source_detail: {
      role: 'primary_property',
      stored_sha256: 'abc123',
      marketplace_eligibility_state: 'ineligible',
      marketplace_rejection_reason: 'annotated_marketing_tile',
      marketplace_eligibility_version: 1,
      ...detail,
    },
  });

  it('makes the ORIGINAL displayable, with no derivative anywhere', () => {
    const image = row(clearanceDetail(clearance));
    expect(isDisplayableSourceImage(image)).toBe(true);
    // The card serves the row's own bytes: nothing was made.
    expect(image.source_detail[DERIVATIVE_KEY]).toBeNull();
    expect(servableClearanceFor(image.source_detail)).not.toBeNull();
  });

  it('never applies to bytes it was not written against', () => {
    const image = row({ ...clearanceDetail(clearance), stored_sha256: 'replaced' });
    expect(servableClearanceFor(image.source_detail)).toBeNull();
    expect(isDisplayableSourceImage(image)).toBe(false);
  });

  it('EXPIRES with the inspection that made it', () => {
    /*
     * A clearance is evidence of ABSENCE, and a version bump usually exists
     * because the previous inspection was missing something — version 2 is
     * exactly that. So it does not survive one, and the picture is hidden
     * again until the current inspection re-establishes it.
     */
    const image = row(clearanceDetail({ ...clearance, sanitization_version: 0 }));
    expect(servableClearanceFor(image.source_detail)).toBeNull();
    expect(isDisplayableSourceImage(image)).toBe(false);
  });

  it('but a DERIVATIVE from an older version keeps serving, which is the opposite', () => {
    /*
     * THE ASYMMETRY, AND WHY IT IS NOT AN OVERSIGHT.
     *
     * Eleven production images carry version-1 derivatives. Raising the
     * constant to 2 under the old rule would have un-served every one of them
     * the instant it shipped — and the four that need the generative route
     * cannot be remade while the vendor account is out of credit, so cards that
     * had been FIXED would have gone blank for a reason unconnected to the
     * pictures. A derivative is evidence of presence, acted on: the graphic was
     * there, it was removed, the result was measured, and a later improvement
     * cannot make that false.
     */
    const older = row(derivativeDetail({
      transformation: 'generative_overlay_inpaint',
      sanitization_version: 1,
      original_image_id: 'image-1',
      original_sha256: 'abc123',
      stock_item_id: 'item-1',
      organisation_id: 'org-1',
      source_reference: null,
      storage_bucket: 'builder-stock-images',
      storage_path: 'org/items/item-1/source/sanitized/v1/image-1.png',
      derivative_sha256: 'def456',
      width: 1200,
      height: 600,
      repaired_share: 0.152,
      regions_removed: 2,
      model: 'gpt-image-1',
      generated_at: '2026-08-19T00:00:00.000Z',
      verdict: 'eligible',
    }));
    expect(isDisplayableSourceImage(older)).toBe(true);
  });

  it('and a derivative the repair itself refused is still never served', () => {
    const refused = row(derivativeDetail({
      transformation: 'generative_overlay_inpaint',
      sanitization_version: SANITIZATION_VERSION,
      original_image_id: 'image-1',
      original_sha256: 'abc123',
      stock_item_id: 'item-1',
      organisation_id: 'org-1',
      source_reference: null,
      storage_bucket: 'builder-stock-images',
      storage_path: 'org/items/item-1/source/sanitized/v2/image-1.png',
      derivative_sha256: 'def456',
      width: 1200,
      height: 600,
      repaired_share: 0.152,
      regions_removed: 2,
      model: 'gpt-image-1',
      generated_at: '2026-08-19T00:00:00.000Z',
      verdict: 'ineligible',
    }));
    expect(isDisplayableSourceImage(refused)).toBe(false);
  });

  it('leaves a refused picture exactly as hidden as it was', () => {
    const image = row(failureDetail({
      transformation: 'deterministic_overlay_reconstruction',
      sanitization_version: SANITIZATION_VERSION,
      original_image_id: 'image-1',
      original_sha256: 'abc123',
      reason: 'background_too_detailed',
      detail: 'the reconstruction would be a guess',
      model: null,
      failed_at: '2026-08-19T00:00:00.000Z',
    }));
    expect(isDisplayableSourceImage(image)).toBe(false);
  });

  it('a refusal REVOKES a standing clearance, because they contradict', () => {
    const detail = {
      ...clearanceDetail(clearance),
      ...failureDetail({
        transformation: 'deterministic_overlay_reconstruction',
        sanitization_version: SANITIZATION_VERSION,
        original_image_id: 'image-1',
        original_sha256: 'abc123',
        reason: 'background_too_detailed',
        detail: 'a badge was found and could not be removed',
        model: null,
        failed_at: '2026-08-19T00:00:00.000Z',
      }),
    };
    expect(detail[CLEARANCE_KEY]).toBeNull();
    expect(isDisplayableSourceImage(row(detail))).toBe(false);
  });

  it('a successful repair REVOKES a standing clearance too', () => {
    // Otherwise the badged original would be displayable beside the clean copy.
    const detail = {
      ...clearanceDetail(clearance),
      ...derivativeDetail({
        transformation: 'deterministic_overlay_reconstruction',
        sanitization_version: SANITIZATION_VERSION,
        original_image_id: 'image-1',
        original_sha256: 'abc123',
        stock_item_id: 'item-1',
        organisation_id: 'org-1',
        source_reference: null,
        storage_bucket: 'builder-stock-images',
        storage_path: 'org/items/item-1/source/sanitized/v2/image-1.png',
        derivative_sha256: 'def456',
        width: 1200,
        height: 600,
        repaired_share: 0.076,
        regions_removed: 1,
        model: null,
        generated_at: '2026-08-19T00:00:00.000Z',
        verdict: 'eligible',
      }),
    };
    expect(detail[CLEARANCE_KEY]).toBeNull();
    expect(detail[FAILURE_KEY]).toBeNull();
  });

  it('cannot make ANOTHER property\'s image displayable', () => {
    /*
     * A clearance is not a licence to draw a picture: it only removes ONE
     * objection. Every other condition still has to hold, and the role is the
     * one that says this image is this property's listing image at all.
     */
    const foreign = { ...row(clearanceDetail(clearance)) };
    foreign.source_detail = { ...foreign.source_detail, role: 'interior' };
    expect(isDisplayableSourceImage(foreign)).toBe(false);

    const notTheBuilders = { ...row(clearanceDetail(clearance)), source_stage: 'google_maps' };
    expect(isDisplayableSourceImage(notTheBuilders)).toBe(false);

    const unverified = {
      ...row(clearanceDetail(clearance)), verification_status: 'location_derived',
    };
    expect(isDisplayableSourceImage(unverified)).toBe(false);
  });
});
