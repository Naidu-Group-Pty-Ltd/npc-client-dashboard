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
 * SECURITY. Internal callers only, through the signed envelope
 * (`verifyInternal`). It holds a service-role client and crosses organisations,
 * which is exactly why it must not be reachable by a portal session.
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
import { PROVENANCE_VERSION } from '../_shared/builderStock/sourceImages.ts';
import { enforceStrictPrimaryImages } from '../_shared/builderStock/primaryImage.ts';

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

  const startedAt = Date.now();
  const deadlineAt = startedAt + BUDGET_MS;

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
      // Quiet path. The migration's job unschedules itself on this.
      return json({
        success: true, settled: 0, remaining: 0, complete: true,
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
  }
});
