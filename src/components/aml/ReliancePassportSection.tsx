import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Loader2, Share2, FileSignature, ShieldCheck, Link2, Eye, CheckCircle2, CircleDot, Lock,
  Send, Download, KeyRound, RefreshCw,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { usePromptDialog } from "@/components/aml/usePromptDialog";
import { PartnerOnboardingWizard } from "@/components/aml/PartnerOnboardingWizard";
import {
  PassportIssuedDialog, type PassportIssueResult,
} from "@/components/aml/PassportIssuedDialog";
import { passportActions, type PassportActionRow } from "@/lib/aml/passportActions.pure";
import {
  amlRelianceApi, type ComplianceAttestation, type DirectPartnerAcknowledgement,
  type IndependentAssessment, type PartnerCaseLink, type PartnerOrganisation,
  type PartnerRecordsRequest, type RelianceAgreement, type RelianceGrant,
} from "@/lib/aml/amlRelianceApi";
import { describeAcknowledgement, grantStanding } from "@/lib/aml/partnerOnboarding.pure";
import {
  newlyAccepted, readHandover, shouldWatchForAcceptance,
  type AcceptedPartner,
} from "@/lib/aml/passportHandover.pure";
import { downloadDirectAcknowledgement } from "@/lib/aml/directAcknowledgementDocument";

/**
 * Compliance Passport — one completed AML/CTF process, reused across every
 * portal under Pt 2 Div 7 reliance.
 *
 * What this panel never does: it never shows a partner our risk assessment,
 * and a partner's independent assessment never moves our case. The two
 * organisations' compliance states are linked by evidence, not by authority.
 *
 * The acts are rendered as an EXPLAINED, ordered list (passportActions.pure)
 * rather than four bare header buttons: production held zero written
 * arrangements, so "Grant access" refused every click with a toast that read
 * as a broken button. A blocked act names its enabler before the click, and
 * issuing an attestation asks for confirmation with the preview one click
 * away — an outward-facing version should be looked at before it exists.
 */
export function ReliancePassportSection({
  caseId, isMlro,
}: { caseId: string; isMlro: boolean }) {
  const navigate = useNavigate();
  const [attestations, setAttestations] = useState<ComplianceAttestation[]>([]);
  const [grants, setGrants] = useState<RelianceGrant[]>([]);
  const [assessments, setAssessments] = useState<IndependentAssessment[]>([]);
  const [agreements, setAgreements] = useState<RelianceAgreement[]>([]);
  const [links, setLinks] = useState<PartnerCaseLink[]>([]);
  const [organisations, setOrganisations] = useState<PartnerOrganisation[]>([]);
  const [recordsRequests, setRecordsRequests] = useState<PartnerRecordsRequest[]>([]);
  /* Agreements sent by email to partners outside the portals. */
  const [acknowledgements, setAcknowledgements] = useState<DirectPartnerAcknowledgement[]>([]);
  /** SERVER-derived passport state code; null when the reading failed. */
  const [passportStateCode, setPassportStateCode] = useState<string | null>(null);
  /** Whether the deployment can run material-change invalidation; null = unknown. */
  const [outboxEnabled, setOutboxEnabled] = useState<boolean | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmIssue, setConfirmIssue] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  /** The one moment the credential exists — see `PassportIssuedDialog`. */
  const [issued, setIssued] = useState<PassportIssueResult | null>(null);
  const { prompt, dialog } = usePromptDialog();

  const refresh = useCallback(async () => {
    try {
      const [a, g, s, ag] = await Promise.all([
        amlRelianceApi.listAttestations(caseId),
        amlRelianceApi.listGrants(caseId),
        amlRelianceApi.listAssessments(caseId),
        amlRelianceApi.listAgreements(),
      ]);
      setAttestations(a.attestations ?? []);
      setGrants(g.grants ?? []);
      setAssessments(s.assessments ?? []);
      setAgreements(ag.agreements ?? []);
    } catch {
      // Function not yet deployed in this environment — render empty state.
    }
    try {
      // Phase 1 surfaces load separately so an environment without the
      // partner-identity migration still renders the legacy panel.
      const [l, o] = await Promise.all([
        amlRelianceApi.listPartnerCaseLinks(caseId),
        amlRelianceApi.listPartnerOrganisations(),
      ]);
      setLinks(l.links ?? []);
      setOrganisations(o.partner_organisations ?? []);
    } catch {
      // Partner-identity tables not present yet — hide the links block.
    }
    try {
      const rr = await amlRelianceApi.staffListPartnerRecordsRequests(caseId);
      setRecordsRequests(rr.requests ?? []);
    } catch {
      // Phase 4 tables not present yet — hide the requests block.
    }
    try {
      const ack = await amlRelianceApi.listPartnerAcknowledgements(caseId);
      setAcknowledgements(ack.acknowledgements ?? []);
    } catch {
      // The acknowledgement table is not present in this environment yet.
    }
    try {
      // The server-derived passport state (refresh flags, supersession) —
      // a failed read stays null and is never treated as "not issued".
      const status = await amlRelianceApi.getPassportDistributionStatus(caseId);
      setPassportStateCode(status.passport?.state?.code ?? null);
    } catch {
      setPassportStateCode(null);
    }
    try {
      // Whether material-change invalidation can run here at all — the
      // health op reports the outbox flag as recorded configuration.
      const { health } = await amlRelianceApi.getPartnerEventsHealth();
      setOutboxEnabled(health?.outbox_enabled ?? null);
    } catch {
      setOutboxEnabled(null);
    } finally {
      setLoaded(true);
    }
  }, [caseId]);

  useEffect(() => { refresh(); }, [refresh]);

  /* ── the live indicator ───────────────────────────────────────────────
     A partner accepts on their own schedule, from an email, with nobody
     watching. This panel fetched once at mount, so an operator with the case
     open — which is exactly what an operator waiting on an acceptance does —
     kept reading "the partner has opened the agreement but not yet accepted
     it" for as long as the tab stayed open, while the register, the
     arrangement and the audit trail all said otherwise.

     Polling is bounded by the same rule the notification bell uses and by one
     more of its own: it runs only while something is actually out with a
     partner (`shouldWatchForAcceptance`), and never while the tab is hidden.
     A settled list asks nothing. Focus and visibility changes refresh
     regardless, because returning to the tab is the moment an operator most
     expects what they are looking at to be current. */
  const watching = shouldWatchForAcceptance(acknowledgements);
  const previousAcks = useRef<DirectPartnerAcknowledgement[] | null>(null);

  useEffect(() => {
    /* Nothing is compared until the first load has actually answered. The
       initial empty array is not a reading of anything — treating it as one
       announces every existing acceptance as though it had just arrived, on
       every page load, which is how an operator learns to dismiss these
       unread. */
    if (!loaded) return;
    const arrivals = newlyAccepted(previousAcks.current, acknowledgements);
    previousAcks.current = acknowledgements;
    for (const partner of arrivals) {
      toast({
        title: `${partner.partnerName} accepted the compliance agreement`,
        description: partner.acceptedByName
          ? `Signed by ${partner.acceptedByName}. The arrangement is recorded — the Passport can be issued to them now.`
          : "The arrangement is recorded — the Passport can be issued to them now.",
      });
    }
  }, [acknowledgements, loaded]);

  useEffect(() => {
    const onFocus = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    let timer: number | undefined;
    if (watching) {
      timer = window.setInterval(() => {
        if (document.visibilityState === "visible") refresh();
      }, 30_000);
    }
    return () => {
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [watching, refresh]);

  /** What the acceptance has unlocked, and what is owed because of it. */
  const handover = useMemo(() => readHandover({
    acknowledgements,
    agreements,
    grants,
    hasAttestation: attestations.some((a) => !a.superseded_at),
    isMlro,
  }), [acknowledgements, agreements, grants, attestations, isMlro]);

  /** The same reading, addressed by acknowledgement, for the row that reports it. */
  const awaitingIssueById = useMemo(
    () => new Map(handover.awaitingIssue.map((p) => [p.acknowledgementId, p])),
    [handover.awaitingIssue],
  );

  const issue = async () => {
    setBusy("issue");
    try {
      const { attestation } = await amlRelianceApi.issueAttestation(caseId);
      toast({
        title: `Attestation v${attestation.version} issued`,
        description: `Content hash ${attestation.payload_sha256.slice(0, 12)}… — nothing is shared yet; grant partner access when ready.`,
      });
      await refresh();
    } catch (e: any) {
      toast({ title: "Could not issue attestation", description: e?.message, variant: "destructive" });
    } finally { setBusy(null); }
  };

  const grant = async () => {
    const active = agreements.filter((a) => a.status === "active");
    if (active.length === 0) {
      toast({
        title: "No active CDD arrangement",
        description: "Reliance requires a written agreement with the partner organisation (Pt 2 Div 7). Record one first.",
        variant: "destructive",
      });
      return;
    }
    const values = await prompt({
      title: "Grant partner access",
      description:
        "The partner receives the current attestation — what procedures were performed, never our " +
        "assessments. Requires the client's sharing consent and a current written agreement.",
      confirmLabel: "Grant access",
      fields: [
        {
          name: "partner", label: `Partner organisation (${active.map((a) => a.partner_org_name).join(" · ")})`,
          required: true, placeholder: "Exact partner name from the list above…",
          helpText: "Must match an active agreement.",
        },
        {
          // The token exists for one moment only — emailing it here is the
          // only chance to deliver it without an operator copying it by hand.
          name: "deliver_to", label: "Email the passport link to (optional)",
          required: false, placeholder: "name@partner.com.au",
          helpText: "They open it without a portal login. Leave blank to hand the link over yourself.",
        },
      ],
    });
    if (!values) return;
    const agreement = active.find(
      (a) => a.partner_org_name.toLowerCase() === values.partner.trim().toLowerCase());
    if (!agreement) {
      toast({ title: "No active agreement matches that name", variant: "destructive" });
      return;
    }
    setBusy("grant");
    try {
      const res = await amlRelianceApi.grantAccess(caseId, agreement.id, {
        deliver_to: values.deliver_to?.trim() || undefined,
      });
      // The raw token exists only in this moment — surface it once, plainly.
      await prompt({
        title: "Partner access token — shown once",
        description:
          `${res.note} Expires ${new Date(res.grant.expires_at).toLocaleDateString()}.`,
        confirmLabel: "I have delivered it",
        fields: [{
          name: "token", label: "Access token (copy now)", type: "textarea",
          required: false, placeholder: res.access_token, helpText: res.access_token,
        }],
      });
      await refresh();
    } catch (e: any) {
      toast({ title: "Could not grant access", description: e?.message, variant: "destructive" });
    } finally { setBusy(null); }
  };

  /**
   * Issue the Passport to a partner who has already accepted.
   *
   * Everything the general "Grant partner access" flow asks for is already
   * known here: the acceptance named the arrangement, and the email it was
   * accepted from is where the link goes. Asking an operator to retype the
   * partner's name into a free-text field that must match an agreement
   * exactly — which is what the general flow does — is how a completed
   * acceptance ends up sitting there unissued.
   *
   * It performs nothing the server does not re-check. `grant_access` still
   * verifies the arrangement is active, that its review is not overdue, that
   * the client consented to sharing and that an attestation exists, and
   * refuses in its own words if any of that has lapsed.
   */
  const issuePassportTo = async (partner: AcceptedPartner) => {
    if (!partner.agreementId) {
      toast({
        title: "No arrangement on this acceptance",
        description: "Re-send the agreement — the acceptance is what records the arrangement a Passport requires.",
        variant: "destructive",
      });
      return;
    }
    setBusy("handover");
    try {
      const res = await amlRelianceApi.grantAccess(caseId, partner.agreementId, {
        deliver_to: partner.recipientEmail,
      });
      /* The raw link exists in this moment and never again — it is stored
         only as a hash — so it is handed to a dialog that can actually be
         copied FROM. The prompt this replaces carried the link as a field
         PLACEHOLDER, which is not a value: the box a reader saw as "the link"
         held nothing, could not be selected and could not be copied, at the
         one moment the credential existed. */
      setIssued({
        partnerName: partner.partnerName,
        recipientEmail: partner.recipientEmail,
        passportLink: res.passport_link ?? res.access_token,
        expiresAt: res.grant.expires_at,
        emailSent: res.link_email_sent,
        emailError: res.link_email_error,
      });
      if (res.link_email_sent === false) {
        toast({
          title: "The Passport was issued, but the email did not send",
          description: `Send the link to ${partner.recipientEmail} yourself, or re-issue once mail is working.`,
          variant: "destructive",
        });
      }
      await refresh();
    } catch (e: any) {
      toast({ title: "Could not issue the Passport", description: e?.message, variant: "destructive" });
    } finally { setBusy(null); }
  };

  /**
   * Re-issue the emailed agreement — to the same address or a different
   * one. The server supersedes the live request, so the previous link
   * stops working: that is what makes "send it somewhere else" safe.
   */
  const resendAcknowledgement = async (row: DirectPartnerAcknowledgement) => {
    const values = await prompt({
      title: "Re-send the compliance agreement",
      description:
        "A fresh link is sent and the previous one stops working. Change the address if it should go to someone else — the history keeps every address it was sent to.",
      confirmLabel: "Send agreement",
      fields: [
        { name: "recipient_name", label: "Recipient name", required: true, placeholder: row.recipient_name },
        { name: "recipient_email", label: "Recipient email", required: true, placeholder: row.recipient_email },
      ],
    });
    if (!values) return;
    setBusy("ack");
    try {
      const res = await amlRelianceApi.sendPartnerAcknowledgement({
        case_id: caseId, partner_org_id: row.partner_org_id,
        recipient_name: values.recipient_name.trim() || row.recipient_name,
        recipient_email: values.recipient_email.trim() || row.recipient_email,
        force: true,
      });
      toast({
        title: res.email_sent ? "Agreement sent" : "Agreement recorded — email did not send",
        description: res.email_sent
          ? `Emailed ${res.acknowledgement.recipient_email}.`
          : `${res.email_error ?? "The mail provider refused it."} The link is live; deliver it by hand if needed.`,
        variant: res.email_sent ? undefined : "destructive",
      });
      await refresh();
    } catch (e: any) {
      toast({ title: "Could not send the agreement", description: e?.message, variant: "destructive" });
    } finally { setBusy(null); }
  };

  /**
   * Re-issue a passport link.
   *
   * The token is stored only as a hash, so a link can never be re-read: a
   * re-issue MINTS A NEW GRANT and revokes the old one. That is also why it
   * re-runs every precondition — arrangement current, client consent,
   * attestation issued — and will refuse if any has lapsed since. It binds
   * to the CURRENT attestation, so the partner receives today's record.
   */
  const reissueGrant = async (row: RelianceGrant) => {
    const values = await prompt({
      title: "Re-issue the passport link",
      description:
        "A new link is issued and the previous one stops working. The partner receives the CURRENT attestation, and every condition is re-checked — if the arrangement's review has lapsed, this will refuse and say so.",
      confirmLabel: "Re-issue link",
      fields: [{
        name: "deliver_to", label: "Email the new link to",
        required: false,
        placeholder: row.delivered_to_email ?? "name@partner.com.au",
        helpText: row.delivered_to_email
          ? `Leave blank to use ${row.delivered_to_email} again.`
          : "Leave blank to hand the link over yourself.",
      }],
    });
    if (!values) return;
    setBusy("reissue");
    try {
      const res = await amlRelianceApi.grantAccess(caseId, row.agreement_id, {
        deliver_to: values.deliver_to?.trim() || row.delivered_to_email || undefined,
        reissue_of: row.id,
      });
      if (res.link_email_sent) {
        toast({
          title: "New link sent",
          description: `Emailed ${res.delivered_to}. The previous link no longer works.`,
        });
      } else {
        // The one-time link must never be lost to a mail outage.
        await prompt({
          title: "New link issued — deliver it yourself",
          description: `${res.link_email_error ?? "No delivery address was given."} Copy the link below; it is shown once.`,
          confirmLabel: "I have delivered it",
          fields: [{
            name: "link", label: "Passport link", type: "textarea", required: false,
            placeholder: res.passport_link, helpText: res.passport_link,
          }],
        });
      }
      await refresh();
    } catch (e: any) {
      toast({ title: "Could not re-issue the link", description: e?.message, variant: "destructive" });
    } finally { setBusy(null); }
  };

  /**
   * The executed agreement as a document. Rendered on first request and
   * stored, so every later request serves the same bytes — the copy the
   * partner holds and the copy on file are one object.
   */
  const downloadAcknowledgement = async (row: DirectPartnerAcknowledgement) => {
    setBusy("ack-doc");
    try {
      const res = await downloadDirectAcknowledgement(row.id);
      // A signed URL, opened rather than fetched: the browser downloads it
      // with the filename the server chose.
      window.open(res.url, "_blank", "noopener,noreferrer");
    } catch (e: any) {
      toast({
        title: "Could not produce the executed agreement",
        description: e?.message, variant: "destructive",
      });
    } finally { setBusy(null); }
  };

  const addAgreement = async () => {
    const values = await prompt({
      title: "Record a written CDD arrangement",
      description:
        "Section 37A reliance is unavailable without a written agreement that is regularly reviewed. " +
        "This records the arrangement; the agreement itself lives with legal.",
      confirmLabel: "Record arrangement",
      fields: [
        { name: "partner_org_name", label: "Partner organisation", required: true, placeholder: "e.g. Meridian Finance Group…" },
        { name: "partner_org_type", label: 'Type ("finance" / "builder" / "developer" / "solicitor_conveyancer" / "other")', required: true, placeholder: "finance" },
        { name: "agreement_reference", label: "Written agreement reference", required: true, placeholder: "e.g. CDD-2026-014…" },
        { name: "executed_on", label: "Executed on", type: "date", required: true },
        { name: "next_review_due", label: "Next review due", type: "date", required: true, helpText: "An overdue review blocks new grants." },
      ],
    });
    if (!values) return;
    setBusy("agreement");
    try {
      await amlRelianceApi.createAgreement({
        partner_org_name: values.partner_org_name,
        partner_org_type: values.partner_org_type.trim() as any,
        agreement_reference: values.agreement_reference,
        executed_on: values.executed_on,
        next_review_due: values.next_review_due,
      });
      toast({ title: "CDD arrangement recorded" });
      await refresh();
    } catch (e: any) {
      toast({ title: "Could not record arrangement", description: e?.message, variant: "destructive" });
    } finally { setBusy(null); }
  };

  const addOrganisation = async () => {
    const values = await prompt({
      title: "Record a partner organisation",
      description:
        "The canonical legal identity of a partner. Classification stays 'unclassified' until the " +
        "MLRO records it with evidence — the system never infers a legal status.",
      confirmLabel: "Record organisation",
      fields: [
        { name: "legal_name", label: "Legal name", required: true, placeholder: "e.g. Meridian Finance Group Pty Ltd…" },
        { name: "organisation_type", label: 'Type ("finance" / "builder" / "developer" / "solicitor_conveyancer" / "other")', required: true, placeholder: "finance" },
        { name: "abn", label: "ABN (optional)", required: false, placeholder: "11 digits…" },
      ],
    });
    if (!values) return;
    setBusy("org");
    try {
      await amlRelianceApi.upsertPartnerOrganisation({
        legal_name: values.legal_name,
        organisation_type: values.organisation_type.trim() as any,
        abn: values.abn || undefined,
      });
      toast({ title: "Partner organisation recorded", description: "Classification: unclassified until the MLRO records it." });
      await refresh();
    } catch (e: any) {
      toast({ title: "Could not record organisation", description: e?.message, variant: "destructive" });
    } finally { setBusy(null); }
  };

  const addLink = async () => {
    if (organisations.length === 0) {
      // Not an error — a missing prerequisite with a paved road: the
      // wizard records the organisation on the way.
      toast({
        title: "No partner organisations recorded yet",
        description: "Use \"Onboard partner & grant\" above — it records the organisation, the arrangement and this link in one pass.",
      });
      setWizardOpen(true);
      return;
    }
    const values = await prompt({
      title: "Link a partner to this case",
      description:
        "The link records why this organisation may access this matter. It grants nothing by " +
        "itself — no passport, no reliance, no data flow. The legal route is a recorded decision, " +
        "never inferred from the portal.",
      confirmLabel: "Link partner",
      fields: [
        {
          name: "partner", label: `Partner organisation (${organisations.map((o) => o.legal_name).join(" · ")})`,
          required: true, placeholder: "Exact legal name from the list above…",
        },
        { name: "portal_type", label: 'Portal ("finance" / "builder" / "developer" / "solicitor_conveyancer" / "other")', required: true, placeholder: "finance" },
        { name: "relationship_role", label: "Relationship role", required: true, placeholder: "e.g. lender, buyer_solicitor, builder…" },
        { name: "legal_route", label: 'Legal route ("reliance" / "outsourced_cdd" / "independent_cdd" / "information_share_only")', required: true, placeholder: "independent_cdd" },
        { name: "purpose", label: "Documented purpose", type: "textarea", required: true, placeholder: "Why this organisation needs access to this matter…" },
      ],
    });
    if (!values) return;
    const org = organisations.find(
      (o) => o.legal_name.toLowerCase() === values.partner.trim().toLowerCase());
    if (!org) {
      toast({ title: "No recorded organisation matches that name", variant: "destructive" });
      return;
    }
    setBusy("link");
    try {
      await amlRelianceApi.linkPartnerToCase({
        case_id: caseId, partner_org_id: org.id,
        portal_type: values.portal_type.trim(),
        relationship_role: values.relationship_role.trim(),
        legal_route: values.legal_route.trim() as any,
        purpose: values.purpose,
      });
      toast({ title: "Partner linked", description: "The link is an access root only — no reliance follows from it." });
      await refresh();
    } catch (e: any) {
      toast({ title: "Could not link partner", description: e?.message, variant: "destructive" });
    } finally { setBusy(null); }
  };

  const endLink = async (link: PartnerCaseLink) => {
    const values = await prompt({
      title: "End partner link",
      description: "Ending the link removes the access root. The reason code is partner-safe.",
      confirmLabel: "End link",
      fields: [{
        name: "reason", label: 'Reason ("completed" / "withdrawn" / "superseded" / "client_declined" / "other")',
        required: true, placeholder: "completed",
      }],
    });
    if (!values) return;
    setBusy("endlink");
    try {
      await amlRelianceApi.setPartnerCaseLinkState({
        link_id: link.id, state: "ended", end_reason_code: values.reason.trim() as any,
      });
      toast({ title: "Partner link ended" });
      await refresh();
    } catch (e: any) {
      toast({ title: "Could not end link", description: e?.message, variant: "destructive" });
    } finally { setBusy(null); }
  };

  const reviewRecordsRequest = async (request: PartnerRecordsRequest) => {
    const values = await prompt({
      title: "Review partner records request",
      description:
        `${request.partner_organisations?.legal_name ?? "Partner"} requested: ` +
        `${request.requested_record_codes.join(", ")}. Releasing CDD records is a restricted ` +
        "disclosure decision. The response message is shown to the partner — write it partner-safe.",
      confirmLabel: "Record decision",
      fields: [
        { name: "decision", label: 'Decision ("approved" / "partly_approved" / "denied" / "under_review")', required: true, placeholder: "approved" },
        { name: "approved_codes", label: "Approved codes (comma-separated; blank = all requested for approval)", required: false, placeholder: request.requested_record_codes.join(", ") },
        { name: "response_message", label: "Partner-safe response message", type: "textarea", required: false, placeholder: "What the partner will read…" },
      ],
    });
    if (!values) return;
    setBusy("review-request");
    try {
      const decision = values.decision.trim() as any;
      const approved = values.approved_codes
        ? values.approved_codes.split(",").map((c) => c.trim()).filter(Boolean)
        : decision === "approved" ? request.requested_record_codes : [];
      await amlRelianceApi.reviewPartnerRecordsRequest({
        request_id: request.id, decision,
        approved_record_codes: approved,
        response_message: values.response_message,
      });
      toast({ title: "Records request decision recorded" });
      await refresh();
    } catch (e: any) {
      toast({ title: "Could not record decision", description: e?.message, variant: "destructive" });
    } finally { setBusy(null); }
  };

  const recordDelivery = async (request: PartnerRecordsRequest) => {
    const values = await prompt({
      title: "Record evidence delivery",
      description:
        "Metadata only: the delivery register records what was supplied, its hash and expiry. " +
        `Approved codes: ${request.approved_record_codes.join(", ") || "none"}.`,
      confirmLabel: "Record delivery",
      fields: [
        { name: "record_code", label: "Record code (from the approved list)", required: true, placeholder: request.approved_record_codes[0] ?? "" },
        { name: "safe_label", label: "Partner-safe label", required: true, placeholder: "e.g. Identity verification record — J. Citizen…" },
        { name: "delivered_sha256", label: "Content hash (optional)", required: false, placeholder: "sha256…" },
      ],
    });
    if (!values) return;
    setBusy("delivery");
    try {
      await amlRelianceApi.recordPartnerEvidenceDelivery({
        request_id: request.id,
        record_code: values.record_code.trim(),
        safe_label: values.safe_label,
        delivered_sha256: values.delivered_sha256 || undefined,
      });
      toast({ title: "Evidence delivery recorded" });
      await refresh();
    } catch (e: any) {
      toast({ title: "Could not record delivery", description: e?.message, variant: "destructive" });
    } finally { setBusy(null); }
  };

  const recordAssessment = async (agreement: RelianceAgreement) => {
    const values = await prompt({
      title: `Assess arrangement — ${agreement.partner_org_name}`,
      description:
        "s 37A requires the arrangement to be regularly reviewed. The assessment history is " +
        "immutable: a new assessment supersedes the previous one, it never edits it.",
      confirmLabel: "Record assessment",
      fields: [
        { name: "trigger", label: 'Trigger ("initial" / "scheduled" / "significant_change" / "incident" / "other")', required: true, placeholder: "scheduled" },
        { name: "decision", label: 'Decision ("suitable" / "suitable_with_conditions" / "unsuitable")', required: true, placeholder: "suitable" },
        { name: "next_due_at", label: "Next assessment due", type: "date", required: true, helpText: "An overdue assessment blocks new reliance grants." },
        { name: "findings", label: "Findings", type: "textarea", required: false, placeholder: "Required unless plainly suitable…" },
      ],
    });
    if (!values) return;
    setBusy("assessment");
    try {
      await amlRelianceApi.recordArrangementAssessment({
        agreement_id: agreement.id,
        trigger: values.trigger.trim() as any,
        decision: values.decision.trim() as any,
        next_due_at: values.next_due_at,
        findings: values.findings || undefined,
      });
      toast({ title: "Arrangement assessment recorded" });
      await refresh();
    } catch (e: any) {
      toast({ title: "Could not record assessment", description: e?.message, variant: "destructive" });
    } finally { setBusy(null); }
  };

  // Phase 6: recompute the material-input hash against live case data and,
  // where it genuinely changed, atomically flag the attestation, grants and
  // partner determinations for refresh (never the case, gate or risk state).
  const materialChange = async () => {
    setBusy("material");
    try {
      const result = await amlRelianceApi.applyMaterialChange({ case_id: caseId });
      if (!result.material) {
        toast({ title: "No material change", description: result.message });
      } else {
        toast({
          title: "Material change recorded",
          description: `Changed: ${result.changed_groups.join(", ")}. Partners see safe refresh wording only.`,
        });
      }
      await refresh();
    } catch (e: any) {
      toast({ title: "Could not evaluate material change", description: e?.message, variant: "destructive" });
    } finally { setBusy(null); }
  };

  if (!loaded) return null;
  const current = attestations.find((a) => !a.superseded_at) ?? null;
  const nextVersion = (current?.version ?? 0) + 1;

  const activeAgreementCount = agreements.filter((a) => a.status === "active").length;
  const actionRows = passportActions({
    attestationVersion: current?.version ?? null,
    issuedAt: current?.issued_at ?? null,
    passportStateCode,
    activeAgreements: activeAgreementCount,
    activeGrants: grants.filter((g) => !g.revoked_at).length,
    isMlro,
    materialChangeAvailable: outboxEnabled,
    awaitingPassportIssue: handover.awaitingIssue.length,
    awaitingPassportName: handover.awaitingIssue.length === 1
      ? handover.awaitingIssue[0].partnerName
      : null,
  });

  /* Each explained row carries its own act — the same handlers the old
   * header buttons invoked, minus the guessing about what they do. */
  const actionButton = (row: PassportActionRow) => {
    if (!isMlro && row.key !== "preview") return null;
    const spinning = (key: string) => busy === key && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />;
    switch (row.key) {
      case "preview":
        return (
          <Button size="sm" variant="outline"
            onClick={() => navigate(`/admin/aml/passport?case=${caseId}`)}>
            <Eye className="mr-1.5 h-3.5 w-3.5" /> Preview
          </Button>
        );
      case "issue":
        return (
          <Button size="sm" onClick={() => setConfirmIssue(true)} disabled={busy !== null}>
            {spinning("issue")}
            {current ? `Reissue as v${nextVersion}` : "Issue v1"}
          </Button>
        );
      case "arrangement":
        return (
          <Button size="sm" variant="outline" onClick={addAgreement} disabled={busy !== null}>
            <FileSignature className="mr-1.5 h-3.5 w-3.5" /> Record arrangement
          </Button>
        );
      case "grant":
        /* The paved road is the onboarding wizard — it records the
         * organisation, the arrangement and the case link on the way to
         * the grant, so a brand-new partner is one pass, not four
         * dialogs. The direct grant stays for partners whose arrangement
         * already exists. */
        return (
          <div className="flex flex-wrap justify-end gap-2">
            {activeAgreementCount > 0 && (
              <Button size="sm" variant="outline" onClick={grant}
                disabled={busy !== null || row.state === "blocked"}>
                {spinning("grant")} Grant to existing partner
              </Button>
            )}
            <Button size="sm" onClick={() => setWizardOpen(true)}
              disabled={busy !== null || row.state === "blocked"}>
              Onboard partner &amp; grant
            </Button>
          </div>
        );
      case "material":
        return (
          <Button size="sm" variant="outline" onClick={materialChange}
            disabled={busy !== null || row.state === "blocked"}>
            {spinning("material")} Run check
          </Button>
        );
    }
  };

  const stateChip = (row: PassportActionRow) => {
    switch (row.state) {
      case "done":
        return <span className="inline-flex items-center gap-1 text-[11px] font-medium uppercase text-success"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Done</span>;
      case "ready":
        return <span className="inline-flex items-center gap-1 text-[11px] font-medium uppercase text-primary"><CircleDot className="h-3.5 w-3.5" aria-hidden /> Next</span>;
      case "blocked":
        return <span className="inline-flex items-center gap-1 text-[11px] font-medium uppercase text-warning"><Lock className="h-3.5 w-3.5" aria-hidden /> Blocked</span>;
      default:
        return <span className="inline-flex items-center gap-1 text-[11px] font-medium uppercase text-muted-foreground"><Eye className="h-3.5 w-3.5" aria-hidden /> Anytime</span>;
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Share2 className="h-4 w-4 text-primary" /> Compliance passport — cross-portal reliance
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {/* ── the handover, at the top, where a next step belongs ─────────
            An acceptance arrives from an email with nobody watching, and
            everything it unlocks is true in the database and silent on the
            screen. This says what happened, what is owed because of it, and
            offers exactly that act — so the answer to "the partner has
            signed, now what?" is the first thing on the card rather than
            something to be inferred from a badge four blocks down. */}
        {handover.state !== "none" && (
          <div
            className={`rounded-md border p-3 ${
              handover.state === "ready_to_issue"
                ? "border-primary/40 bg-primary/5"
                : handover.state === "issued"
                  ? "border-success/40 bg-success/5"
                  : "border-border/60"
            }`}
            aria-live="polite"
          >
            <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  {handover.state === "issued" ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden />
                  ) : handover.state === "awaiting" ? (
                    <CircleDot className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  ) : (
                    <KeyRound className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                  )}
                  <span className="text-sm font-medium">{handover.headline}</span>
                  {watching && (
                    <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <RefreshCw className="h-3 w-3 animate-spin [animation-duration:3s]" aria-hidden />
                      live
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">{handover.detail}</p>
                {handover.blockedBy && (
                  <p className="text-[11px] text-warning">{handover.blockedBy}.</p>
                )}
                {handover.awaitingIssue.length > 0 && (
                  <ul className="space-y-0.5 pt-0.5">
                    {handover.awaitingIssue.map((partner) => (
                      <li key={partner.acknowledgementId} className="text-[11px] text-muted-foreground">
                        {partner.partnerName} · accepted
                        {partner.acceptedByName ? ` by ${partner.acceptedByName}` : ""}
                        {partner.acceptedAt
                          ? ` on ${new Date(partner.acceptedAt).toLocaleDateString()}`
                          : ""} · {partner.recipientEmail}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {handover.state === "ready_to_issue" && handover.awaitingIssue.length === 1 && (
                <Button
                  size="sm"
                  onClick={() => issuePassportTo(handover.awaitingIssue[0])}
                  disabled={busy !== null}
                >
                  {busy === "handover"
                    ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                    : <KeyRound className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
                  Issue the Passport
                </Button>
              )}
            </div>
          </div>
        )}

        {/*
          The acts, in order and in words. What each button DOES sits
          beside it, a blocked act names its enabler before the click, and
          nothing here is a compliance claim — availability only.
        */}
        <ol className="space-y-2" aria-label="Passport actions, in order">
          {actionRows.map((row) => (
            <li key={row.key}
              className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-border/60 p-2.5">
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{row.label}</span>
                  {stateChip(row)}
                </div>
                <p className="text-xs text-muted-foreground">{row.meaning}</p>
                <p className="text-[11px] text-muted-foreground/90">{row.detail}</p>
                {row.blockedBy && (
                  <p className="text-[11px] text-warning">{row.blockedBy}.</p>
                )}
              </div>
              <div className="shrink-0">{actionButton(row)}</div>
            </li>
          ))}
        </ol>

        <Alert>
          <ShieldCheck className="h-4 w-4" />
          <AlertTitle className="text-sm">One process, every portal</AlertTitle>
          <AlertDescription className="text-xs">
            Partners with a written CDD arrangement (AML/CTF Act Pt 2 Div 7) rely on the procedures
            attested here, or record their own independent assessment against the same records —
            without re-approaching the client. They see what was <em>performed</em>, never our risk
            assessment; their determinations never move this case.
          </AlertDescription>
        </Alert>

        <div className="grid gap-3 sm:grid-cols-3 text-xs">
          <div>
            <div className="font-medium">Attestation</div>
            {current ? (
              <div className="text-muted-foreground">
                v{current.version} · {new Date(current.issued_at).toLocaleDateString()}
                <div className="truncate" title={current.payload_sha256}>
                  sha {current.payload_sha256.slice(0, 16)}…
                </div>
              </div>
            ) : <div className="text-muted-foreground">Not issued</div>}
          </div>
          <div>
            <div className="font-medium">Passport links</div>
            {grants.length === 0 ? (
              <div className="text-muted-foreground">None</div>
            ) : grants
              // A grant replaced by a re-issue is history, not a live row.
              .filter((g) => g.revoke_reason !== "superseded_by_reissue")
              .map((g) => {
                const standing = grantStanding({
                  expiresAt: g.expires_at,
                  revokedAt: g.revoked_at,
                  revokeReason: g.revoke_reason,
                  linkRequestedAt: g.link_requested_at ?? null,
                });
                return (
                  <div key={g.id} className="mt-1 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium text-foreground">
                        {g.reliance_agreements?.partner_org_name ?? "Partner"}
                      </span>
                      <Badge variant="outline" className={
                        standing.state === "live" ? "text-success"
                          : standing.state === "expiring" ? "text-warning"
                            : standing.state === "revoked" ? "text-destructive"
                              : "text-muted-foreground"
                      }>
                        {standing.state}
                      </Badge>
                    </div>
                    <div className="text-muted-foreground">{standing.detail}</div>
                    {g.delivered_to_email && (
                      <div className="text-muted-foreground/80">Sent to {g.delivered_to_email}</div>
                    )}
                    {isMlro && standing.canReissue && (
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-xs"
                        onClick={() => reissueGrant(g)} disabled={busy !== null}>
                        {busy === "reissue" && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
                        Re-issue link
                      </Button>
                    )}
                  </div>
                );
              })}
          </div>
          <div>
            <div className="font-medium">Partner assessments</div>
            {assessments.length === 0 ? (
              <div className="text-muted-foreground">None recorded</div>
            ) : assessments.map((a) => (
              <div key={a.id} className="text-muted-foreground">
                {a.reliance_agreements?.partner_org_name ?? a.assessor_name}
                {": "}
                <Badge variant="outline" className={
                  a.status === "satisfied" ? "text-success"
                    : a.status === "not_satisfied" ? "text-destructive" : "text-warning"
                }>
                  {a.status.replace("_", " ")}
                </Badge>
              </div>
            ))}
          </div>
        </div>

        {/* Arrangement governance (Phase 2). The written arrangement and
            its immutable assessment history. An overdue, unsuitable or
            inactive arrangement blocks NEW reliance grants; the independent
            CDD route is never affected. */}
        {agreements.length > 0 && (
          <div className="border-t pt-3">
            <div className="flex items-center justify-between">
              <div className="text-xs font-medium flex items-center gap-1.5">
                <FileSignature className="h-3.5 w-3.5 text-primary" /> Written arrangements
              </div>
            </div>
            <ul className="mt-1.5 space-y-1.5 text-xs">
              {agreements.map((a) => {
                const reviewOverdue = new Date(a.next_review_due).getTime() < Date.now();
                return (
                  <li key={a.id} className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{a.partner_org_name}</span>
                    <Badge variant="outline" className={
                      a.status === "active" ? "text-success"
                        : a.status === "suspended" ? "text-warning" : "text-muted-foreground"
                    }>
                      {a.status}
                    </Badge>
                    {reviewOverdue && (
                      <Badge variant="outline" className="text-destructive">review overdue</Badge>
                    )}
                    {(a.eligibility_classification ?? "unassessed") === "unassessed" && (
                      <Badge variant="outline" className="text-warning">eligibility not recorded</Badge>
                    )}
                    {!a.current_assessment_id && (
                      <Badge variant="outline" className="text-warning">no assessment</Badge>
                    )}
                    {isMlro && (
                      <Button
                        size="sm" variant="ghost" className="h-6 px-2 text-xs"
                        onClick={() => recordAssessment(a)} disabled={busy !== null}
                      >
                        Record assessment
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="text-[11px] text-muted-foreground mt-1.5">
              An overdue, unsuitable or inactive arrangement blocks new reliance grants. A partner
              that cannot rely completes its own independent CDD instead — that route is always
              available.
            </div>
          </div>
        )}

        {/* Agreements sent by email to partners outside the portals. Their
            ACCEPTANCE is what records the arrangement a grant requires, so
            this block is the passport gate made visible — and the place a
            lapsed or declined request is re-issued from. */}
        {acknowledgements.length > 0 && (
          <div className="border-t pt-3">
            <div className="text-xs font-medium flex items-center gap-1.5">
              <FileSignature className="h-3.5 w-3.5 text-primary" /> Compliance agreement — sent for acceptance
            </div>
            {/* One row per request: who and where on the left, the act on
                the right. The actions used to be ghost buttons dropped
                inline after the wrapping text, so "Re-send" read as a
                stray word rather than the thing to click. */}
            <ul className="mt-2 space-y-2 text-xs">
              {acknowledgements.map((row) => {
                const reading = describeAcknowledgement(row.status, row.expires_at);
                return (
                  <li
                    key={row.id}
                    className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 rounded-md border border-border/60 p-2.5"
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">
                          {row.partner_organisations?.legal_name ?? "Partner"}
                        </span>
                        <Badge variant="outline" className={
                          reading.state === "accepted" ? "text-success"
                            : reading.state === "declined" ? "text-destructive"
                              : reading.state === "expired" ? "text-warning"
                                : "text-muted-foreground"
                        }>
                          {reading.state}
                        </Badge>
                      </div>
                      <div className="truncate text-muted-foreground" title={row.recipient_email}>
                        {row.recipient_email}
                      </div>
                      {/* An acceptance is a signed act by a named person on a
                          date. "Acknowledged" alone is the summary of it, not
                          the record of it. */}
                      {reading.state === "accepted" && (row.accepted_by_name || row.accepted_at) && (
                        <p className="text-[11px] font-medium text-success">
                          Accepted{row.accepted_by_name ? ` by ${row.accepted_by_name}` : ""}
                          {row.accepted_at
                            ? ` on ${new Date(row.accepted_at).toLocaleDateString()} at ${new Date(row.accepted_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                            : ""}
                        </p>
                      )}
                      <p className="text-[11px] text-muted-foreground">
                        {reading.detail}
                        {row.resend_count > 0 && ` · sent ${row.resend_count + 1} times`}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      {isMlro && reading.canResend && (
                        <Button size="sm" variant="outline" className="h-8"
                          onClick={() => resendAcknowledgement(row)} disabled={busy !== null}>
                          {busy === "ack"
                            ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                            : <Send className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
                          Re-send agreement
                        </Button>
                      )}
                      {/* The act the acceptance unlocked, offered on the row
                          that reports it. An accepted agreement with no
                          Passport is the one state here that owes somebody
                          something, so it gets the primary button. */}
                      {isMlro && awaitingIssueById.has(row.id) && (
                        <Button size="sm" className="h-8"
                          onClick={() => issuePassportTo(awaitingIssueById.get(row.id)!)}
                          disabled={busy !== null}>
                          {busy === "handover"
                            ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                            : <KeyRound className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
                          Issue the Passport
                        </Button>
                      )}
                      {/* Only an accepted acknowledgement is an executed
                          agreement; there is nothing to produce for the rest. */}
                      {reading.state === "accepted" && (
                        <Button size="sm" variant="outline" className="h-8"
                          onClick={() => downloadAcknowledgement(row)} disabled={busy !== null}>
                          {busy === "ack-doc"
                            ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                            : <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
                          Executed agreement
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Canonical partner links (Phase 1). A link is the access root —
            it explains WHY an organisation may see this matter. It is never
            itself a passport, a reliance decision or a disclosure. */}
        <div className="border-t pt-3">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium flex items-center gap-1.5">
              <Link2 className="h-3.5 w-3.5 text-primary" /> Partner links
            </div>
            {isMlro && (
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={addOrganisation} disabled={busy !== null}>
                  Record organisation
                </Button>
                <Button size="sm" variant="outline" onClick={addLink} disabled={busy !== null}>
                  {busy === "link" && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
                  Link partner
                </Button>
              </div>
            )}
          </div>
          {links.length === 0 ? (
            <div className="text-xs text-muted-foreground mt-1.5">
              No partners linked. A partner sees this matter only through an active link with a
              recorded legal route and purpose — and a link alone still grants no passport or
              reliance access. The fastest path for a new partner is &ldquo;Onboard partner &amp;
              grant&rdquo; in the actions above, which records the link on the way.
            </div>
          ) : (
            <ul className="mt-1.5 space-y-1.5 text-xs">
              {links.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {l.partner_organisations?.legal_name ?? "Partner organisation"}
                  </span>
                  <Badge variant="outline">{l.relationship_role}</Badge>
                  <Badge variant="outline">{l.legal_route.replace(/_/g, " ")}</Badge>
                  <Badge
                    variant="outline"
                    className={
                      l.state === "active" ? "text-success"
                        : l.state === "suspended" ? "text-warning" : "text-muted-foreground"
                    }
                  >
                    {l.state}
                  </Badge>
                  {l.partner_organisations?.classification_status !== "classified" && (
                    <Badge variant="outline" className="text-warning">classification incomplete</Badge>
                  )}
                  {isMlro && l.state === "active" && (
                    <Button
                      size="sm" variant="ghost" className="h-6 px-2 text-xs"
                      onClick={() => endLink(l)} disabled={busy !== null}
                    >
                      End link
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Partner records requests (Phase 4). Origin review of controlled
            record-class requests; nothing is delivered without an explicit
            decision here, and the response wording is partner-safe. */}
        {recordsRequests.length > 0 && (
          <div className="border-t pt-3">
            <div className="text-xs font-medium">Partner records requests</div>
            <ul className="mt-1.5 space-y-1.5 text-xs">
              {recordsRequests.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {r.partner_organisations?.legal_name ?? "Partner"}
                  </span>
                  <span className="text-muted-foreground">
                    {r.requested_record_codes.join(", ")}
                  </span>
                  <Badge variant="outline" className={
                    r.status === "denied" ? "text-destructive"
                      : ["approved", "partly_approved", "delivered"].includes(r.status) ? "text-success"
                        : "text-warning"
                  }>
                    {r.status.replace(/_/g, " ")}
                  </Badge>
                  {isMlro && ["submitted", "under_review"].includes(r.status) && (
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-xs"
                      onClick={() => reviewRecordsRequest(r)} disabled={busy !== null}>
                      Review
                    </Button>
                  )}
                  {isMlro && ["approved", "partly_approved", "delivered"].includes(r.status)
                    && r.approved_record_codes.length > 0 && (
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-xs"
                      onClick={() => recordDelivery(r)} disabled={busy !== null}>
                      Record delivery
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
      {/* One guided pass from "partner does not exist" to "partner holds
          a grant" — the four acts in the server's own order. */}
      <PartnerOnboardingWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        caseId={caseId}
        attestationVersion={current?.version ?? null}
        organisations={organisations}
        agreements={agreements}
        onDone={refresh}
      />
      {/*
        Issuing is an outward act — a numbered version partners will read —
        so it confirms, says exactly what will happen, and keeps the visual
        preview one click away. It never issues silently on a stray click.
      */}
      <AlertDialog open={confirmIssue} onOpenChange={setConfirmIssue}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Issue attestation v{nextVersion}?</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2 text-left">
              <span className="block">
                This freezes the case&apos;s verified facts — identity verification, screening and
                consents — as <strong>v{nextVersion}</strong>, stamped with a content hash.
                {current
                  ? ` The current v${current.version} is superseded and partners are pointed at the new version.`
                  : " It becomes the version partners read once access is granted."}
              </span>
              <span className="block">
                Nothing is shared by issuing alone — partner access is a separate grant. If you
                have not looked at the Passport as the client and partners will see it, preview it
                first.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="outline"
              onClick={() => { setConfirmIssue(false); navigate(`/admin/aml/passport?case=${caseId}`); }}>
              <Eye className="mr-1.5 h-3.5 w-3.5" /> Preview first
            </Button>
            <AlertDialogAction onClick={() => { setConfirmIssue(false); void issue(); }}>
              Issue v{nextVersion}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {dialog}
      <PassportIssuedDialog result={issued} onClose={() => setIssued(null)} />
    </Card>
  );
}
