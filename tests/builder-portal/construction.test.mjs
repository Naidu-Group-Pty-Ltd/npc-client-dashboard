/**
 * Builder / Developer Portal — Construction contract tests.
 *
 * Static contract assertions over the construction migration, the two new Edge
 * Functions, the shared domain modules and the frontend wiring. They run with no
 * database and no network, so they gate every CI run.
 *
 * The behavioural half — access isolation through the parent transaction and
 * project, case-scoped DENY overrides, fail-closed auditing, stale-write
 * rejection, lifecycle transitions and the auditable date history — is executed
 * against a live PostgreSQL database by
 * `scripts/builder-portal/local-db/verify-construction.mjs`, which asserts 110
 * conditions.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('../../', import.meta.url).pathname;
const read = (relative) => readFileSync(join(root, relative), 'utf8');

const MIGRATION = '20260806000000_builder_portal_construction.sql';

const stripSqlComments = (body) => body.replace(/--[^\n]*/g, '');
const stripJsComments = (body) =>
  body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const migrationCode = stripSqlComments(read(join('supabase/migrations', MIGRATION)));
const portalCode = stripJsComments(read('supabase/functions/builder-portal-construction/index.ts'));
const adminCode = stripJsComments(read('supabase/functions/builder-construction-admin/index.ts'));
const sharedDomainCode = stripJsComments(read('supabase/functions/_shared/builderConstruction.ts'));

const app = read('src/App.tsx');
const layout = read('src/components/builder-portal/BuilderPortalLayout.tsx');
const queries = stripJsComments(read('src/lib/builderQueries.ts'));
const domain = stripJsComments(read('src/lib/builderConstruction.ts'));
const listPage = stripJsComments(read('src/pages/builder/BuilderConstruction.tsx'));
const detailPage = stripJsComments(read('src/pages/builder/BuilderConstructionDetail.tsx'));
const adminPanel = stripJsComments(
  read('src/components/admin/builder-portal/AdminBuilderConstructionPanel.tsx'));
const configToml = read('supabase/config.toml');
const registry = JSON.parse(read('supabase/functions-registry/SECURITY_REGISTRY.json'));
const packageJson = JSON.parse(read('package.json'));

const TABLES = [
  'builder_construction_cases', 'builder_construction_stages',
  'builder_construction_milestones', 'builder_construction_progress_updates',
  'builder_construction_photographs', 'builder_construction_status_history',
  'builder_construction_date_history',
];

const GUARDED_COMMANDS = [
  'builder_upsert_construction_case', 'builder_set_construction_date',
  'builder_transition_construction_case', 'builder_upsert_construction_stage',
  'builder_upsert_milestone', 'builder_transition_milestone',
  'builder_add_progress_update', 'builder_add_construction_photograph',
  'builder_delete_construction_photograph',
];

// ---------------------------------------------------------------------------
// Migration structure
// ---------------------------------------------------------------------------

test('the construction migration exists and is timestamped after Transactions', () => {
  assert.ok(readdirSync(join(root, 'supabase/migrations')).includes(MIGRATION));
  assert.ok(MIGRATION.split('_')[0] > '20260805000000');
});

test('the construction migration drops no table, column, schema or type', () => {
  const destructive = migrationCode.match(/DROP\s+(TABLE|COLUMN|SCHEMA|TYPE)\b/gi) || [];
  assert.deepEqual(destructive, []);
});

test('every construction table is created idempotently and RLS-protected', () => {
  for (const table of TABLES) {
    assert.match(migrationCode, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}\\b`),
      `${table} is not created idempotently`);
  }
  assert.match(migrationCode, /ALTER TABLE public\.%I ENABLE ROW LEVEL SECURITY/);
  assert.match(migrationCode, /POST-MIGRATION FAILURE: RLS not enabled on/);
});

test('no construction policy is written with an unrestricted USING (true)', () => {
  assert.doesNotMatch(migrationCode, /USING\s*\(\s*true\s*\)/i);
  assert.doesNotMatch(migrationCode, /WITH CHECK\s*\(\s*true\s*\)/i);
});

test('every construction table is revoked from anon and authenticated', () => {
  assert.match(migrationCode, /REVOKE ALL ON public\.%I FROM anon, authenticated/);
  for (const table of TABLES) {
    assert.ok(migrationCode.includes(`'${table}'`), `${table} is missing from the grant loop`);
  }
});

// ---------------------------------------------------------------------------
// Data boundaries
// ---------------------------------------------------------------------------

test('a milestone carries no amount and no payment flag', () => {
  const table = migrationCode.slice(
    migrationCode.indexOf('CREATE TABLE IF NOT EXISTS public.builder_construction_milestones'));
  const body = table.slice(0, table.indexOf(');'));
  for (const forbidden of ['amount', 'payment', 'claim', 'invoice', 'commission']) {
    assert.ok(!new RegExp(`\\b\\w*${forbidden}\\w*\\s+(numeric|boolean|text|integer)`, 'i').test(body),
      `a milestone carries ${forbidden} information, which Finance owns`);
  }
  assert.match(migrationCode, /POST-MIGRATION FAILURE: a milestone carries payment information/);
});

test('no construction table carries a cost, margin or supplier column', () => {
  const forbidden =
    /\b\w*(cost|margin|supplier|contractor_price|commission)\w*\s+(numeric|text|integer|money)/i;
  assert.doesNotMatch(migrationCode, forbidden);
});

test('neither construction function reads Finance-owned tables', () => {
  for (const [name, code] of [['portal', portalCode], ['admin', adminCode]]) {
    for (const table of ['builder_invoices', 'build_progress_payments', 'client_financials',
      'client_deals', 'legal_matters', 'aml_', 'commission']) {
      assert.ok(!code.includes(table),
        `the ${name} construction function references ${table}, which it does not own`);
    }
  }
});

test('neither construction function uses select("*")', () => {
  for (const [name, code] of [['portal', portalCode], ['admin', adminCode]]) {
    assert.doesNotMatch(code, /\.select\(\s*['"`]\*/,
      `the ${name} construction function uses an unrestricted select`);
  }
});

test('photograph storage paths never leave the server', () => {
  for (const [name, code] of [['portal', portalCode], ['admin', adminCode]]) {
    assert.ok(code.includes('storage_path: _p') || code.includes('storage_path: _path'),
      `the ${name} construction function returns the raw storage path to the browser`);
  }
  // And the frontend type does not declare one.
  assert.ok(!/storage_path/.test(domain),
    'the frontend photograph type declares a storage path');
});

test('a photograph is served through a short-lived signed url, re-checked per request', () => {
  const block = portalCode.slice(portalCode.indexOf("operation === 'photograph_url'"));
  const body = block.slice(0, block.indexOf('expires_in'));
  assert.ok(body.indexOf('loadCase(') > 0,
    'the url operation does not re-resolve the caller access');
  assert.match(body, /createSignedUrl\(photograph\.storage_path, PHOTO_URL_TTL_SECONDS\)/);
  assert.match(portalCode, /const PHOTO_URL_TTL_SECONDS = 300/);
});

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

test('the construction resolver delegates to the project resolver first', () => {
  const resolver = migrationCode.slice(
    migrationCode.indexOf('FUNCTION public.builder_resolve_construction_permission'));
  const body = resolver.slice(0, resolver.indexOf('END $$'));
  const parent = body.indexOf('builder_resolve_project_permission');
  assert.ok(parent > 0, 'the resolver does not consult the parent project at all');
  assert.match(body.slice(parent, parent + 260), /IF NOT v_base THEN RETURN false; END IF;/);
});

test('a denial on the parent transaction denies its construction case', () => {
  const resolver = migrationCode.slice(
    migrationCode.indexOf('FUNCTION public.builder_resolve_construction_permission'));
  const body = resolver.slice(0, resolver.indexOf('END $$'));
  assert.match(body, /builder_resolve_transaction_permission\([\s\S]{0,120}?RETURN false;/,
    'the resolver does not re-check the parent transaction');
});

test('an active membership is a hard requirement in the construction resolver', () => {
  const resolver = migrationCode.slice(
    migrationCode.indexOf('FUNCTION public.builder_resolve_construction_permission'));
  const body = resolver.slice(0, resolver.indexOf('END $$'));
  const gate = body.indexOf('builder_active_membership');
  assert.ok(gate > 0, 'the resolver does not check the membership');
  assert.match(body.slice(gate, gate + 200), /IF v_membership_id IS NULL THEN RETURN false; END IF;/);
  assert.ok(gate < body.indexOf("scope_type = 'construction_case'"),
    'the case-scoped override runs before the membership gate');
});

test('the case-scoped override may only DENY', () => {
  const resolver = migrationCode.slice(
    migrationCode.indexOf('FUNCTION public.builder_resolve_construction_permission'));
  const body = resolver.slice(0, resolver.indexOf('END $$'));
  assert.match(body, /IF v_scoped = 'deny' THEN RETURN false; END IF;/);
  assert.ok(!/v_scoped = 'allow'\s*THEN\s*RETURN true/.test(body));
});

test('BOTH scope gates accept the new construction_case scope', () => {
  assert.match(migrationCode,
    /ADD CONSTRAINT builder_membership_permissions_scope_type_check[\s\S]*?'construction_case'/,
    'the column CHECK does not accept the construction_case scope');
  const guard = migrationCode.slice(
    migrationCode.indexOf('FUNCTION public.builder_guard_permission_scope'));
  const body = guard.slice(0, guard.indexOf('END $$'));
  assert.match(body, /'transaction',\s*'construction_case'/,
    'the trigger guard does not accept the construction_case scope');
  assert.match(body, /scope_type = 'construction_case' AND NOT EXISTS/,
    'a construction_case scope id is not checked against an existing row');
});

test('the construction permission key carries a role baseline', () => {
  assert.match(migrationCode,
    /INSERT INTO public\.builder_role_default_permissions[\s\S]*?'construction'/);
  assert.match(migrationCode,
    /POST-MIGRATION FAILURE: permission key\(s\) without a role baseline: construction/);
});

test('a construction case cannot cross a project or unit boundary', () => {
  assert.match(migrationCode, /BUILDER_CONSTRUCTION_PARENT_MISMATCH/);
  assert.match(migrationCode,
    /BEFORE INSERT OR UPDATE OF transaction_id, project_id, unit_id\s*\n\s*ON public\.builder_construction_cases/);
  assert.match(migrationCode, /BUILDER_MILESTONE_PARENT_MISMATCH/);
  assert.match(migrationCode, /BUILDER_PHOTOGRAPH_PARENT_MISMATCH/);
});

test('one construction case per transaction is enforced by the database', () => {
  assert.match(migrationCode,
    /transaction_id uuid NOT NULL UNIQUE\s*\n\s*REFERENCES public\.builder_transactions/);
});

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

test('every guarded command writes its audit row in its own transaction', () => {
  for (const fn of GUARDED_COMMANDS) {
    const definition = migrationCode.slice(migrationCode.indexOf(`FUNCTION public.${fn}`));
    const body = definition.slice(0, definition.indexOf('END $$'));
    assert.match(body, /PERFORM public\.builder_log_activity\(/,
      `${fn} does not write a trusted audit row in its own transaction`);
  }
});

test('no construction Edge Function mutates a domain table directly', () => {
  for (const [name, code] of [['portal', portalCode], ['admin', adminCode]]) {
    for (const verb of ['insert', 'update', 'delete', 'upsert']) {
      assert.doesNotMatch(code, new RegExp(`\\.${verb}\\(`),
        `the ${name} construction function calls .${verb}() instead of a guarded command`);
    }
  }
});

test('every mutable aggregate enforces expected_version atomically', () => {
  for (const fn of ['builder_upsert_construction_case', 'builder_set_construction_date',
    'builder_upsert_construction_stage', 'builder_upsert_milestone']) {
    const definition = migrationCode.slice(migrationCode.indexOf(`FUNCTION public.${fn}`));
    const body = definition.slice(0, definition.indexOf('END $$'));
    assert.match(body, /_expected_version IS NULL OR .*row_version <> _expected_version/,
      `${fn} does not reject a missing or stale expected_version atomically`);
    assert.match(body, /FOR UPDATE/, `${fn} does not take a row lock`);
  }
});

test('a missing expected_version is a 400, never the current database value', () => {
  for (const [name, code] of [['portal', portalCode], ['admin', adminCode]]) {
    assert.ok(code.includes('EXPECTED_VERSION_REQUIRED'),
      `the ${name} construction function does not reject a missing expected_version`);
    assert.ok(!/expected_version:\s*(record|existing|case)\.row_version/.test(code),
      `the ${name} construction function substitutes the current version for a missing one`);
  }
});

test('every error code the migration raises is mapped by the shared failure table', () => {
  const raised = new Set(
    (migrationCode.match(/MESSAGE='([A-Z_]+)'/g) || []).map((m) => m.slice(9, -1)));
  for (const code of ['BUILDER_CONSTRUCTION_HISTORY_APPEND_ONLY', 'BUILDER_SCOPE_NOT_AVAILABLE',
    'BUILDER_SCOPE_TARGET_NOT_FOUND']) {
    raised.delete(code);
  }
  for (const code of raised) {
    assert.ok(sharedDomainCode.includes(`'${code}'`),
      `${code} is raised by the migration but not mapped to an HTTP status`);
  }
});

test('construction and date history are append-only', () => {
  assert.match(migrationCode, /BUILDER_CONSTRUCTION_HISTORY_APPEND_ONLY/);
  assert.match(migrationCode,
    /BEFORE UPDATE OR DELETE ON public\.builder_construction_status_history/);
  assert.match(migrationCode,
    /BEFORE UPDATE OR DELETE ON public\.builder_construction_date_history/);
});

test('every date change records a reason and its previous value', () => {
  const command = migrationCode.slice(
    migrationCode.indexOf('FUNCTION public.builder_set_construction_date'));
  const body = command.slice(0, command.indexOf('END $$'));
  assert.match(body, /REASON_REQUIRED/, 'a date change without a reason is not refused');
  assert.match(body, /INSERT INTO public\.builder_construction_date_history/);
  assert.match(body, /from_date, to_date, reason/);
  // The reason column itself is NOT NULL and non-empty.
  assert.match(migrationCode, /reason text NOT NULL CHECK \(length\(btrim\(reason\)\) > 0\)/);
});

test('status is not writable through the upsert commands', () => {
  for (const fn of ['builder_upsert_construction_case', 'builder_upsert_milestone']) {
    const command = migrationCode.slice(migrationCode.indexOf(`FUNCTION public.${fn}`));
    const body = command.slice(0, command.indexOf('END $$'));
    const update = body.slice(body.indexOf('UPDATE public.'), body.indexOf('WHERE id = v_existing.id'));
    assert.ok(!/\bstatus\s*=/.test(update),
      `${fn} lets status move without writing history`);
  }
});

// ---------------------------------------------------------------------------
// Edge Function contracts
// ---------------------------------------------------------------------------

test('the portal function resolves its session from the cookie and gates governance', () => {
  assert.ok(portalCode.includes('resolveBuilderSession'));
  assert.ok(portalCode.includes('builderGovernanceError'));
  assert.ok(portalCode.includes('enforceCsrf'));
  assert.ok(!portalCode.includes('verifyAuth'));
});

test('the portal function never trusts a browser-supplied organisation id', () => {
  assert.match(portalCode, /session\.active_organisation\?\.organisation_id/);
  assert.ok(!/body\.organisation_id/.test(portalCode));
});

test('the portal function resolves every case through its parent project', () => {
  const loader = portalCode.slice(portalCode.indexOf('const loadCase'));
  const body = loader.slice(0, loader.indexOf('\n    };'));
  assert.ok(body.indexOf('loadProject') > 0, 'loadCase does not resolve the parent project');
  assert.ok(body.indexOf('builder_resolve_construction_permission') > body.indexOf('loadProject'));
  assert.match(body, /if \(!parent\.ok\) return \{ ok: false, status: 404, error: 'Construction case not found' \}/,
    'a withheld project must report "not found", not "forbidden"');
});

test('a project filter narrows within what is already permitted', () => {
  const occurrences =
    portalCode.match(/accessibleProjectIds\.filter\(\(id\) => id === requestedProjectId\)/g) || [];
  assert.ok(occurrences.length >= 2,
    'every list-style operation must intersect the requested project with the accessible set');
});

test('a milestone id from another case matches no row', () => {
  const block = portalCode.slice(portalCode.indexOf("operation === 'set_milestone_status'"));
  const body = block.slice(0, block.indexOf('const next ='));
  assert.match(body, /\.eq\('construction_case_id', res\.record\.id\)/,
    'the milestone lookup is not scoped to the resolved case');
});

test('the admin function requires internal auth, the module permission and CSRF', () => {
  assert.ok(adminCode.includes('verifyAuth'));
  assert.ok(adminCode.includes('requireModulePermission'));
  assert.ok(adminCode.includes('enforceCsrf'));
  assert.match(adminCode, /const MODULE_KEY = 'builder_portal_admin'/);
  assert.ok(!adminCode.includes('resolveBuilderSession'));
});

test('the admin function never passes the service_role literal to a uuid argument', () => {
  assert.match(adminCode, /auth\.userId === 'service_role'/);
  assert.match(adminCode, /isServiceRoleActor \? null : auth\.userId/);
});

test('read operations require can_view and mutations require can_edit', () => {
  assert.match(adminCode, /READ_OPERATIONS\.has\(operation\) \? 'can_view' : 'can_edit'/);
  const readSet = adminCode.slice(adminCode.indexOf('const READ_OPERATIONS'),
    adminCode.indexOf('function requiredPermFor'));
  for (const mutation of ['create_case', 'update_case', 'set_status', 'set_date',
    'upsert_stage', 'upsert_milestone', 'add_progress', 'delete_photograph']) {
    assert.ok(!readSet.includes(`'${mutation}'`),
      `${mutation} is wrongly classified as a read operation`);
  }
});

test('both functions are registered with the correct JWT posture', () => {
  assert.match(configToml, /\[functions\.builder-portal-construction\]\s*\nverify_jwt = false/);
  assert.match(configToml, /\[functions\.builder-construction-admin\]\s*\nverify_jwt = true/);
  assert.equal(registry.functions['builder-portal-construction'].exposure_class, 'portal-authenticated');
  assert.equal(registry.functions['builder-construction-admin'].exposure_class, 'module-gated');
});

test('both functions are covered by the Deno type check', () => {
  const script = packageJson.scripts['typecheck:builder-edge'];
  assert.ok(script.includes('builder-portal-construction/index.ts'));
  assert.ok(script.includes('builder-construction-admin/index.ts'));
});

// ---------------------------------------------------------------------------
// Frontend wiring
// ---------------------------------------------------------------------------

test('the construction routes are inside the Builder portal tree', () => {
  /*
   * WITHDRAWN, NOT UNROUTED. The section is not offered in this portal
   * (`builderHiddenSections.pure.ts`), so the path resolves to the notice
   * instead of the page. The rule this test protects is unchanged and is the
   * reason it still asserts: the path must live INSIDE the Builder portal
   * tree, never in the internal dashboard tree.
   */
  const builderTree = app.slice(app.indexOf('<Route path="/builder/*"'));
  assert.ok(builderTree.includes('<Route path="construction" element={<BuilderSectionWithdrawn />} />'));
  assert.ok(builderTree.includes(
    '<Route path="construction/:constructionCaseId" element={<BuilderSectionWithdrawn />} />'));
  // The page components stay imported, so re-offering the section is one edit.
  assert.match(app, /const BuilderConstruction = lazyWithRetry/);
  assert.match(app, /const BuilderConstructionDetail = lazyWithRetry/);
});

test('the Construction navigation item is enabled', () => {
  assert.match(layout,
    /\{ to: '\/builder\/construction', label: 'Construction', icon: Hammer, available: true \}/);
});

test('the browser never reaches the database directly', () => {
  for (const [name, code] of [['queries', queries], ['list', listPage],
    ['detail', detailPage], ['admin panel', adminPanel]]) {
    assert.ok(!code.includes('supabase.from('),
      `the ${name} module queries the database directly instead of an Edge Function`);
  }
  assert.ok(queries.includes("invoke('builder-portal-construction'"));
  assert.ok(adminPanel.includes("'builder-construction-admin'"));
});

test('construction queries do not retry a 4xx answer', () => {
  for (const hook of ['useBuilderConstructionCases', 'useBuilderConstructionCase',
    'useBuilderConstructionStats']) {
    const definition = queries.slice(queries.indexOf(`export function ${hook}(`));
    const body = definition.slice(0, definition.indexOf('\n}\n'));
    assert.match(body, /retry: retryBuilderQuery/, `${hook} does not use the shared retry policy`);
  }
});

test('the signed photograph url is never cached by the query layer', () => {
  const definition = queries.slice(queries.indexOf('export async function fetchBuilderPhotographUrl'));
  const body = definition.slice(0, definition.indexOf('\n}\n'));
  assert.ok(!body.includes('useQuery'),
    'the signed url must be fetched per request, not cached');
});

test('the construction mutation hook binds the id so a caller cannot cross records', () => {
  const definition = queries.slice(queries.indexOf('export function useBuilderConstructionMutation'));
  const body = definition.slice(0, definition.indexOf('\n}\n'));
  assert.match(body, /\{ \.\.\.payload, construction_case_id: caseId \}/);
});

test('every construction mutation on the detail page carries expected_version', () => {
  for (const operation of ['update_case', 'set_status', 'set_date']) {
    const call = detailPage.slice(detailPage.indexOf(`operation: '${operation}'`));
    const body = call.slice(0, call.indexOf('});'));
    assert.match(body, /expected_version: record\.row_version/,
      `${operation} does not carry the loaded version`);
  }
});

test('the frontend transition lists match the database allow-lists', () => {
  assert.match(domain, /case 'completed': case 'cancelled': return \[\];/);
  assert.match(domain, /case 'not_started': return \['site_preparation', 'cancelled'\];/);
  assert.match(domain, /case 'achieved': return \[\];/);
});

test('the portal pages render loading, empty, error and permission states', () => {
  assert.ok(listPage.includes('query.isLoading'));
  assert.ok(listPage.includes('query.isError'));
  assert.ok(listPage.includes('No build programmes to show'));
  assert.ok(detailPage.includes('query.isLoading'));
  assert.ok(detailPage.includes('query.isError'));
  assert.ok(detailPage.includes("permissions?.construction?.edit === true"));
  assert.ok(detailPage.includes("permissions?.construction?.delete === true"));
});

test('the frontend exposes no cost, margin, commission or payment amount', () => {
  for (const [name, code] of [['domain', domain], ['list', listPage],
    ['detail', detailPage], ['admin panel', adminPanel]]) {
    assert.doesNotMatch(code,
      /\b(build_cost|cost_price|margin|supplier_price|contractor_price|commission|claim_amount)\b/i,
      `the ${name} module surfaces information the Builder audience must not see`);
  }
});

test('no unbuilt Builder module was introduced', () => {
  for (const forbidden of ['builder_variations', 'builder_progress_claims',
    'builder_inspections', 'builder_defects', 'builder_handovers']) {
    assert.doesNotMatch(migrationCode, new RegExp(`CREATE TABLE[^;]*${forbidden}\\b`),
      `${forbidden} belongs to a later module`);
  }
});

test('the local-database verification script is wired into package.json', () => {
  assert.equal(packageJson.scripts['builder:db:verify:construction'],
    'node scripts/builder-portal/local-db/verify-construction.mjs');
});
