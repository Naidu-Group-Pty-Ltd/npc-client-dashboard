import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  FileText, ShieldCheck, BadgeCheck, Share2, User, Landmark, HardHat,
  Building2, Scale, Check, Circle,
} from "lucide-react";
import type { AmlCase } from "@/lib/aml/amlCasesApi";
import { stageStates } from "@/lib/aml/journeyMapStages.pure";
import { amlRelianceApi, type IndependentAssessment, type RelianceGrant } from "@/lib/aml/amlRelianceApi";

/**
 * Compliance Journey Map — the owner's five-portal flow diagram, rendered as
 * a living surface at the top of every case.
 *
 * Four stages across the top (Submit → Verify → Approve → Share) and the five
 * portal tiles beneath, each fed from data the module already records. This
 * component COMPUTES nothing about compliance — every state shown here is a
 * projection of decisions made elsewhere (the service gate is still only ever
 * moved by an explicit human decision; a partner's assessment is still only
 * ever theirs). It is a map, not a control panel.
 *
 * Styling: semantic tokens only, per FRONTEND_TOOLING.md — no raw palette
 * classes, so the map inherits both themes for free.
 */

/* The node states are derived in `journeyMapStages.pure.ts` — each node
 * answered by its own dimension (decision ≠ gate ≠ sharing), pinned by
 * tests there. This component only renders the answer. */

const STAGES = [
  { icon: FileText, label: "Client submits", sub: "KYC & onboarding" },
  { icon: ShieldCheck, label: "We verify", sub: "identity · screening" },
  { icon: BadgeCheck, label: "Approved", sub: "human decision" },
  { icon: Share2, label: "Shared", sub: "one process, every portal" },
] as const;

interface PortalTile {
  key: string;
  label: string;
  icon: typeof User;
  status: string;
  tone: "done" | "progress" | "idle";
}

function portalTiles(
  caseRow: AmlCase, grants: RelianceGrant[], assessments: IndependentAssessment[],
): PortalTile[] {
  const liveGrants = grants.filter((g) => !g.revoked_at);
  const byType = (t: string) =>
    liveGrants.filter((g) => g.reliance_agreements?.partner_org_type === t);
  const assessed = (t: string) =>
    assessments.some((a) =>
      a.status === "satisfied" &&
      liveGrants.some((g) => g.agreement_id === (a as any).agreement_id
        && g.reliance_agreements?.partner_org_type === t));

  const partnerTile = (key: string, label: string, icon: typeof User): PortalTile => {
    // A satisfied `IndependentAssessment` means that partner recorded itself
    // satisfied with the records we shared. It is not, and must not be shown
    // as, a claim that the partner or the case is compliant in its own right
    // — the tile used to say exactly that.
    if (assessed(key)) return { key, label, icon, status: "Partner assessment satisfied", tone: "done" };
    if (byType(key).length > 0) return { key, label, icon, status: "Passport shared", tone: "progress" };
    return { key, label, icon, status: "Not yet connected", tone: "idle" };
  };

  const portal = String(caseRow.client_portal_status ?? "not_started");
  const finance = String(caseRow.finance_portal_status ?? "not_requested");

  return [
    {
      key: "client", label: "Client portal", icon: User,
      status: portal === "complete" ? "Complete"
        : ["submitted", "under_review"].includes(portal) ? "Submitted"
        : portal === "in_progress" ? "In progress" : "Invited",
      tone: portal === "complete" ? "done"
        : portal === "not_started" ? "idle" : "progress",
    },
    {
      key: "finance", label: "Finance portal", icon: Landmark,
      status: byType("finance").length > 0 ? "Passport shared"
        : finance === "not_requested" ? "Not yet connected"
        : finance.replace(/_/g, " "),
      tone: assessed("finance") || byType("finance").length > 0 ? "progress"
        : finance === "not_requested" ? "idle" : "progress",
    },
    partnerTile("builder", "Builder portal", HardHat),
    partnerTile("developer", "Developer portal", Building2),
    partnerTile("solicitor_conveyancer", "Solicitors & conveyancers", Scale),
  ];
}

export function ComplianceJourneyMap({ caseRow }: { caseRow: AmlCase }) {
  const [grants, setGrants] = useState<RelianceGrant[]>([]);
  const [assessments, setAssessments] = useState<IndependentAssessment[]>([]);
  const [hasAttestation, setHasAttestation] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([
      amlRelianceApi.listGrants(caseRow.id).catch(() => ({ grants: [] })),
      amlRelianceApi.listAssessments(caseRow.id).catch(() => ({ assessments: [] })),
      amlRelianceApi.listAttestations(caseRow.id).catch(() => ({ attestations: [] })),
    ]).then(([g, a, at]) => {
      if (!alive) return;
      setGrants(g.grants ?? []);
      setAssessments(a.assessments ?? []);
      setHasAttestation((at.attestations ?? []).some((x: any) => !x.superseded_at));
    });
    return () => { alive = false; };
  }, [caseRow.id]);

  const states = stageStates(caseRow, hasAttestation, grants.filter((g) => !g.revoked_at).length);
  const tiles = portalTiles(caseRow, grants, assessments);
  const doneCount = states.filter((s) => s === "done").length;

  return (
    <Card className="overflow-hidden border-primary/20">
      <CardContent className="p-5">
        {/* ── the journey ─────────────────────────────────────────────── */}
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Compliance journey</h3>
          <Badge variant="outline" className="text-xs text-muted-foreground">
            One completed process · reused across all portals
          </Badge>
        </div>

        <ol className="relative mt-4 grid grid-cols-4 gap-2" aria-label="Compliance journey stages">
          {/* connector rail: track + progress fill */}
          <div aria-hidden className="absolute left-[12.5%] right-[12.5%] top-5 h-1 rounded-full bg-muted" />
          <div
            aria-hidden
            className="absolute left-[12.5%] top-5 h-1 rounded-full bg-primary transition-all duration-700"
            style={{ width: `${(Math.max(doneCount - 0.5, 0) / 4) * 100}%`, maxWidth: "75%" }}
          />
          {STAGES.map((stage, i) => {
            const state = states[i];
            const Icon = stage.icon;
            return (
              <li key={stage.label} className="relative z-10 flex flex-col items-center text-center">
                <span
                  className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-full border-2 bg-card transition-colors",
                    state === "done" && "border-primary bg-primary text-primary-foreground",
                    state === "active" && "border-primary text-primary animate-pulse",
                    state === "todo" && "border-border text-muted-foreground",
                  )}
                  aria-hidden
                >
                  {state === "done" ? <Check className="h-5 w-5" /> : <Icon className="h-5 w-5" />}
                </span>
                <span className={cn(
                  "mt-2 text-xs font-medium",
                  state === "todo" ? "text-muted-foreground" : "text-foreground",
                )}>
                  {stage.label}
                </span>
                <span className="text-[10px] text-muted-foreground">{stage.sub}</span>
                <span className="sr-only">
                  {state === "done" ? "complete" : state === "active" ? "in progress" : "not started"}
                </span>
              </li>
            );
          })}
        </ol>

        {/* ── the five portals ────────────────────────────────────────── */}
        <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {tiles.map((tile) => {
            const Icon = tile.icon;
            return (
              <div
                key={tile.key}
                className={cn(
                  "rounded-lg border p-2.5 text-center transition-colors",
                  tile.tone === "done" && "border-success/40 bg-success/5",
                  tile.tone === "progress" && "border-primary/40 bg-primary/5",
                  tile.tone === "idle" && "border-border/60",
                )}
              >
                <Icon className={cn(
                  "mx-auto h-4 w-4",
                  tile.tone === "done" ? "text-success"
                    : tile.tone === "progress" ? "text-primary" : "text-muted-foreground",
                )} aria-hidden />
                <div className="mt-1 truncate text-[11px] font-medium" title={tile.label}>
                  {tile.label}
                </div>
                <div className={cn(
                  "flex items-center justify-center gap-1 text-[10px]",
                  tile.tone === "done" ? "text-success"
                    : tile.tone === "progress" ? "text-primary" : "text-muted-foreground",
                )}>
                  {tile.tone === "done"
                    ? <Check className="h-2.5 w-2.5" aria-hidden />
                    : <Circle className="h-2 w-2" aria-hidden />}
                  <span className="truncate" title={tile.status}>{tile.status}</span>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
