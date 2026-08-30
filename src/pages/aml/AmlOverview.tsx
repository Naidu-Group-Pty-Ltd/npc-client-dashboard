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
import { cn } from "@/lib/utils";
import {
  AmlEmptyState,
  AmlErrorState,
  AmlMetricCard,
  AmlPageHeader,
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

/**
 * The queues, and what a queue IS.
 *
 * ── Two entries left, and why ─────────────────────────────────────────
 * This list says "workspaces available to you right now" — work that is
 * waiting for somebody. Two of the six were not that.
 *
 * **Transactions** went. `aml.transactions` and `aml.transaction_parties`
 * both hold zero rows on this deployment, and the page it pointed at is a
 * PER-CASE surface that loads with `cases[0]` selected — the newest case,
 * chosen for the operator rather than by them. That is exactly why the
 * navigation audit already folded Transactions into Customer Compliance as a
 * stage inside a named customer's case and took it out of the strip; leaving
 * it here contradicted a decision the product had already made. The route,
 * the page and the per-case stage are all untouched.
 *
 * **Configuration** went, and did NOT become unreachable. It is not a queue:
 * nothing waits there, it is set once and revisited rarely, and it is
 * step-up protected — an administrator's destination rather than a shift's
 * work. But it is also the only discoverable route to the sanctions
 * register's health, and hiding the page entirely is what once stranded that
 * behind a blocked case. So it moved to the page header, where settings
 * belong, still gated on `aml.configure`.
 */
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
    key: "austrac",
    label: "AUSTRAC Hub",
    description: "SMR / TTR / IFTI drafting, MLRO approval and lodgement.",
    to: "/admin/aml/austrac",
    cta: "Open AUSTRAC Hub",
    capability: "aml.report",
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
        actions={
          <>
            <AmlRefreshButton onClick={refresh} loading={loadingCases || loadingMonitoring} />
            {/*
              Configuration is not a queue — nothing waits there, it is set
              once and revisited rarely, and it is step-up protected. It sits
              in the header because that is where settings belong, and it is
              here at all because it is the only discoverable route to the
              sanctions register's health: hiding the page is what once
              stranded that behind a blocked case.
            */}
            {canConfigure && (
              <Button asChild size="sm" variant="ghost">
                <Link to="/admin/aml/configuration">
                  <Settings2 aria-hidden="true" className="mr-2 h-4 w-4" />
                  Configuration
                </Link>
              </Button>
            )}
          </>
        }
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

      {/*
        ── One strip, not six cards ──────────────────────────────────
        These were six full metric cards in two sections: six borders, six
        paddings and six headers around six single-digit numbers, most of
        them a healthy zero — taking more height than the case list they sit
        above. They are a glance, not a reading.

        One card, two labelled groups, six dense cells. Every cell keeps its
        deep link, its loading skeleton and its "Not available" reading, so
        nothing about what the numbers MEAN changed — only how much of the
        page they take to say it.
      */}
      <Card>
        <CardContent className={cn(
          "grid gap-x-6 gap-y-5 p-4",
          canInvestigate && "lg:grid-cols-2 lg:divide-x lg:divide-border/60",
        )}>
          <section aria-labelledby="home-cases-heading">
            <h2
              id="home-cases-heading"
              className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground"
            >
              Customer cases
            </h2>
            <div className="grid grid-cols-1 divide-y divide-border/50 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              <AmlMetricCard
                dense
                title="Total"
                icon={Users}
                state={caseMetricState}
                value={totalCases}
                hint="All statuses."
                to="/admin/aml/cases"
              />
              <AmlMetricCard
                dense
                title="Open"
                icon={Gauge}
                state={caseMetricState}
                value={openCount}
                hint={`Of the ${cases.length || 0} most recent.`}
                to="/admin/aml/cases"
              />
              <AmlMetricCard
                dense
                title="Awaiting decision"
                icon={ShieldCheck}
                state={caseMetricState}
                value={escalated}
                hint="Escalated to the MLRO."
                to="/admin/aml/cases?view=awaiting_decision"
              />
            </div>
          </section>

          {canInvestigate && (
            <section aria-labelledby="home-monitoring-heading" className="lg:pl-6">
              <h2
                id="home-monitoring-heading"
                className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground"
              >
                Monitoring
              </h2>
              <div className="grid grid-cols-1 divide-y divide-border/50 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
                <AmlMetricCard
                  dense
                  title="Open alerts"
                  icon={Bell}
                  state={monitoringMetricState}
                  value={monitoring?.open_alerts}
                  hint={monitoring ? `${monitoring.critical_alerts} critical` : undefined}
                  to="/admin/aml/monitoring"
                />
                <AmlMetricCard
                  dense
                  title="Unprocessed"
                  icon={Gauge}
                  state={monitoringMetricState}
                  value={monitoring?.unprocessed_events}
                  hint="Rule engine backlog."
                  to="/admin/aml/monitoring"
                />
                <AmlMetricCard
                  dense
                  title="Periodic reviews"
                  icon={ShieldCheck}
                  state={monitoringMetricState}
                  value={monitoring?.pending_reviews}
                  hint={monitoring ? `${monitoring.overdue_reviews} overdue` : undefined}
                  to="/admin/aml/monitoring"
                />
              </div>
            </section>
          )}
        </CardContent>
      </Card>

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

      {/* Restricted-capability affordances are gated where they are drawn;
          nothing more leaks into the home for users without the permission. */}
      {!canReport && !canConfigure && (
        <p className="text-xs text-muted-foreground">
          Reporting and configuration surfaces are restricted and only appear for MLRO users.
        </p>
      )}
      {/*
        A second Configuration button used to sit here, under a comment that
        already said "restricted-capability affordances live in tiles above".
        It went to the same place as the tile and contradicted its own
        neighbour. Configuration is still reached from exactly two places, and
        the first of them has MOVED: the page header — gated on
        `aml.configure`, so an ordinary operator never sees it — and Stage 5's
        "open list health" when screening cannot run. It left the queue list
        because it is not a queue, and it did not leave the page, because
        hiding it is what once stranded the sanctions register behind a
        blocked case. It is still not in the navigation at all.
      */}
    </div>
  );
}
