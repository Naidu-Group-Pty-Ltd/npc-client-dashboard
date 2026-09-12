/**
 * Builder / Developer Portal — Delivery contract tests.
 *
 * Static contract assertions over the delivery migration, the two new Edge
 * Functions, the shared domain modules and the frontend wiring.
 *
 * The behavioural half — access isolation through the construction case,
 * fail-closed auditing, stale-write rejection, every aggregate's lifecycle and
 * the Finance boundary — is executed against a live PostgreSQL database by
 * `scripts/builder-portal/local-db/verify-delivery.mjs` (115 assertions).
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('../../', import.meta.url).pathname;
const read = (relative) => readFileSync(join(root, relative), 'utf8');

const MIGRATION = '20260807000000_builder_portal_delivery.sql';

const stripSqlComments = (body) => body.replace(/--[^\n]*/g, '');
const stripJsComments = (body) =>
  body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const migrationCode = stripSqlComments(read(join('supabase/migrations', MIGRATION)));
const portalCode = stripJsComments(read('supabase/functions/builder-portal-delivery/index.ts'));
const adminCode = stripJsComments(read('supabase/functions/builder-delivery-admin/index.ts'));
const sharedDomainCode = stripJsComments(read('supabase/functions/_shared/builderDelivery.ts'));

const app = read('src/App.tsx');
const queries = stripJsComments(read('src/lib/builderQueries.ts'));
const domain = stripJsComments(read('src/lib/builderDelivery.ts'));
const detailPage = stripJsComments(read('src/pages/builder/BuilderDeliveryDetail.tsx'));
const adminPanel = stripJsComments(
  read('src/components/admin/builder-portal/AdminBuilderDeliveryPanel.tsx'));
const configToml = read('supabase/config.toml');
const registry = JSON.parse(read('supabase/functions-registry/SECURITY_REGISTRY.json'));
const packageJson = JSON.parse(read('package.json'));

const TABLES = [
  'builder_variations', 'builder_variation_approvals', 'builder_progress_claims',
  'builder_inspections', 'builder_defects', 'builder_practical_completions',
  'builder_handovers', 'builder_warranties', 'builder_warranty_claims',
  'builder_delivery_status_history',
];

const GUARDED_COMMANDS = [
  'builder_upsert_variation', 'builder_upsert_variation_approval',
  'builder_upsert_progress_claim', 'builder_upsert_inspection', 'builder_upsert_defect',
  'builder_upsert_delivery_record', 'builder_upsert_warranty_claim',
  'builder_transition_delivery',
];

const DELIVERY_KINDS = [
  'variation', 'progress_claim', 'inspection', 'defect',
  'practical_completion', 'handover', 'warranty_claim',
];

// ---------------------------------------------------------------------------
// Migration structure
// ---------------------------------------------------------------------------

test('the delivery migration exists and is timestamped after Construction', () => {
  assert.ok(readdirSync(join(root, 'supabase/migrations')).includes(MIGRATION));
  assert.ok(MIGRATION.split('_')[0] > '20260806000000');
});

test('the delivery migration drops no table, column, schema or type', () => {
  const destructive = migrationCode.match(/DROP\s+(TABLE|COLUMN|SCHEMA|TYPE)\b/gi) || [];
  assert.deepEqual(destructive, []);
});

test('every delivery table is created idempotently and RLS-protected', () => {
  for (const table of TABLES) {
    assert.match(migrationCode, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}\\b`),
      `${table} is not created idempotently`);
  }
  assert.match(migrationCode, /ALTER TABLE public\.%I ENABLE ROW LEVEL SECURITY/);
  assert.match(migrationCode, /POST-MIGRATION FAILURE: RLS not enabled on/);
});

test('no delivery policy is written with an unrestricted USING (true)', () => {
  assert.doesNotMatch(migrationCode, /USING\s*\(\s*true\s*\)/i);
  assert.doesNotMatch(migrationCode, /WITH CHECK\s*\(\s*true\s*\)/i);
});

test('every delivery table is revoked from anon and authenticated', () => {
  assert.match(migrationCode, /REVOKE ALL ON public\.%I FROM anon, authenticated/);
  for (const table of TABLES) {
    assert.ok(migrationCode.includes(`'${table}'`), `${table} is missing from the grant loop`);
  }
});

// ---------------------------------------------------------------------------
// The Finance boundary
// ---------------------------------------------------------------------------

test('a progress claim does not take ownership of Finance payment information', () => {
  const table = migrationCode.slice(
    migrationCode.indexOf('CREATE TABLE IF NOT EXISTS public.builder_progress_claims'));
  const body = table.slice(0, table.indexOf('CREATE INDEX'));
  for (const forbidden of ['paid', 'payment_reference', 'receipt', 'remittance', 'commission']) {
    assert.ok(!new RegExp(`\\b\\w*${forbidden}\\w*\\s+(numeric|boolean|text|timestamptz)`, 'i').test(body),
      `a progress claim carries ${forbidden}, which Finance owns`);
  }
  // The one permitted column is a pointer, and it is nullable.
  assert.match(body, /finance_payment_id uuid,/);
  assert.match(migrationCode,
    /POST-MIGRATION FAILURE: a progress claim owns Finance payment information/);
});

test('no quality record carries money at all', () => {
  assert.match(migrationCode, /POST-MIGRATION FAILURE: a quality record carries money/);
  for (const table of ['builder_defects', 'builder_inspections', 'builder_practical_completions',
    'builder_handovers', 'builder_warranties', 'builder_warranty_claims']) {
    const block = migrationCode.slice(
      migrationCode.indexOf(`CREATE TABLE IF NOT EXISTS public.${table}`));
    const body = block.slice(0, block.indexOf('\n);'));
    for (const forbidden of ['amount', 'price', 'cost', 'fee']) {
      assert.ok(!new RegExp(`\\b\\w*${forbidden}\\w*\\s+numeric`, 'i').test(body),
        `${table} carries a ${forbidden} column`);
    }
  }
});

test('a variation carries a customer-facing price but no cost or margin', () => {
  const block = migrationCode.slice(
    migrationCode.indexOf('CREATE TABLE IF NOT EXISTS public.builder_variations'));
  const body = block.slice(0, block.indexOf('\n);'));
  assert.match(body, /variation_price numeric/);
  for (const forbidden of ['cost', 'margin', 'supplier', 'contractor']) {
    assert.ok(!new RegExp(`\\b\\w*${forbidden}\\w*\\s+numeric`, 'i').test(body),
      `a variation carries a ${forbidden} column`);
  }
});

test('neither delivery function reads Finance-owned tables', () => {
  for (const [name, code] of [['portal', portalCode], ['admin', adminCode]]) {
    for (const table of ['build_progress_payments', 'builder_invoices', 'client_financials',
      'client_deals', 'legal_matters', 'aml_', 'commission']) {
      assert.ok(!code.includes(table),
        `the ${name} delivery function references ${table}, which it does not own`);
    }
  }
});

test('neither delivery function uses select("*")', () => {
  for (const [name, code] of [['portal', portalCode], ['admin', adminCode]]) {
    assert.doesNotMatch(code, /\.select\(\s*['"`]\*/,
      `the ${name} delivery function uses an unrestricted select`);
  }
});

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

test('every delivery record is authorised through the construction resolver', () => {
  // There is no new resolver and no new access table: the construction resolver
  // already walks project -> transaction -> membership -> case override.
  assert.ok(!/CREATE OR REPLACE FUNCTION public\.builder_resolve_delivery/.test(migrationCode),
    'a second resolver was introduced for delivery');
  assert.ok(!/CREATE TABLE[^;]*builder_delivery_access/.test(migrationCode),
    'a second access table was introduced for delivery');
  for (const [name, code] of [['portal', portalCode], ['admin', adminCode]]) {
    assert.ok(code.includes('builder_construction_cases'),
      `the ${name} delivery function does not resolve the parent construction case`);
  }
  assert.ok(portalCode.includes('builder_resolve_construction_permission'),
    'the portal delivery function does not call the construction resolver');
});

test('the portal function resolves its session from the cookie and gates governance', () => {
  assert.ok(portalCode.includes('resolveBuilderSession'));
  assert.ok(portalCode.includes('builderGovernanceError'));
  assert.ok(portalCode.includes('enforceCsrf'));
  assert.ok(!portalCode.includes('verifyAuth'),
    'the portal function must not accept a Command Centre staff session');
});

test('the portal function never trusts a browser-supplied organisation id', () => {
  assert.match(portalCode, /session\.active_organisation\?\.organisation_id/);
  assert.ok(!/body\.organisation_id/.test(portalCode));
});

test('a withheld construction case reports not found, never forbidden', () => {
  const loader = portalCode.slice(portalCode.indexOf('const loadCase'));
  const body = loader.slice(0, loader.indexOf('\n    };'));
  assert.match(body, /if \(!parent\.ok\) return \{ ok: false, status: 404, error: 'Construction case not found' \}/);
});

test('every record lookup is scoped to the resolved construction case', () => {
  // This is the check that stops an id aimed at another case — or at another
  // aggregate — from matching anything.
  const owned = portalCode.slice(portalCode.indexOf('const ownedByCase'));
  const body = owned.slice(0, owned.indexOf('\n    };'));
  for (const kind of DELIVERY_KINDS) {
    assert.ok(body.includes(`case '${kind}':`), `ownedByCase does not handle ${kind}`);
  }
  const scoped = body.match(/\.eq\('construction_case_id', caseId\)/g) || [];
  assert.equal(scoped.length, DELIVERY_KINDS.length,
    'every aggregate lookup must be scoped to the resolved case');
  assert.match(portalCode, /if \(!await ownedByCase\(kind, entityId, res\.caseId\)\)/,
    'set_status does not confirm the record belongs to the resolved case');
});

test('each aggregate resolves against its own permission key', () => {
  assert.match(sharedDomainCode, /case 'variation': return 'variations';/);
  assert.match(sharedDomainCode, /case 'progress_claim': return 'progress_claims';/);
  assert.match(sharedDomainCode, /case 'inspection': return 'inspections';/);
  assert.match(sharedDomainCode, /case 'defect': return 'defects';/);
  assert.match(portalCode, /permissionKeyFor\(kind\)/);
});

test('every delivery permission key carries a role baseline', () => {
  assert.match(migrationCode,
    /INSERT INTO public\.builder_role_default_permissions[\s\S]*?'variations'/);
  for (const key of ['progress_claims', 'inspections', 'defects', 'handover']) {
    assert.ok(migrationCode.includes(`'${key}'`), `${key} has no seeded role baseline`);
  }
  assert.match(migrationCode,
    /POST-MIGRATION FAILURE: permission key\(s\) without a role baseline/);
  // read_only must not gain edit through the generated baseline.
  assert.match(migrationCode, /r\.role <> 'read_only'/);
});

test('a child cannot name a parent belonging to another construction case', () => {
  assert.match(migrationCode, /BUILDER_DELIVERY_PARENT_MISMATCH/);
  assert.match(migrationCode,
    /BEFORE INSERT OR UPDATE OF construction_case_id, milestone_id\s*\n\s*ON public\.builder_progress_claims/);
  assert.match(migrationCode,
    /BEFORE INSERT OR UPDATE OF construction_case_id, inspection_id\s*\n\s*ON public\.builder_defects/);
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

test('no delivery Edge Function mutates a domain table directly', () => {
  for (const [name, code] of [['portal', portalCode], ['admin', adminCode]]) {
    for (const verb of ['insert', 'update', 'delete', 'upsert']) {
      assert.doesNotMatch(code, new RegExp(`\\.${verb}\\(`),
        `the ${name} delivery function calls .${verb}() instead of a guarded command`);
    }
  }
});

test('every mutable aggregate enforces expected_version atomically', () => {
  for (const fn of ['builder_upsert_variation', 'builder_upsert_variation_approval',
    'builder_upsert_progress_claim', 'builder_upsert_inspection', 'builder_upsert_defect',
    'builder_upsert_warranty_claim']) {
    const definition = migrationCode.slice(migrationCode.indexOf(`FUNCTION public.${fn}`));
    const body = definition.slice(0, definition.indexOf('END $$'));
    assert.match(body, /_expected_version IS NULL OR .*row_version <> _expected_version/,
      `${fn} does not reject a missing or stale expected_version atomically`);
    assert.match(body, /FOR UPDATE/, `${fn} does not take a row lock`);
  }
  // The three one-per-case records enforce it on every save after the first.
  const record = migrationCode.slice(
    migrationCode.indexOf('FUNCTION public.builder_upsert_delivery_record'));
  const body = record.slice(0, record.indexOf('\nEND $$'));
  const checks = body.match(/_expected_version IS NULL OR v_\w+\.row_version <> _expected_version/g) || [];
  assert.equal(checks.length, 3,
    'practical completion, handover and warranty must each enforce expected_version');
});

test('a missing expected_version is a 400, never the current database value', () => {
  for (const [name, code] of [['portal', portalCode], ['admin', adminCode]]) {
    assert.ok(code.includes('EXPECTED_VERSION_REQUIRED'),
      `the ${name} delivery function does not reject a missing expected_version`);
    assert.ok(!/expected_version:\s*(record|existing|current)\.row_version/.test(code),
      `the ${name} delivery function substitutes the current version for a missing one`);
  }
});

test('the transition command locks the row and checks version and status', () => {
  const definition = migrationCode.slice(
    migrationCode.indexOf('FUNCTION public.builder_transition_delivery'));
  const body = definition.slice(0, definition.indexOf('\nEND $$'));
  const locks = body.match(/FOR UPDATE/g) || [];
  assert.equal(locks.length, DELIVERY_KINDS.length,
    'every aggregate branch must take a row lock');
  assert.match(body, /IF v_version <> _expected_version THEN[\s\S]{0,120}?STALE_VERSION/);
  assert.match(body, /IF v_status <> _from THEN[\s\S]{0,120}?STALE_STATUS/);
  assert.match(body, /REASON_REQUIRED/);
  assert.match(body, /INSERT INTO public\.builder_delivery_status_history/);
});

test('a transition kind cannot be aimed at the wrong table', () => {
  const definition = migrationCode.slice(
    migrationCode.indexOf('FUNCTION public.builder_transition_delivery'));
  const body = definition.slice(0, definition.indexOf('\nEND $$'));
  for (const kind of DELIVERY_KINDS) {
    assert.ok(body.includes(`_kind = '${kind}'`), `the transition command does not handle ${kind}`);
  }
  assert.match(body, /BUILDER_INVALID_DELIVERY_KIND/);
  assert.match(body, /IF v_case IS NULL THEN[\s\S]{0,120}?BUILDER_DELIVERY_NOT_FOUND/);
});

test('every aggregate has a transition allow-list', () => {
  const fn = migrationCode.slice(
    migrationCode.indexOf('FUNCTION public.builder_is_delivery_transition_allowed'));
  const body = fn.slice(0, fn.indexOf('$$;'));
  for (const kind of DELIVERY_KINDS) {
    assert.ok(body.includes(`_kind = '${kind}'`), `${kind} has no transition allow-list`);
  }
  assert.match(body, /WHEN _from = _to THEN false/);
});

test('delivery history is append-only', () => {
  assert.match(migrationCode, /BUILDER_DELIVERY_HISTORY_APPEND_ONLY/);
  assert.match(migrationCode,
    /BEFORE UPDATE OR DELETE ON public\.builder_delivery_status_history/);
});

test('every error code the migration raises is mapped by the shared failure table', () => {
  const raised = new Set(
    (migrationCode.match(/MESSAGE='([A-Z_]+)'/g) || []).map((m) => m.slice(9, -1)));
  raised.delete('BUILDER_DELIVERY_HISTORY_APPEND_ONLY');
  for (const code of raised) {
    assert.ok(sharedDomainCode.includes(`'${code}'`),
      `${code} is raised by the migration but not mapped to an HTTP status`);
  }
});

// ---------------------------------------------------------------------------
// Edge Function contracts
// ---------------------------------------------------------------------------

test('the admin function requires internal auth, the module permission and CSRF', () => {
  assert.ok(adminCode.includes('verifyAuth'));
  assert.ok(adminCode.includes('requireModulePermission'));
  assert.ok(adminCode.includes('enforceCsrf'));
  assert.match(adminCode, /const MODULE_KEY = 'builder_portal_admin'/);
  assert.ok(!adminCode.includes('resolveBuilderSession'),
    'the admin function must not accept a Builder Portal session cookie');
});

test('the admin function never passes the service_role literal to a uuid argument', () => {
  assert.match(adminCode, /auth\.userId === 'service_role'/);
  assert.match(adminCode, /isServiceRoleActor \? null : auth\.userId/);
});

test('read operations require can_view and mutations require can_edit', () => {
  assert.match(adminCode, /READ_OPERATIONS\.has\(operation\) \? 'can_view' : 'can_edit'/);
  const readSet = adminCode.slice(adminCode.indexOf('const READ_OPERATIONS'),
    adminCode.indexOf('function requiredPermFor'));
  for (const mutation of ['upsert_variation', 'upsert_claim', 'upsert_inspection',
    'upsert_defect', 'save_completion', 'set_status']) {
    assert.ok(!readSet.includes(`'${mutation}'`),
      `${mutation} is wrongly classified as a read operation`);
  }
});

test('the cross-project summary is portal-only', () => {
  assert.ok(portalCode.includes("operation === 'delivery_summary'"));
  assert.ok(!adminCode.includes("operation === 'delivery_summary'"),
    'the internal surface must not carry the portal cross-project summary');
});

test('both functions are registered with the correct JWT posture', () => {
  assert.match(configToml, /\[functions\.builder-portal-delivery\]\s*\nverify_jwt = false/);
  assert.match(configToml, /\[functions\.builder-delivery-admin\]\s*\nverify_jwt = true/);
  assert.equal(registry.functions['builder-portal-delivery'].exposure_class, 'portal-authenticated');
  assert.equal(registry.functions['builder-delivery-admin'].exposure_class, 'module-gated');
});

test('both functions are covered by the Deno type check', () => {
  const script = packageJson.scripts['typecheck:builder-edge'];
  assert.ok(script.includes('builder-portal-delivery/index.ts'));
  assert.ok(script.includes('builder-delivery-admin/index.ts'));
});

// ---------------------------------------------------------------------------
// Frontend wiring
// ---------------------------------------------------------------------------

test('the delivery route is inside the Builder portal tree', () => {
  /*
   * WITHDRAWN, NOT UNROUTED. The section is not offered in this portal
   * (`builderHiddenSections.pure.ts`), so the path resolves to the notice
   * instead of the page. The rule this test protects is unchanged and is the
   * reason it still asserts: the path must live INSIDE the Builder portal
   * tree, never in the internal dashboard tree.
   */
  const builderTree = app.slice(app.indexOf('<Route path="/builder/*"'));
  assert.ok(builderTree.includes(
    '<Route path="construction/:constructionCaseId/delivery" element={<BuilderSectionWithdrawn />} />'));
  assert.match(app, /const BuilderDeliveryDetail = lazyWithRetry/);
});

test('the browser never reaches the database directly', () => {
  for (const [name, code] of [['queries', queries], ['detail', detailPage],
    ['admin panel', adminPanel]]) {
    assert.ok(!code.includes('supabase.from('),
      `the ${name} module queries the database directly instead of an Edge Function`);
  }
  assert.ok(queries.includes("invoke('builder-portal-delivery'"));
  assert.ok(adminPanel.includes("'builder-delivery-admin'"));
});

test('delivery queries do not retry a 4xx answer', () => {
  for (const hook of ['useDeliveryList', 'useBuilderVariationApprovals', 'useBuilderCompletion',
    'useBuilderDeliveryHistory', 'useBuilderDeliverySummary']) {
    // `useDeliveryList` is generic, so the name is followed by `<T>` not `(`.
    const definition = queries.slice(queries.indexOf(`function ${hook}`));
    const body = definition.slice(0, definition.indexOf('\n}\n'));
    assert.match(body, /retry: retryBuilderQuery/, `${hook} does not use the shared retry policy`);
  }
});

test('the delivery mutation hook binds the case id so a caller cannot cross cases', () => {
  const definition = queries.slice(queries.indexOf('export function useBuilderDeliveryMutation'));
  const body = definition.slice(0, definition.indexOf('\n}\n'));
  assert.match(body, /\{ \.\.\.payload, construction_case_id: caseId \}/);
});

test('every status change on the detail page carries the loaded version and a reason', () => {
  const block = detailPage.slice(detailPage.indexOf('const changeStatus'));
  const body = block.slice(0, block.indexOf('\n  };'));
  assert.match(body, /expected_version: rowVersion/);
  assert.match(body, /if \(!reason \|\| !reason\.trim\(\)\) return;/);
  assert.match(body, /from_status: fromStatus/);
});

test('the completion save carries the loaded version once the row exists', () => {
  const block = detailPage.slice(detailPage.indexOf('const saveCompletion'));
  const body = block.slice(0, block.indexOf('\n  };'));
  assert.match(body, /expected_version: current\?\.row_version/);
});

test('the frontend transition lists match the database allow-lists', () => {
  for (const kind of DELIVERY_KINDS) {
    assert.ok(domain.includes(`case '${kind}':`), `${kind} has no frontend transition list`);
  }
  assert.match(domain, /if \(from === 'verified'\) return \['closed'\];/);
  assert.match(domain, /if \(from === 'certified'\) return \['closed'\];/);
});

test('the detail page renders loading, empty, error and permission states', () => {
  assert.ok(detailPage.includes('caseQuery.isLoading'));
  assert.ok(detailPage.includes('caseQuery.isError'));
  assert.ok(detailPage.includes('variations.isLoading'));
  assert.ok(detailPage.includes('variations.isError'));
  assert.ok(detailPage.includes('No variations recorded for this build'));
  assert.ok(detailPage.includes('No defects recorded for this build'));
  assert.ok(detailPage.includes("permissions?.[key]?.edit === true"));
});

test('the frontend exposes no payment, receipt, commission or cost', () => {
  for (const [name, code] of [['domain', domain], ['detail', detailPage],
    ['admin panel', adminPanel]]) {
    // Field names, not prose: the pages legitimately SAY that receipt,
    // reconciliation and commission stay with Finance, and `Receipt` is a
    // lucide icon. What must not appear is a field carrying that data.
    assert.doesNotMatch(code,
      /\b(paid_at|payment_reference|receipt_(date|amount|reference)|remittance_\w+|commission_(amount|rate)|build_cost|cost_price|margin_\w+|supplier_price)\b/i,
      `the ${name} module surfaces a field Finance owns`);
  }
});

test('the local-database verification script is wired into package.json', () => {
  assert.equal(packageJson.scripts['builder:db:verify:delivery'],
    'node scripts/builder-portal/local-db/verify-delivery.mjs');
});
