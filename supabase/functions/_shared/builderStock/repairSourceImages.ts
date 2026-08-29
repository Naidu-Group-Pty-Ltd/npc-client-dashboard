/**
 * Builder stock — recovering source imagery for stock that is ALREADY imported.
 *
 * WHY THIS EXISTS. Seventy live properties were imported from a public Notion
 * stock list while the decoder read only the text of each row, so twenty-five
 * builder-supplied renders sitting on those rows' covers were never seen and
 * every card fell through to a Street View badged "Location imagery". The
 * properties are correct, they are selected against, and they are referenced
 * by clients; the only thing wrong with them is the picture.
 *
 * So this re-reads the SAME source and attaches what it should have attached
 * the first time. It is deliberately not an import:
 *
 *   NOTHING IS CREATED AND NOTHING IS EDITED. No stock item is inserted, no
 *   field is written, no availability is touched, no selection is disturbed.
 *   The only writes are `builder_stock_item_images` rows and the
 *   `primary_image_id` those rows earn.
 *
 *   ROWS ARE MATCHED, NOT RE-IMPORTED. The same two conservative keys
 *   `importStock.ts` matches on — the builder's own reference, and
 *   development + lot/unit with both halves present — decide which existing
 *   property a source row is. A row that matches nothing is skipped, because
 *   inventing a property here would be worse than leaving a card as it is.
 *
 *   THE ORGANISATION IS THE BOUNDARY. Every lookup filters on the upload's own
 *   `organisation_id`, so an asset from one builder's source cannot reach
 *   another builder's stock even if two rows happen to read alike.
 */
import { classifyFetchedSource, classifyStockFile } from './fileTypes.pure.ts';
import { PROCESSED_LIFECYCLE } from './stockLifecycle.pure.ts';
import { detectDocumentMime } from '../immutableDocuments.ts';
import { extractStockFile } from './extract.ts';
import { keyRowsByHeader } from './table.pure.ts';
import { isNotionUrl } from './urlSource.pure.ts';
import {
  emptyStockRecord, identifiesAProperty, normaliseStockRow, stockMatchKeys,
  stockRecordLabel, stockRowFingerprint,
  type NormalisedStockRecord,
} from './normalise.pure.ts';
import {
  SOURCE_ANCHOR_HEADER, settleRowAssetRoles,
  type AnchoredAssets, type SourceImageAsset,
} from './sourceAssets.pure.ts';
import { roleDetail, roleFromExplicitField } from './sourceImageRole.pure.ts';
import {
  negativeProvenanceStillStands, recordNoDeterministicImage,
} from './negativeProvenance.pure.ts';
import {
  attemptsSoFar, packageAttemptsExhausted, recordPackageAttempt,
  recordPackageUnprocessable, provenanceAfterAttempt,
} from './packageAttempt.pure.ts';
import {
  demoteUnprovenSourceImage, hasReadySourceImage, readPrimaryImageStanding,
  storeSourceImageBytes, storeSourceImages, PROVENANCE_VERSION, type SourceImageFetcher,
} from './sourceImages.ts';
import { driveFileId, driveFolderId } from './drivePackage.pure.ts';
import {
  DriveListingCache, recoverPackageImage, type PackageFetcher, type PackageOutcome,
} from './packageImages.ts';
import { attachDocumentMedia } from './importStock.ts';
import { anchorPdfRowsToPages, pdfAnchorPage } from './pdfRowAnchors.pure.ts';
import { chooseAndStorePrimaryImage } from './primaryImage.ts';
import type { ExtractedMedia } from './extract.ts';

export interface RepairOutcome {
  uploadId: string;
  /** Rows the source produced this time. */
  rowsRead: number;
  /** Rows that carried imagery. */
  rowsWithImagery: number;
  /** Rows whose imagery reached an EXISTING property. */
  matched: number;
  /** Images stored as bytes in the private bucket. */
  imagesStored: number;
  /** Rows whose image came out of their own linked package document. */
  fromPackage: number;
  /** Rows whose linked package named no image for that exact property. */
  packageNotIdentified: number;
  /**
   * Rows skipped because a previous run already read that package, at this
   * version, and it named no image. Not work avoided by luck — work that is
   * finished.
   */
  packageAlreadyAnswered: number;
  /** Rows whose linked package could not be read without signing in. */
  packageUnreachable: number;
  /** True when the wall-clock budget ran out; run it again to continue. */
  incomplete: boolean;
  /**
   * Stage-1 rows this run could not prove belong to the property, demoted so
   * the marketplace will not show them. The row itself is kept.
   */
  demoted: number;
  /** Properties whose card now shows the builder's own image. */
  primaryUpdated: number;
  /** Safe to show: why a source could not be re-read at all. */
  error?: string;
  /** Server-side only. */
  problems: Array<{ reference: string; reason: string }>;
}

interface ExistingItem {
  id: string;
  external_reference: string | null;
  development_name: string | null;
  project_name: string | null;
  unit_number: string | null;
  lot_number: string | null;
  /** The normalised record the import wrote. The exact thing to match on. */
  source_row?: Record<string, unknown> | null;
  /** Read with the row so settling the primary costs no second query. */
  primary_image_id?: string | null;
  /**
   * The terminal answer a previous run reached about this property's linked
   * package, when it read the package and the package named no image.
   */
  source_provenance_result?: unknown;
}

/** A stage-1 row, as the re-audit needs to see it. */
interface Stage1ImageRow {
  id: string;
  source_reference: string | null;
  source_detail: Record<string, unknown> | null;
  processing_status: string;
}

/**
 * Every named property's stage-1 image rows, in as FEW reads as possible.
 *
 * The re-audit and the primary decision are per property; the rows they need
 * are not. Asking per property spent a round trip each against the same wall
 * clock that has to hold reading the source document as well — on a source with
 * a hundred properties that was a hundred queries to decide something one query
 * answers.
 *
 * THE CHUNK AND THE LIMIT ARE A PAIR. A batched read shares one row budget
 * where a per-property read had its own, so the two numbers are chosen to keep
 * the headroom the per-property read gave each property (200 rows) rather than
 * to look round: 100 × 200 is what the limit means. Widening the chunk without
 * the limit would let one property with a great many images crowd another's
 * rows out of the result — and a row the re-audit cannot see is a row it cannot
 * demote, which is the one direction this must never fail in.
 */
const STAGE1_CHUNK = 100;
const STAGE1_ROWS_PER_ITEM = 200;

/**
 * How many properties one run will re-fetch imagery for.
 *
 * THE BOUND THAT ACTUALLY HOLDS. Every other limit in this module is a wall
 * clock, and a wall clock never fired here: fetching, validating, hashing and
 * re-uploading a megabyte of PNG is CPU-bound, and Supabase's edge runtime kills
 * the invocation on its RESOURCE limit — status 546 — long after the work has
 * started and long before 100s have elapsed. Every production settler
 * invocation ended that way. A killed worker returns no response, writes no
 * settlement marker and logs nothing, so the failure was invisible in all three
 * of the places built to make it visible.
 *
 * FOUR, and the number was fitted against production rather than reasoned to.
 * The first attempt used twelve, from the observation that pre-fix ticks always
 * died around the thirteenth image — but that measured the ELIGIBILITY sweep,
 * which only decodes. A provenance restore per property also fetches over the
 * network, validates, hashes, uploads to storage, upserts the row, re-reads the
 * property's stage-1 images and re-points its primary; twelve of those still
 * logged `CPU Time exceeded`. The cap has to sit well under the ceiling, not at
 * it, because the same invocation may also have run an eligibility sweep and
 * must still reach the primary-image enforcement pass that follows it.
 *
 * Draining is not the thing to optimise: the sweep ticks every five minutes and
 * removes itself when the queue empties, so four properties a tick clears a
 * 25-image upload in under half an hour without ever being killed. A run that
 * finishes is worth more than a run that does more, because only a run that
 * finishes writes its marker.
 *
 * IT COUNTS ATTEMPTS, NOT STORES, AND THAT IS A DELIBERATE TRADE. Counting only
 * productive work was tried and reverted: the expensive path here is
 * `recoverPackageImage`, which fetches and parses a linked PDF, and it is
 * expensive whether or not it finds anything. Production upload f7e0d4d1 has 70
 * rows of which 13 are already current and the rest yield nothing, so a cap on
 * stores never engaged, all 57 fruitless recoveries ran, and the worker was
 * killed on CPU again.
 *
 * The cost is that such an upload reports `incomplete` for ever and its
 * provenance marker is never written, so the sweep does not unschedule itself.
 * That is the lesser harm: the run now ENDS, in about 17 seconds, and says what
 * it did, instead of being killed every five minutes having said nothing. It
 * does not affect display — eligibility is a separate marker and is settled.
 *
 * The real fix is to remember a row whose package yielded nothing at this
 * version so it is not retried, which is a schema change and belongs with the
 * `packageNotIdentified` accounting rather than here.
 */
const MAX_ITEMS_RESTORED_PER_RUN = 4;

/**
 * And a TIGHTER bound on the expensive kind of restore.
 *
 * The cap above counts a property whose imagery this run re-fetched, and it was
 * fitted against the row-asset path: fetch a picture, validate it, hash it,
 * upload it. A linked-package recovery is a different order of work — fetch a
 * whole PDF, parse it, read every page's text, choose the cover, extract and
 * re-encode the image — and four of those in one invocation still logged
 * `CPU Time exceeded`, which is how upload f7e0d4d1's last six rows stalled
 * after the other 44 had been answered.
 *
 * ONE. Not a lowering of the fitted cap — that stays at 4 for the cheap path —
 * but a separate ceiling on the costly one, so the two cannot be traded against
 * each other. It costs a tick per outstanding package and the sweep runs every
 * five minutes, which is nothing against a backlog that is answered once and
 * then never re-read.
 */
const MAX_PACKAGE_RECOVERIES_PER_RUN = 1;

/**
 * How much of the budget one package recovery is assumed to need.
 *
 * Not a measurement of a particular document — it cannot be, since the cost is
 * whatever PDF a builder linked — but the size of the bet this run is willing
 * to place. Fitted to the production kills: a recovery that began around ten
 * seconds in ran the invocation to twenty-two. Ten seconds of headroom means
 * the run declines the bet instead of losing it, reports `incomplete`, and the
 * next tick takes it with a full budget.
 */
const PACKAGE_RECOVERY_RESERVE_MS = 10_000;

async function readStage1Images(
  db: any,
  stockItemIds: string[],
): Promise<Map<string, Stage1ImageRow[]>> {
  const byItem = new Map<string, Stage1ImageRow[]>();
  const ids = [...new Set(stockItemIds)];
  for (let index = 0; index < ids.length; index += STAGE1_CHUNK) {
    const { data } = await db
      .from('builder_stock_item_images')
      .select('id, stock_item_id, source_reference, source_detail, processing_status')
      .in('stock_item_id', ids.slice(index, index + STAGE1_CHUNK))
      .eq('source_stage', 'uploaded_document')
      .limit(STAGE1_CHUNK * STAGE1_ROWS_PER_ITEM);
    for (const row of (data ?? []) as Array<Stage1ImageRow & { stock_item_id: string }>) {
      const bucket = byItem.get(row.stock_item_id) ?? [];
      bucket.push(row);
      byItem.set(row.stock_item_id, bucket);
    }
  }
  return byItem;
}

function referenceKey(item: ExistingItem): string | null {
  const value = item.external_reference?.trim().toLowerCase();
  return value || null;
}

function developmentUnitKey(item: ExistingItem): string | null {
  const development = (item.development_name ?? item.project_name ?? '').trim().toLowerCase();
  const unit = (item.unit_number ?? item.lot_number ?? '').trim().toLowerCase();
  return development && unit ? `${development}|${unit}` : null;
}

/**
 * Re-read one source and attach the imagery it states.
 *
 * A Notion source is re-fetched live, because the CSV snapshot taken at import
 * time is precisely the artefact that lost the covers. Everything else is
 * re-read from the stored snapshot, which IS the original document.
 */
/**
 * Where the upload records that it has enumerated its live source's row assets.
 *
 * A key inside the existing `image_stage_summary` document rather than a new
 * column: it is a fact about this upload's imagery, which is what that column
 * already holds, and it needs no migration. It is MERGED, never written over
 * the stage counts beside it.
 */
export const NOTION_ROW_ASSETS_VERSION_KEY = 'notion_row_assets_version';

/**
 * The rows this upload already imported, as the source presented them.
 *
 * `source_row` is the normalised record `importStock.ts` wrote — the same
 * shape `normaliseStockRow` produces, carrying `unmapped` (and with it the
 * `Complete Package Pack` link), `image_urls`, `image_url_fields` and the
 * `source_anchor`. Reading it back is a single indexed query against rows this
 * organisation already owns; nothing here reaches the network.
 */
async function storedSourceRows(
  db: any,
  input: { organisationId: string; uploadId: string },
): Promise<NormalisedStockRecord[]> {
  const { data } = await db
    .from('builder_stock_items')
    .select('source_row')
    .eq('organisation_id', input.organisationId)
    .eq('upload_id', input.uploadId)
    .in('lifecycle_status', PROCESSED_LIFECYCLE)
    .order('created_at', { ascending: true });
  return (data ?? [])
    .map((row: { source_row?: unknown }) => readStoredRecord(row?.source_row))
    .filter((record: NormalisedStockRecord | null): record is NormalisedStockRecord => !!record);
}

/**
 * A stored `source_row` back as the record it already is.
 *
 * NEVER `normaliseStockRow`. That function reads a row keyed by the SOURCE'S
 * OWN HEADERS — `Deal`, `Photo`, `Complete Package Pack` — and a stored record
 * is keyed by this repository's field names, with `unmapped` as a nested
 * object rather than a cell. Passing one to the other loses the whole point of
 * reading it: `unmapped` stringifies to nothing usable, so the package link
 * this exists to recover would be dropped, and the row would then fail
 * `identifiesAProperty` and vanish silently. It is copied field by field, and
 * the same property test the import applied is applied again — so a row that
 * could never have been imported cannot enter here either.
 */
function readStoredRecord(stored: unknown): NormalisedStockRecord | null {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const source = stored as Partial<NormalisedStockRecord> & Record<string, unknown>;
  const record = emptyStockRecord();

  for (const key of Object.keys(record) as Array<keyof NormalisedStockRecord>) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (key === 'image_urls') {
      if (!Array.isArray(value)) continue;
      record.image_urls = value
        .filter((url): url is string => typeof url === 'string').slice(0, 12);
      continue;
    }
    if (key === 'image_url_fields' || key === 'unmapped') {
      if (typeof value !== 'object' || Array.isArray(value)) continue;
      const out: Record<string, string> = {};
      for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
        if (typeof entry === 'string') out[name] = entry;
      }
      record[key] = out;
      continue;
    }
    (record as unknown as Record<string, unknown>)[key] = value;
  }

  return identifiesAProperty(record) ? record : null;
}

export async function repairSourceImagesForUpload(
  db: any,
  input: {
    organisationId: string;
    uploadId: string;
    /**
     * When to stop. A package document is a couple of megabytes and there can
     * be one per property, so a repair is budgeted and RESUMABLE rather than
     * unbounded: a row that already holds a source image is skipped, so
     * running this again continues where it left off.
     */
    deadlineAt?: number;
    /**
     * DO THE WORK FOR EXACTLY ONE PROPERTY, and leave every other property in
     * this upload alone.
     *
     * The caller has CLAIMED that property — nobody else holds it, and nobody
     * else is waiting behind it. Without this the run walks the whole upload
     * `created_at` ascending and ends on the first cap it hits, so a property
     * that is expensive, or one that kills the worker, stops every property
     * after it: on 29 August the walk reached item 13 of 23 in twenty-six
     * hours and items 14 to 23 were never read once.
     *
     * WHAT IT DOES NOT NARROW is how a source row is matched to a property.
     * The loop still resolves every row in the document, in order, consuming
     * the fingerprint queue exactly as it always has — because the reference,
     * development/unit and fingerprint keys are POSITIONAL against a document
     * that can list one lot twice, and resolving a subset would hand the
     * second row's picture to the first row's property. Only the work is
     * skipped, never the identity.
     */
    onlyItemId?: string | null;
  },
  deps: {
    fetchPackage?: PackageFetcher;
    fetchImage?: SourceImageFetcher;
    /** How a linked package's prose is read. See `packageImages.ts`. */
    readPageTexts?: (bytes: Uint8Array) => Promise<string[]>;
    /**
     * How the LIVE public source is re-read, for the row assets only.
     *
     * A seam, for the same reason `fetchImage` and `fetchPackage` are seams:
     * the real one reaches `Deno.resolveDns` through `fetchSource.ts`, so
     * without it the branch that decides whether the live page is read at all
     * could only be exercised against the network. That branch is now the
     * thing that keeps the sweep moving, and it shipped once in the wrong
     * function past a green suite — a rule nothing can execute is not pinned.
     */
    readNotionSource?: (url: string) => Promise<
      { ok: false } | { ok: true; rows: Array<Record<string, unknown>>; assets: AnchoredAssets[] }
    >;
  } = {},
): Promise<RepairOutcome> {
  const outcome: RepairOutcome = {
    uploadId: input.uploadId,
    rowsRead: 0, rowsWithImagery: 0, matched: 0,
    imagesStored: 0, fromPackage: 0, packageNotIdentified: 0, packageAlreadyAnswered: 0,
    packageUnreachable: 0, incomplete: false, demoted: 0,
    primaryUpdated: 0, problems: [],
  };

  const { data: upload } = await db
    .from('builder_stock_uploads')
    .select('id, organisation_id, source_type, source_url, final_url, original_filename, '
      + 'storage_bucket, storage_path, deleted_at, image_stage_summary')
    .eq('id', input.uploadId)
    .eq('organisation_id', input.organisationId)
    .maybeSingle();
  if (!upload || upload.deleted_at) {
    return { ...outcome, error: 'That source could not be found.' };
  }

  let rows: Array<Record<string, unknown>> = [];
  /**
   * Set only on the stored-source path: rows that are ALREADY records and must
   * not be put through `normaliseStockRow` again. See `readStoredRecord`.
   */
  let storedRecords: NormalisedStockRecord[] | null = null;
  let rowAssets: AnchoredAssets[] = [];
  let media: ExtractedMedia[] = [];
  let pageTexts: string[] = [];
  let pageOrderAuthoritative = true;

  const sourceUrl: string | null = upload.final_url || upload.source_url || null;

  /**
   * WHAT THE LIVE SOURCE IS ACTUALLY NEEDED FOR — AND WHAT IT IS NOT.
   *
   * Re-reading a public Notion page costs about nine seconds and answers TWO
   * different questions at once:
   *
   *   THE ROW DATA — identity, and the `Complete Package Pack` link a row
   *   carries. This is captured at import and is sitting in
   *   `builder_stock_items.source_row`, verbatim, including the unmapped
   *   columns. Re-fetching to read it again is buying something already owned.
   *
   *   THE ROW ASSETS — a Notion page cover, which is a file reference the CSV
   *   snapshot cannot carry. This one genuinely does need the live page.
   *
   * Conflating them is a LIVENESS BUG, and production held still because of
   * it. Every tick spent its whole budget re-deriving the record map, then
   * declined the package recovery it existed to perform because too little
   * time remained (see `PACKAGE_RECOVERY_RESERVE_MS`) — 200, `incomplete`,
   * nothing stored, repeat every five minutes for ever. Fourteen properties
   * whose builder image sits in a linked package were never once attempted.
   *
   * So the fetch is now bought only while the ASSET question is open. Once a
   * run has enumerated this source's row assets and left none of them
   * outstanding, that is recorded on the upload and every later tick reads the
   * rows it already has and spends the whole budget on the package.
   */
  const stageSummary = (upload.image_stage_summary ?? {}) as Record<string, unknown>;
  const rowAssetsEnumerated =
    Number(stageSummary[NOTION_ROW_ASSETS_VERSION_KEY] ?? -1) >= PROVENANCE_VERSION;
  /** Set when a run had to defer an asset-bearing row; blocks the stamp. */
  let assetRowsDeferred = 0;
  /** True only where this run actually read the live page. */
  let notionAssetsRead = false;

  try {
    if (upload.source_type === 'url' && sourceUrl && isNotionUrl(sourceUrl)
      && rowAssetsEnumerated) {
      /*
       * The assets have been enumerated at this version and none was left
       * outstanding, so nothing on the live page is needed. The rows come from
       * what the import already stored — the same normalised records, with the
       * same unmapped columns and the same anchors.
       */
      storedRecords = await storedSourceRows(db, input);
      rows = storedRecords as unknown as Array<Record<string, unknown>>;
      rowAssets = [];
    } else if (upload.source_type === 'url' && sourceUrl && isNotionUrl(sourceUrl)) {
      if (deps.readNotionSource) {
        const read = await deps.readNotionSource(sourceUrl);
        if (!read.ok) {
          return { ...outcome, error: 'That Notion page could not be read again.' };
        }
        rows = read.rows;
        rowAssets = read.assets;
      } else {
        // Imported here rather than at the top: both modules reach for
        // `Deno.resolveDns`, and the repair path for an uploaded document must
        // stay loadable — and testable — without the edge runtime.
        const { fetchStockSource } = await import('./fetchSource.ts');
        const { recoverNotionPublicContent } = await import('./notionPublicContent.ts');
        const fetched = await fetchStockSource(sourceUrl);
        const html = new TextDecoder('utf-8', { fatal: false }).decode(fetched.bytes);
        const recovery = await recoverNotionPublicContent(fetched.finalUrl, html);
        if (!recovery.ok) {
          return { ...outcome, error: 'That Notion page could not be read again.' };
        }
        if (!recovery.matrix) {
          return { ...outcome, error: 'That Notion page no longer lists properties in rows.' };
        }
        const keyed = keyRowsByHeader(recovery.matrix);
        rows = keyed?.rows ?? [];
        rowAssets = recovery.assets;
      }
      notionAssetsRead = true;
    } else {
      const { data: blob, error: downloadError } = await db.storage
        .from(upload.storage_bucket).download(upload.storage_path);
      if (downloadError || !blob) {
        return { ...outcome, error: 'The stored copy of that source could not be read.' };
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const detection = detectDocumentMime(bytes);
      const classification = upload.source_type === 'url'
        ? classifyFetchedSource({
          detectedMime: detection.mime,
          detectionReason: detection.reason,
          declaredContentType: '',
          finalUrl: sourceUrl ?? '',
          looksLikeHtml: /^\s*<(?:!doctype html|html)/i.test(
            new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 256))),
        })
        : classifyStockFile(upload.original_filename, detection.mime, detection.reason);
      if (classification.kind === 'unsupported') {
        return { ...outcome, error: 'That source cannot be read for imagery.' };
      }
      const extraction = await extractStockFile(
        bytes, upload.original_filename, classification, { baseUrl: sourceUrl ?? undefined });
      rows = extraction.rows;
      rowAssets = extraction.rowAssets;
      media = extraction.media;
      pageTexts = extraction.pageTexts ?? [];
      pageOrderAuthoritative = extraction.pageOrderAuthoritative !== false;
    }
  } catch (error) {
    return {
      ...outcome,
      error: String((error as { safeMessage?: string })?.safeMessage
        ?? 'That source could not be read again.'),
    };
  }

  /**
   * A PROSE document has no rows to re-read.
   *
   * A PDF's properties were read by a model at import time and normalised into
   * `builder_stock_items`; re-running that model here would be a second import
   * and could write different values onto a live property. So the properties
   * this upload ALREADY produced are the rows, and the only thing re-derived
   * from the stored PDF is its imagery — which is what was missing.
   */
  if (!rows.length && pageTexts.length) {
    return await repairPdfUpload(db, {
      organisationId: input.organisationId,
      upload,
      media,
      pageTexts,
      pageOrderAuthoritative,
      deadlineAt: input.deadlineAt,
      onlyItemId: input.onlyItemId ?? null,
    }, outcome);
  }

  outcome.rowsRead = rows.length;
  if (!rows.length) return outcome;

  // The stock this organisation already holds, and nobody else's.
  const { data: existingRows } = await db
    .from('builder_stock_items')
    .select('id, external_reference, development_name, project_name, unit_number, lot_number, source_row, primary_image_id, source_provenance_result')
    .eq('organisation_id', input.organisationId)
    .in('lifecycle_status', PROCESSED_LIFECYCLE)
    .order('created_at', { ascending: true })
    .limit(20000);

  const byReference = new Map<string, string>();
  const byDevelopmentUnit = new Map<string, string>();
  /**
   * Properties queued under the fingerprint of the row that produced them.
   *
   * A queue rather than a lookup, and CONSUMED as it matches: a stock list
   * that lists the same lot twice produced two properties, and the second
   * source row must reach the second property rather than overwrite the
   * first's imagery. Where the two rows are identical the picture is the same
   * either way — but the rule has to be stated, not left to whichever entry
   * happened to win the map.
   */
  const byFingerprint = new Map<string, string[]>();
  /** What each property's primary was before this run, read with the row. */
  const primaryBefore = new Map<string, string | null>();
  /**
   * The terminal negative answer each property already holds, read with the
   * row so the skip below costs no query of its own — the point of the skip is
   * to make a run cheaper, and paying a round trip per property to decide
   * whether to skip would give most of that back.
   */
  const negativeBefore = new Map<string, unknown>();
  for (const item of (existingRows ?? []) as ExistingItem[]) {
    primaryBefore.set(item.id, item.primary_image_id ?? null);
    if (item.source_provenance_result) negativeBefore.set(item.id, item.source_provenance_result);
    const reference = referenceKey(item);
    if (reference) byReference.set(reference, item.id);
    const developmentUnit = developmentUnitKey(item);
    if (developmentUnit) byDevelopmentUnit.set(developmentUnit, item.id);

    // The stored record first: it is what the row normalised to. The columns
    // are the fallback for a property imported before that was written.
    const fingerprint = stockRowFingerprint(
      (item.source_row as Partial<NormalisedStockRecord>) ?? item as Partial<NormalisedStockRecord>);
    const queue = byFingerprint.get(fingerprint) ?? [];
    queue.push(item.id);
    byFingerprint.set(fingerprint, queue);
  }

  const assetsByAnchor = new Map<string, SourceImageAsset[]>();
  for (const anchored of rowAssets) assetsByAnchor.set(anchored.anchor, anchored.assets);

  // One listing per folder per run: 44 of the live rows link the SAME folder,
  // so this is what keeps a repair to a handful of requests instead of one per
  // property.
  const cache = new DriveListingCache(
    deps.fetchPackage ?? (async (url: string) => {
      const { fetchStockSource } = await import('./fetchSource.ts');
      const fetched = await fetchStockSource(url);
      return { bytes: fetched.bytes, finalUrl: fetched.finalUrl };
    }),
  );

  const itemIdByAnchor = new Map<string, string | null>();
  const itemIdsInOrder: string[] = [];
  /** Rows the DOCUMENT stated, matched or not — see `documentRowCount`. */
  let documentRows = 0;
  const touched = new Set<string>();
  /**
   * What this run could PROVE about each property: the source references it
   * re-derived from the builder's own source. Anything else already sitting on
   * the property as stage 1 is unproven, and unproven means not displayable.
   */
  const provenByItem = new Map<string, Set<string>>();
  /** Properties whose imagery this run actually re-fetched. The CPU bound. */
  let restored = 0;
  /** Of those, the ones that cost a whole PDF parse. The tighter bound. */
  let recoveries = 0;
  const prove = (itemId: string, reference: string) => {
    const set = provenByItem.get(itemId) ?? new Set<string>();
    set.add(reference.slice(0, 400));
    provenByItem.set(itemId, set);
  };

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const raw = rows[rowIndex];
    const record: NormalisedStockRecord | null = storedRecords
      ? storedRecords[rowIndex]
      : normaliseStockRow(raw);
    if (!record) continue;
    documentRows += 1;

    const keys = stockMatchKeys(record);
    const itemId = (keys.reference ? byReference.get(keys.reference) : undefined)
      ?? (keys.developmentUnit
        ? byDevelopmentUnit.get(`${keys.developmentUnit.development}|${keys.developmentUnit.unit}`)
        : undefined)
      ?? byFingerprint.get(stockRowFingerprint(record))?.shift();

    const anchor = record.source_anchor
      ?? (typeof raw[SOURCE_ANCHOR_HEADER] === 'string' ? String(raw[SOURCE_ANCHOR_HEADER]) : null);
    const assets = anchor ? assetsByAnchor.get(anchor) ?? [] : [];
    const linkAssets = settleRowAssetRoles(
      record.image_urls.map((url, position): SourceImageAsset => ({
        url,
        reference: url.slice(0, 400),
        origin: 'stock_list_column',
        provider: 'stock_list_column',
        pageUrl: sourceUrl,
        position: assets.length + position,
        linkFallback: true,
        role: roleFromExplicitField(record.image_url_fields[url]),
      })),
      {
        container: 'this property\'s row',
        designation: 'property image',
        preferredIndex: record.image_urls.findIndex(
          (url) => roleFromExplicitField(record.image_url_fields[url]).evidenceLevel === 1),
      },
    );
    const all = [...assets, ...linkAssets];
    if (all.length) outcome.rowsWithImagery += 1;

    if (!itemId) continue;
    // Identity was resolved above for EVERY row, so the fingerprint queue and
    // the anchor map are byte-identical to an unscoped run. Only the work below
    // belongs to one property.
    if (input.onlyItemId && itemId !== input.onlyItemId) continue;
    itemIdsInOrder.push(itemId);
    if (anchor) {
      if (!itemIdByAnchor.has(anchor)) itemIdByAnchor.set(anchor, itemId);
      else if (itemIdByAnchor.get(anchor) !== itemId) itemIdByAnchor.set(anchor, null);
    }

    /**
     * The row's own linked package, read up front because BOTH branches now
     * need it: the no-assets branch it has always served, and the branch below
     * where the row's own cover turns out to be a convicted marketing tile.
     */
    const packageUrl = solePackageUrl(record.unmapped);

    if (all.length) {
      outcome.matched += 1;

      /**
       * ATTRIBUTION COMES FROM THE ROW; THE DOWNLOAD ONLY REFRESHES BYTES.
       *
       * The row was just re-read from the builder's own stored source, and it
       * names these references — so the property's claim to them is proven
       * whether or not we fetch the pictures again. Proving before the skip
       * below is what keeps the demotion pass honest: an image this run
       * deliberately did not re-download is not an image it failed to prove.
       */
      for (const asset of all) prove(itemId, asset.reference);
      touched.add(itemId);

      /**
       * A PROPERTY ALREADY AT THE CURRENT VERSION IS NOT RE-FETCHED.
       *
       * This is the guard the package branch below has always had, and its
       * absence here is why the sweep could not converge. `storeSourceImages`
       * fetches, validates, hashes and re-uploads every asset unconditionally,
       * so a row path with no skip re-did the SAME work on every tick: upload
       * f7e0d4d1 sat at 13 of 25 images at version 4 for hours, because each
       * run started at the first row, spent the worker's whole allowance
       * re-storing pictures that were already current, and was killed by the
       * edge runtime at exactly the same place. Progress was not slow, it was
       * nil.
       *
       * The reading is `readPrimaryImageStanding` now rather than
       * `hasReadySourceImage` — the identical query answering the identical
       * `ready` question, plus the one fact this branch was blind to: whether
       * everything the row itself supplied has been CONVICTED as promotional.
       */
      let standing = await readPrimaryImageStanding(db, itemId, PROVENANCE_VERSION);
      if (!standing.ready) {
        /**
         * And the run is BOUNDED BY WORK, not only by the clock.
         *
         * The wall-clock deadline never fired here: fetching and hashing
         * images is CPU-bound, and the edge worker's resource limit killed the
         * invocation long before 100s elapsed — which returns no response,
         * writes no marker and leaves nothing in the log to explain itself. A
         * count is the bound that actually holds, so the run stops itself,
         * reports `incomplete`, and is resumed by the next tick having
         * permanently retired the properties it did reach.
         */
        if (restored >= MAX_ITEMS_RESTORED_PER_RUN) {
          // An asset this run could not store. The enumeration is therefore
          // NOT finished, and must not be recorded as if it were.
          assetRowsDeferred += 1;
          outcome.incomplete = true;
          break;
        }
        if (input.deadlineAt && Date.now() > input.deadlineAt) {
          assetRowsDeferred += 1;
          outcome.incomplete = true;
          break;
        }

        restored += 1;
        const stored = await storeSourceImages(db, {
          organisationId: input.organisationId,
          uploadId: upload.id,
          stockItemId: itemId,
          assets: all,
        }, { fetchImage: deps.fetchImage });
        outcome.imagesStored += stored.stored;
        outcome.problems.push(...stored.problems.slice(0, 5));
        // What was just stored was measured as it was stored, so the standing
        // is re-read — but only where a package exists to act on the answer.
        if (packageUrl) {
          standing = await readPrimaryImageStanding(db, itemId, PROVENANCE_VERSION);
        }
      }

      /**
       * THE PRECEDENCE FIX. A row-owned image used to end this property's
       * search unconditionally — `if (all.length) { …; continue; }` — which
       * let a promotional Notion page cover stop the discovery of the CLEAN
       * render the same builder supplied for the same property, one link away
       * in the row's own package. So the search continues in exactly one case:
       * every primary candidate the row itself produced has been measured and
       * CONVICTED as a promotional marketing tile, none is clean, and the row
       * links a package of its own to read.
       *
       * Nothing else changed. A clean cover still ends the search (nothing is
       * unnecessarily replaced); a pending verdict still ends it (evidence
       * that has not arrived decides nothing); a property with no package
       * still ends it (there is nowhere else this property may be looked for
       * — NEVER another lot's package, a search, a map or a generator). And
       * everything downstream of this line is the package path that already
       * existed, with every identity proof it has always demanded.
       */
      if (!(packageUrl && standing.convictedOnly)) continue;
    }

    /**
     * Nothing usable on the row itself — no assets at all, or only convicted
     * marketing tiles. Its own linked package is the last place a
     * builder-supplied photograph can be — and the only one that has to prove
     * which property it depicts before it is used.
     */
    if (!packageUrl) continue;
    // A property that already holds a PROVEN one is skipped, which is what
    // makes a budgeted run resumable rather than repetitive. A row from before
    // provenance was recorded does not count, so it gets re-derived.
    //
    // Tested BEFORE the budget, so a run cannot spend its allowance stopping at
    // properties it would not have worked on: the cap counts work done, and
    // skipping is not work.
    //
    // Only on the no-assets path: where the row's own assets fell through as
    // convicted-only, "already holds a ready image" is precisely the fact that
    // must not end the search — the ready image IS the convicted tile.
    if (!all.length && await hasReadySourceImage(db, itemId, PROVENANCE_VERSION)) continue;

    /**
     * ALREADY ANSWERED. A previous run read this exact package at this exact
     * version and it named no image for this property, so reading it again can
     * only reach the same answer at the cost of a fetch and a parse.
     *
     * This is the whole fix. Without it the sweep could not tell an answered
     * property from an unlooked-at one, so upload f7e0d4d1's 57 answered rows
     * were re-fetched every five minutes, the run always hit its work bound,
     * `incomplete` was permanent, and the settlement marker could never be
     * written — which is why the cron job could never see an empty queue and
     * never unscheduled itself.
     *
     * `negativeProvenanceStillStands` re-opens the question on a version bump,
     * a changed package or a changed anchor, so this skips a settled question
     * and never a live one.
     */
    const question = {
      provenanceVersion: PROVENANCE_VERSION,
      packageReference: packageUrl,
      sourceAnchor: anchor ?? null,
    };
    if (negativeProvenanceStillStands(negativeBefore.get(itemId), question)) {
      outcome.packageAlreadyAnswered += 1;
      continue;
    }

    /**
     * A PACKAGE THAT HAS ALREADY KILLED THE WORKER TWICE IS NOT ASKED A THIRD
     * TIME.
     *
     * The attempt written below survives only when the recovery never returned
     * — a `CPU Time exceeded` or `Memory limit exceeded` kill, which throws
     * nothing and runs no `finally`. Seeing one here is therefore evidence that
     * this exact question destroyed a previous invocation, and starting it
     * again would destroy this one, and the one after that, for ever: upload
     * `eccc9840` stopped dead on Lot 104 Finch Road and pinned twenty-three
     * properties behind it.
     *
     * So it is retired with an honest verdict and the sweep advances. The
     * property loses its builder image, which is a real loss — and it GAINS the
     * fallback ladder, which it could not reach at all while the upload could
     * never settle.
     */
    const priorAttempts = attemptsSoFar(negativeBefore.get(itemId), question);
    if (packageAttemptsExhausted(negativeBefore.get(itemId), question)) {
      const { error: giveUpError } = await db
        .from('builder_stock_items')
        .update({ source_provenance_result: recordPackageUnprocessable(question) })
        .eq('id', itemId)
        .eq('organisation_id', input.organisationId);
      if (giveUpError) {
        // Unrecorded means unadvanced; say so rather than settle on it.
        outcome.incomplete = true;
      } else {
        outcome.packageNotIdentified += 1;
      }
      outcome.problems.push({
        reference: packageUrl.slice(0, 400),
        reason: `package retired after ${priorAttempts} resource-limit failures`,
      });
      continue;
    }

    if (restored >= MAX_ITEMS_RESTORED_PER_RUN) { outcome.incomplete = true; break; }
    if (recoveries >= MAX_PACKAGE_RECOVERIES_PER_RUN) { outcome.incomplete = true; break; }
    /**
     * A DEADLINE YOU CHECK BEFORE AN UNINTERRUPTIBLE STEP MUST RESERVE ROOM
     * FOR IT.
     *
     * "Is there time left?" is the wrong question in front of a package
     * recovery. It downloads a multi-megabyte PDF, extracts its rasters and
     * classifies them, and once begun nothing stops it — so a run with one
     * second left happily starts fifteen seconds of work and is killed on the
     * worker's resource limit, having written no marker and logged nothing.
     *
     * PRODUCTION, 27 AUG 2026. This is what survived giving the step its own
     * budget: the run ended at 22-24 seconds against a 12-second deadline,
     * with zero images stored, because the deadline was tested at ~10s and the
     * recovery then ran past it. The right question is "is there time for THIS
     * step", and `PACKAGE_RECOVERY_RESERVE_MS` is what makes it askable.
     */
    if (input.deadlineAt
      && Date.now() + PACKAGE_RECOVERY_RESERVE_MS > input.deadlineAt) {
      outcome.incomplete = true;
      break;
    }

    restored += 1;
    recoveries += 1;

    /**
     * Undo the claim below. The attempt must survive ONLY a kill, so every path
     * on which `recoverPackageImage` actually RETURNED gives the column back
     * the answer the property held before any claim — nothing at all for an
     * unreadable package, keeping it retryable for ever as it always was.
     * Counting a sign-in wall towards exhaustion would retire a document that
     * reads perfectly well tomorrow.
     *
     * WHAT IT MUST NOT GIVE BACK IS A SURVIVING ATTEMPT. This restored
     * `negativeBefore` verbatim, and after a kill that value IS an attempt
     * record — so each return rolled the counter back to the value the kill had
     * left and `packageAttemptsExhausted` became unreachable. See
     * `provenanceAfterAttempt`, which is why this is not a raw `?? null`.
     */
    const clearAttempt = async () => {
      await db
        .from('builder_stock_items')
        .update({
          source_provenance_result: provenanceAfterAttempt(
            negativeBefore.get(itemId), question),
        })
        .eq('id', itemId)
        .eq('organisation_id', input.organisationId);
    };

    /**
     * THE CLAIM, WRITTEN BEFORE THE SPEND.
     *
     * Everything below this line is uninterruptible and can end the process
     * without raising anything. Recording the attempt first is what makes a
     * kill leave evidence instead of silence — the same reason the sanitizer
     * compares-and-sets its repair claim before it calls the model. The verdict
     * paths below overwrite this, so it survives only when the step did not.
     *
     * A write that fails is not fatal: the recovery still runs and may well
     * succeed. It only means a kill this time would go unrecorded, which is
     * exactly the behaviour this replaces.
     */
    await db
      .from('builder_stock_items')
      .update({
        source_provenance_result: recordPackageAttempt(
          negativeBefore.get(itemId), question),
      })
      .eq('id', itemId)
      .eq('organisation_id', input.organisationId);

    /**
     * THREE OUTCOMES, AND ONLY ONE OF THEM IS KNOWLEDGE.
     *
     * A throw is an operational fault like any other — `readPageTexts` and the
     * selector are not defensive, so a malformed document surfaces here rather
     * than as a verdict. Catching it keeps one unreadable package from
     * abandoning the rest of the upload, and it is emphatically NOT recorded as
     * "no image": the run stays incomplete so the property is asked again.
     */
    let recovered: PackageOutcome;
    try {
      recovered = await recoverPackageImage(
        {
          packageUrl,
          label: stockRecordLabel(record),
          // Tells "(178 SqM)" from "(207 SqM)" where a lot has two packages.
          buildingSqm: Number((record as { building_size_sqm?: unknown })?.building_size_sqm)
            || null,
        },
        { fetchPackage: deps.fetchPackage, cache, readPageTexts: deps.readPageTexts },
      );
    } catch (error) {
      await clearAttempt();
      outcome.packageUnreachable += 1;
      outcome.incomplete = true;
      outcome.problems.push({
        reference: packageUrl.slice(0, 400),
        reason: String((error as { safeMessage?: string; message?: string })?.safeMessage
          ?? (error as { message?: string })?.message ?? error).slice(0, 200),
      });
      continue;
    }

    /*
     * COULD NOT LOOK. A sign-in wall, a fetch that failed, a document that is
     * not a document. Nothing was learned, so nothing is written down and the
     * run does not claim to have finished: recording "no image" here would
     * suppress a package that may be perfectly readable tomorrow.
     */
    if (recovered.status === 'unreachable') {
      await clearAttempt();
      outcome.packageUnreachable += 1;
      outcome.incomplete = true;
      continue;
    }

    /*
     * LOOKED, AND THERE IS NOTHING. The package was read and states nothing
     * that identifies this property, which is a finished answer for this
     * extractor version — so it is written down and not asked again until the
     * version, the package or the anchor changes.
     *
     * A write that fails leaves the answer unrecorded, which is merely the
     * behaviour this replaces; what it must not do is let the caller mark the
     * upload settled on the strength of an answer that was never persisted, so
     * the run reports itself incomplete.
     */
    /*
     * A PHOTOGRAPH THE BUILDER FILED, STORED AS IT STANDS.
     *
     * The same store, the same convicting, the same clearing of a stale
     * negative — what differs is only that there is no page to cite, because
     * the source is a file rather than a document. Recorded as
     * `linked_package_photo` so the row says which of the two it was.
     */
    if (recovered.status === 'recovered_photograph') {
      await clearAttempt();
      const photo = recovered.photograph;
      if (!all.length) {
        outcome.rowsWithImagery += 1;
        outcome.matched += 1;
      }
      const storedPhoto = await storeSourceImageBytes(db, {
        organisationId: input.organisationId,
        uploadId: upload.id,
        stockItemId: itemId,
        bytes: photo.bytes,
        contentType: photo.contentType,
        reference: photo.reference,
        provider: 'linked_package',
        origin: 'linked_package_photo',
        pageUrl: packageUrl,
        position: 0,
        detail: {
          ...roleDetail(photo.role),
          document: photo.fileName,
          document_url: photo.fileUrl,
          source_row_anchor: anchor,
          folder_path: photo.folderPath,
          extraction_method: 'filed_as_is',
        },
      });
      if (storedPhoto) {
        outcome.imagesStored += 1;
        outcome.fromPackage += 1;
        prove(itemId, photo.reference);
        touched.add(itemId);
        if (negativeBefore.has(itemId)) {
          await db.from('builder_stock_items')
            .update({ source_provenance_result: null })
            .eq('id', itemId)
            .eq('organisation_id', input.organisationId);
          negativeBefore.delete(itemId);
        }
      } else {
        outcome.problems.push({
          reference: photo.reference,
          reason: 'The recovered photograph could not be stored.',
        });
      }
      continue;
    }

    if (recovered.status !== 'recovered') {
      outcome.packageNotIdentified += 1;
      const { error: writeError } = await db
        .from('builder_stock_items')
        .update({ source_provenance_result: recordNoDeterministicImage(question, recovered.detail) })
        .eq('id', itemId)
        .eq('organisation_id', input.organisationId);
      if (writeError) {
        outcome.incomplete = true;
        outcome.problems.push({
          reference: packageUrl.slice(0, 400),
          reason: String((writeError as { message?: string })?.message ?? writeError).slice(0, 200),
        });
      }
      continue;
    }

    // RECOVERED. The step returned, so the claim is spent: clear it, or a
    // future question about this property would inherit a failure that never
    // happened.
    await clearAttempt();

    // A row that fell through with convicted assets was already counted once.
    if (!all.length) {
      outcome.rowsWithImagery += 1;
      outcome.matched += 1;
    }
    const written = await storeSourceImageBytes(db, {
      organisationId: input.organisationId,
      uploadId: upload.id,
      stockItemId: itemId,
      bytes: recovered.image.bytes,
      contentType: recovered.image.contentType,
      reference: recovered.image.reference,
      provider: 'linked_package',
      origin: 'linked_package_document',
      pageUrl: packageUrl,
      position: 0,
      // Enough to prove this exact picture came out of this exact document:
      // the file, the page, the object, its size, its hashes and whatever was
      // done to it (nothing, unless it was cut out of a flattened page).
      detail: {
        // The package's own designation of this picture, on the evidence it
        // stated. Without it the row proves origin and nothing about role.
        ...roleDetail(recovered.image.role),
        document: recovered.image.documentName,
        document_url: recovered.image.documentUrl,
        source_row_anchor: anchor,
        page: recovered.image.provenance.page,
        extraction_method: recovered.image.provenance.method,
        pdf_object: recovered.image.provenance.objectNumber,
        pdf_resource: recovered.image.provenance.resourceName,
        source_width: recovered.image.provenance.sourceWidth,
        source_height: recovered.image.provenance.sourceHeight,
        source_sha256: recovered.image.provenance.sourceSha256,
        stored_sha256: recovered.image.provenance.storedSha256,
        crop: recovered.image.provenance.crop,
        page_area_share: recovered.image.provenance.pageAreaShare,
        transformation: recovered.image.provenance.transformation,
      },
    });
    if (written) {
      outcome.imagesStored += 1;
      outcome.fromPackage += 1;
      prove(itemId, recovered.image.reference);
      touched.add(itemId);
      /*
       * A package that has just produced an image is not one that names none.
       * The stale answer would be harmless to the sweep — a property holding a
       * current image is skipped before the question is even asked — but it
       * would sit in the column contradicting the picture beside it, and this
       * column is read by people.
       */
      if (negativeBefore.has(itemId)) {
        await db.from('builder_stock_items')
          .update({ source_provenance_result: null })
          .eq('id', itemId)
          .eq('organisation_id', input.organisationId);
        negativeBefore.delete(itemId);
      }
    } else {
      outcome.problems.push({
        reference: recovered.image.reference,
        reason: 'The recovered image could not be stored.',
      });
    }
  }

  // Media embedded in an uploaded document, attributed the same way an import
  // attributes it — structurally where the container said so.
  if (media.length) {
    await attachDocumentMedia(
      db,
      {
        organisationId: input.organisationId, uploadId: upload.id, media,
        // The repair lists only rows that re-matched, which can be one row of
        // a many-row file. The document's own row count travels with it so
        // the one-property containment fallback cannot fire on a subset.
        documentRowCount: documentRows,
      },
      itemIdsInOrder,
      itemIdByAnchor,
    );
    for (const itemId of itemIdsInOrder) touched.add(itemId);
  }

  /**
   * RE-AUDIT. Every stage-1 row already on a property this run matched is
   * checked against what the source actually says now. A row written before
   * provenance was recorded, or one naming an asset the source no longer
   * carries, is demoted — kept for the audit trail, refused for display.
   *
   * NEVER ON THE STORED-SOURCE PATH. A run that read stored rows deliberately
   * did not read the live page, and the live page is the ONLY thing that can
   * name a row asset — every one of this deployment's nine served cards is a
   * `notion:attachment:…` reference and not one of them appears in any
   * `source_row.image_urls`. So on that path `provenByItem` is empty for them
   * BY CONSTRUCTION, and a re-audit would convict pictures it never looked
   * for. It survives today only because those rows sit at the current
   * provenance version and the loop skips them; the next version bump would
   * blank nine working cards in a single tick.
   *
   * A run that did not look is not a run that found nothing. This is the same
   * rule the image library states as "absent evidence never merges", and the
   * cost of getting it wrong here is a client seeing an empty card for a
   * photograph the builder did in fact supply.
   */
  const stage1ByItem = storedRecords
    ? new Map<string, Array<{ id: string; processing_status: string;
      source_reference: string | null; source_detail: Record<string, unknown> | null }>>()
    : await readStage1Images(db, itemIdsInOrder);
  for (const itemId of new Set(itemIdsInOrder)) {
    const proven = provenByItem.get(itemId) ?? new Set<string>();

    for (const row of stage1ByItem.get(itemId) ?? []) {
      if (row.processing_status !== 'ready') continue;
      const reference = String(row.source_reference ?? '');
      if (proven.has(reference)) continue;
      const version = Number((row.source_detail ?? {}).provenance_version ?? 0);
      if (version >= PROVENANCE_VERSION) continue;

      await demoteUnprovenSourceImage(db, {
        stockItemId: itemId,
        imageId: row.id,
        reason: 'This image predates the source-provenance record and could not be '
          + 're-derived from the builder\'s source, so it is not shown.',
      });
      outcome.demoted += 1;
    }
  }

  for (const itemId of touched) {
    const primary = await chooseAndStorePrimaryImage(db, itemId);
    if (primary && primary !== (primaryBefore.get(itemId) ?? null)) outcome.primaryUpdated += 1;
  }

  /**
   * RECORD THAT THE LIVE SOURCE HAS NOTHING LEFT TO SAY ABOUT ROW ASSETS.
   *
   * Stamped only when this run actually read the live page AND left no
   * asset-bearing row unstored — otherwise a run that stopped at its item cap
   * would strand a cover nobody would ever look for again. Merged into the
   * existing summary so the stage counts beside it are untouched.
   *
   * From here the sweep stops paying nine seconds a tick to re-derive rows it
   * already has, and the package recovery this upload has been waiting on gets
   * a whole budget to itself.
   */
  /*
   * NEVER ON A SCOPED RUN. The stamp says "the live source has nothing left to
   * say about row assets", which is a statement about the whole upload — and a
   * run that deliberately looked at one property has established nothing of the
   * kind. Writing it here would strand every other property's cover behind a
   * marker saying there was none.
   */
  if (!input.onlyItemId && notionAssetsRead && !assetRowsDeferred && !rowAssetsEnumerated) {
    const { error } = await db.from('builder_stock_uploads').update({
      image_stage_summary: {
        ...stageSummary,
        [NOTION_ROW_ASSETS_VERSION_KEY]: PROVENANCE_VERSION,
      },
    }).eq('id', input.uploadId).eq('organisation_id', input.organisationId);
    if (error) {
      // Not fatal: the next run simply reads the page again, which is the
      // behaviour this replaces rather than a new failure.
      outcome.problems.push({
        reference: input.uploadId,
        reason: `row-asset enumeration not recorded: ${error.message}`.slice(0, 200),
      });
    }
  }

  return outcome;
}

/**
 * Re-read an uploaded PDF's imagery and attach it to the properties that
 * upload already produced.
 *
 * NOTHING IS IMPORTED HERE. The properties are read, not written: no row is
 * inserted, no price, status or selection is touched, and the model that read
 * the prose at import time is not run again. The only writes are
 * `builder_stock_item_images` rows and the `primary_image_id` they earn — which
 * is what makes this safe to run over stock a builder is already selling from.
 *
 * Attribution is the page, exactly as it is at import time: the same
 * `anchorPdfRowsToPages` over the same page texts, so a repair and an import of
 * the same document cannot disagree about whose house is on page 3.
 *
 * BUDGETED LIKE EVERY OTHER PATH. This one used to be the exception: it took no
 * deadline and reported no `incomplete`, so a document with enough properties
 * could run past the caller's wall clock and be killed by the edge runtime
 * instead of stopping. A killed run writes no settlement marker, so the sweep
 * re-read the same document on the next tick and was killed again — and because
 * a tick starts at the oldest outstanding upload, everything behind it waited.
 */
async function repairPdfUpload(
  db: any,
  input: {
    organisationId: string;
    upload: { id: string; original_filename: string };
    media: ExtractedMedia[];
    pageTexts: string[];
    pageOrderAuthoritative: boolean;
    deadlineAt?: number;
    /** Work for one claimed property only. See `repairSourceImagesForUpload`. */
    onlyItemId?: string | null;
  },
  outcome: RepairOutcome,
): Promise<RepairOutcome> {
  const { data: items } = await db
    .from('builder_stock_items')
    .select('id, external_reference, development_name, project_name, unit_number, lot_number, address_line, suburb, source_row, primary_image_id')
    .eq('organisation_id', input.organisationId)
    .eq('upload_id', input.upload.id)
    .in('lifecycle_status', PROCESSED_LIFECYCLE)
    .order('created_at', { ascending: true })
    .limit(5000);

  const existing = (items ?? []) as Array<ExistingItem & {
    address_line?: string | null; suburb?: string | null;
  }>;
  outcome.rowsRead = existing.length;
  outcome.rowsWithImagery = input.media.length;
  if (!existing.length || !input.media.length) return outcome;

  // The label the import matched on: the stored normalised record where there
  // is one, and the property's own columns where there is not.
  const labels = existing.map((item) => stockRecordLabel(
    (item.source_row as unknown as NormalisedStockRecord | null)
      ?? (item as unknown as NormalisedStockRecord),
  ));

  const photoPages = input.media
    .map((media) => pdfAnchorPage(media.anchor))
    .filter((page): page is number => page !== null);
  const anchors = anchorPdfRowsToPages(
    labels, input.pageTexts, photoPages, input.pageOrderAuthoritative);

  const itemIdByAnchor = new Map<string, string | null>();
  anchors.forEach((anchor, index) => {
    if (!anchor) return;
    const itemId = existing[index].id;
    if (!itemIdByAnchor.has(anchor)) { itemIdByAnchor.set(anchor, itemId); return; }
    // Two properties claiming one page is the document declining to say.
    if (itemIdByAnchor.get(anchor) !== itemId) itemIdByAnchor.set(anchor, null);
  });

  /*
   * NARROWED AFTER RESOLUTION, NEVER BEFORE IT.
   *
   * `anchorPdfRowsToPages` is positional over the whole document and the
   * two-properties-claim-one-page rule above needs to SEE both of them to
   * refuse. Resolving a subset would let a page the document declines to
   * attribute be handed to the one property we happened to claim. So every
   * anchor is decided exactly as in an unscoped run, and only then are the
   * ones belonging to other properties dropped.
   */
  if (input.onlyItemId) {
    for (const [anchor, itemId] of [...itemIdByAnchor]) {
      if (itemId !== input.onlyItemId) itemIdByAnchor.delete(anchor);
    }
  }

  const attached = await attachDocumentMedia(
    db,
    {
      organisationId: input.organisationId,
      uploadId: input.upload.id,
      media: input.media,
      filename: input.upload.original_filename,
    },
    // Never by order. A page anchor nothing claimed keeps its picture against
    // the upload, and the property's card stays empty.
    [],
    itemIdByAnchor,
    // The SAME role decision the import makes, over the same page texts, so a
    // repair cannot reach a different conclusion about which picture is this
    // property's than the upload that created it did.
    {
      labelByItemId: new Map(existing.map((item, index) => [item.id, labels[index]])),
      pageTexts: input.pageTexts,
      pageOrderAuthoritative: input.pageOrderAuthoritative,
    },
  );

  const provenByItem = new Map<string, Set<string>>();
  for (const record of attached) {
    if (record.stored) outcome.imagesStored += 1;
    if (!record.stockItemId) continue;
    const set = provenByItem.get(record.stockItemId) ?? new Set<string>();
    set.add(record.reference);
    provenByItem.set(record.stockItemId, set);
  }
  outcome.matched = provenByItem.size;

  // Same re-audit the row path runs: a stage-1 image on one of these
  // properties that this run did not re-derive from the builder's own PDF is
  // not provably theirs, so it is kept and refused for display.
  const stage1ByItem = await readStage1Images(db, existing.map((item) => item.id));

  for (const item of existing) {
    if (input.onlyItemId && item.id !== input.onlyItemId) continue;
    /**
     * Stopping here is SAFE TO RESUME because it is safe to repeat: the media
     * were attributed above from the document itself, the demotion below is
     * decided against the current version rather than against what this run
     * happened to reach, and settling a primary is idempotent. The properties
     * left over are re-audited on the next pass.
     */
    if (input.deadlineAt && Date.now() > input.deadlineAt) {
      outcome.incomplete = true;
      break;
    }
    const proven = provenByItem.get(item.id) ?? new Set<string>();

    for (const row of stage1ByItem.get(item.id) ?? []) {
      if (row.processing_status !== 'ready') continue;
      if (proven.has(String(row.source_reference ?? ''))) continue;
      if (Number((row.source_detail ?? {}).provenance_version ?? 0) >= PROVENANCE_VERSION) continue;
      await demoteUnprovenSourceImage(db, {
        stockItemId: item.id,
        imageId: row.id,
        reason: 'This image could not be re-derived from the uploaded PDF, so it is not shown.',
      });
      outcome.demoted += 1;
    }

    const primary = await chooseAndStorePrimaryImage(db, item.id);
    if (primary && primary !== (item.primary_image_id ?? null)) outcome.primaryUpdated += 1;
  }

  return outcome;
}

/**
 * The ONE package link a row carries, or nothing.
 *
 * Read from the columns the normaliser could not place — the live list calls
 * it "Complete Package Pack" — rather than from a column name this module
 * would have to know. Two different package links on one row is a row that
 * does not say which package is its own, and the answer to that is no image.
 */
function solePackageUrl(unmapped: Record<string, string>): string | null {
  const links = new Set<string>();
  for (const value of Object.values(unmapped ?? {})) {
    for (const candidate of String(value).split(/\s+/)) {
      if (!/^https?:\/\//i.test(candidate)) continue;
      if (driveFolderId(candidate) || driveFileId(candidate)) links.add(candidate);
    }
  }
  return links.size === 1 ? [...links][0] : null;
}
