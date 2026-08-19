/**
 * Builder / Developer Portal client-side API wrapper.
 *
 * Modelled directly on `src/lib/solicitorPortal.ts`: cookie-authenticated edge
 * invocation using an HttpOnly portal-scoped session, so the Command Centre,
 * Client Portal, Finance Portal, Solicitor Portal and Builder Portal never
 * share a session.
 *
 * No function here takes a token argument, reads Web Storage, or sets an
 * authentication header. The session travels only as the
 * `__Host-builder_session_token` cookie, attached by `credentials: 'include'`.
 */

import type { PortalAcknowledgementKey } from './portalAgreement';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@/integrations/supabase/env';


export interface BuilderPortalUser {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  job_title: string | null;
  has_accepted_terms: boolean;
  has_completed_onboarding: boolean;
  must_change_password: boolean;
  current_terms_version: string | null;
  has_accepted_current_terms: boolean;
  has_completed_mandatory_onboarding: boolean;
}

export interface BuilderOrganisation {
  organisation_id: string;
  legal_name: string;
  trading_name: string | null;
  org_type: string;
  membership_role: string;
  is_primary: boolean;
}

export type BuilderPermissionMatrix = Record<
  string,
  { view: boolean; edit: boolean; delete: boolean }
>;

export type BuilderGovernanceReason =
  | 'auth_required'
  | 'password_rotation_required'
  | 'organisation_selection_required'
  | 'terms_acceptance_required'
  | 'onboarding_required'
  | null;

export interface BuilderSessionSnapshot {
  valid: boolean;
  user: BuilderPortalUser | null;
  organisations: BuilderOrganisation[];
  active_organisation: BuilderOrganisation | null;
  requires_organisation_selection: boolean;
  permissions: BuilderPermissionMatrix;
  governance: BuilderGovernanceReason;
  previous_seen_at: string | null;
}

export interface BuilderTermsVersion {
  id: string;
  version: string;
  title: string;
  content_markdown: string;
  /** SHA-256 of the text, shown on the consent wall and recorded with the acceptance. */
  document_hash?: string | null;
  effective_at: string;
}

export interface BuilderOnboardingStep {
  step_key: string;
  mandatory: boolean;
  completed_at: string | null;
}

export interface BuilderPortalError {
  message: string;
  code?: string;
  status?: number;
}

export interface BuilderInvokeResult<T> {
  data: T | null;
  error: BuilderPortalError | null;
}

/**
 * Single transport for every Builder Portal call.
 *
 * `credentials: 'include'` is what carries the session. There is deliberately no
 * parameter for a token: a caller cannot supply one even by mistake.
 */
export async function invokeBuilderFunction<T = any>(
  functionName: string,
  body: Record<string, unknown> = {},
  options: { signal?: AbortSignal } = {},
): Promise<BuilderInvokeResult<T>> {
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'X-Portal-Request': 'builder-portal',
      },
      credentials: 'include',
      signal: options.signal,
      body: JSON.stringify(body),
    });

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        data,
        error: {
          message: (data as any)?.error || `HTTP ${response.status}`,
          code: (data as any)?.code,
          status: response.status,
        },
      };
    }
    return { data, error: null };
  } catch (error: any) {
    return { data: null, error: { message: error?.message || 'Network error' } };
  }
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export function builderLogin(email: string, password: string, turnstileToken?: string) {
  return invokeBuilderFunction('builder-portal-login', {
    email,
    password,
    ...(turnstileToken ? { turnstile_token: turnstileToken } : {}),
  });
}

export function builderLogout() {
  return invokeBuilderFunction('builder-portal-logout');
}

/** Restore the session after a page refresh. */
export function builderCurrentSession(options: { signal?: AbortSignal } = {}) {
  return invokeBuilderFunction<BuilderSessionSnapshot>('builder-portal-verify', {}, options);
}

export function builderValidateInvite(token: string) {
  return invokeBuilderFunction('builder-portal-accept-invite', { action: 'validate', token });
}

export function builderAcceptInvite(token: string, password: string) {
  return invokeBuilderFunction('builder-portal-accept-invite', { token, password });
}

/** Authenticated rotation. The server re-issues the cookie; nothing is stored here. */
export function builderChangePassword(currentPassword: string, newPassword: string) {
  return invokeBuilderFunction('builder-portal-change-password', {
    current_password: currentPassword,
    new_password: newPassword,
  });
}

export function builderRequestPasswordReset(email: string) {
  return invokeBuilderFunction('builder-portal-forgot-password', { email });
}

export function builderVerifyResetCode(email: string, otp: string) {
  return invokeBuilderFunction('builder-portal-reset-password', { action: 'verify_otp', email, otp });
}

export function builderResetPassword(email: string, otp: string, newPassword: string) {
  return invokeBuilderFunction('builder-portal-reset-password', {
    email, otp, new_password: newPassword,
  });
}

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

export function builderLoadGovernance() {
  return invokeBuilderFunction<{
    terms: BuilderTermsVersion | null;
    terms_accepted: boolean;
    steps: BuilderOnboardingStep[];
  }>('builder-portal-verify', { action: 'get_governance' });
}

/**
 * The acknowledgments the accepting person asserted travel with the acceptance:
 * they are contractual statements, and the agreement records them as
 * acknowledgment history. The server rejects an acceptance that is missing any
 * of them, so this argument is not advisory.
 */
export function builderAcceptTerms(acknowledgements: PortalAcknowledgementKey[]) {
  return invokeBuilderFunction('builder-portal-verify', {
    action: 'accept_current_terms',
    acknowledgements,
  });
}

export function builderCompleteOnboarding(stepKey?: string) {
  return invokeBuilderFunction<{ success: boolean; onboarding_complete: boolean }>('builder-portal-verify', {
    action: 'complete_onboarding',
    ...(stepKey ? { step_key: stepKey } : {}),
  });
}

// ---------------------------------------------------------------------------
// Organisations
//
// The list always comes from the server. Selecting one sends a REQUEST; the
// server re-verifies membership and holds the result on the session row, so a
// forged value cannot switch organisation.
// ---------------------------------------------------------------------------

export function builderSelectOrganisation(organisationId: string) {
  return invokeBuilderFunction<{ success: boolean; active_organisation: BuilderOrganisation }>(
    'builder-portal-verify',
    { action: 'select_organisation', organisation_id: organisationId },
  );
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export function builderListSessions() {
  return invokeBuilderFunction('builder-portal-verify', { action: 'list_sessions' });
}

export function builderRevokeSession(sessionId: string) {
  return invokeBuilderFunction('builder-portal-verify', { action: 'revoke_session', session_id: sessionId });
}

export function builderRevokeOtherSessions() {
  return invokeBuilderFunction('builder-portal-verify', { action: 'revoke_other_sessions' });
}
