/**
 * BUILDER STOCK — THE PHOTOGRAPH WAS FOUND AND THEN THROWN AWAY.
 *
 * LIVE MARKETPLACE, 28 AUGUST 2026, upload 4dfe1be7.
 *
 * LOT 13 HUMMOCK RISE showed a Street View of the road. #2334 had worked: the
 * settler logged, verbatim,
 *
 *   reference: "Display Home - 13 Hummock Rise Werribee/Property Photos/Kaye_7341_HR.jpg"
 *   reason:    "The recovered photograph could not be stored."
 *
 * The traversal, the street-address identity and the photograph selection were
 * all correct. The file was downloaded — a valid JPEG, `ff d8 ff e1`, HTTP 200,
 * `image/jpeg` — and `validateSourceImageBytes` refused it at 12.28 MB against
 * a 10 MB `MAX_SOURCE_IMAGE_BYTES`. No row was written, `source_provenance_result`
 * stayed NULL, and the card fell through to Stage 3.
 *
 * Trying the next photograph is no answer: the first ten of that folder's 38
 * measure 12.28, 14.55, 14.01, 13.77, 14.70, 14.45, 16.28, 15.99, 13.84 and
 * 13.25 MB. Every one is over. The builder photographed the house at full
 * resolution, which is the right thing for a builder to do.
 *
 * LOT 1663 RINGER STREET showed a roundabout. Its package WAS selected — the
 * same run logged "package retired after 2 resource-limit failures" against
 * folder 1Y7UPKiG… — so Stage 3 answered, and Stage 3 had no usefulness test of
 * any kind: `enrichFromGoogle` asked Google for the nearest panorama to a
 * geocode and accepted whatever came back, at any distance. On a new estate
 * whose own street has never been driven, the nearest panorama is the arterial
 * road it joins.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assessPanoramaUsefulness, metresBetween, MAX_PANORAMA_DISTANCE_METRES,
} from '../../../supabase/functions/_shared/builderStock/streetViewHeading.pure';
import {
  driveRenditionUrl,
} from '../../../supabase/functions/_shared/builderStock/drivePackage.pure';
import {
  MAX_SOURCE_IMAGE_BYTES,
} from '../../../supabase/functions/_shared/builderStock/sourceAssets.pure';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const PACKAGE_IMAGES = readFileSync(join(REPO_ROOT,
  'supabase/functions/_shared/builderStock/packageImages.ts'), 'utf8');
const IMAGES = readFileSync(join(REPO_ROOT,
  'supabase/functions/_shared/builderStock/images.ts'), 'utf8');

/** Sizes measured against the live folder, in bytes. */
const MB = 1024 * 1024;
const LOT_13_PHOTOS_MB = [12.28, 14.55, 14.01, 13.77, 14.70, 14.45, 16.28, 15.99, 13.84, 13.25];

describe('a builder photograph too big to store is rescued, not discarded', () => {
  it('every measured Lot 13 photograph is over the store ceiling', () => {
    // The premise of the fix: falling through to the next file cannot work.
    for (const mb of LOT_13_PHOTOS_MB) {
      expect(mb * MB).toBeGreaterThan(MAX_SOURCE_IMAGE_BYTES);
    }
  });

  it('asks Drive for a smaller rendition of the SAME file', () => {
    const url = driveRenditionUrl('1W03E9_gyadHNwU1QBYDwqSRjMdqWAuw4', 1600);
    expect(url).toContain('drive.google.com/thumbnail');
    expect(url).toContain('id=1W03E9_gyadHNwU1QBYDwqSRjMdqWAuw4');
    expect(url).toContain('sz=w1600');
  });

  it('never substitutes a different photograph', () => {
    // Same id in, same id out. Provenance is unchanged by downscaling.
    const id = 'abc123XYZ_-';
    expect(driveRenditionUrl(id, 1600)).toContain(`id=${id}`);
  });

  it('bounds the width it will ask for', () => {
    expect(driveRenditionUrl('x', 10)).toContain('sz=w320');
    expect(driveRenditionUrl('x', 99999)).toContain('sz=w4096');
    expect(driveRenditionUrl('x', Number.NaN)).toContain('sz=w1600');
  });

  it('only reaches for a rendition when the original is over the ceiling', () => {
    expect(PACKAGE_IMAGES).toContain('fetched.bytes.length > MAX_SOURCE_IMAGE_BYTES');
  });

  it('keeps the original when the rendition is unusable, so nothing is lost', () => {
    // The replacement is conditional on being smaller AND within the ceiling.
    expect(PACKAGE_IMAGES).toContain('smaller.bytes.length <= MAX_SOURCE_IMAGE_BYTES');
    expect(PACKAGE_IMAGES).toContain('fetched = smaller;');
  });

  it('does not decode or re-encode the image in the worker', () => {
    // The worker has been killed for less. Drive does the resizing.
    expect(PACKAGE_IMAGES).not.toMatch(/imagescript|createCanvas|\bdecodeJpeg\b/i);
  });

  it('stays on Drive — no new host is introduced', () => {
    expect(driveRenditionUrl('x', 1600).startsWith('https://drive.google.com/')).toBe(true);
  });
});

describe('a panorama far from the house is not a photograph of it', () => {
  // Lot 1663 Ringer Street, Lara — the geocode production recorded.
  const property = { lat: -38.0229202, lng: 144.3964232 };
  /** ~35 m south: a camera on the roadway outside the dwelling. */
  const atTheFrontage = { lat: property.lat - 0.000315, lng: property.lng };
  /** ~350 m away: the arterial road this estate joins. */
  const downTheRoad = { lat: property.lat - 0.00315, lng: property.lng };

  it('accepts a camera at the frontage', () => {
    const verdict = assessPanoramaUsefulness(atTheFrontage, property);
    expect(verdict.usable).toBe(true);
    expect(verdict.distanceMetres).toBeLessThan(MAX_PANORAMA_DISTANCE_METRES);
  });

  it('refuses a panorama hundreds of metres away', () => {
    const verdict = assessPanoramaUsefulness(downTheRoad, property);
    expect(verdict.usable).toBe(false);
    expect(verdict.distanceMetres).toBeGreaterThan(300);
    expect(verdict.reason).toMatch(/too far to be a photograph of it/);
  });

  it('says how far, so the refusal can be checked', () => {
    const verdict = assessPanoramaUsefulness(downTheRoad, property);
    expect(verdict.reason).toContain(String(verdict.distanceMetres));
  });

  it('accepts a panorama whose location Google did not state', () => {
    // The behaviour that shipped. A missing optional field must not blank a
    // card that is working today.
    expect(assessPanoramaUsefulness(null, property).usable).toBe(true);
    expect(assessPanoramaUsefulness(null, property).distanceMetres).toBeNull();
  });

  it('the boundary is generous enough for a real frontage', () => {
    // Ten to twenty metres of setback plus the roadway must never be refused.
    const setback = { lat: property.lat - 0.00018, lng: property.lng };
    expect(metresBetween(setback, property)).toBeLessThan(25);
    expect(assessPanoramaUsefulness(setback, property).usable).toBe(true);
  });
});

describe('the Street View stage applies the guard and records its evidence', () => {
  it('refuses before spending on the still', () => {
    const guard = IMAGES.indexOf('assessPanoramaUsefulness(');
    const fetchStill = IMAGES.indexOf("maps/api/streetview?");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(fetchStill);
  });

  it('records the refusal as unavailable rather than as an image', () => {
    expect(IMAGES).toContain("recordStageUnavailable(\n        db, item, 'google_maps', 'unavailable', usefulness.reason, 'google')");
  });

  it('does not fall back to a satellite tile to fill the gap', () => {
    // A tile is a roof. `imagePriority` ranks only `streetview`, and blank is
    // the honest answer.
    expect(IMAGES).toContain('staticmap');
    expect(IMAGES).not.toMatch(/usefulness[\s\S]{0,200}staticmap/);
  });

  it('records where the camera was and which way it looked', () => {
    for (const key of [
      'panorama_latitude', 'panorama_longitude', 'panorama_distance_metres', 'heading,',
    ]) {
      expect(IMAGES).toContain(key);
    }
  });

  it('leaves the satellite rule, fov and pitch alone', () => {
    expect(IMAGES).toContain("fov: '80', pitch: '0'");
    expect(IMAGES).toContain("product = 'streetview'");
  });
});
