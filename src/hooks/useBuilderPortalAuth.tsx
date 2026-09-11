import type { PortalAcknowledgementKey } from '@/lib/portalAgreement';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  builderAcceptInvite,
  builderAcceptTerms,
  builderChangePassword,
  builderCompleteOnboarding,
  builderCurrentSession,
  builderLogin,
  builderLogout,
  builderSelectOrganisation,
  type BuilderGovernanceReason,
  type BuilderOrganisation,
  type BuilderPermissionMatrix,
  type BuilderPortalUser,
} from '@/lib/builderPortal';

/**
 * Builder / Developer Portal authentication provider.
 *
 * Mirrors `useSolicitorPortalAuth`: state is never assumed from a login
 * response, it is always re-read through the cookie-backed verifier so
 * governance comes from the server. The provider is mounted only under
 * `/builder/*` and shares nothing with the Solicitor provider.
 */

interface BuilderPortalAuthContextType {
  user: BuilderPortalUser | null;
  organisations: BuilderOrganisation[];
  activeOrganisation: BuilderOrganisation | null;
  permissions: BuilderPermissionMatrix;
  governance: BuilderGovernanceReason;
  requiresOrganisationSelection: boolean;
  loading: boolean;
  previousSeenAt: string | null;
  signIn: (email: string, password: string, turnstileToken?: string) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
  acceptInvite: (token: string, password: string) => Promise<{ error?: string }>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<{ error?: string }>;
  acceptTerms: (acknowledgements: PortalAcknowledgementKey[]) => Promise<{ error?: string }>;
  completeOnboarding: (stepKey?: string) => Promise<{ error?: string }>;
  selectOrganisation: (organisationId: string) => Promise<{ error?: string }>;
  refresh: () => Promise<void>;
  can: (permissionKey: string, level?: 'view' | 'edit' | 'delete') => boolean;
}

const BuilderPortalAuthContext = createContext<BuilderPortalAuthContextType | undefined>(undefined);

export function BuilderPortalAuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<BuilderPortalUser | null>(null);
  const [organisations, setOrganisations] = useState<BuilderOrganisation[]>([]);
  const [activeOrganisation, setActiveOrganisation] = useState<BuilderOrganisation | null>(null);
  const [permissions, setPermissions] = useState<BuilderPermissionMatrix>({});
  const [governance, setGovernance] = useState<BuilderGovernanceReason>(null);
  const [requiresOrganisationSelection, setRequiresOrganisationSelection] = useState(false);
  const [previousSeenAt, setPreviousSeenAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const queryClient = useQueryClient();
  /**
   * Who the cached builder data belongs to: `<builder_user_id>:<organisation_id>`.
   * A ref rather than state because nothing renders from it — it exists only to
   * notice a change.
   */
  const cachedIdentity = useRef<string | null>(null);

  /**
   * THROW AWAY EVERY CACHED ANSWER THAT BELONGED TO SOMEBODY ELSE.
   *
   * MEASURED 11 SEPTEMBER 2026, reported as "a stock list uploaded under Kopi
   * Jantan Builders can be seen from a Bob The Builder account", and seen in
   * Bob's own Stock Lists page.
   *
   * The server was not the leak: every builder-portal query narrows to the
   * session's organisation, the accessible set comes from a SECURITY DEFINER
   * function scoped to the user, all four stock tables are RLS service-role
   * only and both buckets are private. The leak is HERE. React Query caches
   * one builder's data under keys that name no builder —
   * `['builder','stock','uploads',1]` — and `signOut` cleared this hook's
   * React state and nothing else. So:
   *
   *   sign in as Kopi Jantan   → cache fills under that key
   *   sign out                 → cache untouched
   *   sign in as Bob           → the page mounts, reads the SAME key, and
   *                              renders Kopi Jantan's stock lists
   *
   * before the refetch replaces them. One builder's commercial data drawn in
   * another builder's portal.
   *
   * It is fixed at the identity rather than at the key because
   * `builderKeys` has forty-odd entries — projects, units, transactions,
   * construction, documents, conversations — and every one of them is
   * organisation-blind in exactly the same way. Purging on the identity covers
   * all of them, and covers every key anybody adds later, which keying them
   * one by one would not.
   */
  const forgetCachedTenant = useCallback(() => {
    cachedIdentity.current = null;
    queryClient.removeQueries({ queryKey: ['builder'] });
  }, [queryClient]);

  const clearAuthState = useCallback(() => {
    setUser(null);
    setOrganisations([]);
    setActiveOrganisation(null);
    setPermissions({});
    setGovernance(null);
    setRequiresOrganisationSelection(false);
    setPreviousSeenAt(null);
    forgetCachedTenant();
  }, [forgetCachedTenant]);

  const checkSession = useCallback(async () => {
    const { data, error } = await builderCurrentSession();
    if (error || !data?.valid || !data.user) {
      clearAuthState();
    } else {
      /*
       * AND THE SAME PURGE WHEN THE IDENTITY MOVES WITHOUT A SIGN-OUT: a user
       * who belongs to two organisations switching between them, or a second
       * account signed into the same tab. The cached rows are the previous
       * tenant's either way.
       */
      const identity = `${data.user.id}:${data.active_organisation?.organisation_id ?? ''}`;
      if (cachedIdentity.current !== null && cachedIdentity.current !== identity) {
        queryClient.removeQueries({ queryKey: ['builder'] });
      }
      cachedIdentity.current = identity;

      setUser(data.user);
      setOrganisations(data.organisations ?? []);
      setActiveOrganisation(data.active_organisation ?? null);
      setPermissions(data.permissions ?? {});
      setGovernance(data.governance ?? null);
      setRequiresOrganisationSelection(!!data.requires_organisation_selection);
      setPreviousSeenAt(data.previous_seen_at ?? null);
    }
    setLoading(false);
  }, [clearAuthState, queryClient]);

  useEffect(() => { void checkSession(); }, [checkSession]);

  const signIn = useCallback(async (email: string, password: string, turnstileToken?: string) => {
    const { data, error } = await builderLogin(email, password, turnstileToken);
    if (error || !data?.success) {
      return { error: (data as any)?.error || error?.message || 'Login failed' };
    }
    // Re-read through the cookie-backed verifier so governance state always
    // comes from the server, never from login response defaults.
    await checkSession();
    return {};
  }, [checkSession]);

  const signOut = useCallback(async () => {
    try {
      await builderLogout();
    } catch {
      /* best effort — always clear locally */
    }
    clearAuthState();
  }, [clearAuthState]);

  const acceptInvite = useCallback(async (token: string, password: string) => {
    const { data, error } = await builderAcceptInvite(token, password);
    if (error || !data?.success) {
      return { error: (data as any)?.error || error?.message || 'Could not accept this invite' };
    }
    await checkSession();
    return {};
  }, [checkSession]);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const { data, error } = await builderChangePassword(currentPassword, newPassword);
    if (error || !data?.success) {
      return { error: (data as any)?.error || error?.message || 'Could not change your password' };
    }
    // The server rotated the cookie and revoked every other session. Re-read so
    // `must_change_password` comes back cleared from the server, not guessed here.
    await checkSession();
    return {};
  }, [checkSession]);

  // The four acknowledgments are contractual statements, and the server refuses
  // an acceptance that is missing any of them, so they travel with the call.
  const acceptTerms = useCallback(async (acknowledgements: PortalAcknowledgementKey[]) => {
    const { data, error } = await builderAcceptTerms(acknowledgements);
    if (error || !data?.success) {
      return { error: (data as any)?.error || error?.message || 'Could not record your acceptance' };
    }
    await checkSession();
    return {};
  }, [checkSession]);

  const completeOnboarding = useCallback(async (stepKey?: string) => {
    const { data, error } = await builderCompleteOnboarding(stepKey);
    if (error || !data) {
      return { error: (data as any)?.error || error?.message || 'Could not complete onboarding' };
    }
    await checkSession();
    return {};
  }, [checkSession]);

  const selectOrganisation = useCallback(async (organisationId: string) => {
    const { data, error } = await builderSelectOrganisation(organisationId);
    if (error || !data) {
      return { error: (data as any)?.error || error?.message || 'Could not switch organisation' };
    }
    await checkSession();
    return {};
  }, [checkSession]);

  const refresh = useCallback(async () => { await checkSession(); }, [checkSession]);

  /**
   * Convenience read of the server-resolved matrix. This is a rendering aid,
   * never an authorization control — every request is re-authorised server-side.
   */
  const can = useCallback(
    (permissionKey: string, level: 'view' | 'edit' | 'delete' = 'view') =>
      permissions?.[permissionKey]?.[level] === true,
    [permissions],
  );

  const value = useMemo<BuilderPortalAuthContextType>(() => ({
    user, organisations, activeOrganisation, permissions, governance,
    requiresOrganisationSelection, loading, previousSeenAt,
    signIn, signOut, acceptInvite, changePassword, acceptTerms, completeOnboarding,
    selectOrganisation, refresh, can,
  }), [
    user, organisations, activeOrganisation, permissions, governance,
    requiresOrganisationSelection, loading, previousSeenAt,
    signIn, signOut, acceptInvite, changePassword, acceptTerms, completeOnboarding,
    selectOrganisation, refresh, can,
  ]);

  return (
    <BuilderPortalAuthContext.Provider value={value}>
      {children}
    </BuilderPortalAuthContext.Provider>
  );
}

export function useBuilderPortalAuth() {
  const context = useContext(BuilderPortalAuthContext);
  if (context === undefined) {
    throw new Error('useBuilderPortalAuth must be used within a BuilderPortalAuthProvider');
  }
  return context;
}
