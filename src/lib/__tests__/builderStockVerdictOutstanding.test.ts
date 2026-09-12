/**
 * Builder stock — "Finding a picture…", for ever.
 *
 * MEASURED 11 SEPTEMBER 2026. `Lot 1037, Fuchsia Street` was uploaded at
 * 07:13:52 and was still saying "Finding a picture for 1 property" eighteen
 * minutes later. The settler's own log, one invocation:
 *
 *   item tick { settled: 126, last_stock_item_id: "aa3357ef…",
 *               stage: "fallback", next_stage: "fallback",
 *               progressed: true, primary_set: false, ms: 80565 }
 *
 * One property, one stage, a hundred and twenty-six times in eighty seconds,
 * and 102 more on the next tick. It could never have ended.
 *
 * THE CAUSE IS TWO MODULES DISAGREEING ABOUT WHAT IS OWED. Both verdict
 * sweeps open their loop with the same line — only the image a source
 * DESIGNATED as the property's hero is worth a decode:
 *
 *   if (!isPrimaryRole(readStoredRole(detail))) continue;
 *
 * So a row of any other role is owed NOTHING by either sweep: its eligibility
 * version stays 0 and its sanitization stays unsettled for ever, by design.
 * `nextImageStage` asked only the second half — "is the version current?" —
 * read 0 as EVIDENCE THAT HAS NOT ARRIVED, and answered `wait`. That is the
 * one answer in that function with no exit. The ladder was never entered,
 * `enrichment_status` stayed `pending`, the row never left the fallback queue,
 * and the settler re-claimed it immediately because a tick that attempted
 * something reported progress.
 *
 * The shape is ordinary and will recur for every builder who links a wrong
 * brochure: a package document whose pages store fine but whose election
 * REFUSES it, because no page states this property's identity. Every image it
 * leaves behind carries `role: "unknown"`.
 *
 * `nextImageStage`'s own comment already warned about this, about a different
 * branch of the same function: "It is the only answer here with no exit,
 * which is what made it the dangerous one to get wrong."
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  MARKETPLACE_ELIGIBILITY_VERSION, sanitizationSweepAdmits, sourceVerdictOutstanding,
  sweepWillJudge,
} from '../../../supabase/functions/_shared/builderStock/marketplaceEligibility.pure';
import {
  nextImageStage,
} from '../../../supabase/functions/_shared/builderStock/imagePriority.pure';
import {
  settleClaimedItem,
} from '../../../supabase/functions/_shared/builderStock/settleItemImages';
import type {
  ClaimedItem,
} from '../../../supabase/functions/_shared/builderStock/itemWorkClaim';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const read = (relative: string) => readFileSync(join(REPO_ROOT, relative), 'utf8');

const ELIGIBILITY_SWEEP =
  read('supabase/functions/_shared/builderStock/settleMarketplaceEligibility.ts');
const SANITIZATION_SWEEP =
  read('supabase/functions/_shared/builderStock/settleImageSanitization.ts');
const SETTLER = read('supabase/functions/builder-stock-image-settler/index.ts');

/**
 * Page 1 of `Lot 1037 Wollert Rise - VANTA 20 - V002.pdf`, as production
 * stored it — verbatim from `builder_stock_item_images.source_detail`. The
 * election refused the document (its cover reads `NEX 20 — Lot 1307 Fuchsia
 * Street`), so the images it left behind carry no role.
 */
const UNELECTED = {
  page: 1,
  role: 'unknown',
  anchor: 'pdf:page1',
  method: 'embedded_raster',
  origin: 'document_media',
  filename: 'Lot 1037 Wollert Rise - VANTA 20 - V002.pdf',
  structural: true,
  source_width: 1280,
  source_height: 720,
  role_evidence: 'none',
  source_sha256: 'd10319cc7f76903c8b95a0d8d2f1d8e2217c132e33072c76876fab1c190e163b',
  stored_sha256: 'd10319cc7f76903c8b95a0d8d2f1d8e2217c132e33072c76876fab1c190e163b',
  selection_reason:
    "no page states this property's identity together with its package information",
  provenance_version: 23,
} as Record<string, unknown>;

/** The same row, had the election named it the property's hero. */
const ELECTED = { ...UNELECTED, role: 'primary_property', role_evidence: 'cover' };

const imageRow = (detail: Record<string, unknown>) => ({
  id: 'img-1',
  source_stage: 'uploaded_document',
  verification_status: 'source_supplied',
  processing_status: 'ready',
  position: 0,
  storage_path: 'org/item/img-1.jpg',
  external_url: null,
  source_detail: detail,
});

// ---------------------------------------------------------------------------

describe('what is genuinely owed about a stored image', () => {
  it('is nothing, where no sweep will ever look at the row', () => {
    // Role `unknown` — neither sweep's loop gets past its first line.
    expect(sweepWillJudge(UNELECTED)).toBe(false);
    expect(sourceVerdictOutstanding(UNELECTED)).toBe(false);
  });

  it('is a verdict, where a sweep WILL look and has not judged yet', () => {
    expect(sweepWillJudge(ELECTED)).toBe(true);
    expect(sourceVerdictOutstanding(ELECTED)).toBe(true);
  });

  it('is nothing once the current version has judged it and the bytes agree', () => {
    const judged = {
      ...ELECTED,
      marketplace_eligibility_version: MARKETPLACE_ELIGIBILITY_VERSION,
      marketplace_display_state: 'eligible',
      sanitization_clearance: {
        sanitization_version: 99,
        original_sha256: ELECTED.stored_sha256,
      },
    };
    expect(sourceVerdictOutstanding(judged)).toBe(false);
  });

  it('treats a row with no detail at all as nothing owed', () => {
    for (const empty of [null, undefined, {}]) {
      expect(sweepWillJudge(empty)).toBe(false);
      expect(sourceVerdictOutstanding(empty)).toBe(false);
    }
  });

  it('never says a verdict is owed where none will ever be written', () => {
    /*
     * The invariant, stated directly: `sweepWillJudge` is false ⇒
     * `sourceVerdictOutstanding` is false. Every role but one, at every
     * version, including a version FROM THE FUTURE — which is the shape a
     * rollback leaves behind.
     */
    const roles = ['unknown', 'floorplan', 'site_plan', 'masterplan', 'interior',
      'location_map', 'materials', 'logo_decorative', 'property_secondary'];
    for (const role of roles) {
      for (const version of [undefined, 0, 1, MARKETPLACE_ELIGIBILITY_VERSION + 5]) {
        const detail = { ...UNELECTED, role, marketplace_eligibility_version: version };
        expect(sweepWillJudge(detail), role).toBe(false);
        expect(sourceVerdictOutstanding(detail), `${role} @ ${version}`).toBe(false);
      }
    }
  });
});

/*
 * THE SECOND WEDGE, ONE DAY AFTER THE FIRST, AND THE SAME SHAPE ONE LEVEL
 * DOWN.
 *
 * MEASURED 12 SEPTEMBER 2026 on `LOT 48 - EMBER - FLYER.pdf`. The election
 * worked: page 1 states the property with its package facts, the render was
 * extracted, stored, `ready`, `role: primary_property` at v24. The
 * eligibility sweep worked: it measured the picture and answered `pending` /
 * `overlay_uncertain` — one faint line, 4.5% of the frame, which at native
 * resolution is the sunlit rim of a CLOUD against quiet render sky. The
 * verdict is honest; the pale-typography corpus and this cloud are not
 * separable at measurement resolution (four instruments were calibrated on
 * the real bytes: column periodicity, full-resolution component structure,
 * two-sided band contrast, stroke-width statistics — the populations overlap
 * on every one).
 *
 * What was wrong: `sourceVerdictOutstanding` demanded a sanitization stamp
 * from every primary, and the sanitization sweep only stamps the rows it
 * ADMITS — a convicted tile, or a recorded repair region. A `pending` verdict
 * is neither ("'we could not read it' is not 'there is a badge on it'", the
 * sweep's own header), so the stamp was owed by nobody, the predicate
 * answered outstanding for ever, `nextImageStage` answered `wait`, and the
 * property looped at `fallback` under the stall guard: thirty-eight claims,
 * every completion `stalled: fallback reported progress without leaving the
 * stage`.
 */
describe('a pending verdict is a closed question, not one on its way', () => {
  /** LOT 48's stored detail, verbatim shape from production. */
  const UNCERTAIN = {
    ...ELECTED,
    provenance_version: 24,
    marketplace_measured: true,
    marketplace_display_eligible: false,
    marketplace_eligibility_state: 'pending',
    marketplace_rejection_reason: 'overlay_uncertain',
    marketplace_eligibility_version: MARKETPLACE_ELIGIBILITY_VERSION,
  } as Record<string, unknown>;

  /** And the container nothing here can decode — the other pending. */
  const UNMEASURED = {
    ...UNCERTAIN,
    marketplace_measured: false,
    marketplace_rejection_reason: 'decoder_unsupported',
  } as Record<string, unknown>;

  it('owes nothing for an uncertain overlay the sweep will never repair', () => {
    expect(sanitizationSweepAdmits(UNCERTAIN)).toBe(false);
    expect(sourceVerdictOutstanding(UNCERTAIN)).toBe(false);
  });

  it('owes nothing for a container nothing could decode, either', () => {
    expect(sanitizationSweepAdmits(UNMEASURED)).toBe(false);
    expect(sourceVerdictOutstanding(UNMEASURED)).toBe(false);
  });

  it('so the ladder runs instead of waiting for ever', () => {
    expect(nextImageStage([imageRow(UNCERTAIN)] as never,
      { sourceSettlementComplete: true })).toBe('web_search');
  });

  it('still owes the repair for a convicted tile, exactly as before', () => {
    const convicted = {
      ...UNCERTAIN,
      marketplace_eligibility_state: 'ineligible',
      marketplace_rejection_reason: 'annotated_marketing_tile',
    };
    expect(sanitizationSweepAdmits(convicted)).toBe(true);
    expect(sourceVerdictOutstanding(convicted)).toBe(true);
    // And a stamped conviction closes it.
    const repaired = {
      ...convicted,
      sanitization_failure: {
        sanitization_version: 99, original_sha256: convicted.stored_sha256,
      },
    };
    expect(sourceVerdictOutstanding(repaired)).toBe(false);
  });

  it('and a recorded repair region is owed work whatever the verdict says', () => {
    const withRegion = {
      ...UNCERTAIN,
      repair_region: {
        original_sha256: UNCERTAIN.stored_sha256,
        boxes: [{ left: 0.1, top: 0.1, right: 0.3, bottom: 0.2 }],
      },
    };
    expect(sanitizationSweepAdmits(withRegion)).toBe(true);
    expect(sourceVerdictOutstanding(withRegion)).toBe(true);
  });

  it('a cleared uncertain picture is displayable and nothing waits on it', () => {
    /*
     * The resolver for an uncertainty no instrument can settle is a PERSON:
     * the sha-bound clearance the precise inspection writes, with an
     * operator as the instrument. LOT 48\'s was the first, written by hand;
     * the record below is its exact shape.
     */
    const cleared = {
      ...UNCERTAIN,
      sanitization_clearance: {
        sanitization_version: 2,
        original_sha256: UNCERTAIN.stored_sha256,
        evidence: { method: 'operator_attested' },
      },
    };
    expect(sourceVerdictOutstanding(cleared)).toBe(false);
    expect(nextImageStage([imageRow(cleared)] as never,
      { sourceSettlementComplete: true })).toBe('none');
  });

  it('the sweep itself reads the same admission, so the two cannot drift', () => {
    expect(SANITIZATION_SWEEP).toContain('if (!sanitizationSweepAdmits(detail)) continue;');
    expect(SANITIZATION_SWEEP).not.toMatch(
      /readMarketplaceState\(detail\) !== 'ineligible'/);
  });
});

describe('nextImageStage — the answer with no exit', () => {
  it('no longer waits on a verdict that is never coming', () => {
    // The exact production row set: two unelected rasters from a refused
    // package. Before the fix this was `wait`, every claim, for ever.
    const rows = [imageRow(UNELECTED), { ...imageRow(UNELECTED), id: 'img-2', position: 1 }];
    expect(nextImageStage(rows as never, { sourceSettlementComplete: true }))
      .toBe('web_search');
  });

  it('still waits where a verdict genuinely IS coming', () => {
    // A designated hero that no sweep has judged yet: spending a search here
    // is how a builder's own render loses to a stock photo. Unchanged.
    expect(nextImageStage([imageRow(ELECTED)] as never, { sourceSettlementComplete: true }))
      .toBe('wait');
  });

  it('still waits while the source stage itself is unfinished', () => {
    expect(nextImageStage([imageRow(UNELECTED)] as never,
      { sourceSettlementComplete: false })).toBe('wait');
  });

  it('and a property with no images at all is untouched by any of this', () => {
    expect(nextImageStage([] as never, { sourceSettlementComplete: true }))
      .toBe('web_search');
  });
});

describe('one rule, imported by every reader', () => {
  /*
   * Two modules deciding separately what a sweep owes is the whole defect.
   * A test on the STRINGS would pass while the meanings drifted, so this
   * asserts that the inline form is gone and the named one is called.
   */
  it('neither sweep spells the filter inline any more', () => {
    for (const [name, source] of [
      ['eligibility', ELIGIBILITY_SWEEP], ['sanitization', SANITIZATION_SWEEP],
    ] as const) {
      expect(source, name).not.toMatch(/isPrimaryRole\(readStoredRole\(/);
      expect(source, name).toMatch(/if \(!sweepWillJudge\(/);
    }
  });

  it('and the ladder asks the same question through the same module', () => {
    const priority = read('supabase/functions/_shared/builderStock/imagePriority.pure.ts');
    expect(priority).toContain('sourceVerdictOutstanding(image.source_detail)');
    // Not by re-deriving the halves for itself, which is what it used to do.
    expect(priority).not.toMatch(/needsEligibilityAssessment\(detail\)/);
  });
});

// ---------------------------------------------------------------------------
// The other half: a stage that cannot move must not report that it moved
// ---------------------------------------------------------------------------

const itemAt = (stage: string): ClaimedItem => ({
  id: 'item-1', organisation_id: 'org-a', upload_id: 'upload-1',
  pending_upload_id: null, image_work_stage: stage,
  image_work_attempts: 0, lifecycle_status: 'active',
});

const fallbackOutcome = (over: Record<string, number>) => ({
  attempted: 0, resolved: 0, laddered: 0, remaining: 0, withheld: 0, problems: [],
  ...over,
});

describe('the fallback stage reports progress only when a rung was climbed', () => {
  it('does NOT call a property it could not move "progress"', async () => {
    // `attempted: 1, laddered: 0` — the ladder looked and ran nothing. This
    // used to be `progressed: true`, which clears the backoff and makes the
    // row claimable in the same millisecond.
    const settlement = await settleClaimedItem({} as never, itemAt('fallback'), {}, {
      settleFallback: (async () => fallbackOutcome({ attempted: 1, remaining: 1 })) as never,
      choosePrimary: (async () => null) as never,
    });
    expect(settlement.progressed).toBe(false);
    expect(settlement.nextStage).toBe('fallback');
  });

  it('does call a rung that actually ran "progress"', async () => {
    const settlement = await settleClaimedItem({} as never, itemAt('fallback'), {}, {
      settleFallback: (async () =>
        fallbackOutcome({ attempted: 1, laddered: 1, remaining: 1 })) as never,
      choosePrimary: (async () => null) as never,
    });
    expect(settlement.progressed).toBe(true);
  });

  it('and a picture that landed is progress however the rung is counted', async () => {
    const settlement = await settleClaimedItem({} as never, itemAt('fallback'), {}, {
      settleFallback: (async () =>
        fallbackOutcome({ attempted: 1, resolved: 1 })) as never,
      choosePrimary: (async () => 'image-9') as never,
    });
    expect(settlement.progressed).toBe(true);
    expect(settlement.nextStage).toBe('settled');
  });

  it('says what it did, in the units it did it in', async () => {
    const settlement = await settleClaimedItem({} as never, itemAt('fallback'), {}, {
      settleFallback: (async () =>
        fallbackOutcome({ attempted: 2, laddered: 1, resolved: 1 })) as never,
      choosePrimary: (async () => null) as never,
    });
    expect(settlement.result).toBe('fallback: attempted 2, climbed 1, resolved 1');
  });
});

// ---------------------------------------------------------------------------
// And the guard that makes the SHAPE impossible, whatever a stage returns
// ---------------------------------------------------------------------------

describe('one invocation never works the same property at the same stage twice', () => {
  it('remembers what it has done', () => {
    expect(SETTLER).toContain('const workedThisInvocation = new Set<string>()');
    expect(SETTLER).toContain('workedThisInvocation.add(`${claimed.id}:${settlement.stage}`)');
    expect(SETTLER).toContain('workedThisInvocation.has(`${candidate.id}:${stage}`)');
  });

  it('hands a repeat back with a real delay and does not clear its backoff', () => {
    const guard = SETTLER.slice(
      SETTLER.indexOf('workedThisInvocation.has('),
      SETTLER.indexOf('THE STAGE IS ONLY KNOWN ONCE CLAIMED'),
    );
    expect(guard).toContain('retryAfterSeconds: STALLED_RETRY_SECONDS');
    // The counter must STAND, so the claim's own backoff carries a genuinely
    // stuck property out of the queue's way.
    expect(guard).toContain('resetAttempts: false');
    expect(guard).toContain('progressed: false');
    // And it is visible, because it means a stage is lying about progress.
    expect(guard).toContain('item_work_stalled');
  });

  it('keeps working instead of ending on the first property it cannot take', () => {
    /*
     * MEASURED over a real eighteen-property import: 21 invocations used 524 s
     * of the 2,100 s they were given. `item tick { settled: 3, claimable: 17,
     * ms: 19360 }` — three documents opened, seventeen properties ready, eighty
     * seconds in hand, and the worker exited. The document allowance is a
     * memory bound on DECODING; eligibility, sanitization and fallback decode
     * nothing and there are three of those claims for every document claim.
     */
    const loop = SETTLER.slice(SETTLER.indexOf('let nextItem:'));
    // A refusal skips the property…
    expect(loop).toContain('handedBack.add(candidate.id)');
    // …and the loop only ends once the whole claimable set has been offered.
    expect(loop).toContain('if (seenBefore || handbacks >= MAX_HANDBACKS_PER_INVOCATION) break;');
    // The allowance itself is untouched: the memory measurement still stands.
    expect(SETTLER).toContain('const HEAVY_DOCUMENTS_PER_INVOCATION = 3;');
  });

  it('bounds what rides along behind the documents, because light is not free', () => {
    /*
     * The allowance is a MEMORY bound: resident memory measured 50 → 173 →
     * 236 → 247 MB over three package reads in one isolate, against a ~256 MB
     * ceiling. The light stages are not free either — eligibility decodes a
     * stored photograph to judge it and sanitization runs a full-resolution
     * decode and reconstruction — so the walk past a spent allowance is
     * bounded rather than unlimited, and bounded inside what production has
     * already run: mixed invocations of eleven items are ordinary in the live
     * log, so three documents plus eight is not a new combination.
     */
    const bound = /const LIGHT_ITEMS_AFTER_DOCUMENTS = (\d+);/.exec(SETTLER);
    expect(bound).not.toBeNull();
    expect(Number(bound![1]) + 3).toBeLessThanOrEqual(11);
    expect(SETTLER).toContain('if (heavyDocuments > 0 && !isHeavy(stage)) {');
    // And the claim that they cost nothing is corrected rather than left
    // standing, because the bound above is a decision taken on its strength.
    expect(SETTLER).toContain('THE LIGHT STAGES ARE NOT FREE');
  });

  it('is bounded, so a large uniformly-unworkable queue is not walked end to end', () => {
    const bound = /const MAX_HANDBACKS_PER_INVOCATION = (\d+);/.exec(SETTLER);
    expect(bound).not.toBeNull();
    expect(Number(bound![1])).toBeGreaterThan(0);
    expect(Number(bound![1])).toBeLessThanOrEqual(25);
  });

  it('still stops when the clock is genuinely gone', () => {
    const loop = SETTLER.slice(SETTLER.indexOf('let nextItem:'));
    expect(loop).toContain('if (Date.now() > startedAt + BUDGET_MS - LIGHT_STAGE_RESERVE_MS) break;');
  });
});
