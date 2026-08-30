import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verifyAuth, createCorsHeaders, createUnauthorizedResponse } from '../_shared/auth.ts';

import { enforceCsrf, csrfDenied } from "../_shared/csrfGuard.ts";
import { internalError } from '../_shared/errorResponse.ts';
/**
 * Sync GHL marketing assets (workflows, forms/quizzes/surveys, funnels & pages)
 * into Supabase as a stateful snapshot. Designed for re-ingestion into the new
 * GHL account — stores full raw payloads + structured columns + ID mappings.
 *
 * Triggers:
 *   - Manual: POST { resources?: ['workflows'|'forms'|'funnels'] }
 *   - Cron: every 6h (no body)
 *
 * Auth: Service-to-service (cron) OR authenticated admin call.
 */

const GHL_API_BASE = 'https://services.leadconnectorhq.com';
const GHL_API_VERSION = '2021-07-28';

interface SyncResult {
  resource: string;
  fetched: number;
  upserted: number;
  pages: number;
  errors: string[];
}

async function ghlFetch(path: string, apiKey: string): Promise<Response> {
  return fetch(`${GHL_API_BASE}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Version: GHL_API_VERSION,
      Accept: 'application/json',
    },
  });
}

// ─────────────────────── WORKFLOWS ───────────────────────
async function syncWorkflows(supabase: any, apiKey: string, locationId: string): Promise<SyncResult> {
  const result: SyncResult = { resource: 'workflows', fetched: 0, upserted: 0, pages: 1, errors: [] };
  try {
    const res = await ghlFetch(`/workflows/?locationId=${locationId}`, apiKey);
    if (!res.ok) {
      const txt = await res.text();
      result.errors.push(`HTTP ${res.status}: ${txt.slice(0, 300)}`);
      return result;
    }
    const data = await res.json();
    const workflows: any[] = data.workflows || data.data || [];
    result.fetched = workflows.length;

    for (const wf of workflows) {
      const triggers: any[] = wf.triggers || wf.workflowTriggers || [];
      const triggerSummary = triggers
        .map((t) => t?.type || t?.eventType || t?.name)
        .filter(Boolean)
        .slice(0, 5)
        .join(', ');

      const { error } = await supabase.from('ghl_workflows').upsert(
        {
          ghl_workflow_id: wf.id,
          location_id: locationId,
          name: wf.name || 'Unnamed workflow',
          status: wf.status || (wf.published === true ? 'published' : 'draft'),
          version: wf.version ?? null,
          trigger_summary: triggerSummary || null,
          step_count: Array.isArray(wf.steps) ? wf.steps.length : (wf.stepsCount ?? 0),
          raw_payload: wf,
          last_synced_at: new Date().toISOString(),
        },
        { onConflict: 'ghl_workflow_id' },
      );
      if (error) {
        result.errors.push(`workflow ${wf.id}: ${error.message}`);
      } else {
        result.upserted++;
        await supabase.from('ghl_id_mapping').upsert(
          { resource_type: 'workflow', old_ghl_id: wf.id, source_account_label: 'legacy_ghl' },
          { onConflict: 'resource_type,old_ghl_id', ignoreDuplicates: true },
        );
      }
    }
  } catch (e: any) {
    result.errors.push(`workflows fatal: ${e.message}`);
  }
  return result;
}

// ─────────────────────── FORMS / QUIZZES / SURVEYS ───────────────────────
async function syncFormsLike(
  supabase: any,
  apiKey: string,
  locationId: string,
  endpoint: 'forms' | 'surveys',
  formType: 'form' | 'quiz' | 'survey',
): Promise<SyncResult> {
  const result: SyncResult = { resource: `${endpoint} (${formType})`, fetched: 0, upserted: 0, pages: 0, errors: [] };
  let skip = 0;
  const limit = 100;

  try {
    while (true) {
      result.pages++;
      const res = await ghlFetch(`/${endpoint}/?locationId=${locationId}&limit=${limit}&skip=${skip}`, apiKey);
      if (!res.ok) {
        const txt = await res.text();
        result.errors.push(`page ${result.pages} HTTP ${res.status}: ${txt.slice(0, 300)}`);
        break;
      }
      const data = await res.json();
      const items: any[] = data[endpoint] || data.data || [];
      if (items.length === 0) break;
      result.fetched += items.length;

      for (const item of items) {
        // Quizzes are surveys with a quiz flag in many GHL accounts
        const detectedType =
          formType === 'survey' && (item.isQuiz === true || item.type === 'quiz') ? 'quiz' : formType;
        const fields = item.fields || item.questions || item.formFields || [];

        const { error } = await supabase.from('ghl_forms').upsert(
          {
            ghl_form_id: item.id,
            location_id: locationId,
            name: item.name || 'Untitled',
            form_type: detectedType,
            fields_count: Array.isArray(fields) ? fields.length : 0,
            submission_count: item.submissionCount ?? item.submissions ?? 0,
            raw_payload: item,
            last_synced_at: new Date().toISOString(),
          },
          { onConflict: 'ghl_form_id' },
        );
        if (error) {
          result.errors.push(`form ${item.id}: ${error.message}`);
        } else {
          result.upserted++;
          await supabase.from('ghl_id_mapping').upsert(
            { resource_type: detectedType, old_ghl_id: item.id, source_account_label: 'legacy_ghl' },
            { onConflict: 'resource_type,old_ghl_id', ignoreDuplicates: true },
          );
        }
      }

      if (items.length < limit) break;
      skip += items.length;
      if (skip > 5000) {
        result.errors.push('safety cap 5000 reached');
        break;
      }
    }
  } catch (e: any) {
    result.errors.push(`${endpoint} fatal: ${e.message}`);
  }
  return result;
}

// ─────────────────────── FUNNELS + PAGES ───────────────────────
async function syncFunnels(supabase: any, apiKey: string, locationId: string): Promise<SyncResult> {
  const result: SyncResult = { resource: 'funnels', fetched: 0, upserted: 0, pages: 1, errors: [] };
  try {
    const res = await ghlFetch(`/funnels/funnel/list?locationId=${locationId}`, apiKey);
    if (!res.ok) {
      const txt = await res.text();
      result.errors.push(`HTTP ${res.status}: ${txt.slice(0, 300)}`);
      return result;
    }
    const data = await res.json();
    const funnels: any[] = data.funnels || data.data || [];
    result.fetched = funnels.length;

    for (const fn of funnels) {
      const pages: any[] = fn.steps || fn.pages || [];
      const { data: upserted, error } = await supabase
        .from('ghl_funnels')
        .upsert(
          {
            ghl_funnel_id: fn._id || fn.id,
            location_id: locationId,
            name: fn.name || 'Untitled funnel',
            status: fn.status || (fn.deleted ? 'deleted' : 'active'),
            domain: fn.domain || fn.domainName || null,
            page_count: pages.length,
            raw_payload: fn,
            last_synced_at: new Date().toISOString(),
          },
          { onConflict: 'ghl_funnel_id' },
        )
        .select('id, ghl_funnel_id')
        .single();

      if (error) {
        result.errors.push(`funnel ${fn._id || fn.id}: ${error.message}`);
        continue;
      }
      result.upserted++;
      await supabase.from('ghl_id_mapping').upsert(
        { resource_type: 'funnel', old_ghl_id: upserted.ghl_funnel_id, source_account_label: 'legacy_ghl' },
        { onConflict: 'resource_type,old_ghl_id', ignoreDuplicates: true },
      );

      // Sync child pages
      for (let i = 0; i < pages.length; i++) {
        const pg = pages[i];
        const pageId = pg._id || pg.id;
        if (!pageId) continue;

        const slug = pg.path || pg.slug || pg.url || null;
        const fullUrl = pg.fullUrl || (upserted && fn.domain && slug ? `https://${fn.domain}/${slug}` : null);

        const { error: pgErr } = await supabase.from('ghl_funnel_pages').upsert(
          {
            ghl_page_id: pageId,
            ghl_funnel_id: upserted.ghl_funnel_id,
            funnel_uuid: upserted.id,
            name: pg.name || pg.stepName || `Page ${i + 1}`,
            slug,
            full_url: fullUrl,
            page_type: pg.type || pg.stepType || null,
            position: pg.position ?? i,
            raw_payload: pg,
            last_synced_at: new Date().toISOString(),
          },
          { onConflict: 'ghl_page_id' },
        );
        if (pgErr) {
          result.errors.push(`page ${pageId}: ${pgErr.message}`);
        } else {
          await supabase.from('ghl_id_mapping').upsert(
            { resource_type: 'funnel_page', old_ghl_id: pageId, source_account_label: 'legacy_ghl' },
            { onConflict: 'resource_type,old_ghl_id', ignoreDuplicates: true },
          );
        }
      }
    }
  } catch (e: any) {
    result.errors.push(`funnels fatal: ${e.message}`);
  }
  return result;
}

// ─────────────────────── HANDLER ───────────────────────
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

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      /* empty body = cron */
    }

    // Auth strategy:
    //   - Cron path: pg_cron sends bearer = anon key with empty body (no session token).
    //     We treat this as a privileged cron request.
    //   - Service-role bearer: verifyAuth returns authMethod='service_role'.
    //   - User JWT: must additionally have admin/superadmin role.
    const authHeader = req.headers.get('authorization') || '';
    const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();
    // Public anon key (safe to hardcode — also injected by Supabase runtime, but not always)
    const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRkdXpiY2h1c3d3YmVmZHVuZmN0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU0NDM4NzksImV4cCI6MjA3MTAxOTg3OX0.eSYU6fxIc3tBQuGLsdBRff0alBMkNfvv7OpW0efNjxk';
    const sessionToken = req.headers.get('x-session-token') || body?.session_token;
    const isCronCall = bearer === ANON_KEY && !sessionToken;

    if (!isCronCall) {
      const { error: authError, userId, authMethod } = await verifyAuth(supabase, req.headers, body);
      if (authError) {
        return createUnauthorizedResponse(authError, corsHeaders);
      }

      if (authMethod !== 'service_role') {
        const { data: roles } = await supabase
          .from('user_roles')
          .select('role')
          .eq('user_id', userId)
          .in('role', ['admin', 'superadmin']);
        if (!roles || roles.length === 0) {
          return new Response(JSON.stringify({ success: false, error: 'Admin access required' }), {
            status: 403,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }
    } else {
      console.log('[sync-ghl-marketing-assets] Cron invocation accepted (anon-key bearer, no session)');
    }

    const apiKey = Deno.env.get('GOHIGHLEVEL_API_KEY');
    const locationId = Deno.env.get('GOHIGHLEVEL_LOCATION_ID');
    if (!apiKey || !locationId) {
      return new Response(
        JSON.stringify({ success: false, error: 'Missing GOHIGHLEVEL_API_KEY or GOHIGHLEVEL_LOCATION_ID' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const requested: string[] = Array.isArray(body?.resources) && body.resources.length > 0
      ? body.resources
      : ['workflows', 'forms', 'surveys', 'funnels'];

    const results: SyncResult[] = [];

    if (requested.includes('workflows')) {
      results.push(await syncWorkflows(supabase, apiKey, locationId));
    }
    if (requested.includes('forms')) {
      results.push(await syncFormsLike(supabase, apiKey, locationId, 'forms', 'form'));
    }
    if (requested.includes('surveys')) {
      results.push(await syncFormsLike(supabase, apiKey, locationId, 'surveys', 'survey'));
    }
    if (requested.includes('funnels')) {
      results.push(await syncFunnels(supabase, apiKey, locationId));
    }

    const totalUpserted = results.reduce((s, r) => s + r.upserted, 0);
    const totalErrors = results.reduce((s, r) => s + r.errors.length, 0);

    console.log('[sync-ghl-marketing-assets] complete', {
      totalUpserted,
      totalErrors,
      breakdown: results.map((r) => `${r.resource}: ${r.upserted}/${r.fetched} (${r.errors.length} errs)`),
    });

    return new Response(
      JSON.stringify({
        success: true,
        synced_at: new Date().toISOString(),
        total_upserted: totalUpserted,
        total_errors: totalErrors,
        results,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (e: any) {
    console.error('[sync-ghl-marketing-assets] fatal', e);
    return new Response(JSON.stringify({ ...internalError(e, 'sync-ghl-marketing-assets'), success: false }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
