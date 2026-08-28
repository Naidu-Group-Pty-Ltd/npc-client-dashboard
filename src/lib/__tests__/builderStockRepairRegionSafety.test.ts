/**
 * BUILDER STOCK — THE AI MAY REBUILD A BADGE, NEVER A HOUSE.
 *
 * Every other guarantee in the repair path is written in terms of the pixels
 * OUTSIDE the repair. `outsidePermittedRegionUnchanged` compares exactly those
 * and requires zero of them to have moved; the composite writes only where the
 * mask says; the classifier re-reads the result. All three are sound and all
 * three are silently satisfied by a repair that covers the whole frame — the
 * gate does not fail on a whole-frame edit, it runs out of pixels to fail on
 * and returns `changed: 0`.
 *
 * So the invariant has to be stated as an AREA, and enforced twice:
 *
 *   BARRIER A  the rectangle a caller records may not exceed the ceiling
 *              (`repairRegion.pure.ts`), refused before anything is decoded.
 *
 *   BARRIER B  the pixels the repair is finally PERMITTED to write may not
 *              exceed it either (`inpaintOverlay.ts`), measured on `weights`
 *              after dilation, merging and feathering, and checked before the
 *              first model call.
 *
 * A is about what was asked for; B is about what it grew into. Neither alone
 * is enough: A cannot see dilation, and B cannot stop a caller's rectangle
 * from being decoded in the first place.
 */
import { describe, expect, it } from 'vitest';
import {
  newRepairBudget, settleImageSanitization,
} from '../../../supabase/functions/_shared/builderStock/settleImageSanitization';
import { encodePng, sha256Hex } from '../../../supabase/functions/_shared/builderStock/rasterPng';
import { sanitizeSourceImage } from '../../../supabase/functions/_shared/builderStock/sanitizeImage';
import {
  readRepairRegion, regionAreaShare, oversizedRepairRegionShare, MAX_REPAIRED_SHARE,
  combinedAreaShare, MAX_REGION_BOXES,
} from '../../../supabase/functions/_shared/builderStock/repairRegion.pure';
import {
  blendWeights, permittedShare,
} from '../../../supabase/functions/_shared/builderStock/inpaintOverlay.pure';
import { inpaintOverlay } from '../../../supabase/functions/_shared/builderStock/inpaintOverlay';
import {
  readServableDerivative,
} from '../../../supabase/functions/_shared/builderStock/sanitizedDerivative.pure';

const SHA = 'a'.repeat(64);
const W = 240;
const H = 160;

/** A stored region record, as a row would carry it. */
const stored = (box: Record<string, number>) => ({
  repair_region: { ...box, original_sha256: SHA, recorded_at: '2026-08-20T00:00:00Z' },
});

/** A rectangle covering `share` of the frame, anchored top-left. */
function boxOfShare(share: number) {
  // Full width, so height alone carries the share — the shape a banner has.
  return { left: 0, right: 1, top: 0, bottom: share };
}

/** A frame of flat pixels and a mask marking the given rectangles. */
function frame(rects: Array<{ x: number; y: number; w: number; h: number }>) {
  const pixels = new Uint8Array(W * H * 3).fill(128);
  const mask = new Uint8Array(W * H);
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) mask[y * W + x] = 1;
    }
  }
  return { pixels, mask };
}

describe('BARRIER A — the rectangle a caller may record', () => {
  it('A — a full-frame region is refused', () => {
    const detail = stored({ left: 0, top: 0, right: 1, bottom: 1 });
    expect(regionAreaShare({ left: 0, top: 0, right: 1, bottom: 1 })).toBe(1);
    expect(readRepairRegion(detail, SHA)).toBeNull();
  });

  it('B — 80% of the frame is refused', () => {
    expect(readRepairRegion(stored(boxOfShare(0.8)), SHA)).toBeNull();
  });

  it('C — the ceiling plus a hair is refused', () => {
    expect(readRepairRegion(stored(boxOfShare(MAX_REPAIRED_SHARE + 0.001)), SHA)).toBeNull();
  });

  it('D — the ceiling exactly is accepted, and is the boundary', () => {
    // Deterministic on both sides of one number: <= passes, > does not.
    expect(readRepairRegion(stored(boxOfShare(MAX_REPAIRED_SHARE)), SHA)).not.toBeNull();
    expect(readRepairRegion(stored(boxOfShare(MAX_REPAIRED_SHARE + 1e-9)), SHA)).toBeNull();
  });

  it('E,F,G,H — every real production repair is still accepted', () => {
    // The shares production has actually produced. Lot 1663 is the largest
    // repair this marketplace has ever made; Lot 914's is the only rectangle
    // anyone has recorded by hand.
    const production: Array<[string, number]> = [
      ['Lot 1663', 0.2273],
      ['Lot 13', 0.1515],
      ['Lot 60714', 0.1515],
      ['Lot 914', 0.02338],
      ['production median', 0.0758],
      ['production minimum', 0.0296],
    ];
    for (const [name, share] of production) {
      expect(readRepairRegion(stored(boxOfShare(share)), SHA), name).not.toBeNull();
    }
  });

  it('an oversized region is reported rather than silently treated as none', () => {
    const detail = stored({ left: 0, top: 0, right: 1, bottom: 1 });
    expect(oversizedRepairRegionShare(detail, SHA)).toBeCloseTo(1, 5);
    // A region that is merely absent, or attributed to other bytes, is not
    // "oversized" — it is nothing, and must not be reported as a refusal.
    expect(oversizedRepairRegionShare({}, SHA)).toBeNull();
    expect(oversizedRepairRegionShare(detail, 'b'.repeat(64))).toBeNull();
    expect(oversizedRepairRegionShare(stored(boxOfShare(0.1)), SHA)).toBeNull();
  });
});

describe('BARRIER A over a SET of rectangles — several separated marks, one record', () => {
  /*
   * THE PRODUCTION SHAPE THIS EXISTS FOR. A facade can carry a pill in one
   * corner, a plate in the other and a caption strip along the bottom edge.
   * Each mark is a few percent of the frame; their common bounding box is
   * most of the photograph. A record has to be able to say "these three
   * rectangles" without either lying (one box that is mostly house) or being
   * refused for the house BETWEEN the marks.
   */
  const PILL = { left: 0.074, top: 0.137, right: 0.329, bottom: 0.246 };
  const PLATE = { left: 0.797, top: 0.030, right: 0.990, bottom: 0.120 };
  const STRIP = { left: 0.495, top: 0.890, right: 1, bottom: 1 };

  const storedBoxes = (boxes: Array<Record<string, number>>) => ({
    repair_region: { boxes, original_sha256: SHA, recorded_at: '2026-08-27T00:00:00Z' },
  });

  it('the union is measured, never the bounding box of the set', () => {
    const union = combinedAreaShare([PILL, PLATE, STRIP]);
    const sum = [PILL, PLATE, STRIP].map(regionAreaShare).reduce((a, b) => a + b, 0);
    // Disjoint marks: the union IS the sum, exactly.
    expect(union).toBeCloseTo(sum, 10);
    // And it is a badge-sized ask, while the bounding box would be a house.
    const boundingBox = regionAreaShare({
      left: PILL.left, top: PLATE.top, right: 1, bottom: 1 });
    expect(union).toBeLessThan(MAX_REPAIRED_SHARE);
    expect(boundingBox).toBeGreaterThan(0.8);
    // So the record is accepted where a single collapsed rectangle would
    // rightly be refused.
    expect(readRepairRegion(storedBoxes([PILL, PLATE, STRIP]), SHA)).toHaveLength(3);
    expect(readRepairRegion(stored({
      left: PILL.left, top: PLATE.top, right: 1, bottom: 1 }), SHA)).toBeNull();
  });

  it('overlap is counted once — a pair whose SUM exceeds the ceiling can still be honest', () => {
    // Two boxes of 24% each, overlapping in a 18%-wide band: sum 0.48,
    // union 0.30. The ceiling judges the pixels that would actually be
    // writable, and a pixel is not more writable for being asked for twice.
    const a = { left: 0, top: 0, right: 0.8, bottom: 0.3 };
    const b = { left: 0.2, top: 0, right: 1, bottom: 0.3 };
    expect(regionAreaShare(a) + regionAreaShare(b)).toBeGreaterThan(MAX_REPAIRED_SHARE);
    expect(combinedAreaShare([a, b])).toBeCloseTo(0.3, 10);
    expect(readRepairRegion(storedBoxes([a, b]), SHA)).toHaveLength(2);
  });

  it('a set whose UNION exceeds the ceiling is refused, and reported as oversized', () => {
    // Four disjoint bands of 10% each: none alarming alone, 40% together.
    const bands = [0, 1, 2, 3].map((n) => ({
      left: 0, right: 1, top: n * 0.25, bottom: n * 0.25 + 0.1 }));
    expect(readRepairRegion(storedBoxes(bands), SHA)).toBeNull();
    expect(oversizedRepairRegionShare(storedBoxes(bands), SHA)).toBeCloseTo(0.4, 10);
  });

  it('a legacy one-rectangle record reads exactly as it always did', () => {
    const legacy = readRepairRegion(stored(PILL), SHA);
    expect(legacy).toHaveLength(1);
    expect(legacy![0]).toEqual(PILL);
    // A record carrying boxes is read from them ALONE — a stray top-level
    // rectangle beside them does not smuggle in a fifth region.
    const both = {
      repair_region: {
        ...{ left: 0, top: 0, right: 1, bottom: 1 },
        boxes: [PILL], original_sha256: SHA,
      },
    };
    const read = readRepairRegion(both, SHA);
    expect(read).toHaveLength(1);
    expect(read![0]).toEqual(PILL);
  });

  it(`more than ${MAX_REGION_BOXES} rectangles voids the record`, () => {
    const many = [0, 1, 2, 3, 4].map((n) => ({
      left: n * 0.2, top: 0, right: n * 0.2 + 0.05, bottom: 0.05 }));
    expect(many).toHaveLength(MAX_REGION_BOXES + 1);
    expect(readRepairRegion(storedBoxes(many), SHA)).toBeNull();
    // At the cap exactly, it reads.
    expect(readRepairRegion(storedBoxes(many.slice(0, MAX_REGION_BOXES)), SHA))
      .toHaveLength(MAX_REGION_BOXES);
  });

  it('ONE malformed rectangle voids the whole set, honest neighbours and all', () => {
    for (const bad of [
      { left: 0.9, top: 0, right: 0.2, bottom: 0.1 },          // inverted
      { left: 0.5, top: 0.5, right: 0.5, bottom: 0.9 },        // empty
      { left: -0.1, top: 0, right: 0.2, bottom: 0.1 },         // out of frame
      { left: Number.NaN, top: 0, right: 0.2, bottom: 0.1 },   // not a number
    ]) {
      expect(readRepairRegion(storedBoxes([PILL, bad as never]), SHA)).toBeNull();
      // And a voided set is NOT "oversized" — it is nothing.
      expect(oversizedRepairRegionShare(storedBoxes([PILL, bad as never]), SHA)).toBeNull();
    }
  });

  it('the origin test binds the SET exactly as it binds one rectangle', () => {
    expect(readRepairRegion(storedBoxes([PILL, PLATE]), 'b'.repeat(64))).toBeNull();
    expect(readRepairRegion(storedBoxes([PILL, PLATE]), null)).toBeNull();
  });
});

describe('BARRIER B — the pixels the repair is permitted to write', () => {
  /** Runs a repair and reports how many times the model was asked. */
  async function repair(mask: Uint8Array, pixels: Uint8Array) {
    let calls = 0;
    const result = await inpaintOverlay({
      width: W, height: H, pixels, mask,
      edit: async (patch: Uint8Array) => { calls += 1; return patch; },
    });
    return { result, calls };
  }

  it('L — a full-frame mask is refused, and costs ZERO model calls', async () => {
    const { pixels, mask } = frame([{ x: 0, y: 0, w: W, h: H }]);
    const { result, calls } = await repair(mask, pixels);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toBe('too_much_to_rebuild');
    // THE WHOLE POINT: nothing was spent establishing that this is unsafe.
    expect(calls).toBe(0);
  });

  it('I — several individually-modest regions cannot combine past the ceiling', async () => {
    // Four bands, each ~10% of the frame, none of them alarming on its own.
    const rects = [0, 1, 2, 3].map((n) => ({ x: 0, y: n * 40, w: W, h: 16 }));
    const { pixels, mask } = frame(rects);
    const combined = permittedShare(blendWeights(mask, W, H), W, H);
    expect(combined).toBeGreaterThan(MAX_REPAIRED_SHARE);
    const { result, calls } = await repair(mask, pixels);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toBe('too_much_to_rebuild');
    expect(calls).toBe(0);
  });

  it('J,K — the ceiling is measured AFTER feathering, not on the raw mask', () => {
    const { mask } = frame([{ x: 0, y: 0, w: W, h: 40 }]);
    let raw = 0;
    for (let i = 0; i < mask.length; i++) raw += mask[i];
    const rawShare = raw / (W * H);
    const permitted = permittedShare(blendWeights(mask, W, H), W, H);
    // Feathering only ever adds area, so the number the barrier judges is
    // strictly the larger one. A rule written against the raw mask would be a
    // rule with a gap in it exactly the width of the feather ring.
    expect(permitted).toBeGreaterThan(rawShare);
  });

  it('a legitimate badge-sized repair still goes through', async () => {
    // ~7.6% of the frame: the production median.
    const { pixels, mask } = frame([{ x: 10, y: 10, w: 100, h: 29 }]);
    const permitted = permittedShare(blendWeights(mask, W, H), W, H);
    expect(permitted).toBeLessThan(MAX_REPAIRED_SHARE);
    const { result, calls } = await repair(mask, pixels);
    expect(result.ok).toBe(true);
    expect(calls).toBeGreaterThan(0);
  });
});

describe('SERVE TIME — a derivative that rebuilt too much is not drawn', () => {
  const derivative = (share: unknown) => ({
    sanitized_derivative: {
      transformation: 'generative_overlay_inpaint',
      sanitization_version: 2,
      storage_path: 'org/items/item/source/sanitized/v2/img.png',
      derivative_sha256: 'c'.repeat(64),
      original_sha256: SHA,
      verdict: 'eligible',
      repaired_share: share,
    },
  });

  it('M — a historical derivative above the ceiling is refused', () => {
    expect(readServableDerivative(derivative(0.9), SHA)).toBeNull();
    expect(readServableDerivative(derivative(MAX_REPAIRED_SHARE + 0.01), SHA)).toBeNull();
  });

  it('N — every real production derivative still serves', () => {
    for (const share of [0.2273, 0.1515, 0.0758, 0.0296, 0.02338]) {
      expect(readServableDerivative(derivative(share), SHA), String(share)).not.toBeNull();
    }
    expect(readServableDerivative(derivative(MAX_REPAIRED_SHARE), SHA)).not.toBeNull();
  });

  it('a share nothing can read is refused rather than assumed small', () => {
    expect(readServableDerivative(derivative(undefined), SHA)).toBeNull();
    expect(readServableDerivative(derivative('big'), SHA)).toBeNull();
    expect(readServableDerivative(derivative(-1), SHA)).toBeNull();
  });
});

describe('END TO END — an oversized region is answered once and not retried', () => {
  const ORG = 'org-a';
  const PATH = 'org-a/items/item-1/source/cover.png';

  /** The smallest database this settler will run against. */
  function tinyDb(rows: Array<Record<string, any>>, objects: Record<string, Uint8Array>) {
    const build = () => {
      const filters: Array<[string, string, unknown]> = [];
      let limit = 1000;
      const builder: any = {
        eq(c: string, v: unknown) { filters.push(['eq', c, v]); return builder; },
        gt(c: string, v: unknown) { filters.push(['gt', c, v]); return builder; },
        order() { return builder; },
        limit(v: number) { limit = v; return builder; },
        then(res: any, rej?: any) {
          const matched = rows.filter((row) => filters.every(([op, c, v]) =>
            op === 'eq' ? row[c] === v : String(row[c]) > String(v))).slice(0, limit);
          return Promise.resolve({ data: matched, error: null }).then(res, rej);
        },
      };
      return builder;
    };
    return {
      rows,
      from() {
        return {
          select: () => build(),
          update(patch: Record<string, unknown>) {
            const filters: Array<[string, unknown]> = [];
            const builder: any = {
              eq(c: string, v: unknown) { filters.push([c, v]); return builder; },
              then(res: any, rej?: any) {
                for (const row of rows) {
                  if (filters.every(([c, v]) => row[c] === v)) Object.assign(row, patch);
                }
                return Promise.resolve({ data: null, error: null }).then(res, rej);
              },
            };
            return builder;
          },
        };
      },
      storage: { from() { return {
        download(path: string) {
          const bytes = objects[path];
          if (!bytes) return Promise.resolve({ data: null, error: { message: 'missing' } });
          return Promise.resolve({
            data: { arrayBuffer: () => Promise.resolve(bytes.buffer.slice(0)) }, error: null });
        },
        async upload(path: string, blob: Blob) {
          objects[path] = new Uint8Array(await blob.arrayBuffer());
          return { data: { path }, error: null };
        },
      }; } },
    };
  }

  it('records a terminal refusal, spends nothing, and is not picked up again', async () => {
    // A picture the detector convicts, carrying a hand-recorded rectangle that
    // asks for most of the frame.
    const px = new Uint8Array(400 * 200 * 3).fill(128);
    const bytes = (await encodePng(px, { width: 400, height: 200, components: 3 }))!;
    const sha = await sha256Hex(bytes);
    const row = {
      id: 'image-1', stock_item_id: 'item-1', organisation_id: ORG, upload_id: 'upload-1',
      source_reference: null, source_stage: 'uploaded_document',
      verification_status: 'source_supplied', processing_status: 'ready',
      storage_bucket: 'builder-stock-images', storage_path: PATH,
      source_detail: {
        role: 'primary_property', role_evidence_level: 3,
        stored_sha256: sha, source_sha256: sha,
        marketplace_display_eligible: false,
        marketplace_eligibility_state: 'ineligible',
        marketplace_rejection_reason: 'annotated_marketing_tile',
        marketplace_measured: true, marketplace_eligibility_version: 1,
        repair_region: {
          left: 0, top: 0, right: 1, bottom: 0.9, original_sha256: sha,
          established_by: 'an operator who asked for most of the photograph',
        },
      } as Record<string, unknown>,
    };
    const db = tinyDb([row], { [PATH]: bytes });

    let modelCalls = 0;
    const sanitize = (input: Uint8Array) => sanitizeSourceImage(input, {
      edit: async (patch: Uint8Array) => { modelCalls += 1; return patch; },
    });

    const first = await settleImageSanitization(db as never, ORG, {
      budget: newRepairBudget(), sanitize: sanitize as never,
    });
    const second = await settleImageSanitization(db as never, ORG, {
      budget: newRepairBudget(), sanitize: sanitize as never,
    });

    // The region never became a mask, so the picture was judged by the
    // detector alone — and on a flat frame there is nothing to remove. Either
    // way the model was never asked, on either tick.
    expect(modelCalls).toBe(0);
    // No derivative was invented for it.
    const detail = db.rows[0].source_detail as Record<string, any>;
    expect(detail.sanitized_derivative ?? null).toBeNull();
    // And the second tick did not spend the allowance re-deciding the first.
    expect(second.repaired).toBe(0);
    expect(first.repaired).toBe(0);
  });
});
