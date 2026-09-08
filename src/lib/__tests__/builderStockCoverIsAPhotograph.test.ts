/**
 * BUILDER STOCK — A CARD MUST NOT LEAD WITH THE FLOOR PLAN.
 *
 * THE REPORT, VERBATIM: "Some of it pulls the plan instead of the house. It
 * shouldnt be plans man ffs."
 *
 * PRODUCTION, 4 SEPTEMBER 2026. Three Palomino cards, one builder, one estate:
 *
 *   Lot 116  page1:Im2  the house          (Nex 20 brochure)
 *   Lot 109  page1:Im3  a green floor plan (Vanta 23 brochure)
 *   Lot 115  page1:Im3  the same plan      (same brochure, same design)
 *
 * Every attribution is correct — the right document reached the right
 * property. What differs is which picture INSIDE the document was elected, and
 * `selectCoverHero` elected by what the page did: a raster the cover draws
 * once, at twice the size of anything else, is the picture the page named. Its
 * own comment says the test is "the DOCUMENT'S, not the picture's".
 *
 * That is the right test for ownership and the wrong one for a card. A
 * brochure whose first page leads with the floor plan states the plan exactly
 * as emphatically as one that leads with the house, and 109's plan was unique
 * on its page and far larger than anything beside it. Both cards drew it,
 * badged "Builder supplied", which is the one badge that means the builder
 * said this is the property's picture.
 *
 * The listings side already learned this and measured it — six of sixteen
 * sampled heroes were floor plans, and the fix was to look at the pixels.
 * Builder stock never got that judgement; now it borrows the same one.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  selectCoverHero, type CoverCandidate,
} from '../../../supabase/functions/_shared/builderStock/pdfPrimaryImage.pure';
import {
  classifyThumbnail, mayLeadCard, toAnalysisRgba,
} from '../../../supabase/functions/_shared/builderStock/sourceImageVision.pure';

/** A candidate the page presents once and no other page repeats. */
const once = (over: Partial<CoverCandidate> = {}): CoverCandidate => ({
  key: 'k', placementsOnPage: 1, pagesDrawnOn: 1, pageAreaShare: 0.2, ...over,
});

describe('what may lead a card', () => {
  it('admits a photograph and refuses a plan or a graphic', () => {
    expect(mayLeadCard('photo')).toBe(true);
    expect(mayLeadCard('floorplan')).toBe(false);
    expect(mayLeadCard('graphic')).toBe(false);
  });

  it('admits a picture nothing could be established about', () => {
    // Absent evidence is not evidence. A decoder that could not read a
    // builder's raster must not be able to withhold their photograph.
    expect(mayLeadCard(null)).toBe(true);
    expect(mayLeadCard(undefined)).toBe(true);
  });
});

describe('the cover hero, when the document draws the plan biggest', () => {
  it('takes the house even though the page shouts about the plan', () => {
    /*
     * Lot 109's shape: the plan is unique, and drawn at nearly half the page
     * against the render's fifth. Before this, the size rule elected it.
     */
    const outcome = selectCoverHero([
      once({ key: 'plan', pageAreaShare: 0.47, visualKind: 'floorplan' }),
      once({ key: 'house', pageAreaShare: 0.19, visualKind: 'photo' }),
    ]);

    expect(outcome.kind).toBe('hero');
    expect(outcome.kind === 'hero' && outcome.key).toBe('house');
  });

  it('answers no image where every picture on the cover is a plan', () => {
    const outcome = selectCoverHero([
      once({ key: 'plan', pageAreaShare: 0.47, visualKind: 'floorplan' }),
      once({ key: 'siteplan', pageAreaShare: 0.2, visualKind: 'graphic' }),
    ]);

    // A correct blank, which this marketplace says out loud and can act on.
    expect(outcome.kind).toBe('none');
    expect(outcome.reason).toMatch(/plan or a graphic/i);
  });

  it('behaves exactly as before where nothing was classified', () => {
    // The dominance rule, untouched, for every document whose rasters could
    // not be read.
    const outcome = selectCoverHero([
      once({ key: 'big', pageAreaShare: 0.5 }),
      once({ key: 'small', pageAreaShare: 0.1 }),
    ]);
    expect(outcome.kind === 'hero' && outcome.key).toBe('big');
  });

  it('still refuses two comparable photographs — a page presenting a choice', () => {
    const outcome = selectCoverHero([
      once({ key: 'a', pageAreaShare: 0.3, visualKind: 'photo' }),
      once({ key: 'b', pageAreaShare: 0.28, visualKind: 'photo' }),
    ]);
    expect(outcome.kind).toBe('none');
  });

  it('still eliminates repeated artwork before anything else', () => {
    const outcome = selectCoverHero([
      once({ key: 'wash', placementsOnPage: 3, pageAreaShare: 0.6, visualKind: 'photo' }),
      once({ key: 'house', pageAreaShare: 0.2, visualKind: 'photo' }),
    ]);
    expect(outcome.kind === 'hero' && outcome.key).toBe('house');
  });
});

describe('the adapter onto the measured classifier', () => {
  /** A w×h RGB thumbnail whose every pixel is one colour. */
  const flat = (w: number, h: number, rgb: [number, number, number]) => ({
    width: w,
    height: h,
    pixels: Uint8Array.from(
      Array.from({ length: w * h }, () => rgb).flat(),
    ),
  });

  it('produces the square RGBA buffer the classifier reads', () => {
    const rgba = toAnalysisRgba(flat(8, 4, [10, 20, 30]), 4);
    expect(rgba).not.toBeNull();
    expect(rgba!.length).toBe(4 * 4 * 4);
    expect([rgba![0], rgba![1], rgba![2], rgba![3]]).toEqual([10, 20, 30, 255]);
  });

  it('reads a near-white line drawing as a plan and a coloured scene as a photo', () => {
    // The two populations the thresholds were measured on: a plan is
    // overwhelmingly near-white, a photograph is not.
    expect(classifyThumbnail(flat(64, 64, [250, 250, 250]))?.kind).toBe('floorplan');
    expect(classifyThumbnail(flat(64, 64, [40, 110, 60]))?.kind).toBe('photo');
  });

  it('says nothing rather than guessing when there are no pixels', () => {
    expect(classifyThumbnail(null)).toBeNull();
    expect(toAnalysisRgba({ width: 0, height: 0, pixels: new Uint8Array() })).toBeNull();
    // A buffer shorter than its own dimensions is a broken read, not a plan.
    expect(toAnalysisRgba({ width: 8, height: 8, pixels: new Uint8Array(4) })).toBeNull();
  });
});

/*
 * BOTH PATHS HAVE TO LOOK, AND ONLY ONE OF THEM DID.
 *
 * `resolvePdfSourcePhoto`'s own comment calls its election "the SAME decision
 * an upload and a repair make, over the same inputs" — which is only true if
 * both sides SUPPLY the same inputs. The visual gate was wired into the import
 * alone, so the v14 reopen re-derived lots 109 and 115 Palomino and re-elected
 * exactly what it had elected before: `page1:Im3`, the floor plan. The
 * marketplace drained for forty minutes and came back unchanged.
 *
 * A behavioural test cannot reach this — it needs a real PDF and a real
 * decoder — so the contract is asserted at the source: every caller of the
 * elector passes what the pictures ARE.
 */
describe('every path that elects a cover reads the pixels', () => {
  const read = (rel: string) => readFileSync(
    join(process.cwd(), 'supabase/functions/_shared/builderStock', rel), 'utf8');

  it('the import path and the repair path both supply visualKinds', () => {
    for (const file of ['importStock.ts', 'pdfSourcePhoto.ts']) {
      const source = read(file);
      expect(source).toMatch(/documentVisualKinds\(/);
      expect(source).toMatch(/visualKinds/);
    }
  });

  it('no caller of the elector omits them', () => {
    // If a third caller appears, it is a third way to elect a floor plan.
    for (const file of ['importStock.ts', 'pdfSourcePhoto.ts']) {
      const source = read(file);
      for (const call of source.split(/assignPdfMediaRoles(?:PerProperty)?\(\{/).slice(1)) {
        const body = call.slice(0, call.indexOf('});'));
        expect(body).toMatch(/visualKinds/);
      }
    }
  });
});

/**
 * A DOCUMENT NAMING NO CANDIDATE PAGE DECODES NOTHING.
 *
 * `coverSearchPages` is a superset of every page the role decision can
 * designate, so an empty answer decides the refusal before a raster is
 * touched. Measured, 6 September 2026, on Lot 709 Verve's 13-page brochure:
 * the unscoped walk was ~2.6 s of a ~2.9 s recovery — spent materialising,
 * flattening and classifying pictures whose only fate was the refusal
 * already decided — and the worker died inside that waste on every attempt.
 */
describe('a document naming no candidate page decodes nothing', () => {
  it('the election path returns before discovery when no page can be designated', () => {
    const source = readFileSync(
      join(process.cwd(), 'supabase/functions/_shared/builderStock', 'pdfSourcePhoto.ts'), 'utf8');
    const body = source.slice(
      source.indexOf('async function selectPdfPropertyPrimaryHoldingSlot'),
      source.indexOf('export async function discoverPdfSourceAssets('),
    );
    const guardAt = body.indexOf('if (!searchPages.length)');
    const discoverAt = body.indexOf('discoverPdfSourceAssetsHoldingSlot(');
    expect(guardAt).toBeGreaterThan(-1);
    expect(discoverAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(discoverAt);
  });
});
