/**
 * Builder stock — bringing stock that is ALREADY imported up to the current
 * image rules, with nobody watching.
 *
 * WHY THIS EXISTS. Changing what counts as a property's primary image makes
 * every previously stored image row out of date by definition: it proves where
 * its bytes came from and says nothing about what the source presented them as.
 * The repair that fixes that has existed for a while and was only ever reachable
 * through a "Source images" button in the Builder Portal, one stock list at a
 * time. Asking a builder to press a button on every source they have ever
 * uploaded is not a deployment step; it is a defect with instructions.
 *
 * So this drives the SAME repair from pg_cron. It is a sweep, not a service:
 * every upload carries a settled-version marker, this brings the ones below
 * the current version up to it, and when none are left the migration's cron
 * job unschedules itself. Nothing here is on a read path and nothing runs when
 * there is no work.
 *
 * IT NOW CARRIES THREE KINDS OF WORK, UNDER THREE MARKERS. Provenance
 * (`source_images_settled_version`) is where a row's bytes came from and what
 * the source designated them as. Marketplace display eligibility
 * (`marketplace_eligibility_settled_version`) is whether the picture itself may
 * go on a card — a facade under a status ribbon answers every provenance
 * question correctly and is still not a card image. They are versioned apart on
 * purpose: improving the classifier must not re-fetch every Notion page, and
 * re-reading a source must not re-run a classifier that has not changed. An
 * upload behind on either is outstanding, and every upload written before the
 * fourth question existed is behind on the second one — which is what makes
 * this the thing that repairs production, with nobody pressing anything.
 *
 * AND A THIRD: THE OVERLAY REPAIR (`image_sanitization_settled_version`). Where
 * the display gate refused a picture for carrying a promotional graphic laid
 * over it, the graphic is taken off the builder's OWN file and the result is
 * stored once, beside the original, as a versioned derivative. It is on its own
 * marker for the same reason the other two are: a better repair must not
 * re-fetch every source, and a better classifier must not re-run every repair.
 * It is by far the most expensive of the three and is capped hardest.
 *
 * WHAT IT MAY WRITE. `builder_stock_item_images` rows, the display verdict and
 * the derivative record inside their `source_detail`, sanitized derivative
 * objects in the image bucket, the `primary_image_id` those rows earn, and the
 * three settlement markers. NO STORED IMAGE IS EVER REWRITTEN: eligibility
 * re-READS each object to measure it, and the overlay repair writes a NEW
 * object and leaves the builder's file, its hashes and its provenance exactly
 * as they are. No picture is replaced by another picture — not a map, not a
 * street view, not a search result, not stock imagery, not another property. No stock item is created or
 * deleted; no price, availability, configuration, status, selection, builder or
 * project/unit linkage is touched. Those guarantees are `repairSourceImages.ts`'s
 * and are not restated here — this only decides WHICH uploads it runs for.
 *
 * AND ONE THING THAT IS NOT A SWEEP AT ALL: `preview_sanitization`, which
 * produces a repair candidate for one image and hands back the PNG without
 * writing anything anywhere. It lives here because this is the function that
 * already holds the worker credential and already refuses every caller that is
 * not internally signed; it exists because the generative route's model is
 * behind a deployment secret, so before it the only way to SEE a candidate was
 * to let production write one over a picture a client was already being shown.
 * See `previewSanitization.ts`.
 *
 * SECURITY. Internal callers only, through the signed envelope
 * (`verifyInternal`). It holds a service-role client and crosses organisations,
 * which is exactly why it must not be reachable by a portal session. The
 * preview is behind that same gate and adds no other way in.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import { choosePhase } from '../_shared/builderStock/settlementPhase.pure.ts';
import { createCorsHeaders } from '../_shared/auth.ts';
import { verifyInternal } from '../_shared/auth_v2.ts';
import { enforceRawBodyLimit } from '../_shared/requestSecurity.ts';
import { internalErrorResponse } from '../_shared/errorResponse.ts';
import {
  readEligibilityTarget, readOutstandingUploads, readSanitizationTarget,
  readSettlementReadiness, runSettlementTick, settleUploadSourceImages,
  ELIGIBILITY_SETTLED_VERSION_COLUMN, SANITIZATION_SETTLED_VERSION_COLUMN,
  SETTLED_VERSION_COLUMN,
  type SettlementCandidate,
} from '../_shared/builderStock/settleSourceImages.ts';
import { newRepairBudget } from '../_shared/builderStock/settleImageSanitization.ts';
import {
  settleFallbackImages, MAX_FALLBACK_ITEMS_PER_TICK,
} from '../_shared/builderStock/settleFallbackImages.ts';
import { previewSanitization } from '../_shared/builderStock/previewSanitization.ts';
import { PROVENANCE_VERSION } from '../_shared/builderStock/sourceImages.ts';
import { enforceStrictPrimaryImages } from '../_shared/builderStock/primaryImage.ts';
import {
  claimOneImageWorkItem, completeItemWork, isMissingCapability, readItemWorkPending,
} from '../_shared/builderStock/itemWorkClaim.ts';
import { settleClaimedItem } from '../_shared/builderStock/settleItemImages.ts';

/*
 * The canonical headers, not a hand-rolled copy.
 *
 * The copy this replaces was a snapshot of the allowlist on the day it was
 * written: it was already missing `x-correlation-id` and `x-step-up-token`,
 * and it declared no `Access-Control-Expose-Headers` at all — so any custom
 * response header would have read back as `null`. A hand-rolled list can only
 * ever go stale, which is why `check-cors-contract.mjs` refuses one.
 *
 * `createCorsHeaders()` with no origin also drops the wildcard ACAO the copy
 * carried. This function holds a service-role client and crosses
 * organisations; `*` on it was wrong independently of the preflight.
 */
const corsHeaders = createCorsHeaders();

/** Wall clock for one tick, well inside the edge ceiling. */
const BUDGET_MS = 100_000;
/** Sources one tick may read. Resumable, so small is safe and slow is not. */
const MAX_UPLOADS_PER_TICK = 6;
/**
 * Outstanding uploads one tick asks the database for.
 *
 * Comfortably more than it can settle, so the tick always has the oldest work
 * in front of it, and bounded so a very large backlog drains over several ticks
 * rather than arriving in one response.
 */
const MAX_QUEUE_ROWS = 100;
const MAX_BODY_BYTES = 8 * 1024;

/**
 * How often the phase rotation advances.
 *
 * The cron interval, so one tick is one phase and the next tick is the next
 * one. Reading the clock rather than a counter keeps this function stateless;
 * the only property required is that consecutive ticks land on consecutive
 * indices, which any period at or below the cron's gives.
 */
const TICK_ROTATION_MS = 5 * 60 * 1000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const bounded = await enforceRawBodyLimit(req, MAX_BODY_BYTES);
  if (!bounded.ok) return bounded.error;
  const gate = await verifyInternal(supabase, req, bounded.raw);
  if (!gate.ok) {
    console.warn('[builder-stock-image-settler] verifyInternal denied', {
      errorCode: (gate as { errorCode?: string }).errorCode,
    });
    return json({ error: 'Forbidden' }, 403);
  }

  /**
   * LOOK AT A CANDIDATE WITHOUT LETTING IT BECOME A PICTURE.
   *
   * The generative route is the only one that can clean some facades, its model
   * lives behind the private worker, and the worker's token is a deployment
   * secret — so before this existed the only way to SEE a candidate was to let
   * production write one over the picture a client is already being shown.
   *
   * It is here rather than anywhere else because this is the function that
   * already holds the worker credential, already refuses everything that is not
   * an internally-signed caller, and already imports the repair. Nothing about
   * it reaches a portal session or the marketplace, and it writes nothing at
   * all — see `previewSanitization.ts`, where that is the enforced property.
   *
   * Placed AFTER `verifyInternal` and before any settlement work, so an
   * unsigned caller is refused exactly as it always was and a tick with no
   * `operation` behaves precisely as it did before this block existed.
   */
  let body: Record<string, unknown> = {};
  try {
    body = bounded.raw ? JSON.parse(bounded.raw) as Record<string, unknown> : {};
  } catch {
    body = {};
  }

  if (String(body.operation ?? '') === 'preview_sanitization') {
    const preview = await previewSanitization(supabase, {
      organisationId: String(body.organisation_id ?? ''),
      imageId: String(body.image_id ?? ''),
      originalSha256: String(body.original_sha256 ?? ''),
      boxes: (Array.isArray(body.boxes) ? body.boxes : []) as never,
    });

    if (preview.ok === false) {
      console.warn('[builder-stock-image-settler] preview refused', {
        phase: 'preview_sanitization',
        image_id: String(body.image_id ?? '').slice(0, 64),
        reason: preview.reason,
      });
      return json({ success: false, error: preview.reason, detail: preview.detail },
        preview.status);
    }

    /*
     * The candidate itself, and facts about how it was made. No path, no
     * bucket, no credential and no worker address: an operator needs to see
     * the picture and know what it cost, not where the secrets are.
     */
    const headers: Record<string, string> = {
      ...corsHeaders,
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'x-builder-stock-preview': 'true',
      'x-repaired-share': preview.repairedShare.toFixed(5),
      'x-repair-route': preview.transformation,
      'x-regions-removed': String(preview.regionsRemoved),
    };
    // Reported only when the metering ledger could actually be read. A count
    // nobody measured is worse than no count at all.
    if (preview.modelCalls !== null) headers['x-model-calls'] = String(preview.modelCalls);
    if (preview.model) headers['x-inpaint-model'] = preview.model;

    return new Response(preview.bytes as unknown as BodyInit, { status: 200, headers });
  }

  const startedAt = Date.now();
  const deadlineAt = startedAt + BUDGET_MS;

  /*
   * ═══════════════════════════════════════════════════════════════════════
   * THE PER-ITEM PATH. ONE INVOCATION, ONE PROPERTY, NO GLOBAL LEASE.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * WHY IT COMES FIRST AND TAKES NO LEASE. The lease below is a single boolean
   * row for the whole deployment. It was the queue lock, and a killed worker
   * runs no `finally`, so it held that row for its full term while the queue
   * stayed shut for every property — not just the one that died. Production,
   * 29 August, seventeen minutes: six `CPU Time exceeded`, ten `lease_held`,
   * not one completed tick, no work at all.
   *
   * The item claim replaces it. `FOR UPDATE SKIP LOCKED` means a property
   * somebody else holds is stepped over rather than waited for, so two
   * invocations can never own the same property and may freely own different
   * ones. Taking the global lease here as well would put the old bottleneck
   * straight back in front of the fix, so this path does not touch it.
   *
   * EXACTLY ONE PROPERTY PER INVOCATION. Claiming a batch and working through
   * it inside one invocation rebuilds the very thing this replaces: claim A,
   * B, C, D — A kills the worker — and B, C and D are leased by a process that
   * no longer exists, having never been looked at. Throughput comes from
   * invoking more often, never from widening this number.
   */
  const itemClaim = await claimOneImageWorkItem(supabase, {
    leaseSeconds: Math.ceil(BUDGET_MS / 1000) + 20,
  });

  if (itemClaim.available) {
    if (!itemClaim.item) {
      /*
       * Nothing due. That is NOT the same as nothing left — a property may be
       * leased by a live invocation or backing off after a kill — so the
       * scheduler is told both numbers and retires the job only on the second.
       */
      const pending = await readItemWorkPending(supabase);
      console.log('[builder-stock-image-settler] item tick', {
        phase: 'item_work', claimed: 0,
        claimable: pending.claimable, outstanding: pending.outstanding,
      });
      return json({
        success: true, path: 'item_work', settled: 0,
        claimable: pending.claimable, outstanding: pending.outstanding,
        complete: pending.outstanding === 0, deploymentReady: true,
      });
    }

    const claimed = itemClaim.item;
    /*
     * The whole tick's wall clock goes to this one property, less a reserve to
     * write the outcome down. That is the other half of the fix: the upload
     * walk gave each property a 12-second slice of which the preceding ones had
     * already spent most, so a linked-package recovery — which declines the bet
     * unless ten seconds remain — could be starved indefinitely while the
     * counter that would have retired it never advanced.
     */
    const settlement = await settleClaimedItem(supabase, claimed, {
      deadlineAt: startedAt + BUDGET_MS - 10_000,
      repairBudget: newRepairBudget(),
    });

    /*
     * A CLAIM THAT SUCCEEDS AND A COMPLETION THAT DOES NOT IS THE WORST HALF
     * OF A HALF-DEPLOYED MIGRATION, so it is named rather than swallowed.
     *
     * PostgREST resolves a function by the argument NAMES in the request body,
     * so a completion whose signature has moved on answers PGRST202 — the same
     * "not deployed" this file already handles for the claim. Reaching here
     * with `available: false` therefore means the two halves disagree: the
     * property was claimed, the work was done, and nothing recorded it. It
     * stays leased until expiry and is then re-done, for ever.
     *
     * That exact state existed in production: 20261019000000 shipped
     * `complete_builder_stock_image_work` with five arguments while this code
     * calls it with six. There is no repair from in here — the migration has
     * to land — so the job is to make it unmissable rather than to guess.
     */
    const completion = await completeItemWork(supabase, claimed.id, {
      nextStage: settlement.nextStage,
      result: settlement.result,
      error: settlement.error ?? null,
      retryAfterSeconds: 0,
      progressed: settlement.progressed,
    });
    if (!completion.available) {
      console.error('[builder-stock-image-settler] work was claimed but could not be recorded', {
        phase: 'deployment_skew',
        stock_item_id: claimed.id,
        missing: 'public.complete_builder_stock_image_work(uuid,text,text,text,integer,boolean)',
        remedy: 'apply supabase/migrations/'
          + '20261021000000_builder_stock_item_work_claim_amendments.sql',
      });
      return json({
        success: false, path: 'item_work', error: 'item_completion_unavailable',
        deploymentReady: false, stage: settlement.stage,
      }, 503);
    }

    const pending = await readItemWorkPending(supabase);
    console.log('[builder-stock-image-settler] item tick', {
      phase: 'item_work',
      stock_item_id: claimed.id,
      stage: settlement.stage,
      next_stage: settlement.nextStage,
      progressed: settlement.progressed,
      primary_set: settlement.primarySet,
      claimable: pending.claimable,
      outstanding: pending.outstanding,
      ms: Date.now() - startedAt,
    });

    return json({
      success: true, path: 'item_work', settled: 1,
      stage: settlement.stage, nextStage: settlement.nextStage,
      progressed: settlement.progressed, primarySet: settlement.primarySet,
      error: settlement.error ?? undefined,
      claimable: pending.claimable, outstanding: pending.outstanding,
      complete: pending.outstanding === 0, deploymentReady: true,
    });
  }

  /*
   * ═══════════════════════════════════════════════════════════════════════
   * DEPLOYMENT SKEW. The claim function is not there yet.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Edge functions ship automatically when `main` moves; migrations here are
   * dispatched by hand. So this build WILL run against a database without
   * `claim_builder_stock_image_work`, and that must not be an outage: on 29
   * August a settler requiring an unapplied lease function answered 503 on
   * every tick and the entire marketplace went blank until somebody noticed.
   *
   * Loud, and then the old path, unchanged. Slow is not an outage.
   */
  console.warn('[builder-stock-image-settler] per-item claim not deployed — using the upload walk', {
    phase: 'deployment_skew',
    missing: 'public.claim_builder_stock_image_work',
    remedy: 'apply supabase/migrations/20261019000000_builder_stock_item_work_claim.sql',
  });

  /*
   * ONE SETTLER AT A TIME.
   *
   * The cron offers this function a turn every minute while work is
   * outstanding, and `BUDGET_MS` permits a single tick to run for a hundred
   * seconds. Production has never come near that — 16.9s is the worst completed
   * tick across 101 of them — but two settlers reading the same queue would
   * start the same package twice, and "has not happened yet" is not a guard.
   *
   * The lease is a compare-and-set row rather than an advisory lock because
   * this function holds no persistent database session: it speaks PostgREST,
   * over HTTP, and a lock taken on one connection would not span the run. It
   * EXPIRES rather than being released, so a worker killed on a resource limit
   * — no `finally`, no response, as this repository has already paid to learn —
   * costs one skipped minute instead of wedging the queue shut.
   *
   * Declining is a normal outcome and not a failure: the previous turn is still
   * working, and the next minute will offer another.
   */
  const lease = await supabase.rpc('claim_builder_stock_settlement_lease', {
    p_seconds: Math.ceil(BUDGET_MS / 1000) + 20,
    p_holder: 'builder-stock-image-settler',
  });
  /*
   * A LEASE THAT IS NOT DEPLOYED IS NOT A REASON TO STOP EITHER.
   *
   * The fallback path must not reintroduce the failure the path above exists
   * to survive. A deployment with neither migration applied would otherwise
   * answer 503 here — an outage reached by falling back FROM an outage. A
   * missing lease means only that nothing is serialising ticks, which is
   * exactly the state this function ran in for its whole life before the lease
   * existed. A live lease FAULT is different and still refuses.
   */
  const leaseMissing = !!lease.error && isMissingCapability(lease.error);
  if (lease.error && !leaseMissing) {
    console.error('[builder-stock-image-settler] settlement lease unavailable', {
      phase: 'settlement_lease',
      reason: String(lease.error?.message ?? lease.error).slice(0, 200),
    });
    return json({ success: false, error: 'Settlement lease unavailable' }, 503);
  }
  if (leaseMissing) {
    console.warn('[builder-stock-image-settler] settlement lease not deployed — proceeding unserialised', {
      phase: 'deployment_skew', missing: 'public.claim_builder_stock_settlement_lease',
    });
  }
  if (!lease.error && lease.data !== true) {
    console.log('[builder-stock-image-settler] tick skipped — previous run still holds the lease');
    return json({ success: true, skipped: 'lease_held' });
  }

  const releaseLease = async () => {
    if (leaseMissing) return;
    try {
      await supabase.rpc('release_builder_stock_settlement_lease');
    } catch {
      // The lease expires on its own; failing to hand it back early is not
      // worth failing a tick that otherwise did its work.
    }
  };

  try {
    /**
     * The uploads with work outstanding, oldest source first.
     *
     * ASKED OF THE DATABASE, NOT FILTERED IN MEMORY. This used to read the
     * oldest 500 uploads and filter them here, which meant 500 settled uploads
     * were enough to hide every outstanding one behind them: the tick found
     * nothing, reported the queue empty, and the 501st was never reached.
     * `readOutstandingUploads` asks for the rows that are actually behind, so
     * the queue drains at 500 uploads and at 50,000.
     *
     * The eligibility version it selects against is the DATABASE's target, not
     * this build's constant — see `readEligibilityTarget`, which is what makes
     * a later classifier bump wake production rather than change nothing.
     */
    /*
     * THE SCHEMA THIS NEEDS, CHECKED BEFORE ANYTHING ELSE.
     *
     * Edge functions ship automatically when `main` moves; migrations here are
     * dispatched by hand, one file at a time. So the display gate can be live
     * for days before the columns that let this clear it exist — and when that
     * happened, every marketplace card went blank while this function reported
     * `success: true` with `skipped: 'marker_unavailable'`, because a missing
     * column and an empty queue looked identical to it.
     *
     * A missing schema is an operational failure with a name now. It answers
     * 503 and says which piece is absent, so the deployment is visibly
     * incomplete rather than quietly finished.
     */
    const readiness = await readSettlementReadiness(supabase);
    if (!readiness.ready) {
      console.error('[builder-stock-image-settler] settlement schema not deployed', {
        phase: 'deployment_readiness',
        missing: readiness.missing,
        remedy: 'apply supabase/migrations/*_builder_stock_*settlement*.sql, '
          + '*_builder_stock_eligibility_target_version.sql and '
          + '*_builder_stock_terminal_negative_provenance.sql and '
          + '*_builder_stock_image_sanitization_settlement.sql',
      });
      return json({
        success: false,
        error: 'settlement_schema_unavailable',
        deploymentReady: false,
        missing: readiness.missing,
      }, 503);
    }

    const eligibilityTarget = await readEligibilityTarget(supabase);
    const sanitizationTarget = await readSanitizationTarget(supabase);
    const queue = await readOutstandingUploads(supabase, {
      limit: MAX_QUEUE_ROWS, eligibilityTarget, sanitizationTarget,
    });

    if (queue.unavailable) {
      // Readiness passed a moment ago, so this is a live read fault rather than
      // a missing column. Either way it is not an empty queue.
      console.error('[builder-stock-image-settler] upload queue unreadable', {
        phase: 'settlement_scan',
      });
      return json({
        success: false, error: 'upload_queue_unreadable', deploymentReady: true,
      }, 503);
    }

    const outstanding = queue.rows;

    if (!outstanding.length) {
      /**
       * SETTLEMENT IS DONE. THE WORK IS NOT NECESSARILY DONE.
       *
       * This used to answer `complete: true` here, and the migration's job
       * unschedules itself on that — so the sweep went permanently quiet the
       * moment the last upload's provenance, eligibility and sanitization
       * markers were current. `readOutstandingUploads` reads
       * `builder_stock_uploads` and nothing else; it has never known that a
       * PROPERTY can still be owed the fallback ladder.
       *
       * That is how three properties came to sit blank for ever with a
       * terminal `no_deterministic_image` and not one image row: their builder
       * supplied no usable photograph, stage A said so honestly, and the only
       * thing that would have looked anywhere else was `enrich_images` in the
       * Builder Portal — a loop that runs while somebody has the page open.
       * Close the browser after an import and the ladder never ran.
       *
       * So the empty settlement queue is where the fallback phase belongs, and
       * it is also the one place it is unconditionally SAFE: no upload is
       * still being read, so no property is about to gain the builder's own
       * render, and stage B or C cannot be bought against a card that is about
       * to have the real picture. That is #2305's rule, kept rather than
       * traded for speed.
       */
      const fallback = await settleFallbackImages(supabase, {
        limit: MAX_FALLBACK_ITEMS_PER_TICK,
        deadlineAt,
      });

      if (fallback.problems.length) {
        console.warn('[builder-stock-image-settler] fallback problems', {
          phase: 'fallback_enrichment', problems: fallback.problems.slice(0, 3),
        });
      }

      /*
       * An unreadable queue is not an empty one. Answering `complete` on a
       * failed read would unschedule the cron on a database fault — the same
       * shape as the missing-column bug above, and just as silent.
       */
      if (fallback.unavailable) {
        console.error('[builder-stock-image-settler] fallback queue unreadable', {
          phase: 'fallback_enrichment',
        });
        return json({
          success: false, error: 'fallback_queue_unreadable', deploymentReady: true,
        }, 503);
      }

      console.log('[builder-stock-image-settler] fallback tick', {
        phase: 'fallback_enrichment',
        attempted: fallback.attempted,
        resolved: fallback.resolved,
        remaining: fallback.remaining,
      });

      /*
       * THE COMPLETION RULE. Quiet requires BOTH queues empty. A settlement
       * queue at zero with fallback work outstanding keeps the cron alive.
       */
      return json({
        success: true,
        phase: 'fallback_enrichment',
        settled: 0,
        remaining: 0,
        fallbackAttempted: fallback.attempted,
        fallbackResolved: fallback.resolved,
        fallbackRemaining: fallback.remaining,
        complete: fallback.remaining === 0,
        deploymentReady: true, eligibilityTarget, sanitizationTarget,
      });
    }

    /**
     * The tick's own rule lives in the shared module, not here.
     *
     * It is the part with a defect worth pinning — the cap counts settlements
     * rather than attempts, so one upload that can never settle cannot starve
     * the queue behind it — and a rule inside a `Deno.serve` handler is a rule
     * nothing can test.
     */
    const candidates = outstanding.map((row): SettlementCandidate => ({
      id: String(row.id),
      organisation_id: String(row.organisation_id),
      needsProvenance:
        Number(row[SETTLED_VERSION_COLUMN] ?? 0) < PROVENANCE_VERSION,
      needsEligibility:
        Number(row[ELIGIBILITY_SETTLED_VERSION_COLUMN] ?? 0) < eligibilityTarget,
      needsSanitization:
        Number(row[SANITIZATION_SETTLED_VERSION_COLUMN] ?? 0) < sanitizationTarget,
    }));

    const enforced = new Set<string>();
    const enforce = async (organisationId: string) => {
      if (enforced.has(organisationId)) return;
      enforced.add(organisationId);
      try {
        await enforceStrictPrimaryImages(supabase, organisationId);
      } catch (enforceError) {
        console.warn('[builder-stock-image-settler] primaries not enforced', {
          organisation_id: organisationId,
          phase: 'primary_enforcement',
          message: String((enforceError as { message?: string })?.message ?? enforceError)
            .slice(0, 200),
        });
      }
    };

    /**
     * ENFORCE BEFORE SETTLING, for organisations whose verdicts are already in.
     *
     * Enforcement is a handful of queries and it is the step that decides what
     * a card may draw; settlement decodes images and re-fetches source
     * documents, and the edge worker kills the invocation on its RESOURCE
     * limit long before the wall-clock budget below is reached. Every
     * production tick returned 546, which meant the loop after the settlement
     * tick was never arrived at: upload f7e0d4d1 held a complete set of
     * verdicts and its organisation's stale pointers went on not being
     * rewritten, one per tick at best.
     *
     * An upload still in the queue for its PROVENANCE half has nothing
     * outstanding that enforcement reads, so running it first is not running it
     * early. The `needsEligibility === false` test is the same licence
     * `eligibilitySettled` gives below — a finished sweep, banked on an earlier
     * pass — and `enforceStrictPrimaryImages` still skips any item holding an
     * unjudged candidate.
     */
    for (const candidate of candidates) {
      if (!candidate.needsEligibility) await enforce(candidate.organisation_id);
    }

    /*
     * ONE overlay-repair allowance for the whole tick, not one per upload.
     *
     * A repair is a full-resolution decode plus a reconstruction or up to four
     * model calls; the worker's resource limit is what kills this function, and
     * it kills it long before the wall clock above expires. Six uploads each
     * spending their own allowance is twelve of them and a 546 with nothing
     * written — which is the failure this whole settlement programme exists
     * because of. The budget is shared, so the tick spends it once.
     */
    const repairBudget = newRepairBudget();

    /**
     * ONE PHASE PER INVOCATION, AND PRODUCTION IS WHY.
     *
     * The three phases are independent questions with independent markers, and
     * running all three in one invocation is what kills this function: a tick
     * that re-reads a builder's Drive package (a folder listing, a multi-megabyte
     * PDF download, a text extraction and a raster extraction), THEN sweeps
     * display eligibility, THEN spends the overlay-repair budget on
     * full-resolution decodes, exceeds the worker's CPU allowance and returns
     * 546 with NOTHING WRITTEN. Every tick then does the same work and dies the
     * same way, so a queue that looks busy makes no progress at all — which is
     * exactly what a provenance-version bump produced here: 26 reopened
     * packages, and 546 on every tick.
     *
     * So the tick picks the one phase with work and does only that. Nothing is
     * skipped and no cap is relaxed: the phases have their own markers, the
     * sweep is resumable, and a phase deferred by this tick is the phase the
     * next tick picks. It costs ticks and never coverage.
     *
     * PROVENANCE FIRST, because it is the phase that DISCOVERS images. The
     * other two judge and repair pictures that provenance has already found, so
     * running them first would be spending the expensive budget deciding about
     * a smaller set than the one we are about to have.
     */
    // One phase per tick, rotated so none starves. See `settlementPhase.pure.ts`.
    const phase = choosePhase(candidates, startedAt, TICK_ROTATION_MS);

    const { attempted, settled, organisations } = await runSettlementTick(
      candidates,
      { maxSettled: MAX_UPLOADS_PER_TICK, deadlineAt },
      (candidate) => settleUploadSourceImages(supabase, {
        organisationId: candidate.organisation_id,
        uploadId: candidate.id,
        deadlineAt,
        needsProvenance: phase === 'provenance' && candidate.needsProvenance,
        needsEligibility: phase === 'eligibility' && candidate.needsEligibility,
        needsSanitization: phase === 'sanitization' && candidate.needsSanitization,
        repairBudget,
      }),
    );

    /**
     * And every organisation whose eligibility sweep finished DURING this tick,
     * which the pass above could not have known about.
     *
     * A property whose source no longer designates a displayable image must END
     * this run with no primary rather than the one it had under the old rules,
     * and that is true of properties the sweep never re-read, which is why it
     * is applied per organisation rather than per upload. What it must NOT do
     * is decide on evidence that was never gathered: `runSettlementTick`
     * collects an organisation only where the eligibility sweep actually
     * completed, and `enforceStrictPrimaryImages` skips any item still holding
     * an unjudged candidate. Between them, an unfinished backfill cannot clear
     * the pointer of a property whose picture is about to be approved.
     */
    for (const organisationId of organisations) await enforce(organisationId);

    const remaining = Math.max(0, outstanding.length - settled);
    console.log('[builder-stock-image-settler] tick', {
      attempted, settled, remaining, ms: Date.now() - startedAt,
    });
    // `phase` is reported because a tick that did one phase and left the others
    // is indistinguishable from a tick that did nothing, and telling them apart
    // from the outside is the whole point of this response.
    return json({
      success: true, phase, settled, attempted, remaining, complete: remaining === 0,
    });
  } catch (error) {
    // `internalError` builds the BODY; the handler owes `Deno.serve` a
    // Response. Returning the body meant the sweep's only failure path
    // answered with something the runtime cannot serve — and the arguments
    // were transposed besides, so the headers were being logged as the
    // context and the context discarded as a correlation id.
    return internalErrorResponse(error, '[builder-stock-image-settler]', corsHeaders);
  } finally {
    /*
     * Hand the turn back as soon as the work is done, on every path this
     * function can return by. A tick that took seven seconds must not hold the
     * next two minutes; the expiry above is the backstop for the one path that
     * runs no code at all — a resource-limit kill.
     */
    await releaseLease();
  }
});
