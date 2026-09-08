/**
 * Builder / Developer Portal Admin — Command Centre control plane (Phase 1)
 *
 * Every builder-organisation, portal-user and membership administration
 * operation funnels through this one service-role function. Staff callers are
 * gated deny-by-default on the `builder_portal_admin` module permission
 * (superadmin bypass preserved), and mutations additionally require CSRF
 * validation because the staff session is cookie-carried.
 *
 * This function serves the INTERNAL surface only. It resolves a Command Centre
 * session and never accepts a Builder Portal session cookie. The external
 * `/builder/*` portal is served by a separate `builder-portal-*` family that
 * resolves a builder session and never accepts a staff JWT. No function accepts
 * either (ADR 018).
 *
 * Operations
 *   Organisations: list_organisations | upsert_organisation | set_organisation_status
 *                  | delete_organisation
 *   Users:         list_users | create_user | update_user | set_user_status
 *                  | delete_user
 *   Memberships:   list_memberships | upsert_membership | revoke_membership
 *                  | delete_membership
 *   Permissions:   get_membership_permissions | update_membership_permissions
 *   Sessions:      list_user_sessions | revoke_user_sessions
 *   Reference:     get_permission_catalogue
 *
 * The three delete_* operations are permanent removal. Each delegates to a
 * guarded command that, under a lock on the parent, sorts dependants into two
 * categories:
 *
 *   Access and account records — memberships (live or revoked), permission
 *   overrides, sessions, access grants, onboarding, preferences, notifications,
 *   conversation participation, organisation settings. Deleted with the parent
 *   in the same transaction, because they describe access and cannot outlive
 *   the thing they grant it to.
 *
 *   Business and historical work — projects, inventory, reservations,
 *   transactions, construction records, documents, authored messages, tasks.
 *   These refuse the removal with 409 `has_dependents`; revoke, suspend or
 *   close is the answer then, and each preserves everything.
 *
 * Nothing here cascade-deletes a business record, and a removal either
 * completes or rolls back whole.
 *
 * Boundary invariants enforced here, not merely documented:
 *   * Forbidden permission keys are stripped server-side before any write.
 *   * Organisation ids supplied by the browser are never trusted as authority;
 *     the module permission is the authority and every child write is scoped to
 *     a re-read parent.
 *   * `builder_invoices` and `build_progress_payments` are Finance-owned and are
 *     never read or written here.
 *   * Mutable aggregates use expected_version; a stale write returns HTTP 409.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.55.0";
import { createCorsHeaders, createForbiddenResponse, verifyAuth } from "../_shared/auth.ts";
import { requireModulePermission, type ModulePerm } from "../_shared/authz.ts";
import { enforceCsrf, csrfDenied } from "../_shared/csrfGuard.ts";
import { internalError } from '../_shared/errorResponse.ts';

const MODULE_KEY = 'builder_portal_admin';

const ORG_TYPES = new Set(['developer', 'builder', 'builder_developer', 'sales_representative']);
const ORG_STATUSES = new Set(['pending_activation', 'active', 'suspended', 'closed']);
const USER_STATUSES = new Set(['invited', 'active', 'suspended', 'revoked']);
const MEMBERSHIP_ROLES = new Set(['owner', 'administrator', 'manager', 'member', 'read_only']);
const AU_STATES = new Set(['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT']);
const DECISIONS = new Set(['inherit', 'allow', 'deny']);

const READ_OPERATIONS = new Set([
  'list_organisations', 'list_users', 'list_memberships',
  'get_membership_permissions', 'list_user_sessions', 'get_permission_catalogue',
]);

/** Operations that mutate state require can_edit rather than can_view. */
function requiredPermFor(operation: string): ModulePerm {
  return READ_OPERATIONS.has(operation) ? 'can_view' : 'can_edit';
}

/**
 * Why this user may not be moved to `status = active`, or null if they may.
 *
 * Activation is the end of the invitation flow, never a shortcut around it. The
 * database command `builder_admin_set_user_status` will happily flip any row to
 * active, so without this an administrator could mark an invited, passwordless
 * account active: it would then satisfy `builder_accessible_organisations` and
 * appear to have access while having no credential to sign in with, and no
 * audit record of ever having accepted anything.
 *
 * Restoring a genuinely suspended user passes every check here, which is the
 * point — the same guard that blocks a fake activation permits a real one.
 */
async function activationBlocker(
  supabase: any,
  userId: string,
  user: { status?: string; revoked_at?: string | null; invite_accepted_at?: string | null; password_hash?: string | null },
): Promise<{ error: string; code: string } | null> {
  if (user.revoked_at || user.status === 'revoked') {
    return {
      error: 'This user has been revoked. Restore them to suspended first, then activate.',
      code: 'user_revoked',
    };
  }
  if (!user.invite_accepted_at || !user.password_hash) {
    return {
      error: 'This user has not accepted their invitation and set a password yet. '
        + 'Send an invitation instead of activating the account manually.',
      code: 'invitation_not_accepted',
    };
  }

  const { data: memberships } = await supabase
    .from('builder_organisation_memberships')
    .select('organisation_id, status, valid_from, valid_until')
    .eq('builder_user_id', userId).is('revoked_at', null);
  if (!Array.isArray(memberships) || !memberships.length) {
    return {
      error: 'This user has no organisation membership and would have no access. '
        + 'Grant a membership first.',
      code: 'no_membership',
    };
  }

  // Mirrors builder_accessible_organisations, minus the user-active predicate
  // this call is about to satisfy.
  const now = Date.now();
  const current = memberships.filter((membership: any) =>
    membership.status === 'active'
    && (!membership.valid_from || new Date(membership.valid_from).getTime() <= now)
    && (!membership.valid_until || new Date(membership.valid_until).getTime() > now));
  if (!current.length) {
    return {
      error: 'This user has no currently valid organisation membership. '
        + 'Grant or reinstate a membership first.',
      code: 'no_membership',
    };
  }

  const { data: organisations } = await supabase
    .from('builder_organisations').select('id, status')
    .in('id', current.map((membership: any) => membership.organisation_id));
  const open = (organisations ?? []).filter((organisation: any) => organisation.status !== 'closed');
  if (!open.length) {
    return {
      error: 'Every organisation this user belongs to is closed. '
        + 'Grant a membership of an open organisation first.',
      code: 'organisation_closed',
    };
  }

  return null;
}

const json = (body: unknown, status: number, cors: Record<string, string>) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...cors, 'Content-Type': 'application/json' },
  });

const trimmed = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const out = value.trim();
  return out.length ? out : null;
};

const digitsOnly = (value: unknown): string | null => {
  const raw = trimmed(value);
  return raw ? raw.replace(/[^0-9]/g, '') || null : null;
};

/**
 * A refused organisation write, said in words.
 *
 * The organisation create/update path writes the table directly rather than
 * through a guarded command, so its failures arrived as raw PostgreSQL faults
 * and the outer catch flattened every one of them into "Internal error" — which
 * is what an administrator saw when they created an organisation whose legal
 * name, ABN or ACN already existed, or whose postcode/e-mail the column
 * refused. Nothing was wrong with the request the operator could not have
 * fixed; they were simply never told.
 *
 * Returns null for a fault that is genuinely ours, so an unrecognised error
 * stays opaque.
 */
const ORG_CONSTRAINT_MESSAGE: Array<[RegExp, string]> = [
  [/builder_organisations_legal_name_key/, 'An organisation with this legal name already exists.'],
  [/builder_organisations_abn_key/, 'Another organisation is already recorded against this ABN.'],
  [/builder_organisations_acn_key/, 'Another organisation is already recorded against this ACN.'],
  [/builder_organisations_postcode_check|postcode/, 'Postcode must be four digits.'],
  [/contact_email/, 'Enter a valid contact email address.'],
  [/builder_organisations_abn_check|abn/, 'ABN must be 11 digits.'],
  [/builder_organisations_acn_check|acn/, 'ACN must be 9 digits.'],
  [/legal_name/, 'A legal name is required.'],
  [/org_type/, 'Choose an organisation type.'],
  [/state/, 'State must be an Australian state or territory.'],
];

const organisationWriteFailure = (
  error: { message?: string; details?: string; code?: string } | null | undefined,
): { error: string; code: string } | null => {
  if (!error) return null;
  const text = `${error.message ?? ''} ${error.details ?? ''}`;
  const isConstraint = error.code === '23505' || error.code === '23514'
    || error.code === '23502' || /duplicate key value|violates check constraint|null value in column/.test(text);
  if (!isConstraint) return null;
  for (const [pattern, message] of ORG_CONSTRAINT_MESSAGE) {
    if (pattern.test(text)) {
      return { error: message, code: error.code === '23505' ? 'duplicate' : 'invalid_field' };
    }
  }
  return { error: 'Some of these organisation details were refused. Check the fields and try again.', code: 'invalid_field' };
};

/** Column allow-lists. No handler ever selects `*`. */
const ORG_SELECT = `id, legal_name, trading_name, org_type, abn, acn, contact_email,
  contact_phone, website, address_line1, address_line2, suburb, state, postcode,
  status, is_active, activated_at, suspended_at, suspension_reason, notes,
  row_version, created_at, updated_at`;

/**
 * The only portal-user fields that may leave this function. `projectUser` picks
 * from exactly this list, so the guarantee is structural rather than a
 * blacklist that a new column could slip past.
 *
 * Deliberately absent: `password_hash`, `invite_token_hash`, `reset_token_hash`
 * and every session token hash. An administrator has no use for them and a
 * leaked hash is a replayable credential.
 */
const SAFE_USER_FIELDS = [
  'id', 'email', 'name', 'phone', 'job_title', 'status', 'is_active',
  'must_change_password', 'has_accepted_current_terms', 'has_completed_onboarding',
  'invite_accepted_at', 'invited_at', 'invite_token_expires_at', 'last_login_at',
  'last_seen_at', 'revoked_at', 'revoked_reason',
  'row_version', 'created_at', 'updated_at',
] as const;

/**
 * Spelled out rather than joined from `SAFE_USER_FIELDS`: PostgREST infers the
 * row type from a literal select string, and a computed one erases it to
 * `GenericStringError`. A contract test asserts the two stay in step.
 */
const USER_SELECT = `id, email, name, phone, job_title, status, is_active,
  must_change_password, has_accepted_current_terms, has_completed_onboarding,
  invite_accepted_at, invited_at, invite_token_expires_at, last_login_at,
  last_seen_at, revoked_at, revoked_reason,
  row_version, created_at, updated_at`;

/**
 * `password_hash` is read only so the server can answer "has this account
 * finished setup?"; `projectUser` drops it before anything is returned.
 */
const USER_SELECT_INTERNAL = `${USER_SELECT}, password_hash`;

/**
 * The only shape a portal user leaves this function in.
 *
 * The derived `has_completed_account_setup` tells the Command Centre whether the
 * user has actually been through the invitation flow, without exposing the hash
 * that proves it. `builder_admin_set_user_status` returns the whole
 * `builder_portal_users` row — token hashes included — so its result must be
 * projected too, not just the rows this function selects itself.
 */
const projectUser = (row: Record<string, any> | null | undefined) => {
  if (!row) return row;
  const safe: Record<string, unknown> = {};
  for (const field of SAFE_USER_FIELDS) {
    if (field in row) safe[field] = row[field];
  }
  safe.has_completed_account_setup = !!row.password_hash && !!row.invite_accepted_at;
  return safe;
};

const MEMBERSHIP_SELECT = `id, builder_user_id, organisation_id, membership_role,
  is_primary, status, valid_from, valid_until, revoked_at, revoked_reason,
  row_version, created_at, updated_at`;

Deno.serve(async (req) => {
  const cors = createCorsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid request body' }, 400, cors);
  }

  const operation = trimmed(body?.operation);
  if (!operation) return json({ error: 'operation is required' }, 400, cors);

  // 1. Command Centre session. A Builder Portal cookie is not a staff session
  //    and cannot satisfy this.
  //
  //    P3: authentication failure is 401, not 403. createForbiddenResponse()
  //    takes (message, corsHeaders) and always returns 403, so it is used only
  //    for the authorization failure below — matching solicitor-portal-admin,
  //    which returns json({...}, 401) here and createForbiddenResponse() there.
  const auth = await verifyAuth(supabase, req.headers, body);
  if (auth.error || !auth.userId) {
    return json({ error: auth.error || 'Authentication required' }, 401, cors);
  }

  // 2. CSRF on every mutation — the staff session is cookie-carried.
  //    P1: the established signature is csrfDenied(corsHeaders, csrfResult).
  //    Reversing them spread the CsrfCheckResult into the response headers and
  //    dropped Access-Control-Allow-Origin, so the browser saw a CORS error
  //    instead of the CSRF failure detail.
  if (!READ_OPERATIONS.has(operation)) {
    const csrf = enforceCsrf(req);
    if (!csrf.ok) return csrfDenied(cors, csrf);
  }

  // 3. Deny-by-default module permission. A missing module registration or a
  //    missing permission row denies. Authenticated-but-not-permitted is 403.
  const authz = await requireModulePermission(
    supabase, { userId: auth.userId, authMethod: auth.authMethod },
    MODULE_KEY, requiredPermFor(operation),
  );
  if (!authz.ok) {
    return createForbiddenResponse(authz.error || 'Not authorized', cors);
  }

  // P2: verifyAuth() returns the literal string 'service_role' as the identity
  // for a verified internal call (see _shared/auth.ts). That is not a uuid, so
  // writing it into created_by / updated_by / granted_by / invited_by or into a
  // uuid RPC argument fails with 22P02. Solicitor guards this the same way.
  //
  // auth.userId stays the permission-check identity; adminUserId is the only
  // value that reaches a uuid column.
  const isServiceRoleActor = auth.userId === 'service_role';
  const adminUserId: string | null = isServiceRoleActor ? null : auth.userId;
  const actorType = isServiceRoleActor ? 'service_role' : 'command_user';

  /** Re-read a parent server-side. A browser-supplied id is a request, not an authority. */
  const loadOrganisation = async (organisationId: string | null) => {
    if (!organisationId) return null;
    const { data } = await supabase
      .from('builder_organisations').select('id, status, row_version')
      .eq('id', organisationId).maybeSingle();
    return data ?? null;
  };

  /**
   * P4: access-control mutations run through guarded database commands that
   * write the state change AND the trusted audit record in one transaction. A
   * failed audit write aborts the mutation, so nothing can be reported as
   * successfully completed without evidence (Phase 0 NOCOPY-04).
   *
   * The commands signal failure as PostgreSQL exceptions; this maps them onto
   * the HTTP contract Phase 1 already established.
   */
  const RPC_STATUS: Array<[RegExp, number, string | undefined]> = [
    [/BUILDER_STALE_WRITE/, 409, 'stale_write'],
    [/BUILDER_ORG_CLOSED/, 409, 'organisation_closed'],
    [/BUILDER_USER_REVOKED/, 409, 'user_revoked'],
    [/BUILDER_MEMBERSHIP_NOT_FOUND_OR_REVOKED/, 409, 'membership_not_found'],
    [/BUILDER_HAS_DEPENDENTS/, 409, 'has_dependents'],
    [/BUILDER_REASON_REQUIRED/, 400, 'reason_required'],
    [/BUILDER_ORG_NOT_FOUND/, 404, undefined],
    [/BUILDER_USER_NOT_FOUND/, 404, undefined],
    [/BUILDER_MEMBERSHIP_NOT_FOUND\b/, 404, undefined],
    [/BUILDER_UNKNOWN_USER_STATUS|BUILDER_UNKNOWN_ORG_STATUS/, 400, undefined],
    [/BUILDER_FORBIDDEN_PERMISSION_KEY|BUILDER_UNKNOWN_PERMISSION_KEY/, 400, 'forbidden_permission_key'],
    [/BUILDER_PROJECTION_NOT_WRITABLE/, 400, 'projection_not_writable'],
    [/BUILDER_SCOPE_NOT_AVAILABLE/, 400, 'scope_not_available'],
    [/BUILDER_AUDIT_WRITE_FAILED|BUILDER_ACTIVITY_LOG_APPEND_ONLY/, 500, 'audit_write_failed'],
    [/duplicate key value|23505/, 409, 'duplicate'],
  ];

  /**
   * A guarded command signals failure as a PostgreSQL exception, so its raw
   * message is a sentinel like BUILDER_HAS_DEPENDENTS. Those sentinels are for
   * this layer, not for the administrator reading the dialog, so the ones that
   * surface in the interface get a sentence instead.
   */
  const RPC_MESSAGE: Record<string, string> = {
    has_dependents: 'This record is still in use and cannot be removed.',
    reason_required: 'A reason is required for this operation.',
  };

  const rpcFailure = (error: { message?: string; details?: string; code?: string }) => {
    // Two different reads of the same failure. `text` includes the SQLSTATE so
    // the patterns above can match on it; the structured values are taken from
    // the DETAIL line ALONE.
    //
    // Reading them out of `text` appended the SQLSTATE to the last field on the
    // line, which is how "Memberships (1) P0001" reached an administrator's
    // screen. A guarded command writes its structured detail in DETAIL, so that
    // is the only place worth reading it from.
    const detail = String(error?.details ?? '') || String(error?.message ?? '');
    const text = `${error?.message ?? ''} ${error?.details ?? ''} ${error?.code ?? ''}`;
    for (const [pattern, status, code] of RPC_STATUS) {
      if (pattern.test(text)) {
        const currentVersion = /current_version=(\d+)/.exec(detail)?.[1];
        // A refused removal names what is holding the record, so the
        // administrator is told which alternative to reach for rather than
        // just being stopped.
        const dependents = /dependents=([^\n]+)/.exec(detail)?.[1]?.trim();
        return json({
          error: (code && RPC_MESSAGE[code]) || error?.message || 'Operation failed',
          ...(code ? { code } : {}),
          ...(currentVersion ? { current_version: Number(currentVersion) } : {}),
          ...(dependents ? { dependents } : {}),
        }, status, cors);
      }
    }
    return json({ error: error?.message || 'Operation failed' }, 500, cors);
  };

  /** Best-effort observability. Never the only record of an access-control change. */
  const auditRows: Array<Record<string, unknown>> = [];

  try {
    switch (operation) {
      // ---------------------------------------------------------------- orgs
      case 'list_organisations': {
        const { data, error } = await supabase
          .from('builder_organisations').select(ORG_SELECT)
          .order('legal_name', { ascending: true });
        if (error) throw error;
        return json({ organisations: data ?? [] }, 200, cors);
      }

      case 'upsert_organisation': {
        const legalName = trimmed(body.legal_name);
        const orgType = trimmed(body.org_type);
        if (!legalName) return json({ error: 'legal_name is required' }, 400, cors);
        if (!orgType || !ORG_TYPES.has(orgType)) {
          return json({ error: 'org_type must be developer, builder, builder_developer or sales_representative' }, 400, cors);
        }
        const state = trimmed(body.state);
        if (state && !AU_STATES.has(state.toUpperCase())) {
          return json({ error: 'state must be an Australian state or territory' }, 400, cors);
        }
        const abn = digitsOnly(body.abn);
        if (abn && !/^[0-9]{11}$/.test(abn)) return json({ error: 'ABN must be 11 digits', code: 'invalid_field' }, 400, cors);
        const acn = digitsOnly(body.acn);
        if (acn && !/^[0-9]{9}$/.test(acn)) return json({ error: 'ACN must be 9 digits', code: 'invalid_field' }, 400, cors);
        // The column refuses these too; refusing them here is what turns a
        // 500 into a sentence naming the field.
        const postcode = trimmed(body.postcode);
        if (postcode && !/^[0-9]{4}$/.test(postcode)) {
          return json({ error: 'Postcode must be four digits', code: 'invalid_field' }, 400, cors);
        }
        const contactEmail = trimmed(body.contact_email)?.toLowerCase() ?? null;
        if (contactEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail)) {
          return json({ error: 'Enter a valid contact email address', code: 'invalid_field' }, 400, cors);
        }


        const payload: Record<string, unknown> = {
          legal_name: legalName,
          trading_name: trimmed(body.trading_name),
          org_type: orgType,
          abn, acn,
          contact_email: contactEmail,
          contact_phone: trimmed(body.contact_phone),
          website: trimmed(body.website),
          address_line1: trimmed(body.address_line1),
          address_line2: trimmed(body.address_line2),
          suburb: trimmed(body.suburb),
          state: state ? state.toUpperCase() : null,
          postcode,
          notes: trimmed(body.notes),
          updated_by: adminUserId,
        };

        const organisationId = trimmed(body.organisation_id);
        if (!organisationId) {
          // Creation always starts pending_activation. Status is a separate,
          // audited transition — never a field on the create form.
          const { data, error } = await supabase.from('builder_organisations')
            .insert({ ...payload, status: 'pending_activation', is_active: false, created_by: adminUserId })
            .select(ORG_SELECT).single();
          if (error) {
            const refused = organisationWriteFailure(error);
            if (refused) return json(refused, 409, cors);
            throw error;
          }
          auditRows.push({ action: 'builder_organisation_created', entity_id: data.id });
          return json({ organisation: data }, 200, cors);
        }

        const existing = await loadOrganisation(organisationId);
        if (!existing) return json({ error: 'Organisation not found' }, 404, cors);

        const expectedVersion = Number(body.expected_version);
        if (!Number.isFinite(expectedVersion)) {
          return json({ error: 'expected_version is required' }, 400, cors);
        }
        if (existing.row_version !== expectedVersion) {
          return json({
            error: 'This organisation changed since you loaded it. Reload and try again.',
            code: 'stale_write', current_version: existing.row_version,
          }, 409, cors);
        }

        const { data, error } = await supabase.from('builder_organisations')
          .update(payload).eq('id', organisationId).eq('row_version', expectedVersion)
          .select(ORG_SELECT).maybeSingle();
        if (error) {
          const refused = organisationWriteFailure(error);
          if (refused) return json(refused, 409, cors);
          throw error;
        }
        if (!data) {
          return json({ error: 'Concurrent update detected', code: 'stale_write' }, 409, cors);
        }
        auditRows.push({ action: 'builder_organisation_updated', entity_id: organisationId });
        return json({ organisation: data }, 200, cors);
      }

      case 'set_organisation_status': {
        // Access-control mutation: guarded command, trusted audit, one
        // transaction. Session revocation for the organisation's members
        // happens inside the same transaction.
        const organisationId = trimmed(body.organisation_id);
        const status = trimmed(body.status);
        if (!organisationId) return json({ error: 'organisation_id is required' }, 400, cors);
        if (!status || !ORG_STATUSES.has(status)) {
          return json({ error: 'Unknown organisation status' }, 400, cors);
        }
        const expectedVersion = Number(body.expected_version);
        if (!Number.isFinite(expectedVersion)) {
          return json({ error: 'expected_version is required' }, 400, cors);
        }

        const { data, error } = await supabase.rpc('builder_admin_set_organisation_status', {
          _actor_user_id: adminUserId,
          _actor_type: actorType,
          _organisation_id: organisationId,
          _status: status,
          _expected_version: expectedVersion,
          _reason: trimmed(body.reason),
        });
        if (error) return rpcFailure(error);

        auditRows.push({ action: `builder_organisation_${status}`, entity_id: organisationId });
        return json({ organisation: data }, 200, cors);
      }

      // --------------------------------------------------------------- users
      case 'list_users': {
        // An organisation filter narrows the result; it never widens it, and it
        // is applied through the membership table rather than trusted directly.
        const organisationId = trimmed(body.organisation_id);
        if (organisationId) {
          const { data: memberships, error: mErr } = await supabase
            .from('builder_organisation_memberships').select('builder_user_id')
            .eq('organisation_id', organisationId).is('revoked_at', null);
          if (mErr) throw mErr;
          const ids = (memberships ?? []).map((m: any) => m.builder_user_id);
          if (!ids.length) return json({ users: [] }, 200, cors);
          const { data, error } = await supabase.from('builder_portal_users')
            .select(USER_SELECT_INTERNAL).in('id', ids).order('name');
          if (error) throw error;
          return json({ users: (data ?? []).map(projectUser) }, 200, cors);
        }
        const { data, error } = await supabase.from('builder_portal_users')
          .select(USER_SELECT_INTERNAL).order('name');
        if (error) throw error;
        return json({ users: (data ?? []).map(projectUser) }, 200, cors);
      }

      case 'create_user': {
        const email = trimmed(body.email)?.toLowerCase();
        const name = trimmed(body.name);
        if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          return json({ error: 'A valid email is required' }, 400, cors);
        }
        if (!name) return json({ error: 'name is required' }, 400, cors);

        const { data, error } = await supabase.from('builder_portal_users').insert({
          email, name,
          phone: trimmed(body.phone),
          job_title: trimmed(body.job_title),
          status: 'invited', is_active: false,
          must_change_password: true,
          invited_by: adminUserId, invited_at: new Date().toISOString(),
          created_by: adminUserId,
        }).select(USER_SELECT_INTERNAL).single();
        if (error) {
          if ((error as any).code === '23505') {
            return json({ error: 'A portal user with that email already exists' }, 409, cors);
          }
          throw error;
        }
        auditRows.push({ action: 'builder_user_created', entity_id: data.id });
        return json({ user: projectUser(data) }, 200, cors);
      }

      case 'update_user': {
        const userId = trimmed(body.builder_user_id);
        if (!userId) return json({ error: 'builder_user_id is required' }, 400, cors);

        const { data: existing } = await supabase.from('builder_portal_users')
          .select('id, row_version').eq('id', userId).maybeSingle();
        if (!existing) return json({ error: 'User not found' }, 404, cors);

        const expectedVersion = Number(body.expected_version);
        if (!Number.isFinite(expectedVersion) || existing.row_version !== expectedVersion) {
          return json({
            error: 'This user changed since you loaded them. Reload and try again.',
            code: 'stale_write', current_version: existing.row_version,
          }, 409, cors);
        }

        // Email is editable because a mistyped address makes an account
        // unreachable and therefore unusable. It is the sign-in identifier, so
        // it is normalised and validated exactly as it is on create, and the
        // unique-violation path is answered as a 409 rather than a 500.
        //
        // Deliberately not editable here, at any privilege: password_hash,
        // invite_token_hash, reset_token_hash, every session token hash, and
        // the system-owned lifecycle timestamps (invited_at,
        // invite_accepted_at, last_login_at, revoked_at). Those are written
        // only by the flows that earn them. The update payload below is a
        // closed allow-list, so a new column cannot become editable by
        // accident.
        const nextEmail = trimmed(body.email)?.toLowerCase();
        if (body.email !== undefined && (!nextEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(nextEmail))) {
          return json({ error: 'A valid email is required' }, 400, cors);
        }

        const { data, error } = await supabase.from('builder_portal_users').update({
          name: trimmed(body.name) ?? undefined,
          ...(nextEmail ? { email: nextEmail } : {}),
          phone: trimmed(body.phone),
          job_title: trimmed(body.job_title),
          updated_by: adminUserId,
        }).eq('id', userId).eq('row_version', expectedVersion).select(USER_SELECT_INTERNAL).maybeSingle();
        if (error) {
          if ((error as any).code === '23505') {
            return json({ error: 'A portal user with that email already exists', code: 'duplicate' }, 409, cors);
          }
          throw error;
        }
        if (!data) return json({ error: 'Concurrent update detected', code: 'stale_write' }, 409, cors);
        auditRows.push({ action: 'builder_user_updated', entity_id: userId });
        return json({ user: projectUser(data) }, 200, cors);
      }

      case 'set_user_status': {
        const userId = trimmed(body.builder_user_id);
        const status = trimmed(body.status);
        if (!userId) return json({ error: 'builder_user_id is required' }, 400, cors);
        if (!status || !USER_STATUSES.has(status)) {
          return json({ error: 'Unknown user status' }, 400, cors);
        }

        const { data: existing } = await supabase.from('builder_portal_users')
          .select('id, row_version, status, revoked_at, invite_accepted_at, password_hash')
          .eq('id', userId).maybeSingle();
        if (!existing) return json({ error: 'User not found' }, 404, cors);

        const expectedVersion = Number(body.expected_version);
        if (!Number.isFinite(expectedVersion) || existing.row_version !== expectedVersion) {
          return json({
            error: 'This user changed since you loaded them. Reload and try again.',
            code: 'stale_write', current_version: existing.row_version,
          }, 409, cors);
        }

        // An account only becomes active by completing the invitation flow.
        // Enforced here, server-side, because a disabled button is a hint and
        // not a control: this function is reachable directly by any caller
        // holding the module permission.
        if (status === 'active') {
          const blocked = await activationBlocker(supabase, userId, existing);
          if (blocked) return json(blocked, 409, cors);
        }

        const { data, error } = await supabase.rpc('builder_admin_set_user_status', {
          _actor_user_id: adminUserId,
          _actor_type: actorType,
          _builder_user_id: userId,
          _status: status,
          _expected_version: expectedVersion,
          _reason: trimmed(body.reason),
        });
        if (error) return rpcFailure(error);

        auditRows.push({ action: `builder_user_${status}`, entity_id: userId });
        return json({ user: projectUser(data as Record<string, any>) }, 200, cors);
      }

      /**
       * Permanent removal. The three delete operations below all delegate to a
       * guarded command that counts protected dependants under a lock on the
       * parent row and writes the audit record before the DELETE.
       *
       * That has to happen inside the database, not here: most Builder child
       * tables cascade from the user and the organisation, so a check issued as
       * one call and a delete issued as the next would let a row created in
       * between be destroyed silently. An explicit reason is mandatory and is
       * enforced by the command as well as here.
       */
      case 'delete_user': {
        const userId = trimmed(body.builder_user_id);
        const reason = trimmed(body.reason);
        if (!userId) return json({ error: 'builder_user_id is required' }, 400, cors);
        if (!reason) {
          return json({ error: 'A reason is required to remove a portal user', code: 'reason_required' }, 400, cors);
        }
        const expectedVersion = Number(body.expected_version);
        if (!Number.isFinite(expectedVersion)) {
          return json({ error: 'expected_version is required' }, 400, cors);
        }

        const { data, error } = await supabase.rpc('builder_admin_delete_user', {
          _actor_user_id: adminUserId,
          _actor_type: actorType,
          _builder_user_id: userId,
          _expected_version: expectedVersion,
          _reason: reason,
        });
        if (error) return rpcFailure(error);

        auditRows.push({ action: 'builder_user_removed', entity_id: userId });
        // `detail` carries what the command actually cleaned up — memberships
        // removed, sessions revoked, primary reassigned. It never contains a row.
        return json({ removed: true, id: userId, detail: data ?? null }, 200, cors);
      }

      case 'delete_organisation': {
        const organisationId = trimmed(body.organisation_id);
        const reason = trimmed(body.reason);
        if (!organisationId) return json({ error: 'organisation_id is required' }, 400, cors);
        if (!reason) {
          return json({ error: 'A reason is required to remove an organisation', code: 'reason_required' }, 400, cors);
        }
        const expectedVersion = Number(body.expected_version);
        if (!Number.isFinite(expectedVersion)) {
          return json({ error: 'expected_version is required' }, 400, cors);
        }

        const { data, error } = await supabase.rpc('builder_admin_delete_organisation', {
          _actor_user_id: adminUserId,
          _actor_type: actorType,
          _organisation_id: organisationId,
          _expected_version: expectedVersion,
          _reason: reason,
        });
        if (error) return rpcFailure(error);

        auditRows.push({ action: 'builder_organisation_removed', entity_id: organisationId });
        // `detail` carries what the command actually cleaned up — memberships
        // removed, sessions revoked, primary reassigned. It never contains a row.
        return json({ removed: true, id: organisationId, detail: data ?? null }, 200, cors);
      }

      case 'delete_membership': {
        const membershipId = trimmed(body.membership_id);
        const reason = trimmed(body.reason);
        if (!membershipId) return json({ error: 'membership_id is required' }, 400, cors);
        if (!reason) {
          return json({ error: 'A reason is required to remove a membership', code: 'reason_required' }, 400, cors);
        }
        const expectedVersion = Number(body.expected_version);
        if (!Number.isFinite(expectedVersion)) {
          return json({ error: 'expected_version is required' }, 400, cors);
        }

        const { data, error } = await supabase.rpc('builder_admin_delete_membership', {
          _actor_user_id: adminUserId,
          _actor_type: actorType,
          _membership_id: membershipId,
          _expected_version: expectedVersion,
          _reason: reason,
        });
        if (error) return rpcFailure(error);

        auditRows.push({ action: 'builder_membership_removed', entity_id: membershipId });
        // `detail` carries what the command actually cleaned up — memberships
        // removed, sessions revoked, primary reassigned. It never contains a row.
        return json({ removed: true, id: membershipId, detail: data ?? null }, 200, cors);
      }

      // --------------------------------------------------------- memberships
      case 'list_memberships': {
        const organisationId = trimmed(body.organisation_id);
        const userId = trimmed(body.builder_user_id);
        let queryBuilder = supabase.from('builder_organisation_memberships').select(MEMBERSHIP_SELECT);
        if (organisationId) queryBuilder = queryBuilder.eq('organisation_id', organisationId);
        if (userId) queryBuilder = queryBuilder.eq('builder_user_id', userId);
        const { data, error } = await queryBuilder.order('created_at', { ascending: false });
        if (error) throw error;
        return json({ memberships: data ?? [] }, 200, cors);
      }

      case 'upsert_membership': {
        const userId = trimmed(body.builder_user_id);
        const organisationId = trimmed(body.organisation_id);
        const role = trimmed(body.membership_role);
        if (!userId || !organisationId) {
          return json({ error: 'builder_user_id and organisation_id are required' }, 400, cors);
        }
        if (!role || !MEMBERSHIP_ROLES.has(role)) {
          return json({ error: 'membership_role must be owner, administrator, manager, member or read_only' }, 400, cors);
        }

        // Both parents are re-read server-side before the child write.
        const organisation = await loadOrganisation(organisationId);
        if (!organisation) return json({ error: 'Organisation not found' }, 404, cors);
        if (organisation.status === 'closed') {
          return json({ error: 'Cannot grant membership of a closed organisation', code: 'organisation_closed' }, 409, cors);
        }
        const { data: user } = await supabase.from('builder_portal_users')
          .select('id, status').eq('id', userId).maybeSingle();
        if (!user) return json({ error: 'User not found' }, 404, cors);
        if (user.status === 'revoked') {
          return json({ error: 'Cannot grant membership to a revoked user', code: 'user_revoked' }, 409, cors);
        }

        const { data: existing } = await supabase.from('builder_organisation_memberships')
          .select('id, row_version').eq('builder_user_id', userId)
          .eq('organisation_id', organisationId).is('revoked_at', null).maybeSingle();

        const expectedVersion = existing ? Number(body.expected_version) : null;
        if (existing && !Number.isFinite(expectedVersion as number)) {
          return json({
            error: 'This membership changed since you loaded it. Reload and try again.',
            code: 'stale_write', current_version: existing.row_version,
          }, 409, cors);
        }

        // Access-control mutation: the grant or role change and its trusted
        // audit record commit together, or neither commits.
        const { data, error } = await supabase.rpc('builder_admin_upsert_membership', {
          _actor_user_id: adminUserId,
          _actor_type: actorType,
          _builder_user_id: userId,
          _organisation_id: organisationId,
          _membership_role: role,
          _is_primary: body.is_primary === true,
          _expected_version: expectedVersion,
          _reason: trimmed(body.reason),
        });
        if (error) return rpcFailure(error);

        auditRows.push({
          action: existing ? 'builder_membership_role_changed' : 'builder_membership_granted',
          entity_id: (data as any)?.id ?? null,
        });
        return json({ membership: data }, 200, cors);
      }

      case 'revoke_membership': {
        const membershipId = trimmed(body.membership_id);
        if (!membershipId) return json({ error: 'membership_id is required' }, 400, cors);

        // Access-control mutation: revocation and its trusted audit record
        // commit together. The Phase 1 trigger that ends the user's sessions
        // when their last membership goes fires inside the same transaction.
        const { data, error } = await supabase.rpc('builder_admin_revoke_membership', {
          _actor_user_id: adminUserId,
          _actor_type: actorType,
          _membership_id: membershipId,
          _reason: trimmed(body.reason),
        });
        if (error) return rpcFailure(error);

        auditRows.push({ action: 'builder_membership_revoked', entity_id: membershipId });
        return json({ membership: data }, 200, cors);
      }

      // -------------------------------------------------------- permissions
      case 'get_permission_catalogue': {
        const [{ data: keys, error: kErr }, { data: defaults, error: dErr }] = await Promise.all([
          supabase.from('builder_permission_keys')
            .select('permission_key, description, key_kind, is_forbidden')
            .eq('is_forbidden', false).order('permission_key'),
          supabase.from('builder_role_default_permissions')
            .select('membership_role, permission_key, can_view, can_edit, can_delete'),
        ]);
        if (kErr) throw kErr;
        if (dErr) throw dErr;
        return json({ permission_keys: keys ?? [], role_defaults: defaults ?? [] }, 200, cors);
      }

      case 'get_membership_permissions': {
        const membershipId = trimmed(body.membership_id);
        if (!membershipId) return json({ error: 'membership_id is required' }, 400, cors);
        const { data, error } = await supabase.from('builder_membership_permissions')
          .select('permission_key, scope_type, view_decision, edit_decision, delete_decision, reason')
          .eq('membership_id', membershipId).eq('scope_type', 'organisation');
        if (error) throw error;
        return json({ overrides: data ?? [] }, 200, cors);
      }

      case 'update_membership_permissions': {
        const membershipId = trimmed(body.membership_id);
        if (!membershipId) return json({ error: 'membership_id is required' }, 400, cors);

        const { data: membership } = await supabase.from('builder_organisation_memberships')
          .select('id').eq('id', membershipId).is('revoked_at', null).maybeSingle();
        if (!membership) return json({ error: 'Membership not found or revoked' }, 404, cors);

        // Forbidden keys are stripped here as well as denied in the resolver and
        // rejected by the database trigger. Three independent layers, because a
        // single layer is a single point of failure.
        const { data: allowedKeys, error: kErr } = await supabase
          .from('builder_permission_keys').select('permission_key, key_kind')
          .eq('is_forbidden', false);
        if (kErr) throw kErr;
        const allowed = new Map((allowedKeys ?? []).map((k: any) => [k.permission_key, k.key_kind]));

        const incoming = Array.isArray(body.overrides) ? body.overrides : [];
        const rows: Array<Record<string, unknown>> = [];
        const rejected: string[] = [];

        for (const entry of incoming) {
          const key = trimmed(entry?.permission_key);
          if (!key || !allowed.has(key)) { if (key) rejected.push(key); continue; }
          const view = DECISIONS.has(entry?.view_decision) ? entry.view_decision : 'inherit';
          let edit = DECISIONS.has(entry?.edit_decision) ? entry.edit_decision : 'inherit';
          let del = DECISIONS.has(entry?.delete_decision) ? entry.delete_decision : 'inherit';
          // Inbound projections are read-only regardless of what was submitted.
          if (allowed.get(key) === 'inbound_projection') { edit = 'inherit'; del = 'inherit'; }
          if (view === 'inherit' && edit === 'inherit' && del === 'inherit') continue;
          rows.push({
            permission_key: key,
            view_decision: view, edit_decision: edit, delete_decision: del,
            reason: trimmed(entry?.reason),
          });
        }

        // Access-control mutation: the guarded command replaces the
        // organisation-scoped override set and writes the before/after audit
        // record in one transaction. Project scopes are untouched because none
        // can exist yet.
        const { data: applied, error } = await supabase.rpc('builder_admin_set_membership_permissions', {
          _actor_user_id: adminUserId,
          _actor_type: actorType,
          _membership_id: membershipId,
          _overrides: rows,
          _reason: trimmed(body.reason),
        });
        if (error) return rpcFailure(error);

        auditRows.push({
          action: 'builder_membership_permissions_changed', entity_id: membershipId,
          metadata: { applied, rejected_keys: rejected },
        });
        return json({ applied: applied ?? 0, rejected_keys: rejected }, 200, cors);
      }

      // ------------------------------------------------------------ sessions
      case 'list_user_sessions': {
        const userId = trimmed(body.builder_user_id);
        if (!userId) return json({ error: 'builder_user_id is required' }, 400, cors);
        // token_hash is deliberately excluded: an administrator has no reason to
        // see it, and a leaked hash is a replayable credential.
        const { data, error } = await supabase.from('builder_portal_sessions')
          .select('id, created_at, last_used_at, absolute_expires_at, idle_expires_at, revoked_at, revoked_reason, device_label')
          .eq('builder_user_id', userId).order('last_used_at', { ascending: false }).limit(50);
        if (error) throw error;
        return json({ sessions: data ?? [] }, 200, cors);
      }

      case 'revoke_user_sessions': {
        // Access-control mutation: revocation and its trusted audit record
        // commit together.
        const userId = trimmed(body.builder_user_id);
        if (!userId) return json({ error: 'builder_user_id is required' }, 400, cors);
        const { data, error } = await supabase.rpc('builder_admin_revoke_user_sessions', {
          _actor_user_id: adminUserId,
          _actor_type: actorType,
          _builder_user_id: userId,
          _reason: trimmed(body.reason),
        });
        if (error) return rpcFailure(error);
        auditRows.push({ action: 'builder_sessions_revoked', entity_id: userId, metadata: { revoked: data } });
        return json({ revoked: data ?? 0 }, 200, cors);
      }

      default:
        return json({ error: `Unknown operation: ${operation}` }, 400, cors);
    }
  } catch (error: any) {
    console.error('[builder-portal-admin] operation failed', { operation, message: error?.message });
    return json({ ...internalError(error, 'builder-portal-admin') }, 500, cors);
  } finally {
    // Best-effort operational event, for observability only. Access-control
    // mutations already wrote a trusted, fail-closed record to
    // builder_portal_activity_log inside their own transaction, so a failure
    // here loses a metric, never the audit trail (Phase 0 NOCOPY-04).
    for (const entry of auditRows) {
      try {
        await supabase.rpc('record_portal_operational_event', {
          _event_name: 'builder_admin_command', _severity: 'info',
          _correlation_id: crypto.randomUUID(), _request_id: null,
          _actor_type: actorType, _actor_id: adminUserId, _portal: 'builder',
          _case_id: null, _matter_id: null, _firm_id: null, _duration_ms: null,
          _success: true, _metadata: entry,
        });
      } catch (auditError) {
        console.error('[builder-portal-admin] operational event failed', auditError);
      }
    }
  }
});
