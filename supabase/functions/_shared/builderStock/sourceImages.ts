/**
 * Builder stock — bringing the builder's OWN image inside.
 *
 * Stage 1 of the three-stage enrichment, and the only stage that can say
 * "this is the photograph the builder supplied for this property". Everything
 * here exists to keep that sentence true after the source has moved on:
 *
 *   THE BYTES ARE COPIED, THE LINK IS NOT KEPT. A Notion attachment resolves
 *   to a signed URL that expires within the hour, and a builder's own site
 *   reorganises. A marketplace card that depends on either shows a broken
 *   image to a client weeks later, so the bytes are fetched once, at import,
 *   and stored in the private `builder-stock-images` bucket. What is recorded
 *   against the row is the SOURCE's own identity — `attachment:<id>:<name>`,
 *   the page URL — never the temporary URL we happened to fetch through.
 *
 *   THE BYTES ARE CHECKED, NOT THE PROMISE. A content type is a claim by
 *   whoever served the file. `validateSourceImageBytes` reads the signature,
 *   which is why an HTML login wall served as `image/jpeg` is refused rather
 *   than stored and shown to a client.
 *
 * SSRF: every retrieval goes through `fetchStockSource` — the existing guard,
 * applied to the original URL and to every redirect hop, with no cookie, no
 * Authorization header, no Supabase credential and no builder session
 * attached. Notion's public image endpoint redirects to its CDN, which is
 * exactly why the guard has to run per hop rather than once.
 */
import { STOCK_IMAGE_BUCKET } from './fileTypes.pure.ts';
import {
  MAX_SOURCE_IMAGE_BYTES, sourceImageObjectPath, validateSourceImageBytes,
  type SourceImageAsset,
} from './sourceAssets.pure.ts';
import { eligibilityDetailFor } from './assessSourceImage.ts';
import { roleDetail } from './sourceImageRole.pure.ts';
import { sha256Hex } from './rasterPng.ts';
import {
  classifyPrimaryImageStanding, type DisplayableImage, type PrimaryImageStanding,
} from './primaryImage.ts';

/**
 * Bumped when what we record about an image's origin changes.
 *
 * A row written before provenance was recorded cannot prove where its picture
 * came from, so the repair re-derives it rather than trusting the label.
 *
 * 3 adds the IMAGE ROLE. Versions 1 and 2 proved where the bytes came from and
 * said nothing about what the source presented them as, which is how a bedroom
 * render came to be a property's card image. Every version-2 row is therefore
 * unproven for display purposes and is re-derived rather than trusted — which
 * is the behaviour this constant already had, applied to a second fact.
 *
 * 4 changes the REFERENCE, which is what a row is KEYED on. A page's resource
 * name is not unique across the forms that draw it, so `page3:Im0` could be two
 * different pictures and the second silently replaced the first; references now
 * carry the object number. A version-3 row keyed the old way can never match
 * the new one, and the re-audit is deliberately forbidden from demoting a row
 * already at the current version — so it would sit there ready and displayable
 * for ever beside its replacement. Bumping is what retires it.
 *
 * 5 changes what the package reader can IDENTIFY, and every negative version 4
 * banked is therefore stale by definition. Two capabilities changed. A page now
 * states a property's identity when it names the lot, contradicts no other lot
 * and names the design — rather than when it repeats every one of the label's
 * first eight tokens, which required the builder's document to word an address
 * exactly as the stock list does and refused twenty-five live properties whose
 * own package cover names them plainly. And a document whose pages carry no
 * extractable text is now operationally unreadable rather than a finished "this
 * names no image", because a reader that read nothing has learned nothing.
 *
 * This is the bump doing precisely the job it exists for: `negativeProvenance`
 * compares the stored version against this one, so raising it reopens every
 * banked negative for a reader that can now find what the old one could not.
 */
export const PROVENANCE_VERSION = 5;

/** What a retrieval produced. Injected in tests; the default is the guard. */
export interface FetchedImage {
  bytes: Uint8Array;
  /** After redirects. Recorded for diagnosis, never as product data. */
  finalUrl: string;
}

export type SourceImageFetcher = (url: string) => Promise<FetchedImage>;

/**
 * The production fetcher, imported lazily.
 *
 * `fetchSource.ts` reaches for `Deno.resolveDns`, so a static import would
 * make this module unloadable outside the edge runtime — including by the
 * tests that pin the attribution rules. The guard is still the only thing
 * production ever uses.
 */
const guardedFetch: SourceImageFetcher = async (url: string) => {
  const { fetchStockSource } = await import('./fetchSource.ts');
  const fetched = await fetchStockSource(url);
  return { bytes: fetched.bytes, finalUrl: fetched.finalUrl };
};

export interface AttachOutcome {
  stored: number;
  failed: number;
  /** Server-side only: one line per asset we could not bring inside. */
  problems: Array<{ reference: string; reason: string }>;
}

/**
 * Fetch, validate, store and record one property's source-supplied imagery.
 *
 * `stockItemId` is resolved by the caller from the source's own statement of
 * which row owns the asset. Nothing in here matches, guesses or reorders.
 */
export async function storeSourceImages(
  db: any,
  input: {
    organisationId: string;
    uploadId: string | null;
    stockItemId: string;
    assets: SourceImageAsset[];
  },
  deps: { fetchImage?: SourceImageFetcher } = {},
): Promise<AttachOutcome> {
  const fetchImage = deps.fetchImage ?? guardedFetch;
  const outcome: AttachOutcome = { stored: 0, failed: 0, problems: [] };

  for (const asset of input.assets) {
    const reference = asset.reference.slice(0, 400);
    try {
      const { bytes, finalUrl } = await fetchImage(asset.url);
      if (bytes.length > MAX_SOURCE_IMAGE_BYTES) {
        throw new Error('That image is larger than the 10 MB limit.');
      }
      const check = validateSourceImageBytes(bytes);
      if (check.ok !== true) throw new Error(check.reason);

      const path = sourceImageObjectPath(
        input.organisationId, input.stockItemId, reference, check.extension);
      const { error: uploadError } = await db.storage
        .from(STOCK_IMAGE_BUCKET)
        .upload(path, bytes, { contentType: check.contentType, upsert: true });
      if (uploadError) throw uploadError;

      await db.from('builder_stock_item_images').upsert({
        stock_item_id: input.stockItemId,
        upload_id: input.uploadId,
        organisation_id: input.organisationId,
        source_stage: 'uploaded_document',
        source_reference: reference,
        source_provider: asset.provider,
        source_page_url: asset.pageUrl,
        storage_bucket: STOCK_IMAGE_BUCKET,
        storage_path: path,
        // The stored copy is what the marketplace serves. The URL we fetched
        // through is deliberately NOT kept as `external_url`: it expires, and
        // a card that falls back to it would break silently.
        external_url: null,
        content_type: check.contentType,
        byte_size: bytes.length,
        verification_status: 'source_supplied',
        confidence: 1,
        processing_status: 'ready',
        error_message: null,
        position: asset.position,
        source_detail: {
          origin: asset.origin,
          // What the SOURCE presented this image as, and on what evidence.
          // Without it "source_supplied" says only that the bytes are the
          // builder's, which was never the question a card asks.
          ...roleDetail(asset.role),
          fetched_from_host: hostOf(finalUrl),
          snapshotted: true,
          // The bytes are stored exactly as the source served them, so one
          // hash answers both "what did the builder supply" and "what are we
          // serving".
          source_sha256: await sha256Hex(bytes),
          stored_sha256: await sha256Hex(bytes),
          extraction_method: 'downloaded_asset',
          transformation: null,
          provenance_version: PROVENANCE_VERSION,
          // Whether the marketplace may DRAW it, which is a different
          // question from every other one recorded here. See
          // `marketplaceEligibility.pure.ts`.
          ...await eligibilityDetailFor(bytes, asset.role.role),
        },
      }, { onConflict: 'stock_item_id,source_stage,source_reference' });

      outcome.stored += 1;
    } catch (error) {
      const reason = String((error as { safeMessage?: string; message?: string })?.safeMessage
        ?? (error as { message?: string })?.message ?? error).slice(0, 300);
      outcome.failed += 1;
      outcome.problems.push({ reference, reason });

      /**
       * Recorded rather than dropped, and NEVER as something displayable.
       *
       * A link we could not fetch is a picture whose bytes we do not hold and
       * cannot hash, so it cannot be shown as the builder's exact image — the
       * URL is kept for the audit trail and the stage stays `failed`, which
       * leaves the card in its no-image state rather than hot-linking
       * somebody else's server and calling it provenance.
       */
      await db.from('builder_stock_item_images').upsert({
        stock_item_id: input.stockItemId,
        upload_id: input.uploadId,
        organisation_id: input.organisationId,
        source_stage: 'uploaded_document',
        source_reference: reference,
        source_provider: asset.provider,
        source_page_url: asset.pageUrl,
        external_url: asset.url.slice(0, 1500),
        verification_status: 'source_supplied',
        confidence: null,
        processing_status: 'failed',
        error_message: reason,
        position: asset.position,
        source_detail: {
          origin: asset.origin,
          ...roleDetail(asset.role),
          snapshotted: false,
          provenance_version: PROVENANCE_VERSION,
        },
      }, { onConflict: 'stock_item_id,source_stage,source_reference' }).then(
        () => undefined,
        () => undefined,
      );
    }
  }

  return outcome;
}

/**
 * Store bytes we already hold as this property's source-supplied image.
 *
 * The same row shape and the same bucket as a fetched asset — the difference
 * is only where the bytes came from. Used for an image taken out of the row's
 * own package document, which has no URL of its own to record.
 */
export async function storeSourceImageBytes(
  db: any,
  input: {
    organisationId: string;
    uploadId: string | null;
    stockItemId: string;
    bytes: Uint8Array;
    contentType: string;
    /** Names the document and page the image came out of. */
    reference: string;
    provider: string;
    origin: string;
    pageUrl: string | null;
    position: number;
    detail?: Record<string, unknown>;
  },
): Promise<boolean> {
  const check = validateSourceImageBytes(input.bytes);
  if (check.ok !== true) return false;

  const reference = input.reference.slice(0, 400);
  const path = sourceImageObjectPath(
    input.organisationId, input.stockItemId, reference, check.extension);

  const { error: uploadError } = await db.storage
    .from(STOCK_IMAGE_BUCKET)
    .upload(path, input.bytes, { contentType: check.contentType, upsert: true });
  if (uploadError) return false;

  await db.from('builder_stock_item_images').upsert({
    stock_item_id: input.stockItemId,
    upload_id: input.uploadId,
    organisation_id: input.organisationId,
    source_stage: 'uploaded_document',
    source_reference: reference,
    source_provider: input.provider,
    source_page_url: input.pageUrl,
    storage_bucket: STOCK_IMAGE_BUCKET,
    storage_path: path,
    external_url: null,
    content_type: check.contentType,
    byte_size: input.bytes.length,
    verification_status: 'source_supplied',
    confidence: 1,
    processing_status: 'ready',
    error_message: null,
    position: input.position,
    source_detail: {
      origin: input.origin,
      snapshotted: true,
      provenance_version: PROVENANCE_VERSION,
      ...(input.detail ?? {}),
      ...await eligibilityDetailFor(input.bytes, (input.detail ?? {}).role),
    },
  }, { onConflict: 'stock_item_id,source_stage,source_reference' });

  return true;
}

/**
 * Demote a stage-1 row that this run could NOT prove belongs to the property.
 *
 * The row is kept — audit history is never deleted — but it stops being
 * something the marketplace may show, because the only images allowed on a
 * Builder Stock card are ones whose source we can point at.
 */
export async function demoteUnprovenSourceImage(
  db: any,
  input: { stockItemId: string; imageId: string; reason: string },
): Promise<void> {
  await db.from('builder_stock_item_images')
    .update({
      processing_status: 'unavailable',
      error_message: input.reason,
    })
    .eq('id', input.imageId)
    .eq('stock_item_id', input.stockItemId);
}

function hostOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return null;
  }
}

/**
 * Does this property already hold a usable image the source supplied?
 *
 * Asked before stages 2 and 3 run. A property whose builder gave us a render
 * has nothing to gain from a Street View of the same lot, and every provider
 * call is billed to somebody.
 */
export async function hasReadySourceImage(
  db: any,
  stockItemId: string,
  /** Only count a row whose origin is recorded to at least this standard. */
  minimumProvenanceVersion = 0,
): Promise<boolean> {
  const { data } = await db
    .from('builder_stock_item_images')
    .select('id, storage_path, external_url, source_detail')
    .eq('stock_item_id', stockItemId)
    .eq('source_stage', 'uploaded_document')
    .eq('processing_status', 'ready')
    .limit(20);
  return (data ?? []).some((row: any) =>
    (row.storage_path || row.external_url)
    && Number((row.source_detail ?? {}).provenance_version ?? 0) >= minimumProvenanceVersion);
}

/**
 * The same reading, answering three questions instead of one.
 *
 * `ready` is exactly what `hasReadySourceImage` answers, from the same query;
 * `clean` and `convictedOnly` are what the source repair needs to know before
 * it lets a stored image END the search — a promotional page cover is a ready
 * image and is still not a reason to stop reading the property's own package.
 * See `classifyPrimaryImageStanding` for the rules; this only fetches the rows.
 */
export async function readPrimaryImageStanding(
  db: any,
  stockItemId: string,
  minimumProvenanceVersion = 0,
): Promise<PrimaryImageStanding> {
  const { data } = await db
    .from('builder_stock_item_images')
    .select('id, storage_path, external_url, verification_status, source_detail')
    .eq('stock_item_id', stockItemId)
    .eq('source_stage', 'uploaded_document')
    .eq('processing_status', 'ready')
    .limit(20);
  return classifyPrimaryImageStanding(
    (data ?? []) as DisplayableImage[], minimumProvenanceVersion);
}
