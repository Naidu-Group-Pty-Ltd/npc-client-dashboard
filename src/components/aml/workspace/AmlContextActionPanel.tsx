/**
 * Case status transitions, in the right rail.
 *
 * ── What this does and does not do ────────────────────────────────────
 * It invents no server operation. The only mutation it performs is the
 * case status transition the original action panel performed, through the
 * same `amlCasesApi.transition` call, with the same legal transition map
 * (mirrored server-side), the same separation of attention-raising and
 * destructive options, and the same required, confirmed reason for Blocked
 * and Closed. Hiding a button was never authorisation and still is not —
 * the server decides.
 *
 * ── Why it reads the CANONICAL lifecycle ──────────────────────────────
 * `NEXT_STATUSES.closed` is `[]`, so a closed case has always had no
 * transitions — but this keyed that off the LEGACY `status` column, and the
 * legacy and canonical dimensions can disagree. They did, in production:
 * `reopen_case` moved `status` to its resumed value and left `case_stage` at
 * `closed`, so the Live Position rail said "Case stage: Closed" while this
 * panel offered the ordinary advances of a live case, Cleared among them.
 *
 * The write defect is fixed in `aml-cases` (`reopen_case` now syncs the
 * dimension, exactly as `transition` always has). This reads the canonical
 * dimension as well, because a UI that offers to advance a case the rest of
 * the product calls closed is wrong whichever side produced the divergence —
 * and the two deploy separately.
 *
 * ── What moved out of it ──────────────────────────────────────────────
 * It used to open with two context cards: what was outstanding in the
 * current *area*, and a restatement of the service gate. The journey
 * replaced areas with ten stages, and `AmlLivePositionRail` now carries
 * position, readiness, attention and the next action in one place — so
 * those two cards would have been a second, quieter copy of the rail
 * directly above them. The transitions are what is left, and they are the
 * only thing here that was ever a mutation.
 */
import { useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/hooks/use-toast";
import { amlCasesApi, type AmlCase, type AmlCaseStatus } from "@/lib/aml/amlCasesApi";
import { caseStage, CASE_STATUS_LABELS } from "@/lib/aml/caseDimensions";

/**
 * The legal transition map. Unchanged from the panel this replaces and
 * mirrored by the server, which remains authoritative.
 */
const NEXT_STATUSES: Record<AmlCaseStatus, AmlCaseStatus[]> = {
  draft: ["kyc_in_progress", "closed"],
  kyc_in_progress: ["kyc_complete", "edd_required", "blocked", "closed"],
  kyc_complete: ["under_review", "edd_required", "cleared", "closed"],
  edd_required: ["under_review", "escalated_mlro", "blocked", "closed"],
  under_review: ["cleared", "escalated_mlro", "edd_required", "blocked", "closed"],
  escalated_mlro: ["cleared", "blocked", "closed"],
  cleared: ["under_review", "closed"],
  blocked: ["under_review", "closed"],
  closed: [],
};

const PANEL_ATTENTION_TRANSITIONS = new Set<AmlCaseStatus>(["edd_required"]);
const PANEL_DESTRUCTIVE_TRANSITIONS = new Set<AmlCaseStatus>(["blocked", "closed"]);

const PANEL_DESTRUCTIVE_COPY: Partial<Record<AmlCaseStatus, { title: string; body: string; action: string }>> = {
  blocked: {
    title: "Block this case?",
    body: "Blocking locks the service gate and stops the client's onboarding until the case is re-reviewed. Record why this case is being blocked — the reason is written to the tamper-evident audit trail.",
    action: "Block case",
  },
  closed: {
    title: "Close this case?",
    body: "Closing ends this AML/CTF case. A closed case cannot be advanced further. Record why this case is being closed — the reason is written to the tamper-evident audit trail.",
    action: "Close case",
  },
};

export interface AmlContextActionPanelProps {
  caseRow: AmlCase;
  canWrite: boolean;
  isMlro: boolean;
  onChanged: () => void;
  /**
   * Resume a closed case. Reopening is a separate, reason-bearing decision
   * and must never be reachable as an ordinary status transition, so it is
   * passed in rather than performed here.
   */
  onReopen?: () => void;
}

export function AmlContextActionPanel({
  caseRow,
  canWrite,
  isMlro,
  onChanged,
  onReopen,
}: AmlContextActionPanelProps) {
  const [reason, setReason] = useState("");
  const [transitioning, setTransitioning] = useState(false);
  const [pendingDestructive, setPendingDestructive] = useState<AmlCaseStatus | null>(null);
  const [destructiveReason, setDestructiveReason] = useState("");

  /*
   * Terminal on EITHER dimension. They are two views of one lifecycle and a
   * disagreement between them is a defect rather than a third state, so the
   * safe reading is the one that does not offer to advance a retained record.
   */
  const closed = caseStage(caseRow) === "closed" || caseRow.status === "closed";
  const nextOptions = closed ? [] : (NEXT_STATUSES[caseRow.status] ?? []);
  const progressOptions = nextOptions.filter(
    (s) => !PANEL_ATTENTION_TRANSITIONS.has(s) && !PANEL_DESTRUCTIVE_TRANSITIONS.has(s),
  );
  const attentionOptions = nextOptions.filter((s) => PANEL_ATTENTION_TRANSITIONS.has(s));
  const destructiveOptions = nextOptions.filter((s) => PANEL_DESTRUCTIVE_TRANSITIONS.has(s));
  const destructiveCopy = pendingDestructive ? PANEL_DESTRUCTIVE_COPY[pendingDestructive] : null;

  const transition = async (to: AmlCaseStatus, reasonText?: string) => {
    setTransitioning(true);
    try {
      await amlCasesApi.transition(caseRow.id, to, reasonText || undefined);
      toast({
        title: "Status updated",
        description: `${CASE_STATUS_LABELS[caseRow.status]} → ${CASE_STATUS_LABELS[to]}`,
      });
      setReason("");
      setPendingDestructive(null);
      setDestructiveReason("");
      onChanged();
    } catch (e: any) {
      toast({ title: "Transition failed", description: e.message, variant: "destructive" });
    } finally {
      setTransitioning(false);
    }
  };

  return (
    <>
      {/*
        ── A closed case gets ONE action, and it is not a transition ──
        Reopening carries a reason and its own authority check. Presenting it
        among the ordinary advances would turn the two into the same gesture.
      */}
      {closed && (
        <Card>
          <CardContent className="space-y-2 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Case closed
            </p>
            <p className="text-xs text-muted-foreground">
              This AML/CTF record is retained for compliance purposes. The journey is not
              progressing and the ordinary status advances do not apply.
            </p>
            {canWrite && onReopen && (
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onReopen}>
                Reopen case to resume AML/CTF
              </Button>
            )}
            <p className="text-[11px] text-muted-foreground">
              Reopening restores the ability to work the case. It does not approve the
              service, revive a terminated service gate, or restore a revoked passport.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── Case status transitions ────────────────────────────────── */}
      {canWrite && nextOptions.length > 0 && (
        <Card>
          <CardContent className="space-y-2 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              Advance status
            </p>
            <Input
              aria-label="Reason for the status change"
              placeholder="Reason (optional)…"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={transitioning}
              className="h-8 text-xs"
            />
            <div className="flex flex-wrap gap-1.5">
              {progressOptions.map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  disabled={transitioning}
                  onClick={() => transition(s, reason)}
                >
                  {CASE_STATUS_LABELS[s]}
                </Button>
              ))}
              {attentionOptions.map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant="outline"
                  className="h-7 border-warning/40 text-xs text-warning hover:bg-warning/10 hover:text-warning"
                  disabled={transitioning}
                  onClick={() => transition(s, reason)}
                >
                  {CASE_STATUS_LABELS[s]}
                </Button>
              ))}
            </div>
            {destructiveOptions.length > 0 && (
              <div className="flex flex-wrap gap-1.5 border-t border-border/60 pt-2">
                {destructiveOptions.map((s) => (
                  <Button
                    key={s}
                    size="sm"
                    variant="outline"
                    className="h-7 border-destructive/40 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                    disabled={transitioning}
                    onClick={() => {
                      setDestructiveReason(reason);
                      setPendingDestructive(s);
                    }}
                  >
                    {CASE_STATUS_LABELS[s]}
                  </Button>
                ))}
              </div>
            )}
            {caseRow.status === "escalated_mlro" && !isMlro && (
              <p className="text-xs text-muted-foreground">
                Escalated decisions can only be recorded by authorised decision-makers.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Destructive transitions keep their confirmed, required reason. */}
      <AlertDialog
        open={!!pendingDestructive}
        onOpenChange={(o) => {
          if (!o) {
            setPendingDestructive(null);
            setDestructiveReason("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle aria-hidden="true" className="h-5 w-5 text-destructive" />
              {destructiveCopy?.title ?? "Confirm action"}
            </AlertDialogTitle>
            <AlertDialogDescription>{destructiveCopy?.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="aml-workspace-destructive-reason">Reason (required)</Label>
            <Textarea
              id="aml-workspace-destructive-reason"
              value={destructiveReason}
              onChange={(e) => setDestructiveReason(e.target.value)}
              rows={3}
              placeholder="Why is this case being blocked or closed?"
              disabled={transitioning}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={transitioning}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={transitioning || !destructiveReason.trim()}
              onClick={() => pendingDestructive && transition(pendingDestructive, destructiveReason.trim())}
            >
              {transitioning && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {destructiveCopy?.action ?? "Confirm"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
