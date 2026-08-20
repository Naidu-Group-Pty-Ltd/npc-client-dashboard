/**
 * Command Centre — Builder Stock in the Property Marketplace.
 *
 * The internal half of the Stock List feature. Reads the stock builders
 * uploaded through their portal, and writes the selection that activates the
 * builder when a Command Centre user picks a property for a client.
 *
 * THREE GATES, IN ORDER, ON EVERY OPERATION:
 *   1. the internal session (`verifyAuth`), plus CSRF on mutations;
 *   2. the module permission — deny by default, `listings` to read and
 *      `clients` to write a client selection;
 *   3. the `builder_stock_marketplace` feature flag.
 *
 * (3) is here and not only in the browser. Hiding a tab is convenience; a
 * disabled feature whose endpoint still answers is not disabled.
 *
 * THE SELECTION IS RESOLVED, NEVER ACCEPTED. The request names a property and
 * a client and nothing else. Which builder organisation supplied that
 * property, which upload it came from and which builder user uploaded it are
 * all re-read from the database at write time, because a browser cannot be the
 * source of a relationship.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.55.0';
import {
  verifyAuth, createCorsHeaders, createUnauthorizedResponse, createForbiddenResponse,
} from '../_shared/auth.ts';
import { requireModulePermission } from '../_shared/authz.ts';
import { enforceCsrf, csrfDenied } from '../_shared/csrfGuard.ts';
import { internalError } from '../_shared/errorResponse.ts';
import { STOCK_IMAGE_BUCKET } from '../_shared/builderStock/fileTypes.pure.ts';
import {
  COMMAND_SELECTION_SELECT, COMMAND_SELECTION_STATUSES, STOCK_IMAGE_SELECT,
  STOCK_ITEM_SELECT, isSelectableAvailability, stockPagination,
} from '../_shared/builderStock/projection.pure.ts';
import {
  isDisplayableSourceImage, type DisplayableImage,
} from '../_shared/builderStock/primaryImage.ts';
import {
  servableDerivativeFor,
} from '../_shared/builderStock/sanitizedDerivative.pure.ts';

const FEATURE_FLAG_KEY = 'builder_stock_marketplace';
const IMAGE_URL_TTL_SECONDS = 300;

function cleanText(value: unknown, max = 200): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * The toggle, read server-side.
 *
 * Fails CLOSED: an unreadable flag row disables the surface rather than
 * opening it. A missing row is the same as `false`, which is what a deployment
 * that has never turned this on should see.
 */
async function builderStockEnabled(db: any): Promise<boolean> {
  const { data, error } = await db
    .from('feature_flags').select('value').eq('key', FEATURE_FLAG_KEY).maybeSingle();
  if (error || !data) return false;
  const value = data.value;
  return value === true || value === 'true'
    || (typeof value === 'object' && value !== null && (value as any).enabled === true);
}

Deno.serve(async (req) => {
  const corsHeaders = createCorsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const csrf = enforceCsrf(req);
  if (!csrf.ok) return csrfDenied(corsHeaders, csrf);

  const json = (payload: unknown, status = 200) => new Response(
    JSON.stringify(payload),
    { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const body = await req.json().catch(() => ({} as Record<string, any>));
    const operation = String(body.operation || '');

    const { error: authError, userId, authMethod } = await verifyAuth(
      supabase, req.headers, body as { session_token?: string });
    if (authError || !userId) {
      return createUnauthorizedResponse(authError || 'Authentication required', corsHeaders);
    }
    const actor = { userId, authMethod };

    const listingsView = await requireModulePermission(supabase, actor, 'listings', 'can_view');
    if (!listingsView.ok) {
      return createForbiddenResponse(listingsView.error || 'Listings access required', corsHeaders);
    }

    /**
     * "Is the tab available?" — the one operation that must answer while the
     * feature is OFF, because it is what decides whether to render the tab.
     *
     * It is here rather than in the browser because the Command Centre's
     * Supabase client is anon-only: `feature_flags` grants SELECT to
     * `authenticated`, which this app's custom cookie session never becomes, so
     * a direct table read from the page returns nothing and every flag would
     * read as off. The service role inside this function is the only reader
     * that works, and the caller is still checked against `listings` above.
     */
    if (operation === 'feature_state') {
      return json({ success: true, enabled: await builderStockEnabled(supabase) });
    }

    // Gate 3. Every other operation, including the reads.
    if (!await builderStockEnabled(supabase)) {
      return json({
        error: 'Builder Stock is switched off for this workspace.',
        code: 'builder_stock_disabled',
      }, 403);
    }

    /** Load one stock item with its organisation. Active stock only. */
    const loadItem = async (itemId: string) => {
      if (!itemId) return null;
      const { data } = await supabase
        .from('builder_stock_items')
        .select('*')
        .eq('id', itemId)
        .eq('lifecycle_status', 'active')
        .maybeSingle();
      return data;
    };

    // =====================================================================
    // Reads
    // =====================================================================

    if (operation === 'list_stock') {
      const { page, pageSize, from, to } = stockPagination(body);
      const search = cleanText(body.search, 120);
      const organisationId = cleanText(body.organisation_id, 64);
      const availability = cleanText(body.availability_status, 40);
      const state = cleanText(body.state, 8);

      let query = supabase
        .from('builder_stock_items')
        .select(STOCK_ITEM_SELECT, { count: 'exact' })
        .eq('lifecycle_status', 'active');
      if (organisationId) query = query.eq('organisation_id', organisationId);
      if (availability) query = query.eq('availability_status', availability);
      if (state) query = query.eq('state', state);
      if (search) {
        const escaped = search.replace(/[%,()]/g, ' ');
        query = query.or(
          ['address_line', 'suburb', 'development_name', 'project_name', 'external_reference']
            .map((column) => `${column}.ilike.%${escaped}%`).join(','),
        );
      }

      const { data, count, error } = await query
        .order('created_at', { ascending: false })
        .range(from, to);
      if (error) {
        console.error('[builder-stock-marketplace] list failed', error.message);
        return json({ error: 'Builder stock could not be loaded.' }, 500);
      }

      const records = await decorate(supabase, data ?? []);
      return json({
        success: true,
        records,
        pagination: {
          page, page_size: pageSize, total: count ?? 0,
          total_pages: Math.max(1, Math.ceil((count ?? 0) / pageSize)),
        },
      });
    }

    if (operation === 'get_stock_item') {
      const item = await loadItem(cleanText(body.stock_item_id, 64));
      if (!item) return json({ error: 'Property not found' }, 404);
      const [record] = await decorate(supabase, [item]);
      return json({ success: true, record });
    }

    if (operation === 'list_builders') {
      // The organisations that actually have live stock, for the filter. A
      // full builder directory is not this endpoint's business.
      const { data } = await supabase
        .from('builder_stock_items')
        .select('organisation_id')
        .eq('lifecycle_status', 'active')
        .limit(10000);
      const ids = Array.from(new Set((data ?? []).map((row: any) => row.organisation_id)));
      if (!ids.length) return json({ success: true, records: [] });
      const { data: organisations } = await supabase
        .from('builder_organisations')
        .select('id, legal_name, trading_name')
        .in('id', ids);
      return json({ success: true, records: organisations ?? [] });
    }

    if (operation === 'image_url') {
      const { data: image } = await supabase
        .from('builder_stock_item_images')
        .select('id, stock_item_id, source_stage, verification_status, processing_status, storage_bucket, storage_path, external_url, source_detail')
        .eq('id', cleanText(body.image_id, 64))
        .maybeSingle();
      if (!image) return json({ error: 'Image not found' }, 404);

      /**
       * THE RULE IS ENFORCED WHERE THE BYTES ARE SERVED, not only where the
       * pointer is chosen.
       *
       * `primary_image_id` decides what a card asks for, and `primaryImage.ts`
       * is careful about how it is chosen — but this endpoint took any image id
       * and minted a signed URL for it on a service-role client. That included
       * the rows the re-audit had just DEMOTED for being unprovable, which is
       * precisely the class of picture the whole rule exists to keep off a
       * client's screen, and images belonging to stock no marketplace surface
       * will list. The same predicate the card applies is applied here, so
       * "no proven primary means no image" holds at the boundary that actually
       * hands over bytes.
       */
      if (!isDisplayableSourceImage(image as DisplayableImage)) {
        return json({ error: 'Image not found' }, 404);
      }
      /**
       * An image the document carried but attributed to NOBODY is stored
       * against the upload with a null `stock_item_id` — the page declining to
       * say whose house that is. It belongs to no property, so it is served to
       * nobody, and asking the question explicitly beats sending `id=eq.null`.
       */
      if (!image.stock_item_id) return json({ error: 'Image not found' }, 404);
      const { data: owner } = await supabase
        .from('builder_stock_items')
        .select('id')
        .eq('id', image.stock_item_id)
        .eq('lifecycle_status', 'active')
        .maybeSingle();
      if (!owner) return json({ error: 'Image not found' }, 404);

      if (image.external_url && !image.storage_path) {
        return json({ success: true, url: image.external_url, external: true });
      }

      /**
       * THE FROZEN DERIVATIVE, WHEN THERE IS ONE — NEVER A REPAIR AT REQUEST
       * TIME.
       *
       * Where the builder laid a promotional graphic over their own photograph,
       * the repair ran once, in the settler, and the result is an object in the
       * bucket. This endpoint reads a record and signs a path; it decodes
       * nothing, calls no model and generates nothing. A card that triggered a
       * repair would repair the same picture on every render, spend a vendor
       * key every time, and hand two viewers two different images.
       *
       * `servableDerivativeFor` is the same call the card's own filter makes,
       * so the two cannot disagree about which object this is. It resolves only
       * while the record still names the SHA-256 the row holds, so a replaced
       * original falls back to the original — which the gate above has already
       * decided is displayable.
       */
      const derivative = servableDerivativeFor(image.source_detail);
      const bucket = derivative?.storage_bucket
        || image.storage_bucket || STOCK_IMAGE_BUCKET;
      const path = derivative?.storage_path || image.storage_path;

      const { data: signed, error } = await supabase.storage
        .from(bucket)
        .createSignedUrl(path, IMAGE_URL_TTL_SECONDS);
      if (error || !signed?.signedUrl) return json({ error: 'The image could not be prepared' }, 502);
      return json({
        success: true,
        url: signed.signedUrl,
        expires_in: IMAGE_URL_TTL_SECONDS,
        // Disclosed rather than hidden: a repaired photograph is the builder's
        // own picture with an overlay removed, and a surface that wants to say
        // so can.
        sanitized: derivative ? derivative.transformation : null,
      });
    }

    if (operation === 'search_clients') {
      // The picker for "select for a client". Gated on the CLIENTS module, not
      // on listings — a user who may see the marketplace is not thereby
      // entitled to a directory of clients. Two columns and no more.
      const clientsView = await requireModulePermission(supabase, actor, 'clients', 'can_view');
      if (!clientsView.ok) {
        return createForbiddenResponse(clientsView.error || 'Client access required', corsHeaders);
      }
      const search = cleanText(body.search, 80);
      let query = supabase
        .from('clients')
        .select('id, primary_first_name, primary_surname, primary_email')
        .order('primary_surname', { ascending: true })
        .limit(25);
      if (search) {
        const escaped = search.replace(/[%,()]/g, ' ');
        query = query.or(
          ['primary_first_name', 'primary_surname', 'primary_email']
            .map((column) => `${column}.ilike.%${escaped}%`).join(','),
        );
      }
      const { data } = await query;
      return json({ success: true, records: data ?? [] });
    }

    if (operation === 'list_selections') {
      // Gated on the CLIENTS module, like `search_clients` and unlike the
      // stock reads: this returns `client_id`, the client's name and the
      // Command Centre's `internal_notes`. `listings.can_view` alone was
      // enough to reach all three, which let a user with Marketplace access
      // but no Clients access read both.
      const clientsView = await requireModulePermission(supabase, actor, 'clients', 'can_view');
      if (!clientsView.ok) {
        return createForbiddenResponse(clientsView.error || 'Client access required', corsHeaders);
      }

      const { page, pageSize, from, to } = stockPagination(body);
      const clientId = cleanText(body.client_id, 64);
      const stockItemId = cleanText(body.stock_item_id, 64);

      let query = supabase
        .from('builder_stock_selections')
        .select(COMMAND_SELECTION_SELECT, { count: 'exact' });
      if (clientId) query = query.eq('client_id', clientId);
      if (stockItemId) query = query.eq('stock_item_id', stockItemId);

      const { data, count } = await query
        .order('selected_at', { ascending: false })
        .range(from, to);

      const selections = data ?? [];
      const itemIds = Array.from(new Set(selections.map((row: any) => row.stock_item_id)));
      const clientIds = Array.from(new Set(selections.map((row: any) => row.client_id)));
      const organisationIds = Array.from(new Set(selections.map((row: any) => row.organisation_id)));

      const [{ data: items }, { data: clients }, { data: organisations }] = await Promise.all([
        itemIds.length
          ? supabase.from('builder_stock_items').select(STOCK_ITEM_SELECT).in('id', itemIds)
          : Promise.resolve({ data: [] }),
        clientIds.length
          ? supabase.from('clients')
            .select('id, primary_first_name, primary_surname').in('id', clientIds)
          : Promise.resolve({ data: [] }),
        organisationIds.length
          ? supabase.from('builder_organisations')
            .select('id, legal_name, trading_name').in('id', organisationIds)
          : Promise.resolve({ data: [] }),
      ]);

      const itemById = new Map((items ?? []).map((row: any) => [row.id, row]));
      const clientById = new Map((clients ?? []).map((row: any) => [row.id, row]));
      const organisationById = new Map((organisations ?? []).map((row: any) => [row.id, row]));

      return json({
        success: true,
        records: selections.map((row: any) => ({
          ...row,
          stock_item: itemById.get(row.stock_item_id) ?? null,
          client: clientById.get(row.client_id) ?? null,
          builder_organisation: organisationById.get(row.organisation_id) ?? null,
        })),
        pagination: {
          page, page_size: pageSize, total: count ?? 0,
          total_pages: Math.max(1, Math.ceil((count ?? 0) / pageSize)),
        },
      });
    }

    // =====================================================================
    // The selection — the write that activates the builder
    // =====================================================================

    if (operation === 'select_for_client') {
      const clientsEdit = await requireModulePermission(supabase, actor, 'clients', 'can_edit');
      if (!clientsEdit.ok) {
        return createForbiddenResponse(
          clientsEdit.error || 'Client edit access required', corsHeaders);
      }

      const item = await loadItem(cleanText(body.stock_item_id, 64));
      if (!item) return json({ error: 'Property not found' }, 404);
      if (!isSelectableAvailability(item.availability_status)) {
        return json({
          error: 'That property is no longer available.',
          code: 'not_available',
        }, 409);
      }

      // The client id is validated against the database, not trusted.
      const clientId = cleanText(body.client_id, 64);
      const { data: client } = await supabase
        .from('clients')
        .select('id, primary_first_name, primary_surname')
        .eq('id', clientId)
        .maybeSingle();
      if (!client) return json({ error: 'Client not found' }, 404);

      // The upload this property came from, and who uploaded it. Both read
      // from the item's own row — the request supplied neither.
      const { data: upload } = item.upload_id
        ? await supabase.from('builder_stock_uploads')
          .select('id, uploaded_by_builder_user_id, organisation_id')
          .eq('id', item.upload_id).maybeSingle()
        : { data: null };

      // A live selection already exists for this pair.
      const { data: existing } = await supabase
        .from('builder_stock_selections')
        .select(COMMAND_SELECTION_SELECT)
        .eq('stock_item_id', item.id)
        .eq('client_id', client.id)
        .neq('status', 'withdrawn')
        .maybeSingle();
      if (existing) {
        return json({
          success: true, record: existing, already_selected: true,
        });
      }

      const { data: selection, error } = await supabase
        .from('builder_stock_selections')
        .insert({
          stock_item_id: item.id,
          // Resolved, not accepted. The database trigger checks it again.
          organisation_id: item.organisation_id,
          source_upload_id: item.upload_id ?? null,
          // Also resolved from the item, never from the request.
          builder_project_id: item.builder_project_id ?? null,
          originating_builder_user_id:
            upload?.uploaded_by_builder_user_id ?? item.created_by_builder_user_id ?? null,
          client_id: client.id,
          selected_by_user_id: userId,
          status: 'selected',
          internal_notes: cleanText(body.notes, 2000) || null,
          builder_reference: cleanText(body.builder_reference, 120) || null,
        })
        .select(COMMAND_SELECTION_SELECT)
        .single();
      if (error) {
        console.error('[builder-stock-marketplace] selection insert failed', error.message);
        return json({ error: 'The selection could not be saved.' }, 400);
      }

      // The builder's activation signal. It is a notification in their portal,
      // written with the shared notification writer so it appears in the same
      // feed as everything else they are told.
      await notifyBuilder(supabase, {
        organisationId: item.organisation_id,
        builderUserId: selection.originating_builder_user_id,
        stockItemId: item.id,
        selectionId: selection.id,
      });

      return json({ success: true, record: selection });
    }

    if (operation === 'set_selection_status') {
      const clientsEdit = await requireModulePermission(supabase, actor, 'clients', 'can_edit');
      if (!clientsEdit.ok) {
        return createForbiddenResponse(
          clientsEdit.error || 'Client edit access required', corsHeaders);
      }

      const status = cleanText(body.status, 40);
      if (!(COMMAND_SELECTION_STATUSES as readonly string[]).includes(status)) {
        return json({ error: 'That status is not recognised' }, 400);
      }

      const selectionId = cleanText(body.selection_id, 64);
      const { data: selection } = await supabase
        .from('builder_stock_selections')
        .select('id, status')
        .eq('id', selectionId)
        .maybeSingle();
      if (!selection) return json({ error: 'Selection not found' }, 404);

      const { data, error } = await supabase
        .from('builder_stock_selections')
        .update({
          status,
          withdrawn_at: status === 'withdrawn' ? new Date().toISOString() : null,
          ...(body.notes !== undefined ? { internal_notes: cleanText(body.notes, 2000) || null } : {}),
        })
        .eq('id', selection.id)
        .select(COMMAND_SELECTION_SELECT)
        .single();
      if (error) return json({ error: 'The selection could not be updated.' }, 400);
      return json({ success: true, record: data });
    }

    return json({ error: `Unknown operation: ${operation}` }, 400);
  } catch (error) {
    console.error('[builder-stock-marketplace] unhandled', error);
    return new Response(
      JSON.stringify(internalError(error, 'builder-stock-marketplace')),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});

/** Images and builder identity for a page of stock. Two queries, not 2N. */
async function decorate(supabase: any, items: any[]): Promise<any[]> {
  if (!items.length) return [];
  const ids = items.map((item) => item.id);
  const organisationIds = Array.from(new Set(items.map((item) => item.organisation_id)));

  const [{ data: images }, { data: organisations }, { data: selections }] = await Promise.all([
    supabase.from('builder_stock_item_images')
      .select(STOCK_IMAGE_SELECT)
      .in('stock_item_id', ids)
      .order('position', { ascending: true }),
    supabase.from('builder_organisations')
      .select('id, legal_name, trading_name')
      .in('id', organisationIds),
    // No `client_id`. The card needs to know a property IS spoken for and at
    // what stage, not for whom — and `list_stock` is reachable on
    // `listings.can_view` alone, which does not entitle the caller to client
    // identifiers. `list_selections` is where a selection's client is read,
    // behind the Clients module.
    supabase.from('builder_stock_selections')
      .select('id, stock_item_id, status, selected_at')
      .in('stock_item_id', ids)
      .neq('status', 'withdrawn'),
  ]);

  const imagesByItem = new Map<string, any[]>();
  for (const image of images ?? []) {
    const list = imagesByItem.get(image.stock_item_id) ?? [];
    list.push(image);
    imagesByItem.set(image.stock_item_id, list);
  }
  const organisationById = new Map((organisations ?? []).map((row: any) => [row.id, row]));
  const selectionsByItem = new Map<string, any[]>();
  for (const selection of selections ?? []) {
    const list = selectionsByItem.get(selection.stock_item_id) ?? [];
    list.push(selection);
    selectionsByItem.set(selection.stock_item_id, list);
  }

  return items.map((item) => ({
    ...item,
    images: imagesByItem.get(item.id) ?? [],
    builder_organisation: organisationById.get(item.organisation_id) ?? null,
    selections: selectionsByItem.get(item.id) ?? [],
  }));
}

/**
 * Tell the builder. Best-effort by design: a notification that will not write
 * must not roll back a selection that did — the selection row IS the
 * activation, and the builder's Stock List reads it directly.
 */
async function notifyBuilder(
  supabase: any,
  input: {
    organisationId: string; builderUserId: string | null;
    stockItemId: string; selectionId: string;
  },
): Promise<void> {
  try {
    // Everyone with a live membership of the supplying organisation, so the
    // signal does not depend on one uploader still being active.
    const { data: members } = await supabase
      .from('builder_organisation_memberships')
      .select('builder_user_id')
      .eq('organisation_id', input.organisationId)
      .is('revoked_at', null)
      .limit(50);

    const recipients = new Set<string>(
      (members ?? []).map((row: any) => row.builder_user_id).filter(Boolean));
    if (input.builderUserId) recipients.add(input.builderUserId);
    if (!recipients.size) return;

    await supabase.from('builder_notifications').insert(
      Array.from(recipients).map((builderUserId) => ({
        builder_user_id: builderUserId,
        organisation_id: input.organisationId,
        // `general` is the only type this table accepts for an event outside
        // its enumerated list. Adding a value to that CHECK would be a change
        // to the collaboration module, which this feature does not own.
        notification_type: 'general',
        // No client name, no adviser name, no price. The builder is told that
        // one of their properties has been selected; the rest is not theirs.
        title: 'A property from your stock list has been selected',
        body: 'A Command Centre adviser has selected one of your uploaded properties for a buyer. Open Stock List to acknowledge it.',
        entity_kind: 'stock_selection',
        entity_id: input.selectionId,
      })),
    );
  } catch (error) {
    console.warn('[builder-stock-marketplace] builder notification failed',
      String((error as { message?: string })?.message ?? error));
  }
}
