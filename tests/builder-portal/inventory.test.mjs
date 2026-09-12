/**
 * Builder / Developer Portal — Inventory contract tests.
 *
 * Static contract assertions over the inventory migration, the two new Edge
 * Functions, the shared domain modules and the frontend wiring. They run with no
 * database and no network, so they gate every CI run.
 *
 * The behavioural half — access isolation through the parent project, scoped
 * DENY overrides, fail-closed auditing, stale-write rejection, status
 * transitions — is executed against a live PostgreSQL database by
 * `scripts/builder-portal/local-db/verify-inventory.mjs`, which asserts 136
 * conditions. These tests assert the shape that verification depends on, so a
 * change that would invalidate it fails here first.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('../../', import.meta.url).pathname;
const read = (relative) => readFileSync(join(root, relative), 'utf8');

const MIGRATION = '20260804000000_builder_portal_inventory.sql';

const stripSqlComments = (body) => body.replace(/--[^\n]*/g, '');
const stripJsComments = (body) =>
  body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const migrationSql = read(join('supabase/migrations', MIGRATION));
const migrationCode = stripSqlComments(migrationSql);

const portalFn = read('supabase/functions/builder-portal-inventory/index.ts');
const portalCode = stripJsComments(portalFn);
const adminFn = read('supabase/functions/builder-inventory-admin/index.ts');
const adminCode = stripJsComments(adminFn);
const sharedDomain = read('supabase/functions/_shared/builderInventory.ts');
const sharedDomainCode = stripJsComments(sharedDomain);

const app = read('src/App.tsx');
const layout = read('src/components/builder-portal/BuilderPortalLayout.tsx');
const queries = stripJsComments(read('src/lib/builderQueries.ts'));
const domain = stripJsComments(read('src/lib/builderInventory.ts'));
const listPage = stripJsComments(read('src/pages/builder/BuilderInventory.tsx'));
const detailPage = stripJsComments(read('src/pages/builder/BuilderUnitDetail.tsx'));
const adminPanel = stripJsComments(
  read('src/components/admin/builder-portal/AdminBuilderInventoryPanel.tsx'));
const configToml = read('supabase/config.toml');
const registry = JSON.parse(read('supabase/functions-registry/SECURITY_REGISTRY.json'));
const packageJson = JSON.parse(read('package.json'));

const INVENTORY_TABLES = [
  'builder_stages', 'builder_buildings', 'builder_lots', 'builder_units',
  'builder_unit_pricing', 'builder_unit_holds', 'builder_reservations',
  'builder_allocations', 'builder_unit_status_history', 'builder_reservation_status_history',
];

const GUARDED_COMMANDS = [
  'builder_upsert_stage', 'builder_upsert_building', 'builder_upsert_lot', 'builder_upsert_unit',
  'builder_transition_unit_availability', 'builder_transition_unit_release',
  'builder_set_unit_price', 'builder_create_unit_hold', 'builder_release_unit_hold',
  'builder_create_reservation', 'builder_transition_reservation',
  'builder_create_allocation', 'builder_release_allocation',
];

// ---------------------------------------------------------------------------
// Migration structure
// ---------------------------------------------------------------------------

test('the inventory migration exists and is timestamped after Phase 3', () => {
  assert.ok(readdirSync(join(root, 'supabase/migrations')).includes(MIGRATION));
  assert.ok(MIGRATION.split('_')[0] > '20260803000000');
});

test('the inventory migration is additive — it drops no existing object', () => {
  // Trigger and constraint replacement is idempotent re-creation, not removal.
  const destructive = migrationCode.match(/DROP\s+(TABLE|COLUMN|SCHEMA|TYPE)\b/gi) || [];
  assert.deepEqual(destructive, [],
    `the inventory migration must not drop existing objects, found: ${destructive.join(', ')}`);
});

test('every inventory table is created idempotently and RLS-protected', () => {
  for (const table of INVENTORY_TABLES) {
    assert.match(migrationCode, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}\\b`),
      `${table} is not created idempotently`);
  }
  // RLS is enabled by a loop over the same table list, and a post-migration
  // assertion fails the migration if any of them is left unprotected.
  assert.match(migrationCode, /ALTER TABLE public\.%I ENABLE ROW LEVEL SECURITY/);
  assert.match(migrationCode, /POST-MIGRATION FAILURE: RLS not enabled on/);
});

test('no inventory policy is written with an unrestricted USING (true)', () => {
  assert.doesNotMatch(migrationCode, /USING\s*\(\s*true\s*\)/i);
  assert.doesNotMatch(migrationCode, /WITH CHECK\s*\(\s*true\s*\)/i);
});

test('every inventory table is revoked from anon and authenticated', () => {
  assert.match(migrationCode, /REVOKE ALL ON public\.%I FROM anon, authenticated/);
  for (const table of INVENTORY_TABLES) {
    assert.ok(migrationCode.includes(`'${table}'`), `${table} is missing from the grant loop`);
  }
});

// ---------------------------------------------------------------------------
// Data boundaries
// ---------------------------------------------------------------------------

test('no inventory table carries a cost, margin or supplier price column', () => {
  const forbidden = /\b\w*(cost|margin|supplier|contractor_price)\w*\s+(numeric|text|integer|money)/i;
  assert.doesNotMatch(migrationCode, forbidden,
    'a build cost, margin, supplier or contractor price column was introduced');
  // And the migration asserts it at apply time rather than only by convention.
  assert.match(migrationCode, /%cost%/);
  assert.match(migrationCode, /%margin%/);
  assert.match(migrationCode, /%supplier%/);
  assert.match(migrationCode, /%contractor_price%/);
});

test('neither inventory function reads Finance-owned payment tables', () => {
  for (const [name, code] of [['portal', portalCode], ['admin', adminCode]]) {
    for (const table of ['builder_invoices', 'build_progress_payments', 'client_financials',
      'aml_', 'commission']) {
      assert.ok(!code.includes(table),
        `the ${name} inventory function references ${table}, which it does not own`);
    }
  }
});

test('neither inventory function uses select("*")', () => {
  for (const [name, code] of [['portal', portalCode], ['admin', adminCode]]) {
    assert.doesNotMatch(code, /\.select\(\s*['"`]\*/,
      `the ${name} inventory function uses an unrestricted select`);
  }
});

test('the shared domain module exposes explicit allow-listed select lists', () => {
  for (const constant of ['BUILDER_UNIT_PORTAL_LIST_SELECT', 'BUILDER_UNIT_PORTAL_DETAIL_SELECT',
    'BUILDER_UNIT_COMMAND_CENTRE_SELECT', 'BUILDER_STAGE_SELECT', 'BUILDER_BUILDING_SELECT',
    'BUILDER_LOT_SELECT', 'BUILDER_PRICING_SELECT', 'BUILDER_HOLD_SELECT',
    'BUILDER_RESERVATION_SELECT', 'BUILDER_ALLOCATION_SELECT']) {
    assert.ok(sharedDomainCode.includes(`export const ${constant}`),
      `${constant} is missing from the shared domain module`);
  }
  assert.doesNotMatch(sharedDomainCode, /cost|margin|supplier_price|contractor_price/i);
});

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

test('the unit resolver delegates to the project resolver first', () => {
  const resolver = migrationCode.slice(
    migrationCode.indexOf('FUNCTION public.builder_resolve_unit_permission'));
  const body = resolver.slice(0, resolver.indexOf('END $$'));
  const parent = body.indexOf('builder_resolve_project_permission');
  assert.ok(parent > 0, 'the unit resolver does not consult the parent project at all');
  assert.match(body.slice(parent, parent + 260), /IF NOT v_base THEN RETURN false; END IF;/,
    'a project denial does not immediately deny the unit');
});

test('an active membership is a hard requirement in the unit resolver', () => {
  const resolver = migrationCode.slice(
    migrationCode.indexOf('FUNCTION public.builder_resolve_unit_permission'));
  const body = resolver.slice(0, resolver.indexOf('END $$'));
  const gate = body.indexOf('builder_active_membership');
  assert.ok(gate > 0, 'the unit resolver does not check the membership');
  assert.match(body.slice(gate, gate + 200), /IF v_membership_id IS NULL THEN RETURN false; END IF;/,
    'a missing membership does not return false immediately');
  // Every scoped override must run AFTER the gate.
  assert.ok(gate < body.indexOf("scope_type = 'stage'"),
    'the stage-scoped override runs before the membership gate');
  assert.ok(gate < body.indexOf("scope_type = 'unit'"),
    'the unit-scoped override runs before the membership gate');
});

test('stage-scoped and unit-scoped overrides may only DENY', () => {
  const resolver = migrationCode.slice(
    migrationCode.indexOf('FUNCTION public.builder_resolve_unit_permission'));
  const body = resolver.slice(0, resolver.indexOf('END $$'));
  const denials = body.match(/IF v_scoped = 'deny' THEN RETURN false; END IF;/g) || [];
  assert.equal(denials.length, 2, 'both scoped overrides must be deny-only');
  assert.ok(!/v_scoped = 'allow'\s*THEN\s*RETURN true/.test(body),
    'a narrower scope must never be able to grant what the parent withheld');
});

test('the new stage and unit scopes are accepted by the database scope guard', () => {
  const guard = migrationCode.slice(migrationCode.indexOf('FUNCTION public.builder_guard_permission_scope'));
  const body = guard.slice(0, guard.indexOf('END $$'));
  assert.match(body, /'organisation',\s*'project',\s*'stage',\s*'unit'/,
    'the scope guard does not accept the stage and unit scopes');
  // A scope id must name a row that actually exists.
  assert.match(body, /BUILDER_SCOPE_TARGET_NOT_FOUND/);
});

test('the inventory and pricing permission keys carry a role baseline', () => {
  // Without seeded defaults every valid grant resolves false and the module is
  // unusable — the defect Phase 3 hit with the projects key.
  for (const key of ['inventory', 'pricing', 'reservations']) {
    assert.match(migrationCode,
      new RegExp(`INSERT INTO public\\.builder_role_default_permissions[\\s\\S]*?'${key}'`),
      `the ${key} permission key has no seeded role baseline`);
  }
  assert.match(migrationCode, /POST-MIGRATION FAILURE: permission key\(s\) without a role baseline/);
});

test('a child cannot name a parent belonging to another project', () => {
  assert.match(migrationCode, /BUILDER_UNIT_PARENT_MISMATCH/);
  assert.match(migrationCode, /BUILDER_STAGE_PARENT_MISMATCH/);
  assert.match(migrationCode,
    /BEFORE INSERT OR UPDATE OF project_id, stage_id, building_id, lot_id\s*\n\s*ON public\.builder_units/);
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

test('no inventory Edge Function mutates a domain table directly', () => {
  for (const [name, code] of [['portal', portalCode], ['admin', adminCode]]) {
    for (const verb of ['insert', 'update', 'delete', 'upsert']) {
      assert.doesNotMatch(code, new RegExp(`\\.${verb}\\(`),
        `the ${name} inventory function calls .${verb}() instead of a guarded command`);
    }
  }
});

test('every mutable aggregate enforces expected_version', () => {
  for (const fn of ['builder_upsert_stage', 'builder_upsert_building', 'builder_upsert_lot',
    'builder_upsert_unit', 'builder_release_unit_hold', 'builder_release_allocation']) {
    const definition = migrationCode.slice(migrationCode.indexOf(`FUNCTION public.${fn}`));
    const body = definition.slice(0, definition.indexOf('END $$'));
    assert.match(body, /_expected_version IS NULL OR .*row_version <> _expected_version/,
      `${fn} does not reject a missing or stale expected_version atomically`);
    assert.match(body, /BUILDER_STALE_WRITE/);
  }
});

test('a missing expected_version is a 400, never the current database value', () => {
  for (const [name, code] of [['portal', portalCode], ['admin', adminCode]]) {
    assert.ok(code.includes('EXPECTED_VERSION_REQUIRED'),
      `the ${name} inventory function does not reject a missing expected_version`);
    assert.ok(!/expected_version:\s*(unit|record|existing)\.row_version/.test(code),
      `the ${name} inventory function substitutes the current version for a missing one`);
  }
});

test('a stale expected_version maps to HTTP 409', () => {
  assert.match(sharedDomainCode, /\['BUILDER_STALE_WRITE', \{ status: 409/);
  assert.match(sharedDomainCode, /\['STALE_VERSION', \{ status: 409/);
  assert.match(sharedDomainCode, /\['STALE_STATUS', \{ status: 409/);
});

test('every error code the migration raises is mapped by the shared failure table', () => {
  const raised = new Set(
    (migrationCode.match(/MESSAGE='([A-Z_]+)'/g) || []).map((m) => m.slice(9, -1)));
  // Append-only history is a trigger guard, not a command outcome.
  raised.delete('BUILDER_INVENTORY_HISTORY_APPEND_ONLY');
  raised.delete('BUILDER_SCOPE_NOT_AVAILABLE');
  raised.delete('BUILDER_SCOPE_TARGET_NOT_FOUND');
  for (const code of raised) {
    assert.ok(sharedDomainCode.includes(`'${code}'`),
      `${code} is raised by the migration but not mapped to an HTTP status`);
  }
});

test('inventory status history is append-only', () => {
  assert.match(migrationCode, /BUILDER_INVENTORY_HISTORY_APPEND_ONLY/);
  assert.match(migrationCode, /BEFORE UPDATE OR DELETE ON public\.builder_unit_status_history/);
  assert.match(migrationCode, /BEFORE UPDATE OR DELETE ON public\.builder_reservation_status_history/);
});

test('a unit cannot be released without a current price', () => {
  const definition = migrationCode.slice(
    migrationCode.indexOf('FUNCTION public.builder_transition_unit_release'));
  const body = definition.slice(0, definition.indexOf('END $$'));
  assert.match(body, /BUILDER_UNIT_PRICE_REQUIRED/);
});

test('one active hold, reservation and allocation per unit is enforced by the database', () => {
  assert.match(migrationCode, /builder_unit_holds_one_active[\s\S]*?WHERE status = 'active'/);
  assert.match(migrationCode, /builder_reservations_one_active[\s\S]*?WHERE status = 'active'/);
  assert.match(migrationCode, /builder_allocations_one_active[\s\S]*?WHERE status = 'active'/);
  assert.match(migrationCode, /builder_unit_pricing_one_current[\s\S]*?WHERE is_current/);
});

// ---------------------------------------------------------------------------
// Edge Function contracts
// ---------------------------------------------------------------------------

test('the portal function resolves its session from the cookie and gates governance', () => {
  assert.ok(portalCode.includes('resolveBuilderSession'));
  assert.ok(portalCode.includes('builderGovernanceError'));
  assert.ok(portalCode.includes('enforceCsrf'));
  assert.ok(!portalCode.includes('verifyAuth'),
    'the portal function must not accept a Command Centre staff session');
});

test('the portal function never trusts a browser-supplied organisation id', () => {
  assert.match(portalCode, /session\.active_organisation\?\.organisation_id/);
  assert.ok(!/body\.organisation_id/.test(portalCode),
    'the portal function reads an organisation id from the request body');
  // Holds and reservations are created for the SESSION organisation.
  assert.match(portalCode, /_organisation_id: activeOrganisationId/);
});

test('the portal function resolves every unit through its parent project', () => {
  const loader = portalCode.slice(portalCode.indexOf('const loadUnit'));
  const body = loader.slice(0, loader.indexOf('\n    };'));
  assert.ok(body.indexOf('loadProject') > 0, 'loadUnit does not resolve the parent project');
  assert.ok(body.indexOf('builder_resolve_unit_permission') > body.indexOf('loadProject'),
    'the unit resolver must run after the parent project check, not instead of it');
  assert.match(body, /if \(!parent\.ok\) return \{ ok: false, status: 404, error: 'Unit not found' \}/,
    'a withheld project must report "not found", not "forbidden"');
});

test('a project filter narrows within what is already permitted', () => {
  assert.match(portalCode, /accessibleProjectIds\.filter\(\(id\) => id === requestedProjectId\)/,
    'the project filter is not intersected with the accessible set');
});

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
  for (const operation of ['list_units', 'get_unit', 'list_stages']) {
    assert.ok(adminCode.includes(`'${operation}'`), `${operation} is missing from the read set`);
  }
  for (const mutation of ['create_unit', 'update_unit', 'set_price', 'set_availability']) {
    assert.ok(!new RegExp(`READ_OPERATIONS[\\s\\S]{0,400}'${mutation}'`).test(adminCode),
      `${mutation} is wrongly classified as a read operation`);
  }
});

test('both functions are registered with the correct JWT posture', () => {
  assert.match(configToml, /\[functions\.builder-portal-inventory\]\s*\nverify_jwt = false/);
  assert.match(configToml, /\[functions\.builder-inventory-admin\]\s*\nverify_jwt = true/);
  assert.equal(registry.functions['builder-portal-inventory'].exposure_class, 'portal-authenticated');
  assert.equal(registry.functions['builder-portal-inventory'].verify_jwt, false);
  assert.equal(registry.functions['builder-inventory-admin'].exposure_class, 'module-gated');
  assert.equal(registry.functions['builder-inventory-admin'].verify_jwt, true);
});

test('both functions are covered by the Deno type check', () => {
  const script = packageJson.scripts['typecheck:builder-edge'];
  assert.ok(script.includes('builder-portal-inventory/index.ts'));
  assert.ok(script.includes('builder-inventory-admin/index.ts'));
});

// ---------------------------------------------------------------------------
// Frontend wiring
// ---------------------------------------------------------------------------

test('the inventory routes are inside the Builder portal tree, not the dashboard', () => {
  /*
   * WITHDRAWN, NOT UNROUTED. The section is not offered in this portal
   * (`builderHiddenSections.pure.ts`), so the path resolves to the notice
   * instead of the page. The rule this test protects is unchanged and is the
   * reason it still asserts: the path must live INSIDE the Builder portal
   * tree, never in the internal dashboard tree.
   */
  const builderTree = app.slice(app.indexOf('<Route path="/builder/*"'));
  assert.ok(builderTree.includes('<Route path="inventory" element={<BuilderSectionWithdrawn />} />'));
  assert.ok(builderTree.includes('<Route path="inventory/:unitId" element={<BuilderSectionWithdrawn />} />'));
  // And nothing outside the portal tree links to them — the guard that
  // matters most here, and it is untouched by the withdrawal.
  const beforeTree = app.slice(0, app.indexOf('<Route path="/builder/*"'));
  assert.ok(!beforeTree.includes('BuilderInventory />'));
  assert.match(app, /const BuilderInventory = lazyWithRetry/);
});

test('the Inventory navigation item is enabled', () => {
  assert.match(layout, /\{ to: '\/builder\/inventory', label: 'Inventory', icon: Boxes, available: true \}/);
});

test('the browser never reaches the database directly', () => {
  for (const [name, code] of [['queries', queries], ['list', listPage],
    ['detail', detailPage], ['admin panel', adminPanel]]) {
    assert.ok(!code.includes('supabase.from('),
      `the ${name} module queries the database directly instead of an Edge Function`);
  }
  assert.ok(queries.includes("invoke('builder-portal-inventory'"));
  assert.ok(adminPanel.includes("invokeSecureFunction(\n      'builder-inventory-admin'")
    || adminPanel.includes("'builder-inventory-admin'"));
});

test('inventory queries do not retry a 4xx answer', () => {
  for (const hook of ['useBuilderUnits', 'useBuilderUnit', 'useBuilderInventoryStats',
    'useBuilderStages']) {
    const definition = queries.slice(queries.indexOf(`export function ${hook}`));
    const body = definition.slice(0, definition.indexOf('\n}\n'));
    assert.match(body, /retry: retryBuilderQuery/, `${hook} does not use the shared retry policy`);
  }
});

test('the unit mutation hook binds the unit id so a caller cannot cross units', () => {
  const definition = queries.slice(queries.indexOf('export function useBuilderUnitMutation'));
  const body = definition.slice(0, definition.indexOf('\n}\n'));
  assert.match(body, /\{ \.\.\.payload, unit_id: unitId \}/,
    'the unit id must be bound by the hook, not supplied per call');
});

test('every unit mutation on the detail page carries expected_version', () => {
  for (const operation of ['update_unit', 'set_availability', 'set_release']) {
    const call = detailPage.slice(detailPage.indexOf(`operation: '${operation}'`));
    const body = call.slice(0, call.indexOf('});'));
    assert.match(body, /expected_version: unit\.row_version/,
      `${operation} does not carry the loaded version`);
  }
});

test('the frontend transition lists match the database allow-lists', () => {
  // Availability: the database refuses anything else, but the UI must not offer
  // a transition the server will reject.
  assert.match(domain, /case 'settled': return \[\];/);
  assert.match(domain, /case 'available': return \['on_hold', 'reserved', 'withdrawn'\];/);
  assert.match(domain, /case 'contracted': return \['settled', 'available'\];/);
  // Reservations move only out of 'active'.
  assert.match(domain,
    /return from === 'active' \? \['contracted', 'cancelled', 'expired', 'lapsed'\] : \[\];/);
});

test('the portal pages render loading, empty, error and permission states', () => {
  assert.ok(listPage.includes('query.isLoading'));
  assert.ok(listPage.includes('query.isError'));
  assert.ok(listPage.includes('No units to show'));
  assert.ok(detailPage.includes('query.isLoading'));
  assert.ok(detailPage.includes('query.isError'));
  assert.ok(detailPage.includes("permissions?.inventory?.edit === true"));
  assert.ok(detailPage.includes("permissions?.pricing?.edit === true"));
  assert.ok(detailPage.includes("permissions?.reservations?.view === true"));
});

test('the frontend exposes no cost, margin or supplier price', () => {
  for (const [name, code] of [['domain', domain], ['list', listPage],
    ['detail', detailPage], ['admin panel', adminPanel]]) {
    assert.doesNotMatch(code, /\b(build_cost|cost_price|margin|supplier_price|contractor_price)\b/i,
      `the ${name} module surfaces internal Builder commercial information`);
  }
});

test('no later-phase Builder module was introduced', () => {
  for (const forbidden of ['builder_transactions', 'builder_construction_cases', 'builder_variations',
    'builder_progress_claims', 'builder_inspections', 'builder_defects', 'builder_handovers',
    'builder_warranty_claims']) {
    assert.doesNotMatch(migrationCode, new RegExp(`CREATE TABLE[^;]*${forbidden}\\b`),
      `${forbidden} belongs to a later module`);
  }
  assert.doesNotMatch(migrationCode, /transaction_case_links/);
});

test('the local-database verification script is wired into package.json', () => {
  assert.equal(packageJson.scripts['builder:db:verify:inventory'],
    'node scripts/builder-portal/local-db/verify-inventory.mjs');
});
