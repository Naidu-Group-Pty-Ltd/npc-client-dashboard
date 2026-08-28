/**
 * Stage 9 — the road from the recorded decision to an issued Passport, in
 * order, with the previous stage's outcome PULLED THROUGH.
 *
 * ── The defects this replaces ─────────────────────────────────────────
 * Stage 9 was three disconnected panels. Nothing on it said the case had
 * been CLEARED at Stage 8 — the reader saw "Under review — not yet
 * decided" about the gate and read it as the decision not pulling
 * through. Nothing ordered gate → preview → issue, so how the Aurixa
 * Passport actually gets issued was a hunt. And the stage's primary
 * button carried no actionType, so it fell to the workspace switch's
 * default — a scroll to a screening anchor that does not exist here —
 * the same broken-button class as Stages 6, 7 and 8 before it.
 *
 * ── What this module is ───────────────────────────────────────────────
 * Arrangement only. The decision comes from the case row, the gate from
 * the gate column, the credential state from the SERVER-derived passport
 * projection (this module never derives a passport state of its own —
 * that is the one rule the passport facts carry). Issuance stays where it
 * belongs: the MLRO controls in the reliance panel; preview is the
 * digital passport page, exactly as the client and partners will see it.
 */

export type GatePassportStepState =
  | "done"
  | "current"
  | "outstanding"
  | "blocked"
  /** Available at any moment and gates nothing — a look, not a step owed. */
  | "anytime";

export interface GatePassportStep {
  key: "decision" | "gate" | "preview" | "issue";
  label: string;
  state: GatePassportStepState;
  detail: string;
  blockedBy: string | null;
}

export interface GatePassportFacts {
  /** The Stage 8 outcome as the case row carries it: "cleared", "blocked",
   *  or null when no decision has been recorded. */
  decisionOutcome: "cleared" | "blocked" | null;
  gateStatus: string;
  /** SERVER-derived passport state code; null when the reading was
   *  unavailable — which is never treated as "not issued". */
  passportState: string | null;
  passportVersion: number | null;
  canReview: boolean;
}

const GATE_APPROVED = new Set(["approved", "approved_with_controls"]);
const REVIEWER_NEEDED = "Requires a reviewer or the MLRO";

export function gatePassportPath(f: GatePassportFacts): GatePassportStep[] {
  const gateApproved = GATE_APPROVED.has(f.gateStatus);
  const steps: GatePassportStep[] = [];

  /* 1 · The decision, pulled through from Stage 8 — the fact this stage
   *     used to keep silent about. */
  steps.push({
    key: "decision",
    label: "Compliance decision",
    state: f.decisionOutcome === "cleared"
      ? "done"
      : f.decisionOutcome === "blocked"
        ? "blocked"
        : "current",
    detail: f.decisionOutcome === "cleared"
      ? "Cleared — recorded on the Decision stage."
      : f.decisionOutcome === "blocked"
        ? "The case is blocked. Nothing here proceeds until an explicit decision reopens it."
        : "Record the decision on the Decision stage first.",
    blockedBy: f.decisionOutcome === "blocked" ? "The case is blocked" : null,
  });

  /* 2 · The gate — the explicit entitlement act. */
  steps.push({
    key: "gate",
    label: "Service gate approved",
    state: gateApproved
      ? "done"
      : f.decisionOutcome === "cleared"
        ? (f.canReview ? "current" : "blocked")
        : "outstanding",
    detail: gateApproved
      ? `${f.gateStatus.replace(/_/g, " ")} — the designated service may proceed.`
      : f.decisionOutcome === "cleared"
        ? "The case is cleared — approve the gate on the card below (the recorded decision suggests the status)."
        : `Currently ${f.gateStatus.replace(/_/g, " ")}. Approval happens on this stage once the case is cleared; every other gate status is recorded on the Decision stage.`,
    blockedBy: !gateApproved && f.decisionOutcome === "cleared" && !f.canReview
      ? REVIEWER_NEEDED
      : null,
  });

  /* 3 · Seeing the credential — before anything is issued, deliberately. */
  steps.push({
    key: "preview",
    label: "Preview the digital passport",
    state: "anytime",
    detail: "Open the Passport exactly as the client and partners will see it — worth a look before any version is issued.",
    blockedBy: null,
  });

  /* 4 · Issuance — by the SERVER's own state code, never re-derived. */
  const code = f.passportState;
  steps.push({
    key: "issue",
    label: "Issue the Passport",
    state: code === "issued_current"
      ? "done"
      : code === "ready_for_issuance" || code === "refresh_required" || code === "superseded"
        ? "current"
        : code === null
          ? "outstanding"
          : gateApproved
            ? "current"
            : "outstanding",
    detail: code === "issued_current"
      ? `Passport${f.passportVersion ? ` v${f.passportVersion}` : ""} is in force — every connected portal reads this version.`
      : code === "ready_for_issuance"
        ? "Ready — an authorised decision-maker issues it from the reliance panel below."
        : code === "refresh_required" || code === "superseded"
          ? "A newer version is needed — reissue from the reliance panel below."
          : code === null
            ? "The passport state could not be read just now — issuance lives in the reliance panel below."
            : gateApproved
              ? "The gate is approved — issue the attestation from the reliance panel below."
              : "Issued from the reliance panel once the gate approves the service.",
    blockedBy: null,
  });

  return steps;
}

/** Every owed step discharged — the case's credential is in force. */
export function gatePassportComplete(steps: GatePassportStep[]): boolean {
  return steps
    .filter((s) => s.state !== "anytime")
    .every((s) => s.state === "done");
}
