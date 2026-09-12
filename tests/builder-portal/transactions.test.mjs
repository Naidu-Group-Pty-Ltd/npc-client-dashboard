/**
 * Builder / Developer Portal — Transactions contract tests.
 *
 * Static contract assertions over the transactions migration, the two new Edge
 * Functions, the shared domain modules and the frontend wiring. They run with no
 * database and no network, so they gate every CI run.
 *
 * The behavioural half — access isolation through the parent project, scoped
 * DENY overrides, fail-closed auditing, stale-write rejection, lifecycle
 * transitions, the transaction-case guard (MIG-02) and the unsold-inventory rule
 * — is executed against a live PostgreSQL database by
 * `scripts/builder-portal/local-db/verify-transactions.mjs`, which asserts 111
 * conditions. These tests assert the shape that verification depends on, so a
 * change that would invalidate it fails here first.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('../../', import.meta.url).pathname;
const read = (relative) => readFileSync(join(root, relative), 'utf8');

const MIGRATION = '20260805000000_builder_portal_transactions.sql';

const stripSqlComments = (body) => body.replace(/--[^\n]*/g, '');
const stripJsComments = (body) =>
  body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const migrationSql = read(join('supabase/migrations', MIGRATION));
const migrationCode = stripSqlComments(migrationSql);

const portalFn = read('supabase/functions/builder-portal-transactions/index.ts');
const portalCode = stripJsComments(portalFn);
const adminFn = read('supabase/functions/builder-transactions-admin/index.ts');
const adminCode = stripJsComments(adminFn);
const sharedDomain = read('supabase/functions/_shared/builderTransactions.ts');
const sharedDomainCode = stripJsComments(sharedDomain);

const app = read('src/App.tsx');
const layout = read('src/components/builder-portal/BuilderPortalLayout.tsx');
const queries = stripJsComments(read('src/lib/builderQueries.ts'));
const domain = stripJsComments(read('src/lib/builderTransactions.ts'));
const listPage = stripJsComments(read('src/pages/builder/BuilderTransactions.tsx'));
const detailPage = stripJsComments(read('src/pages/builder/BuilderTransactionDetail.tsx'));
const pipelinePage = stripJsComments(read('src/pages/builder/BuilderPipeline.tsx'));
const adminPanel = stripJsComments(
  read('src/components/admin/builder-portal/AdminBuilderTransactionsPanel.tsx'));
const configToml = read('supabase/config.toml');
const registry = JSON.parse(read('supabase/functions-registry/SECURITY_REGISTRY.json'));
const packageJson = JSON.parse(read('package.json'));

const TRANSACTION_TABLES = [
  'builder_transactions', 'builder_transaction_parties',
  'builder_transaction_status_history', 'builder_transaction_pipeline_stages',
];

const GUARDED_COMMANDS = [
  'builder_upsert_transaction', 'builder_transition_transaction',
  'builder_upsert_transaction_party', 'builder_delete_transaction_party',
  'builder_set_transaction_client',
  'builder_link_transaction_to_case', 'builder_unlink_transaction_from_case',
];

// ---------------------------------------------------------------------------
// Migration structure
// ---------------------------------------------------------------------------

test('the transactions migration exists and is timestamped after Inventory', () => {
  assert.ok(readdirSync(join(root, 'supabase/migrations')).includes(MIGRATION));
  assert.ok(MIGRATION.split('_')[0] > '20260804000000');
});

test('the transactions migration drops no table, column, schema or type', () => {
  const destructive = migrationCode.match(/DROP\s+(TABLE|COLUMN|SCHEMA|TYPE)\b/gi) || [];
  assert.deepEqual(destructive, [],
    `the transactions migration must not drop existing objects, found: ${destructive.join(', ')}`);
});

test('every transaction table is created idempotently and RLS-protected', () => {
  for (const table of TRANSACTION_TABLES) {
    assert.match(migrationCode, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}\\b`),
      `${table} is not created idempotently`);
  }
  assert.match(migrationCode, /ALTER TABLE public\.%I ENABLE ROW LEVEL SECURITY/);
  assert.match(migrationCode, /POST-MIGRATION FAILURE: RLS not enabled on/);
});

test('no transaction policy is written with an unrestricted USING (true)', () => {
  assert.doesNotMatch(migrationCode, /USING\s*\(\s*true\s*\)/i);
  assert.doesNotMatch(migrationCode, /WITH CHECK\s*\(\s*true\s*\)/i);
});

test('every transaction table is revoked from anon and authenticated', () => {
  assert.match(migrationCode, /REVOKE ALL ON public\.%I FROM anon, authenticated/);
  for (const table of TRANSACTION_TABLES) {
    assert.ok(migrationCode.includes(`'${table}'`), `${table} is missing from the grant loop`);
  }
});

// ---------------------------------------------------------------------------
// Data boundaries
// ---------------------------------------------------------------------------

test('no transaction table carries a cost, margin, supplier or commission column', () => {
  const forbidden =
    /\b\w*(cost|margin|supplier|contractor_price|commission)\w*\s+(numeric|text|integer|money)/i;
  assert.doesNotMatch(migrationCode, forbidden,
    'an internal commercial column was introduced');
  assert.match(migrationCode, /%commission%/,
    'the post-migration assertion does not check for a commission column');
});

test('no client financial position is copied onto the transaction', () => {
  const table = migrationCode.slice(migrationCode.indexOf('CREATE TABLE IF NOT EXISTS public.builder_transactions'));
  const body = table.slice(0, table.indexOf(');'));
  for (const forbidden of ['income', 'expense', 'asset', 'liabilit', 'employment',
    'borrowing', 'serviceab', 'aml', 'smr', 'mlro', 'privileg']) {
    assert.ok(!new RegExp(`\\b\\w*${forbidden}\\w*\\s+(numeric|text|integer|boolean|jsonb)`, 'i').test(body),
      `builder_transactions carries a ${forbidden} column, which is not Builder-owned`);
  }
});

test('neither transaction function reads Finance-owned or Legal-owned tables', () => {
  for (const [name, code] of [['portal', portalCode], ['admin', adminCode]]) {
    for (const table of ['builder_invoices', 'build_progress_payments', 'client_financials',
      'legal_matters', 'purchase_files', 'client_deals', 'aml_', 'commission']) {
      assert.ok(!code.includes(table),
        `the ${name} transaction function references ${table}, which it does not own`);
    }
  }
});

test('neither transaction function uses select("*")', () => {
  for (const [name, code] of [['portal', portalCode], ['admin', adminCode]]) {
    assert.doesNotMatch(code, /\.select\(\s*['"`]\*/,
      `the ${name} transaction function uses an unrestricted select`);
  }
});

test('the case-link projection carries only link identity', () => {
  const select = sharedDomainCode.slice(sharedDomainCode.indexOf('BUILDER_CASE_LINK_SELECT'));
  const body = select.slice(0, select.indexOf('`;'));
  for (const forbidden of ['legal_matter_id', 'purchase_file_id', 'client_deal_id', 'client_id']) {
    assert.ok(!body.includes(forbidden),
      `the case-link projection exposes ${forbidden}, which belongs to another domain`);
  }
});

test('the admin case list returns case identity only', () => {
  const block = adminCode.slice(adminCode.indexOf("operation === 'list_client_cases'"));
  // The block returns early when there is no client, so it is sliced to the
  // error check that follows the projection rather than to the first return.
  const body = block.slice(0, block.indexOf('if (error) throw error'));
  // The projection is written across two lines, so the columns are asserted
  // individually rather than as one literal.
  for (const column of ['id', 'case_type', 'shared_lifecycle_status',
    'property_address_normalized', 'opened_at']) {
    assert.ok(body.includes(column), `list_client_cases omits ${column}`);
  }
  for (const forbidden of ['legal_matter', 'purchase_file', 'client_deal', 'risk_level']) {
    assert.ok(!body.includes(forbidden),
      `list_client_cases exposes ${forbidden}, which belongs to another domain`);
  }
});

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

test('the transaction resolver delegates to the project resolver first', () => {
  const resolver = migrationCode.slice(
    migrationCode.indexOf('FUNCTION public.builder_resolve_transaction_permission'));
  const body = resolver.slice(0, resolver.indexOf('END $$'));
  const parent = body.indexOf('builder_resolve_project_permission');
  assert.ok(parent > 0, 'the resolver does not consult the parent project at all');
  assert.match(body.slice(parent, parent + 260), /IF NOT v_base THEN RETURN false; END IF;/,
    'a project denial does not immediately deny the transaction');
});

test('an active membership is a hard requirement in the transaction resolver', () => {
  const resolver = migrationCode.slice(
    migrationCode.indexOf('FUNCTION public.builder_resolve_transaction_permission'));
  const body = resolver.slice(0, resolver.indexOf('END $$'));
  const gate = body.indexOf('builder_active_membership');
  assert.ok(gate > 0, 'the resolver does not check the membership');
  assert.match(body.slice(gate, gate + 200), /IF v_membership_id IS NULL THEN RETURN false; END IF;/,
    'a missing membership does not return false immediately');
  assert.ok(gate < body.indexOf("scope_type = 'unit'"),
    'the unit-scoped override runs before the membership gate');
  assert.ok(gate < body.indexOf("scope_type = 'transaction'"),
    'the transaction-scoped override runs before the membership gate');
});

test('unit-scoped and transaction-scoped overrides may only DENY', () => {
  const resolver = migrationCode.slice(
    migrationCode.indexOf('FUNCTION public.builder_resolve_transaction_permission'));
  const body = resolver.slice(0, resolver.indexOf('END $$'));
  const denials = body.match(/IF v_scoped = 'deny' THEN RETURN false; END IF;/g) || [];
  assert.equal(denials.length, 2, 'both scoped overrides must be deny-only');
  assert.ok(!/v_scoped = 'allow'\s*THEN\s*RETURN true/.test(body),
    'a narrower scope must never grant what the parent withheld');
});

test('BOTH scope gates accept the new transaction scope', () => {
  // The column CHECK and the trigger guard are separate gates. Widening only one
  // leaves the override unstorable, so the resolver reads a row that cannot
  // exist — the defect the local verification caught.
  assert.match(migrationCode,
    /ADD CONSTRAINT builder_membership_permissions_scope_type_check[\s\S]*?'transaction'/,
    'the column CHECK does not accept the transaction scope');
  const guard = migrationCode.slice(
    migrationCode.indexOf('FUNCTION public.builder_guard_permission_scope'));
  const body = guard.slice(0, guard.indexOf('END $$'));
  assert.match(body, /'organisation',\s*'project',\s*'stage',\s*'unit',\s*'transaction'/,
    'the trigger guard does not accept the transaction scope');
  assert.match(body, /scope_type = 'transaction' AND NOT EXISTS/,
    'a transaction scope id is not checked against an existing row');
});

test('the transactions permission key carries a role baseline', () => {
  assert.match(migrationCode,
    /INSERT INTO public\.builder_role_default_permissions[\s\S]*?'transactions'/,
    'the transactions permission key has no seeded role baseline');
  assert.match(migrationCode,
    /POST-MIGRATION FAILURE: permission key\(s\) without a role baseline: transactions/);
});

test('a transaction cannot cross a project or organisation boundary', () => {
  assert.match(migrationCode, /BUILDER_TRANSACTION_PARENT_MISMATCH/);
  assert.match(migrationCode, /BUILDER_TRANSACTION_ORG_MISMATCH/);
  assert.match(migrationCode,
    /BEFORE INSERT OR UPDATE OF project_id, unit_id, organisation_id\s*\n\s*ON public\.builder_transactions/);
});

// ---------------------------------------------------------------------------
// Transaction-case relationship (GEN-09 / MIG-02)
// ---------------------------------------------------------------------------

test('the fourth case-link slot is added with its unique constraint and index', () => {
  assert.match(migrationCode,
    /ADD COLUMN IF NOT EXISTS builder_transaction_id uuid/);
  assert.match(migrationCode, /transaction_case_links_builder_transaction_id_key/);
  assert.match(migrationCode, /idx_transaction_case_links_builder/);
});

test('MIG-02: the guard, its trigger and both CHECKs ship in the same migration', () => {
  // A column added without all of these is a defect, not an incomplete feature.
  assert.match(migrationCode, /CREATE OR REPLACE FUNCTION public\.guard_transaction_case_links/);
  assert.match(migrationCode,
    /BEFORE INSERT OR UPDATE OF case_id, legal_matter_id, purchase_file_id,\s*\n\s*client_deal_id, builder_transaction_id/,
    'the trigger does not fire on the new column');
  assert.match(migrationCode,
    /transaction_case_link_history_domain_type_check[\s\S]*?'builder_transaction'/,
    'the link-history domain_type CHECK was not widened');
  assert.match(migrationCode,
    /transaction_case_links_link_source_check[\s\S]*?'builder_portal'/,
    'the link_source CHECK was not widened');
  assert.match(migrationCode,
    /POST-MIGRATION FAILURE: the case-link guard does not fire on builder_transaction_id \(MIG-02\)/);
});

test('the replaced guard preserves every existing branch', () => {
  const guard = migrationCode.slice(
    migrationCode.indexOf('FUNCTION public.guard_transaction_case_links'));
  const body = guard.slice(0, guard.indexOf('END $$'));
  for (const slot of ['legal_matter_id', 'purchase_file_id', 'client_deal_id',
    'builder_transaction_id']) {
    assert.ok(body.includes(`NEW.${slot} IS NOT NULL`),
      `the replaced guard lost the ${slot} branch`);
  }
  const crossClient = body.match(/CROSS_CLIENT_CASE_LINK/g) || [];
  assert.equal(crossClient.length, 4, 'every slot must raise CROSS_CLIENT_CASE_LINK');
});

test('unsold inventory can never reach a case', () => {
  const link = migrationCode.slice(
    migrationCode.indexOf('FUNCTION public.builder_link_transaction_to_case'));
  const body = link.slice(0, link.indexOf('END $$'));
  assert.match(body, /IF t\.client_id IS NULL THEN[\s\S]*?BUILDER_TRANSACTION_HAS_NO_CLIENT/,
    'a transaction with no client is not refused');
  assert.match(body, /BUILDER_CASE_SLOT_TAKEN/,
    'a case whose builder slot is already taken is not refused');
});

test('the client cannot be changed under a live case link', () => {
  const command = migrationCode.slice(
    migrationCode.indexOf('FUNCTION public.builder_set_transaction_client'));
  const body = command.slice(0, command.indexOf('END $$'));
  assert.match(body, /BUILDER_TRANSACTION_CASE_LINKED/,
    'changing the client under a live link is not refused');
});

test('link and unlink append to the shared link history', () => {
  for (const fn of ['builder_link_transaction_to_case', 'builder_unlink_transaction_from_case']) {
    const command = migrationCode.slice(migrationCode.indexOf(`FUNCTION public.${fn}`));
    const body = command.slice(0, command.indexOf('END $$'));
    assert.match(body, /INSERT INTO public\.transaction_case_link_history/,
      `${fn} does not append to the shared link history`);
  }
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

test('no transaction Edge Function mutates a domain table directly', () => {
  for (const [name, code] of [['portal', portalCode], ['admin', adminCode]]) {
    for (const verb of ['insert', 'update', 'delete', 'upsert']) {
      assert.doesNotMatch(code, new RegExp(`\\.${verb}\\(`),
        `the ${name} transaction function calls .${verb}() instead of a guarded command`);
    }
  }
});

test('every mutable aggregate enforces expected_version atomically', () => {
  for (const fn of ['builder_upsert_transaction', 'builder_upsert_transaction_party',
    'builder_set_transaction_client']) {
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
      `the ${name} transaction function does not reject a missing expected_version`);
    assert.ok(!/expected_version:\s*(transaction|record|existing)\.row_version/.test(code),
      `the ${name} transaction function substitutes the current version for a missing one`);
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
  // Trigger guards, not command outcomes.
  for (const code of ['BUILDER_TRANSACTION_HISTORY_APPEND_ONLY', 'BUILDER_SCOPE_NOT_AVAILABLE',
    'BUILDER_SCOPE_TARGET_NOT_FOUND']) {
    raised.delete(code);
  }
  for (const code of raised) {
    assert.ok(sharedDomainCode.includes(`'${code}'`),
      `${code} is raised by the migration but not mapped to an HTTP status`);
  }
});

test('transaction status history is append-only', () => {
  assert.match(migrationCode, /BUILDER_TRANSACTION_HISTORY_APPEND_ONLY/);
  assert.match(migrationCode,
    /BEFORE UPDATE OR DELETE ON public\.builder_transaction_status_history/);
});

test('status is not writable through the upsert command', () => {
  const command = migrationCode.slice(
    migrationCode.indexOf('FUNCTION public.builder_upsert_transaction'));
  const body = command.slice(0, command.indexOf('END $$'));
  const update = body.slice(body.indexOf('UPDATE public.builder_transactions SET'),
    body.indexOf('WHERE id = v_existing.id'));
  assert.ok(!/\bstatus\s*=/.test(update),
    'status must move only through the transition command, which writes history');
});

test('one live transaction per unit is enforced by the database', () => {
  assert.match(migrationCode,
    /builder_transactions_one_live_per_unit[\s\S]*?WHERE unit_id IS NOT NULL AND status NOT IN \('cancelled','lapsed'\)/);
});

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

test('the pipeline mapping lives in the database, not in a function', () => {
  assert.match(migrationCode,
    /CREATE TABLE IF NOT EXISTS public\.builder_transaction_pipeline_stages/);
  assert.match(migrationCode, /stage_key text NOT NULL/);
  assert.match(migrationCode, /stage_order smallint NOT NULL/);
  // Both functions read the mapping rather than hard-coding it.
  for (const [name, code] of [['portal', portalCode], ['admin', adminCode]]) {
    assert.ok(code.includes("from('builder_transaction_pipeline_stages')"),
      `the ${name} function does not read the database pipeline mapping`);
  }
});

test('every transaction status is seeded into the pipeline mapping', () => {
  const seed = migrationCode.slice(
    migrationCode.indexOf('INSERT INTO public.builder_transaction_pipeline_stages'));
  const body = seed.slice(0, seed.indexOf('ON CONFLICT'));
  for (const status of ['lead', 'reserved', 'contract_issued', 'contract_signed', 'unconditional',
    'construction', 'practical_completion', 'settled', 'cancelled', 'lapsed']) {
    assert.ok(body.includes(`'${status}'`), `${status} has no pipeline stage`);
  }
});

test('the pipeline page renders what the server returned and derives nothing', () => {
  assert.ok(pipelinePage.includes('useBuilderPipeline'));
  assert.ok(!pipelinePage.includes('stage_key ='),
    'the pipeline page assigns its own stage keys instead of using the server mapping');
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
});

test('the portal function resolves every transaction through its parent project', () => {
  const loader = portalCode.slice(portalCode.indexOf('const loadTransaction'));
  const body = loader.slice(0, loader.indexOf('\n    };'));
  assert.ok(body.indexOf('loadProject') > 0, 'loadTransaction does not resolve the parent project');
  assert.ok(body.indexOf('builder_resolve_transaction_permission') > body.indexOf('loadProject'),
    'the transaction resolver must run after the parent project check, not instead of it');
  assert.match(body, /if \(!parent\.ok\) return \{ ok: false, status: 404, error: 'Transaction not found' \}/,
    'a withheld project must report "not found", not "forbidden"');
});

test('a project filter narrows within what is already permitted', () => {
  const occurrences =
    portalCode.match(/accessibleProjectIds\.filter\(\(id\) => id === requestedProjectId\)/g) || [];
  assert.ok(occurrences.length >= 3,
    'every list-style operation must intersect the requested project with the accessible set');
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
  for (const operation of ['list_transactions', 'get_transaction', 'pipeline']) {
    assert.ok(adminCode.includes(`'${operation}'`), `${operation} is missing from the read set`);
  }
  const readSet = adminCode.slice(adminCode.indexOf('const READ_OPERATIONS'),
    adminCode.indexOf('function requiredPermFor'));
  for (const mutation of ['create_transaction', 'update_transaction', 'set_status',
    'set_client', 'link_case', 'unlink_case']) {
    assert.ok(!readSet.includes(`'${mutation}'`),
      `${mutation} is wrongly classified as a read operation`);
  }
});

test('both functions are registered with the correct JWT posture', () => {
  assert.match(configToml, /\[functions\.builder-portal-transactions\]\s*\nverify_jwt = false/);
  assert.match(configToml, /\[functions\.builder-transactions-admin\]\s*\nverify_jwt = true/);
  assert.equal(registry.functions['builder-portal-transactions'].exposure_class, 'portal-authenticated');
  assert.equal(registry.functions['builder-portal-transactions'].verify_jwt, false);
  assert.equal(registry.functions['builder-transactions-admin'].exposure_class, 'module-gated');
  assert.equal(registry.functions['builder-transactions-admin'].verify_jwt, true);
});

test('both functions are covered by the Deno type check', () => {
  const script = packageJson.scripts['typecheck:builder-edge'];
  assert.ok(script.includes('builder-portal-transactions/index.ts'));
  assert.ok(script.includes('builder-transactions-admin/index.ts'));
});

// ---------------------------------------------------------------------------
// Frontend wiring
// ---------------------------------------------------------------------------

test('the transaction routes are inside the Builder portal tree', () => {
  /*
   * WITHDRAWN, NOT UNROUTED. The section is not offered in this portal
   * (`builderHiddenSections.pure.ts`), so the path resolves to the notice
   * instead of the page. The rule this test protects is unchanged and is the
   * reason it still asserts: the path must live INSIDE the Builder portal
   * tree, never in the internal dashboard tree.
   */
  const builderTree = app.slice(app.indexOf('<Route path="/builder/*"'));
  assert.ok(builderTree.includes('<Route path="transactions" element={<BuilderSectionWithdrawn />} />'));
  assert.ok(builderTree.includes(
    '<Route path="transactions/:transactionId" element={<BuilderSectionWithdrawn />} />'));
  assert.ok(builderTree.includes('<Route path="pipeline" element={<BuilderSectionWithdrawn />} />'));
  assert.match(app, /const BuilderTransactions = lazyWithRetry/);
  assert.match(app, /const BuilderPipeline = lazyWithRetry/);
});

test('the Transactions and Pipeline navigation items are enabled', () => {
  assert.match(layout,
    /\{ to: '\/builder\/transactions', label: 'Transactions', icon: Receipt, available: true \}/);
  assert.match(layout,
    /\{ to: '\/builder\/pipeline', label: 'Pipeline', icon: KanbanSquare, available: true \}/);
});

test('the browser never reaches the database directly', () => {
  for (const [name, code] of [['queries', queries], ['list', listPage], ['detail', detailPage],
    ['pipeline', pipelinePage], ['admin panel', adminPanel]]) {
    assert.ok(!code.includes('supabase.from('),
      `the ${name} module queries the database directly instead of an Edge Function`);
  }
  assert.ok(queries.includes("invoke('builder-portal-transactions'"));
  assert.ok(adminPanel.includes("'builder-transactions-admin'"));
});

test('transaction queries do not retry a 4xx answer', () => {
  for (const hook of ['useBuilderTransactions', 'useBuilderTransaction',
    'useBuilderTransactionStats', 'useBuilderPipeline']) {
    const definition = queries.slice(queries.indexOf(`export function ${hook}(`));
    const body = definition.slice(0, definition.indexOf('\n}\n'));
    assert.match(body, /retry: retryBuilderQuery/, `${hook} does not use the shared retry policy`);
  }
});

test('the transaction mutation hook binds the id so a caller cannot cross records', () => {
  const definition = queries.slice(queries.indexOf('export function useBuilderTransactionMutation'));
  const body = definition.slice(0, definition.indexOf('\n}\n'));
  assert.match(body, /\{ \.\.\.payload, transaction_id: transactionId \}/,
    'the transaction id must be bound by the hook, not supplied per call');
});

test('every transaction mutation on the detail page carries expected_version', () => {
  for (const operation of ['update_transaction', 'set_status']) {
    const call = detailPage.slice(detailPage.indexOf(`operation: '${operation}'`));
    const body = call.slice(0, call.indexOf('});'));
    assert.match(body, /expected_version: transaction\.row_version/,
      `${operation} does not carry the loaded version`);
  }
});

test('the frontend transition list matches the database allow-list', () => {
  assert.match(domain, /case 'settled': case 'cancelled': case 'lapsed': return \[\];/);
  assert.match(domain, /case 'lead': return \['reserved', 'contract_issued', \.\.\.terminal\];/);
  assert.match(domain,
    /case 'unconditional': return \['construction', 'practical_completion', 'settled', \.\.\.terminal\];/);
});

test('the portal pages render loading, empty, error and permission states', () => {
  for (const [name, page] of [['list', listPage], ['pipeline', pipelinePage]]) {
    assert.ok(page.includes('query.isLoading'), `${name} has no loading state`);
    assert.ok(page.includes('query.isError'), `${name} has no error state`);
  }
  assert.ok(listPage.includes('No transactions to show'));
  assert.ok(pipelinePage.includes('No transactions in the pipeline'));
  assert.ok(detailPage.includes('query.isLoading'));
  assert.ok(detailPage.includes('query.isError'));
  assert.ok(detailPage.includes("permissions?.transactions?.edit === true"));
  assert.ok(detailPage.includes("permissions?.transactions?.delete === true"));
});

test('the frontend exposes no cost, margin, commission or client financial position', () => {
  for (const [name, code] of [['domain', domain], ['list', listPage], ['detail', detailPage],
    ['pipeline', pipelinePage], ['admin panel', adminPanel]]) {
    assert.doesNotMatch(code,
      /\b(build_cost|cost_price|margin|supplier_price|contractor_price|commission|borrowing_capacity|serviceability)\b/i,
      `the ${name} module surfaces information the Builder audience must not see`);
  }
});

test('no unbuilt Builder module was introduced', () => {
  for (const forbidden of ['builder_construction_cases', 'builder_variations',
    'builder_progress_claims', 'builder_inspections', 'builder_defects', 'builder_handovers']) {
    assert.doesNotMatch(migrationCode, new RegExp(`CREATE TABLE[^;]*${forbidden}\\b`),
      `${forbidden} belongs to a later module`);
  }
});

test('the local-database verification script is wired into package.json', () => {
  assert.equal(packageJson.scripts['builder:db:verify:transactions'],
    'node scripts/builder-portal/local-db/verify-transactions.mjs');
});
