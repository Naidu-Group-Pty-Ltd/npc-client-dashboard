/**
 * Client-side gate for the partner workspace surfaces (Phase 5).
 *
 * Reads the master + per-surface flags from `public.feature_flags` with the
 * anon client (same read model as `useAmlV3Flags`), failing CLOSED to
 * disabled. This is presentation gating only — the server enforces the same
 * flags on every workspace operation, so hiding here is convenience, not a
 * control. Deliberately its own module so portal LAYOUTS can consume it
 * without importing a data client into their own file.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export type WorkspaceSurfaceKey = "finance" | "builder" | "solicitor";

const SURFACE_FLAG: Record<WorkspaceSurfaceKey, string> = {
  finance: "aml_partner_workspace_finance",
  builder: "aml_partner_workspace_builder",
  solicitor: "aml_partner_workspace_solicitor",
};
const MASTER_FLAG = "aml_partner_compliance_workspace";

const coerce = (v: unknown): boolean =>
  v === true || v === "true" ||
  (typeof v === "object" && v !== null && (v as any).enabled === true);

/** Session-scoped memo so layout, nav and page share one read. */
const cache = new Map<string, Promise<boolean>>();

async function readEnabled(surface: WorkspaceSurfaceKey): Promise<boolean> {
  const { data, error } = await supabase
    .from("feature_flags").select("key, value")
    .in("key", [MASTER_FLAG, SURFACE_FLAG[surface]]);
  if (error || !data) return false;
  const byKey = new Map(data.map((r: any) => [r.key, r.value]));
  return coerce(byKey.get(MASTER_FLAG)) && coerce(byKey.get(SURFACE_FLAG[surface]));
}

export function usePartnerWorkspaceEnabled(surface: WorkspaceSurfaceKey): {
  loading: boolean; enabled: boolean;
} {
  const [state, setState] = useState<{ loading: boolean; enabled: boolean }>({
    loading: true, enabled: false,
  });
  useEffect(() => {
    let alive = true;
    if (!cache.has(surface)) cache.set(surface, readEnabled(surface).catch(() => false));
    cache.get(surface)!.then((enabled) => {
      if (alive) setState({ loading: false, enabled });
    });
    return () => { alive = false; };
  }, [surface]);
  return state;
}

/**
 * Whether ANY partner portal has the in-portal compliance workspace enabled.
 *
 * The Command Centre needs this to be honest about where a Passport actually
 * appears. On a deployment with every `aml_partner_workspace_*` flag off — as
 * production is — a partner has no in-portal surface at all, so the emailed
 * link is not one channel among several, it is the only one. An operator who
 * believes otherwise waits for a partner to "see it in their portal", which
 * is how a Passport that was never emailed went unnoticed.
 *
 * Fails CLOSED like the per-surface hook, and says `null` while it is still
 * reading rather than asserting "off".
 */
export function useAnyPartnerWorkspaceEnabled(): { loading: boolean; enabled: boolean | null } {
  const finance = usePartnerWorkspaceEnabled("finance");
  const builder = usePartnerWorkspaceEnabled("builder");
  const solicitor = usePartnerWorkspaceEnabled("solicitor");
  const loading = finance.loading || builder.loading || solicitor.loading;
  return {
    loading,
    enabled: loading ? null : (finance.enabled || builder.enabled || solicitor.enabled),
  };
}
