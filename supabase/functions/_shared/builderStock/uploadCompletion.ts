/**
 * BUILDER STOCK — AN UPLOAD'S OWN STATUS IS SETTLED BY THE SERVER.
 *
 * WHAT HAPPENED. Every stage of imagery moved into the backend settler —
 * reading the builder's own documents, ranking what a card may draw, retiring
 * a picture whose source is gone — so an import now finishes with nobody
 * watching. The upload ROW's status did not move with it: `enriching` →
 * `complete`, and the `image_stage_summary` audit record beside it, was
 * written in exactly one place — the `enrich_images` operation, which is the
 * loop the Builder Portal runs WHILE SOMEBODY HAS THE PAGE OPEN.
 *
 * MEASURED, 2 SEPTEMBER 2026: upload `tq.csv` imported at 14:04 (14 rows
 * detected, 14 updated, 0 failed) and ninety minutes later its eleven live
 * properties were all `settled`, ten of them drawing the builder's own
 * brochure render — while the upload still read `enriching` with
 * `image_stage_summary: {}`. The work was done; the RECORD of it was waiting
 * for a browser. A builder reading that history is told an import is still
 * churning hours after it finished, and the audit summary is empty precisely
 * where a reader looks for it.
 *
 * So the rule lives here, once, and both callers ask it: the portal's loop
 * (settling the upload a person is watching) and the settler's tick (settling
 * every upload nobody is watching). Two implementations of "is this import
 * finished" is how one of them comes to be wrong.
 *
 * Three rules carry it.
 *
 *   - COMPLETION IS DECIDED ON THE PROPERTIES ALONE. An upload is finished
 *     when no active property of its own is still owed enrichment. Whether
 *     the settlement queue has caught up is a different question, and gating
 *     on it would leave a source too large to settle inside one budget
 *     reading `enriching` for ever. That is the rule the portal already
 *     applied, kept verbatim rather than re-derived.
 *   - A READ THAT FAILED IS NOT AN IMPORT THAT FINISHED. A failed count and
 *     an incomplete paged read both refuse to settle, because writing
 *     `complete` with an empty summary on a database fault produces an audit
 *     record that states, permanently and wrongly, that no images were
 *     processed. The portal's copy read `stagePage.rows` without consulting
 *     `stagePage.failed`, which is exactly that defect.
 *   - THE IMPORT'S OWN VERDICT DECIDES THE FINAL STATUS: an upload that could
 *     not save every row settles to `partially_complete`, never `complete`.
 *
 * THE SAME MODULE ANSWERS ONE MORE QUESTION ABOUT AN UPLOAD ROW'S OWN STATE:
 * whether a `parsing` row is still being read, or was abandoned by a request
 * that died. Both recovery doors were shut on the second case —
 * `process_upload` answers "This file has already been processed" (it has
 * not) and `reprocess_upload` answers "This source is being read right now"
 * (it is not) — so a builder whose import was killed mid-parse could never
 * import that file again, and their only recourse was deleting the source,
 * which archives its properties. An edge invocation cannot outlive its own
 * ceiling of roughly 150 seconds, and worker kills are a measured, ordinary
 * event in this pipeline, so a `parsing` row older than a generous multiple
 * of that ceiling is not in flight.
 */
import { readAllRows } from './pagedRead.ts';

/** The statuses an upload may still be completed FROM. */
export const COMPLETABLE_UPLOAD_STATUSES = ['enriching', 'partially_complete'];

/** Enrichment states meaning a property has not been through imagery yet. */
export const UNFINISHED_ENRICHMENT_STATUSES = ['pending', 'enriching'];

/** Uploads one settler tick will look at. Cheap reads, and resumable. */
const MAX_UPLOADS_PER_PASS = 25;

/**
 * How long a `parsing` row may be believed.
 *
 * An edge invocation is capped at roughly 150 seconds and stamps
 * `processing_started_at` before it begins, so six times that ceiling cannot
 * mistake a running import for an abandoned one — while a request killed on
 * its resource limit stops refusing the retry a quarter of an hour later
 * rather than never.
 */
export const ABANDONED_PARSE_MS = 15 * 60 * 1000;

/**
 * Is this `parsing` row a request that died, rather than one still running?
 *
 * Answers false for every other status: only a `parsing` row makes the claim
 * this question is about.
 */
export function parseIsAbandoned(
  upload: { status?: unknown; processing_started_at?: unknown },
  now: number = Date.now(),
): boolean {
  if (String(upload?.status) !== 'parsing') return false;
  const startedAt = Date.parse(String(upload?.processing_started_at ?? ''));
  /*
   * Every path that sets `parsing` stamps the start in the same write, so a
   * row without one cannot be an import in flight — and refusing the retry on
   * an unreadable stamp is the failure this exists to end.
   */
  if (!Number.isFinite(startedAt)) return true;
  return now - startedAt > ABANDONED_PARSE_MS;
}

export type SettledUploadStatus = 'complete' | 'partially_complete';

export type CompletionRefusal =
  | 'not_found'
  | 'not_completable'
  | 'items_outstanding'
  | 'read_failed';

export interface UploadCompletionOutcome {
  /** The status written, or null when nothing was written. */
  status: SettledUploadStatus | null;
  /** Why nothing was written. Absent on success. */
  refusal?: CompletionRefusal;
}

interface StageRow { source_stage: unknown; processing_status: unknown }

/**
 * The audit record a builder reads: how many images of each source stage
 * ended in each processing state.
 */
export function summariseImageStages(
  rows: StageRow[],
): Record<string, Record<string, number>> {
  const summary: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    const stage = String(row.source_stage);
    const state = String(row.processing_status);
    summary[stage] = summary[stage] ?? {};
    summary[stage][state] = (summary[stage][state] ?? 0) + 1;
  }
  return summary;
}

/** The import's own verdict, not the imagery's. */
export function finalUploadStatus(recordsFailed: unknown): SettledUploadStatus {
  return Number(recordsFailed ?? 0) > 0 ? 'partially_complete' : 'complete';
}

/**
 * Settle ONE upload, if its properties are finished with enrichment.
 *
 * Returns the status written, or the reason nothing was. Never throws: a
 * caller settles records as housekeeping and must not fail its own work over
 * it.
 */
export async function settleUploadCompletion(
  db: any,
  params: { uploadId: string; organisationId?: string | null },
): Promise<UploadCompletionOutcome> {
  const uploadId = String(params.uploadId ?? '');
  if (!uploadId) return { status: null, refusal: 'not_found' };

  try {
    let uploadQuery = db
      .from('builder_stock_uploads')
      .select('id, organisation_id, status, records_failed, deleted_at')
      .eq('id', uploadId);
    if (params.organisationId) {
      uploadQuery = uploadQuery.eq('organisation_id', params.organisationId);
    }
    const { data: upload, error: uploadError } = await uploadQuery.maybeSingle();
    if (uploadError) return { status: null, refusal: 'read_failed' };
    if (!upload) return { status: null, refusal: 'not_found' };
    if (upload.deleted_at) return { status: null, refusal: 'not_completable' };
    if (!COMPLETABLE_UPLOAD_STATUSES.includes(String(upload.status))) {
      return { status: null, refusal: 'not_completable' };
    }

    /*
     * The properties alone decide, and a FAILED count is not a count of zero:
     * a database fault must leave the upload exactly as it found it.
     */
    const { count, error: countError } = await db
      .from('builder_stock_items')
      .select('id', { count: 'exact', head: true })
      .eq('organisation_id', upload.organisation_id)
      .eq('upload_id', uploadId)
      .eq('lifecycle_status', 'active')
      .in('enrichment_status', UNFINISHED_ENRICHMENT_STATUSES);
    if (countError) return { status: null, refusal: 'read_failed' };
    if ((count ?? 0) > 0) return { status: null, refusal: 'items_outstanding' };

    /*
     * Paged, because the API caps a response at 1,000 rows however the limit
     * is written — and an incomplete read is never written from, because the
     * summary it would produce understates the work permanently.
     */
    const stagePage = await readAllRows<StageRow>(
      () => db
        .from('builder_stock_item_images')
        .select('id, source_stage, processing_status')
        .eq('upload_id', uploadId)
        .order('id', { ascending: true }));
    if (stagePage.failed) return { status: null, refusal: 'read_failed' };

    const status = finalUploadStatus(upload.records_failed);
    const { error: writeError } = await db
      .from('builder_stock_uploads')
      .update({ status, image_stage_summary: summariseImageStages(stagePage.rows) })
      .eq('id', uploadId);
    if (writeError) return { status: null, refusal: 'read_failed' };

    console.info('[builderStock] upload settled', {
      phase: 'upload_completion', upload_id: uploadId, status,
    });
    return { status };
  } catch (error) {
    console.warn('[builderStock] upload completion failed', {
      phase: 'upload_completion', upload_id: uploadId,
      message: String((error as { message?: string })?.message ?? error).slice(0, 200),
    });
    return { status: null, refusal: 'read_failed' };
  }
}

export interface UploadCompletionPassOutcome {
  inspected: number;
  settled: number;
}

/**
 * Settle every upload whose properties have finished — the pass the settler
 * runs, because an import that completes headlessly has nobody to settle it.
 *
 * Enumerates its own work rather than being handed a queue: an upload waiting
 * for its status is not settlement work, and the steady state — nothing left
 * to settle — is exactly when this matters.
 */
export async function settleCompletedUploads(
  db: any,
  params: { organisationId?: string | null; limit?: number } = {},
): Promise<UploadCompletionPassOutcome> {
  const outcome: UploadCompletionPassOutcome = { inspected: 0, settled: 0 };
  try {
    let query = db
      .from('builder_stock_uploads')
      .select('id')
      .is('deleted_at', null)
      .in('status', COMPLETABLE_UPLOAD_STATUSES)
      .order('created_at', { ascending: true })
      .limit(Math.max(1, params.limit ?? MAX_UPLOADS_PER_PASS));
    if (params.organisationId) {
      query = query.eq('organisation_id', params.organisationId);
    }
    const { data: rows, error } = await query;
    if (error || !rows?.length) return outcome;

    for (const row of rows as Array<{ id: string }>) {
      outcome.inspected += 1;
      const settled = await settleUploadCompletion(db, {
        uploadId: String(row.id),
        organisationId: params.organisationId ?? null,
      });
      if (settled.status) outcome.settled += 1;
    }
  } catch (error) {
    // Housekeeping must never fail the tick it rides in.
    console.warn('[builderStock] upload completion pass failed', {
      phase: 'upload_completion',
      message: String((error as { message?: string })?.message ?? error).slice(0, 200),
    });
  }
  return outcome;
}
