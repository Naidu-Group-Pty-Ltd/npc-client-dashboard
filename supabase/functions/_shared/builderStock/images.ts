/**
 * Builder stock — three-stage image enrichment.
 *
 * An imported property needs a picture, and there are exactly three places one
 * can come from. They are run in order, they are recorded SEPARATELY, and
 * their provenance is never merged:
 *
 *   1. uploaded_document  the builder's own render or photograph, taken out of
 *                         the file they uploaded. Written by `importStock.ts`
 *                         at import time, not here.
 *   2. google_maps        Street View or satellite imagery of the property's
 *                         actual address, fetched server-side so the API key
 *                         never reaches a browser.
 *   3. internet_search    a broader search for imagery of this development.
 *                         Kept as a URL plus where it was found, marked
 *                         `unverified` for ever, because nothing has confirmed
 *                         it depicts THIS property.
 *
 * THE STAGES MAY FAIL. A property whose address will not geocode, a
 * deployment with no Google key, a search that returns nothing — each records
 * its stage as unavailable and the import stands. Only a stage that produced
 * an image is allowed to change what the marketplace shows.
 */
import { meteredFetch } from '../meteredFetch.ts';
import { enforceGlobalDailyQuota, killSwitchActive } from '../publicAbuseControls.ts';
import { STOCK_IMAGE_BUCKET } from './fileTypes.pure.ts';
import { geocodableAddress } from './normalise.pure.ts';
import { hasReadySourceImage } from './sourceImages.ts';
import { chooseAndStorePrimaryImage } from './primaryImage.ts';
import { nextImageStage, WEB_VERIFIED_VERIFICATION } from './imagePriority.pure.ts';
import { verifyWebImageIdentity } from './webImageIdentity.pure.ts';

/**
 * The SAME circuit scope `street-view` uses.
 *
 * Google imagery is one vendor account with one bill and one failure mode, so
 * it gets one circuit, one daily ceiling and one kill switch — shared with the
 * Listings page rather than duplicated for this feature. A second scope would
 * mean the breaker could be open for the dashboard and closed here, and the
 * daily limit would be spent twice over.
 */
const GOOGLE_CIRCUIT_SCOPE = 'google_street_view';

export interface EnrichableStockItem {
  id: string;
  organisation_id: string;
  address_line: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  development_name: string | null;
  project_name: string | null;
  lot_number: string | null;
  unit_number: string | null;
  /**
   * Has the builder's own source finished being read for this property?
   *
   * FALSE MEANS "DO NOT PAY YET". A property whose source settlement is still
   * outstanding may be about to gain the builder's own render, and buying a
   * search or a Street View against it spends money to be discarded — or
   * worse, puts a fallback on a card that is about to have the real picture.
   * Defaults to true so a caller that has not looked behaves as before.
   */
  sourceSettlementComplete?: boolean;
  /** The builder's trading name, for the identity check on a web result. */
  builder_name?: string | null;
}

export interface StageOutcome {
  stage: 'google_maps' | 'internet_search';
  /**
   * `skipped` is not a failure and not an absence: it is a stage that was not
   * WORTH running because the builder's own image is already in hand. It is
   * recorded on the row as `unavailable` — the schema's three statuses are not
   * being extended — with a message that says which of the two it was.
   */
  status: 'ready' | 'unavailable' | 'failed' | 'skipped';
  detail: string;
}

/**
 * A search is slower than a map tile, and it is the last thing that runs
 * before the batch's wall-clock budget matters.
 */
const SEARCH_TIMEOUT_MS = 15_000;

/**
 * `publicAbuseControls.fetchWithTimeout` is the shared primitive, but it calls
 * plain `fetch`, and a Perplexity call that skips `meteredFetch` is billed to
 * nobody. This is the same abort-on-deadline shape applied to the metered
 * wrapper instead of replacing it.
 */
async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    return await work(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Record a stage that produced nothing, so the UI can say why. */
async function recordStageUnavailable(
  db: any,
  item: EnrichableStockItem,
  stage: 'google_maps' | 'internet_search',
  status: 'unavailable' | 'failed',
  message: string,
  provider: string,
): Promise<StageOutcome> {
  await db.from('builder_stock_item_images').upsert({
    stock_item_id: item.id,
    organisation_id: item.organisation_id,
    source_stage: stage,
    source_reference: 'stage-status',
    source_provider: provider,
    processing_status: status,
    verification_status: stage === 'google_maps' ? 'location_derived' : 'unverified',
    error_message: message,
    position: 0,
  }, { onConflict: 'stock_item_id,source_stage,source_reference' });
  return { stage, status, detail: message };
}

/**
 * Record a stage that was not run because stage 1 already answered.
 *
 * A stage that PRODUCED something is left exactly as it is: on an existing
 * property being repaired, the Street View we already paid for stays on the
 * record. It simply stops being the picture the marketplace shows.
 */
async function recordStageSkipped(
  db: any,
  item: EnrichableStockItem,
  stage: 'google_maps' | 'internet_search',
): Promise<StageOutcome> {
  const message = 'Skipped: the builder supplied an image for this property.';
  const { data: existing } = await db
    .from('builder_stock_item_images')
    .select('id')
    .eq('stock_item_id', item.id)
    .eq('source_stage', stage)
    .eq('processing_status', 'ready')
    .limit(1);

  if (!(existing ?? []).length) {
    await db.from('builder_stock_item_images').upsert({
      stock_item_id: item.id,
      organisation_id: item.organisation_id,
      source_stage: stage,
      source_reference: 'stage-status',
      source_provider: stage === 'google_maps' ? 'google' : 'perplexity',
      processing_status: 'unavailable',
      verification_status: stage === 'google_maps' ? 'location_derived' : 'unverified',
      error_message: message,
      position: 0,
    }, { onConflict: 'stock_item_id,source_stage,source_reference' });
  }
  return { stage, status: 'skipped', detail: message };
}

// ---------------------------------------------------------------------------
// Stage 2 — Google Maps / location
// ---------------------------------------------------------------------------

/**
 * Street View of the address, falling back to a satellite still.
 *
 * THE CREDENTIAL AND THE CONTROLS AROUND IT ARE THE EXISTING ONES.
 * `GOOGLE_MAPS_API_KEY` is the same secret `street-view`, `google-places-autocomplete`
 * and `resolve-listing-coordinates` spend, read from the environment inside
 * this function and never returned to any caller: the bytes land in a private
 * bucket and the browser gets a short-lived signed URL. Around it sit the same
 * `publicAbuseControls` primitives the Listings page's Street View proxy uses —
 * one kill switch, one daily ceiling and one circuit breaker on the shared
 * `google_street_view` scope, so a bulk stock import cannot quietly spend the
 * dashboard's Google budget or hammer a provider that is already failing.
 *
 * `meteredFetch` still wraps every call: it resolves the credential from the
 * host and writes the `api_usage_log` row, so this spend is recharged to the
 * tenant that made it.
 */
export async function enrichFromGoogle(
  db: any,
  item: EnrichableStockItem,
): Promise<StageOutcome> {
  const apiKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
  if (!apiKey) {
    return await recordStageUnavailable(
      db, item, 'google_maps', 'unavailable',
      'Location imagery is not configured for this workspace.', 'google');
  }

  const address = geocodableAddress(item);
  if (!address) {
    return await recordStageUnavailable(
      db, item, 'google_maps', 'unavailable',
      'This property has no street address to look up.', 'google');
  }

  // The operator's off switch, shared with `street-view`.
  if (killSwitchActive('GOOGLE_STREET_VIEW_KILL_SWITCH')) {
    return await recordStageUnavailable(
      db, item, 'google_maps', 'unavailable',
      'Location imagery is temporarily switched off.', 'google');
  }

  /**
   * The circuit reports whether GOOGLE is failing. Fail OPEN when our own
   * circuit store cannot be read — that says nothing about Google, and
   * `street-view` records what treating an unreadable store as "open" cost:
   * an unapplied migration turned a local database gap into a total outage of
   * the feature.
   */
  const { data: circuitOpen, error: circuitReadError } = await db
    .rpc('provider_circuit_is_open', { p_scope: GOOGLE_CIRCUIT_SCOPE });
  if (circuitReadError) {
    console.warn('[builderStock] google circuit state unreadable, proceeding:',
      circuitReadError.message);
  } else if (circuitOpen === true) {
    return await recordStageUnavailable(
      db, item, 'google_maps', 'unavailable',
      'Location imagery is temporarily unavailable.', 'google');
  }

  // The same daily ceiling and the same env var as `street-view`, because it
  // is the same Google account being billed.
  const dailyLimit = Number(Deno.env.get('GOOGLE_STREET_VIEW_DAILY_LIMIT') ?? '5000');
  const spend = async (): Promise<boolean> =>
    (await enforceGlobalDailyQuota(db, GOOGLE_CIRCUIT_SCOPE, dailyLimit)).ok;

  try {
    if (!await spend()) {
      return await recordStageUnavailable(
        db, item, 'google_maps', 'unavailable',
        'The daily limit for location imagery has been reached.', 'google');
    }
    const geocoded = await meteredFetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&region=au&key=${apiKey}`,
      {},
      { feature: 'builder-stock/geocode' },
    );
    const geo = await geocoded.json().catch(() => null);
    const location = geo?.results?.[0]?.geometry?.location;
    if (!location || typeof location.lat !== 'number' || typeof location.lng !== 'number') {
      return await recordStageUnavailable(
        db, item, 'google_maps', 'unavailable',
        'That address could not be located.', 'google');
    }

    const point = `${location.lat},${location.lng}`;
    let bytes: Uint8Array | null = null;
    let product = 'streetview';

    if (!await spend()) {
      return await recordStageUnavailable(
        db, item, 'google_maps', 'unavailable',
        'The daily limit for location imagery has been reached.', 'google');
    }
    const metadata = await meteredFetch(
      `https://maps.googleapis.com/maps/api/streetview/metadata?location=${encodeURIComponent(point)}&key=${apiKey}`,
      {},
      { feature: 'builder-stock/streetview-metadata' },
    );
    const meta = await metadata.json().catch(() => ({}));

    if (meta?.status !== 'OK' && meta?.status !== 'ZERO_RESULTS') {
      // A provider error, not an absence of coverage. Tell the shared breaker.
      await db.rpc('provider_circuit_record_failure',
        { p_scope: GOOGLE_CIRCUIT_SCOPE, p_threshold: 20, p_open_seconds: 60 });
    }

    if (meta?.status === 'OK' && await spend()) {
      const params = new URLSearchParams({
        size: '640x400', location: point, fov: '80', pitch: '0',
        return_error_code: 'true', key: apiKey,
      });
      const image = await meteredFetch(
        `https://maps.googleapis.com/maps/api/streetview?${params.toString()}`,
        {}, { feature: 'builder-stock/streetview' },
      );
      if (image.ok) bytes = new Uint8Array(await image.arrayBuffer());
      else {
        await db.rpc('provider_circuit_record_failure',
          { p_scope: GOOGLE_CIRCUIT_SCOPE, p_threshold: 20, p_open_seconds: 60 });
      }
    }

    /**
     * NO SATELLITE PROMOTION. The product requirement is STREET VIEW, and a
     * satellite tile is not a photograph of a house — it is a roof. It is
     * still fetched and kept, because it is honest location imagery and other
     * surfaces may show it, but `imagePriority.pure.ts` ranks only
     * `streetview`, so a tile can never become a marketplace card image.
     *
     * Where there is no Street View coverage — normal on a new estate whose
     * road has not been driven — the card shows nothing, which is what the
     * rule asks for.
     */
    if (!bytes && await spend()) {
      product = 'staticmap';
      const params = new URLSearchParams({
        center: point, zoom: '18', size: '640x400', maptype: 'satellite',
        markers: `color:red|${point}`, key: apiKey,
      });
      const image = await meteredFetch(
        `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`,
        {}, { feature: 'builder-stock/staticmap' },
      );
      if (image.ok) bytes = new Uint8Array(await image.arrayBuffer());
    }

    if (bytes) {
      await db.rpc('provider_circuit_record_success', { p_scope: GOOGLE_CIRCUIT_SCOPE });
    }

    if (!bytes || bytes.length < 1024) {
      return await recordStageUnavailable(
        db, item, 'google_maps', 'unavailable',
        'No location imagery is available for this address.', 'google');
    }

    const path = `${item.organisation_id}/items/${item.id}/google-${product}.jpg`;
    const { error: uploadError } = await db.storage
      .from(STOCK_IMAGE_BUCKET)
      .upload(path, bytes, { contentType: 'image/jpeg', upsert: true });
    if (uploadError) throw uploadError;

    await db.from('builder_stock_item_images').upsert({
      stock_item_id: item.id,
      organisation_id: item.organisation_id,
      source_stage: 'google_maps',
      source_reference: product,
      source_provider: 'google',
      storage_bucket: STOCK_IMAGE_BUCKET,
      storage_path: path,
      content_type: 'image/jpeg',
      byte_size: bytes.length,
      // Derived from the address we hold, which is a weaker claim than the
      // builder's own render and a much stronger one than a search result.
      verification_status: 'location_derived',
      confidence: product === 'streetview' ? 0.8 : 0.6,
      processing_status: 'ready',
      error_message: null,
      position: 0,
      source_detail: { address, latitude: location.lat, longitude: location.lng, product },
    }, { onConflict: 'stock_item_id,source_stage,source_reference' });

    return { stage: 'google_maps', status: 'ready', detail: product };
  } catch (error) {
    console.warn('[builderStock] google enrichment failed', {
      item: item.id, message: String((error as { message?: string })?.message ?? error),
    });
    return await recordStageUnavailable(
      db, item, 'google_maps', 'failed',
      'Location imagery could not be retrieved.', 'google');
  }
}

// ---------------------------------------------------------------------------
// Stage 3 — broader internet search
// ---------------------------------------------------------------------------

/**
 * What the property is called out in the world, for a search engine.
 *
 * Deliberately more than the address: a new estate's lots are not indexed
 * individually, but the development and the builder are.
 */
export function stockSearchQuery(
  item: EnrichableStockItem,
  builderName: string | null,
): string | null {
  const parts: string[] = [];
  if (item.address_line) parts.push(item.address_line);
  const development = item.development_name ?? item.project_name;
  if (development) parts.push(development);
  if (item.suburb) parts.push(item.suburb);
  if (item.state) parts.push(item.state);
  if (builderName) parts.push(builderName);
  if (item.lot_number) parts.push(`Lot ${item.lot_number}`);
  else if (item.unit_number) parts.push(`Unit ${item.unit_number}`);
  // A search on a suburb alone returns pictures of somewhere else in it.
  if (!item.address_line && !development) return null;
  return parts.join(', ').slice(0, 300);
}

/**
 * The broader search.
 *
 * THE CREDENTIAL IS THE EXISTING ONE. `PERPLEXITY_API_KEY` is the same secret
 * `estimate-property-expenses`, `generate-investment-report`,
 * `format-comparison-report` and `generate-market-intelligence-report` already
 * spend, read server-side and never returned to a caller. The call goes through
 * `meteredFetch`, which resolves the credential from `perplexity.ai` and writes
 * the `api_usage_log` row — the repo's rule is that a vendor call which skips
 * it is billed to nobody.
 */
export async function enrichFromInternetSearch(
  db: any,
  item: EnrichableStockItem,
  builderName: string | null,
): Promise<StageOutcome> {
  const apiKey = Deno.env.get('PERPLEXITY_API_KEY');
  if (!apiKey) {
    return await recordStageUnavailable(
      db, item, 'internet_search', 'unavailable',
      'Internet property search is not configured for this workspace.', 'perplexity');
  }

  const query = stockSearchQuery(item, builderName);
  if (!query) {
    return await recordStageUnavailable(
      db, item, 'internet_search', 'unavailable',
      'This property does not name enough to search for.', 'perplexity');
  }

  try {
    const response = await withTimeout((signal) => meteredFetch(
      'https://api.perplexity.ai/chat/completions',
      {
        method: 'POST',
        signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'sonar',
          temperature: 0,
          max_tokens: 700,
          messages: [
            {
              role: 'system',
              content: 'You find publicly published photographs of Australian residential property. '
                + 'Reply with JSON only: {"images":[{"image_url":"...","source_page_url":"...","title":"..."}]}. '
                + 'Only include direct links to image files (.jpg, .jpeg, .png, .webp) that you found on the page you cite. '
                + 'Never guess a URL. If you find none, reply {"images":[]}.',
            },
            {
              role: 'user',
              content: `Find published photographs or renders of this property or its development: ${query}`,
            },
          ],
        }),
      },
      { feature: 'builder-stock/image-search', model: 'sonar' },
    ));

    if (!response.ok) {
      return await recordStageUnavailable(
        db, item, 'internet_search', 'failed',
        'The property search service did not respond.', 'perplexity');
    }

    const payload = await response.json().catch(() => null);
    const content = String(payload?.choices?.[0]?.message?.content ?? '');
    const candidates = parseSearchImages(content);

    if (!candidates.length) {
      return await recordStageUnavailable(
        db, item, 'internet_search', 'unavailable',
        'No published imagery was found for this property.', 'perplexity');
    }

    /**
     * EVERY CANDIDATE IS CHECKED AGAINST THE PROPERTY BEFORE IT MAY BE SHOWN.
     *
     * Finding a URL is not verifying a property. A candidate that passes
     * `verifyWebImageIdentity` is written with the positive verification state
     * and the evidence that earned it; one that does not is still recorded —
     * with its refusal reason — as `unverified`, which is the state every
     * historical row has and which nothing displays. So a rejection is
     * auditable and is never a card image.
     */
    let verified = 0;
    for (const [index, candidate] of candidates.entries()) {
      const verdict = verifyWebImageIdentity({
        imageUrl: candidate.imageUrl,
        pageUrl: candidate.pageUrl,
        title: candidate.title,
      }, {
        addressLine: item.address_line,
        lotNumber: item.lot_number,
        unitNumber: item.unit_number,
        developmentName: item.development_name,
        projectName: item.project_name,
        suburb: item.suburb,
        state: item.state,
        postcode: item.postcode,
        builderName,
      });
      if (verdict.ok) verified += 1;

      await db.from('builder_stock_item_images').upsert({
        stock_item_id: item.id,
        organisation_id: item.organisation_id,
        source_stage: 'internet_search',
        source_reference: candidate.imageUrl.slice(0, 400),
        source_provider: 'perplexity',
        source_page_url: candidate.pageUrl,
        // NOT stored. An internet image is kept as a link with its provenance;
        // copying it into our bucket would make it look like ours.
        external_url: candidate.imageUrl,
        verification_status: verdict.ok ? WEB_VERIFIED_VERIFICATION : 'unverified',
        confidence: verdict.ok ? 0.6 : 0.3,
        processing_status: 'ready',
        position: index,
        source_detail: {
          query, title: candidate.title,
          ...(verdict.ok
            ? {
              property_identity: {
                matched: verdict.matched,
                verified_at: new Date().toISOString(),
                stock_item_id: item.id,
                organisation_id: item.organisation_id,
                source_page_url: candidate.pageUrl ?? null,
                query_fingerprint: query,
              },
            }
            : { identity_refused: verdict.reason, identity_matched: verdict.matched }),
        },
      }, { onConflict: 'stock_item_id,source_stage,source_reference' });
    }

    return {
      stage: 'internet_search',
      status: verified ? 'ready' : 'unavailable',
      detail: `${candidates.length} candidate(s), ${verified} verified`,
    };
  } catch (error) {
    console.warn('[builderStock] internet search failed', {
      item: item.id, message: String((error as { message?: string })?.message ?? error),
    });
    return await recordStageUnavailable(
      db, item, 'internet_search', 'failed',
      'The property search could not be completed.', 'perplexity');
  }
}

interface SearchCandidate { imageUrl: string; pageUrl: string | null; title: string | null }

/** Pull the candidates out of the model's reply, discarding anything unusable. */
export function parseSearchImages(content: string): SearchCandidate[] {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let parsed: { images?: unknown };
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed.images) ? parsed.images : [];
  const out: SearchCandidate[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const imageUrl = String((row as { image_url?: unknown }).image_url ?? '').trim();
    if (!/^https:\/\/[^\s"']+$/i.test(imageUrl)) continue;
    if (imageUrl.length > 1500) continue;
    if (!/\.(jpe?g|png|webp)(\?|$)/i.test(imageUrl)) continue;
    if (seen.has(imageUrl)) continue;
    seen.add(imageUrl);

    const pageUrl = String((row as { source_page_url?: unknown }).source_page_url ?? '').trim();
    out.push({
      imageUrl,
      pageUrl: /^https?:\/\//i.test(pageUrl) ? pageUrl.slice(0, 1500) : null,
      title: String((row as { title?: unknown }).title ?? '').trim().slice(0, 200) || null,
    });
    if (out.length >= 4) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Run stages 2 and 3 for one property and settle its enrichment status.
 *
 * Stage 1 already ran at import time. The primary image is then chosen by
 * priority — the builder's own image, then location imagery, then a search
 * result — and nothing is deleted when a better one appears.
 */
export async function enrichStockItem(
  db: any,
  item: EnrichableStockItem,
  builderName: string | null,
): Promise<{ outcomes: StageOutcome[]; enrichmentStatus: string }> {
  await db.from('builder_stock_items')
    .update({ enrichment_status: 'enriching' })
    .eq('id', item.id);

  const outcomes: StageOutcome[] = [];

  /**
   * STAGE 1 SETTLES IT.
   *
   * A property whose builder supplied a photograph has nothing to gain from a
   * Street View of the same lot or a search for a picture that might be it:
   * the priority below would discard both anyway, and each is a call billed to
   * somebody. The three-stage record is still written — stages 2 and 3 say
   * they were skipped and why — so the audit row reads as three stages, which
   * is what it is.
   */
  /**
   * ONE STAGE AT A TIME, IN PRIORITY ORDER — never all three ranked afterwards.
   *
   * What changed: this used to run BOTH paid stages whenever stage 1 produced
   * nothing, and the selector then discarded whatever they wrote, because the
   * old rule was builder-supplied-or-nothing. So every property without a
   * source picture bought a geocode, a Street View metadata call, a Street
   * View still (or a satellite tile) AND a Perplexity search, to display none
   * of them.
   *
   * `nextImageStage` decides instead, from the rows this property already
   * holds. Its `wait` answer is the one that matters most: a source image
   * whose display verdict has not been measured yet is evidence that has not
   * ARRIVED, and paying for a search against it is how a builder's own render
   * loses to a photograph of somebody else's estate.
   */
  const { data: rows } = await db
    .from('builder_stock_item_images')
    .select('id, source_stage, verification_status, processing_status, position, '
      + 'storage_path, external_url, source_detail')
    .eq('stock_item_id', item.id);

  const stage = nextImageStage((rows ?? []) as never, {
    sourceSettlementComplete: item.sourceSettlementComplete !== false,
  });

  if (stage === 'none' || stage === 'wait') {
    // Both paid stages are recorded as skipped, which is what they were. A
    // `wait` is not a finding about the property and writes no verdict.
    for (const skipped of ['google_maps', 'internet_search'] as const) {
      outcomes.push(await recordStageSkipped(db, item, skipped));
    }
  } else if (stage === 'web_search') {
    outcomes.push(await enrichFromInternetSearch(db, item, builderName));
    outcomes.push(await recordStageSkipped(db, item, 'google_maps'));
  } else {
    outcomes.push(await enrichFromGoogle(db, item));
    outcomes.push(await recordStageSkipped(db, item, 'internet_search'));
  }

  const primaryImageId = await chooseAndStorePrimaryImage(db, item.id);
  const anyReady = !!primaryImageId;
  const anyProblem = outcomes.some(
    (outcome) => outcome.status !== 'ready' && outcome.status !== 'skipped');

  const enrichmentStatus = anyReady
    ? (anyProblem ? 'partial' : 'complete')
    : 'failed';

  await db.from('builder_stock_items')
    .update({ enrichment_status: enrichmentStatus, enriched_at: new Date().toISOString() })
    .eq('id', item.id);

  return { outcomes, enrichmentStatus };
}

export { chooseAndStorePrimaryImage, SOURCE_SUPPLIED_STAGE } from './primaryImage.ts';
