import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import {
  ShieldCheck,
  Home,
  Users,
  Coins,
  Gavel,
  Settings2,
  ChevronRight,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useAmlAccess } from "@/hooks/useAmlAccess";
import { hasAmlCapability, type AmlCapability } from "@/lib/aml/permissions";
import { useAmlTerminology } from "@/lib/aml/useAmlTerminology";
import { useAmlV3Flags } from "@/lib/aml/useAmlV3Flags";

/**
 * AML shell navigation.
 *
 * Ships two navigation configurations:
 *
 *  - **Legacy (V2, default)** — the five-workspace shell delivered in V2, kept
 *    byte-identical for tenants who have not yet enabled the V3 nav flag.
 *  - **V3** — activated by `feature_flags.aml_v3_nav = true`. Applies
 *    Directives 2, 3, 4, 7 and 8 from the Version 3 report:
 *      · Directive 2 — Customer Compliance is limited to Cases + My Queue.
 *        Verification, Screening, Risk, Structures and Finance handoff move
 *        inside the case workspace (built in Phase 4/6). Legacy URLs remain
 *        live via aliases in `src/App.tsx`.
 *      · Directive 3 — "Structures" is renamed "Ownership & Control" in the
 *        (transaction) counterparty entry.
 *      · Directive 4 — "Finance handoff" is renamed "Funding & Finance"
 *        wherever the legacy label still surfaces.
 *      · Directive 7 — "Platform Administration" is renamed
 *        "Organisation Settings".
 *      · Directive 8 — the tenant-facing Plans & Entitlements surface is
 *        withdrawn from workspace navigation.
 *
 * Server-side permission checks continue to run inside each route via
 * `AmlGuard`; this shell only decides what appears in the primary and
 * secondary nav.
 *
 * Presentation notes (UI/UX enhancement — behaviour unchanged):
 *  - Below `md` the two tab rows collapse into labelled Selects so the shell
 *    stays usable at 320–360 px without wrapping into five rows of tabs and
 *    without any horizontal-scroll-only interaction.
 *  - The header shows a workspace › section context line so deep pages keep
 *    their bearings; it never surfaces roles, capabilities or flag names.
 *  - The header is deliberately NOT sticky: the case workspace pins its own
 *    section nav and action panel (`lg:sticky lg:top-4`), and a sticky shell
 *    header would stack with those and hide focused content on short
 *    laptops.
 */

interface SecondaryEntry {
  label: string;
  to: string;
  end?: boolean;
  capability: AmlCapability;
}

interface Workspace {
  key: string;
  label: string;
  icon: LucideIcon;
  /** All URLs that should activate this workspace tab. */
  paths: string[];
  /** Where the workspace tab lands when clicked. */
  defaultPath: string;
  /** Minimum capability to see the workspace at all. */
  minCapability: AmlCapability;
  /** Workspace-local secondary navigation (case tabs / sub-sections). */
  secondary?: SecondaryEntry[];
}

const LEGACY_WORKSPACES: Workspace[] = [
  {
    key: "home",
    label: "Compliance Home",
    icon: Home,
    paths: ["/admin/aml"],
    defaultPath: "/admin/aml",
    minCapability: "aml.view",
  },
  {
    key: "customer",
    label: "Customer Compliance",
    icon: Users,
    paths: [
      "/admin/aml/cases",
      // A destination in `secondary` MUST also be listed here. `paths` is what
      // pathMatchesWorkspace resolves the active workspace from, and the
      // secondary strip is rendered from the ACTIVE workspace only — so a link
      // missing from this list navigates to a page that then shows no
      // secondary nav at all and highlights Compliance Home instead. That is
      // how the Passport shipped reachable and still looked absent.
      "/admin/aml/passport",
      "/admin/aml/intake",
      "/admin/aml/verification",
      "/admin/aml/screening",
      "/admin/aml/risk",
      "/admin/aml/counterparty",
      "/admin/aml/finance",
    ],
    defaultPath: "/admin/aml/cases",
    minCapability: "aml.view",
    secondary: [
      { label: "Register", to: "/admin/aml/cases", capability: "aml.view" },
      { label: "Compliance Passport", to: "/admin/aml/passport", capability: "aml.view" },
      { label: "Intake Queue", to: "/admin/aml/intake", capability: "aml.view" },
      { label: "Verification", to: "/admin/aml/verification", capability: "aml.view" },
      { label: "Screening", to: "/admin/aml/screening", capability: "aml.view" },
      { label: "Risk", to: "/admin/aml/risk", capability: "aml.view" },
      { label: "Ownership & Control", to: "/admin/aml/counterparty", capability: "aml.view" },
      { label: "Funding & Finance", to: "/admin/aml/finance", capability: "aml.investigate" },
    ],
  },
  {
    key: "transactions",
    label: "Transaction Compliance",
    icon: Coins,
    paths: ["/admin/aml/transactions"],
    defaultPath: "/admin/aml/transactions",
    minCapability: "aml.investigate",
    secondary: [
      { label: "Transactions", to: "/admin/aml/transactions", capability: "aml.investigate" },
    ],
  },
  {
    key: "regulatory",
    label: "Regulatory & Assurance",
    icon: Gavel,
    paths: [
      "/admin/aml/monitoring",
      "/admin/aml/investigations",
      "/admin/aml/austrac",
      "/admin/aml/records",
      "/admin/aml/governance",
    ],
    defaultPath: "/admin/aml/monitoring",
    minCapability: "aml.view",
    secondary: [
      { label: "Monitoring", to: "/admin/aml/monitoring", capability: "aml.view" },
      { label: "Investigations & EDD", to: "/admin/aml/investigations", capability: "aml.investigate" },
      { label: "AUSTRAC Hub", to: "/admin/aml/austrac", capability: "aml.report" },
      { label: "Records & Privacy", to: "/admin/aml/records", capability: "aml.view" },
      { label: "Governance", to: "/admin/aml/governance", capability: "aml.view" },
    ],
  },
  {
    key: "admin",
    label: "Organisation Settings",
    icon: Settings2,
    paths: ["/admin/aml/launch-ops", "/admin/aml/partner-operations", "/admin/aml/configuration"],
    defaultPath: "/admin/aml/launch-ops",
    minCapability: "aml.view",
    secondary: [
      { label: "Launch Operations", to: "/admin/aml/launch-ops", capability: "aml.view" },
      { label: "Partner Operations", to: "/admin/aml/partner-operations", capability: "aml.view" },
      { label: "Configuration", to: "/admin/aml/configuration", capability: "aml.configure" },
    ],
  },
];

/**
 * V3 nav (Directives 2, 3, 4, 7, 8).
 *
 * Structural changes vs legacy:
 *  - Customer Compliance: only Cases + My Queue. Verification / Screening /
 *    Risk / Ownership & Control / Funding & Finance are surfaced inside the
 *    case workspace (Phase 4/6) — their legacy routes remain reachable.
 *  - Transaction Compliance: gains Counterparty Due (formerly "Structures").
 *  - Organisation Settings: Governance & Contacts sits first (Directive 14
 *    contact register lands here in Phase 1); Configuration and Launch
 *    Operations follow. Plans & Entitlements is withdrawn (Directive 8).
 */
const V3_WORKSPACES: Workspace[] = [
  {
    key: "home",
    label: "Compliance Home",
    icon: Home,
    paths: ["/admin/aml"],
    defaultPath: "/admin/aml",
    minCapability: "aml.view",
  },
  {
    key: "customer",
    label: "Customer Compliance",
    icon: Users,
    paths: [
      "/admin/aml/cases",
      // Listed for the same reason as the legacy shell: `secondary` links must
      // appear in `paths` or the page they reach loses its secondary nav.
      "/admin/aml/passport",
      "/admin/aml/intake",
      // Legacy aliases stay part of this workspace for URL matching only.
      "/admin/aml/verification",
      "/admin/aml/screening",
      "/admin/aml/risk",
      "/admin/aml/finance",
    ],
    defaultPath: "/admin/aml/cases",
    minCapability: "aml.view",
    secondary: [
      { label: "Cases", to: "/admin/aml/cases", capability: "aml.view" },
      { label: "Compliance Passport", to: "/admin/aml/passport", capability: "aml.view" },
      { label: "My Queue", to: "/admin/aml/intake", capability: "aml.view" },
    ],
  },
  {
    key: "transactions",
    label: "Transaction Compliance",
    icon: Coins,
    paths: ["/admin/aml/transactions", "/admin/aml/counterparty"],
    defaultPath: "/admin/aml/transactions",
    minCapability: "aml.investigate",
    secondary: [
      { label: "Transactions", to: "/admin/aml/transactions", capability: "aml.investigate" },
      { label: "Counterparty Due", to: "/admin/aml/counterparty", capability: "aml.view" },
    ],
  },
  {
    key: "regulatory",
    label: "Regulatory & Assurance",
    icon: Gavel,
    paths: [
      "/admin/aml/monitoring",
      "/admin/aml/investigations",
      "/admin/aml/austrac",
      "/admin/aml/records",
    ],
    defaultPath: "/admin/aml/monitoring",
    minCapability: "aml.view",
    secondary: [
      { label: "Monitoring", to: "/admin/aml/monitoring", capability: "aml.view" },
      { label: "Investigations", to: "/admin/aml/investigations", capability: "aml.investigate" },
      { label: "AUSTRAC Hub", to: "/admin/aml/austrac", capability: "aml.report" },
      { label: "Records & Retention", to: "/admin/aml/records", capability: "aml.view" },
    ],
  },
  {
    key: "admin",
    label: "Organisation Settings",
    icon: Settings2,
    paths: [
      "/admin/aml/governance",
      "/admin/aml/configuration",
      "/admin/aml/launch-ops",
      "/admin/aml/partner-operations",
    ],
    defaultPath: "/admin/aml/governance",
    minCapability: "aml.view",
    secondary: [
      { label: "Governance & Contacts", to: "/admin/aml/governance", capability: "aml.view" },
      { label: "Configuration", to: "/admin/aml/configuration", capability: "aml.configure" },
      { label: "Launch Operations", to: "/admin/aml/launch-ops", capability: "aml.view" },
      { label: "Partner Operations", to: "/admin/aml/partner-operations", capability: "aml.view" },
    ],
  },
];

function pathMatchesWorkspace(pathname: string, workspace: Workspace): boolean {
  // Compliance Home matches only the exact root — every other path belongs to
  // the workspace whose `paths` list contains a matching prefix.
  if (workspace.key === "home") return pathname === "/admin/aml";
  return workspace.paths.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
}

export function AmlLayout() {
  const { roles, loading } = useAmlAccess();
  const { t } = useAmlTerminology();
  const { v3Nav } = useAmlV3Flags();
  const location = useLocation();
  const navigate = useNavigate();

  const WORKSPACES = v3Nav ? V3_WORKSPACES : LEGACY_WORKSPACES;

  // Only show workspaces the user has *any* legitimate reason to enter.
  // Server-side permission enforcement continues to happen inside each route
  // via `AmlGuard`; this filter simply hides unreachable entries.
  const visibleWorkspaces = useMemo(() => {
    if (loading) return WORKSPACES;
    return WORKSPACES.filter((w) => {
      if (!hasAmlCapability(roles, w.minCapability)) return false;
      if (!w.secondary || w.secondary.length === 0) return true;
      // Show the workspace if at least one secondary entry is permitted.
      return w.secondary.some((s) => hasAmlCapability(roles, s.capability));
    });
  }, [roles, loading, WORKSPACES]);

  const activeWorkspace =
    visibleWorkspaces.find((w) => pathMatchesWorkspace(location.pathname, w)) ??
    visibleWorkspaces[0];

  // If a user lands on a legacy URL they cannot access (permissions changed),
  // AmlGuard will already show the denial page — nothing to do here.

  // Route legacy `/admin/aml/intake` onward remains untouched. All legacy URLs
  // continue to resolve because the underlying routes in `src/App.tsx` are
  // preserved. This shell only changes the visual navigation grouping.

  // Auto-redirect: if the user lands on the module root but their default
  // landing role is not Compliance Home (Phase 2 will refine this per-role),
  // we still deliver them to `/admin/aml` for now — no forced redirect.
  useEffect(() => {
    // Reserved for Phase 2 role-based default landing.
  }, [navigate]);

  const secondary = activeWorkspace?.secondary?.filter((s) =>
    hasAmlCapability(roles, s.capability),
  );

  const activeSecondary = secondary?.find(
    (s) =>
      location.pathname === s.to || location.pathname.startsWith(s.to + "/"),
  );

  // Context line: where the user is within the module. On Compliance Home the
  // strapline reads better than a one-crumb trail.
  // Role chips + module status intentionally removed per Version 2 spec.
  const showTrail = activeWorkspace && activeWorkspace.key !== "home";
  const [lastRefreshed, setLastRefreshed] = useState(() => new Date());
  const refreshModule = () => {
    setLastRefreshed(new Date());
    window.dispatchEvent(new CustomEvent("aml-command-refresh"));
  };

  return (
    <div className="flex min-h-full flex-col">
      <header className="relative overflow-hidden border-b border-border/60 bg-card/80 supports-[backdrop-filter]:bg-card/60 backdrop-blur">
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-r from-primary/10 via-muted/10 to-warning/10" />
        <div className="relative mx-auto flex w-full max-w-[1600px] flex-col gap-3 px-4 py-3 sm:px-6">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <div aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-primary/25 bg-primary/10 text-primary shadow-sm">
                <ShieldCheck className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                  <span>{t("AML/CTF")}</span>
                  {showTrail && <ChevronRight aria-hidden="true" className="h-3 w-3" />}
                  {showTrail && <span className="text-foreground/80">{t(activeWorkspace.label)}</span>}
                </div>
                <h1 className="truncate text-base font-semibold tracking-tight sm:text-lg">
                  {showTrail && activeSecondary ? t(activeSecondary.label) : t("Compliance command centre")}
                </h1>
                <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                  {showTrail ? t("Case-centred operational control across customer, transaction, regulatory and platform workspaces.") : t("AUSTRAC-aligned KYC, screening, monitoring and reporting operations.")}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span aria-live="polite">Refreshed {lastRefreshed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              <Button type="button" size="sm" variant="outline" onClick={refreshModule} className="h-8">
                <RefreshCw aria-hidden="true" className="mr-2 h-3.5 w-3.5" />
                Refresh
              </Button>
              {activeWorkspace && (
                <Button asChild size="sm" className="h-8">
                  <Link to={activeWorkspace.defaultPath}>{activeWorkspace.key === "home" ? "Open queue" : `Open ${t(activeWorkspace.label)}`}</Link>
                </Button>
              )}
            </div>
          </div>

          <div className="grid gap-2 md:hidden">
            <label className="space-y-1 text-xs font-medium text-muted-foreground">
              <span>AML workspace</span>
              <Select value={activeWorkspace?.key} onValueChange={(key) => { const w = visibleWorkspaces.find((x) => x.key === key); if (w) navigate(w.defaultPath); }}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Choose a workspace" /></SelectTrigger>
                <SelectContent>{visibleWorkspaces.map((w) => <SelectItem key={w.key} value={w.key}>{t(w.label)}</SelectItem>)}</SelectContent>
              </Select>
            </label>
            {secondary && secondary.length > 1 && (
              <label className="space-y-1 text-xs font-medium text-muted-foreground">
                <span>{activeWorkspace?.label ?? "Workspace"} section</span>
                <Select value={activeSecondary?.to ?? ""} onValueChange={(to) => { if (to) navigate(to); }}>
                  <SelectTrigger className="w-full"><SelectValue placeholder="Choose a section" /></SelectTrigger>
                  <SelectContent>{secondary.map((s) => <SelectItem key={s.to} value={s.to}>{t(s.label)}</SelectItem>)}</SelectContent>
                </Select>
              </label>
            )}
          </div>

          <nav aria-label="AML workspaces" className="hidden min-w-0 grid-cols-5 gap-1 rounded-xl border border-border/60 bg-background/45 p-1 shadow-inner md:grid">
            {visibleWorkspaces.map((w) => { const active = activeWorkspace?.key === w.key; const Icon = w.icon; return (
              <Link key={w.key} to={w.defaultPath} className={cn("group inline-flex min-w-0 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background lg:text-sm", active ? "border-primary/30 bg-primary/10 text-primary shadow-sm" : "border-transparent text-muted-foreground hover:border-border/70 hover:bg-muted/55 hover:text-foreground")} aria-current={active ? "page" : undefined}>
                <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                <span className="truncate">{t(w.label)}</span>
              </Link>
            );})}
          </nav>

          {secondary && secondary.length > 0 && (
            <nav aria-label={`${activeWorkspace?.label} sections`} className="hidden flex-wrap gap-1 md:flex">
              {secondary.map((s) => { const active = location.pathname === s.to || location.pathname.startsWith(s.to + "/"); return (
                <Link key={s.to} to={s.to} className={cn("inline-flex shrink-0 items-center rounded-full border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background", active ? "border-primary/30 bg-primary/10 text-primary" : "border-border/50 bg-background/35 text-muted-foreground hover:bg-muted/60 hover:text-foreground")} aria-current={active ? "page" : undefined}>{t(s.label)}</Link>
              );})}
            </nav>
          )}
        </div>
      </header>

      <div className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-4 sm:px-6 sm:py-5">
        <Outlet />
      </div>
    </div>
  );
}
