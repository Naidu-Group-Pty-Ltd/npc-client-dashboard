/**
 * Builder stock lists — shared client types and labels.
 *
 * One module for both audiences. The Builder Portal and the Command Centre
 * render the same properties with the same wording, and a status that reads
 * "Sold" on one side and "sold" on the other is how two surfaces stop looking
 * like one product.
 *
 * The vocabularies here are re-exported from the edge function's pure modules
 * where one already exists, so the browser cannot offer a value the server
 * would reject.
 */
import {
  comparePrimaryEvidence, isPrimaryRole, readStoredEvidenceLevel, readStoredRole,
} from '../../supabase/functions/_shared/builderStock/sourceImageRole.pure';
import {
  isMarketplaceEligible,
} from '../../supabase/functions/_shared/builderStock/marketplaceEligibility.pure';
import {
  servableClearanceFor,
  servableDerivativeFor,
} from '../../supabase/functions/_shared/builderStock/sanitizedDerivative.pure';

export {
  stockFileAcceptAttribute,
  MAX_STOCK_FILE_BYTES,
  STOCK_EXTENSIONS,
} from '../../supabase/functions/_shared/builderStock/fileTypes.pure';
export {
  isPrimaryRole, readStoredRole, PRIMARY_ROLE,
  type SourceImageRole,
} from '../../supabase/functions/_shared/builderStock/sourceImageRole.pure';

export type StockUploadStatus =
  | 'uploaded' | 'parsing' | 'imported' | 'enriching' | 'complete'
  | 'partially_complete' | 'failed';

export type StockAvailability =
  | 'available' | 'on_hold' | 'reserved' | 'contracted' | 'sold' | 'settled'
  | 'withdrawn' | 'unknown';

export type StockImageStage = 'uploaded_document' | 'google_maps' | 'internet_search';

export type StockSelectionStatus =
  | 'selected' | 'builder_acknowledged' | 'progressed' | 'completed' | 'withdrawn';

export type StockSourceType = 'file' | 'url';

export interface BuilderStockUpload {
  id: string;
  organisation_id: string;
  uploaded_by_builder_user_id: string | null;
  /** How the bytes reached us. Both end in the same import pipeline. */
  source_type: StockSourceType;
  /** URL sources only: what the builder pasted, and where it settled. */
  source_url: string | null;
  final_url: string | null;
  /** A page title or shortened URL. What the history row is labelled with. */
  source_title: string | null;
  retrieved_at: string | null;
  original_filename: string;
  declared_content_type: string | null;
  detected_content_type: string | null;
  byte_size: number | null;
  status: StockUploadStatus;
  parse_strategy: string | null;
  records_detected: number;
  records_imported: number;
  records_updated: number;
  records_failed: number;
  image_stage_summary: Record<string, Record<string, number>> | null;
  error_code: string | null;
  /** Safe to display. The internal diagnosis is never sent to the browser. */
  error_message: string | null;
  processing_started_at: string | null;
  processing_completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BuilderStockImage {
  id: string;
  stock_item_id: string | null;
  source_stage: StockImageStage;
  source_reference: string | null;
  source_provider: string | null;
  source_page_url: string | null;
  external_url: string | null;
  storage_path: string | null;
  content_type: string | null;
  verification_status: 'source_supplied' | 'location_derived' | 'unverified';
  confidence: number | null;
  processing_status: 'pending' | 'ready' | 'unavailable' | 'failed';
  error_message: string | null;
  position: number;
  source_detail: Record<string, unknown> | null;
  created_at: string;
}

export interface BuilderStockItem {
  id: string;
  organisation_id: string;
  upload_id: string | null;
  first_upload_id: string | null;
  created_by_builder_user_id: string | null;
  builder_project_id: string | null;
  builder_unit_id: string | null;
  external_reference: string | null;
  development_name: string | null;
  project_name: string | null;
  address_line: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  lot_number: string | null;
  unit_number: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  car_spaces: number | null;
  property_type: string | null;
  land_size_sqm: number | null;
  building_size_sqm: number | null;
  price: number | null;
  price_display: string | null;
  availability_status: StockAvailability;
  expected_completion: string | null;
  description: string | null;
  lifecycle_status: 'active' | 'archived';
  enrichment_status: 'pending' | 'enriching' | 'complete' | 'partial' | 'failed';
  enriched_at: string | null;
  primary_image_id: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
  /** Attached by the server. */
  images?: BuilderStockImage[];
  builder_organisation?: { id: string; legal_name: string; trading_name: string | null } | null;
  selection_count?: number;
  latest_selection?: {
    id: string; status: StockSelectionStatus; selected_at: string; acknowledged_at: string | null;
  } | null;
  /** Live selections on this property. Carries no client identifier — see
   *  `decorate()` in `builder-stock-marketplace`. */
  selections?: Array<{
    id: string; status: StockSelectionStatus; selected_at: string;
  }>;
}

/** What the BUILDER is shown. No client, no adviser, no note. */
export interface BuilderStockSelectionForBuilder {
  id: string;
  stock_item_id: string;
  organisation_id: string;
  source_upload_id: string | null;
  originating_builder_user_id: string | null;
  builder_project_id: string | null;
  status: StockSelectionStatus;
  selected_at: string;
  acknowledged_at: string | null;
  acknowledged_by_builder_user_id: string | null;
  builder_reference: string | null;
  stock_item?: Partial<BuilderStockItem> | null;
}

/** What the COMMAND CENTRE is shown — it made the selection. */
export interface BuilderStockSelection extends BuilderStockSelectionForBuilder {
  client_id: string;
  selected_by_user_id: string;
  withdrawn_at: string | null;
  internal_notes: string | null;
  client?: { id: string; primary_first_name: string; primary_surname: string } | null;
  builder_organisation?: { id: string; legal_name: string; trading_name: string | null } | null;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** What a source row is called in the history. */
export function stockSourceLabel(upload: Pick<BuilderStockUpload,
  'source_type' | 'source_title' | 'original_filename' | 'source_url'>): string {
  if (upload.source_type === 'url') {
    return upload.source_title || upload.source_url || 'Imported page';
  }
  return upload.original_filename;
}

export const STOCK_SOURCE_TYPE_LABELS: Record<StockSourceType, string> = {
  file: 'File',
  url: 'URL',
};

export const STOCK_UPLOAD_STATUS_LABELS: Record<StockUploadStatus, string> = {
  uploaded: 'Uploaded',
  parsing: 'Reading the file',
  imported: 'Properties imported',
  enriching: 'Finding images',
  complete: 'Complete',
  partially_complete: 'Complete with issues',
  failed: 'Failed',
};

export const STOCK_UPLOAD_STATUS_CLASSES: Record<StockUploadStatus, string> = {
  uploaded: 'border-border/70 bg-muted/40 text-muted-foreground',
  parsing: 'border-primary/30 bg-primary/10 text-primary',
  imported: 'border-primary/30 bg-primary/10 text-primary',
  enriching: 'border-primary/30 bg-primary/10 text-primary',
  complete: 'border-success/30 bg-success/10 text-success',
  partially_complete: 'border-warning/30 bg-warning/10 text-warning',
  failed: 'border-destructive/30 bg-destructive/10 text-destructive',
};

export const STOCK_AVAILABILITY_LABELS: Record<StockAvailability, string> = {
  available: 'Available',
  on_hold: 'On hold',
  reserved: 'Reserved',
  contracted: 'Under contract',
  sold: 'Sold',
  settled: 'Settled',
  withdrawn: 'Withdrawn',
  unknown: 'Not stated',
};

export const STOCK_AVAILABILITY_CLASSES: Record<StockAvailability, string> = {
  available: 'border-success/30 bg-success/10 text-success',
  on_hold: 'border-warning/30 bg-warning/10 text-warning',
  reserved: 'border-warning/30 bg-warning/10 text-warning',
  contracted: 'border-primary/30 bg-primary/10 text-primary',
  sold: 'border-border/70 bg-muted/40 text-muted-foreground',
  settled: 'border-border/70 bg-muted/40 text-muted-foreground',
  withdrawn: 'border-border/70 bg-muted/40 text-muted-foreground',
  unknown: 'border-dashed border-border/70 bg-muted/30 text-muted-foreground',
};

/** Availability the marketplace still offers. Mirrors the server's set. */
export const SELECTABLE_AVAILABILITY: ReadonlySet<StockAvailability> =
  new Set<StockAvailability>(['available', 'on_hold', 'unknown']);

export const STOCK_IMAGE_STAGE_LABELS: Record<StockImageStage, string> = {
  uploaded_document: 'From the stock list',
  google_maps: 'Street View / satellite',
  internet_search: 'Found online',
};

/** The short badge that must appear wherever an image does. */
export const STOCK_IMAGE_STAGE_BADGES: Record<StockImageStage, string> = {
  uploaded_document: 'Builder supplied',
  google_maps: 'Location imagery',
  internet_search: 'Unverified',
};

export const STOCK_SELECTION_STATUS_LABELS: Record<StockSelectionStatus, string> = {
  selected: 'Selected for a client',
  builder_acknowledged: 'Acknowledged by builder',
  progressed: 'Progressing',
  completed: 'Completed',
  withdrawn: 'Withdrawn',
};

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export function stockItemTitle(item: Pick<BuilderStockItem,
  'unit_number' | 'lot_number' | 'address_line' | 'development_name'
  | 'project_name' | 'external_reference'>): string {
  const prefix = item.unit_number
    ? `Unit ${item.unit_number}`
    : item.lot_number ? `Lot ${item.lot_number}` : '';
  const body = item.address_line
    ?? item.development_name ?? item.project_name ?? item.external_reference ?? '';
  if (prefix && body) return `${prefix}, ${body}`;
  return prefix || body || 'Unnamed property';
}

export function stockItemLocality(item: Pick<BuilderStockItem,
  'suburb' | 'state' | 'postcode'>): string {
  return [item.suburb, item.state, item.postcode].filter(Boolean).join(' ');
}

/**
 * The price line.
 *
 * `price_display` wins when it exists, because it is what the builder's own
 * file said — printing "$749,000" where the schedule said "From $749,000" is a
 * different offer.
 */
export function stockItemPrice(item: Pick<BuilderStockItem, 'price' | 'price_display'>): string | null {
  if (item.price_display) return item.price_display;
  if (item.price === null || item.price === undefined) return null;
  return new Intl.NumberFormat('en-AU', {
    style: 'currency', currency: 'AUD', maximumFractionDigits: 0,
  }).format(item.price);
}

export function stockItemConfiguration(item: Pick<BuilderStockItem,
  'bedrooms' | 'bathrooms' | 'car_spaces'>): string | null {
  const parts: string[] = [];
  if (item.bedrooms !== null && item.bedrooms !== undefined) parts.push(`${item.bedrooms} bed`);
  if (item.bathrooms !== null && item.bathrooms !== undefined) parts.push(`${item.bathrooms} bath`);
  if (item.car_spaces !== null && item.car_spaces !== undefined) parts.push(`${item.car_spaces} car`);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * The image a Builder Stock card shows — the builder's own, or none.
 *
 * ONE RULE, MIRRORING THE SERVER'S `primaryImage.ts`: a card may show the
 * photograph the builder supplied, or an empty frame. Street View, a satellite
 * still and a search result are none of them a photograph of the property, and
 * a card showing one tells a client something untrue about a house.
 *
 * There is deliberately NO ordering across stages any more, because there is
 * nothing to order: `google_maps` and `internet_search` are not candidates.
 * They stay in the payload — the source panel still reports what each stage
 * found — they are simply never what the card draws.
 */
export function isDisplayableSourceImage(image: BuilderStockImage): boolean {
  return image.source_stage === 'uploaded_document'
    && image.verification_status === 'source_supplied'
    && image.processing_status === 'ready'
    && !!(image.storage_path || image.external_url)
    && isPrimaryRole(readStoredRole(image.source_detail))
    // The stored verdict, read — never re-measured. Deciding this per card
    // would mean decoding every image on every render.
    //
    // Or the same photograph with the laid-over graphic taken off. That is a
    // derivative of THESE bytes, named by id and by SHA-256 and re-measured by
    // the same classifier, not a substitute picture. Mirrors the server's
    // `primaryImage.ts`, and both read the one rule.
    //
    // Or the same photograph with nothing wrong with it: a clearance, which is
    // the precise inspection's finding that the classifier convicted this
    // picture for a feature of the house rather than for a badge. That serves
    // the ORIGINAL — nothing was made and nothing was changed.
    && (isMarketplaceEligible(image.source_detail)
      || !!servableDerivativeFor(image.source_detail)
      || !!servableClearanceFor(image.source_detail));
}

/**
 * The card's image, or null.
 *
 * TWO THINGS CHANGED HERE, AND THE SECOND IS WHAT A CLIENT ACTUALLY SAW.
 *
 * The role check above is the first: "the builder supplied this" and "the
 * builder supplied this AS this property's listing image" are different facts,
 * and only the second belongs on a card badged "Builder supplied".
 *
 * The second is that the fallback can no longer reach an image the source did
 * not designate. It used to fall back to the lowest-`position` SOURCE image
 * whenever `primary_image_id` was absent or stale, which meant the server could
 * decline to nominate a primary and the card would show one anyway. Lot 537
 * Kirramingly Avenue is exactly that: its `primary_image_id` is null in the
 * database, and the bedroom render reached the marketplace through this
 * fallback alone. The fallback is kept — a stale pointer at a Street View must
 * still resolve to the builder's own image rather than to nothing — but it now
 * ranks only images that already passed the role check above, so there is
 * nothing for it to fall back TO unless the source designated one.
 */
export function primaryStockImage(item: BuilderStockItem): BuilderStockImage | null {
  const displayable = (item.images ?? []).filter(isDisplayableSourceImage);
  if (!displayable.length) return null;

  if (item.primary_image_id) {
    const chosen = displayable.find((image) => image.id === item.primary_image_id);
    if (chosen) return chosen;
  }
  // The stored choice is missing or stale. Ranked exactly as the server ranks
  // it — the strength of the source's own evidence first, then the order the
  // SOURCE gave them, then the id — so the two never disagree.
  return [...displayable].sort((a, b) =>
    comparePrimaryEvidence(
      readStoredEvidenceLevel(a.source_detail), readStoredEvidenceLevel(b.source_detail))
    || (a.position ?? 0) - (b.position ?? 0)
    || String(a.id).localeCompare(String(b.id)))[0] ?? null;
}

/** Per-stage state for the enrichment readout. */
export function stockImageStageSummary(item: BuilderStockItem): Array<{
  stage: StockImageStage; label: string; ready: number; note: string | null;
}> {
  const stages: StockImageStage[] = ['uploaded_document', 'google_maps', 'internet_search'];
  return stages.map((stage) => {
    const rows = (item.images ?? []).filter((image) => image.source_stage === stage);
    const ready = rows.filter((image) => image.processing_status === 'ready').length;
    const problem = rows.find((image) => image.processing_status !== 'ready');
    return {
      stage,
      label: STOCK_IMAGE_STAGE_LABELS[stage],
      ready,
      note: ready ? null : (problem?.error_message ?? 'Not attempted yet'),
    };
  });
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (!bytes || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
