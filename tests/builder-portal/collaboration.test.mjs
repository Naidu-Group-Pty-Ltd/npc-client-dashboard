/**
 * Builder / Developer Portal — Collaboration contract tests.
 *
 * Static contract assertions over the collaboration migration, the two new Edge
 * Functions, the shared domain modules and the frontend wiring.
 *
 * The behavioural half — scope dispatch, grants and participation narrowing but
 * never widening, membership as the hard gate, fail-closed auditing,
 * stale-write rejection, immutability of versions and messages, and derived
 * unread counts — is executed against a live PostgreSQL database by
 * `scripts/builder-portal/local-db/verify-collaboration.mjs` (184 assertions).
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('../../', import.meta.url).pathname;
const read = (relative) => readFileSync(join(root, relative), 'utf8');

const MIGRATION = '20260808000000_builder_portal_collaboration.sql';

const stripSqlComments = (body) => body.replace(/--[^\n]*/g, '');
const stripJsComments = (body) =>
  body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const migrationCode = stripSqlComments(read(join('supabase/migrations', MIGRATION)));
const portalCode = stripJsComments(read('supabase/functions/builder-portal-collaboration/index.ts'));
const adminCode = stripJsComments(read('supabase/functions/builder-collaboration-admin/index.ts'));
const sharedDomainCode = stripJsComments(read('supabase/functions/_shared/builderCollaboration.ts'));

const app = read('src/App.tsx');
const layout = read('src/components/builder-portal/BuilderPortalLayout.tsx');
const queries = stripJsComments(read('src/lib/builderQueries.ts'));
const domain = stripJsComments(read('src/lib/builderCollaboration.ts'));
const documentsPage = stripJsComments(read('src/pages/builder/BuilderDocuments.tsx'));
const messagesPage = stripJsComments(read('src/pages/builder/BuilderMessages.tsx'));
const tasksPage = stripJsComments(read('src/pages/builder/BuilderTasks.tsx'));
const notificationsPage = stripJsComments(read('src/pages/builder/BuilderNotifications.tsx'));
const adminPanel = stripJsComments(
  read('src/components/admin/builder-portal/AdminBuilderCollaborationPanel.tsx'));
const configToml = read('supabase/config.toml');
const registry = JSON.parse(read('supabase/functions-registry/SECURITY_REGISTRY.json'));
const packageJson = JSON.parse(read('package.json'));

const TABLES = [
  'builder_documents', 'builder_document_versions', 'builder_document_grants',
  'builder_conversations', 'builder_conversation_participants', 'builder_messages',
  'builder_tasks', 'builder_task_assignments', 'builder_notifications',
];

const VERSIONED_TABLES = [
  'builder_documents', 'builder_document_grants', 'builder_conversations',
  'builder_conversation_participants', 'builder_tasks', 'builder_task_assignments',
];

const GUARDED_COMMANDS = [
  'builder_upsert_document', 'builder_add_document_version', 'builder_set_document_grant',
  'builder_create_conversation', 'builder_post_message', 'builder_mark_conversation_read',
  'builder_upsert_task', 'builder_set_task_assignment', 'builder_mark_notifications_read',
];

const SCOPE_TYPES = ['project', 'unit', 'transaction', 'construction_case'];

const PORTAL_PAGES = [
  ['documents', documentsPage], ['messages', messagesPage],
  ['tasks', tasksPage], ['notifications', notificationsPage],
];

// ---------------------------------------------------------------------------
// Migration structure
// ---------------------------------------------------------------------------

test('the collaboration migration exists and is timestamped after Delivery', () => {
  assert.ok(readdirSync(join(root, 'supabase/migrations')).includes(MIGRATION));
  assert.ok(MIGRATION.split('_')[0] > '20260807000000');
});

test('the collaboration migration drops no table, column, schema or type', () => {
  const destructive = migrationCode.match(/DROP\s+(TABLE|COLUMN|SCHEMA|TYPE)\b/gi) || [];
  assert.deepEqual(destructive, []);
});

test('every collaboration table is created idempotently and RLS-protected', () => {
  for (const table of TABLES) {
    assert.match(migrationCode, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}\\b`),
      `${table} is not created idempotently`);
  }
  assert.match(migrationCode, /ALTER TABLE public\.%I ENABLE ROW LEVEL SECURITY/);
  assert.match(migrationCode, /POST-MIGRATION FAILURE: RLS not enabled on/);
});

test('no collaboration policy is written with an unrestricted USING (true)', () => {
  assert.doesNotMatch(migrationCode, /USING\s*\(\s*true\s*\)/i);
  assert.doesNotMatch(migrationCode, /WITH CHECK\s*\(\s*true\s*\)/i);
});

test('every collaboration table is revoked from anon and authenticated', () => {
  assert.match(migrationCode, /REVOKE ALL ON public\.%I FROM anon, authenticated/);
  for (const table of TABLES) {
    assert.ok(migrationCode.includes(`'${table}'`), `${table} is missing from the grant loop`);
  }
});

test('every collaboration function is revoked from PUBLIC, anon and authenticated', () => {
  assert.match(migrationCode,
    /REVOKE ALL ON FUNCTION public\.%I\(%s\) FROM PUBLIC, anon, authenticated/);
  for (const fn of GUARDED_COMMANDS) {
    assert.ok(migrationCode.includes(`'${fn}'`), `${fn} is missing from the revoke loop`);
  }
});

test('every table carrying the shared touch trigger also carries row_version', () => {
  // The touch trigger bumps row_version; a table without the column would make
  // every update raise at runtime.
  const block = migrationCode.slice(migrationCode.indexOf('builder_touch_row'));
  for (const table of VERSIONED_TABLES) {
    const definition = migrationCode.slice(
      migrationCode.indexOf(`CREATE TABLE IF NOT EXISTS public.${table}`));
    const body = definition.slice(0, definition.indexOf('\n);'));
    assert.match(body, /row_version bigint NOT NULL DEFAULT 1/,
      `${table} carries the touch trigger without row_version`);
  }
  assert.ok(block.length > 0);
  assert.match(migrationCode,
    /POST-MIGRATION FAILURE: touch-triggered table\(s\) without row_version/);
});

test('the two immutable tables carry no row_version and no touch trigger', () => {
  // A version and a message are never updated, so neither needs — nor may have —
  // a mutable version counter.
  for (const table of ['builder_document_versions', 'builder_messages']) {
    const definition = migrationCode.slice(
      migrationCode.indexOf(`CREATE TABLE IF NOT EXISTS public.${table}`));
    const body = definition.slice(0, definition.indexOf('\n);'));
    assert.ok(!body.includes('row_version'), `${table} carries a row_version it can never bump`);
    assert.ok(!VERSIONED_TABLES.includes(table));
  }
});

// ---------------------------------------------------------------------------
// The data boundary
// ---------------------------------------------------------------------------

test('no collaboration table carries money, AML or privileged data', () => {
  assert.match(migrationCode,
    /POST-MIGRATION FAILURE: a collaboration table carries restricted data/);
  for (const table of TABLES) {
    const definition = migrationCode.slice(
      migrationCode.indexOf(`CREATE TABLE IF NOT EXISTS public.${table}`));
    const body = definition.slice(0, definition.indexOf('\n);'));
    for (const forbidden of ['amount', 'price', 'cost', 'income', 'borrowing',
      'aml', 'privileg', 'commission']) {
      assert.ok(!new RegExp(`\\b\\w*${forbidden}\\w*\\s+(numeric|boolean|text|timestamptz)`, 'i').test(body),
        `${table} carries a ${forbidden} column`);
    }
  }
});

test('neither collaboration function reads a table it does not own', () => {
  for (const [name, code] of [['portal', portalCode], ['admin', adminCode]]) {
    for (const table of ['build_progress_payments', 'builder_invoices', 'client_financials',
      'client_deals', 'clients', 'legal_matters', 'purchase_files', 'solicitor_',
      'aml_', 'commission']) {
      assert.ok(!code.includes(table),
        `the ${name} collaboration function references ${table}, which it does not own`);
    }
  }
});

test('neither collaboration function uses select("*")', () => {
  for (const [name, code] of [['portal', portalCode], ['admin', adminCode]]) {
    assert.doesNotMatch(code, /\.select\(\s*['"`]\*/,
      `the ${name} collaboration function uses an unrestricted select`);
  }
});

test('a storage path is never in a response projection', () => {
  // The bytes live in storage. The path is read only to mint a signed url and
  // is stripped from everything that leaves the server.
  // Every explicit projection, not just the version one: none may name the path.
  for (const [, name, body] of sharedDomainCode.matchAll(
    /export const (BUILDER_\w+_SELECT) = `([\s\S]*?)`;/g)) {
    assert.ok(!body.includes('storage_path'),
      `${name} returns the storage path to the browser`);
  }
  assert.ok(sharedDomainCode.includes('BUILDER_DOCUMENT_VERSION_SELECT'),
    'the version projection is missing');
  for (const [name, code] of [['portal', portalCode], ['admin', adminCode]]) {
    assert.match(code, /const \{ storage_path: _path, \.\.\.safe \} = \(data \|\| \{\}\) as any;/,
      `the ${name} function returns a raw version row including its path`);
  }
});

test('a signed url is short-lived and re-resolves the permission on every request', () => {
  assert.match(sharedDomainCode, /BUILDER_DOCUMENT_URL_TTL_SECONDS = 300/);
  const block = portalCode.slice(portalCode.indexOf("operation === 'document_url'"));
  const body = block.slice(0, block.indexOf("if (operation === 'list_document_grants'"));
  assert.match(body, /await loadDocument\(/,
    'the url operation does not re-resolve the document permission');
  assert.match(body, /createSignedUrl\(version\.storage_path, BUILDER_DOCUMENT_URL_TTL_SECONDS\)/);
});

test('an upload path outside the Builder prefix is refused', () => {
  assert.match(sharedDomainCode, /path\.includes\('\.\.'\) \|\| path\.startsWith\('\/'\)/);
  assert.match(sharedDomainCode, /return path\.startsWith\(BUILDER_DOCUMENT_STORAGE_PREFIX\)/);
  for (const [name, code] of [['portal', portalCode], ['admin', adminCode]]) {
    assert.match(code, /if \(!isAcceptableStoragePath\(payload\.storage_path as string\)\)/,
      `the ${name} function accepts an arbitrary storage path`);
  }
});

// ---------------------------------------------------------------------------
// Access control — the scope dispatcher
// ---------------------------------------------------------------------------

test('one dispatcher delegates to the resolver that already governs the scope', () => {
  // There is no new access table and no new decision: the dispatcher forwards to
  // the resolver each aggregate already has.
  assert.ok(!/CREATE TABLE[^;]*builder_collaboration_access/.test(migrationCode),
    'a new access table was introduced for collaboration');
  const fn = migrationCode.slice(
    migrationCode.indexOf('FUNCTION public.builder_resolve_scope_permission'));
  const body = fn.slice(0, fn.indexOf('END $$'));
  assert.match(body, /WHEN 'project' THEN\s*\n\s*public\.builder_resolve_project_permission/);
  assert.match(body, /WHEN 'unit' THEN\s*\n\s*public\.builder_resolve_unit_permission/);
  assert.match(body, /WHEN 'transaction' THEN\s*\n\s*public\.builder_resolve_transaction_permission/);
  assert.match(body, /WHEN 'construction_case' THEN\s*\n\s*public\.builder_resolve_construction_permission/);
  assert.match(body, /ELSE false/, 'an unknown scope type must not default open');
});

test('the scope list is closed at the column and guarded by a trigger', () => {
  for (const table of ['builder_documents', 'builder_conversations', 'builder_tasks']) {
    const definition = migrationCode.slice(
      migrationCode.indexOf(`CREATE TABLE IF NOT EXISTS public.${table}`));
    const body = definition.slice(0, definition.indexOf('\n);'));
    assert.match(body,
      /CHECK \(scope_type IN \('project','unit','transaction','construction_case'\)\)/,
      `${table} does not close its scope list at the column`);
  }
  assert.match(migrationCode, /BUILDER_SCOPE_TARGET_NOT_FOUND/);
  assert.match(migrationCode, /EXECUTE FUNCTION public\.builder_enforce_collaboration_scope\(\)/);
  const exists = migrationCode.slice(migrationCode.indexOf('FUNCTION public.builder_scope_exists'));
  assert.match(exists.slice(0, exists.indexOf('END $$')), /ELSE false/);
});

test('a grant narrows a document and can never widen one', () => {
  const fn = migrationCode.slice(migrationCode.indexOf('FUNCTION public.builder_can_see_document'));
  const body = fn.slice(0, fn.indexOf('END $$'));
  // The scope resolver is the FIRST check and returns false outright.
  const gate = body.indexOf('builder_resolve_scope_permission');
  const grantCheck = body.indexOf('builder_document_grants');
  assert.ok(gate > -1 && grantCheck > gate,
    'the grant is consulted before the scope resolver');
  assert.match(body, /IF NOT public\.builder_resolve_scope_permission\([\s\S]{0,120}?RETURN false;/);
  assert.match(body, /IF NOT v_restricted THEN RETURN true; END IF;/);
});

test('participation narrows a conversation and can never widen one', () => {
  const fn = migrationCode.slice(
    migrationCode.indexOf('FUNCTION public.builder_can_see_conversation'));
  const body = fn.slice(0, fn.indexOf('END $$'));
  const gate = body.indexOf('builder_resolve_scope_permission');
  const participantCheck = body.indexOf('builder_conversation_participants');
  assert.ok(gate > -1 && participantCheck > gate,
    'participation is consulted before the scope resolver');
  assert.match(body, /IF NOT v_has_participants THEN RETURN true; END IF;/);
});

test('every accessible-set function runs each row through a resolver', () => {
  for (const [fn, gate] of [
    ['builder_accessible_documents', 'builder_can_see_document'],
    ['builder_accessible_conversations', 'builder_can_see_conversation'],
    ['builder_accessible_tasks', 'builder_resolve_scope_permission'],
  ]) {
    const definition = migrationCode.slice(migrationCode.indexOf(`FUNCTION public.${fn}`));
    const body = definition.slice(0, definition.indexOf('$$;'));
    assert.ok(body.includes(gate), `${fn} does not gate its rows through ${gate}`);
  }
});

test('unread counts are derived and filtered through the same resolvers', () => {
  const fn = migrationCode.slice(migrationCode.indexOf('FUNCTION public.builder_unread_counts'));
  const body = fn.slice(0, fn.indexOf('$$;'));
  assert.ok(body.includes('builder_can_see_conversation'),
    'the unread message count is not filtered through the conversation resolver');
  assert.ok(body.includes('builder_resolve_scope_permission'),
    'the overdue task count is not filtered through the scope resolver');
  // No stored counter anywhere.
  for (const table of TABLES) {
    const definition = migrationCode.slice(
      migrationCode.indexOf(`CREATE TABLE IF NOT EXISTS public.${table}`));
    const tableBody = definition.slice(0, definition.indexOf('\n);'));
    assert.ok(!/unread_\w+/.test(tableBody), `${table} stores an unread counter`);
  }
});

test('every collaboration permission key carries a role baseline', () => {
  assert.match(migrationCode,
    /INSERT INTO public\.builder_role_default_permissions[\s\S]*?'documents'/);
  for (const key of ['messages', 'tasks']) {
    assert.ok(migrationCode.includes(`'${key}'`), `${key} has no seeded role baseline`);
  }
  assert.match(migrationCode,
    /POST-MIGRATION FAILURE: permission key\(s\) without a role baseline/);
  assert.match(migrationCode, /r\.role <> 'read_only'/);
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

test('the portal function anchors every scope to a project it can re-check', () => {
  const loader = portalCode.slice(portalCode.indexOf('const projectIdForScope'));
  const body = loader.slice(0, loader.indexOf('\n    };'));
  for (const scope of SCOPE_TYPES) {
    assert.ok(body.includes(`case '${scope}':`), `projectIdForScope does not handle ${scope}`);
  }
  assert.match(body, /default:\s*\n\s*return null;/, 'an unknown scope must resolve to null');
  const scopeLoader = portalCode.slice(portalCode.indexOf('const loadScope'));
  const scopeBody = scopeLoader.slice(0, scopeLoader.indexOf('\n    };'));
  assert.match(scopeBody, /const parent = await loadProject\(projectId\);/);
  assert.match(scopeBody, /builder_resolve_scope_permission/);
});

test('a withheld scope, document or conversation reports not found, never forbidden', () => {
  for (const [loader, message] of [
    ['const loadScope', "{ ok: false, status: 404, error: 'Not found' }"],
    ['const loadDocument', "{ ok: false, status: 404, error: 'Document not found' }"],
    ['const loadConversation', "{ ok: false, status: 404, error: 'Conversation not found' }"],
  ]) {
    const block = portalCode.slice(portalCode.indexOf(loader));
    const body = block.slice(0, block.indexOf('\n    };'));
    assert.ok(body.includes(message), `${loader} leaks existence on a view denial`);
  }
});

test('a document or task scope comes from the stored row, never the request', () => {
  // A caller must not be able to move a record into a scope they can reach.
  for (const marker of ['upsert_document', 'upsert_task']) {
    const block = portalCode.slice(portalCode.indexOf(`operation === '${marker}'`));
    const body = block.slice(0, block.indexOf('\n      if (error) return fail'));
    assert.match(body, /scopeType = existing\.(document|task)\.scope_type;/,
      `${marker} takes the scope from the request when updating`);
    assert.match(body, /_scope_type: (documentId|taskId) \? null : scopeType,/,
      `${marker} sends a scope on an update`);
  }
});

test('a named participant or assignee must be an active member of this organisation', () => {
  for (const marker of ['create_conversation', 'set_task_assignment', 'set_document_grant']) {
    const block = portalCode.slice(portalCode.indexOf(`operation === '${marker}'`));
    const body = block.slice(0, block.indexOf('\n      if (error) return fail'));
    assert.ok(body.includes("eq('organisation_id', activeOrganisationId)"),
      `${marker} accepts a user id without checking organisation membership`);
    assert.ok(body.includes("eq('status', 'active')"),
      `${marker} accepts an inactive membership`);
  }
});

test('the notification reader is the session user, never a request field', () => {
  const block = portalCode.slice(portalCode.indexOf("operation === 'mark_notifications_read'"));
  const body = block.slice(0, block.indexOf('\n      if (error) return fail'));
  assert.match(body, /_actor_builder_user_id: me\.id,/);
  assert.ok(!body.includes('body.builder_user_id'),
    'the portal function lets a caller name whose notifications are read');
  const listBlock = portalCode.slice(portalCode.indexOf("operation === 'list_notifications'"));
  assert.match(listBlock.slice(0, 600), /eq\('builder_user_id', me\.id\)/);
  const fn = migrationCode.slice(
    migrationCode.indexOf('FUNCTION public.builder_mark_notifications_read'));
  const fnBody = fn.slice(0, fn.indexOf('END $$'));
  assert.match(fnBody, /WHERE builder_user_id = _actor_builder_user_id AND read_at IS NULL/);
});

test('the message author display name comes from the session', () => {
  const block = portalCode.slice(portalCode.indexOf("operation === 'post_message'"));
  const body = block.slice(0, block.indexOf('\n      if (error) return fail'));
  assert.match(body, /_display_name: me\.name \?\? null,/);
  assert.ok(!body.includes('body.display_name'),
    'the portal function lets a caller choose the name a message is attributed to');
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

test('no collaboration Edge Function mutates a domain table directly', () => {
  for (const [name, code] of [['portal', portalCode], ['admin', adminCode]]) {
    for (const verb of ['insert', 'update', 'delete', 'upsert']) {
      assert.doesNotMatch(code, new RegExp(`\\.${verb}\\(`),
        `the ${name} collaboration function calls .${verb}() instead of a guarded command`);
    }
  }
});

test('every mutable aggregate enforces expected_version atomically', () => {
  for (const fn of ['builder_upsert_document', 'builder_set_document_grant',
    'builder_upsert_task', 'builder_set_task_assignment']) {
    const definition = migrationCode.slice(migrationCode.indexOf(`FUNCTION public.${fn}`));
    const body = definition.slice(0, definition.indexOf('END $$'));
    assert.match(body, /_expected_version IS NULL OR v_existing\.row_version <> _expected_version/,
      `${fn} does not reject a missing or stale expected_version atomically`);
    assert.match(body, /FOR UPDATE/, `${fn} does not take a row lock`);
  }
});

test('appending a version is the one command with no expected_version, by design', () => {
  // It is an APPEND: the caller supplies no field of an existing row, and the
  // only change to the parent is a server-derived pointer set under the same
  // FOR UPDATE lock that allocates the version number. Requiring a version would
  // make concurrent uploads fail spuriously while protecting nothing.
  const fn = migrationCode.slice(
    migrationCode.indexOf('FUNCTION public.builder_add_document_version'));
  const body = fn.slice(0, fn.indexOf('END $$'));
  assert.ok(!body.includes('_expected_version'),
    'the append command takes a version it does not need');
  assert.match(body, /FROM public\.builder_documents WHERE id = _document_id FOR UPDATE/,
    'the append is not serialised by a row lock');
  // The only parent column it writes is the derived pointer.
  const parentWrites = body.match(/UPDATE public\.builder_documents SET ([^\n]+)/g) || [];
  assert.equal(parentWrites.length, 1);
  assert.match(parentWrites[0], /SET current_version_id = v_row\.id WHERE id = _document_id;/);
  // Editing the document's own fields still requires a version.
  const upsert = migrationCode.slice(
    migrationCode.indexOf('FUNCTION public.builder_upsert_document'));
  assert.match(upsert.slice(0, upsert.indexOf('END $$')),
    /_expected_version IS NULL OR v_existing\.row_version <> _expected_version/);
});

test('a missing expected_version is a 400, never the current database value', () => {
  for (const [name, code] of [['portal', portalCode], ['admin', adminCode]]) {
    assert.ok(code.includes('EXPECTED_VERSION_REQUIRED'),
      `the ${name} collaboration function does not reject a missing expected_version`);
    assert.ok(!/expected_version:\s*(record|existing|current|document|task)\.row_version/.test(code),
      `the ${name} collaboration function substitutes the current version for a missing one`);
  }
});

test('a document version and a message are immutable', () => {
  assert.match(migrationCode, /BUILDER_DOCUMENT_VERSION_IMMUTABLE/);
  assert.match(migrationCode, /BEFORE UPDATE OR DELETE ON public\.builder_document_versions/);
  assert.match(migrationCode, /BUILDER_MESSAGE_IMMUTABLE/);
  assert.match(migrationCode, /BEFORE UPDATE OR DELETE ON public\.builder_messages/);
});

test('version numbers are allocated server-side under the document lock', () => {
  const fn = migrationCode.slice(
    migrationCode.indexOf('FUNCTION public.builder_add_document_version'));
  const body = fn.slice(0, fn.indexOf('END $$'));
  assert.match(body, /FROM public\.builder_documents WHERE id = _document_id FOR UPDATE/);
  assert.match(body, /SELECT COALESCE\(max\(version_number\), 0\) \+ 1 INTO v_next/);
  assert.ok(!body.includes("_payload->>'version_number'"),
    'a caller can choose the version number');
});

test('the owning organisation is resolved server-side from the scope', () => {
  for (const fn of ['builder_upsert_document', 'builder_create_conversation',
    'builder_upsert_task']) {
    const definition = migrationCode.slice(migrationCode.indexOf(`FUNCTION public.${fn}`));
    const body = definition.slice(0, definition.indexOf('END $$'));
    assert.match(body, /v_org := public\.builder_scope_org\(_scope_type, _scope_id\);/,
      `${fn} does not derive the organisation from the scope`);
    assert.match(body, /IF v_org IS NULL THEN[\s\S]{0,160}?BUILDER_SCOPE_TARGET_NOT_FOUND/,
      `${fn} accepts a scope with no owning organisation`);
  }
  assert.ok(!portalCode.includes('organisation_id: '),
    'the portal function passes an organisation id into a command');
});

test('every error code the migration raises is mapped by the shared failure table', () => {
  const raised = new Set(
    (migrationCode.match(/MESSAGE='([A-Z_]+)'/g) || []).map((m) => m.slice(9, -1)));
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
  for (const mutation of ['upsert_document', 'add_document_version', 'set_document_grant',
    'create_conversation', 'post_message', 'upsert_task', 'set_task_assignment']) {
    assert.ok(!readSet.includes(`'${mutation}'`),
      `${mutation} is wrongly classified as a read operation`);
  }
});

test('the admin function refuses a scope type outside the closed list', () => {
  const loader = adminCode.slice(adminCode.indexOf('const loadScope'));
  const body = loader.slice(0, loader.indexOf('\n    };'));
  assert.match(body, /cleanEnum\(body\.scope_type, BUILDER_SCOPE_TYPES\)/);
  assert.match(body, /builder_scope_exists/);
});

test('the per-user portal views are portal-only', () => {
  for (const operation of ['my_tasks', 'unread_counts', 'collaboration_summary',
    'mark_conversation_read', 'mark_notifications_read']) {
    assert.ok(portalCode.includes(`operation === '${operation}'`),
      `the portal function is missing ${operation}`);
    assert.ok(!adminCode.includes(`operation === '${operation}'`),
      `the internal surface must not carry the per-user operation ${operation}`);
  }
});

test('both functions are registered with the correct JWT posture', () => {
  assert.match(configToml, /\[functions\.builder-portal-collaboration\]\s*\nverify_jwt = false/);
  assert.match(configToml, /\[functions\.builder-collaboration-admin\]\s*\nverify_jwt = true/);
  assert.equal(registry.functions['builder-portal-collaboration'].exposure_class,
    'portal-authenticated');
  assert.equal(registry.functions['builder-collaboration-admin'].exposure_class, 'module-gated');
});

test('both functions are covered by the Deno type check', () => {
  const script = packageJson.scripts['typecheck:builder-edge'];
  assert.ok(script.includes('builder-portal-collaboration/index.ts'));
  assert.ok(script.includes('builder-collaboration-admin/index.ts'));
});

// ---------------------------------------------------------------------------
// Frontend wiring
// ---------------------------------------------------------------------------

test('every collaboration route is inside the Builder portal tree', () => {
  /*
   * WITHDRAWN, NOT UNROUTED. The section is not offered in this portal
   * (`builderHiddenSections.pure.ts`), so the path resolves to the notice
   * instead of the page. The rule this test protects is unchanged and is the
   * reason it still asserts: the path must live INSIDE the Builder portal
   * tree, never in the internal dashboard tree.
   */
  const builderTree = app.slice(app.indexOf('<Route path="/builder/*"'));
  for (const [path, element] of [
    // Documents is withdrawn from this portal; the other three are offered.
    ['documents', 'BuilderSectionWithdrawn'], ['messages', 'BuilderMessages'],
    ['tasks', 'BuilderTasks'], ['notifications', 'BuilderNotifications'],
  ]) {
    assert.ok(builderTree.includes(`<Route path="${path}" element={<${element} />} />`),
      `${path} is not routed inside the Builder portal tree`);
  }
  assert.match(app, /const BuilderDocuments = lazyWithRetry/);
});

test('no navigation item is left disabled now that every module is built', () => {
  assert.ok(!layout.includes('available: false'),
    'a completed module is still rendered as unavailable');
  for (const label of ['Documents', 'Messages', 'Tasks', 'Notifications']) {
    assert.ok(layout.includes(`label: '${label}'`), `${label} is missing from the navigation`);
  }
});

test('the browser never reaches the database directly', () => {
  for (const [name, code] of [['queries', queries], ['admin panel', adminPanel],
    ...PORTAL_PAGES]) {
    assert.ok(!code.includes('supabase.from('),
      `the ${name} module queries the database directly instead of an Edge Function`);
  }
  assert.ok(queries.includes("invoke('builder-portal-collaboration'"));
  assert.ok(adminPanel.includes("'builder-collaboration-admin'"));
});

test('collaboration queries do not retry a 4xx answer', () => {
  for (const hook of ['useScopedList', 'useBuilderScopedTasks', 'useBuilderDocument',
    'useBuilderConversation', 'useBuilderMyTasks', 'useBuilderNotifications',
    'useBuilderUnreadCounts', 'useBuilderCollaborationSummary']) {
    // `useScopedList` is generic, so its name is followed by `<T>` not `(`.
    const marker = hook === 'useScopedList' ? `function ${hook}<` : `function ${hook}(`;
    const definition = queries.slice(queries.indexOf(marker));
    assert.ok(definition, `${hook} is not defined`);
    const body = definition.slice(0, definition.indexOf('\n}\n'));
    assert.match(body, /retry: retryBuilderQuery/, `${hook} does not use the shared retry policy`);
  }
});

test('a scoped list is disabled until a scope is chosen', () => {
  const definition = queries.slice(queries.indexOf('function useScopedList'));
  const body = definition.slice(0, definition.indexOf('\n}\n'));
  assert.match(body, /enabled: Boolean\(scope\.scopeType && scope\.scopeId\)/);
});

test('every task status change carries the loaded version', () => {
  const block = tasksPage.slice(tasksPage.indexOf('const changeStatus'));
  const body = block.slice(0, block.indexOf('\n  };'));
  assert.match(body, /expected_version: task\.row_version,/);
  const adminBlock = adminPanel.slice(adminPanel.indexOf('const changeTaskStatus'));
  const adminBody = adminBlock.slice(0, adminBlock.indexOf('\n  };'));
  assert.match(adminBody, /expected_version: task\.row_version,/);
  assert.match(adminBody, /if \(!reason \|\| !reason\.trim\(\)\) return;/);
});

test('every portal page renders loading, empty, error and permission-denied states', () => {
  for (const [name, code] of PORTAL_PAGES) {
    assert.ok(/\bisLoading\b/.test(code), `${name} has no loading state`);
    assert.ok(/\bisError\b/.test(code), `${name} has no error state`);
    assert.ok(code.includes('border-dashed'), `${name} has no empty state`);
  }
  // The three scoped pages additionally distinguish a permission denial.
  for (const [name, code] of PORTAL_PAGES.filter(([n]) => n !== 'notifications')) {
    assert.ok(code.includes('permissionDenied'),
      `${name} does not distinguish a permission denial from a failure`);
    assert.ok(code.includes('ShieldAlert'), `${name} has no permission-denied affordance`);
  }
});

test('the frontend models no storage path and no restricted field', () => {
  for (const [name, code] of [['domain', domain], ['admin panel', adminPanel], ...PORTAL_PAGES]) {
    assert.ok(!code.includes('storage_path'),
      `the ${name} module models a storage path the server never sends`);
    assert.doesNotMatch(code,
      /\b(paid_at|payment_reference|receipt_(date|amount|reference)|commission_(amount|rate)|aml_\w+|client_income|borrowing_\w+)\b/i,
      `the ${name} module surfaces a field it does not own`);
  }
});

test('the scope picker offers only the closed list of scopes', () => {
  const picker = stripJsComments(read('src/components/builder-portal/BuilderScopePicker.tsx'));
  assert.ok(picker.includes('BUILDER_SCOPE_TYPES'));
  for (const scope of SCOPE_TYPES) {
    assert.ok(domain.includes(`'${scope}'`), `${scope} is missing from the frontend scope list`);
  }
  assert.ok(!picker.includes('supabase.from('),
    'the scope picker queries the database directly');
});

test('the local-database verification script is wired into package.json', () => {
  assert.equal(packageJson.scripts['builder:db:verify:collaboration'],
    'node scripts/builder-portal/local-db/verify-collaboration.mjs');
});
