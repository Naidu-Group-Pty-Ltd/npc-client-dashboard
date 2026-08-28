/**
 * Stage 9's ONE gate act — approving a cleared case's service gate.
 *
 * ── Why this is not the full gate card ────────────────────────────────
 * Gate & Passport used to mount the Decision stage's whole gate card —
 * eight statuses, the same choice grid, the same copy — and it read as a
 * duplicate of Stage 8. But removing the act entirely re-breaks the
 * stage's own "Record the service-gate decision" button. So Stage 9
 * keeps exactly the act it owes and nothing else: a cleared case whose
 * gate awaits an authorised approval gets the two approval choices, the
 * reason, and one button. Every other status — conditions, lock,
 * termination — is recorded on the Decision stage, and this card says so
 * rather than repeating the controls.
 *
 * When there is nothing to do here (not cleared, already approved, not a
 * reviewer, or the reading failed) it renders NOTHING — the guided path
 * above already narrates those states, and an empty echo of it is the
 * duplication this replaces. The server's `set_service_gate` still
 * enforces every rule.
 */
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import { amlRiskApi, type AmlServiceGateContract } from "@/lib/aml/amlRiskApi";
import { gateChangeHint, reasonHint } from "@/lib/aml/decisionPath.pure";
import { gateOptionGroups } from "@/lib/aml/gateOptions.pure";
import { cn } from "@/lib/utils";

const GATE_STOPPED = new Set(["locked", "terminated"]);
const GATE_APPROVED = new Set(["approved", "approved_with_controls"]);

export function GateApprovalCard({ caseId, cleared, canReview, isMlro, onChanged, onOpenDecision, anchorId }: {
  caseId: string;
  /** The Stage 8 outcome, dual-read from the case row by the caller. */
  cleared: boolean;
  canReview: boolean;
  isMlro: boolean;
  onChanged: () => void | Promise<void>;
  /** Routes to the Decision stage's full gate card (all statuses). */
  onOpenDecision: () => void;
  anchorId: string;
}) {
  const [gate, setGate] = useState<AmlServiceGateContract | null>(null);
  const [openConditionCount, setOpenConditionCount] = useState(0);
  const [choice, setChoice] = useState<string>("approved");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [g, c] = await Promise.all([
      amlRiskApi.gateContract(caseId).catch(() => ({ gate: null as any })),
      amlRiskApi.listConditions(caseId).catch(() => ({ conditions: [] as any[] })),
    ]);
    setGate(g.gate ?? null);
    setOpenConditionCount((c.conditions ?? []).filter((x: any) => x.status === "open").length);
  }, [caseId]);
  useEffect(() => { void load(); }, [load]);

  const approve = async () => {
    setBusy(true);
    try {
      await amlRiskApi.setServiceGate({ case_id: caseId, status: choice, reason: reason.trim() });
      toast({ title: "Service gate approved", description: "The designated service may proceed — the Passport can be issued below." });
      setReason("");
      await load();
      await onChanged();
    } catch (e: any) { toast({ title: "Gate approval failed", description: e.message, variant: "destructive" }); }
    finally { setBusy(false); }
  };

  // Nothing owed here → nothing rendered. The guided path narrates why.
  if (!cleared || !canReview || !gate) return null;
  if (GATE_APPROVED.has(gate.status) || GATE_STOPPED.has(gate.status)) return null;

  const suggested = gateOptionGroups({
    decisionOutcome: "cleared", currentGate: gate.status, isMlro,
  }).suggested;
  const hint = reasonHint(reason);
  const precondition = gateChangeHint(choice, {
    decisionOutcome: "cleared", openConditions: openConditionCount, isMlro,
  });

  return (
    <Card id={anchorId} className="scroll-mt-24 border-primary/30">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Approve the service gate</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2.5 text-sm">
        <p className="text-xs text-muted-foreground">
          The case is cleared — this is the one act this stage still owes. Approving grants the
          designated service; the reason is recorded on the gate decision and the audit trail.
        </p>
        <div role="radiogroup" aria-label="Gate approval status" className="grid gap-2 sm:grid-cols-2">
          {suggested.map((c) => (
            <button
              key={c.value}
              type="button"
              role="radio"
              aria-checked={choice === c.value}
              onClick={() => setChoice(c.value)}
              className={cn(
                "rounded-md border p-2.5 text-left transition-colors",
                choice === c.value ? "border-primary bg-primary/5" : "border-border/60 hover:border-primary/50",
              )}
            >
              <span className="block text-sm font-medium">{c.label}</span>
              <span className="block text-xs text-muted-foreground">{c.meaning}</span>
            </button>
          ))}
        </div>
        {precondition && (
          <p className="text-[11px] text-warning" aria-live="polite">{precondition}</p>
        )}
        <textarea
          className="min-h-[48px] w-full rounded-md border border-input bg-background p-2 text-sm"
          aria-label="Gate approval reason"
          placeholder="Reason (required, minimum 10 characters) — recorded on the gate decision and audit trail."
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {hint && (
          <p className="text-[11px] text-muted-foreground" aria-live="polite">{hint}</p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy || reason.trim().length < 10} onClick={approve}>
            Approve the gate — {suggested.find((c) => c.value === choice)?.label ?? choice}
          </Button>
          {/* Every non-approval status lives on the Decision stage — named
              here rather than duplicated here. */}
          <Button size="sm" variant="ghost" className="text-xs" onClick={onOpenDecision}>
            Need a different status? Full gate controls are on the Decision stage
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
