import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertTriangle, CheckCircle2, Loader2, MailWarning, Send, UserPlus, Users,
} from "lucide-react";

import {
  passportRecipients, type RecipientFacts, type RecipientRow, type RecipientState,
} from "@/lib/aml/passport/passportRecipients.pure";

/**
 * Who holds this Passport — and the one click that sends it to somebody else.
 *
 * ── The defect this exists for ────────────────────────────────────────
 * Distribution to several partners is the entire point of a Compliance
 * Passport, and it had no surface. The workspace offered "Grant to existing
 * partner", which opened a free-text box that had to match an agreement's
 * organisation name exactly, and "Onboard partner & grant", which is a
 * five-step wizard for a partner who already exists. Everything else about
 * distribution was a three-line summary column reading "live" beside a
 * partner who had, in fact, been sent nothing.
 *
 * ── What this renders ─────────────────────────────────────────────────
 * One row per ACTIVE written arrangement, worst standing first, each with
 * exactly one act. It decides nothing: every state, every label and every
 * blocker comes from `passportRecipients`, and the act itself is
 * `grant_access`, which re-checks the arrangement, the review date, the
 * client's sharing consent and the attestation and refuses in its own words.
 *
 * The two things it is careful to say out loud, because both were silently
 * untrue on screen: a grant nobody emailed is not a partner who holds a
 * Passport, and on a deployment with the partner workspace switched off the
 * emailed link is the ONLY way a partner ever reaches this record.
 */

const STATE_STYLE: Record<RecipientState, { label: string; className: string }> = {
  holds: { label: "holds", className: "text-success" },
  expiring: { label: "expiring", className: "text-warning" },
  undelivered: { label: "never emailed", className: "text-destructive" },
  lapsed: { label: "expired", className: "text-muted-foreground" },
  revoked: { label: "withdrawn", className: "text-destructive" },
  never: { label: "not sent", className: "text-muted-foreground" },
};

export function PassportRecipientsPanel({
  facts, busyAgreementId, onSend, onOnboard, workspaceEnabled,
}: {
  facts: RecipientFacts;
  /** The row currently mid-send, so only its own button spins. */
  busyAgreementId: string | null;
  onSend: (row: RecipientRow) => void;
  onOnboard: () => void;
  /** null while unread — never rendered as "off" on a failed read. */
  workspaceEnabled: boolean | null;
}) {
  const reading = passportRecipients(facts);
  const busy = busyAgreementId !== null;

  return (
    <section className="rounded-md border border-border/60 p-3" aria-label="Passport recipients">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 shrink-0 text-primary" aria-hidden />
            <span className="text-sm font-medium">Who holds this Passport</span>
          </div>
          <p className="text-xs text-muted-foreground">{reading.headline}</p>
        </div>
        <Button size="sm" variant="outline" onClick={onOnboard} disabled={busy}>
          <UserPlus className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          Send to another partner
        </Button>
      </div>

      {/* The symptom, named once at the top rather than inferred from a row.
          A grant with no delivery is the state that reads as healthy in every
          register and is invisible to the partner. */}
      {reading.undelivered > 0 && (
        <div className="mt-2 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2.5">
          <MailWarning className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
          <p className="text-xs">
            {reading.undelivered === 1 ? "One partner has" : `${reading.undelivered} partners have`}{" "}
            access that was never emailed to anyone. The link is the credential and it is shown
            once, so it cannot be recovered — sending replaces the grant with one that is
            actually delivered.
          </p>
        </div>
      )}

      {/* Where a Passport actually appears, stated rather than assumed. */}
      {workspaceEnabled === false && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          The in-portal compliance workspace is switched off on this deployment, so the emailed
          link is the only way a partner reaches this Passport — nothing will appear inside their
          portal.
        </p>
      )}

      {reading.rows.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          A Passport goes to an organisation with a written CDD arrangement (AML/CTF Act Pt 2
          Div 7). Onboard the partner and the arrangement is recorded on the way through.
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {reading.rows.map((row) => {
            const style = STATE_STYLE[row.state];
            return (
              <li
                key={row.agreementId}
                className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5 rounded-md border border-border/50 p-2.5"
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{row.partnerName}</span>
                    <Badge variant="outline" className={style.className}>{style.label}</Badge>
                    <span className="text-[11px] text-muted-foreground">
                      {row.partnerType.replace(/_/g, " ")}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">{row.detail}</p>
                  {row.blockedBy ? (
                    <p className="flex items-center gap-1 text-[11px] text-warning">
                      <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
                      {row.blockedBy}.
                    </p>
                  ) : (
                    <p className="text-[11px] text-muted-foreground/90">{row.actionMeaning}</p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant={row.state === "undelivered" || row.state === "never" ? "default" : "outline"}
                  onClick={() => onSend(row)}
                  disabled={busy || row.blockedBy !== null}
                >
                  {busyAgreementId === row.agreementId
                    ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                    : <Send className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
                  {row.actionLabel}
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {reading.rows.length > 0 && reading.undelivered === 0 && reading.holding === reading.rows.length && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-success">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Every partner with an arrangement on this matter has been sent the Passport.
        </p>
      )}
    </section>
  );
}
