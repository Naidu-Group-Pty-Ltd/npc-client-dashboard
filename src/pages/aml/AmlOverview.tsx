import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Gauge,
  ShieldCheck,
  Users,
  Info,
  Bell,
  Settings2,
  ArrowRight,
  Lock,
} from "lucide-react";
import { amlCasesApi, type AmlCase } from "@/lib/aml/amlCasesApi";
import { amlMonitoringApi, type AmlMonitoringSummary } from "@/lib/aml/amlMonitoringApi";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useAmlAccess } from "@/hooks/useAmlAccess";
import { hasAmlCapability, type AmlCapability } from "@/lib/aml/permissions";
import { suggestAmlLanding } from "@/lib/aml/defaultLanding";
import { useAmlV3Flags } from "@/lib/aml/useAmlV3Flags";
import { caseStage } from "@/lib/aml/caseDimensions";
import {
  AmlEmptyState,
  AmlErrorState,
  AmlMetricCard,
  AmlPageHeader,
  AmlPageSection,
  AmlRefreshButton,
  AmlRiskBadge,
  AmlStageBadge,
} from "@/components/aml/primitives";
import AmlComplianceHomeV3 from "./AmlComplianceHomeV3";

/**
 * Phase 2 — Compliance Home (role-adaptive).
 *
 * All tiles and queue links are derived from the user's **effective
 * capabilities** returned by `useAmlAccess`. Restricted metric counts
 * (reporting SLA, configuration health) are never rendered — not even
 * as blurred placeholders — for users lacking the underlying capability,
 * to comply with tipping-off protections in AGENTS.md §2.
 */

interface QueueLink {
  key: string;
  label: string;
  description: string;
  to: string;
  cta: string;
  capability: AmlCapability;
}

const QUEUE_LINKS: QueueLink[] = [
  {
    key: "cases",
    label: "Customer Case register",
    description: "Search, open and continue any customer compliance case.",
    to: "/admin/aml/cases",
    cta: "Open register",
    capability: "aml.view",
  },
  {
    key: "monitoring",
    label: "Monitoring & alerts",
    description: "Triage open alerts, unprocessed events and periodic reviews.",
    to: "/admin/aml/monitoring",
    cta: "Open monitoring",
    capability: "aml.investigate",
  },
  {
    key: "investigations",
    label: "Investigations & EDD",
    description: "Progress EDD workstreams and evidence-backed decisions.",
    to: "/admin/aml/investigations",
    cta: "Open investigations",
    capability: "aml.investigate",
  },
  {
    key: "transactions",
    label: "Transactions",
    description: "Investigate flagged transactions and IFTI/TTR triggers.",
    to: "/admin/aml/transactions",
    cta: "Open transactions",
    capability: "aml.investigate",
  },
  {
    key: "austrac",
    label: "AUSTRAC Hub",
    description: "SMR / TTR / IFTI drafting, MLRO approval and lodgement.",
    to: "/admin/aml/austrac",
    cta: "Open AUSTRAC Hub",
    capability: "aml.report",
  },
  {
    key: "configuration",
    label: "Configuration",
    description: "Tenant, thresholds, provider keys and program version.",
    to: "/admin/aml/configuration",
    cta: "Open configuration",
    capability: "aml.configure",
  },
];

export default function AmlOverview() {
  const { complianceHome: v3Home, loading: v3Loading } = useAmlV3Flags();

  // Phase 3 (V3) — swap to the action-led Compliance Home when the
  // `aml_v3_compliance_home` feature flag is on. Default false → V2 renders.
  if (!v3Loading && v3Home) {
    return <AmlComplianceHomeV3 />;
  }

  return <AmlOverviewV2 />;
}

function AmlOverviewV2() {
  const { roles, loading: accessLoading } = useAmlAccess();

  const canView = hasAmlCapability(roles, "aml.view");
  const canInvestigate = hasAmlCapability(roles, "aml.investigate");
  const canReport = hasAmlCapability(roles, "aml.report");
  const canConfigure = hasAmlCapability(roles, "aml.configure");

  const [loadingCases, setLoadingCases] = useState(true);
  const [cases, setCases] = useState<AmlCase[]>([]);
  const [totalCases, setTotalCases] = useState(0);
  const [caseError, setCaseError] = useState<string | null>(null);

  const [monitoring, setMonitoring] = useState<AmlMonitoringSummary | null>(null);
  const [loadingMonitoring, setLoadingMonitoring] = useState(false);
  const [monitoringSettled, setMonitoringSettled] = useState(false);

  const loadCases = useCallback(async (alive: () => boolean) => {
    try {
      setLoadingCases(true);
      setCaseError(null);
      const res = await amlCasesApi.list({ limit: 5 });
      if (!alive()) return;
      setCases(res.cases ?? []);
      setTotalCases(res.total ?? 0);
    } catch (e: any) {
      if (alive()) setCaseError(e?.message ?? "Unable to load cases");
    } finally {
      if (alive()) setLoadingCases(false);
    }
  }, []);

  const loadMonitoring = useCallback(async (alive: () => boolean) => {
    try {
      setLoadingMonitoring(true);
      const s = await amlMonitoringApi.summary();
      if (alive()) setMonitoring(s);
    } catch {
      // tile shows its unavailable state
      if (alive()) setMonitoring(null);
    } finally {
      if (alive()) {
        setLoadingMonitoring(false);
        setMonitoringSettled(true);
      }
    }
  }, []);

  useEffect(() => {
    if (!canView) return;
    let alive = true;
    void loadCases(() => alive);
    return () => { alive = false; };
  }, [canView, loadCases]);

  useEffect(() => {
    if (!canInvestigate) return;
    let alive = true;
    void loadMonitoring(() => alive);
    return () => { alive = false; };
  }, [canInvestigate, loadMonitoring]);

  const refresh = () => {
    const alive = () => true;
    if (canView) void loadCases(alive);
    if (canInvestigate) void loadMonitoring(alive);
  };

  const openCount = useMemo(
    () => cases.filter((c) => !["cleared", "closed", "blocked"].includes(c.status)).length,
    [cases],
  );
  const escalated = useMemo(
    () => cases.filter((c) => c.status === "escalated_mlro").length,
    [cases],
  );

  const landing = useMemo(() => suggestAmlLanding(roles), [roles]);

  const visibleQueues = useMemo(
    () => QUEUE_LINKS.filter((q) => hasAmlCapability(roles, q.capability)),
    [roles],
  );

  const caseMetricState = loadingCases ? "loading" : caseError ? "unavailable" : "ready";
  // "loading" until the fetch has actually settled — never a fabricated zero
  // in the paint before the effect runs.
  const monitoringMetricState = !monitoringSettled || loadingMonitoring
    ? "loading"
    : monitoring === null
      ? "unavailable"
      : "ready";

  // No access at all — actionable empty state.
  if (!accessLoading && roles.size === 0) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 py-10">
        <div className="flex items-center gap-3">
          <div
            aria-hidden="true"
            className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground"
          >
            <Lock className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">You don't have access yet</h2>
            <p className="text-sm text-muted-foreground">
              The AML/CTF workspace is visible, but acting in it needs an access grant.
            </p>
          </div>
        </div>
        <Alert>
          <Info className="h-4 w-4" />
          <AlertTitle>Request access</AlertTitle>
          <AlertDescription>
            Ask your compliance administrator to grant you AML access from{" "}
            <Link className="underline" to="/admin/users">User Management</Link>. Queues and
            restricted areas appear automatically once access is granted.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <AmlPageHeader
        title="Compliance Home"
        description="Your queues and case activity across the AML/CTF program."
        icon={ShieldCheck}
        actions={<AmlRefreshButton onClick={refresh} loading={loadingCases || loadingMonitoring} />}
      />

      {/* Role-adaptive landing hint */}
      {landing && (
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="text-sm font-medium">Jump back into your queue</div>
              <div className="text-xs text-muted-foreground">{landing.reason}</div>
            </div>
            <Button asChild size="sm">
              <Link to={landing.path}>
                {landing.label}
                <ArrowRight aria-hidden="true" className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {caseError && (
        <AmlErrorState
          title="Unable to load cases"
          message={caseError}
          onRetry={refresh}
        />
      )}

      {/* Case tiles — always visible for aml.view */}
      <AmlPageSection title="Customer cases" description="Case volume and what is waiting on a decision.">
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
          <AmlMetricCard
            title="Total cases"
            icon={Users}
            state={caseMetricState}
            value={totalCases}
            hint="Across all statuses in this tenant."
            to="/admin/aml/cases"
          />
          <AmlMetricCard
            title="Open (recent)"
            icon={Gauge}
            state={caseMetricState}
            value={openCount}
            hint={`Of the latest ${cases.length || 0} cases, still under investigation.`}
            to="/admin/aml/cases"
          />
          <AmlMetricCard
            title="Awaiting decision"
            icon={ShieldCheck}
            state={caseMetricState}
            value={escalated}
            hint="Escalated cases awaiting a decision."
            to="/admin/aml/cases?view=awaiting_decision"
          />
        </div>
      </AmlPageSection>

      {/* Investigate-only tiles: monitoring queue snapshot */}
      {canInvestigate && (
        <AmlPageSection title="Monitoring" description="Alert triage and periodic review backlog.">
          <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
            <AmlMetricCard
              title="Open alerts"
              icon={Bell}
              state={monitoringMetricState}
              value={monitoring?.open_alerts}
              hint={monitoring ? `${monitoring.critical_alerts} critical` : undefined}
              to="/admin/aml/monitoring"
            />
            <AmlMetricCard
              title="Unprocessed events"
              icon={Gauge}
              state={monitoringMetricState}
              value={monitoring?.unprocessed_events}
              hint="Rule engine backlog."
              to="/admin/aml/monitoring"
            />
            <AmlMetricCard
              title="Periodic reviews"
              icon={ShieldCheck}
              state={monitoringMetricState}
              value={monitoring?.pending_reviews}
              hint={monitoring ? `${monitoring.overdue_reviews} overdue` : undefined}
              to="/admin/aml/monitoring"
            />
          </div>
        </AmlPageSection>
      )}

      {/* Queue directory — only entries the user can reach */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Your queues</CardTitle>
          <p className="text-xs text-muted-foreground">
            Workspaces available to you right now, based on your assigned capabilities.
          </p>
        </CardHeader>
        <CardContent>
          {visibleQueues.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No actionable queues yet — request an AML role to get started.
            </p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {visibleQueues.map((q) => (
                <li
                  key={q.key}
                  className="flex items-start justify-between gap-3 rounded-lg border border-border/60 bg-card/40 p-3"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{q.label}</div>
                    <div className="text-xs text-muted-foreground">{q.description}</div>
                  </div>
                  <Button asChild size="sm" variant="outline" className="shrink-0">
                    <Link to={q.to}>{q.cta}</Link>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Latest cases with actionable empty state */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">Latest cases</CardTitle>
            <Button asChild size="sm" variant="outline">
              <Link to="/admin/aml/cases">Open case register →</Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loadingCases ? (
            <div className="space-y-2" role="status">
              <span className="sr-only">Loading latest cases</span>
              <Skeleton className="h-10 w-full" aria-hidden="true" />
              <Skeleton className="h-10 w-full" aria-hidden="true" />
              <Skeleton className="h-10 w-full" aria-hidden="true" />
            </div>
          ) : cases.length === 0 ? (
            <AmlEmptyState
              body="No cases yet. Cases are only created after a human-confirmed client activation — nothing is auto-generated from marketing leads."
              action={
                <Button asChild size="sm" variant="outline">
                  <Link to="/admin/aml/cases">Go to Case register</Link>
                </Button>
              }
            />
          ) : (
            <ul className="divide-y divide-border/60 text-sm">
              {cases.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{c.subject_display_name}</div>
                    <div className="text-xs text-muted-foreground">{c.case_reference}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {c.risk_rating && <AmlRiskBadge risk={c.risk_rating} />}
                    <AmlStageBadge stage={caseStage(c)} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Restricted-capability affordances live in tiles above; nothing more
          leaks into the home for users without the underlying permission. */}
      {!canReport && !canConfigure && (
        <p className="text-xs text-muted-foreground">
          Reporting and configuration surfaces are restricted and only appear for MLRO users.
        </p>
      )}
      {/*
        A second Configuration button used to sit here, under a comment that
        already said "restricted-capability affordances live in tiles above".
        It went to the same place as the tile and contradicted its own
        neighbour. Configuration is now reached from exactly two places: that
        tile — gated on `aml.configure`, so an ordinary operator never sees it
        — and Stage 5's "open list health" when screening cannot run. It is no
        longer in the navigation at all.
      */}
    </div>
  );
}
