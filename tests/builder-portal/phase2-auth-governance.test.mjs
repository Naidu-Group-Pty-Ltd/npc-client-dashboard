/**
 * Builder / Developer Portal — Phase 2 contract tests.
 *
 * Static contract assertions over the Phase 2 migration, the eight Builder
 * authentication Edge Functions, the shared modules and the frontend wiring.
 * They run with no database and no network, so they gate every CI run.
 *
 * The behavioural half of Phase 2 — organisation-context enforcement, terms and
 * onboarding commands, reset-attempt consumption, fail-closed branches — is
 * executed against a live PostgreSQL database by
 * scripts/builder-portal/local-db/verify-phase-2.mjs, which asserts 73
 * conditions. These tests assert the shape that verification depends on, so a
 * change that would invalidate it fails here first.
 *
 * A large share of the assertions below are NEGATIVE: they exist to stop the
 * documented Solicitor Portal defects (Phase 0 NOCOPY-01…07) from being
 * reproduced in the Builder Portal by a later edit.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('../../', import.meta.url).pathname;
const read = (relative) => readFileSync(join(root, relative), 'utf8');

const MIGRATION = '20260802000000_builder_portal_phase2_auth_governance.sql';

/**
 * Strip comments before asserting "this identifier appears nowhere". Every
 * Builder file explains in prose which Solicitor defect it is correcting, so an
 * un-stripped search matches the explanation rather than the code and reports a
 * defect that does not exist.
 */
const stripSqlComments = (body) => body.replace(/--[^\n]*/g, '');
const stripJsComments = (body) =>
  body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const migrationSql = read(join('supabase/migrations', MIGRATION));
const migrationCode = stripSqlComments(migrationSql);

const AUTH_FUNCTIONS = [
  'builder-portal-login',
  'builder-portal-logout',
  'builder-portal-verify',
  'builder-portal-accept-invite',
  'builder-portal-forgot-password',
  'builder-portal-reset-password',
  'builder-portal-change-password',
  'builder-portal-invite',
];

const fn = Object.fromEntries(
  AUTH_FUNCTIONS.map((name) => [name, read(`supabase/functions/${name}/index.ts`)]),
);
const fnCode = Object.fromEntries(
  Object.entries(fn).map(([name, body]) => [name, stripJsComments(body)]),
);

const shared = {
  sessionToken: read('supabase/functions/_shared/builderSessionToken.ts'),
  sessions: read('supabase/functions/_shared/builderSessions.ts'),
  portalAuth: read('supabase/functions/_shared/builderPortalAuth.ts'),
  auth: read('supabase/functions/_shared/auth.ts'),
};
const sharedCode = Object.fromEntries(
  Object.entries(shared).map(([key, body]) => [key, stripJsComments(body)]),
);

const clientLib = read('src/lib/builderPortal.ts');
const clientLibCode = stripJsComments(clientLib);
const provider = read('src/hooks/useBuilderPortalAuth.tsx');
const gate = read('src/components/builder-portal/BuilderPortalProtectedRoute.tsx');
const layout = read('src/components/builder-portal/BuilderPortalLayout.tsx');
const app = read('src/App.tsx');
const configToml = read('supabase/config.toml');
const registry = JSON.parse(read('supabase/functions-registry/SECURITY_REGISTRY.json'));

// ---------------------------------------------------------------------------
// Migration hygiene
// ---------------------------------------------------------------------------

test('the Phase 2 migration exists and is timestamped after Phase 1', () => {
  const existing = readdirSync(join(root, 'supabase/migrations'));
  assert.ok(existing.includes(MIGRATION), `missing migration ${MIGRATION}`);
  assert.ok(MIGRATION.split('_')[0] > '20260801000600',
    'Phase 2 must sort after the last Phase 1 migration');
});

test('the Phase 2 migration is additive — it drops no Phase 1 object', () => {
  // DROP TRIGGER / DROP POLICY / DROP CONSTRAINT ... IF EXISTS immediately
  // before a matching CREATE is the repository's idempotent-redefinition
  // idiom, not a removal. Anything else would be a destructive change.
  const destructive = migrationCode.match(
    /DROP\s+(TABLE|COLUMN|FUNCTION|INDEX|SCHEMA|TYPE)\b/gi) || [];
  assert.deepEqual(destructive, [],
    `Phase 2 must not drop existing objects, found: ${destructive.join(', ')}`);
});

test('every new Phase 2 object is created idempotently', () => {
  for (const [what, pattern] of [
    ['builder_onboarding_steps', /CREATE TABLE IF NOT EXISTS public\.builder_onboarding_steps/],
    ['onboarding index', /CREATE INDEX IF NOT EXISTS builder_onboarding_steps_user_idx/],
    ['session organisation column', /ADD COLUMN IF NOT EXISTS active_organisation_id/],
    ['login attempt columns', /ADD COLUMN IF NOT EXISTS failed_login_attempts/],
  ]) {
    assert.match(migrationCode, pattern, `${what} is not created idempotently`);
  }
});

test('every Phase 2 function is SECURITY DEFINER with a pinned search_path', () => {
  const definitions = migrationCode.match(
    /CREATE OR REPLACE FUNCTION public\.(\w+)[\s\S]*?LANGUAGE plpgsql[^\n]*/g) || [];
  assert.ok(definitions.length >= 6, `expected at least 6 functions, found ${definitions.length}`);
  for (const definition of definitions) {
    assert.match(definition, /SET search_path = public/,
      `a Phase 2 function does not pin search_path: ${definition.slice(0, 90)}`);
  }
});

test('no Phase 2 policy is written with an unrestricted USING (true)', () => {
  assert.doesNotMatch(migrationCode, /USING\s*\(\s*true\s*\)/i);
  assert.doesNotMatch(migrationCode, /WITH CHECK\s*\(\s*true\s*\)/i);
});

test('the new table is RLS-protected and revoked from anon and authenticated', () => {
  assert.match(migrationCode, /ALTER TABLE public\.builder_onboarding_steps ENABLE ROW LEVEL SECURITY/);
  assert.match(migrationCode, /REVOKE ALL ON public\.builder_onboarding_steps FROM anon, authenticated/);
});

test('every Phase 2 function is revoked from PUBLIC, anon and authenticated', () => {
  for (const name of [
    'builder_ensure_onboarding_steps',
    'builder_select_session_organisation',
    'builder_accept_current_terms',
    'builder_complete_onboarding',
    'consume_builder_portal_reset_attempt',
  ]) {
    assert.ok(
      migrationCode.includes(`REVOKE ALL ON FUNCTION public.${name}`),
      `${name} is not revoked from PUBLIC/anon/authenticated`);
    assert.ok(
      migrationCode.includes(`GRANT EXECUTE ON FUNCTION public.${name}`),
      `${name} has no explicit service_role grant`);
  }
});

test('the migration introduces no plaintext credential column', () => {
  // The Solicitor schema stores session_token / reset_token in plaintext
  // (Phase 0 NOCOPY-01). Builder stores hashes only, and the migration asserts
  // this at the end of its own run as well.
  assert.doesNotMatch(migrationCode,
    /ADD COLUMN[^;]*\b(session_token|reset_token|invite_token)\b(?!_hash)/);
  assert.match(migrationCode, /POST-MIGRATION FAILURE: a plaintext credential column exists/);
});

test('the rollout default is asserted to stay off', () => {
  assert.match(migrationCode, /builder_portal_identity_v1/);
  assert.match(migrationCode, /Phase 2 requires off/);
});

test('the migration enables no rollout row', () => {
  // Enabling a rollout would switch the external portal on for real
  // organisations. Phase 2 may define the plane; it may not turn it on.
  assert.doesNotMatch(migrationCode,
    /INSERT INTO\s+public\.cross_portal_firm_rollouts/i);
  assert.doesNotMatch(migrationCode,
    /UPDATE\s+public\.cross_portal_firm_rollouts[\s\S]{0,200}SET[\s\S]{0,200}mode\s*=\s*'(shadow|dual_read|dual_write|cutover)'/i);
});

test('the organisation context is guarded by a trigger, not only by a function', () => {
  // A guarded command alone can be bypassed by any future code path that writes
  // the column directly. The trigger is what makes the rule unconditional.
  assert.match(migrationCode, /CREATE TRIGGER trg_builder_guard_session_organisation/);
  assert.match(migrationCode, /BEFORE INSERT OR UPDATE OF active_organisation_id/);
  assert.match(migrationCode, /BUILDER_ORGANISATION_NOT_ACCESSIBLE/);
});

test('the reset-attempt function compares a hash and never returns a secret', () => {
  const definition = migrationCode.slice(
    migrationCode.indexOf('FUNCTION public.consume_builder_portal_reset_attempt'));
  assert.match(definition, /p_token_hash/);
  // It answers with a status and an id; it must not hand back the stored hash
  // or any token material.
  assert.match(definition, /RETURNS TABLE \(status text, user_id uuid/);
  assert.doesNotMatch(definition.split('END $$')[0], /RETURN QUERY[\s\S]*reset_token_hash/);
});

test('a wrong reset code is reported identically to an unknown account', () => {
  const definition = migrationCode.slice(
    migrationCode.indexOf('FUNCTION public.consume_builder_portal_reset_attempt'));
  const mismatchBranch = definition.slice(definition.indexOf('IS DISTINCT FROM p_token_hash'));
  assert.match(mismatchBranch.slice(0, 200), /status := 'not_found'/,
    'a hash mismatch must not be distinguishable from an unknown account');
});

// ---------------------------------------------------------------------------
// Governance correctness — the three Phase 2 corrections
// ---------------------------------------------------------------------------

test('terms acceptance is version-exact, derived exactly as the Solicitor derives it', () => {
  // Mirrors resolveSolicitorSession: look up the CURRENT terms version, then an
  // acceptance row for THAT version. Reading the stored flag would leave every
  // existing user showing as accepted when a new version is published.
  assert.match(sharedCode.portalAuth, /from\('portal_terms_acceptances'\)/,
    'the resolver does not look up an acceptance row at all');
  assert.match(sharedCode.portalAuth, /\.eq\('terms_version_id', terms\.id\)/,
    'the acceptance lookup is not keyed on the current terms version');
  assert.match(sharedCode.portalAuth, /\.eq\('builder_user_id', user\.id\)/,
    'the acceptance lookup is not keyed on the authenticated user');
  assert.match(sharedCode.portalAuth, /has_accepted_current_terms: !!terms && !!acceptance/,
    'has_accepted_current_terms is not derived from a live acceptance row');
  assert.doesNotMatch(sharedCode.portalAuth,
    /has_accepted_current_terms: !!user\.has_accepted_current_terms/,
    'the resolver still returns the stored flag as the version-exact answer');
});

test('mandatory onboarding is derived from the steps, as the Solicitor derives it', () => {
  assert.match(sharedCode.portalAuth, /from\('builder_onboarding_steps'\)/);
  assert.match(sharedCode.portalAuth, /has_completed_mandatory_onboarding: mandatoryComplete/);
});

test('the governance gate and the route gate both use the derived values', () => {
  const governance = sharedCode.portalAuth.slice(
    sharedCode.portalAuth.indexOf('export function builderGovernanceError'));
  assert.match(governance.slice(0, 500), /has_completed_mandatory_onboarding\) return 'onboarding_required'/,
    'the server governance error still gates on the stored onboarding flag');
  assert.match(gate, /if \(!user\.has_completed_mandatory_onboarding\)/,
    'the route gate still gates on the stored onboarding flag');
});

test('terms and onboarding commands validate session ownership in the database', () => {
  // The same check builder_select_session_organisation performs. Without it the
  // function trusts whatever (user, session) pair it is handed.
  for (const name of ['builder_accept_current_terms', 'builder_complete_onboarding']) {
    const definition = migrationCode.slice(migrationCode.indexOf(`FUNCTION public.${name}`));
    const body = definition.slice(0, definition.indexOf('END $$'));
    assert.match(body, /FROM public\.builder_portal_sessions/,
      `${name} does not check the session at all`);
    assert.match(body, /WHERE id = _session_id AND builder_user_id = _builder_user_id AND revoked_at IS NULL/,
      `${name} does not validate that the session belongs to the user and is live`);
    assert.match(body, /BUILDER_SESSION_NOT_FOUND/,
      `${name} does not fail closed on an unowned session`);
  }
});

test('an unowned session on terms or onboarding is reported as an auth failure', () => {
  const verify = fnCode['builder-portal-verify'];
  const occurrences = verify.match(/BUILDER_SESSION_NOT_FOUND/g) || [];
  assert.ok(occurrences.length >= 2,
    'the verify function does not map BUILDER_SESSION_NOT_FOUND on both governance actions');
  assert.match(verify, /code: 'auth_required' \}, 401/);
});

test('the password reset is atomically single-use', () => {
  const reset = fnCode['builder-portal-reset-password'];
  // The completing UPDATE must still require the code's hash, so exactly one of
  // two concurrent requests carrying the same valid code matches a row.
  assert.match(reset, /\.eq\('reset_token_hash', otpHash\)/,
    'the completing update does not re-assert the code, so it is not single-use');
  assert.match(reset, /\.select\('id'\)\s*\n?\s*\.maybeSingle\(\)/,
    'the completing update does not read back whether it matched a row');
  assert.match(reset, /if \(!updated\) return json\(\{ error: GENERIC_CODE_ERROR \}, 400\)/,
    'a losing concurrent reset is not rejected with the generic error');
  // Ordering: the guard must precede session revocation and the audit write.
  // Anchored on the CALL, not the identifier — the import line appears first.
  assert.ok(reset.indexOf('if (!updated)') < reset.indexOf('await revokeAllBuilderSessions('),
    'the single-use guard runs after the reset has already taken effect');
});

test('the single-use idiom matches the one the invite flow already uses', () => {
  // Same pattern, same file family — not a new mechanism invented for reset.
  const invite = fnCode['builder-portal-accept-invite'];
  assert.match(invite, /\.eq\('invite_token_hash', tokenHash\)/);
  assert.match(invite, /\.maybeSingle\(\)/);
});

// ---------------------------------------------------------------------------
// Session transport — NOCOPY-01, NOCOPY-02, NOCOPY-05
// ---------------------------------------------------------------------------

test('the Builder session cookie is __Host- prefixed, HttpOnly and Secure', () => {
  assert.match(sharedCode.auth, /__Host-builder_session_token/);
  const cookieFn = sharedCode.auth.slice(sharedCode.auth.indexOf('createBuilderSessionCookie'));
  assert.match(cookieFn.slice(0, 700), /HttpOnly/);
  assert.match(cookieFn.slice(0, 700), /Secure/);
  assert.match(cookieFn.slice(0, 700), /Path=\//);
});

test('a Builder session is only ever read from the cookie', () => {
  // The Solicitor resolver accepts a session token from a header or a request
  // body (Phase 0 NOCOPY-02). The Builder extractor takes headers only, and
  // reads only the cookie header from them.
  assert.doesNotMatch(sharedCode.sessionToken, /body\s*[.[]/);
  assert.match(sharedCode.sessionToken, /BUILDER_SESSION_COOKIE/);
  assert.doesNotMatch(sharedCode.sessionToken, /authorization['"]?\s*\)\s*\?\.\s*replace/i);
});

test('resolveBuilderSession takes a Request, never a caller-supplied body', () => {
  assert.match(sharedCode.portalAuth,
    /export async function resolveBuilderSession\(\s*supabase: any,\s*req: Request,\s*\)/);
});

test('no Builder Edge Function returns a raw session token in its JSON body', () => {
  for (const [name, body] of Object.entries(fnCode)) {
    // A token may only leave through Set-Cookie.
    assert.doesNotMatch(body, /session_token\s*:/,
      `${name} appears to return a session token in its response body`);
    assert.doesNotMatch(body, /token:\s*issued\.token/,
      `${name} appears to return the raw session token`);
  }
});

test('every function that issues or clears a session does so through Set-Cookie', () => {
  for (const name of ['builder-portal-login', 'builder-portal-change-password']) {
    assert.match(fnCode[name], /'Set-Cookie': createBuilderSessionCookie\(/,
      `${name} must deliver the session through Set-Cookie`);
  }
  for (const name of ['builder-portal-logout', 'builder-portal-verify', 'builder-portal-reset-password']) {
    assert.match(fnCode[name], /createClearBuilderSessionCookie\(\)/,
      `${name} must clear the cookie rather than leaving a stale one`);
  }
});

test('session hashing is peppered and fails closed', () => {
  assert.match(sharedCode.sessions, /isSessionHashConfigured\(\)/);
  assert.match(sharedCode.sessions, /refusing to issue an unpeppered session/);
  assert.match(shared.sessions, /hashSessionToken/);
  assert.doesNotMatch(sharedCode.sessions, /createHash\(\s*['"]sha256['"]\s*\)/,
    'a bare SHA-256 would drop the pepper');
});

// ---------------------------------------------------------------------------
// CSRF — NOCOPY-06
// ---------------------------------------------------------------------------

test('every mutating Builder function passes the central CSRF guard', () => {
  for (const name of [
    'builder-portal-logout',
    'builder-portal-verify',
    'builder-portal-change-password',
    'builder-portal-invite',
  ]) {
    assert.match(fnCode[name], /enforceCsrf\(req\)/, `${name} does not enforce CSRF`);
    assert.match(fnCode[name], /csrfDenied\(corsHeaders,/,
      `${name} calls csrfDenied with the wrong argument order`);
  }
});

test('the portal-request header and origin allow-list are enforced', () => {
  assert.match(sharedCode.sessionToken, /x-portal-request/);
  assert.match(sharedCode.sessionToken, /builder-portal/);
  assert.match(clientLibCode, /'X-Portal-Request': 'builder-portal'/);
});

test('a session issued for another portal cannot be presented to Builder', () => {
  assert.match(sharedCode.sessionToken, /carriesForeignPortalSession/);
});

// ---------------------------------------------------------------------------
// Account enumeration and login ordering — NOCOPY-07
// ---------------------------------------------------------------------------

test('login always performs a password verification, even for a missing account', () => {
  const login = fnCode['builder-portal-login'];
  assert.match(login, /DUMMY_PASSWORD_HASH/);
  assert.match(login, /portalUser\?\.password_hash \|\| DUMMY_PASSWORD_HASH/,
    'the dummy hash must be used, not merely declared');
  // The verification must precede the "no such account" return.
  assert.ok(
    login.indexOf('await verifyPassword(password, candidateHash)')
      < login.indexOf('if (!portalUser || !portalUser.password_hash || !passwordValid)'),
    'the password must be verified before the missing-account branch returns');
});

test('account state is only evaluated after the password is proven', () => {
  const login = fnCode['builder-portal-login'];
  // Anchored on the code that returns for a failed credential, not on a
  // comment — `fnCode` is comment-stripped, so a prose anchor never matches.
  const passwordProven = login.indexOf('if (!portalUser || !portalUser.password_hash || !passwordValid)');
  assert.ok(passwordProven > 0, 'the credential-failure branch was restructured');
  assert.ok(login.indexOf('portalUser.locked_until') > passwordProven,
    'lockout state is checked before the password — that leaks account state');
  assert.ok(login.indexOf('portalUser.status !== \'active\'') > passwordProven,
    'account status is checked before the password — that leaks account state');
});

test('every credential failure returns one generic message', () => {
  const login = fnCode['builder-portal-login'];
  assert.match(login, /GENERIC_AUTH_ERROR/);
  // No branch may distinguish locked / inactive / unknown / wrong password.
  assert.doesNotMatch(login, /error: ['"][^'"]*locked[^'"]*['"]/i);
  assert.doesNotMatch(login, /error: ['"][^'"]*no such (account|user)[^'"]*['"]/i);
  assert.doesNotMatch(login, /error: ['"][^'"]*not found[^'"]*['"]/i);
});

test('invite validation returns one generic message for every rejection', () => {
  const invite = fnCode['builder-portal-accept-invite'];
  assert.match(invite, /GENERIC_INVITE_ERROR/);
  assert.doesNotMatch(invite, /error: ['"][^'"]*already accepted[^'"]*['"]/i);
});

test('the forgot-password response does not reveal whether an account exists', () => {
  const forgot = fnCode['builder-portal-forgot-password'];
  assert.doesNotMatch(forgot, /error: ['"][^'"]*(no account|not found|unknown email)[^'"]*['"]/i);
});

test('login is rate limited before any account lookup', () => {
  const login = fnCode['builder-portal-login'];
  assert.ok(
    login.indexOf('check_and_bump_rate_limit') < login.indexOf("from('builder_portal_users')"),
    'the throttle must run before the lookup so enumeration cannot outrun it');
});

// ---------------------------------------------------------------------------
// Auditing — NOCOPY-04
// ---------------------------------------------------------------------------

test('auditBuilderIdentity reports success rather than swallowing failure', () => {
  assert.match(sharedCode.sessions, /Promise<boolean>/);
  assert.match(sharedCode.sessions, /return false;/);
});

test('a password change fails closed when its audit row cannot be written', () => {
  const change = fnCode['builder-portal-change-password'];
  assert.match(change, /const logged = await auditBuilderIdentity/);
  assert.match(change, /if \(!logged\)/);
  assert.match(change, /revokeAllBuilderSessions\(supabase, record\.id, 'audit_write_failed'\)/);
});

test('the terms, onboarding and organisation commands audit inside their transaction', () => {
  for (const name of [
    'builder_accept_current_terms',
    'builder_complete_onboarding',
    'builder_select_session_organisation',
  ]) {
    const definition = migrationCode.slice(
      migrationCode.indexOf(`FUNCTION public.${name}`));
    const body = definition.slice(0, definition.indexOf('END $$'));
    assert.match(body, /PERFORM public\.builder_log_activity\(/,
      `${name} does not write a trusted audit row`);
  }
});

// ---------------------------------------------------------------------------
// Permissions — NOCOPY-03 (default allow) and OR-merged permissions
// ---------------------------------------------------------------------------

test('the permission helper denies by default', () => {
  assert.match(sharedCode.portalAuth, /builderCan/);
  // There must be no fallback that grants when a key is absent.
  assert.doesNotMatch(sharedCode.portalAuth, /\?\?\s*true/);
  assert.doesNotMatch(sharedCode.portalAuth, /\|\|\s*true\b/);
});

test('the client-side permission read is a rendering aid, never the control', () => {
  assert.match(provider, /never an authorization control/);
  assert.match(provider, /permissions\?\.\[permissionKey\]\?\.\[level\] === true/);
});

test('forbidden data keys are enumerated and never exposed by the portal', () => {
  assert.match(sharedCode.portalAuth, /BUILDER_FORBIDDEN_KEYS/);
  for (const forbidden of [
    'builder_invoices',
    'build_progress_payments',
    'commission',
    'aml',
  ]) {
    assert.ok(shared.portalAuth.includes(forbidden),
      `${forbidden} is not named in the forbidden-key list`);
  }
});

test('no Builder Edge Function selects from the Finance-owned builder tables', () => {
  for (const [name, body] of Object.entries(fnCode)) {
    assert.doesNotMatch(body, /from\(['"]builder_invoices['"]\)/,
      `${name} reaches into the Finance-owned builder_invoices`);
    assert.doesNotMatch(body, /from\(['"]build_progress_payments['"]\)/,
      `${name} reaches into the Finance-owned build_progress_payments`);
  }
});

// ---------------------------------------------------------------------------
// Client transport — no Web Storage, no token parameters
// ---------------------------------------------------------------------------

test('the client library carries the session by cookie alone', () => {
  assert.match(clientLibCode, /credentials: 'include'/);
  assert.doesNotMatch(clientLibCode, /localStorage/);
  assert.doesNotMatch(clientLibCode, /sessionStorage/);
  assert.doesNotMatch(clientLibCode, /document\.cookie/);
});

test('no client function accepts a session token argument', () => {
  assert.doesNotMatch(clientLibCode, /session_token/);
  assert.doesNotMatch(clientLibCode, /sessionToken/);
});

test('no Builder frontend file touches Web Storage', () => {
  const files = [
    'src/hooks/useBuilderPortalAuth.tsx',
    'src/components/builder-portal/BuilderPortalProtectedRoute.tsx',
    'src/components/builder-portal/BuilderPortalLayout.tsx',
    'src/components/builder-portal/BuilderOrganisationSwitcher.tsx',
    /*
     * FILES, NOT ENTRIES. `src/pages/builder` holds a `__tests__/`
     * directory — the convention `src/pages/{admin,aml,calculators}`
     * already follow — and `read()` on a directory throws EISDIR, so this
     * failed on a name rather than on a finding. The sibling readdir in
     * `portal-presentation.test.mjs` filtered from the start; this one
     * did not.
     */
    ...readdirSync(join(root, 'src/pages/builder'))
      .filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))
      .map((f) => `src/pages/builder/${f}`),
  ];
  for (const file of files) {
    const body = stripJsComments(read(file));
    assert.doesNotMatch(body, /localStorage|sessionStorage|document\.cookie/,
      `${file} must not persist authentication state in the browser`);
  }
});

test('the provider re-reads governance from the server after every mutation', () => {
  // Trusting the login response would let a stale or crafted payload decide
  // whether terms and onboarding are outstanding.
  for (const mutation of ['signIn', 'acceptInvite', 'changePassword', 'acceptTerms',
    'completeOnboarding', 'selectOrganisation']) {
    const slice = provider.slice(provider.indexOf(`const ${mutation} = useCallback`));
    assert.match(slice.slice(0, 900), /await checkSession\(\)/,
      `${mutation} does not re-read the session from the server`);
  }
});

// ---------------------------------------------------------------------------
// Route placement and the governance gate
// ---------------------------------------------------------------------------

test('the Builder route tree is a sibling of the internal Command Centre tree', () => {
  assert.match(app, /<Route path="\/builder\/\*" element=\{/);
  const builderTree = app.slice(app.indexOf('<Route path="/builder/*"'));
  const treeEnd = builderTree.indexOf('{/* Internal Dashboard Routes */}');
  const tree = builderTree.slice(0, treeEnd > 0 ? treeEnd : 4000);
  assert.doesNotMatch(tree, /<ProtectedRoute>/,
    'the Builder Portal must not be wrapped in the internal ProtectedRoute');
  assert.doesNotMatch(tree, /<DashboardLayout/,
    'the Builder Portal must not be an internal dashboard page');
  assert.match(tree, /<BuilderPortalAuthProvider>/);
});

test('every gate destination has a route, so the gate cannot loop', () => {
  const builderTree = app.slice(app.indexOf('<Route path="/builder/*"'));
  for (const path of [
    'login', 'accept-invite', 'forgot-password', 'reset-password',
    'change-password', 'select-organisation', 'terms', 'onboarding',
  ]) {
    assert.ok(builderTree.includes(`path="${path}"`),
      `/builder/${path} is a gate destination with no route`);
  }
});

// The gate body starts after the unauthenticated stage. Searching the whole
// file would match the destructuring at the top of the component, which names
// every stage in an order that has nothing to do with evaluation order.
const gateBody = gate.slice(gate.indexOf("<Navigate to=\"/builder/login\""));

test('each gate stage lets its own destination render instead of redirecting again', () => {
  for (const [stage, path] of [
    ['must_change_password', '/builder/change-password'],
    ['requiresOrganisationSelection', '/builder/select-organisation'],
    ['has_accepted_current_terms', '/builder/terms'],
    ['has_completed_mandatory_onboarding', '/builder/onboarding'],
  ]) {
    const slice = gateBody.slice(gateBody.indexOf(stage));
    assert.match(slice.slice(0, 400), new RegExp(`location\\.pathname === '${path}'`),
      `the ${stage} stage would redirect to ${path} while already on it`);
  }
});

test('the gate order matches the documented governance order', () => {
  const order = ['must_change_password', 'requiresOrganisationSelection',
    'has_accepted_current_terms', 'has_completed_mandatory_onboarding'];
  let previous = 0;
  for (const stage of order) {
    const index = gateBody.indexOf(stage);
    assert.ok(index > previous, `gate stage ${stage} is missing or out of order`);
    previous = index;
  }
});

test('no navigation item links to a placeholder', () => {
  // Phase 2 delivered no business domain, so every item was disabled then. Each
  // moved to `available: true` as its module landed; the portal is now complete,
  // so what this asserts is the other half of the same rule — nothing is linked
  // that has no module, and nothing built is left unreachable.
  const items = [...layout.matchAll(/\{ to: '([^']+)', label: '([^']+)'[^}]*available: (true|false)/g)];
  assert.ok(items.length >= 10, 'the navigation list could not be parsed');
  for (const [, to, label, available] of items) {
    assert.equal(available, 'true', `${label} is built and must not be rendered as unavailable`);
    assert.ok(to.startsWith('/builder'), `${label} points outside the portal tree`);
  }
  // The disabled affordance itself stays, so a future unbuilt item cannot be
  // linked to a placeholder instead.
  assert.match(layout, /becomes available in a later phase/);
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test('every Builder Edge Function is declared in supabase/config.toml', () => {
  for (const name of AUTH_FUNCTIONS) {
    assert.ok(configToml.includes(`[functions.${name}]`),
      `${name} is missing from supabase/config.toml`);
  }
});

test('every Builder Edge Function is listed in the security registry', () => {
  for (const name of AUTH_FUNCTIONS) {
    const entry = registry.functions[name];
    assert.ok(entry, `${name} is missing from SECURITY_REGISTRY.json`);
    assert.equal(entry.owner, 'builder-portal-program');
    assert.ok(entry.exposure_class, `${name} has no exposure class`);
  }
});

test('verify_jwt agrees between config.toml and the security registry', () => {
  for (const name of AUTH_FUNCTIONS) {
    const declared = configToml
      .slice(configToml.indexOf(`[functions.${name}]`))
      .split('\n')[1];
    const expected = registry.functions[name].verify_jwt;
    assert.equal(declared.trim(), `verify_jwt = ${expected}`,
      `${name}: config.toml and the registry disagree on verify_jwt`);
  }
});

test('the internal invite function requires a Command Centre JWT', () => {
  // It is the one Builder function that is staff-facing, so it is the one that
  // must NOT be reachable without an internal session.
  assert.equal(registry.functions['builder-portal-invite'].verify_jwt, true);
  assert.match(fnCode['builder-portal-invite'], /requireModulePermission/);
  assert.match(fnCode['builder-portal-invite'], /builder_portal_admin/);
});

test('the scoped Deno type-check covers every Builder Edge Function', () => {
  const pkg = JSON.parse(read('package.json'));
  const command = pkg.scripts['typecheck:builder-edge'];
  assert.ok(command, 'typecheck:builder-edge is not defined');
  for (const name of [...AUTH_FUNCTIONS, 'builder-portal-admin']) {
    assert.ok(command.includes(`supabase/functions/${name}/index.ts`),
      `${name} is outside the scoped type-check, so signature drift there is invisible`);
  }
});

test('the Phase 2 database verification script is wired into package.json', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.scripts['builder:db:verify:phase2'],
    'the Phase 2 verification script has no npm entry point');
  assert.ok(existsSync(join(root, 'scripts/builder-portal/local-db/verify-phase-2.mjs')));
});
