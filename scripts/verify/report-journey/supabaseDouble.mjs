/**
 * A stand-in for the Supabase project, answered from fixtures.
 *
 * The real Investment Compass journey — open the report, edit it, choose a
 * template, preview, generate the client PDF, send it — is driven in a REAL
 * browser against the REAL application. Every request the browser makes to
 * `*.supabase.co` is intercepted at the browser and answered from here, from
 * rows read out of production earlier. Nothing here holds or forges a
 * credential: the "session" is a fixture user the application is told about,
 * and every write the journey makes lands in this process's memory.
 *
 * That is what lets the check run with no login, no network and no side
 * effects, on every change.
 *
 * ## What is answered
 *
 *   custom-auth-verify-v2           a fixture superadmin session
 *   admin-user-management           get_my_permissions → every module
 *   mission-control-balance         a healthy balance (entitlements open)
 *   get-investment-reports          the fixture report (edits persist in memory)
 *   manage-investment-reports       update → merged into the in-memory row
 *   manage-templates                list/get templates, list/upsert/delete selections
 *   manage-global-report-settings   the deployment's settings row
 *   render-template-pdf             LOCAL WeasyPrint on the posted HTML
 *   secure-storage                  upload → remembered; download → served
 *   REST whitelabel_settings        the deployment's branding row
 *
 * Anything else answers an empty success and is LOGGED, so the manifest at
 * the end says exactly what the page asked for that nobody supplied.
 */
import fs from 'node:fs';
import path from 'node:path';

export function loadFixtures(root, reportId) {
  const reportFile = path.join(root, reportId, 'report.json');
  if (!fs.existsSync(reportFile)) {
    throw new Error(`No fixture for report ${reportId} at ${reportFile}. See README.md to populate .verify/fixtures.`);
  }
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  const tplDir = path.join(root, 'templates');
  const templates = fs.readdirSync(tplDir)
    .filter((f) => f.endsWith('.json') && f !== 'index.json')
    .map((f) => JSON.parse(fs.readFileSync(path.join(tplDir, f), 'utf8')));
  const settings = JSON.parse(fs.readFileSync(path.join(root, 'global_report_settings.json'), 'utf8'));
  const whitelabel = JSON.parse(fs.readFileSync(path.join(root, 'whitelabel_settings.json'), 'utf8'));
  const assetsDir = path.join(root, 'assets');
  return { report, templates, settings, whitelabel, assetsDir };
}

const FIXTURE_USER = {
  id: '00000000-0000-4000-8000-00000000c0de',
  username: 'verify.harness',
  role: 'super_admin',
};

/**
 * A token with a JWT's SHAPE and no signature worth anything: the app only
 * decodes it client-side to decide it is signed in with an RLS token (and
 * warns loudly when there is none), and every request it is attached to is
 * answered here. It authenticates nothing anywhere.
 */
/** One client to send the report to — a fixture, not a person. */
const FIXTURE_CLIENT = {
  id: '00000000-0000-4000-8000-0000000c11e7', primary_first_name: 'Verify', primary_surname: 'Client',
  primary_email: 'verify.client@example.invalid', pipeline_status: 'active',
};

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const FIXTURE_ACCESS_TOKEN = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({
  sub: FIXTURE_USER.id, role: 'authenticated', aud: 'authenticated', iss: 'verify-harness',
  exp: Math.floor(Date.now() / 1000) + 6 * 3600,
})}.harness`;

/**
 * Columns `TEMPLATE_COLUMNS` asks for, plus the PostgREST alias
 * `libraryLineage:config->libraryLineage`.
 */
function projectTemplateForList(t) {
  return {
    id: t.id, name: t.name, description: t.description ?? null, report_type: t.report_type,
    engine: t.engine, is_active: t.is_active, is_default: t.is_default, is_draft: t.is_draft,
    scope: t.scope ?? null, variant: t.variant ?? null, tier: t.tier ?? null,
    priority: t.priority ?? 0, updated_at: t.updated_at, thumbnail_url: t.thumbnail_url ?? null,
    libraryLineage: t.config?.libraryLineage ?? null,
  };
}

export function createSupabaseDouble(fixtures, opts = {}) {
  const log = [];
  const state = {
    report: structuredClone(fixtures.report),
    selections: [],          // report_template_selections rows this run wrote
    uploads: new Map(),      // storage path → bytes
    renders: [],             // every render-template-pdf call, with its HTML
    portalReports: [],       // client_portal_reports rows the send flow wrote
    updates: [],             // every manage-investment-reports update payload
  };
  const renderHtml = opts.renderHtml; // async (html) => Uint8Array | null

  const json = (body, status = 200) => ({
    status, contentType: 'application/json', body: JSON.stringify(body),
  });

  async function edge(name, body) {
    switch (name) {
      case 'custom-auth-verify-v2':
        return json({ valid: true, user: FIXTURE_USER, roles: ['superadmin'], access_token: FIXTURE_ACCESS_TOKEN, jwt_unavailable: false });
      case 'custom-auth-logout-v2':
        return json({ success: true });
      case 'admin-user-management':
        if (body?.action === 'get_my_permissions') {
          return json({ success: true, permissions: [{ module_key: 'reports', can_view: true, can_edit: true, can_delete: true }] });
        }
        return json({ success: true });
      case 'mission-control-balance':
        return json({ available: 100000, allowance: 100000, used: 0, reserved: 0, planName: 'Verify', planSlug: 'scale' });
      case 'mission-control-gate':
        return json({ status: 'open' });
      case 'get-investment-reports': {
        if (body?.reportId && body.reportId === state.report.id) {
          return json({ success: true, report: state.report });
        }
        if (body?.familyOf) return json({ success: true, family: null });
        return json({ success: true, reports: [], count: 0 });
      }
      case 'manage-investment-reports': {
        if (body?.action === 'update' && body.reportId === state.report.id) {
          state.updates.push(body.data);
          state.report = {
            ...state.report, ...body.data,
            updated_at: new Date().toISOString(),
            current_version: (state.report.current_version ?? 1),
          };
          return json({ success: true, report: state.report });
        }
        return json({ success: true });
      }
      case 'manage-templates': {
        const { operation, table, recordId, listOptions, data } = body ?? {};
        if (table === 'report_templates') {
          if (operation === 'list') {
            const sel = String(listOptions?.select ?? '');
            const rows = fixtures.templates.filter((t) => t.is_active);
            const records = sel.includes('previewPage')
              ? rows.map((t) => ({ id: t.id, previewPage: t.schema?.pages?.[0] ?? null, previewTokens: t.schema?.tokens ?? {} }))
              : rows.map(projectTemplateForList);
            return json({ success: true, records, count: records.length });
          }
          if (operation === 'get' && recordId) {
            const t = fixtures.templates.find((x) => x.id === recordId);
            return t ? json({ success: true, record: t }) : json({ success: false, error: 'not found' }, 404);
          }
        }
        if (table === 'report_template_selections') {
          if (operation === 'list') return json({ success: true, records: state.selections, count: state.selections.length });
          if (operation === 'upsert' && data) {
            const row = { id: `sel-${data.report_type}`, owner_user_id: FIXTURE_USER.id, ...data, updated_at: new Date().toISOString() };
            state.selections = state.selections.filter((s) => s.report_type !== data.report_type).concat(row);
            return json({ success: true, records: row });
          }
          if (operation === 'delete' && recordId) {
            state.selections = state.selections.filter((s) => s.id !== recordId);
            return json({ success: true });
          }
        }
        if (table === 'template_library_entries' && operation === 'list') return json({ success: true, records: [], count: 0 });
        return json({ success: true, records: [], count: 0 });
      }
      case 'manage-global-report-settings':
        return json(fixtures.settings);
      case 'render-template-pdf': {
        const html = String(body?.html ?? '');
        // The HTML is kept so a run can write it beside the PDF: a geometry
        // defect is diagnosed on the document the engine was handed, and the
        // journey is the only place that document exists.
        const entry = { mode: body?.mode, reportId: body?.reportId ?? null, templateId: body?.templateId ?? null, htmlBytes: html.length, html, at: Date.now() };
        state.renders.push(entry);
        if (!renderHtml) return json({ error: 'no local renderer configured' }, 500);
        const pdf = await renderHtml(html);
        if (!pdf) return json({ error: 'local WeasyPrint failed' }, 500);
        const storagePath = `template-builder/${new Date().toISOString().slice(0, 10)}/${entry.at}-${String(body?.fileName || 'report.pdf')}`;
        state.uploads.set(storagePath, pdf);
        entry.path = storagePath; entry.bytes = pdf.length;
        const url = `data:application/pdf;base64,${Buffer.from(pdf).toString('base64')}`;
        return json({ url, path: storagePath, fileName: body?.fileName, mode: body?.mode, templateId: body?.templateId ?? null, bytes: pdf.length, jobId: `job-${entry.at}` });
      }
      case 'secure-storage': {
        if (body?.action === 'upload' || body?.operation === 'upload') {
          const p = String(body.path ?? body.filePath ?? `upload-${Date.now()}`);
          state.uploads.set(p, Buffer.from(String(body.data ?? body.fileData ?? ''), 'base64'));
          return json({ success: true, data: { path: p, publicUrl: '' } });
        }
        return json({ success: true, data: { publicUrl: '' } });
      }
      case 'log-activity':
      case 'activity-logger':
      case 'log-report-render-event':
        return json({ success: true });
      case 'notifications-feed-v2':
        return json({ success: true, notifications: [] });
      case 'internal-messaging':
        return json({ success: true, threads: [], messages: [], unread: 0 });
      case 'mission-control-plan-change':
        return json({ changes: [] });
      case 'mission-control-feedback-prompt':
        return json({ due: false });
      case 'manage-template-library':
        return json({ success: true, records: [], count: 0 });
      case 'authenticated-data':
        return json({ success: true, data: [], records: [] });
      case 'get-client-data':
        return json({ success: true, clients: [FIXTURE_CLIENT] });
      case 'manage-client-data': {
        if (body?.operation === 'create' && body?.table === 'client_portal_reports') {
          const row = { id: `portal-${Date.now()}`, ...(body.data ?? {}) };
          state.portalReports.push(row);
          return json({ success: true, data: row, record: row });
        }
        return json({ success: true, data: null });
      }
      default:
        return null; // unfulfilled → logged
    }
  }

  async function rest(table, method) {
    if (table === 'whitelabel_settings') return json([fixtures.whitelabel]);
    if (table === 'feature_flags') return json([]);
    return null;
  }

  /** Playwright route handler. */
  async function handle(route, request) {
    const url = new URL(request.url());
    if (process.env.VERIFY_TRACE) console.log(`[route] ${request.method()} ${url.host}${url.pathname.slice(0, 80)}`);
    const method = request.method();
    // The app sends `credentials: 'include'`, and a credentialed request is
    // refused by the browser unless the answer names the exact origin and says
    // credentials are allowed — a `*` here makes every call throw and the app
    // reads that as "session unverifiable" and shows the sign-in form.
    const origin = request.headers()['origin'] ?? 'http://127.0.0.1:5173';
    const cors = {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type, x-correlation-id, x-step-up-token',
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'access-control-expose-headers': 'x-correlation-id, content-range',
    };
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const host = url.hostname;
    let answer = null; let kind = 'external';
    if (host.endsWith('.supabase.co')) {
      const fn = url.pathname.match(/\/functions\/v1\/([^/]+)/)?.[1];
      const table = url.pathname.match(/\/rest\/v1\/([^/?]+)/)?.[1];
      let body = null;
      if (fn) { try { body = request.postDataJSON(); } catch { body = null; } }
      if (fn) { kind = `fn:${fn}`; answer = await edge(fn, body); }
      else if (table) { kind = `rest:${table}`; answer = await rest(table, method); }
      else if (url.pathname.includes('/storage/v1/object/')) {
        kind = 'storage';
        const p = decodeURIComponent(url.pathname.split('/object/')[1] ?? '');
        for (const [k, v] of state.uploads) if (p.endsWith(k)) { answer = { status: 200, contentType: 'application/pdf', body: Buffer.from(v) }; break; }
        if (!answer && fixtures.assetsDir) {
          const which = p.includes('615db046') ? 'reportMono.png' : 'report.png';
          const f = path.join(fixtures.assetsDir, which);
          if (fs.existsSync(f)) answer = { status: 200, contentType: 'image/png', body: fs.readFileSync(f) };
        }
      }
      else if (url.pathname.includes('/realtime/')) { kind = 'realtime'; answer = { status: 204, body: '' }; }
    } else if (host === 'challenges.cloudflare.com') {
      kind = 'turnstile'; answer = { status: 204, body: '' };
    } else if (host === '127.0.0.1' || host === 'localhost') {
      return route.continue();
    }
    log.push({ kind, method, url: url.pathname.slice(0, 120), fulfilled: !!answer });
    if (!answer) {
      // Unknown: answer an empty success so the page does not hang, and record it.
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}', headers: cors });
    }
    return route.fulfill({ status: answer.status, contentType: answer.contentType, body: answer.body, headers: cors });
  }

  return { handle, state, log };
}
