import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verifyAuth, createCorsHeaders, createUnauthorizedResponse } from '../_shared/auth.ts';
import { enforceCsrf, csrfDenied } from "../_shared/csrfGuard.ts";
import { enforceRawBodyLimit, verifySignedInternal } from '../_shared/requestSecurity.ts';
import { getEffectiveGhlCredentials } from '../_shared/ghl-account.ts';
import { internalError } from '../_shared/errorResponse.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-correlation-id, x-step-up-token',
  'Access-Control-Expose-Headers': 'x-correlation-id, x-tokens-used, x-tokens-reserved, x-tokens-estimated, x-duration-ms',
};

const GHL_API_BASE = 'https://services.leadconnectorhq.com';

/**
 * A wall-clock budget, because this walk does not fit.
 *
 * `config.toml` declares `request_timeout = 120` for this function. 95s
 * leaves room to write a response that says how far the pass got, which is
 * the whole point: a run cut off by the platform reports nothing, and the
 * caller cannot tell it from one that finished.
 */
const BUDGET_MS = 95_000;

interface GHLOpportunity {
  id: string;
  name: string;
  monetaryValue: number;
  pipelineId: string;
  pipelineStageId: string;
  status: string;
  contact: {
    id: string;
    name: string;
    email?: string;
    phone?: string;
  };
  notes?: string;
  createdAt: string;
  updatedAt: string;
  followUpDate?: string;
  customFields?: Array<{
    id: string;
    key?: string;
    value: any;
  }>;
}

interface GHLPipeline {
  id: string;
  name: string;
  stages: Array<{
    id: string;
    name: string;
    position: number;
  }>;
}

interface GHLOpportunitiesResponse {
  opportunities: GHLOpportunity[];
  meta: {
    total: number;
    nextPageUrl?: string;
    startAfterId?: string;
    startAfter?: number;
  };
}

// Default colors for pipeline stages based on position
const STAGE_COLORS = [
  '#6B7280', // gray
  '#3B82F6', // blue
  '#6366F1', // indigo
  '#8B5CF6', // violet
  '#A855F7', // purple
  '#EC4899', // pink
  '#EF4444', // red
  '#F97316', // orange
  '#F59E0B', // amber
  '#EAB308', // yellow
  '#84CC16', // lime
  '#22C55E', // green
  '#14B8A6', // teal
  '#06B6D4', // cyan
];

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  const corsHeaders = createCorsHeaders(origin);
  
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // SEC5-CSRF: reject cross-site cookie-authenticated mutations (exact-origin).
  // No-op for GET/HEAD/OPTIONS and any request without the session cookie.
  const __csrf = enforceCsrf(req);
  if (!__csrf.ok) return csrfDenied(corsHeaders, __csrf);

  const startedAt = Date.now();
  const stop = () => Date.now() - startedAt > BUDGET_MS;

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !supabaseKey) {
      return new Response(JSON.stringify({ error: 'Supabase credentials not configured', success: false }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const supabase = createClient(supabaseUrl, supabaseKey);
    // Capture run start so we can purge any rows not touched by this sync
    const syncRunStartedAt = new Date().toISOString();
    const _ghlCreds = await getEffectiveGhlCredentials(supabase);
    const apiKey = _ghlCreds.apiKey;
    const locationId = _ghlCreds.locationId;
    console.log(`[sync-ghl-pipelines] Using GHL account: ${_ghlCreds.label}`);
    
    if (!apiKey || !locationId) {
      console.error('GHL credentials not configured');
      return new Response(JSON.stringify({ 
        error: 'GoHighLevel credentials not configured',
        success: false 
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // The signature covers a hash of the raw bytes, so the body is read once
    // as text and parsed from that — `req.json()` consumes the stream and
    // leaves nothing for `verifySignedInternal` to hash.
    const bounded = await enforceRawBodyLimit(req, 8192);
    if (!bounded.ok) return bounded.error;
    let body: any = {};
    try { body = bounded.raw ? JSON.parse(bounded.raw) : {}; } catch { body = {}; }

    /*
     * Where a previous pass stopped, and when the RUN began.
     *
     * `syncRunStartedAt` above is this PASS. The reconciliations at the end
     * judge rows against the start of the run, so that timestamp has to
     * survive the resume — a pass-local one marks everything the previous
     * pass wrote as stale and deletes it.
     */
    const resumeAfterContactId: string | null =
      typeof body?.resumeAfterContactId === 'string' && body.resumeAfterContactId.length > 0
        ? body.resumeAfterContactId
        : null;
    const runStartedAt: string =
      typeof body?.runStartedAt === 'string' && body.runStartedAt.length > 0
        ? body.runStartedAt
        : syncRunStartedAt;

    /*
     * A scheduled caller, because the resume above needs a driver.
     *
     * This function had no cron at all: it ran when somebody opened the Client
     * Tracker, and a pass cut off by the platform was never picked back up. A
     * budget with nothing to call it again is just a quieter truncation.
     *
     * `cron_invoke_signed_function` sends a signed internal envelope and the
     * anon key for the gateway — no user JWT — so `verifyAuth` alone could
     * never have admitted it. The human path is untouched.
     */
    const internal = await verifySignedInternal(supabase, req, bounded.raw, ['pg_cron']);
    if (!internal.ok) {
      const { error: authError, userId } = await verifyAuth(supabase, req.headers, body);
      if (authError) {
        console.log('[sync-ghl-pipelines] Auth failed:', authError);
        return createUnauthorizedResponse(authError, corsHeaders);
      }
      console.log(`[sync-ghl-pipelines] Authenticated user: ${userId}`);
    } else {
      console.log(`[sync-ghl-pipelines] Signed internal caller: ${internal.actorId}`);
    }

    const headers = {
      'Authorization': `Bearer ${apiKey}`,
      'Version': '2021-07-28',
      'Content-Type': 'application/json',
    };

    console.log('Fetching GHL pipelines...');

    // Step 1: Fetch all pipelines from GHL
    const pipelinesResponse = await fetch(
      `${GHL_API_BASE}/opportunities/pipelines?locationId=${locationId}`,
      { headers }
    );

    if (!pipelinesResponse.ok) {
      const errorText = await pipelinesResponse.text();
      console.error(`GHL pipelines API error: ${pipelinesResponse.status} - ${errorText}`);
      throw new Error(`GHL API error: ${pipelinesResponse.status} - ${errorText}`);
    }

    const pipelinesData = await pipelinesResponse.json();
    const ghlPipelines: GHLPipeline[] = pipelinesData.pipelines || [];
    console.log(`Found ${ghlPipelines.length} pipelines from GHL`);

    // Step 2: Sync pipelines to database
    const pipelineIdMap: Record<string, string> = {}; // ghl_id -> supabase uuid
    const stageIdMap: Record<string, { uuid: string; stageName: string; pipelineName: string; pipelineUuid: string; pipelinePosition: number; stagePosition: number }> = {};

    for (let pIdx = 0; pIdx < ghlPipelines.length; pIdx++) {
      const pipeline = ghlPipelines[pIdx];
      
      // Upsert pipeline
      const { data: pipelineData, error: pipelineError } = await supabase
        .from('ghl_pipelines')
        .upsert({
          ghl_id: pipeline.id,
          name: pipeline.name,
          position: pIdx,
          location_id: locationId,
          is_active: true,
          synced_at: new Date().toISOString(),
        }, { onConflict: 'ghl_id' })
        .select('id')
        .single();

      if (pipelineError) {
        console.error(`Error upserting pipeline ${pipeline.name}:`, pipelineError);
        continue;
      }

      const pipelineUuid = pipelineData.id;
      pipelineIdMap[pipeline.id] = pipelineUuid;
      console.log(`Synced pipeline: ${pipeline.name} (${pipeline.id}) -> ${pipelineUuid}`);

      // Upsert stages for this pipeline
      for (const stage of pipeline.stages || []) {
        const colorIndex = stage.position % STAGE_COLORS.length;
        
        const { data: stageData, error: stageError } = await supabase
          .from('ghl_pipeline_stages')
          .upsert({
            ghl_id: stage.id,
            pipeline_id: pipelineUuid,
            name: stage.name,
            position: stage.position,
            color: STAGE_COLORS[colorIndex],
            synced_at: new Date().toISOString(),
          }, { onConflict: 'ghl_id' })
          .select('id')
          .single();

        if (stageError) {
          console.error(`Error upserting stage ${stage.name}:`, stageError);
          continue;
        }

        stageIdMap[stage.id] = {
          uuid: stageData.id,
          stageName: stage.name,
          pipelineName: pipeline.name,
          pipelineUuid: pipelineUuid,
          pipelinePosition: pIdx,
          stagePosition: stage.position,
        };
      }
    }

    console.log(`Synced ${Object.keys(stageIdMap).length} pipeline stages to database`);

    // Purge stale pipelines & stages from previous accounts/locations or removed in GHL.
    // Anything not touched by this run is stale.
    let stalePipelinesDeleted = 0;
    let staleStagesDeleted = 0;
    try {
      const { data: deletedStages } = await supabase
        .from('ghl_pipeline_stages')
        .delete()
        .lt('synced_at', syncRunStartedAt)
        .select('id');
      staleStagesDeleted = deletedStages?.length || 0;

      const { data: deletedPipelines } = await supabase
        .from('ghl_pipelines')
        .delete()
        .lt('synced_at', syncRunStartedAt)
        .select('id');
      stalePipelinesDeleted = deletedPipelines?.length || 0;
      console.log(`Purged ${stalePipelinesDeleted} stale pipelines and ${staleStagesDeleted} stale stages`);
    } catch (e) {
      console.error('Stale pipeline purge failed:', e);
    }

    // Step 3: Fetch all opportunities from GHL - increased limit to ensure all are fetched
    let allOpportunities: GHLOpportunity[] = [];
    let startAfterId: string | null = null;
    let startAfter: number | null = null;
    let pageCount = 0;
    const maxPages = 50; // Increased from 20 to handle more opportunities (up to 5000)

    while (pageCount < maxPages) {
      pageCount++;

      // GHL v2021-07-28 opportunities/search uses GET with query params.
      // POST body validation rejects startAfterId/startAfter as "unknown properties".
      const params = new URLSearchParams({
        location_id: locationId,
        limit: '100',
      });
      if (startAfterId) params.set('startAfterId', startAfterId);
      if (startAfter) params.set('startAfter', String(startAfter));

      const searchUrl = `${GHL_API_BASE}/opportunities/search?${params.toString()}`;
      console.log(`Fetching opportunities page ${pageCount} via GET to ${searchUrl}`);

      const oppResponse = await fetch(searchUrl, {
        method: 'GET',
        headers,
      });

      if (!oppResponse.ok) {
        const errorText = await oppResponse.text();
        console.error(`GHL opportunities SEARCH error: ${oppResponse.status} - ${errorText}`);
        throw new Error(`GHL API error: ${oppResponse.status} - ${errorText}`);
      }

      const oppData: GHLOpportunitiesResponse = await oppResponse.json();
      const opportunities = oppData.opportunities || [];

      console.log(`Received ${opportunities.length} opportunities on page ${pageCount} (meta.total: ${oppData.meta?.total ?? 'n/a'})`);

      if (opportunities.length === 0) break;

      allOpportunities = [...allOpportunities, ...opportunities];

      // Check for pagination (GHL may return either cursor fields or nextPageUrl)
      let advanced = false;

      if (oppData.meta?.nextPageUrl) {
        // Some responses provide a fully qualified URL; others may be relative.
        const nextUrl = oppData.meta.nextPageUrl.startsWith('http')
          ? oppData.meta.nextPageUrl
          : `${GHL_API_BASE}${oppData.meta.nextPageUrl}`;

        startAfterId = null;
        startAfter = null;

        try {
          const parsed = new URL(nextUrl);
          startAfterId = parsed.searchParams.get('startAfterId');
          const startAfterStr = parsed.searchParams.get('startAfter');
          startAfter = startAfterStr ? Number(startAfterStr) : null;
          if (startAfterId || startAfter) advanced = true;
        } catch (_e) {
          advanced = false;
        }
      }

      if (!advanced && oppData.meta?.startAfterId) {
        startAfterId = oppData.meta.startAfterId;
        startAfter = oppData.meta.startAfter || null;
        advanced = true;
      }

      // FALLBACK: GHL sometimes omits pagination metadata even when more pages exist.
      // If we received a full page (>=limit) but no cursor was provided, manually
      // construct cursor from the last opportunity (id + createdAt epoch ms).
      if (!advanced && opportunities.length >= 100) {
        const last = opportunities[opportunities.length - 1];
        const lastCreatedMs = last.createdAt ? new Date(last.createdAt).getTime() : null;
        if (last?.id && lastCreatedMs) {
          startAfterId = last.id;
          startAfter = lastCreatedMs;
          advanced = true;
          console.log(`Pagination meta missing — falling back to manual cursor: startAfterId=${startAfterId}, startAfter=${startAfter}`);
        }
      }

      if (!advanced) break;
      // Stop early if we've collected everything GHL says exists
      if (oppData.meta?.total && allOpportunities.length >= oppData.meta.total) {
        console.log(`Collected ${allOpportunities.length} >= meta.total ${oppData.meta.total}, stopping.`);
        break;
      }
    }

    console.log(`========================================`);
    console.log(`SYNC SUMMARY - OPPORTUNITIES FROM GHL`);
    console.log(`========================================`);
    console.log(`Total opportunities fetched from GHL: ${allOpportunities.length}`);
    console.log(`Pages fetched: ${pageCount}`);
    
    // Count opportunities by pipeline for debugging
    const oppByPipeline: Record<string, number> = {};
    const oppByStage: Record<string, number> = {};
    for (const opp of allOpportunities) {
      const pipelineInfo = pipelineIdMap[opp.pipelineId] ? ghlPipelines.find(p => p.id === opp.pipelineId)?.name : opp.pipelineId;
      const stageInfo = stageIdMap[opp.pipelineStageId];
      const pipelineName = pipelineInfo || 'Unknown Pipeline';
      const stageName = stageInfo?.stageName || 'Unknown Stage';
      
      oppByPipeline[pipelineName] = (oppByPipeline[pipelineName] || 0) + 1;
      oppByStage[`${pipelineName} / ${stageName}`] = (oppByStage[`${pipelineName} / ${stageName}`] || 0) + 1;
    }
    
    console.log(`Opportunities by pipeline:`);
    for (const [pipeline, count] of Object.entries(oppByPipeline)) {
      console.log(`  - ${pipeline}: ${count}`);
    }
    
    console.log(`Opportunities by stage (top 20):`);
    const sortedStages = Object.entries(oppByStage).sort((a, b) => b[1] - a[1]).slice(0, 20);
    for (const [stage, count] of sortedStages) {
      console.log(`  - ${stage}: ${count}`);
    }

    // Step 4: Store ALL opportunities in ghl_client_opportunities table
    // Also track the "best" opportunity per contact for the legacy clients table fields
    const contactBestOpportunity: Record<string, { 
      opp: GHLOpportunity; 
      pipelinePosition: number; 
      stagePosition: number;
    }> = {};

    // Group all opportunities by contact for bulk processing
    const contactAllOpportunities: Record<string, GHLOpportunity[]> = {};

    for (const opp of allOpportunities) {
      const contactId = opp.contact?.id;
      if (!contactId) {
        console.log(`Opportunity ${opp.id} has no contact, skipping`);
        continue;
      }

      // Track all opportunities per contact
      if (!contactAllOpportunities[contactId]) {
        contactAllOpportunities[contactId] = [];
      }
      contactAllOpportunities[contactId].push(opp);

      // Track best opportunity for legacy client table update
      const stageInfo = stageIdMap[opp.pipelineStageId];
      const pipelinePosition = stageInfo?.pipelinePosition ?? -1;
      const stagePosition = stageInfo?.stagePosition ?? -1;

      const existing = contactBestOpportunity[contactId];
      const shouldReplace = !existing || 
        pipelinePosition > existing.pipelinePosition ||
        (pipelinePosition === existing.pipelinePosition && stagePosition > existing.stagePosition);

      if (shouldReplace) {
        contactBestOpportunity[contactId] = { opp, pipelinePosition, stagePosition };
      }
    }

    const uniqueContacts = Object.keys(contactAllOpportunities).length;
    const totalOpps = allOpportunities.length;
    console.log(`========================================`);
    console.log(`OPPORTUNITY MAPPING`);
    console.log(`========================================`);
    console.log(`Total opportunities: ${totalOpps}`);
    console.log(`Unique contacts with opportunities: ${uniqueContacts}`);
    console.log(`========================================`);

    /*
     * Steps 5 and 6, as ONE pass over contacts, under a wall-clock budget.
     *
     * They used to be two loops over the same key set, and each began by
     * finding the client for a contact — step 5 with
     * `.select('id').eq('ghl_contact_id', …).single()`, step 6 with
     * `.update(…).eq('ghl_contact_id', …).select(…).single()`. Every contact
     * in `contactAllOpportunities` has an entry in `contactBestOpportunity`,
     * so that was two sequential round trips per contact to answer one
     * question, on top of one upsert per opportunity.
     *
     * WHAT THAT COST, WHILE THE FUNCTION ANSWERED 200
     *
     * Measured on the NPC Client Dashboard, 13 Sep 2026. The run started at
     * 09:47:00 and `ghl_client_opportunities.synced_at` ran to 09:50:10 —
     * 190 seconds against the 120 this function declares in `config.toml`.
     * It was cut off inside step 5, so step 6 never ran, and step 6 is the
     * ONLY writer of `clients.pipeline_status`, `current_pipeline_id`,
     * `current_stage_id` and `ghl_opportunity_id`. All 500 client rows were
     * left holding their column DEFAULTS — `pipeline_status` reading
     * 'New Lead' on every one of them — while 367 opportunities sat correctly
     * stored beside them.
     *
     * Nothing in the product could see it. The Client Tracker's board places
     * clients from `ghl_client_opportunities`, which was complete, so the
     * stage columns filled correctly; the card badge reads `pipeline_status`,
     * so all 500 cards said "New Lead" anyway; and the Active tab filters
     * `is_favorite`, which had never been written either, so it was empty. A
     * half-finished run and a healthy one are indistinguishable from the
     * response, which is 200 either way.
     *
     * So: one batched lookup serves both writes, and the pass stops on a
     * clock it can see rather than on a timeout it cannot.
     */
    let opportunitiesUpserted = 0;
    let opportunitiesSkipped = 0;
    let updatedCount = 0;
    let notFoundCount = 0;
    const notFoundContacts: string[] = [];
    let contactsProcessed = 0;
    let stoppedEarly = false;
    let cursor: string | null = resumeAfterContactId;

    /*
     * A TOTAL order, so a cursor over it means the same thing on every pass.
     *
     * `Object.keys` is insertion order, which here follows the order GHL
     * happened to return opportunities in — not a property of the data. A
     * resumable cursor over an order that can move between passes skips a
     * contact and visits another twice. `sync-ghl-conversations` records the
     * same lesson about an unordered `select`; this is the in-memory form of
     * it.
     */
    const orderedContactIds = Object.keys(contactAllOpportunities).sort();
    const pending = resumeAfterContactId
      ? orderedContactIds.filter((id) => id > resumeAfterContactId)
      : orderedContactIds;

    console.log(
      `[sync-ghl-pipelines] ${orderedContactIds.length} contacts with opportunities, ` +
        `${pending.length} pending this pass` +
        (resumeAfterContactId ? ` (resuming after ${resumeAfterContactId})` : ''),
    );

    /** One read for up to this many contacts, rather than one `.single()` each. */
    const LOOKUP_CHUNK = 200;

    contactPass:
    for (let i = 0; i < pending.length; i += LOOKUP_CHUNK) {
      const chunk = pending.slice(i, i + LOOKUP_CHUNK);

      const { data: clientRows, error: lookupError } = await supabase
        .from('clients')
        .select('id, ghl_contact_id')
        .in('ghl_contact_id', chunk);

      if (lookupError) {
        /*
         * A read that FAILED is not a set of rows that are ABSENT. Treating it
         * as absence would count every contact in this chunk as "no client",
         * finish the pass, and let the reconciliation below clear the pipeline
         * fields of clients that are perfectly fine. Stop instead, leave the
         * cursor where it is, and let the next pass retry exactly these.
         */
        console.error(`[sync-ghl-pipelines] client lookup failed: ${lookupError.message}`);
        stoppedEarly = true;
        break;
      }

      const clientByContact = new Map<string, string>();
      for (const row of clientRows ?? []) {
        const contactId = (row as Record<string, unknown>).ghl_contact_id;
        const id = (row as Record<string, unknown>).id;
        if (typeof contactId === 'string' && typeof id === 'string') clientByContact.set(contactId, id);
      }

      for (const contactId of chunk) {
        // Asked BEFORE a contact starts, so a contact is never left with its
        // opportunities written and its client row unwritten — which is the
        // exact split this whole change exists to stop.
        if (stop()) {
          stoppedEarly = true;
          break contactPass;
        }

        const opps = contactAllOpportunities[contactId] ?? [];
        const clientId = clientByContact.get(contactId);

        if (!clientId) {
          opportunitiesSkipped += opps.length;
          notFoundCount++;
          const best = contactBestOpportunity[contactId];
          notFoundContacts.push(best?.opp.contact?.name || contactId);
          cursor = contactId;
          contactsProcessed++;
          continue;
        }

        // ── The opportunities themselves ────────────────────────────────
        for (const opp of opps) {
          const stageInfo = stageIdMap[opp.pipelineStageId];

          const oppRecord: Record<string, any> = {
            client_id: clientId,
            ghl_opportunity_id: opp.id,
            ghl_contact_id: contactId,
            pipeline_id: stageInfo?.pipelineUuid || pipelineIdMap[opp.pipelineId] || null,
            stage_id: stageInfo?.uuid || null,
            pipeline_name: stageInfo?.pipelineName || ghlPipelines.find(p => p.id === opp.pipelineId)?.name || null,
            stage_name: stageInfo?.stageName || opp.status || 'Unknown Stage',
            opportunity_status: opp.status || 'open',
            monetary_value: opp.monetaryValue || 0,
            opportunity_name: opp.name || null,
            follow_up_date: opp.followUpDate || null,
            notes: opp.notes || null,
            custom_fields: opp.customFields ? JSON.stringify(opp.customFields) : null,
            ghl_created_at: opp.createdAt || null,
            ghl_updated_at: opp.updatedAt || null,
            synced_at: new Date().toISOString(),
          };

          const { error: upsertError } = await supabase
            .from('ghl_client_opportunities')
            .upsert(oppRecord, { onConflict: 'client_id,ghl_opportunity_id' });

          if (upsertError) {
            console.error(`Error upserting opportunity ${opp.id}:`, upsertError);
          } else {
            opportunitiesUpserted++;
          }
        }

        // ── The client's own pipeline fields, from its BEST opportunity ──
        const best = contactBestOpportunity[contactId];
        if (best) {
          const opp = best.opp;
          const stageInfo = stageIdMap[opp.pipelineStageId];
          const pipelineStatus = stageInfo
            ? stageInfo.stageName
            : opp.status || 'Unknown Stage';

          let borrowingCapacity: number | null = null;
          let proposedRentalIncome: number | null = null;
          let equityRelease: number | null = null;

          if (opp.customFields) {
            for (const field of opp.customFields) {
              const key = (field.key || '').toLowerCase();
              if (key.includes('borrowing') || key.includes('capacity')) {
                borrowingCapacity = parseFloat(field.value) || null;
              } else if (key.includes('rental') || key.includes('income')) {
                proposedRentalIncome = parseFloat(field.value) || null;
              } else if (key.includes('equity') || key.includes('release')) {
                equityRelease = parseFloat(field.value) || null;
              }
            }
          }

          if (!borrowingCapacity && opp.monetaryValue) {
            borrowingCapacity = opp.monetaryValue;
          }

          const updateData: Record<string, any> = {
            pipeline_status: pipelineStatus,
            pipeline_updated_at: new Date().toISOString(),
            ghl_opportunity_id: opp.id,
            opportunity_status: opp.status || 'open',
          };

          if (stageInfo) {
            updateData.current_pipeline_id = stageInfo.pipelineUuid;
            updateData.current_stage_id = stageInfo.uuid;
          } else if (pipelineIdMap[opp.pipelineId]) {
            updateData.current_pipeline_id = pipelineIdMap[opp.pipelineId];
          }

          if (opp.followUpDate) updateData.follow_up_date = opp.followUpDate;
          if (borrowingCapacity) updateData.borrowing_capacity = borrowingCapacity;
          if (proposedRentalIncome) updateData.proposed_rental_income = proposedRentalIncome;
          if (equityRelease) updateData.equity_release = equityRelease;
          if (opp.notes) updateData.pipeline_notes = opp.notes;

          // By `id`, which the lookup above already resolved. The old form
          // matched on `ghl_contact_id` and asked for the row back with
          // `.single()`, so a contact with no client answered PGRST116 and was
          // counted as "not found" a second time.
          const { error: updateError } = await supabase
            .from('clients')
            .update(updateData)
            .eq('id', clientId);

          if (updateError) {
            console.error(`Error updating client for contact ${contactId}:`, updateError);
          } else {
            updatedCount++;
          }
        }

        // Set only once the contact is FULLY written. A cursor that moved
        // before the client update would let a budget stop skip exactly the
        // write this function exists for.
        cursor = contactId;
        contactsProcessed++;
      }
    }

    const hasMore = stoppedEarly;

    console.log(
      `Pipeline sync pass complete. Contacts: ${contactsProcessed}/${pending.length}, ` +
        `Updated: ${updatedCount}, Not found: ${notFoundCount}, ` +
        `Opportunities stored: ${opportunitiesUpserted}, hasMore: ${hasMore}`,
    );

    // Build response with full pipeline structure
    const pipelinesWithStages = ghlPipelines.map(p => ({
      id: pipelineIdMap[p.id] || p.id,
      ghl_id: p.id,
      name: p.name,
      stages: (p.stages || []).map(s => ({
        id: stageIdMap[s.id]?.uuid || s.id,
        ghl_id: s.id,
        name: s.name,
        position: s.position,
        color: STAGE_COLORS[s.position % STAGE_COLORS.length],
      })),
    }));

    /*
     * The two RECONCILIATIONS, and why they wait for the last pass.
     *
     * Both are statements about the whole account — "no GHL opportunity
     * corresponds to this row any more" — so neither can be judged from a
     * pass that has seen part of it. Run on a partial pass they would delete
     * every opportunity this pass had not yet reached and clear the pipeline
     * fields of every client behind the cursor, which is worse than the
     * truncation they would be repairing.
     *
     * They compare against `runStartedAt`, which is the start of the RUN and
     * travels through the resume, not the start of this pass. A pass-local
     * timestamp would make every row the previous pass wrote look stale.
     */
    let staleOpportunitiesDeleted = 0;
    let orphanClientsCleared = 0;

    if (!hasMore) {
      const { data: deleted, error: purgeError } = await supabase
        .from('ghl_client_opportunities')
        .delete()
        .lt('synced_at', runStartedAt)
        .select('id');
      if (purgeError) {
        console.error('Error purging stale opportunities:', purgeError);
      } else {
        staleOpportunitiesDeleted = deleted?.length || 0;
        console.log(`Purged ${staleOpportunitiesDeleted} stale opportunities not present in current GHL account`);
      }

      const { data: orphans, error: orphanErr } = await supabase
        .from('clients')
        .update({
          pipeline_status: null,
          ghl_opportunity_id: null,
          opportunity_status: null,
          current_pipeline_id: null,
          current_stage_id: null,
          pipeline_updated_at: new Date().toISOString(),
        })
        .not('ghl_opportunity_id', 'is', null)
        .not('ghl_opportunity_id', 'in', `(${
          allOpportunities.map(o => `"${o.id}"`).join(',') || '""'
        })`)
        .select('id');
      if (orphanErr) {
        console.error('Error clearing orphan client pipeline fields:', orphanErr);
      } else {
        orphanClientsCleared = orphans?.length || 0;
        console.log(`Cleared pipeline fields on ${orphanClientsCleared} orphan clients`);
      }
    } else {
      console.log('[sync-ghl-pipelines] reconciliation deferred — this pass did not finish the contact list');
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: hasMore
          ? `Pipeline sync in progress — ${contactsProcessed} of ${pending.length} contacts this pass, ` +
            `${opportunitiesUpserted} opportunities stored, ${updatedCount} clients updated. Call again to continue.`
          : `Pipeline sync complete! Synced ${ghlPipelines.length} pipelines, ${opportunitiesUpserted} opportunities stored, ${updatedCount} clients updated, ${staleOpportunitiesDeleted} stale opps purged.`,
        // The caller resumes by sending these two back verbatim. `null` on a
        // finished run, so "there is more" is a fact rather than an inference
        // from a cursor that is always present.
        hasMore,
        nextResumeAfterContactId: hasMore ? cursor : null,
        runStartedAt: hasMore ? runStartedAt : null,
        stats: {
          pipelinesFound: ghlPipelines.length,
          stagesSynced: Object.keys(stageIdMap).length,
          opportunitiesFound: allOpportunities.length,
          opportunitiesStored: opportunitiesUpserted,
          opportunitiesSkippedNoClient: opportunitiesSkipped,
          staleOpportunitiesDeleted,
          orphanClientsCleared,
          clientsUpdated: updatedCount,
          contactsNotFound: notFoundCount,
          contactsProcessed,
          contactsPending: pending.length,
          durationMs: Date.now() - startedAt,
        },
        pipelines: pipelinesWithStages,
        notFoundContacts: notFoundContacts.slice(0, 10),
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );

  } catch (error) {
    console.error('Error in sync-ghl-pipelines:', error);
    return new Response(JSON.stringify({
      ...internalError(error, 'sync-ghl-pipelines'),
      success: false,
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
