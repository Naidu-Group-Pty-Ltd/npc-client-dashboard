/**
 * BUILDER STOCK — THE CARD SHOWED A ROAD.
 *
 * PRODUCTION, 30 AUGUST 2026. A house-and-land package whose brochure carries a
 * finished render was served a Street View still of an empty rural road. The
 * numbers behind it: of 76 cards holding a picture, 58 were Street View and
 * NOT ONE was a web result. Every real photograph came from a builder document
 * on a different list.
 *
 * Three faults, and each on its own put the wrong picture on the screen.
 *
 * ONE — THE VETO OUTRANKED THE EVIDENCE. The correct image WAS found. Its own
 * URL read `…/lot-310-<estate>-<suburb>-<postcode>-vic.jpg` and its title said
 * the same. It was refused `generic_estate_page` because the page also carried
 * the words "house and land packages" — which sits beside every individual
 * listing on every builder's site. The veto was checked before any evidence was
 * gathered and returned outright.
 *
 * TWO — A VERDICT WAS NEVER REVISITED. 14 candidates were refused
 * `no_location_evidence` because the property held no suburb at the moment they
 * were found. The suburb was recovered minutes later from the raw row, and
 * nothing ever asked again.
 *
 * THREE — STREET VIEW STOOD IN FOR A HOUSE THAT DOES NOT EXIST. A lot in a new
 * estate has no building on it. The camera photographs dirt, and that is not
 * "no picture available" — it is the wrong picture, handed to a client as
 * their property.
 *
 * Written on invented data. No estate, lot, suburb, builder, organisation or
 * URL here belongs to any deployment.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { verifyWebImageIdentity } from '../../../supabase/functions/_shared/builderStock/webImageIdentity.pure';
import { hasPhotographableStreetAddress } from '../../../supabase/functions/_shared/builderStock/normalise.pure';

const PROPERTY = {
  addressLine: null,
  lotNumber: '310',
  unitNumber: null,
  developmentName: 'Sample Reach',
  projectName: null,
  suburb: 'Northfield',
  state: 'VIC',
  postcode: '3427',
  builderName: 'Sample Homes',
  designName: null,
};

describe('a page that names THIS lot is about this property', () => {
  it('marketing boilerplate no longer discards the builder\'s own image', () => {
    /*
     * The exact shape that was thrown away: the image file, the page title and
     * the URL all name the lot, the estate, the suburb and the postcode — and
     * the page also carries the phrase every builder site carries.
     */
    const verdict = verifyWebImageIdentity({
      imageUrl: 'https://example.invalid/uploads/lot-310-sample-reach-northfield-3427-vic.jpg',
      pageUrl: 'https://example.invalid/house-and-land-packages/lot-310-sample-reach',
      title: 'LOT 310 Sample Reach, Northfield 3427 VIC',
      snippet: 'View our house and land packages across Melbourne.',
    }, PROPERTY);
    expect(verdict.ok).toBe(true);
    expect(verdict.matched).toEqual(expect.arrayContaining(['lot', 'development', 'suburb']));
  });

  it('and the veto still bites where nothing pinned the candidate', () => {
    // The case it was written for: the estate's own marketing picture, of no
    // particular house. Matching more fields does not make it more specific.
    const verdict = verifyWebImageIdentity({
      imageUrl: 'https://example.invalid/uploads/sample-reach-hero.jpg',
      pageUrl: 'https://example.invalid/our-estates/sample-reach',
      title: 'Sample Reach, Northfield — house and land packages',
    }, PROPERTY);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('generic_estate_page');
  });

  it('a page naming a DIFFERENT lot is still refused outright', () => {
    // Unchanged, and the most dangerous wrong answer on a new estate.
    const verdict = verifyWebImageIdentity({
      imageUrl: 'https://example.invalid/uploads/lot-42-sample-reach.jpg',
      title: 'Lot 42 Sample Reach, Northfield 3427 VIC',
    }, PROPERTY);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('names_a_different_lot');
  });

  it('a floorplan is still refused however well it names the lot', () => {
    // The subject test runs before any of this and is untouched.
    const verdict = verifyWebImageIdentity({
      imageUrl: 'https://example.invalid/uploads/lot-310-sample-reach-floorplan.jpg',
      title: 'Lot 310 Sample Reach, Northfield 3427 VIC floorplan',
    }, PROPERTY);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/^subject_not_a_facade/);
  });

  it('the veto is evaluated AFTER the evidence, not before it', () => {
    const source = readFileSync(
      'supabase/functions/_shared/builderStock/webImageIdentity.pure.ts', 'utf8');
    const gather = source.indexOf('const named = [...new Set(lotsNamedIn(pageHaystack))]');
    const veto = source.indexOf("reason: 'generic_estate_page'");
    expect(gather).toBeGreaterThan(-1);
    expect(veto).toBeGreaterThan(gather);
  });

  it('reads the lot from the PAGE and never from the image file name', () => {
    /*
     * THE LIVE DEFECT. Luxton's Lot 818 was given a render from a page about
     * Lot 118 by Simonds Homes, because the image was FILED as `…lot-818…`
     * and the old haystack merged the two. The page is what says which
     * property is being described.
     */
    const verdict = verifyWebImageIdentity({
      imageUrl: 'https://cdn.example.invalid/images/sample-reach-lot-310-render.jpg',
      pageUrl: 'https://example.invalid/sample-reach/house-land/lot-118-by-another-builder-52221',
      title: 'Sample Reach, Northfield – lot/render image',
    }, PROPERTY);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('names_a_different_lot');
  });

  it('refuses a page that names OUR lot and somebody else\'s together', () => {
    // One page, one property. A comparison table has identified nothing.
    const verdict = verifyWebImageIdentity({
      imageUrl: 'https://example.invalid/uploads/sample-reach.jpg',
      pageUrl: 'https://example.invalid/sample-reach/lot-310-and-lot-118',
      title: 'Lot 310 and Lot 118, Sample Reach, Northfield 3427 VIC',
    }, PROPERTY);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('names_a_different_lot');
  });
});

describe('an identity that improves reaches the pictures already found', () => {
  it('the same candidate that failed on a missing suburb passes once it has one', () => {
    const candidate = {
      imageUrl: 'https://example.invalid/uploads/lot-310-sample-reach-northfield.jpg',
      title: 'LOT 310 Sample Reach, Northfield 3427 VIC',
    };
    const beforeRepair = verifyWebImageIdentity(candidate, { ...PROPERTY, suburb: null, postcode: null });
    expect(beforeRepair.ok).toBe(false);
    expect(beforeRepair.reason).toBe('no_location_evidence');

    // …and the property later recovers its locality from its own raw row.
    expect(verifyWebImageIdentity(candidate, PROPERTY).ok).toBe(true);
  });

  it('the re-judgement spends nothing and defers to the one authority', () => {
    const source = readFileSync(
      'supabase/functions/_shared/builderStock/reverifyWebImages.ts', 'utf8');
    // No search, no fetch, no model — the evidence was stored when it was found.
    expect(source).not.toMatch(/\bfetch\(/);
    expect(source).not.toMatch(/perplexity|openai|llmRouter/i);
    // One authority, imported rather than re-implemented.
    expect(source).toContain("from './webImageIdentity.pure.ts'");
  });

  it('a VERIFIED candidate the current rule refuses is taken back, with the reason written', () => {
    /*
     * "Only ever promotes" stood until the accepting rule itself was wrong:
     * Lot 818's verified render came from a page about lot 118 by another
     * builder, and a promote-only re-judgement could never reach the one card
     * the rule change existed for. Demotion is deterministic — judged from the
     * same stored evidence the acceptance was — and it must write WHY.
     */
    const source = readFileSync(
      'supabase/functions/_shared/builderStock/reverifyWebImages.ts', 'utf8');
    expect(source).toMatch(/!verdict\.ok && row\.verification_status === WEB_VERIFIED_VERIFICATION/);
    expect(source).toContain("verification_status: 'unverified'");
    expect(source).toContain('identity_refused: verdict.reason');
    // And an already-verified candidate the rule still ACCEPTS is left alone.
    expect(source).toContain('=== WEB_VERIFIED_VERIFICATION) continue');
  });

  it('it runs inside the claim, after identity is repaired', () => {
    const settler = readFileSync(
      'supabase/functions/_shared/builderStock/settleItemImages.ts', 'utf8');
    const identity = settler.indexOf('await ensureCanonicalIdentity(');
    const reverify = settler.indexOf('await reverifyWebImagesFor(');
    expect(identity).toBeGreaterThan(-1);
    expect(reverify).toBeGreaterThan(identity);
  });

  it('and the stage machine still names no module that decides what a picture IS', () => {
    const settler = readFileSync(
      'supabase/functions/_shared/builderStock/settleItemImages.ts', 'utf8');
    for (const untouched of ['drivePackage', 'streetViewHeading', 'imagePriority',
      'webImageIdentity', 'sanitizeImage', 'normalise.pure']) {
      expect(settler).not.toContain(untouched);
    }
  });
});

describe('Street View photographs the ground, so there has to be something on it', () => {
  it('a property the source addressed may be photographed', () => {
    expect(hasPhotographableStreetAddress({ address_line: '12 Wattle Street' })).toBe(true);
  });

  it('a lot in an estate may not — the camera would see the land', () => {
    // `geocodableAddress` will still COMPOSE a line for this property, because
    // naming it to a search is a different act from pointing a camera at it.
    expect(hasPhotographableStreetAddress({ address_line: null })).toBe(false);
    expect(hasPhotographableStreetAddress({ address_line: '   ' })).toBe(false);
  });

  it('the refusal is an ANSWER, so the ladder settles instead of re-buying it', () => {
    const source = readFileSync(
      'supabase/functions/_shared/builderStock/images.ts', 'utf8');
    const guard = source.indexOf('if (!hasPhotographableStreetAddress(item))');
    expect(guard).toBeGreaterThan(-1);
    expect(source.slice(guard, guard + 420)).toMatch(/'google', true\)/);
  });

  it('it is checked before anything is spent on Google', () => {
    const source = readFileSync(
      'supabase/functions/_shared/builderStock/images.ts', 'utf8');
    const guard = source.indexOf('if (!hasPhotographableStreetAddress(item))');
    const geocode = source.indexOf('maps/api/geocode/json');
    expect(guard).toBeLessThan(geocode);
  });

  it('stage 2 is untouched by it — a render of the design is a fair reference', () => {
    const source = readFileSync(
      'supabase/functions/_shared/builderStock/images.ts', 'utf8');
    const guard = source.indexOf('if (!hasPhotographableStreetAddress(item))');
    // The guard lives inside the Google path…
    expect(source.slice(0, guard)).toContain('export async function enrichFromGoogle');
    // …and the search path never consults it.
    const searchStart = source.indexOf('async function enrichFromInternetSearch');
    expect(searchStart).toBeGreaterThan(guard);
    expect(source.slice(searchStart)).not.toContain('hasPhotographableStreetAddress');
  });
});

describe('the migration retires the pictures taken under the old rule', () => {
  const migration = readFileSync(
    'supabase/migrations/20261028000000_builder_stock_retire_unbuilt_streetview.sql', 'utf8');

  it('scoped by the rule itself and never by an id', () => {
    expect(migration).toMatch(/source_stage = 'google_maps'/);
    expect(migration).toMatch(/btrim\(i\.address_line\), ''\) = ''/);
    const withoutComments = migration
      .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*--.*$/gm, ' ');
    expect(withoutComments).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
    expect(withoutComments).not.toMatch(/https?:\/\//);
  });

  it('clears the pointer before deleting, or the key refuses', () => {
    expect(migration.indexOf('SET primary_image_id = NULL'))
      .toBeLessThan(migration.indexOf('DELETE FROM public.builder_stock_item_images'));
  });

  it('reaches nothing but location imagery', () => {
    for (const spared of ['uploaded_document', 'internet_search']) {
      expect(migration).not.toContain(`'${spared}'`);
    }
  });

  it('takes the PRODUCT, not the whole stage — tiles and bookkeeping survive', () => {
    /*
     * A dry-run against production before merge showed `source_stage =
     * 'google_maps'` alone selecting 145 rows rather than 58: 7 satellite
     * tiles the stage deliberately retains (and which `imagePriority` can
     * never rank as a card image anyway), plus 80 `stage-status` /
     * `stage-skipped` bookkeeping rows the generation re-open already handles.
     * Only the stills are a wrong picture on a card.
     */
    expect(migration).toMatch(/x\.source_reference = 'streetview'/);
    expect(migration).toMatch(/x\.source_detail->>'product' = 'streetview'/);
    // Both halves of the statement, so the pointer clear cannot be broader
    // than the delete it precedes.
    expect(migration.match(/source_detail->>'product' = 'streetview'/g) ?? [])
      .toHaveLength(2);
    expect(migration).not.toContain("'staticmap'");
  });

  it('raises the generation so the ladder looks again, and wakes the scheduler', () => {
    expect(migration).toContain('image_ladder_generation_at = now()');
    expect(migration).toContain('ensure_builder_stock_settlement_scheduled');
  });

  it('a property the source addressed keeps every Street View it has', () => {
    // The predicate is the address, so an addressed property is unreachable.
    expect(migration).toMatch(/AND coalesce\(btrim\(i\.address_line\), ''\) = ''/);
  });
});
