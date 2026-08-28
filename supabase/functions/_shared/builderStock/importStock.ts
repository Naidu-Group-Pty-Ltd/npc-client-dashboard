/**
 * Builder stock lists — writing the rows.
 *
 * Takes what `extract.ts` read, normalises it, and matches each record against
 * the stock this organisation already has before deciding to insert or update.
 *
 * Two rules carry this module:
 *
 *   MATCHING IS CONSERVATIVE. Only two keys count — the builder's own
 *   reference, and development + lot/unit with both halves present. Anything
 *   fuzzier can merge two different properties, and a merged property is a
 *   defect nobody can see. A duplicate row, by contrast, is visible and can be
 *   archived.
 *
 *   AN UPDATE NEVER ERASES. A second upload of a thinner file must not blank
 *   the fields the first one filled, so only values the new file actually
 *   carries are written. That includes availability: a row whose status column
 *   we could not read leaves the stored status alone rather than resetting it
 *   to `unknown`.
 */
import {
  normaliseStockRow, stockMatchKeys, stockRecordLabel,
  type NormalisedStockRecord,
} from './normalise.pure.ts';
import { STOCK_IMAGE_BUCKET } from './fileTypes.pure.ts';
import type { ExtractedMedia } from './extract.ts';
import {
  attributeDocumentMedia, settleContainerMediaRoles, settleRowAssetRoles,
  type AnchoredAssets, type SourceImageAsset,
} from './sourceAssets.pure.ts';
import { roleDetail, roleFromExplicitField } from './sourceImageRole.pure.ts';
import { chooseAndStorePrimaryImage } from './primaryImage.ts';
import { assignPdfMediaRolesPerProperty } from './pdfPrimaryImage.pure.ts';
import {
  PROVENANCE_VERSION, storeSourceImages, type SourceImageFetcher,
} from './sourceImages.ts';
import { anchorPdfRowsToPages, pdfAnchorPage } from './pdfRowAnchors.pure.ts';
import { eligibilityDetailFor } from './assessSourceImage.ts';

/** What `attachDocumentMedia` did with one picture, for a caller that counts. */
export interface AttachedMedia {
  reference: string;
  /** The property it reached, or null where the document did not say. */
  stockItemId: string | null;
  anchor: string | null;
  stored: boolean;
}

export interface ImportOutcome {
  detected: number;
  imported: number;
  updated: number;
  failed: number;
  itemIds: string[];
  /** Safe to show the uploader: a label and a short reason, never a stack. */
  failures: Array<{ label: string; reason: string }>;
  /**
   * Properties whose card now has the builder's own picture on it.
   *
   * Reported so an import can SAY whether supplied-image processing worked
   * rather than leaving a reader to infer it from an empty frame later.
   */
  withSourceImage: number;
  /**
   * IMAGERY THIS IMPORT DELIBERATELY LEFT FOR THE ENRICHMENT PASS.
   *
   * The properties are saved either way; this says only that their pictures
   * are not all attached yet, so the caller keeps the upload's settlement
   * markers open and the browser's existing loop finishes the job. See
   * `IMAGE_BUDGET_MS`.
   */
  imageryOutstanding: boolean;
}

interface ExistingItem {
  id: string;
  external_reference: string | null;
  development_name: string | null;
  project_name: string | null;
  unit_number: string | null;
  lot_number: string | null;
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

/** Only the fields the record actually carries. Null means "the file was silent". */
function writablePatch(record: NormalisedStockRecord): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const set = (column: string, value: unknown) => {
    if (value !== null && value !== undefined && value !== '') patch[column] = value;
  };
  set('external_reference', record.external_reference);
  set('development_name', record.development_name);
  set('project_name', record.project_name);
  set('address_line', record.address_line);
  set('suburb', record.suburb);
  set('state', record.state);
  set('postcode', record.postcode);
  set('lot_number', record.lot_number);
  set('unit_number', record.unit_number);
  set('bedrooms', record.bedrooms);
  set('bathrooms', record.bathrooms);
  set('car_spaces', record.car_spaces);
  set('property_type', record.property_type);
  set('land_size_sqm', record.land_size_sqm);
  set('building_size_sqm', record.building_size_sqm);
  set('price', record.price);
  set('price_display', record.price_display);
  set('expected_completion', record.expected_completion);
  set('description', record.description);
  // `unknown` is the absence of a reading, not a reading of absence.
  if (record.availability_status !== 'unknown') {
    patch.availability_status = record.availability_status;
  }
  return patch;
}

/**
 * Resolve the existing builder project and unit a record names, when the
 * portal already holds them.
 *
 * This is what keeps the feature from duplicating the inventory model: a stock
 * row that IS a `builder_units` row links to it instead of copying it. Nothing
 * is created here — an unmatched record simply carries no unit, which is a
 * complete and correct state.
 */
async function buildInventoryIndex(db: any, organisationId: string): Promise<{
  projectByName: Map<string, string>;
  unitByProjectAndNumber: Map<string, string>;
}> {
  const projectByName = new Map<string, string>();
  const unitByProjectAndNumber = new Map<string, string>();

  const { data: projects } = await db
    .from('builder_projects')
    .select('id, name, project_reference')
    .or(`developer_organisation_id.eq.${organisationId},builder_organisation_id.eq.${organisationId}`)
    .limit(500);

  for (const project of projects ?? []) {
    const name = String(project.name ?? '').trim().toLowerCase();
    if (name) projectByName.set(name, project.id);
    const reference = String(project.project_reference ?? '').trim().toLowerCase();
    if (reference) projectByName.set(reference, project.id);
  }

  const projectIds = Array.from(new Set(Array.from(projectByName.values())));
  if (projectIds.length) {
    const { data: units } = await db
      .from('builder_units')
      .select('id, project_id, unit_number')
      .in('project_id', projectIds)
      .limit(5000);
    for (const unit of units ?? []) {
      const number = String(unit.unit_number ?? '').trim().toLowerCase();
      if (number) unitByProjectAndNumber.set(`${unit.project_id}|${number}`, unit.id);
    }
  }

  return { projectByName, unitByProjectAndNumber };
}

/**
 * HOW LONG AN IMPORT MAY SPEND ATTACHING PICTURES.
 *
 * MEASURED IN PRODUCTION, AND IT IS THE DEFECT THIS CONSTANT EXISTS FOR. This
 * function's own comment further down says "The page enriches next. Images
 * never block the import." That was the intent and it was not true: every
 * stored image is downloaded here, hashed three times and put through
 * `eligibilityDetailFor`, which decodes a thumbnail and runs the marketing
 * overlay classifier. On 27 Aug 2026 a 23-row Notion stock list did that
 * inline and the worker was killed on its RESOURCE limit ~16s in — twice, on
 * consecutive attempts.
 *
 * A KILLED WORKER IS THE WORST WAY FOR THIS TO FAIL. It emits no body and no
 * CORS headers, so the browser's fetch REJECTS rather than reading a status:
 * the portal showed "Failed to fetch" while the server had already committed
 * the upload and every property in it. The user is told the import failed by
 * the one path that cannot tell them anything else.
 *
 * So the image phase is BUDGETED and the records are not. Properties are
 * cheap and are always saved in full; pictures are expensive, are attached
 * while there is room, and whatever is left is reported as outstanding —
 * which is a state this system already knows how to finish, because
 * `enrich_images` settles exactly this and `repairSourceImagesForUpload`
 * re-reads the source (including re-fetching a Notion page for its row
 * covers) to do it.
 */
const IMAGE_BUDGET_MS = 8_000;

/**
 * And a ceiling on the COUNT, because the limit that killed the worker is CPU
 * rather than wall clock and a deadline only measures the latter. Each stored
 * image is a decode plus a classifier pass; twenty of them is the most one
 * request may take on. The rest are outstanding, not lost.
 */
const MAX_IMAGES_PER_IMPORT = 20;

export async function importStockRecords(
  db: any,
  input: {
    organisationId: string;
    uploadId: string;
    builderUserId: string | null;
    rows: Array<Record<string, unknown>>;
    media: ExtractedMedia[];
    /** Imagery the source published against one of its own rows. */
    rowAssets?: AnchoredAssets[];
    /**
     * When the image phase must stop. Defaults to `IMAGE_BUDGET_MS` from now.
     * The records are never subject to it — see that constant.
     */
    imageDeadlineAt?: number;
    /**
     * The document's prose, one entry per page, for a format that paginates.
     * A PDF's properties are read out of prose and carry no anchor of their
     * own, so the page each one is described on is worked out here — see
     * `pdfRowAnchors.pure.ts`, which refuses far more often than it answers.
     */
    pageTexts?: string[];
    /**
     * Did the document's OWN page tree establish that order?
     *
     * False means a page number is the third-lowest object number rather than
     * the third page, so no page may be read as a property's cover. It defaults
     * to true only where no paginated reader ran at all.
     */
    pageOrderAuthoritative?: boolean;
    /** The uploaded document's own name, recorded on every image it yielded. */
    filename?: string | null;
  },
  /**
   * Injected for the same reason the repair injects it: the production fetcher
   * reaches for `Deno.resolveDns`, and the end-to-end contract this module now
   * owns — import produces a displayable card — has to be exercisable.
   */
  deps: { fetchImage?: SourceImageFetcher } = {},
): Promise<ImportOutcome> {
  const outcome: ImportOutcome = {
    detected: 0, imported: 0, updated: 0, failed: 0, itemIds: [], failures: [],
    withSourceImage: 0,
    imageryOutstanding: false,
  };

  /**
   * The image phase's allowance, spent by every step that stores a picture.
   *
   * `room()` is asked BEFORE each expensive step rather than after it, so the
   * step that would exceed the budget is the one that does not run. Anything
   * it declines is recorded as outstanding rather than dropped.
   */
  const imageDeadlineAt = (input.imageDeadlineAt ?? Date.now() + IMAGE_BUDGET_MS);
  let imagesStored = 0;
  const room = (): boolean => {
    if (Date.now() > imageDeadlineAt || imagesStored >= MAX_IMAGES_PER_IMPORT) {
      outcome.imageryOutstanding = true;
      return false;
    }
    return true;
  };

  /**
   * Anchor → the property it became.
   *
   * An anchor that two properties claim is demoted to null rather than
   * arbitrarily resolved: a slide holding two lots states no relationship
   * between its picture and either of them, and picking one would be exactly
   * the mis-attribution this whole path exists to prevent.
   */
  const itemIdByAnchor = new Map<string, string | null>();
  const labelByItemId = new Map<string, string>();
  const claimAnchor = (anchor: string | null, itemId: string) => {
    if (!anchor) return;
    if (!itemIdByAnchor.has(anchor)) { itemIdByAnchor.set(anchor, itemId); return; }
    if (itemIdByAnchor.get(anchor) !== itemId) itemIdByAnchor.set(anchor, null);
  };

  // Normalise first, so `detected` counts properties and not spreadsheet lines.
  const records: NormalisedStockRecord[] = [];
  for (const row of input.rows) {
    const record = normaliseStockRow(row);
    if (record) records.push(record);
  }
  outcome.detected = records.length;
  if (!records.length) return outcome;

  /**
   * A paginated document's own structure, applied to records that arrived
   * without an anchor. Only records the pages actually name get one; the rest
   * stay unanchored, which is the whole point — an unanchored record's
   * photograph is stored against the upload and shown against nobody.
   */
  if (input.pageTexts?.length) {
    const photoPages = input.media
      .map((media) => pdfAnchorPage(media.anchor))
      .filter((page): page is number => page !== null);
    const anchors = anchorPdfRowsToPages(
      records.map((record) => stockRecordLabel(record)),
      input.pageTexts,
      photoPages,
      input.pageOrderAuthoritative !== false,
    );
    records.forEach((record, index) => {
      if (!record.source_anchor && anchors[index]) record.source_anchor = anchors[index];
    });
  }

  const { data: existingRows } = await db
    .from('builder_stock_items')
    .select('id, external_reference, development_name, project_name, unit_number, lot_number')
    .eq('organisation_id', input.organisationId)
    .limit(20000);

  const byReference = new Map<string, string>();
  const byDevelopmentUnit = new Map<string, string>();
  for (const item of (existingRows ?? []) as ExistingItem[]) {
    const reference = referenceKey(item);
    if (reference) byReference.set(reference, item.id);
    const developmentUnit = developmentUnitKey(item);
    if (developmentUnit) byDevelopmentUnit.set(developmentUnit, item.id);
  }

  const inventory = await buildInventoryIndex(db, input.organisationId);
  const now = new Date().toISOString();

  for (const record of records) {
    const label = stockRecordLabel(record);
    try {
      const keys = stockMatchKeys(record);
      const existingId = (keys.reference ? byReference.get(keys.reference) : undefined)
        ?? (keys.developmentUnit
          ? byDevelopmentUnit.get(`${keys.developmentUnit.development}|${keys.developmentUnit.unit}`)
          : undefined);

      const patch = writablePatch(record);

      // Link, never copy.
      const projectName = (record.project_name ?? record.development_name ?? '').trim().toLowerCase();
      const projectId = projectName ? inventory.projectByName.get(projectName) : undefined;
      if (projectId) {
        patch.builder_project_id = projectId;
        const unitNumber = (record.unit_number ?? record.lot_number ?? '').trim().toLowerCase();
        const unitId = unitNumber
          ? inventory.unitByProjectAndNumber.get(`${projectId}|${unitNumber}`)
          : undefined;
        if (unitId) patch.builder_unit_id = unitId;
      }

      let itemId: string;
      if (existingId) {
        const { data, error } = await db
          .from('builder_stock_items')
          .update({
            ...patch,
            upload_id: input.uploadId,
            source_row: record as unknown as Record<string, unknown>,
            lifecycle_status: 'active',
            last_seen_at: now,
          })
          .eq('id', existingId)
          .eq('organisation_id', input.organisationId)
          .select('id')
          .single();
        if (error) throw error;
        itemId = data.id;
        outcome.updated += 1;
      } else {
        const { data, error } = await db
          .from('builder_stock_items')
          .insert({
            ...patch,
            organisation_id: input.organisationId,
            upload_id: input.uploadId,
            first_upload_id: input.uploadId,
            created_by_builder_user_id: input.builderUserId,
            source_row: record as unknown as Record<string, unknown>,
            availability_status: patch.availability_status ?? 'unknown',
            last_seen_at: now,
          })
          .select('id')
          .single();
        if (error) throw error;
        itemId = data.id;
        outcome.imported += 1;

        // Keep the in-memory index current so two rows in ONE file that match
        // each other update rather than colliding on the unique index.
        const reference = keys.reference;
        if (reference) byReference.set(reference, itemId);
        if (keys.developmentUnit) {
          byDevelopmentUnit.set(
            `${keys.developmentUnit.development}|${keys.developmentUnit.unit}`, itemId);
        }
      }

      outcome.itemIds.push(itemId);
      // The label the property was matched on, kept so a paginated source can
      // ask which page states THIS property's identity.
      labelByItemId.set(itemId, label);
      claimAnchor(record.source_anchor, itemId);

      /**
       * Image URLs the file itself listed are stage-1 provenance: the builder
       * supplied them, so they are `source_supplied` and not a search result.
       * The BYTES are taken now rather than the link being kept — see
       * `sourceImages.ts` — so the card does not depend on somebody else's
       * server months later.
       */
      if (record.image_urls.length && room()) {
        imagesStored += record.image_urls.length;
        await storeSourceImages(db, {
          organisationId: input.organisationId,
          uploadId: input.uploadId,
          stockItemId: itemId,
          assets: settleRowAssetRoles(
            record.image_urls.map((url, position): SourceImageAsset => ({
              url,
              reference: url.slice(0, 400),
              origin: 'stock_list_column',
              provider: 'stock_list_column',
              pageUrl: null,
              position,
              linkFallback: true,
              // LEVEL 1: the heading the URL sat under is the source saying
              // what the image is for.
              role: roleFromExplicitField(record.image_url_fields[url]),
            })),
            {
              container: 'this property\'s row',
              designation: 'property image',
              preferredIndex: record.image_urls.findIndex(
                (url) => roleFromExplicitField(record.image_url_fields[url]).evidenceLevel === 1),
            },
          ),
        }, { fetchImage: deps.fetchImage });
      }
    } catch (error) {
      outcome.failed += 1;
      if (outcome.failures.length < 25) {
        outcome.failures.push({ label, reason: safeFailureReason(error) });
      }
    }
  }

  /**
   * Imagery the SOURCE tied to one of its rows — a Notion row's cover, an
   * `<img>` inside a stock table's row. The anchor came out of the source and
   * travelled with the row; nothing here matches by order or by name.
   */
  for (const anchored of input.rowAssets ?? []) {
    const itemId = itemIdByAnchor.get(anchored.anchor);
    if (!itemId) continue;
    if (!room()) break;
    imagesStored += anchored.assets.length;
    await storeSourceImages(db, {
      organisationId: input.organisationId,
      uploadId: input.uploadId,
      stockItemId: itemId,
      assets: anchored.assets,
    }, { fetchImage: deps.fetchImage });
  }

  if (input.media.length && !room()) {
    // The document's own media is the same expensive work by another route.
    // Left whole for the enrichment pass rather than half-attributed here:
    // `attachDocumentMedia` decides roles across the WHOLE set, so running it
    // against a truncated one would be attribution on partial evidence.
    outcome.imageryOutstanding = true;
  } else await attachDocumentMedia(
    db, { ...input, documentRowCount: records.length }, outcome.itemIds, itemIdByAnchor,
    input.pageTexts?.length
      ? {
        labelByItemId,
        pageTexts: input.pageTexts,
        pageOrderAuthoritative: input.pageOrderAuthoritative !== false,
      }
      : null,
  );

  /**
   * SETTLE THE POINTER. An import that stores a photograph and does not say
   * which one the property shows has not finished.
   *
   * This used to be nobody's job here. `primary_image_id` was written only by
   * `enrichStockItem` — the stage-2/3 PROVIDER loop — so a property's own
   * builder-supplied picture reached its card as a side effect of going out to
   * Google and Perplexity for pictures it did not need. Where that loop did not
   * run, and it does not run for a property it has already been through, the
   * image sat in the bucket with nothing pointing at it and the card read "No
   * image found". That is how Lot 537 Kirramingly Avenue ended up needing a
   * person to press "Source images".
   *
   * It is the same rule the repair and the marketplace apply
   * (`chooseDisplayableImage`), and it is cheap: a read of the rows this import
   * just wrote and one column. No network, no provider, no budget.
   */
  for (const itemId of new Set(outcome.itemIds)) {
    try {
      const primary = await chooseAndStorePrimaryImage(db, itemId);
      if (primary) outcome.withSourceImage += 1;
    } catch (error) {
      // An import must not fail because a pointer could not be written; the
      // property is already saved. It is logged so it is discoverable, and the
      // re-queue below means the automatic loop will try again.
      console.warn('[builderStock] primary image not settled at import', {
        upload_id: input.uploadId,
        stock_item_id: itemId,
        phase: 'primary_assignment',
        message: safeFailureReason(error),
      });
    }
  }

  /**
   * PUT EVERY TOUCHED PROPERTY BACK IN THE IMAGE QUEUE.
   *
   * `enrich_images` selects `enrichment_status in ('pending','enriching')`, and
   * an import never wrote that column — so re-importing a source updated the
   * property, attached a better image and left it in whatever state it had
   * finished in last time. `complete` meant the loop skipped it; `failed` meant
   * nothing automatic would ever look at it again, which is precisely what
   * every property became on the day the role rule shipped.
   *
   * A property this import touched has new imagery by definition, so its image
   * pipeline starts again. This is pipeline state and not property data: no
   * price, availability, configuration, selection or linkage is written here.
   */
  if (outcome.itemIds.length) {
    await db.from('builder_stock_items')
      .update({ enrichment_status: 'pending' })
      // Scoped like every other write in this module: an id in a list is a
      // lookup key, never authority.
      .eq('organisation_id', input.organisationId)
      .in('id', [...new Set(outcome.itemIds)]);
  }

  return outcome;
}

/**
 * Store the imagery found INSIDE the document.
 *
 * ATTRIBUTION IS STRUCTURAL FIRST. Every office format states where a picture
 * sits — a spreadsheet drawing is anchored to a cell, a `<w:drawing>` lives
 * inside a `<w:tr>`, a slide holds one property's schedule — and where the
 * container said so, that statement decides. Counting is what remains for a
 * format that stated nothing, and `attributeDocumentMedia` switches even that
 * off once any image in the same document carried a real anchor.
 *
 * Anything unattributed is kept against the UPLOAD with no property attached:
 * source information is never deleted, and a render of lot 12 shown against
 * lot 40 is worse than showing nothing.
 */
export async function attachDocumentMedia(
  db: any,
  input: {
    organisationId: string; uploadId: string; media: ExtractedMedia[];
    /** The document these pictures came out of, recorded on each of them. */
    filename?: string | null;
    /**
     * How many property rows the DOCUMENT stated — which can exceed the
     * imported list when rows failed to import or, in the repair, when only
     * some re-matched. The one-property containment fallback keys on this,
     * so a caller holding one match out of a twelve-row file cannot present
     * the file as a one-property document.
     */
    documentRowCount?: number;
  },
  itemIdsInOrder: string[],
  itemIdByAnchor: Map<string, string | null>,
  /**
   * The properties this upload produced, and the page text they were read out
   * of. Present for a PAGINATED source, where the role of a picture is decided
   * by which page presents the property as a package — see
   * `pdfPrimaryImage.pure.ts`. Absent for everything else, whose containment is
   * the only thing the format states.
   */
  paginated?: {
    labelByItemId: Map<string, string>;
    pageTexts: string[];
    pageOrderAuthoritative: boolean;
  } | null,
): Promise<AttachedMedia[]> {
  const attached: AttachedMedia[] = [];
  if (!input.media.length) return attached;

  const resolvedAnchors: Record<string, string> = {};
  for (const [anchor, itemId] of itemIdByAnchor.entries()) {
    if (itemId) resolvedAnchors[anchor] = itemId;
  }
  /**
   * A PDF's photographs are attributed by the page they were drawn on and by
   * nothing else. Counting is not the fallback here: a page anchor that no
   * property claimed is the document DECLINING to say whose house that is, and
   * the answer to that is an image kept against the upload and shown against
   * nobody. Other formats keep the counting fallback they always had.
   */
  const pageAnchored = input.media.some((media) => pdfAnchorPage(media.anchor) !== null);
  const attributions = attributeDocumentMedia({
    anchors: input.media.map((media) => media.anchor ?? null),
    itemIdByAnchor: resolvedAnchors,
    itemIdsInOrder: pageAnchored ? [] : itemIdsInOrder,
    rowCount: input.documentRowCount,
  });

  /**
   * WHAT EACH PICTURE IS FOR, settled once for the whole document.
   *
   * Provenance — these bytes came from here — was already recorded and was
   * never the problem. This is the second fact: did the source present this
   * image as THIS property's listing image? Without it, "source_supplied" was
   * read as "safe to show", and a bedroom render reached a client's card.
   */
  const roles = paginated
    ? assignPdfMediaRolesPerProperty({
      media: input.media,
      stockItemIds: attributions.map((attribution) => attribution.stockItemId),
      ...paginated,
    })
    : settleContainerMediaRoles({
      media: input.media.map((media) => ({ name: media.name, anchor: media.anchor ?? null })),
      stockItemIds: attributions.map((attribution) => attribution.stockItemId),
      structural: attributions.map((attribution) => attribution.structural),
      container: 'the container in the builder\'s own document',
    });

  for (const [index, media] of input.media.entries()) {
    const path = `${input.organisationId}/${input.uploadId}/document/${index}-${media.name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(-60)}`;
    try {
      const { error: uploadError } = await db.storage
        .from(STOCK_IMAGE_BUCKET)
        .upload(path, media.bytes, { contentType: media.contentType, upsert: true });
      if (uploadError) throw uploadError;

      const attribution = attributions[index];
      const stockItemId = attribution.stockItemId;

      await db.from('builder_stock_item_images').upsert({
        stock_item_id: stockItemId,
        upload_id: input.uploadId,
        organisation_id: input.organisationId,
        source_stage: 'uploaded_document',
        source_reference: media.name.slice(0, 400),
        source_provider: 'uploaded_file',
        storage_bucket: STOCK_IMAGE_BUCKET,
        storage_path: path,
        content_type: media.contentType,
        byte_size: media.bytes.length,
        verification_status: 'source_supplied',
        confidence: stockItemId ? 1 : null,
        processing_status: 'ready',
        position: index,
        source_detail: {
          // The origin every embedded-document image shares, stamped so a
          // census can SEE this path — it used to write no origin at all, and
          // every row it produced landed in the legacy no-origin bucket.
          origin: 'document_media',
          attributed: !!stockItemId,
          structural: attribution.structural,
          anchor: media.anchor ?? null,
          reason: attribution.reason,
          // What the enumeration that produced this entry looked like, when
          // the extractor recorded one. A truncated read is a fact about the
          // row, not a silence.
          ...(media.enumeration ? { enumeration: media.enumeration } : {}),
          ...roleDetail(roles[index]),
          // Whether the marketplace may DRAW it. Every format lands here or
          // in `sourceImages.ts`, and both ask the same question of the bytes.
          ...await eligibilityDetailFor(media.bytes, roles[index].role),
          upload_id: input.uploadId,
          stock_item_id: stockItemId,
          filename: input.filename ?? null,
          /**
           * Where in the builder's own document this came from, and what it
           * hashes to at both ends. This is the record that makes
           * "source_supplied" a fact somebody can check rather than a label.
           */
          ...(media.provenance
            ? {
              page: media.provenance.page,
              method: media.provenance.method,
              object_number: media.provenance.objectNumber,
              resource_name: media.provenance.resourceName,
              source_width: media.provenance.sourceWidth,
              source_height: media.provenance.sourceHeight,
              source_sha256: media.provenance.sourceSha256,
              stored_sha256: media.provenance.storedSha256,
              crop: media.provenance.crop,
              page_area_share: media.provenance.pageAreaShare,
              transformation: media.provenance.transformation,
              // Stamped only where the origin is actually recorded, because
              // this is the version the re-audit trusts.
              provenance_version: PROVENANCE_VERSION,
            }
            : {}),
        },
      }, { onConflict: 'stock_item_id,source_stage,source_reference' });
      attached.push({
        reference: media.name.slice(0, 400),
        stockItemId,
        anchor: media.anchor ?? null,
        stored: true,
      });
    } catch {
      // A document image that will not store must not fail the import. The
      // property is already saved and stages 2 and 3 still run.
      attached.push({
        reference: media.name.slice(0, 400),
        stockItemId: null,
        anchor: media.anchor ?? null,
        stored: false,
      });
    }
  }
  return attached;
}

function safeFailureReason(error: unknown): string {
  const message = String((error as { message?: string })?.message ?? error ?? '');
  if (/duplicate key/i.test(message)) return 'A matching property already exists in your stock.';
  if (/violates check constraint/i.test(message)) return 'A value in this row is outside the allowed range.';
  if (/invalid input syntax/i.test(message)) return 'A value in this row could not be read.';
  return 'This row could not be saved.';
}
