/**
 * Builder stock — the FOURTH question, and the one the card actually asks.
 *
 * WHAT WAS MEASURED IN PRODUCTION. Two Marketplace cards showed the property's
 * own facade under promotional pills — "Completed" and "SMSF" on Lot 13
 * Hummock Rise, "$25,000 Rebate", "VIC" and "LARA" on Lot 1663 Ringer Street.
 * The source audit proved every provenance claim behind them: the stored bytes
 * and the Notion attachment hash identically, the row designates that image and
 * no other, and no clean original exists anywhere in either property's chain.
 *
 * So provenance, ownership and role all answer YES and the card is still
 * wrong, which is why display eligibility is a fourth question with its own
 * answer stored beside the other three. The role stays `primary_property` —
 * that is what the source said, and falsifying it to hide the picture would
 * put a lie in the audit trail.
 *
 * TWO THINGS THESE PIN ABOVE ALL.
 *
 *   IT FAILS CLOSED. An image nothing could decode is `pending`, never
 *   `eligible`. "We could not look" and "we looked and it was clean" are
 *   different facts, and a container no decoder here reads must never be a way
 *   for a marketing tile to walk past the rule.
 *
 *   IT IS A PIPELINE RULE, NOT A REPAIR. Every future import of every
 *   supported format asks the same question of the same bytes at the same
 *   point, persists the same answer, and both selectors read it. No property,
 *   filename, word, colour, font or position is named anywhere in the
 *   implementation.
 *
 * The fixtures are drawn rather than sampled, and drawn to the geometry the
 * live tiles actually have: a flat block with straight sides, and lettering
 * set on a common baseline, over a photograph with grain in it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

import {
  measureFlatColourRegions, measureOverlayText, readMarketingOverlay,
} from '../../../supabase/functions/_shared/builderStock/marketingOverlay.pure';
import {
  decideMarketplaceEligibility, isMarketplaceEligible, marketplaceEligibilityDetail,
  needsEligibilityAssessment, readEligibilityVersion, readMarketplaceState, unmeasured,
  MARKETPLACE_ELIGIBILITY_VERSION,
} from '../../../supabase/functions/_shared/builderStock/marketplaceEligibility.pure';
import {
  SANITIZATION_VERSION,
} from '../../../supabase/functions/_shared/builderStock/sanitizedDerivative.pure';
import {
  assessMarketplaceEligibility, eligibilityDetailFor,
} from '../../../supabase/functions/_shared/builderStock/assessSourceImage';
import {
  decodeThumbnailResult, DECODABLE_CONTAINERS,
} from '../../../supabase/functions/_shared/builderStock/sourceImageRaster';
import {
  chooseDisplayableImage, isDisplayableSourceImage,
} from '../../../supabase/functions/_shared/builderStock/primaryImage';
import {
  eligibilitySweepCompleted, settleMarketplaceEligibility,
} from '../../../supabase/functions/_shared/builderStock/settleMarketplaceEligibility';
import {
  readOutstandingUploads, uploadHasWorkOutstanding, SETTLEMENT_TARGET_TABLE,
} from '../../../supabase/functions/_shared/builderStock/settleSourceImages';
import { decodeWebp } from '../../../supabase/functions/_shared/builderStock/webp';
import { lossyWebpOf } from './fixtures/vp8Encoder';
import { primaryStockImage } from '../../lib/builderStock';
import {
  annotatedPicture, cleanPicture, jpegOf, losslessWebpOf, photograph, withCaption,
  withPlate, type Picture,
} from './fixtures/builderStockPictures';
import type { BuilderStockImage, BuilderStockItem } from '../../lib/builderStock';

// ---------------------------------------------------------------------------
// Fixtures — pictures, drawn
//
// The picture itself and the treatments laid over it come from
// `fixtures/builderStockPictures`, which the pipeline tests share. The
// arrangements below are this file's own: each one is a shape the classifier
// has to reach a stated verdict on.
// ---------------------------------------------------------------------------

const W = 400;
const H = 200;

/** The organisation every fixture row belongs to. */
const ORG = 'org-a';

const LIME: [number, number, number] = [193, 255, 114];
const CLEAN = photograph();
/** The verdict a measured, clean picture carries. Measured, never typed. */
const CLEAN_DETAIL = marketplaceEligibilityDetail(
  decideMarketplaceEligibility(readMarketingOverlay(CLEAN)));

/** A banner of any colour, with a caption on it. */
const banner = (plate: [number, number, number], ink: [number, number, number]) =>
  withCaption(withPlate(CLEAN, { x: 14, y: 10, w: 230, h: 34 }, plate),
    'SOLERA', { x: 20, y: 16, scale: 3, ink });

const MARKETING_TILE = banner(LIME, [10, 10, 10]);
const BLACK_BANNER = banner([12, 12, 12], [250, 250, 250]);
const WHITE_BANNER = banner([250, 250, 250], [20, 20, 20]);
const GREY_BANNER = banner([128, 128, 130], [250, 250, 250]);
/** A builder's own corner tag: the same colour as a refused pill, a fraction
 *  of the size. */
const SMALL_TAG = withCaption(withPlate(CLEAN, { x: 6, y: 5, w: 60, h: 12 }, LIME),
  'ORAL', { x: 9, y: 7, scale: 1, ink: [10, 10, 10] });
/** An "artist impression" footer: neutral, small, and at the foot. */
const DISCLAIMER = withCaption(withPlate(CLEAN, { x: 250, y: 184, w: 140, h: 12 }, [38, 38, 40]),
  'ARSOLE', { x: 254, y: 186, scale: 1, ink: [235, 235, 235] });
/** Letterboxing: flat, neutral, perfectly straight, and pure framing. */
const LETTERBOXED = withPlate(withPlate(CLEAN, { x: 0, y: 0, w: 26, h: H }, [255, 255, 255]),
  { x: W - 26, y: 0, w: 26, h: H }, [255, 255, 255]);

// ---------------------------------------------------------------------------
// What the measurement reads, and what it refuses to read
// ---------------------------------------------------------------------------

describe('the measurement', () => {
  it('finds a coloured pill laid over the photograph', () => {
    expect(readMarketingOverlay(MARKETING_TILE).annotated).toBe(true);
    expect(measureFlatColourRegions(MARKETING_TILE).regions.length).toBeGreaterThan(0);
  });

  it('TEST T/U/V — a black, white or grey banner is refused too', () => {
    // Colour decides nothing. A neutral banner has to be larger before it
    // counts, because neutral is what ordinary presentation is drawn in, and
    // every one of these clears that.
    for (const view of [BLACK_BANNER, WHITE_BANNER, GREY_BANNER]) {
      expect(readMarketingOverlay(view).annotated).toBe(true);
    }
  });

  it('TEST Y — an artist-impression footer stays', () => {
    expect(readMarketingOverlay(DISCLAIMER).annotated).toBe(false);
  });

  it('TEST Z — a small builder tag or watermark stays', () => {
    // Exactly the colour of the pill that is refused, a fraction of the size.
    expect(readMarketingOverlay(SMALL_TAG).annotated).toBe(false);
  });

  it('a clean render, and letterboxing around one, stay', () => {
    expect(readMarketingOverlay(CLEAN).annotated).toBe(false);
    // Framing is not a badge: a band spanning the picture is excluded by
    // measurement rather than by knowing what letterboxing is.
    expect(readMarketingOverlay(LETTERBOXED).annotated).toBe(false);
  });

  it('reads lettering as shape and never as words', () => {
    const source = readFileSync(
      'supabase/functions/_shared/builderStock/marketingOverlay.pure.ts', 'utf8');
    // Comments describe the live case and quote its wording; the code may not.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');
    // No string or regular-expression literal of any kind: nothing to compare
    // a word, a hex colour or a font name against.
    expect(code).not.toMatch(/['"`]/);
    expect(code).not.toMatch(/\/[^\s/][^\n]*\/[gimsuy]*/);
  });

  it('the text signal is separate, and silent on a clean photograph', () => {
    // Two independent signals, either of which is enough. On the live source
    // it is the text signal that catches Lot 13 and Lot 1663; on the drawn
    // fixtures here it is the block signal, because drawn type is not
    // photographed type. What matters in both is that a clean photograph
    // trips neither.
    expect(measureOverlayText(CLEAN).lineCount).toBe(0);
    expect(measureOverlayText(CLEAN).heightShare).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Decoding, and failing closed
// ---------------------------------------------------------------------------

describe('what happens when the pixels cannot be read', () => {
  const webp = () => {
    const bytes = new Uint8Array(64);
    bytes.set([0x52, 0x49, 0x46, 0x46], 0);          // RIFF
    bytes.set([0x57, 0x45, 0x42, 0x50], 8);          // WEBP
    bytes.set([0x56, 0x50, 0x38, 0x20], 12);         // VP8␣
    return bytes;
  };

  it('TEST Q — a container nothing here reads is pending and hidden', async () => {
    // A TIFF: a real image format, and not one of the four. The point is the
    // FAIL-CLOSED path rather than the format — an unreadable container must
    // never be a way past the display rule.
    const tiff = Uint8Array.from([0x49, 0x49, 0x2a, 0x00, ...new Array(4096).fill(0x40)]);
    const result = await decodeThumbnailResult(tiff);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('unsupported');

    const decision = await assessMarketplaceEligibility(tiff);
    expect(decision.state).toBe('pending');
    expect(decision.measured).toBe(false);
    expect(decision.reason).toBe('decoder_unsupported');
    expect(isMarketplaceEligible(marketplaceEligibilityDetail(decision))).toBe(false);
  });

  it('TEST R — a progressive JPEG IS decoded, so it is judged rather than waved through', async () => {
    // A real progressive file, from this repository.
    const progressive = readFileSync('public/brand/aurixa-source.jpg');
    const result = await decodeThumbnailResult(new Uint8Array(progressive));
    expect(result.ok).toBe(true);
    const decision = await assessMarketplaceEligibility(new Uint8Array(progressive));
    expect(decision.measured).toBe(true);
    expect(decision.state === 'eligible' || decision.state === 'ineligible').toBe(true);
  });

  it('TEST S — an unsupported container is never eligible', async () => {
    const decision = await assessMarketplaceEligibility(
      new TextEncoder().encode('<html>not an image at all</html>'));
    expect(decision.state).toBe('pending');
    expect(isMarketplaceEligible(marketplaceEligibilityDetail(decision))).toBe(false);
  });

  it('TEST AA — a decoder error leaves the row stored and the card empty', async () => {
    // A PNG signature with a truncated body: the decoder starts and fails.
    const broken = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const decision = await assessMarketplaceEligibility(broken);
    expect(decision.measured).toBe(false);
    expect(decision.state).toBe('pending');
    // The import is unaffected: this never throws.
    expect(await eligibilityDetailFor(broken, 'primary_property'))
      .toMatchObject({ marketplace_display_eligible: false });
  });

  it('names the containers it can actually read', () => {
    expect(DECODABLE_CONTAINERS)
      .toEqual(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  });
});

// ---------------------------------------------------------------------------
// The stored decision
// ---------------------------------------------------------------------------

describe('the decision is stored beside the role, never instead of it', () => {
  it('an annotated primary keeps its role and loses its eligibility', () => {
    const decision = decideMarketplaceEligibility(readMarketingOverlay(MARKETING_TILE));
    expect(decision.state).toBe('ineligible');
    expect(decision.reason).toBe('annotated_marketing_tile');

    const detail: Record<string, unknown> = { role: 'primary_property', ...marketplaceEligibilityDetail(decision) };
    expect(detail.role).toBe('primary_property');
    expect(detail.marketplace_display_eligible).toBe(false);
    expect(detail.marketplace_eligibility_state).toBe('ineligible');
    expect(detail.marketplace_eligibility_version).toBe(MARKETPLACE_ELIGIBILITY_VERSION);
  });

  it('an unjudged image is pending, which is not eligible', () => {
    expect(readMarketplaceState({ role: 'primary_property' })).toBe('pending');
    expect(isMarketplaceEligible({ role: 'primary_property' })).toBe(false);
    expect(needsEligibilityAssessment({ role: 'primary_property' })).toBe(true);
  });

  it('TEST AD — a version bump brings every old decision back for re-audit', () => {
    const settled = marketplaceEligibilityDetail(
      decideMarketplaceEligibility(readMarketingOverlay(CLEAN)));
    expect(needsEligibilityAssessment(settled)).toBe(false);
    // The same row, judged under an older algorithm, is outstanding again —
    // without re-uploading anything or touching the source bytes.
    const older = { ...settled, marketplace_eligibility_version: MARKETPLACE_ELIGIBILITY_VERSION - 1 };
    expect(readEligibilityVersion(older)).toBe(MARKETPLACE_ELIGIBILITY_VERSION - 1);
    expect(needsEligibilityAssessment(older)).toBe(true);
  });

  /**
   * TEST AE — a pending row is HIDDEN, and is not work to be redone.
   *
   * These are two different statements and the code used to make only one of
   * them. `pending` still refuses to display, which is the whole point of the
   * third state; what it no longer does is come back on every tick. A better
   * decoder or a better classifier arrives with a version bump, never between
   * two ticks of the same one — so retrying under the same version re-downloaded
   * and re-refused the same object every five minutes for ever, while the
   * upload's own marker said its eligibility work was complete. The two
   * statements contradicted each other and the sweep could never go quiet.
   */
  it('TEST AE — a current-version pending row is hidden and not retried', () => {
    const pending = marketplaceEligibilityDetail(unmeasured('decoder_unsupported'));
    expect(readEligibilityVersion(pending)).toBe(MARKETPLACE_ELIGIBILITY_VERSION);
    expect(isMarketplaceEligible(pending)).toBe(false);
    expect(needsEligibilityAssessment(pending)).toBe(false);
  });

  it('TEST AF — and a version bump brings it back for a real second look', () => {
    const pending = {
      ...marketplaceEligibilityDetail(unmeasured('decoder_unsupported')),
      marketplace_eligibility_version: MARKETPLACE_ELIGIBILITY_VERSION - 1,
    };
    expect(needsEligibilityAssessment(pending)).toBe(true);
    expect(isMarketplaceEligible(pending)).toBe(false);
  });

  it('and an ineligible row is equally terminal until the version moves', () => {
    const refused = marketplaceEligibilityDetail(
      decideMarketplaceEligibility(readMarketingOverlay(MARKETING_TILE)));
    expect(needsEligibilityAssessment(refused)).toBe(false);
    expect(needsEligibilityAssessment({
      ...refused, marketplace_eligibility_version: MARKETPLACE_ELIGIBILITY_VERSION - 1,
    })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The display gate
// ---------------------------------------------------------------------------

type Candidate = Parameters<typeof isDisplayableSourceImage>[0];

const withDecision = (view: Picture, over: Partial<Candidate> = {}, level = 3): Candidate => ({
  id: 'image-1',
  source_stage: 'uploaded_document',
  verification_status: 'source_supplied',
  processing_status: 'ready',
  storage_path: 'org/items/item-1/source/a.png',
  position: 0,
  ...over,
  source_detail: {
    role: 'primary_property',
    role_evidence_level: level,
    ...marketplaceEligibilityDetail(decideMarketplaceEligibility(readMarketingOverlay(view))),
  },
});

const eligible = (over: Partial<Candidate> = {}, level = 3) => withDecision(CLEAN, over, level);
const rejected = (over: Partial<Candidate> = {}, level = 3) =>
  withDecision(MARKETING_TILE, over, level);
const unjudged = (over: Partial<Candidate> = {}): Candidate => ({
  ...eligible(over),
  source_detail: { role: 'primary_property', role_evidence_level: 3 },
});
const otherRole = (role: string): Candidate => ({
  ...eligible({ id: `image-${role}` }),
  source_detail: {
    role,
    role_evidence_level: 1,
    ...marketplaceEligibilityDetail(decideMarketplaceEligibility(readMarketingOverlay(CLEAN))),
  },
});

describe('the display gate', () => {
  it('TEST A/D/I — the only primary is a marketing tile: no image at all', () => {
    const tile = rejected({ id: 'tile' });
    expect(tile.source_detail!.role).toBe('primary_property');
    expect(isDisplayableSourceImage(tile)).toBe(false);
    expect(chooseDisplayableImage([tile])).toBeNull();
  });

  it('TEST B/E/G — an annotated primary beside a clean one: the clean one wins', () => {
    const tile = rejected({ id: 'tile', position: 0 }, 3);
    const clean = eligible({ id: 'clean', position: 9 }, 1);
    expect(chooseDisplayableImage([tile, clean])!.id).toBe('clean');
    expect(chooseDisplayableImage([clean, tile])!.id).toBe('clean');
  });

  it('TEST C/F/H — a clean builder primary is displayed', () => {
    expect(chooseDisplayableImage([eligible({ id: 'hero' }, 2)])!.id).toBe('hero');
  });

  it('the source evidence still orders two eligible candidates', () => {
    const cover = eligible({ id: 'cover', position: 0 }, 3);
    const field = eligible({ id: 'field', position: 9 }, 1);
    expect(chooseDisplayableImage([cover, field])!.id).toBe('field');
  });

  it('TEST J/K — a rejected primary never falls through to another role', () => {
    const tile = rejected({ id: 'tile' });
    for (const role of ['interior', 'floorplan', 'masterplan', 'location_map',
      'site_plan', 'materials', 'logo_decorative', 'property_secondary', 'unknown']) {
      expect(chooseDisplayableImage([tile, otherRole(role)])).toBeNull();
    }
  });

  it('TEST L — a rejected primary beside Google and search rows shows nothing', () => {
    const google = { ...eligible({ id: 'google' }), source_stage: 'google_maps',
      verification_status: 'location_derived' } as Candidate;
    const search = { ...eligible({ id: 'search' }), source_stage: 'internet_search',
      verification_status: 'unverified' } as Candidate;
    expect(chooseDisplayableImage([rejected({ id: 'tile' }), google, search])).toBeNull();
  });

  it('TEST O — an unjudged legacy image never outranks a judged one, and never shows', () => {
    const legacy = unjudged({ id: 'legacy', position: 0 });
    const judged = eligible({ id: 'judged', position: 9 });
    expect(chooseDisplayableImage([legacy, judged])!.id).toBe('judged');
    // And on its own it shows nothing: unjudged is not clean.
    expect(chooseDisplayableImage([legacy])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Server and client agree
// ---------------------------------------------------------------------------

describe('the client applies the identical rule', () => {
  const asImage = (c: Candidate): BuilderStockImage => ({
    id: c.id,
    stock_item_id: 'item-1',
    source_stage: c.source_stage as BuilderStockImage['source_stage'],
    source_reference: null, source_provider: null, source_page_url: null, external_url: null,
    storage_path: c.storage_path ?? null,
    content_type: 'image/png',
    verification_status: c.verification_status as BuilderStockImage['verification_status'],
    confidence: 1,
    processing_status: c.processing_status as BuilderStockImage['processing_status'],
    error_message: null,
    position: c.position ?? 0,
    source_detail: c.source_detail ?? null,
    created_at: '2026-08-18T00:00:00Z',
  });
  const item = (images: Candidate[], primaryId: string | null = null): BuilderStockItem => ({
    id: 'item-1', primary_image_id: primaryId, images: images.map(asImage),
  } as unknown as BuilderStockItem);

  it('hides a rejected tile even when the server still points at it', () => {
    expect(primaryStockImage(item([rejected({ id: 'tile' })], 'tile'))).toBeNull();
  });

  it('hides an unjudged image even when the server still points at it', () => {
    expect(primaryStockImage(item([unjudged({ id: 'legacy' })], 'legacy'))).toBeNull();
  });

  it('picks the same image the server picks', () => {
    const tile = rejected({ id: 'tile', position: 0 }, 3);
    const clean = eligible({ id: 'clean', position: 9 }, 1);
    expect(primaryStockImage(item([tile, clean]))!.id)
      .toBe(chooseDisplayableImage([tile, clean])!.id);
  });

  it('reads the stored verdict rather than measuring anything', () => {
    const source = readFileSync('src/lib/builderStock.ts', 'utf8');
    expect(source).not.toMatch(
      /decodeThumbnail|measureFlatColourRegions|measureOverlayText|readMarketingOverlay/);
  });
});

// ---------------------------------------------------------------------------
// Settlement of what is already stored
// ---------------------------------------------------------------------------

/** A database with enough of PostgREST's shape to run a keyset scan. */
function fakeDb(rows: Array<Record<string, any>>, objects: Record<string, Uint8Array>) {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  /** Set by a test to make every verdict write fail, as a database would. */
  const state = { failWrites: false };
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
    updates,
    set failWrites(value: boolean) { state.failWrites = value; },
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
                  updates.push({ id: row.id, patch });
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
        };
      },
    },
  };
}

describe('TEST AB — settlement reaches every outstanding row', () => {
  it('walks past thousands of settled rows to the one that is not', async () => {
    const { encodePng } = await import(
      '../../../supabase/functions/_shared/builderStock/rasterPng');
    const tile = (await encodePng(MARKETING_TILE.pixels,
      { width: W, height: H, components: 3 }))!;

    // Measured once: judging a clean picture 5,200 times is a test that
    // measures the test.
    const settledDetail = marketplaceEligibilityDetail(
      decideMarketplaceEligibility(readMarketingOverlay(CLEAN)));

    const rows: Array<Record<string, any>> = [];
    // 5,200 rows already judged, so an in-memory filter over the first page
    // would see nothing to do and stop for ever.
    for (let i = 0; i < 5_200; i++) {
      rows.push({
        id: `image-${String(i).padStart(6, '0')}`,
        organisation_id: 'org-a',
        source_stage: 'uploaded_document',
        verification_status: 'source_supplied',
        processing_status: 'ready',
        storage_bucket: 'builder-stock-images',
        storage_path: null,
        source_detail: { role: 'primary_property', ...settledDetail },
      });
    }
    // And one, last by id, that has never been judged.
    rows.push({
      id: 'image-999999',
      organisation_id: 'org-a',
      source_stage: 'uploaded_document',
      verification_status: 'source_supplied',
      processing_status: 'ready',
      storage_bucket: 'builder-stock-images',
      storage_path: 'org-a/items/item-z/source/tile.png',
      source_detail: { role: 'primary_property' },
    });

    const db = fakeDb(rows, { 'org-a/items/item-z/source/tile.png': tile });
    const outcome = await settleMarketplaceEligibility(db as any, 'org-a');

    expect(outcome.scanned).toBe(5_201);
    expect(outcome.outstanding).toBe(1);
    expect(outcome.assessed).toBe(1);
    expect(outcome.rejected).toBe(1);
    expect(rows[rows.length - 1].source_detail.marketplace_display_eligible).toBe(false);
  });
});

describe('TEST AC — the autonomous settler picks up eligibility work on its own', () => {
  it('treats an upload at the current provenance version as outstanding', () => {
    // Exactly the state every existing upload is in the moment this ships:
    // its imagery has been settled, and its display eligibility has not.
    expect(uploadHasWorkOutstanding({
      source_images_settled_version: 4,
      marketplace_eligibility_settled_version: null,
    })).toBe(true);
  });

  it('stops only when ALL THREE markers are current', () => {
    expect(uploadHasWorkOutstanding({
      source_images_settled_version: 4,
      marketplace_eligibility_settled_version: MARKETPLACE_ELIGIBILITY_VERSION,
      image_sanitization_settled_version: SANITIZATION_VERSION,
    })).toBe(false);
    expect(uploadHasWorkOutstanding({
      source_images_settled_version: null,
      marketplace_eligibility_settled_version: MARKETPLACE_ELIGIBILITY_VERSION,
      image_sanitization_settled_version: SANITIZATION_VERSION,
    })).toBe(true);
    // And the third, which is the overlay repair: a picture the gate refused
    // for carrying a laid-over graphic can have the graphic taken off, and an
    // upload never offered to that repair is outstanding however current the
    // other two are.
    expect(uploadHasWorkOutstanding({
      source_images_settled_version: 4,
      marketplace_eligibility_settled_version: MARKETPLACE_ELIGIBILITY_VERSION,
      image_sanitization_settled_version: null,
    })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TEST P — one decision, wherever it is made
// ---------------------------------------------------------------------------

describe('TEST P — reprocessing reaches the same verdict as a fresh import', () => {
  it('is the same function over the same bytes', async () => {
    const { encodePng } = await import(
      '../../../supabase/functions/_shared/builderStock/rasterPng');
    const bytes = (await encodePng(MARKETING_TILE.pixels,
      { width: W, height: H, components: 3 }))!;
    const atImport = await assessMarketplaceEligibility(bytes);
    const atReprocess = await assessMarketplaceEligibility(bytes);
    expect(atReprocess).toEqual(atImport);
    expect(atImport.state).toBe('ineligible');
  });

  it('measures a primary and never a role that could not be shown', async () => {
    const { encodePng } = await import(
      '../../../supabase/functions/_shared/builderStock/rasterPng');
    const bytes = (await encodePng(MARKETING_TILE.pixels,
      { width: W, height: H, components: 3 }))!;
    expect(await eligibilityDetailFor(bytes, 'primary_property'))
      .toMatchObject({ marketplace_display_eligible: false });
    expect(await eligibilityDetailFor(bytes, 'interior')).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// TEST W/X — the treatments that are not a coloured rectangle
// ---------------------------------------------------------------------------

/**
 * These go through the WHOLE path — a picture at source resolution, encoded,
 * decoded and downscaled — rather than measuring a hand-drawn 400px view.
 *
 * That is not ceremony. Type behaves differently at the two scales: a stroke
 * drawn five pixels wide at thumbnail size has hard edges, and the local
 * window sits inside it and reads no contrast, so only the stroke's outline
 * registers. A stroke drawn at source resolution and then downscaled is soft
 * and solid, which is what production actually measures. A fixture authored
 * at thumbnail size would have understated the detector and been "fixed" by
 * loosening a threshold that did not need loosening.
 */
const SOURCE_W = 960;
const SOURCE_H = 497;

const SOURCE = photograph(SOURCE_W, SOURCE_H);

/** TEST W: a scrim across the foot of the picture, with type on it. */
const SEMI_TRANSPARENT_BANNER = withCaption(
  withPlate(SOURCE, {
    x: 0, y: Math.round(SOURCE_H * 0.72), w: SOURCE_W, h: Math.round(SOURCE_H * 0.16),
  }, [10, 10, 14], 0.6),
  'SOLERA',
  { x: Math.round(SOURCE_W * 0.05), y: Math.round(SOURCE_H * 0.745), scale: 8, ink: [250, 250, 250] },
);

/** TEST X: a word set straight onto the photograph. No plate of any kind. */
const BARE_TYPOGRAPHY = withCaption(SOURCE, 'SOLERA', {
  x: Math.round(SOURCE_W * 0.08), y: Math.round(SOURCE_H * 0.12), scale: 11, ink: [12, 12, 14],
});

/** The same word, pale, over the pale part of the sky. See TEST AP. */
const PALE_ON_PALE = withCaption(SOURCE, 'SOLERA', {
  x: Math.round(SOURCE_W * 0.08), y: Math.round(SOURCE_H * 0.12), scale: 11, ink: [255, 255, 255],
});
/** Smaller, and still prominent. */
const PALE_SMALLER = withCaption(SOURCE, 'SOLERA', {
  x: Math.round(SOURCE_W * 0.08), y: Math.round(SOURCE_H * 0.12), scale: 8, ink: [255, 255, 255],
});
/** And a pale grey, which is what a real scrim-free caption usually is. */
const PALE_GREY = withCaption(SOURCE, 'SOLERA', {
  x: Math.round(SOURCE_W * 0.08), y: Math.round(SOURCE_H * 0.12), scale: 11, ink: [225, 232, 240],
});

describe('TEST W/X — treatments with no flat coloured rectangle to find', () => {
  it('TEST W — a semi-transparent banner is refused', async () => {
    // Nothing here is a flat colour: the photograph's own grain shows through
    // the scrim, so the block signal finds no region at all. It is refused on
    // the typography alone, which is the point of having two signals.
    const verdict = await assessMarketplaceEligibility(jpegOf(SEMI_TRANSPARENT_BANNER));
    expect(verdict.state).toBe('ineligible');
    expect(verdict.reason).toBe('annotated_marketing_tile');
    expect(verdict.overlay!.regionCount).toBe(0);
    expect(verdict.overlay!.textLineCount).toBeGreaterThan(0);
  });

  it('TEST X — large typography straight over the photograph is refused', async () => {
    const verdict = await assessMarketplaceEligibility(jpegOf(BARE_TYPOGRAPHY));
    expect(verdict.state).toBe('ineligible');
    expect(verdict.reason).toBe('annotated_marketing_tile');
    expect(verdict.overlay!.regionCount).toBe(0);
    expect(verdict.overlay!.textLineCount).toBeGreaterThan(0);
    expect(verdict.overlay!.textHeightShare).toBeGreaterThan(0.1);
  });

  it('and the clean picture under both of them is not', async () => {
    expect((await assessMarketplaceEligibility(jpegOf(SOURCE))).state).toBe('eligible');
  });

  /**
   * TEST AP — pale type over the pale part of a sky.
   *
   * THE CASE THAT MUST NOT BE `ELIGIBLE`. It carries almost no absolute
   * contrast, so the strict pass is silent — and "the strict pass was silent"
   * is not evidence that a picture is clean. What catches it is the faint pass,
   * which looks only where the picture is QUIET and can therefore afford to be
   * very sensitive there. The answer is `pending`: hidden, because the
   * classifier cannot establish the picture is clean, and not `ineligible`,
   * because it has not established the opposite either.
   */
  it('TEST AP — pale typography over a pale sky is never eligible', async () => {
    for (const view of [PALE_ON_PALE, PALE_SMALLER, PALE_GREY]) {
      const verdict = await assessMarketplaceEligibility(jpegOf(view));
      expect(verdict.state).not.toBe('eligible');
      expect(verdict.state).toBe('pending');
      expect(verdict.reason).toBe('overlay_uncertain');
      // Measured, and still not eligible: the pixels were read, and what is
      // missing is confidence rather than the decode.
      expect(verdict.measured).toBe(true);
      expect(verdict.overlay!.faintTextLineCount).toBeGreaterThan(0);
      expect(isMarketplaceEligible(marketplaceEligibilityDetail(verdict))).toBe(false);
    }
  });

  it('and the clean picture under them is still eligible', async () => {
    expect((await assessMarketplaceEligibility(jpegOf(SOURCE))).state).toBe('eligible');
  });
});

// ---------------------------------------------------------------------------
// TEST M/N — what the decision may and may not lead to
// ---------------------------------------------------------------------------

describe('TEST M — the server and the client reach the same answer', () => {
  const asImage = (c: Candidate): BuilderStockImage => ({
    id: c.id, stock_item_id: 'item-1',
    source_stage: c.source_stage as BuilderStockImage['source_stage'],
    source_reference: null, source_provider: null, source_page_url: null, external_url: null,
    storage_path: c.storage_path ?? null, content_type: 'image/png',
    verification_status: c.verification_status as BuilderStockImage['verification_status'],
    confidence: 1,
    processing_status: c.processing_status as BuilderStockImage['processing_status'],
    error_message: null, position: c.position ?? 0, source_detail: c.source_detail ?? null,
    created_at: '2026-08-18T00:00:00Z',
  });
  const item = (images: Candidate[]): BuilderStockItem => ({
    id: 'item-1', primary_image_id: null, images: images.map(asImage),
  } as unknown as BuilderStockItem);

  it('over every combination of the three states', () => {
    const states = [
      eligible({ id: 'a', position: 0 }, 3),
      rejected({ id: 'b', position: 1 }, 1),
      unjudged({ id: 'c', position: 2 }),
      otherRole('interior'),
    ];
    // Every subset, so agreement is a property rather than three examples.
    for (let mask = 0; mask < 1 << states.length; mask++) {
      const subset = states.filter((_, index) => mask & (1 << index));
      const server = chooseDisplayableImage(subset)?.id ?? null;
      const client = primaryStockImage(item(subset))?.id ?? null;
      expect(client).toBe(server);
    }
  });
});

describe('TEST N — a refusal is a refusal, not a request for a substitute', () => {
  it('offers nothing in place of a refused or unjudged primary', () => {
    // Everything a fallback could reach, present at once: another role of the
    // same property's own builder imagery, a location-derived row, and a
    // search result. The answer is still nothing.
    const everything = [
      rejected({ id: 'tile' }, 3),
      unjudged({ id: 'legacy' }),
      otherRole('interior'),
      otherRole('floorplan'),
      otherRole('masterplan'),
      {
        id: 'google-1', source_stage: 'google_maps', verification_status: 'location_derived',
        processing_status: 'ready', position: 0, storage_path: 'g.jpg', source_detail: null,
      } as Candidate,
      {
        id: 'search-1', source_stage: 'internet_search', verification_status: 'unverified',
        processing_status: 'ready', position: 0, storage_path: 's.jpg', source_detail: null,
      } as Candidate,
    ];
    expect(chooseDisplayableImage(everything)).toBeNull();
  });

  it('and the refusal never rewrites the picture or its role', async () => {
    const bytes = jpegOf(annotatedPicture(SOURCE_W, SOURCE_H));
    const before = Uint8Array.from(bytes);
    const detail = await eligibilityDetailFor(bytes, 'primary_property');
    // The bytes handed in are the bytes still held: nothing crops, erases,
    // blurs or repaints anything, here or anywhere this is called from.
    expect(Array.from(bytes)).toEqual(Array.from(before));
    // And the verdict is stored BESIDE the role. It contributes no role key,
    // so merging it can never restate what the source said.
    expect(detail).toMatchObject({ marketplace_display_eligible: false });
    expect(Object.keys(detail).some((key) => key.startsWith('role'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TEST AG/AH/AI — an operation that FAILED is not a decision
// ---------------------------------------------------------------------------

/**
 * The distinction these pin, which the sweep did not used to make.
 *
 * A `pending` verdict that was WRITTEN is a completed decision for this
 * algorithm version: the classifier looked and could not decide, the card shows
 * nothing, and the next version bump revisits it. A download that errored, an
 * object that is not there, a write the database rejected — none of those is a
 * decision at all, and the upload's marker must not move over them. Collapsing
 * the two is how a storage outage would have looked like a finished sweep:
 * every image skipped, nothing outstanding, the cron job unscheduling itself,
 * and every card empty for ever with nothing left to retry it.
 */
describe('TEST AG/AH/AI — operational failures block settlement', () => {
  const IMAGE_ROW = (over: Record<string, unknown> = {}) => ({
    id: 'image-1',
    organisation_id: ORG,
    upload_id: 'upload-1',
    source_stage: 'uploaded_document',
    verification_status: 'source_supplied',
    processing_status: 'ready',
    storage_bucket: 'builder-stock-images',
    storage_path: 'org/items/item-1/source/cover.png',
    source_detail: { role: 'primary_property', role_evidence_level: 3 },
    ...over,
  });

  const cleanBytes = async () => {
    const { encodePng } = await import(
      '../../../supabase/functions/_shared/builderStock/rasterPng');
    return (await encodePng(CLEAN.pixels, { width: W, height: H, components: 3 }))!;
  };

  it('TEST AI — a designated primary with no stored object leaves work unresolved', async () => {
    const db = fakeDb([IMAGE_ROW({ storage_path: null })], {});
    const outcome = await settleMarketplaceEligibility(db as never, ORG);
    expect(outcome.outstanding).toBe(1);
    expect(outcome.assessed).toBe(0);
    expect(outcome.unresolved).toBe(1);
    expect(eligibilitySweepCompleted(outcome)).toBe(false);
    // And nothing was written, so the row is still unjudged and still hidden.
    expect(db.updates).toHaveLength(0);
  });

  it('TEST AG — a storage download failure leaves work unresolved', async () => {
    // The row names an object the bucket does not hand over.
    const db = fakeDb([IMAGE_ROW()], {});
    const outcome = await settleMarketplaceEligibility(db as never, ORG);
    expect(outcome.outstanding).toBe(1);
    expect(outcome.unresolved).toBe(1);
    expect(eligibilitySweepCompleted(outcome)).toBe(false);
    expect(db.updates).toHaveLength(0);
  });

  it('TEST AH — a rejected verdict write leaves work unresolved', async () => {
    const row = IMAGE_ROW();
    const db = fakeDb([row], { [row.storage_path as string]: await cleanBytes() });
    db.failWrites = true;
    const outcome = await settleMarketplaceEligibility(db as never, ORG);
    expect(outcome.outstanding).toBe(1);
    // The decision was reached and not persisted, so as far as anything that
    // reads this row is concerned it was never made.
    expect(outcome.assessed).toBe(0);
    expect(outcome.unresolved).toBe(1);
    expect(eligibilitySweepCompleted(outcome)).toBe(false);
  });

  it('a written pending verdict is NOT an unresolved failure', async () => {
    const row = IMAGE_ROW();
    // Bytes no decoder here reads: the classifier decides it cannot decide,
    // writes that, and the sweep is finished with the row.
    const undecodable = Uint8Array.from([0x49, 0x49, 0x2a, 0x00, ...new Array(4096).fill(9)]);
    const db = fakeDb([row], { [row.storage_path as string]: undecodable });
    const outcome = await settleMarketplaceEligibility(db as never, ORG);
    expect(outcome.assessed).toBe(1);
    expect(outcome.unmeasured).toBe(1);
    expect(outcome.unresolved).toBe(0);
    expect(eligibilitySweepCompleted(outcome)).toBe(true);
    expect(db.updates).toHaveLength(1);
  });

  it('and a clean image settles cleanly', async () => {
    const row = IMAGE_ROW();
    const db = fakeDb([row], { [row.storage_path as string]: await cleanBytes() });
    const outcome = await settleMarketplaceEligibility(db as never, ORG);
    expect(outcome.assessed).toBe(1);
    expect(outcome.rejected).toBe(0);
    expect(outcome.unresolved).toBe(0);
    expect(eligibilitySweepCompleted(outcome)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TEST AJ/AK/AL — the upload queue
// ---------------------------------------------------------------------------

/**
 * A fake `builder_stock_uploads` that answers the four narrow reads the queue
 * makes, rather than the one broad read it used to make.
 */
function fakeUploads(rows: Array<Record<string, unknown>>) {
  const build = () => {
    const filters: Array<[string, string, unknown]> = [];
    let limit = 1000;
    const builder: any = {
      is(column: string, value: unknown) { filters.push(['is', column, value]); return builder; },
      lt(column: string, value: unknown) { filters.push(['lt', column, value]); return builder; },
      eq(column: string, value: unknown) { filters.push(['eq', column, value]); return builder; },
      order() { return builder; },
      limit(value: number) { limit = value; return builder; },
      then(resolve: (v: { data: any[]; error: null }) => unknown, reject?: unknown) {
        const matched = rows
          .filter((row) => filters.every(([op, column, value]) => {
            const current = row[column];
            if (op === 'is') return (current ?? null) === value;
            if (op === 'eq') return current === value;
            // PostgREST's `lt` never matches null, which is exactly why the
            // queue asks for the null rows separately.
            return current !== null && current !== undefined && Number(current) < Number(value);
          }))
          .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
          .slice(0, limit);
        return Promise.resolve({ data: matched, error: null }).then(resolve, reject as never);
      },
    };
    return builder;
  };
  return {
    from(table: string) {
      if (table === SETTLEMENT_TARGET_TABLE) {
        return {
          select: () => ({
            limit: () => Promise.resolve({
              data: [{ marketplace_eligibility_version: MARKETPLACE_ELIGIBILITY_VERSION }],
              error: null,
            }),
          }),
        };
      }
      return { select: () => build() };
    },
  };
}

describe('TEST AJ/AK — the queue reaches work behind a full page of settled uploads', () => {
  const settledUpload = (index: number) => ({
    id: `upload-${String(index).padStart(4, '0')}`,
    organisation_id: ORG,
    deleted_at: null,
    created_at: `2026-01-01T00:${String(index % 60).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}Z`,
    source_images_settled_version: 4,
    marketplace_eligibility_settled_version: MARKETPLACE_ELIGIBILITY_VERSION,
    image_sanitization_settled_version: SANITIZATION_VERSION,
  });

  it('TEST AJ — 500 settled uploads do not hide the 501st', async () => {
    const rows = Array.from({ length: 500 }, (_, index) => settledUpload(index));
    rows.push({
      ...settledUpload(500),
      id: 'upload-0500',
      created_at: '2026-06-01T00:00:00Z',
      marketplace_eligibility_settled_version: null,
    });

    const queue = await readOutstandingUploads(fakeUploads(rows) as never, { limit: 100 });
    expect(queue.unavailable).toBe(false);
    // The old sweep read the oldest 500 and filtered them here, so this row —
    // the only one with work — was never in the page it looked at.
    expect(queue.rows.map((row) => row.id)).toEqual(['upload-0500']);
  });

  it('TEST AK — several pages of outstanding work all drain', async () => {
    const rows = [
      ...Array.from({ length: 500 }, (_, index) => settledUpload(index)),
      ...Array.from({ length: 250 }, (_, index) => ({
        ...settledUpload(1000 + index),
        id: `pending-${String(index).padStart(4, '0')}`,
        created_at: `2026-07-${String((index % 28) + 1).padStart(2, '0')}T00:00:00Z`,
        marketplace_eligibility_settled_version: null,
      })),
    ];

    // One tick asks for at most `limit`; the queue is drained by the ticks that
    // follow, so the test settles them a page at a time until nothing is left.
    const seen = new Set<string>();
    for (let tick = 0; tick < 10; tick++) {
      const queue = await readOutstandingUploads(fakeUploads(rows) as never, { limit: 40 });
      if (!queue.rows.length) break;
      for (const row of queue.rows) {
        seen.add(String(row.id));
        const target = rows.find((candidate) => candidate.id === row.id)!;
        target.marketplace_eligibility_settled_version = MARKETPLACE_ELIGIBILITY_VERSION;
      }
    }
    expect(seen.size).toBe(250);
    expect(await readOutstandingUploads(fakeUploads(rows) as never, { limit: 40 })
      .then((queue) => queue.rows)).toHaveLength(0);
  });
});

describe('TEST AL — the target version lives in the database', () => {
  const upload = (marker: number | null) => ({
    id: 'upload-1', organisation_id: ORG, deleted_at: null,
    created_at: '2026-01-01T00:00:00Z',
    source_images_settled_version: 4,
    marketplace_eligibility_settled_version: marker,
    image_sanitization_settled_version: SANITIZATION_VERSION,
  });

  it('an upload at marker 1 is outstanding against a target of 2', async () => {
    const queue = await readOutstandingUploads(
      fakeUploads([upload(1)]) as never, { limit: 10, eligibilityTarget: 2 });
    expect(queue.rows.map((row) => row.id)).toEqual(['upload-1']);
    expect(uploadHasWorkOutstanding(upload(1), 2)).toBe(true);
  });

  it('and is finished against a target of 1', async () => {
    const queue = await readOutstandingUploads(
      fakeUploads([upload(1)]) as never, { limit: 10, eligibilityTarget: 1 });
    expect(queue.rows).toHaveLength(0);
    expect(uploadHasWorkOutstanding(upload(1), 1)).toBe(false);
  });

  /**
   * The half of the mechanism that lives in SQL.
   *
   * The sweep's cron job decides in the database whether any work is left, and
   * the database cannot see a TypeScript constant. A classifier bump therefore
   * ships two things in one deployment — the constant, and a migration raising
   * the target beside it — and a bump that ships only the first changes new
   * imports while leaving every stored image on the old rules for ever. This is
   * what makes that impossible to do by accident.
   */
  it('and the migrations declare exactly the version this build implements', () => {
    // The whole migration history, because a LATER migration is exactly how the
    // target is raised — reading only this programme's own files would miss the
    // next bump, which is the case this test exists for. A cheap substring test
    // first: the history is 945 files and most of them are generated seeds
    // measured in megabytes, and running a regular expression over all of that
    // is the difference between a second and a dozen.
    const directory = 'supabase/migrations';
    const CALL = 'set_builder_stock_eligibility_target';
    const declared: number[] = [];
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.sql')) continue;
      const text = readFileSync(`${directory}/${name}`, 'utf8');
      if (!text.includes(CALL)) continue;
      for (const match of text.matchAll(/set_builder_stock_eligibility_target\((\d+)\)/g)) {
        declared.push(Number(match[1]));
      }
    }
    expect(declared.length).toBeGreaterThan(0);
    expect(Math.max(...declared)).toBe(MARKETPLACE_ELIGIBILITY_VERSION);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// TEST AM/AN/AO — WebP
// ---------------------------------------------------------------------------

/**
 * Builder Stock accepts WebP, so a clean WebP has to be able to reach a card.
 *
 * BOTH FIXTURES ARE GENERATED HERE, NOT CHECKED IN. No generated image may be
 * committed to this repository — the release gate refuses any `.png`, `.jpg` or
 * `.webp` in a change — so the bitstreams are written in memory by encoders
 * built from RFC 6386 and the WebP lossless specification, independently of the
 * decoders they feed. An encoder that shares its author's misreadings with the
 * decoder proves nothing; two written from the specification separately make
 * the round trip worth something.
 *
 * `vp8Encoder.ts` writes the lossy bitstream — the arithmetic coder, the frame
 * header, key-frame mode records, the forward transform and the token tree —
 * so the larger and riskier half of the decoder is exercised end to end rather
 * than left untested for want of a committed file.
 */
describe('TEST AM/AN/AO — WebP', () => {
  const LOSSY_W = 480;
  const LOSSY_H = 250;

  it('TEST AM — a clean lossy WebP is measured, eligible and displayed', async () => {
    const bytes = lossyWebpOf(cleanPicture(LOSSY_W, LOSSY_H));
    // It really is a lossy WebP: RIFF/WEBP container, VP8 bitstream.
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe('WEBP');
    expect(String.fromCharCode(...bytes.subarray(12, 16))).toBe('VP8 ');

    const decoded = decodeWebp(bytes, { maxPixels: 40_000_000 });
    expect(decoded).not.toBeNull();
    expect(decoded!.width).toBe(LOSSY_W);
    expect(decoded!.height).toBe(LOSSY_H);

    const verdict = await assessMarketplaceEligibility(bytes);
    expect(verdict.measured).toBe(true);
    expect(verdict.state).toBe('eligible');
    expect(isMarketplaceEligible(marketplaceEligibilityDetail(verdict))).toBe(true);

    const candidate = {
      ...eligible({ id: 'webp' }),
      source_detail: {
        role: 'primary_property',
        role_evidence_level: 3,
        ...marketplaceEligibilityDetail(verdict),
      },
    };
    expect(chooseDisplayableImage([candidate])?.id).toBe('webp');
  });

  it('TEST AM — and a clean lossless WebP likewise', async () => {
    const bytes = losslessWebpOf(cleanPicture(640, 332));
    expect(String.fromCharCode(...bytes.subarray(12, 16))).toBe('VP8L');
    const verdict = await assessMarketplaceEligibility(bytes);
    expect(verdict.measured).toBe(true);
    expect(verdict.state).toBe('eligible');
    expect(isMarketplaceEligible(marketplaceEligibilityDetail(verdict))).toBe(true);
  });

  it('TEST AN — an annotated WebP is refused, lossy and lossless alike', async () => {
    const lossy = await assessMarketplaceEligibility(
      lossyWebpOf(annotatedPicture(LOSSY_W, LOSSY_H)));
    expect(lossy.state).toBe('ineligible');
    expect(lossy.reason).toBe('annotated_marketing_tile');
    expect(isMarketplaceEligible(marketplaceEligibilityDetail(lossy))).toBe(false);

    const lossless = await assessMarketplaceEligibility(
      losslessWebpOf(annotatedPicture(640, 332)));
    expect(lossless.state).toBe('ineligible');
    expect(lossless.reason).toBe('annotated_marketing_tile');
    expect(isMarketplaceEligible(marketplaceEligibilityDetail(lossless))).toBe(false);
  });

  it('TEST AO — a corrupt WebP is pending, hidden, and does not throw', async () => {
    const good = lossyWebpOf(cleanPicture(LOSSY_W, LOSSY_H));
    const goodLossless = losslessWebpOf(cleanPicture(160, 96));

    // Truncated mid-bitstream; a container whose image chunk is not one this
    // reads; and a lossless stream cut off after its header.
    const truncated = good.slice(0, 60);
    const headerless = Uint8Array.from(good);
    headerless[12] = 0x41; headerless[13] = 0x42;
    headerless[14] = 0x43; headerless[15] = 0x44;
    const shortLossless = goodLossless.slice(0, 40);

    for (const bytes of [truncated, headerless, shortLossless]) {
      const verdict = await assessMarketplaceEligibility(bytes);
      expect(verdict.state).toBe('pending');
      expect(verdict.measured).toBe(false);
      expect(isMarketplaceEligible(marketplaceEligibilityDetail(verdict))).toBe(false);
      // The import survives: a decoder that cannot read a builder's file must
      // not fail their upload, only refuse to draw it.
      expect(await eligibilityDetailFor(bytes, 'primary_property'))
        .toMatchObject({ marketplace_display_eligible: false });
    }
  });

  it('the lossless decoder reproduces the picture rather than approximating it', () => {
    // "Lossless" has to mean exactly that: a decoder that is nearly right is
    // one whose errors nobody can bound.
    const picture = cleanPicture(320, 200, 3);
    const decoded = decodeWebp(losslessWebpOf(picture), { maxPixels: 40_000_000 });
    expect(decoded).not.toBeNull();
    expect(Array.from(decoded!.pixels)).toEqual(Array.from(picture.pixels));
  });

  it('and the lossy decoder stays close to the picture that was encoded', () => {
    const picture = cleanPicture(LOSSY_W, LOSSY_H);
    const decoded = decodeWebp(lossyWebpOf(picture), { maxPixels: 40_000_000 })!;
    let total = 0;
    for (let i = 0; i < picture.pixels.length; i++) {
      total += Math.abs(decoded.pixels[i] - picture.pixels[i]);
    }
    // Most of what is lost is the fixture's own grain, which a 4x4 transform at
    // this quantiser does not keep. A desynchronised arithmetic coder would not
    // land anywhere near this — it produces noise, not a slightly softer copy.
    expect(total / picture.pixels.length).toBeLessThan(8);
  });
});

// ---------------------------------------------------------------------------
// TEST AQ — a refusal is never a request for a substitute
// ---------------------------------------------------------------------------

describe('TEST AQ — nothing stands in for a refused or pending primary', () => {
  const other = (role: string, id: string): Candidate => ({
    id,
    source_stage: 'uploaded_document',
    verification_status: 'source_supplied',
    processing_status: 'ready',
    storage_path: `org/items/item-1/source/${id}.png`,
    position: 0,
    source_detail: { role, role_evidence_level: 1, ...CLEAN_DETAIL },
  });

  const provider = (stage: string, verification: string, id: string): Candidate => ({
    id,
    source_stage: stage,
    verification_status: verification,
    processing_status: 'ready',
    storage_path: `org/items/item-1/${id}.jpg`,
    position: 0,
    source_detail: null,
  });

  it('not another role of the same property, and not another provider', () => {
    const everything = [
      rejected({ id: 'tile' }, 3),
      unjudged({ id: 'legacy' }),
      other('interior', 'interior'),
      other('floorplan', 'floorplan'),
      other('site_plan', 'site-plan'),
      other('masterplan', 'masterplan'),
      other('location_map', 'location-map'),
      other('materials', 'materials'),
      provider('google_maps', 'location_derived', 'google'),
      provider('google_street_view', 'location_derived', 'street-view'),
      provider('satellite', 'location_derived', 'satellite'),
      provider('internet_search', 'unverified', 'search'),
      provider('ai_generated', 'unverified', 'generated'),
    ];
    expect(chooseDisplayableImage(everything)).toBeNull();
  });

  it('and a pending primary is refused exactly as an ineligible one is', () => {
    const uncertain: Candidate = {
      ...unjudged({ id: 'uncertain' }),
      source_detail: {
        role: 'primary_property',
        role_evidence_level: 1,
        ...marketplaceEligibilityDetail(
          decideMarketplaceEligibility({
            annotated: false, uncertain: true,
            largestShare: 0, totalShare: 0, regionCount: 0,
            textHeightShare: 0, textLineCount: 0,
            faintTextHeightShare: 0.12, faintTextLineCount: 1,
          })),
      },
    };
    expect(chooseDisplayableImage([uncertain])).toBeNull();
    expect(chooseDisplayableImage([uncertain, other('interior', 'interior')])).toBeNull();
  });
});
