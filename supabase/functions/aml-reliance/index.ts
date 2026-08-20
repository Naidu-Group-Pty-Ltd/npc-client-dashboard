/**
 * AML/CTF Compliance Passport — cross-portal reliance engine.
 *
 * Legal model: AML/CTF Act 2006 (Cth), Part 2 Division 7 (ss 37A–38). One
 * reporting entity may rely on the applicable customer identification
 * procedure carried out by another, under a WRITTEN customer due diligence
 * arrangement that is regularly reviewed — and the relying entity remains
 * responsible for its own compliance. That last clause is why the
 * "independent assessment" path exists: a partner who wants their own
 * determination makes it here, against internally-transferred records,
 * instead of approaching the client again.
 *
 * Staff ops (verifyAuth; agreements/attestations/grants are MLRO-only —
 * cross-entity disclosure is a restricted operation like every other
 * outward-facing act in this module):
 *   list_agreements | create_agreement | review_agreement
 *   issue_attestation | list_attestations
 *   grant_access | revoke_grant | list_grants
 *   list_assessments | list_access_log
 *
 * Partner ops (bearer token minted by grant_access; no session — mirrors the
 * finance handoff-token pattern; token stored hashed, expiring, revocable):
 *   redeem_attestation | record_independent_assessment
 *
 * Disclosure boundary (Appendix C contracts, extended outward): an
 * attestation states WHAT PROCEDURES WERE PERFORMED — parties verified, by
 * what method, when; consents held; screening performed against which lists
 * and how fresh. It NEVER carries risk ratings, screening match content,
 * reviewer notes or MLRO commentary. A partner relying on our identification
 * procedure has no entitlement to our investigation, and s 123 (tipping off)
 * forbids sharing some of it regardless.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.55.0";
import { verifyAuth } from "../_shared/auth.ts";
// `aml.cases` has no tenant_id column. See `_shared/aml/caseTenant.ts`.
import { tenantForCase } from "../_shared/aml/caseTenant.ts";
import { enforceCsrf, csrfDenied } from "../_shared/csrfGuard.ts";
import { withRequestOrigin } from "../_shared/corsOrigin.ts";
import {
  LEGAL_ROUTES,
  evaluateArrangementForReliance,
  evaluatePartnerLinkForReliance,
} from "../_shared/aml/relianceEligibility.ts";
import {
  evaluateDistribution,
  summariseBatch,
  type DistributionCandidate,
  type DistributionContext,
} from "../_shared/aml/passport/passportDistribution.pure.ts";
import {
  DEFAULT_ALLOWED_ATTRIBUTE_CODES,
  DEFAULT_DENIED_CLASSES,
  evaluateManifestForRead,
  findRestrictedKeys,
  intersectPayloadWithManifest,
  materialInputHash,
  sha256HexCanonical,
  toV2Payload,
} from "../_shared/aml/attestationV2.ts";
import {
  REQUESTABLE_RECORD_CLASSES,
  buildPartnerWorkspaceDto,
  evaluateRecordsRequestScope,
  validatePartnerDetermination,
} from "../_shared/aml/partnerWorkspace.ts";
import {
  evaluateMaterialChange,
  materialInputsFromV2Payload,
} from "../_shared/aml/partnerEvents.ts";
import { evaluateEvidenceObjectDelivery } from "../_shared/aml/partnerRetention.ts";
import { buildPassportView } from "../_shared/aml/passport/passportView.pure.ts";
import { derivePassportState } from "../_shared/aml/passport/passportState.pure.ts";
import {
  DEFAULT_SLA_TARGETS,
  REGISTER_DEFS,
  SLA_TARGET_NOTE,
  buildQueueSummary,
  normaliseReadinessItem,
  registerAllowed,
  type OperationsCapabilities,
  type QueueCount,
  type ReadinessItem,
  type SlaTarget,
} from "../_shared/aml/partnerOperations.ts";
import { extractFinanceToken, resolveFinancePartner } from "../_shared/finance-portal-session.ts";
import { resolveBuilderSession } from "../_shared/builderPortalAuth.ts";
import { resolveSolicitorSession } from "../_shared/solicitorPortalAuth.ts";
import { internalError } from '../_shared/errorResponse.ts';
import { readBoundedJson } from '../_shared/validate.ts';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  // Includes the first-party partner-portal session carriers (all present in
  // the canonical CORS_ALLOWED_REQUEST_HEADERS list in _shared/auth.ts):
  // finance sends x-finance-session-token; the builder and solicitor portals
  // authenticate with HttpOnly cookies plus the x-portal-request marker.
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-correlation-id, x-step-up-token, x-session-token, x-command-centre-session-token, x-finance-session-token, x-solicitor-session-token, x-portal-request",
  "Access-Control-Expose-Headers": "x-correlation-id, x-duration-ms",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const jr = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

async function sha256Hex(input: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function appendCaseEvent(admin: any, caseId: string, category: string, summary: string, payload: any, actorId: string | null, actorLabel: string | null) {
  const { data: prev } = await admin.schema("aml").from("case_events")
    .select("row_hash").eq("case_id", caseId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const prevHash = prev?.row_hash ?? null;
  const now = new Date().toISOString();
  const rowHash = await sha256Hex(JSON.stringify({ case_id: caseId, category, summary, payload, actor_id: actorId, actor_label: actorLabel, prev_hash: prevHash, created_at: now }));
  await admin.schema("aml").from("case_events").insert({
    case_id: caseId, category, summary, payload, actor_id: actorId, actor_label: actorLabel,
    prev_hash: prevHash, row_hash: rowHash, created_at: now,
  });
}

const GRANT_TTL_DAYS = 90;

/** One questionnaire section's stored payload, or null. Read-only. */
async function questionnairePayload(admin: any, caseId: string, section: string) {
  const { data } = await admin.schema("aml").from("questionnaire_responses")
    .select("payload").eq("case_id", caseId).eq("section", section).maybeSingle();
  return (data?.payload && typeof data.payload === "object") ? data.payload : null;
}

/**
 * Build the sanitised attestation payload for a case.
 *
 * Everything here answers "what procedures were performed" — nothing answers
 * "what did you conclude about this customer". The exclusion list is the
 * contract: risk_rating, risk_score, screening match content, reviewer notes
 * and MLRO commentary must never enter this object.
 */
async function buildAttestationPayload(admin: any, caseRow: any) {
  const caseId = caseRow.id;
  const [{ data: checks }, { data: consents }, { data: sections }, { data: screenings }, { data: syncs }] = await Promise.all([
    admin.schema("aml").from("verification_checks")
      .select("party_label, check_type, status, provider, completed_at, outcome_detail")
      .eq("case_id", caseId),
    admin.schema("aml").from("consents")
      .select("kind, version, accepted_at").eq("case_id", caseId),
    admin.schema("aml").from("questionnaire_responses")
      .select("section, status").eq("case_id", caseId),
    admin.schema("aml").from("screening_checks")
      .select("completed_at, scope, status").eq("case_id", caseId)
      .order("completed_at", { ascending: false }).limit(1),
    admin.schema("aml").from("sanctions_list_syncs")
      .select("list_code, completed_at").eq("status", "succeeded")
      .order("completed_at", { ascending: false }).limit(10),
  ]);

  // One line per party: verified or not, by which method, when. Sighting
  // detail keeps document type + certifier because that is precisely what a
  // relying entity's own risk assessment needs; scores stay internal.
  const partyMap = new Map<string, any>();
  for (const c of (checks ?? [])) {
    const key = c.party_label;
    const cur = partyMap.get(key) ?? { party: key, verified: false, method: null, completed_at: null, document_type: null };
    if (c.status === "passed" && ["electronic_idv", "document_sighting", "dvs"].includes(c.check_type)) {
      cur.verified = true;
      cur.method = c.check_type;
      cur.completed_at = c.completed_at;
      if (c.check_type === "document_sighting") {
        cur.document_type = c.outcome_detail?.document_type ?? null;
        cur.sighting_kind = c.outcome_detail?.sighting_kind ?? null;
        cur.certifier_capacity = c.outcome_detail?.certifier_capacity ?? null;
      }
    }
    partyMap.set(key, cur);
  }

  const latestScreening = (screenings ?? [])[0] ?? null;
  const listFreshness: Record<string, string> = {};
  for (const s of (syncs ?? [])) {
    if (!listFreshness[s.list_code]) listFreshness[s.list_code] = s.completed_at;
  }

  return {
    schema: "aml.compliance_attestation.v1",
    issuer: "NPC Services command centre",
    case_reference: caseRow.case_reference,
    subject: caseRow.subject_display_name,
    subject_type: caseRow.subject_type,
    customer_identification: {
      parties: [...partyMap.values()],
      questionnaire_version: caseRow.metadata?.questionnaire_version ?? null,
      sections_submitted: (sections ?? []).filter((s: any) =>
        ["submitted", "accepted", "complete"].includes(s.status)).length,
      consents_held: (consents ?? []).map((c: any) => ({
        code: c.kind, version: c.version, accepted_at: c.accepted_at,
      })),
    },
    screening: {
      performed: Boolean(latestScreening),
      last_performed_at: latestScreening?.completed_at ?? null,
      scope: latestScreening?.scope ?? null,
      list_freshness: listFreshness,
      // Deliberately absent: match content. A partner sees THAT screening
      // ran and how fresh the lists were, never what it surfaced.
    },
    // Same finance-safe derivation as Appendix C.2: readiness is a boolean
    // derived only from an explicitly approved gate, never the raw status.
    service_readiness: ["approved", "approved_with_controls"]
      .includes(caseRow.service_gate_status) ,
    limitations: [
      "documents_not_verified_against_issuing_authority",
      "liveness_signal_is_heuristic_only",
    ],
    reliance_basis: "AML/CTF Act 2006 (Cth) Pt 2 Div 7 — written CDD arrangement required; relying entity remains responsible for its own compliance",
  };
}

/**
 * Phase 1 enforcement flag. Off = legacy free-text agreement behaviour is
 * preserved exactly. On = new reliance grants require a canonical partner
 * organisation and an active partner-case link (legal_route = reliance).
 * Tolerates both feature-flag value shapes used in this repo.
 */
async function flagEnabled(admin: any, key: string): Promise<boolean> {
  const { data } = await admin.from("feature_flags")
    .select("value").eq("key", key).maybeSingle();
  const v = data?.value;
  if (v === true || v === "true") return true;
  if (v && typeof v === "object" && (v as any).enabled === true) return true;
  return false;
}

const partnerIdentityEnforced = (admin: any) => flagEnabled(admin, "aml_partner_identity");
const arrangementGovernanceEnforced = (admin: any) => flagEnabled(admin, "aml_arrangement_governance");
const attestationV2Enabled = (admin: any) => flagEnabled(admin, "aml_attestation_v2");

const PARTNER_ORG_TYPES = ["finance", "builder", "developer", "solicitor_conveyancer", "other"];
const PARTNER_PORTAL_TYPES = ["finance", "builder", "developer", "solicitor_conveyancer"];
const PARTNER_USER_SOURCES = ["finance_portal_users", "builder_portal_users", "solicitor_portal_users"];
const PARTNER_CLASSIFICATIONS = [
  "unclassified", "eligible_relying_reporting_entity", "eligible_foreign_equivalent",
  "reporting_entity_no_reliance", "non_reporting_commercial", "outsourcing_principal",
  "service_provider",
];

/** Resolve a partner bearer token to a live grant, or null. */
async function resolveGrant(admin: any, rawToken: string) {
  if (!rawToken || rawToken.length < 20) return null;
  const hash = await sha256Hex(rawToken);
  const { data: grant } = await admin.schema("aml").from("reliance_grants")
    .select("*, reliance_agreements:agreement_id(*), compliance_attestations:attestation_id(*)")
    .eq("access_token_hash", hash).maybeSingle();
  if (!grant) return null;
  if (grant.revoked_at) return { grant, denied: "revoked" };
  if (new Date(grant.expires_at).getTime() < Date.now()) return { grant, denied: "expired" };
  const agreement = (grant as any).reliance_agreements;
  if (!agreement || agreement.status !== "active") return { grant, denied: "agreement_inactive" };
  return { grant, denied: null };
}

/* ── first-party partner workspace (Phase 4) ──────────────────────────── */

/** Surface → membership/link portal types it may serve. The Builder surface
 * serves both builder and developer organisations (there is no standalone
 * Developer Portal; that absence FAILS CLOSED — no session, no access). */
const SURFACE_PORTAL_TYPES: Record<string, string[]> = {
  finance: ["finance"],
  builder: ["builder", "developer"],
  solicitor_conveyancer: ["solicitor_conveyancer"],
};

const PARTNER_WORKSPACE_OPS = new Set([
  "get_partner_compliance_workspace",
  "request_cdd_records",
  "list_partner_records_requests",
  "record_partner_determination",
  "list_partner_evidence_deliveries",
  "get_partner_audit_receipt",
  // Phase 6: refresh obligations and safe notifications (read-only lists;
  // obligations complete through record_partner_determination, never here).
  "list_partner_refresh_obligations",
  "list_partner_notifications",
  // Pre-rollout Stage B: controlled, expiring, audited P3 evidence access.
  "get_partner_evidence_delivery_access",
]);

/** Server-controlled signed-access lifetime for evidence objects. The body
 * cannot lengthen it; nothing persists the URL. */
const EVIDENCE_ACCESS_TTL_SECONDS = 300;
/** Evidence-access attempts allowed per membership per minute. */
const EVIDENCE_ACCESS_RATE_LIMIT = 10;

const WORKSPACE_PORTAL_FLAGS: Record<string, string> = {
  finance: "aml_partner_workspace_finance",
  builder: "aml_partner_workspace_builder",
  solicitor_conveyancer: "aml_partner_workspace_solicitor",
};

type PartnerPortalContext = {
  ok: true;
  surface: string;
  source: string;
  portalUserId: string;
  portalUserLabel: string | null;
  membership: any;
  partnerOrg: any;
};
type PartnerPortalDenied = { ok: false; status: number; error: string; code?: string };

/**
 * Resolve the authenticated portal identity to ONE canonical partner
 * organisation via an active membership.
 *
 * Identity always comes from the portal's own server-trusted session
 * resolver — never from a body identifier. Where the session itself carries
 * an organisation (builder active organisation, solicitor firm), the
 * canonical organisation's recorded portal reference MUST match it; a
 * membership row alone cannot widen a session into another organisation.
 * Finance sessions carry no organisation, so the membership must be
 * unambiguous (exactly one candidate) — ambiguity fails closed.
 */
async function resolvePartnerPortalContext(
  admin: any, req: Request, body: any,
): Promise<PartnerPortalContext | PartnerPortalDenied> {
  const surface = String(body.portal_type ?? "");
  if (!Object.keys(SURFACE_PORTAL_TYPES).includes(surface)) {
    return { ok: false, status: 400, error: "portal_type must be finance, builder or solicitor_conveyancer" };
  }

  let source = "";
  let portalUserId = "";
  let portalUserLabel: string | null = null;
  let sessionBuilderOrgId: string | null = null;
  let sessionSolicitorFirmId: string | null = null;
  let sessionFinanceContactId: string | null = null;

  if (surface === "finance") {
    const token = extractFinanceToken(req.headers, body);
    const resolved: any = await resolveFinancePartner(admin, token);
    if (resolved.error || !resolved.portalUser) {
      return { ok: false, status: resolved.status ?? 401, error: "Invalid or expired session", code: "auth_required" };
    }
    source = "finance_portal_users";
    portalUserId = String(resolved.portalUser.id);
    portalUserLabel = resolved.portalUser.email ?? null;
    const { data: fpUser } = await admin.from("finance_portal_users")
      .select("finance_contact_id").eq("id", portalUserId).maybeSingle();
    sessionFinanceContactId = fpUser?.finance_contact_id ?? null;
  } else if (surface === "builder") {
    const resolved: any = await resolveBuilderSession(admin, req);
    if (!resolved.ok || !resolved.user) {
      return { ok: false, status: resolved.status ?? 401, error: resolved.error ?? "Invalid or expired session", code: resolved.code };
    }
    source = "builder_portal_users";
    portalUserId = String(resolved.user.id);
    portalUserLabel = resolved.user.email ?? null;
    sessionBuilderOrgId = resolved.active_organisation?.organisation_id ?? null;
    if (!sessionBuilderOrgId) {
      return { ok: false, status: 403, error: "Select an organisation before opening the compliance workspace.", code: "organisation_selection_required" };
    }
  } else {
    const resolved: any = await resolveSolicitorSession(admin, req.headers, body);
    if (!resolved.ok || !resolved.user) {
      return { ok: false, status: resolved.status ?? 401, error: resolved.error ?? "Invalid or expired session", code: "auth_required" };
    }
    source = "solicitor_portal_users";
    portalUserId = String(resolved.user.id);
    portalUserLabel = resolved.user.email ?? null;
    sessionSolicitorFirmId = resolved.user.firm_id ?? null;
    if (!sessionSolicitorFirmId) {
      return { ok: false, status: 403, error: "No legal practice is linked to this account.", code: "firm_required" };
    }
  }

  const allowedTypes = SURFACE_PORTAL_TYPES[surface];
  const { data: memberships } = await admin.schema("aml").from("partner_portal_memberships")
    .select("*").eq("portal_user_source", source).eq("portal_user_id", portalUserId)
    .eq("status", "active").in("portal_type", allowedTypes);
  const membershipRows: any[] = memberships ?? [];
  if (membershipRows.length === 0) {
    return { ok: false, status: 403, error: "Your account is not enrolled for the compliance workspace. Ask the issuing organisation to set up your membership.", code: "membership_missing" };
  }

  const orgIds = [...new Set(membershipRows.map((m) => String(m.partner_org_id)))];
  const { data: orgs } = await admin.schema("aml").from("partner_organisations")
    .select("*").in("id", orgIds).eq("status", "active");
  const orgRows: any[] = orgs ?? [];

  // Session-organisation cross-check: the canonical organisation must carry
  // the matching portal reference where the session names one.
  let candidates = orgRows;
  if (surface === "builder") {
    candidates = orgRows.filter((o) => o.builder_organisation_id === sessionBuilderOrgId);
  } else if (surface === "solicitor_conveyancer") {
    candidates = orgRows.filter((o) => o.solicitor_firm_id === sessionSolicitorFirmId);
  } else {
    candidates = orgRows.filter((o) =>
      !o.finance_agent_contact_id || o.finance_agent_contact_id === sessionFinanceContactId);
  }
  if (candidates.length === 0) {
    return { ok: false, status: 403, error: "No canonical partner organisation is mapped to your current portal organisation.", code: "partner_org_unmapped" };
  }
  if (candidates.length > 1) {
    // Never guess between organisations.
    return { ok: false, status: 409, error: "Your account maps to more than one partner organisation. Ask the issuing organisation to correct the memberships.", code: "partner_org_ambiguous" };
  }
  const partnerOrg = candidates[0];
  const membership = membershipRows.find((m) => String(m.partner_org_id) === String(partnerOrg.id));
  if (!membership) {
    return { ok: false, status: 403, error: "Membership not found for the resolved organisation.", code: "membership_missing" };
  }
  return { ok: true, surface, source, portalUserId, portalUserLabel, membership, partnerOrg };
}

/** Load a partner-case link by id, scoped to the resolved organisation and
 * the surface's permitted portal types. Absence answers 404 — a link id is
 * never confirmed to an organisation it does not belong to. */
async function loadScopedPartnerLink(admin: any, linkId: string, partnerOrgId: string, surface: string) {
  if (!linkId) return null;
  const { data: link } = await admin.schema("aml").from("partner_case_links")
    .select("*").eq("id", linkId).eq("partner_org_id", partnerOrgId).maybeSingle();
  if (!link) return null;
  if (!SURFACE_PORTAL_TYPES[surface].includes(link.portal_type)) return null;
  return link;
}

/** Latest grant/attestation pair for a case × canonical organisation. Only
 * canonically-stamped grants participate — the workspace is the new path. */
async function loadOrgGrantAndAttestation(admin: any, caseId: string, partnerOrgId: string) {
  const { data: grant } = await admin.schema("aml").from("reliance_grants")
    .select("*, compliance_attestations:attestation_id(*)")
    .eq("case_id", caseId).eq("partner_org_id", partnerOrgId)
    .order("granted_at", { ascending: false }).limit(1).maybeSingle();
  if (!grant) return { grant: null, attestation: null };
  return { grant, attestation: (grant as any).compliance_attestations ?? null };
}

const __corsWrappedHandler = (async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const __csrf = enforceCsrf(req);
  if (!__csrf.ok) return csrfDenied(corsHeaders, __csrf);

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await readBoundedJson(req).catch(() => ({}));
    const op = String(body?.op ?? "");
    if (!op) return jr({ error: "op required" }, 400);
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

    /* ── partner workspace ops: first-party portal sessions (Phase 4) ────── */
    // Session-authenticated, membership-mapped, link-scoped. No bearer token
    // ever reaches a first-party browser; identity comes from the portal's
    // own server-trusted session resolver. Everything is flag-gated: with
    // the master or surface flag off these ops answer 404 and the system
    // behaves exactly as before Phase 4.

    if (PARTNER_WORKSPACE_OPS.has(op)) {
      const surfaceForFlag = String(body.portal_type ?? "");
      const masterOn = await flagEnabled(admin, "aml_partner_compliance_workspace");
      const surfaceFlagKey = WORKSPACE_PORTAL_FLAGS[surfaceForFlag];
      const surfaceOn = surfaceFlagKey ? await flagEnabled(admin, surfaceFlagKey) : false;
      if (!masterOn || !surfaceOn) {
        return jr({ error: "The partner compliance workspace is not available.", code: "workspace_disabled" }, 404);
      }
      const ctx = await resolvePartnerPortalContext(admin, req, body);
      if (!ctx.ok) return jr({ error: ctx.error, code: ctx.code }, ctx.status);
      const { surface, source, portalUserId, portalUserLabel, membership, partnerOrg } = ctx;

      if (op === "get_partner_compliance_workspace") {
        const linkId = String(body.partner_case_link_id ?? "");
        if (!linkId) {
          // Link directory: the organisation's own links only, safe fields only.
          const { data: links } = await admin.schema("aml").from("partner_case_links")
            .select("id, relationship_role, legal_route, state, portal_type, linked_at, ended_at, end_reason_code, purchase_file_id, legal_matter_id")
            .eq("partner_org_id", partnerOrg.id)
            .in("portal_type", SURFACE_PORTAL_TYPES[surface])
            .order("linked_at", { ascending: false }).limit(100);
          return jr({
            organisation: { legal_name: partnerOrg.legal_name, classification_status: partnerOrg.classification_status },
            links: links ?? [],
          });
        }
        const link = await loadScopedPartnerLink(admin, linkId, partnerOrg.id, surface);
        if (!link) return jr({ error: "Not found" }, 404);

        const { grant, attestation } = await loadOrgGrantAndAttestation(admin, link.case_id, partnerOrg.id);
        let procedures: Record<string, unknown> | null = null;
        let recordAvailability: string[] = [];
        let limitations: string[] = [];
        let manifestRow: any = null;
        if (grant && attestation && (attestation.schema_version ?? 1) === 2) {
          const { data: manifest } = await admin.schema("aml").from("disclosure_manifests")
            .select("*").eq("grant_id", grant.id).maybeSingle();
          manifestRow = manifest ?? null;
          const manifestDecision = evaluateManifestForRead(manifestRow, new Date());
          if (manifestDecision.ok && !attestation.superseded_at && !attestation.refresh_required_at
            && !grant.revoked_at && new Date(grant.expires_at).getTime() > Date.now()) {
            try {
              procedures = intersectPayloadWithManifest(attestation.payload, manifestRow);
              recordAvailability = [...(manifestRow.allowed_record_classes ?? [])];
              limitations = Array.isArray(attestation.payload?.limitations)
                ? attestation.payload.limitations.map(String) : [];
            } catch (_integrity) {
              procedures = null; // tripwire: disclose nothing
            }
          }
        }

        const [{ data: determinations }, { data: requests }, { data: deliveries }, { data: tenantRow }] = await Promise.all([
          admin.schema("aml").from("independent_assessments")
            .select("status, decided_at, based_on_attestation_sha256, created_at")
            .eq("case_id", link.case_id).eq("partner_org_id", partnerOrg.id)
            .order("created_at", { ascending: false }).limit(50),
          admin.schema("aml").from("partner_records_requests")
            .select("id, requested_record_codes, status, requested_at, due_at, origin_response_message")
            .eq("partner_case_link_id", link.id)
            .order("requested_at", { ascending: false }).limit(50),
          admin.schema("aml").from("partner_evidence_deliveries")
            .select("id, record_code, safe_label, delivered_version, delivered_sha256, delivered_at, expires_at, revoked_at")
            .eq("partner_case_link_id", link.id)
            .order("delivered_at", { ascending: false }).limit(100),
          admin.schema("aml").from("tenant_settings")
            .select("display_name").eq("tenant_id", link.tenant_id ?? "default").maybeSingle(),
        ]);

        const dto = buildPartnerWorkspaceDto({
          partnerOrg: { legal_name: partnerOrg.legal_name, classification_status: partnerOrg.classification_status },
          originLabel: tenantRow?.display_name ?? "Issuing organisation",
          link: {
            id: link.id, relationship_role: link.relationship_role, legal_route: link.legal_route,
            state: link.state, portal_type: link.portal_type, linked_at: link.linked_at,
            purchase_file_id: link.purchase_file_id ?? null, legal_matter_id: link.legal_matter_id ?? null,
          },
          attestation: attestation ? {
            schema_version: attestation.schema_version ?? 1, version: attestation.version,
            payload_sha256: attestation.payload_sha256, issued_at: attestation.issued_at,
            superseded_at: attestation.superseded_at ?? null,
            refresh_required_at: attestation.refresh_required_at ?? null,
          } : null,
          grant: grant ? { revoked_at: grant.revoked_at ?? null, expires_at: grant.expires_at } : null,
          procedures, limitations, recordAvailability,
          determinations: determinations ?? [],
          requests: requests ?? [],
          deliveries: deliveries ?? [],
          now: new Date(),
        });

        // A workspace view that actually disclosed procedure content is an
        // access — logged like a token redemption.
        if (grant && dto.procedures) {
          await admin.schema("aml").from("reliance_access_log").insert({
            grant_id: grant.id, case_id: link.case_id, action: "view_attestation",
            actor_label: `${partnerOrg.legal_name} — ${portalUserLabel ?? "portal user"}`,
            ip_address: ip,
            detail: { via: "partner_workspace", partner_case_link_id: link.id, attestation_version: attestation?.version ?? null },
          });
        }
        return jr({ workspace: dto });
      }

      if (op === "request_cdd_records") {
        // Phase 9 action flag: partner writes roll out one capability at a
        // time, enforced here — not by hidden buttons.
        if (!(await flagEnabled(admin, "aml_partner_records_requests_write"))) {
          return jr({ error: "Records requests are not enabled yet for this environment.", code: "records_requests_write_disabled" }, 409);
        }
        const link = await loadScopedPartnerLink(admin, String(body.partner_case_link_id ?? ""), partnerOrg.id, surface);
        if (!link) return jr({ error: "Not found" }, 404);
        if (link.state !== "active") {
          return jr({ error: "This link is no longer active.", code: "link_inactive" }, 409);
        }
        const codes: string[] = Array.isArray(body.record_codes)
          ? [...new Set<string>((body.record_codes as unknown[]).map((c) => String(c)))] : [];
        const rationale = String(body.rationale ?? "").trim();
        if (codes.length === 0) return jr({ error: "record_codes required" }, 400);
        if (rationale.length < 10) return jr({ error: "rationale must be at least 10 characters — record why the records are necessary" }, 400);

        const { data: agreementRow } = link ? await admin.schema("aml").from("reliance_agreements")
          .select("scope_record_classes").eq("partner_org_id", partnerOrg.id)
          .eq("status", "active").order("created_at", { ascending: false }).limit(1).maybeSingle() : { data: null };
        const evaluation = evaluateRecordsRequestScope(codes, agreementRow?.scope_record_classes ?? null);
        const prohibited = evaluation.filter((e) => e.scope === "prohibited");
        if (prohibited.length > 0) {
          return jr({
            error: `These record codes are not available through this channel: ${prohibited.map((p) => p.code).join(", ")}. Only the controlled record classes can be requested.`,
            code: "record_codes_prohibited",
            prohibited_codes: prohibited.map((p) => p.code),
          }, 400);
        }
        const dueAt = String(body.due_at ?? "");
        if (dueAt && !/^\d{4}-\d{2}-\d{2}$/.test(dueAt)) return jr({ error: "due_at must be YYYY-MM-DD" }, 400);

        const { grant, attestation } = await loadOrgGrantAndAttestation(admin, link.case_id, partnerOrg.id);
        const { data: request, error } = await admin.schema("aml").from("partner_records_requests").insert({
          tenant_id: link.tenant_id ?? "default",
          case_id: link.case_id,
          partner_case_link_id: link.id,
          partner_org_id: partnerOrg.id,
          grant_id: grant?.id ?? null,
          attestation_id: attestation?.id ?? null,
          requested_record_codes: codes,
          rationale: rationale.slice(0, 2000),
          scope_evaluation: evaluation,
          requested_by_source: source,
          requested_by_id: portalUserId,
          requested_by_label: portalUserLabel,
          due_at: dueAt || null,
        }).select("id, requested_record_codes, status, requested_at, due_at, origin_response_message").single();
        if (error) throw error;

        await appendCaseEvent(admin, link.case_id, "system",
          `Partner records request from ${partnerOrg.legal_name} (${codes.length} record class${codes.length === 1 ? "" : "es"})`,
          {
            partner_records_request_id: request.id, partner_case_link_id: link.id,
            requested_record_codes: codes,
            note: "Controlled records request. Nothing is delivered without an origin review decision.",
          }, null, `${partnerOrg.legal_name} — ${portalUserLabel ?? "portal user"}`);
        return jr({ request });
      }

      if (op === "list_partner_records_requests") {
        const link = await loadScopedPartnerLink(admin, String(body.partner_case_link_id ?? ""), partnerOrg.id, surface);
        if (!link) return jr({ error: "Not found" }, 404);
        const { data, error } = await admin.schema("aml").from("partner_records_requests")
          .select("id, requested_record_codes, rationale, scope_evaluation, status, requested_at, due_at, approved_record_codes, denied_record_codes, origin_response_message, reviewed_at")
          .eq("partner_case_link_id", link.id).order("requested_at", { ascending: false }).limit(100);
        if (error) throw error;
        return jr({ requests: data ?? [] });
      }

      if (op === "record_partner_determination") {
        // Phase 9 action flag (server-side, like every write gate).
        if (!(await flagEnabled(admin, "aml_partner_determinations_write"))) {
          return jr({ error: "Recording determinations is not enabled yet for this environment.", code: "determinations_write_disabled" }, 409);
        }
        const link = await loadScopedPartnerLink(admin, String(body.partner_case_link_id ?? ""), partnerOrg.id, surface);
        if (!link) return jr({ error: "Not found" }, 404);
        if (link.state !== "active") {
          return jr({ error: "This link is no longer active.", code: "link_inactive" }, 409);
        }
        const outcome = String(body.outcome ?? "");
        const decisionBasis = String(body.decision_basis ?? "").trim();
        const responsibilityAcknowledged = body.responsibility_acknowledged === true;
        const { grant, attestation } = await loadOrgGrantAndAttestation(admin, link.case_id, partnerOrg.id);
        const currentHash = attestation && !attestation.superseded_at ? attestation.payload_sha256 : null;

        const validation = validatePartnerDetermination({
          outcome, decisionBasis, responsibilityAcknowledged,
          complianceRole: membership.compliance_role ?? null,
          attestationSha256: currentHash,
        });
        if (!validation.ok) return jr({ error: validation.message, code: validation.code }, 403);

        // Append-only: a new determination row, never an update of history.
        const { data: assessment, error } = await admin.schema("aml").from("independent_assessments").insert({
          grant_id: grant?.id ?? null,
          case_id: link.case_id,
          agreement_id: grant?.agreement_id ?? null,
          partner_org_id: partnerOrg.id,
          partner_case_link_id: link.id,
          assessor_user_source: source,
          assessor_user_id: portalUserId,
          membership_id: membership.id,
          assessor_name: (portalUserLabel ?? "partner compliance officer").slice(0, 200),
          assessor_role: membership.compliance_role,
          responsibility_acknowledged: true,
          decision_basis: decisionBasis.slice(0, 4000),
          conditions: String(body.conditions ?? "").slice(0, 4000) || null,
          based_on_attestation_sha256: currentHash,
          status: outcome,
          decision_notes: decisionBasis.slice(0, 4000),
          decided_at: new Date().toISOString(),
        }).select("id, status, decided_at, based_on_attestation_sha256").single();
        if (error) throw error;

        if (grant) {
          await admin.schema("aml").from("reliance_access_log").insert({
            grant_id: grant.id, case_id: link.case_id,
            action: outcome === "records_requested" ? "records_request" : "independent_assessment",
            actor_label: `${partnerOrg.legal_name} — ${portalUserLabel ?? "portal user"}`,
            ip_address: ip,
            detail: { assessment_id: assessment.id, status: outcome, via: "partner_workspace" },
          });
        }
        // Phase 6: a fresh determination discharges the open refresh
        // obligation for this link. Idempotent — re-recording matches zero
        // open rows; with no Phase 6 data the update matches nothing.
        await admin.schema("aml").from("partner_refresh_obligations").update({
          status: "completed", completed_at: new Date().toISOString(),
          completed_by_source: source, completed_by_id: portalUserId,
          completed_against_attestation_hash: currentHash,
          determination_id: assessment.id,
        }).eq("partner_case_link_id", link.id).eq("partner_org_id", partnerOrg.id)
          .eq("status", "open").eq("required_action", "review_and_redetermine");
        await appendCaseEvent(admin, link.case_id, "system",
          `Independent assessment by ${partnerOrg.legal_name}: ${outcome.replace(/_/g, " ")}`,
          {
            assessment_id: assessment.id, partner_case_link_id: link.id,
            based_on_attestation_sha256: currentHash,
            note: "Partner determination under its own AML/CTF obligations. Does not alter this case's status or service gate.",
          }, null, partnerOrg.legal_name);
        return jr({ assessment });
      }

      if (op === "list_partner_evidence_deliveries") {
        const link = await loadScopedPartnerLink(admin, String(body.partner_case_link_id ?? ""), partnerOrg.id, surface);
        if (!link) return jr({ error: "Not found" }, 404);
        const { data, error } = await admin.schema("aml").from("partner_evidence_deliveries")
          .select("id, request_id, record_code, safe_label, delivered_version, delivered_sha256, delivered_at, expires_at, revoked_at")
          .eq("partner_case_link_id", link.id).order("delivered_at", { ascending: false }).limit(100);
        if (error) throw error;
        return jr({ deliveries: data ?? [] });
      }

      if (op === "get_partner_evidence_delivery_access") {
        // Controlled, expiring, audited access to ONE approved P3 evidence
        // object (Stage B). The partner organisation comes from the session
        // resolver above — the body cannot name an organisation or tenant.
        // Every attempt, approved or denied, lands in the access log with a
        // safe result code; the signed URL is returned once and never
        // persisted anywhere.
        const deliveryId = String(body.delivery_id ?? "");
        const retrievalReason = String(body.retrieval_reason ?? "").trim();
        const link = await loadScopedPartnerLink(admin, String(body.partner_case_link_id ?? ""), partnerOrg.id, surface);

        const logAttempt = async (
          result: "approved" | "denied" | "failed",
          detailExtra: Record<string, unknown>,
          grantId: string | null = null,
          caseId: string | null = link?.case_id ?? null,
        ) => {
          if (!caseId) return; // nothing safe to anchor the log to
          await admin.schema("aml").from("reliance_access_log").insert({
            grant_id: grantId, case_id: caseId, action: "evidence_access",
            actor_label: `${partnerOrg.legal_name} — ${portalUserLabel ?? "portal user"}`,
            ip_address: ip,
            detail: {
              via: "partner_workspace", portal: surface,
              membership_id: membership.id,
              partner_case_link_id: link?.id ?? null,
              delivery_id: deliveryId || null,
              retrieval_reason: retrievalReason ? retrievalReason.slice(0, 500) : null,
              result, ...detailExtra,
            },
          });
        };
        const deny = async (
          status: number, code: string, message: string,
          detailExtra: Record<string, unknown> = {}, grantId: string | null = null,
        ) => {
          await logAttempt("denied", { denial_code: code, ...detailExtra }, grantId);
          return jr({ error: message, code }, status);
        };

        if (!link) return jr({ error: "Not found" }, 404);
        if (!(await flagEnabled(admin, "aml_partner_evidence_delivery_write"))) {
          return deny(409, "evidence_access_disabled",
            "Evidence access is not enabled for this environment.");
        }
        if (link.state !== "active") {
          return deny(409, "link_inactive", "This link is no longer active.");
        }
        if (membership.compliance_role !== "compliance_officer") {
          return deny(403, "compliance_role_required",
            "Only your organisation's compliance role can retrieve delivered evidence.");
        }
        if (!deliveryId) return jr({ error: "delivery_id required" }, 400);
        if (retrievalReason.length < 10) {
          return jr({ error: "retrieval_reason must be at least 10 characters — record why access is necessary now", code: "retrieval_reason_required" }, 400);
        }

        // Rate limit: attempts (any outcome) by this membership in the last
        // minute, from the same access log the attempt lands in.
        const { count: recentAttempts } = await admin.schema("aml").from("reliance_access_log")
          .select("id", { count: "exact", head: true })
          .eq("action", "evidence_access")
          .eq("detail->>membership_id", membership.id)
          .gte("created_at", new Date(Date.now() - 60_000).toISOString());
        if ((recentAttempts ?? 0) >= EVIDENCE_ACCESS_RATE_LIMIT) {
          return deny(429, "rate_limited", "Too many access attempts. Try again shortly.");
        }

        // Runtime catalogue tripwire: the classification correction must be
        // present and coherent, or nothing is served (fail closed).
        const { data: catalogueRow } = await admin.schema("aml").from("record_class_catalogue")
          .select("information_classification").eq("record_code", "raw_id_document_copy").maybeSingle();
        if (!catalogueRow || catalogueRow.information_classification !== "P3") {
          return deny(503, "catalogue_inconsistent",
            "Evidence access is unavailable while the record catalogue is inconsistent. Contact the issuing organisation.");
        }

        const { data: delivery } = await admin.schema("aml").from("partner_evidence_deliveries")
          .select("*").eq("id", deliveryId)
          .eq("partner_case_link_id", link.id).eq("partner_org_id", partnerOrg.id)
          .maybeSingle();
        if (!delivery) return deny(404, "delivery_not_found", "Not found");
        if (delivery.revoked_at) {
          return deny(403, "delivery_revoked", "Access to this record has been withdrawn.",
            { record_code: delivery.record_code });
        }
        if (new Date(delivery.expires_at).getTime() <= Date.now()) {
          return deny(403, "delivery_expired", "Access to this record has expired.",
            { record_code: delivery.record_code });
        }

        // The delivery must trace to an approved request covering EXACTLY
        // this record code on this link for this organisation.
        const { data: request } = await admin.schema("aml").from("partner_records_requests")
          .select("*").eq("id", delivery.request_id).maybeSingle();
        if (!request || request.partner_org_id !== partnerOrg.id
          || request.partner_case_link_id !== link.id || request.case_id !== link.case_id) {
          return deny(403, "request_mismatch", "This record is not available.",
            { record_code: delivery.record_code });
        }
        if (!["approved", "partly_approved", "delivered"].includes(request.status)) {
          return deny(403, "request_not_approved", "This record's request is not approved.",
            { record_code: delivery.record_code });
        }
        if (!(request.approved_record_codes ?? []).includes(delivery.record_code)) {
          return deny(403, "record_code_not_approved",
            "That record code was not approved on this request.",
            { record_code: delivery.record_code });
        }

        // Delivery-class rule: the object channel serves ONLY the closed P3
        // evidence catalogue. P1/P2 metadata, P4 reviewer material, P5
        // prohibited and P6 biometric classes are refused categorically.
        const classDecision = evaluateEvidenceObjectDelivery(
          delivery.record_code, REQUESTABLE_RECORD_CLASSES);
        if (!classDecision.ok) {
          return deny(403, classDecision.code, classDecision.message,
            { record_code: delivery.record_code });
        }

        // Legal route / arrangement: reliance-route sharing requires the
        // written arrangement to still stand. (Independent-CDD and
        // information-share links rest on the origin's explicit per-request
        // approval recorded above.)
        const { grant } = await loadOrgGrantAndAttestation(admin, link.case_id, partnerOrg.id);
        if (link.legal_route === "reliance" || link.legal_route === "outsourced_cdd") {
          const agreementId = grant?.agreement_id ?? request.grant_id ?? null;
          const { data: agreement } = agreementId
            ? await admin.schema("aml").from("reliance_agreements")
              .select("status").eq("id", agreementId).maybeSingle()
            : await admin.schema("aml").from("reliance_agreements")
              .select("status").eq("partner_org_id", partnerOrg.id)
              .eq("status", "active").limit(1).maybeSingle();
          if (!agreement || agreement.status !== "active") {
            return deny(403, "arrangement_inactive",
              "The arrangement between the organisations is not active.",
              { record_code: delivery.record_code }, grant?.id ?? null);
          }
        }
        // Disclosure manifest: where one exists for the current grant, a
        // REVOKED manifest is a kill switch for every disclosure channel.
        if (grant) {
          const { data: manifest } = await admin.schema("aml").from("disclosure_manifests")
            .select("revoked_at, expires_at").eq("grant_id", grant.id).maybeSingle();
          if (manifest?.revoked_at) {
            return deny(403, "manifest_revoked", "Access to this disclosure has been revoked.",
              { record_code: delivery.record_code }, grant.id);
          }
        }

        // Disclosure hold: any active legal hold touching the case or this
        // delivery withholds release with GENERIC wording — the existence
        // and reason of a hold are never disclosed to a partner.
        const { data: holds } = await admin.schema("aml").from("legal_holds")
          .select("id").is("released_at", null)
          .or(`case_id.eq.${link.case_id},and(entity_type.eq.partner_evidence_delivery,entity_id.eq.${delivery.id})`)
          .limit(1);
        if ((holds ?? []).length > 0) {
          return deny(409, "evidence_temporarily_unavailable",
            "This record is temporarily unavailable. Contact the issuing organisation if it remains needed.",
            { record_code: delivery.record_code }, grant?.id ?? null);
        }

        // The opaque object reference. Metadata-only deliveries (no linked
        // object) answer a safe unavailable state — nothing is fabricated.
        if (!delivery.evidence_document_id) {
          return deny(409, "evidence_object_unavailable",
            "No retrievable document is attached to this delivery. The delivery record itself remains valid metadata.",
            { record_code: delivery.record_code }, grant?.id ?? null);
        }
        const { data: doc } = await admin.schema("aml").from("documents")
          .select("id, case_id, filename, mime_type, storage_path, status")
          .eq("id", delivery.evidence_document_id).maybeSingle();
        if (!doc || doc.case_id !== link.case_id || doc.status !== "accepted" || !doc.storage_path) {
          return deny(409, "evidence_object_unavailable",
            "The underlying document is not available for release.",
            { record_code: delivery.record_code, evidence_document_id: delivery.evidence_document_id },
            grant?.id ?? null);
        }

        // Authorised: mint the short-lived signed URL through the existing
        // secure mechanism. The bucket name and permanent path never leave
        // this block; the URL is never written anywhere.
        const { data: signed, error: signErr } = await admin.storage
          .from("aml-documents")
          .createSignedUrl(doc.storage_path, EVIDENCE_ACCESS_TTL_SECONDS, { download: doc.filename });
        if (signErr || !signed?.signedUrl) {
          await logAttempt("failed", {
            denial_code: "storage_resolution_failed",
            record_code: delivery.record_code,
            evidence_document_id: delivery.evidence_document_id,
          }, grant?.id ?? null);
          return jr({
            error: "The document could not be retrieved. The attempt has been recorded — contact the issuing organisation.",
            code: "evidence_access_failed",
          }, 502);
        }

        const expiresAt = new Date(Date.now() + EVIDENCE_ACCESS_TTL_SECONDS * 1000).toISOString();
        await logAttempt("approved", {
          record_code: delivery.record_code,
          request_id: delivery.request_id,
          evidence_document_id: delivery.evidence_document_id,
          signed_expiry: expiresAt,
        }, grant?.id ?? null);
        await appendCaseEvent(admin, link.case_id, "system",
          `Evidence access by ${partnerOrg.legal_name}: ${delivery.record_code}`,
          {
            delivery_id: delivery.id, partner_case_link_id: link.id,
            record_code: delivery.record_code, signed_expiry: expiresAt,
            note: "Controlled P3 evidence retrieval under the written arrangement. Short-lived access; the URL is not retained.",
          }, null, `${partnerOrg.legal_name} — ${portalUserLabel ?? "portal user"}`);

        return jr({
          access: {
            url: signed.signedUrl,
            filename: doc.filename,
            mime_type: doc.mime_type ?? null,
            expires_at: expiresAt,
            record_code: delivery.record_code,
            safe_label: delivery.safe_label,
          },
        });
      }

      if (op === "list_partner_refresh_obligations") {
        // Safe fields ONLY: the internal trigger classification
        // (internal_trigger_codes, trigger_source) never leaves the origin.
        const link = await loadScopedPartnerLink(admin, String(body.partner_case_link_id ?? ""), partnerOrg.id, surface);
        if (!link) return jr({ error: "Not found" }, 404);
        const { data, error } = await admin.schema("aml").from("partner_refresh_obligations")
          .select("id, required_action, safe_reason_code, status, due_at, created_at, completed_at")
          .eq("partner_case_link_id", link.id).eq("partner_org_id", partnerOrg.id)
          .order("created_at", { ascending: false }).limit(50);
        if (error) throw error;
        return jr({ obligations: data ?? [] });
      }

      if (op === "list_partner_notifications") {
        // Fixed safe copy written by the outbox worker; org-scoped from the
        // resolved session, never from a body identifier.
        const { data, error } = await admin.schema("aml").from("partner_notifications")
          .select("id, partner_case_link_id, event_type, safe_reason_code, title, body, created_at, read_at")
          .eq("partner_org_id", partnerOrg.id)
          .order("created_at", { ascending: false }).limit(100);
        if (error) throw error;
        return jr({ notifications: data ?? [] });
      }

      if (op === "get_partner_audit_receipt") {
        const link = await loadScopedPartnerLink(admin, String(body.partner_case_link_id ?? ""), partnerOrg.id, surface);
        if (!link) return jr({ error: "Not found" }, 404);
        const [{ data: tenantRow }, { data: attestations }, { data: grants }, { data: determinations }, { data: requests }, { data: deliveries }] = await Promise.all([
          admin.schema("aml").from("tenant_settings")
            .select("display_name").eq("tenant_id", link.tenant_id ?? "default").maybeSingle(),
          admin.schema("aml").from("compliance_attestations")
            .select("version, payload_sha256, issued_at, superseded_at")
            .eq("case_id", link.case_id).order("version", { ascending: false }).limit(20),
          admin.schema("aml").from("reliance_grants")
            .select("id, granted_at, expires_at, revoked_at")
            .eq("case_id", link.case_id).eq("partner_org_id", partnerOrg.id),
          admin.schema("aml").from("independent_assessments")
            .select("status, decided_at, based_on_attestation_sha256, decision_basis, conditions, assessor_name, assessor_role, created_at")
            .eq("case_id", link.case_id).eq("partner_org_id", partnerOrg.id)
            .order("created_at", { ascending: false }).limit(50),
          admin.schema("aml").from("partner_records_requests")
            .select("id, requested_record_codes, status, requested_at, approved_record_codes, denied_record_codes, reviewed_at")
            .eq("partner_case_link_id", link.id).order("requested_at", { ascending: false }).limit(50),
          admin.schema("aml").from("partner_evidence_deliveries")
            .select("record_code, safe_label, delivered_version, delivered_sha256, delivered_at, expires_at, revoked_at")
            .eq("partner_case_link_id", link.id).order("delivered_at", { ascending: false }).limit(100),
        ]);
        const grantIds = (grants ?? []).map((g: any) => g.id);
        let accessEntries: any[] = [];
        if (grantIds.length > 0) {
          const { data: accessLog } = await admin.schema("aml").from("reliance_access_log")
            .select("action, created_at").in("grant_id", grantIds)
            .order("created_at", { ascending: false }).limit(200);
          accessEntries = accessLog ?? [];
        }
        const receipt = {
          generated_at: new Date().toISOString(),
          origin_organisation: tenantRow?.display_name ?? "Issuing organisation",
          partner_organisation: partnerOrg.legal_name,
          link_reference: {
            id: link.id, relationship_role: link.relationship_role,
            legal_route: link.legal_route, state: link.state,
            purchase_file_id: link.purchase_file_id ?? null,
            legal_matter_id: link.legal_matter_id ?? null,
          },
          attestations: (attestations ?? []).map((a: any) => ({
            version: a.version, sha256: a.payload_sha256,
            issued_at: a.issued_at, superseded_at: a.superseded_at,
          })),
          access_events: accessEntries,
          records_requests: requests ?? [],
          evidence_deliveries: deliveries ?? [],
          determinations: determinations ?? [],
          responsibility_notice:
            "This receipt records your organisation's own reliance activity and determinations. It does not contain, and must not be read as, the issuing organisation's internal assessment.",
        };
        const violations = findRestrictedKeys(receipt);
        if (violations.length > 0) {
          return jr({ error: "Receipt blocked by an integrity check." }, 500);
        }
        return jr({ receipt });
      }
    }

    /* ── partner ops: bearer token, no staff session ─────────────────────── */

    if (op === "redeem_attestation" || op === "record_independent_assessment") {
      const resolved = await resolveGrant(admin, String(body.access_token ?? ""));
      if (!resolved) return jr({ error: "Invalid access token" }, 401);
      if (resolved.denied) {
        return jr({ error: `Access ${resolved.denied.replace("_", " ")}`, code: resolved.denied }, 403);
      }
      const grant = resolved.grant;
      const agreement = (grant as any).reliance_agreements;
      const attestation = (grant as any).compliance_attestations;

      if (op === "redeem_attestation") {
        const schemaVersion = attestation.schema_version ?? 1;

        // Schema-aware reading. v1 historical grants behave exactly as
        // before. v2 is manifest-controlled: superseded content is never
        // served, expiry/revocation are checked at read time, and the
        // response is BUILT by intersecting the payload with the manifest —
        // denied classes override allowed codes, server-side.
        if (schemaVersion === 2) {
          const logDenied = async (code: string) => {
            await admin.schema("aml").from("reliance_access_log").insert({
              grant_id: grant.id, case_id: grant.case_id, action: "view_attestation",
              actor_label: agreement.partner_org_name, ip_address: ip,
              detail: { attestation_version: attestation.version, denied: code },
            });
          };
          if (attestation.superseded_at) {
            await logDenied("attestation_superseded");
            return jr({
              error: "This attestation has been superseded. Ask the issuing organisation for current access.",
              code: "attestation_superseded",
              refresh_required: true,
            }, 409);
          }
          // Phase 6: a material change flags the attestation for refresh
          // without superseding it — flagged content stops being served the
          // same way. Safe wording only; the trigger detail stays internal.
          if (attestation.refresh_required_at) {
            await logDenied("attestation_refresh_required");
            return jr({
              error: "The information behind this attestation has been updated. Ask the issuing organisation for refreshed access.",
              code: "attestation_refresh_required",
              refresh_required: true,
            }, 409);
          }
          const { data: manifest } = await admin.schema("aml").from("disclosure_manifests")
            .select("*").eq("grant_id", grant.id).maybeSingle();
          const manifestDecision = evaluateManifestForRead(manifest ?? null, new Date());
          if (!manifestDecision.ok) {
            await logDenied(manifestDecision.code);
            return jr({ error: manifestDecision.message, code: manifestDecision.code }, 403);
          }
          let disclosed: Record<string, unknown>;
          try {
            disclosed = intersectPayloadWithManifest(attestation.payload, manifest);
          } catch (_integrity) {
            // The stored payload tripped the restricted-key tripwire —
            // refuse to serve anything rather than risk over-disclosure.
            await logDenied("integrity_check_failed");
            return jr({ error: "Disclosure blocked by an integrity check. Contact the issuing organisation.", code: "integrity_check_failed" }, 500);
          }
          await admin.schema("aml").from("reliance_access_log").insert({
            grant_id: grant.id, case_id: grant.case_id, action: "view_attestation",
            actor_label: agreement.partner_org_name, ip_address: ip,
            detail: {
              attestation_version: attestation.version,
              schema_version: 2,
              manifest_version: manifest.version,
            },
          });
          return jr({
            attestation: disclosed,
            attestation_sha256: attestation.payload_sha256,
            schema_version: 2,
            issued_at: attestation.issued_at,
            agreement: {
              partner_org_name: agreement.partner_org_name,
              agreement_reference: agreement.agreement_reference,
              scope: agreement.scope,
            },
            notice: "You may rely on the customer identification procedures described here under your written CDD arrangement (AML/CTF Act Pt 2 Div 7). Your organisation remains responsible for its own AML/CTF compliance. To make your own determination without re-approaching the customer, record an independent assessment.",
          });
        }

        await admin.schema("aml").from("reliance_access_log").insert({
          grant_id: grant.id, case_id: grant.case_id, action: "view_attestation",
          actor_label: agreement.partner_org_name, ip_address: ip,
          detail: { attestation_version: attestation.version },
        });
        return jr({
          attestation: attestation.payload,
          attestation_sha256: attestation.payload_sha256,
          issued_at: attestation.issued_at,
          agreement: {
            partner_org_name: agreement.partner_org_name,
            agreement_reference: agreement.agreement_reference,
            scope: agreement.scope,
          },
          // The statutory position, restated at the point of use so a partner
          // integration cannot claim it was not told.
          notice: "You may rely on the customer identification procedures described here under your written CDD arrangement (AML/CTF Act Pt 2 Div 7). Your organisation remains responsible for its own AML/CTF compliance. To make your own determination without re-approaching the customer, record an independent assessment.",
        });
      }

      // record_independent_assessment — the partner's OWN determination,
      // made against internally-held records. Never touches our case status
      // or service gate: their compliance is theirs, ours is ours.
      const assessorName = String(body.assessor_name ?? "").trim();
      const status = String(body.status ?? "");
      const notes = String(body.decision_notes ?? "").trim();
      if (!assessorName) return jr({ error: "assessor_name is required" }, 400);
      if (!["satisfied", "not_satisfied", "records_requested"].includes(status)) {
        return jr({ error: 'status must be "satisfied", "not_satisfied" or "records_requested"' }, 400);
      }
      if (notes.length < 10) return jr({ error: "decision_notes must be at least 10 characters" }, 400);

      const { data: assessment, error } = await admin.schema("aml")
        .from("independent_assessments").insert({
          grant_id: grant.id, case_id: grant.case_id, agreement_id: agreement.id,
          assessor_name: assessorName.slice(0, 200),
          assessor_role: String(body.assessor_role ?? "").slice(0, 200) || null,
          based_on_attestation_sha256: attestation.payload_sha256,
          status, decision_notes: notes,
          decided_at: new Date().toISOString(),
        }).select("*").single();
      if (error) throw error;

      await admin.schema("aml").from("reliance_access_log").insert({
        grant_id: grant.id, case_id: grant.case_id,
        action: status === "records_requested" ? "records_request" : "independent_assessment",
        actor_label: `${agreement.partner_org_name} — ${assessorName}`, ip_address: ip,
        detail: { assessment_id: assessment.id, status },
      });
      await appendCaseEvent(admin, grant.case_id, "system",
        `Independent assessment by ${agreement.partner_org_name}: ${status.replace("_", " ")}`,
        {
          assessment_id: assessment.id, agreement_id: agreement.id,
          based_on_attestation_sha256: attestation.payload_sha256,
          // Explicit in the audit trail: this decision is the partner's.
          note: "Partner determination under its own AML/CTF obligations. Does not alter this case's status or service gate.",
        }, null, agreement.partner_org_name);

      return jr({
        assessment: { id: assessment.id, status: assessment.status, decided_at: assessment.decided_at },
        message: status === "records_requested"
          ? "Your records request has been logged. The MLRO will respond under the CDD arrangement."
          : "Your independent assessment has been recorded against the attestation you reviewed.",
      });
    }

    /* ── staff ops ───────────────────────────────────────────────────────── */

    const auth = await verifyAuth(admin, req.headers, body);
    if (auth.error || !auth.userId || auth.userId === "service_role") {
      return jr({ error: auth.error || "Authentication required" }, 401);
    }
    const userId = auth.userId;
    const userEmail = auth.username ?? null;
    const { data: hasAny } = await admin.rpc("has_any_aml_role", { _user_id: userId });
    if (!hasAny) return jr({ error: "AML role required" }, 403);
    const { data: roleRows } = await admin.schema("aml").from("role_assignments")
      .select("role").eq("user_id", userId).is("revoked_at", null);
    const roles = new Set<string>((roleRows ?? []).map((r: any) => r.role));
    const isMlro = roles.has("mlro");

    switch (op) {
      case "list_agreements": {
        const { data, error } = await admin.schema("aml").from("reliance_agreements")
          .select("*").order("created_at", { ascending: false });
        if (error) throw error;
        return jr({ agreements: data ?? [] });
      }

      case "create_agreement": {
        // Cross-entity disclosure machinery is MLRO-only, like every other
        // outward-facing restricted operation in this module.
        if (!isMlro) return jr({ error: "MLRO role required" }, 403);
        const name = String(body.partner_org_name ?? "").trim();
        const type = String(body.partner_org_type ?? "");
        const ref = String(body.agreement_reference ?? "").trim();
        const executed = String(body.executed_on ?? "");
        const review = String(body.next_review_due ?? "");
        if (!name) return jr({ error: "partner_org_name is required" }, 400);
        if (!["finance", "builder", "developer", "solicitor_conveyancer", "other"].includes(type)) {
          return jr({ error: "partner_org_type must be finance, builder, developer, solicitor_conveyancer or other" }, 400);
        }
        // No written agreement, no s 37A. Not a formality.
        if (!ref) return jr({ error: "agreement_reference is required — reliance without a written CDD arrangement is not available under Pt 2 Div 7" }, 400);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(executed)) return jr({ error: "executed_on must be YYYY-MM-DD" }, 400);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(review)) return jr({ error: "next_review_due must be YYYY-MM-DD — the arrangement must be reviewed regularly" }, 400);
        const { data, error } = await admin.schema("aml").from("reliance_agreements").insert({
          partner_org_name: name.slice(0, 200), partner_org_type: type,
          partner_abn: String(body.partner_abn ?? "").slice(0, 20) || null,
          agreement_reference: ref.slice(0, 200), executed_on: executed,
          next_review_due: review, notes: String(body.notes ?? "").slice(0, 2000) || null,
          created_by: userId,
        }).select("*").single();
        if (error) throw error;
        return jr({ agreement: data });
      }

      case "review_agreement": {
        if (!isMlro) return jr({ error: "MLRO role required" }, 403);
        const id = String(body.agreement_id ?? "");
        const nextDue = String(body.next_review_due ?? "");
        const outcome = String(body.outcome ?? "");
        if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(nextDue)) {
          return jr({ error: "agreement_id and next_review_due (YYYY-MM-DD) are required" }, 400);
        }
        if (!["continue", "suspend", "terminate"].includes(outcome)) {
          return jr({ error: 'outcome must be "continue", "suspend" or "terminate"' }, 400);
        }
        const { data, error } = await admin.schema("aml").from("reliance_agreements").update({
          last_reviewed_at: new Date().toISOString(), last_reviewed_by: userId,
          next_review_due: nextDue,
          status: outcome === "continue" ? "active" : outcome === "suspend" ? "suspended" : "terminated",
          updated_at: new Date().toISOString(),
        }).eq("id", id).select("*").single();
        if (error) throw error;
        return jr({ agreement: data });
      }

      case "issue_attestation": {
        if (!isMlro) return jr({ error: "MLRO role required — an attestation is an outward statement of this entity's procedures" }, 403);
        const caseId = String(body.case_id ?? "");
        if (!caseId) return jr({ error: "case_id required" }, 400);
        const { data: caseRow } = await admin.schema("aml").from("cases")
          .select("*").eq("id", caseId).maybeSingle();
        if (!caseRow) return jr({ error: "Case not found" }, 404);

        const payload = await buildAttestationPayload(admin, caseRow);
        // Refuse to attest to nothing: an attestation with zero verified
        // parties is a passport for a process that has not happened.
        if (!payload.customer_identification.parties.some((p: any) => p.verified)) {
          return jr({
            error: "No verified parties on this case — complete identity verification before issuing an attestation.",
            code: "nothing_to_attest",
          }, 409);
        }

        // Schema v2 (flag-gated): anchored to the EXPLICIT authorised gate
        // decision, hashed canonically, with a material-input hash so
        // supersession is deterministic. v1 issuance below is byte-identical
        // to the pre-Phase-3 behaviour while the flag is off.
        const v2 = await attestationV2Enabled(admin);
        let payloadToStore: Record<string, unknown> = payload as Record<string, unknown>;
        let payloadSha: string;
        const insertExtra: Record<string, unknown> = {};
        let materialHash: string | null = null;
        if (v2) {
          if (!["approved", "approved_with_controls"].includes(String(caseRow.service_gate_status ?? ""))) {
            return jr({
              error: "A v2 attestation requires an explicit approved or approved-with-controls service gate on this case.",
              code: "service_gate_not_approved",
            }, 409);
          }
          const { data: gateDecision } = await admin.schema("aml").from("service_gate_decisions")
            .select("id, status").eq("case_id", caseId)
            .in("status", ["approved", "approved_with_controls"])
            .order("created_at", { ascending: false }).limit(1).maybeSingle();
          if (!gateDecision) {
            return jr({
              error: "No recorded service-gate decision exists for this case. A v2 attestation anchors to the explicit decision record, not a status string.",
              code: "service_gate_decision_missing",
            }, 409);
          }
          payloadToStore = toV2Payload(payload as Record<string, unknown>);
          const violations = findRestrictedKeys(payloadToStore);
          if (violations.length > 0) {
            // Fail closed and loudly: never store, never serve.
            return jr({
              error: `Refusing to issue: restricted vocabulary in the assembled payload (${violations.join(", ")}).`,
              code: "restricted_keys_in_payload",
            }, 500);
          }
          materialHash = await materialInputHash({
            subject: (payload as any).subject ?? null,
            subject_type: (payload as any).subject_type ?? null,
            parties: (payload as any).customer_identification.parties,
            consents_held: (payload as any).customer_identification.consents_held,
            screening: (payload as any).screening,
            service_gate_decision_id: gateDecision.id,
            limitations: (payload as any).limitations,
            questionnaire_version: (payload as any).customer_identification.questionnaire_version ?? null,
          });
          payloadSha = await sha256HexCanonical(payloadToStore);
          insertExtra.schema_version = 2;
          insertExtra.material_input_hash = materialHash;
          insertExtra.service_gate_decision_id = gateDecision.id;
        } else {
          payloadSha = await sha256Hex(JSON.stringify(payloadToStore));
        }

        const { data: last } = await admin.schema("aml").from("compliance_attestations")
          .select("*").eq("case_id", caseId)
          .order("version", { ascending: false }).limit(1).maybeSingle();
        const version = (last?.version ?? 0) + 1;
        if (v2) {
          const requested = String(body.issued_reason_code ?? "");
          insertExtra.issued_reason_code =
            ["initial_issue", "material_change", "scheduled_refresh", "correction", "other"].includes(requested)
              ? requested
              : !last ? "initial_issue"
              : (last.material_input_hash && last.material_input_hash !== materialHash)
                ? "material_change" : "other";
        }
        if (last) {
          const supersedePatch: Record<string, unknown> = { superseded_at: new Date().toISOString() };
          if (v2) {
            supersedePatch.superseded_reason_code =
              insertExtra.issued_reason_code === "material_change" ? "material_change" : "new_version_issued";
          }
          await admin.schema("aml").from("compliance_attestations")
            .update(supersedePatch).eq("id", last.id);
        }
        const { data: att, error } = await admin.schema("aml").from("compliance_attestations")
          .insert({
            case_id: caseId, version, payload: payloadToStore, payload_sha256: payloadSha,
            issued_by: userId, issued_by_email: userEmail,
            ...insertExtra,
          }).select("*").single();
        if (error) throw error;
        if (v2 && last) {
          await admin.schema("aml").from("compliance_attestations")
            .update({ superseded_by_id: att.id }).eq("id", last.id);
        }

        await appendCaseEvent(admin, caseId, "mlro_decision",
          `Compliance attestation v${version} issued (sha ${payloadSha.slice(0, 12)})`,
          {
            attestation_id: att.id, version, payload_sha256: payloadSha,
            schema_version: v2 ? 2 : 1,
            material_input_hash: materialHash,
            issued_reason_code: (insertExtra.issued_reason_code as string | undefined) ?? null,
          }, userId, userEmail);
        return jr({ attestation: att });
      }

      case "list_attestations": {
        if (!body.case_id) return jr({ error: "case_id required" }, 400);
        const { data, error } = await admin.schema("aml").from("compliance_attestations")
          .select("*").eq("case_id", body.case_id).order("version", { ascending: false });
        if (error) throw error;
        return jr({ attestations: data ?? [] });
      }

      /* ── Passport partner distribution (Phase 1) ────────────────────────
         Readiness and distribution are SERVER-DERIVED. The body names a case
         and, optionally, which partners to consider; it can never assert that
         a partner is eligible, that an arrangement is current, that consent
         exists or that the Passport is issued — every one of those is read
         from the database here and decided by
         `passportDistribution.pure.ts`.

         The distribution flag gates the WRITE path and the readiness answer.
         With it off these operations report `distribution_disabled` and
         nothing else in this function changes behaviour. */

      case "get_passport_distribution_readiness":
      case "get_passport_distribution_status":
      case "share_passport_to_partner":
      case "share_passport_to_partners": {
        if (!isMlro) return jr({ error: "MLRO role required" }, 403);
        const distributionEnabled = await flagEnabled(admin, "aml_passport_partner_distribution");
        const isWrite = op === "share_passport_to_partner" || op === "share_passport_to_partners";
        if (!distributionEnabled && isWrite) {
          return jr({
            error: "Passport partner distribution is not enabled for this environment.",
            code: "distribution_disabled",
          }, 409);
        }

        const caseId = String(body.case_id ?? "");
        if (!caseId) return jr({ error: "case_id is required" }, 400);

        const { data: caseRow } = await admin.schema("aml").from("cases")
          .select("id, subject_type, status, service_gate_status")
          .eq("id", caseId).maybeSingle();
        if (!caseRow) return jr({ error: "Case not found" }, 404);
        const caseTenant = tenantForCase(String(caseRow.id));

        // Current, non-superseded attestation — the exact version distribution
        // pins to (§15). Never taken from the body.
        const { data: att } = await admin.schema("aml").from("compliance_attestations")
          .select("id, version, payload_sha256, issued_at, superseded_at, schema_version")
          .eq("case_id", caseId).is("superseded_at", null)
          .order("version", { ascending: false }).limit(1).maybeSingle();

        const { data: consentRow } = await admin.schema("aml").from("consents")
          .select("id").eq("case_id", caseId).eq("kind", "compliance_sharing")
          .order("accepted_at", { ascending: false }).limit(1).maybeSingle();

        const { count: openRefresh } = await admin.schema("aml")
          .from("partner_refresh_obligations")
          .select("id", { count: "exact", head: true })
          .eq("case_id", caseId).eq("status", "open");

        // Every field `PassportAttestationFact` declares, not only the three
        // the state machine reads first. `schema_version` in particular is not
        // decoration: `PassportStateInput.material_inputs_current` documents
        // that `null` means "not assessable (v1 attestation)", so the version
        // is how a v1 attestation is told apart from a v2 one. The query above
        // already selects both, so carrying them costs nothing.
        const attestations = att
          ? [{
            version: att.version,
            issued_at: att.issued_at,
            superseded_at: att.superseded_at,
            payload_sha256: att.payload_sha256,
            schema_version: att.schema_version,
          }]
          : [];
        const passportState = derivePassportState({
          attestations,
          service_gate_status: caseRow.service_gate_status,
          case_status: caseRow.status,
          material_inputs_current: true,
          open_refresh_obligations: openRefresh ?? 0,
        });

        // Candidate partners are the ACTIVE links on this case. A body may
        // narrow the set but never widen it — an organisation with no link
        // cannot be introduced by naming it.
        const { data: linkRows } = await admin.schema("aml").from("partner_case_links")
          .select("id, case_id, tenant_id, partner_org_id, portal_type, relationship_role, legal_route, purpose, state")
          .eq("case_id", caseId);
        const requested: string[] = Array.isArray(body.partner_org_ids)
          ? body.partner_org_ids.map((v: unknown) => String(v))
          : typeof body.partner_org_id === "string" ? [body.partner_org_id] : [];
        const orgIds = [...new Set((linkRows ?? []).map((l: any) => l.partner_org_id).filter(Boolean))]
          .filter((id) => requested.length === 0 || requested.includes(String(id)));

        const distCtx: DistributionContext = {
          caseId, caseTenantId: caseTenant,
          caseSubjectType: caseRow.subject_type ?? null,
          sharingConsentId: consentRow?.id ?? null,
          passport: {
            attestation: att ?? null,
            stateCode: passportState.code,
            openRefreshObligations: openRefresh ?? 0,
            serviceGateStatus: caseRow.service_gate_status ?? null,
          },
          distributionEnabled,
          now: new Date(),
        };

        const evaluations: Array<{ candidate: DistributionCandidate; readiness: any; agreementId: string | null }> = [];
        for (const orgId of orgIds) {
          const links = (linkRows ?? []).filter((l: any) => l.partner_org_id === orgId);
          const primary = links.find((l: any) => l.state === "active") ?? links[0];

          const { data: org } = await admin.schema("aml").from("partner_organisations")
            .select("id, legal_name, status, classification_status")
            .eq("id", orgId).maybeSingle();

          const { data: membership } = await admin.schema("aml").from("partner_portal_memberships")
            .select("id, partner_org_id, portal_type, portal_user_source, portal_user_id, status")
            .eq("partner_org_id", orgId).eq("status", "active")
            .limit(1).maybeSingle();

          const { data: agreement } = await admin.schema("aml").from("reliance_agreements")
            .select("id, status, next_review_due, eligibility_classification, scope_procedures, scope_customer_types, effective_from, expires_on, partner_org_id")
            .eq("partner_org_id", orgId).eq("status", "active")
            .order("created_at", { ascending: false }).limit(1).maybeSingle();

          const { data: assessment } = agreement
            ? await admin.schema("aml").from("arrangement_assessments")
              .select("decision, next_due_at, status")
              .eq("agreement_id", agreement.id).eq("status", "operative").maybeSingle()
            : { data: null };

          const { data: grant } = await admin.schema("aml").from("reliance_grants")
            .select("id, attestation_id, expires_at, revoked_at, refresh_required_at, partner_org_id")
            .eq("case_id", caseId).eq("partner_org_id", orgId)
            .order("granted_at", { ascending: false }).limit(1).maybeSingle();

          const { count: manifestCount } = att && grant
            ? await admin.schema("aml").from("disclosure_manifests")
              .select("id", { count: "exact", head: true })
              .eq("attestation_id", att.id).eq("grant_id", grant.id).is("revoked_at", null)
            : { count: 0 };

          const [docs, checks, owners, txns, deliveries] = await Promise.all([
            admin.schema("aml").from("documents").select("id", { count: "exact", head: true })
              .eq("case_id", caseId).eq("status", "accepted"),
            admin.schema("aml").from("verification_checks").select("id", { count: "exact", head: true })
              .eq("case_id", caseId).eq("status", "passed"),
            admin.schema("aml").from("beneficial_owners").select("id", { count: "exact", head: true })
              .eq("entity_id", caseRow.id),
            admin.schema("aml").from("transactions").select("id", { count: "exact", head: true })
              .eq("case_id", caseId),
            admin.schema("aml").from("partner_evidence_deliveries").select("id", { count: "exact", head: true })
              .eq("case_id", caseId).eq("partner_org_id", orgId).is("revoked_at", null),
          ]);

          const candidate: DistributionCandidate = {
            partnerOrgId: String(orgId),
            partnerOrgName: org?.legal_name ?? null,
            portalType: primary?.portal_type ?? null,
            legalRoute: primary?.legal_route ?? null,
            relationshipRole: primary?.relationship_role ?? null,
            purpose: primary?.purpose ?? null,
            partnerOrg: org ? { id: org.id, status: org.status } : null,
            classificationStatus: org?.classification_status ?? null,
            links: (links ?? []).map((l: any) => ({
              id: l.id, case_id: l.case_id, tenant_id: l.tenant_id,
              partner_org_id: l.partner_org_id, legal_route: l.legal_route, state: l.state,
            })),
            membership: membership ?? null,
            arrangement: agreement
              ? {
                id: agreement.id, status: agreement.status,
                next_review_due: agreement.next_review_due,
                eligibility_classification: agreement.eligibility_classification ?? "unassessed",
                scope_procedures: agreement.scope_procedures ?? null,
                scope_customer_types: agreement.scope_customer_types ?? null,
                effective_from: agreement.effective_from ?? null,
                expires_on: agreement.expires_on ?? null,
                partner_org_id: agreement.partner_org_id ?? null,
              }
              : null,
            assessment: assessment ?? null,
            existingGrant: grant ?? null,
            manifestPresent: (manifestCount ?? 0) > 0,
            evidence: {
              identityDocumentsAccepted: docs.count ?? 0,
              verificationPassed: checks.count ?? 0,
              addressEvidenceAccepted: 0,
              entityEvidenceAccepted: caseRow.subject_type === "individual" ? 0 : (docs.count ?? 0),
              ownershipRecords: owners.count ?? 0,
              authorityRecords: 0,
              transactionRecords: txns.count ?? 0,
              deliveriesToPartner: deliveries.count ?? 0,
            },
          };
          evaluations.push({
            candidate,
            readiness: evaluateDistribution(distCtx, candidate),
            agreementId: agreement?.id ?? null,
          });
        }

        if (op === "get_passport_distribution_readiness" || op === "get_passport_distribution_status") {
          return jr({
            enabled: distributionEnabled,
            passport: {
              attestation_id: att?.id ?? null,
              version: att?.version ?? null,
              payload_sha256: att?.payload_sha256 ?? null,
              issued_at: att?.issued_at ?? null,
              state: passportState,
            },
            partners: evaluations.map((e) => e.readiness),
            summary: summariseBatch(evaluations.map((e) => e.readiness)),
          });
        }

        /* Write path. Each partner is executed independently: one failure
           never reports another as shared, and an ALREADY_CURRENT partner is
           a no-op rather than a duplicate grant (§10). */
        const outcomes: any[] = [];
        for (const e of evaluations) {
          const r = e.readiness;
          if (!r.ready) {
            outcomes.push({
              partner_org_id: r.partner.org_id, state: r.state, shared: false,
              blockers: r.blockers, messages: r.messages,
            });
            continue;
          }
          if (r.state === "ALREADY_CURRENT") {
            outcomes.push({
              partner_org_id: r.partner.org_id, state: "ALREADY_CURRENT", shared: false,
              grant_id: e.candidate.existingGrant?.id ?? null,
              note: "This partner already holds the current Passport version.",
            });
            continue;
          }
          if (!e.agreementId) {
            // Non-reliance routes carry no arrangement, so there is no grant
            // to create here. Phase 2 wires their portal surface; Phase 1
            // reports the readiness rather than inventing a record.
            outcomes.push({
              partner_org_id: r.partner.org_id, state: r.state, shared: false,
              code: "route_not_grant_backed",
              note: `The ${r.legal_route} route does not create a reliance grant. Readiness is recorded; portal delivery follows in Phase 2.`,
            });
            continue;
          }

          const { data: existing } = await admin.schema("aml").from("reliance_grants")
            .select("id").eq("case_id", caseId)
            .eq("partner_org_id", r.partner.org_id)
            .eq("attestation_id", att!.id).is("revoked_at", null)
            .limit(1).maybeSingle();
          if (existing) {
            outcomes.push({
              partner_org_id: r.partner.org_id, state: "ALREADY_CURRENT",
              shared: false, grant_id: existing.id,
            });
            continue;
          }

          const rawToken = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
          const grantInsert: Record<string, unknown> = {
            case_id: caseId, agreement_id: e.agreementId, attestation_id: att!.id,
            consent_id: distCtx.sharingConsentId,
            access_token_hash: await sha256Hex(rawToken),
            granted_by: userId,
            expires_at: new Date(Date.now() + GRANT_TTL_DAYS * 864e5).toISOString(),
            partner_org_id: r.partner.org_id,
          };
          const activeLink = e.candidate.links.find((l) => l.state === "active");
          if (activeLink) grantInsert.partner_case_link_id = activeLink.id;
          const { data: grant, error: grantError } = await admin.schema("aml")
            .from("reliance_grants").insert(grantInsert).select("*").single();
          if (grantError) {
            outcomes.push({
              partner_org_id: r.partner.org_id, state: "ACTION_REQUIRED", shared: false,
              code: "grant_write_failed",
            });
            continue;
          }

          if ((att!.schema_version ?? 1) === 2 && await attestationV2Enabled(admin)) {
            const manifestScope = {
              allowed_attribute_codes: DEFAULT_ALLOWED_ATTRIBUTE_CODES,
              allowed_record_classes: [] as string[],
              denied_classes: DEFAULT_DENIED_CLASSES,
            };
            const manifestSha = await sha256HexCanonical({
              ...manifestScope, attestation_id: att!.id, grant_id: grant.id, version: 1,
            });
            await admin.schema("aml").from("disclosure_manifests").insert({
              attestation_id: att!.id, grant_id: grant.id,
              partner_org_id: r.partner.org_id,
              partner_case_link_id: activeLink?.id ?? null,
              purpose: "passport_distribution",
              consent_id: distCtx.sharingConsentId,
              ...manifestScope,
              manifest_sha256: manifestSha,
              expires_at: grant.expires_at,
              created_by: userId,
            });
          }

          await appendCaseEvent(admin, caseId, "mlro_decision",
            `Passport v${att!.version} distributed to ${r.partner.org_name} (${r.legal_route})`,
            {
              grant_id: grant.id, agreement_id: e.agreementId,
              attestation_id: att!.id, attestation_version: att!.version,
              partner_org_id: r.partner.org_id, legal_route: r.legal_route,
              evidence_classes: r.evidence.available,
            }, userId, userEmail);

          outcomes.push({
            partner_org_id: r.partner.org_id, state: "CURRENTLY_SHARED", shared: true,
            grant_id: grant.id, attestation_version: att!.version,
            access_token: rawToken,
            evidence_classes: r.evidence.available,
          });
        }

        return jr({
          passport: { attestation_id: att?.id ?? null, version: att?.version ?? null },
          outcomes,
          summary: {
            total: outcomes.length,
            shared: outcomes.filter((o) => o.shared).length,
            already_current: outcomes.filter((o) => o.state === "ALREADY_CURRENT").length,
            blocked: outcomes.filter((o) => !o.shared && o.state !== "ALREADY_CURRENT").length,
          },
        });
      }

      case "get_passport_view": {
        // Command Centre Passport projection — read-only, any AML role.
        // The view is BUILT server-side by the shared pure assembler
        // (`_shared/aml/passport/passportView.pure.ts`): one credential
        // format, one state derivation, one stamp vocabulary for every
        // portal. Nothing here writes; nothing here re-decides.
        if (!(await flagEnabled(admin, "aml_passport_command_view"))) {
          return jr({ error: "The Compliance Passport view is not available.", code: "passport_disabled" }, 404);
        }
        const caseId = String(body.case_id ?? "");
        if (!caseId) return jr({ error: "case_id required" }, 400);
        const { data: caseRow } = await admin.schema("aml").from("cases")
          .select("id, case_reference, subject_display_name, subject_type, status, case_stage, service_gate_status, opened_at, closed_at, assigned_mlro_id")
          .eq("id", caseId).maybeSingle();
        if (!caseRow) return jr({ error: "Case not found" }, 404);

        const [
          { data: attRows }, { data: consents }, { data: checks }, { data: docs },
          { data: reqs }, { data: subjects }, { data: pep }, { data: syncs },
          { data: entityLinks }, { data: sof }, { data: sow }, { data: edd },
          { data: txns }, { data: links }, { data: grants }, { data: assessments },
          { data: refreshObs }, { data: events }, { data: requests }, { data: tenant },
        ] = await Promise.all([
          admin.schema("aml").from("compliance_attestations")
            .select("id, version, issued_at, superseded_at, payload_sha256, schema_version, refresh_required_at")
            .eq("case_id", caseId).order("version", { ascending: true }),
          admin.schema("aml").from("consents")
            .select("id, kind, accepted_at, actor_label").eq("case_id", caseId),
          admin.schema("aml").from("verification_checks")
            .select("id, party_label, check_type, status, completed_at").eq("case_id", caseId),
          admin.schema("aml").from("documents")
            .select("id, requirement_id, status, created_at, reviewed_at, version_number")
            .eq("case_id", caseId).neq("status", "deleted"),
          admin.schema("aml").from("document_requirements")
            .select("id, code, label, required").eq("case_id", caseId),
          admin.schema("aml").from("party_screening_subjects")
            .select("state, last_screened_at, adjudicated_at, screened_name").eq("case_id", caseId),
          admin.schema("aml").from("pep_determinations")
            .select("result, determined_at").eq("case_id", caseId)
            .is("superseded_at", null).order("determined_at", { ascending: false }).limit(1),
          admin.schema("aml").from("sanctions_list_syncs")
            .select("list_code, completed_at").eq("status", "succeeded")
            .order("completed_at", { ascending: false }).limit(10),
          admin.schema("aml").from("entity_case_links")
            .select("entity_id").eq("case_id", caseId),
          admin.schema("aml").from("source_of_funds")
            .select("verified, verified_at").eq("case_id", caseId),
          admin.schema("aml").from("source_of_wealth")
            .select("verified, verified_at").eq("case_id", caseId),
          admin.schema("aml").from("edd_cases")
            .select("status, completed_at").eq("case_id", caseId),
          admin.schema("aml").from("transactions")
            .select("id, kind, status, property_address, contract_date, settlement_date, purchase_price")
            .eq("case_id", caseId).is("archived_at", null),
          admin.schema("aml").from("partner_case_links")
            .select("state, legal_route, portal_type, partner_org_id, partner_organisations:partner_org_id(legal_name, organisation_type)")
            .eq("case_id", caseId),
          admin.schema("aml").from("reliance_grants")
            .select("id, granted_at, expires_at, revoked_at, attestation_id, reliance_agreements:agreement_id(partner_org_name, partner_org_type)")
            .eq("case_id", caseId),
          admin.schema("aml").from("independent_assessments")
            .select("id, status, decided_at, assessor_name, reliance_agreements:agreement_id(partner_org_name, partner_org_type)")
            .eq("case_id", caseId),
          admin.schema("aml").from("partner_refresh_obligations")
            .select("id, created_at, status, completed_at, cancelled_at, due_at").eq("case_id", caseId),
          admin.schema("aml").from("case_events")
            .select("id, category, summary, actor_label, created_at")
            .eq("case_id", caseId).order("created_at", { ascending: false }).limit(300),
          admin.schema("aml").from("client_requests")
            .select("id, kind, subject, status, created_at").eq("case_id", caseId)
            .order("created_at", { ascending: false }),
          admin.schema("aml").from("tenant_settings")
            .select("display_name, mlro_contact_name").eq("tenant_id", "default").maybeSingle(),
        ]);

        // Beneficial owners hang off entities, which link to the case through
        // entity_case_links — a two-step read, not a PostgREST embed.
        const entityIds = [...new Set((entityLinks ?? []).map((l: any) => l.entity_id).filter(Boolean))];
        const [{ data: owners }, { data: reps }, { data: entityRows }] = entityIds.length
          ? await Promise.all([
              admin.schema("aml").from("beneficial_owners")
                .select("full_name, ownership_percent, control_type, is_ubo, verification_state, updated_at")
                .in("entity_id", entityIds),
              admin.schema("aml").from("authorised_representatives")
                .select("full_name, role_title, is_director, is_signatory, verification_state")
                .in("entity_id", entityIds),
              admin.schema("aml").from("entities")
                .select("legal_name, entity_type, abn, acn, jurisdiction, registered_address")
                .in("id", entityIds),
            ])
          : [{ data: [] as any[] }, { data: [] as any[] }, { data: [] as any[] }];

        // Control structure: owners and representatives as ONE party list.
        // Names and roles only — risk flags, PEP linkage and notes stay in
        // the case file and are never projected.
        const ownership = [
          ...(owners ?? []).map((o: any) => ({
            name: o.full_name ?? "Beneficial owner",
            party_kind: "beneficial_owner",
            relationship: o.control_type ?? null,
            ownership_percent: typeof o.ownership_percent === "number" ? o.ownership_percent : null,
            control_type: o.control_type ?? null,
            is_ubo: o.is_ubo ?? null,
            verification_state: o.verification_state ?? null,
          })),
          ...(reps ?? []).map((r: any) => ({
            name: r.full_name ?? "Authorised representative",
            party_kind: "authorised_representative",
            relationship: r.role_title ?? (r.is_director ? "Director" : r.is_signatory ? "Signatory" : null),
            ownership_percent: null,
            control_type: r.is_director ? "director" : r.is_signatory ? "signatory" : null,
            is_ubo: false,
            verification_state: r.verification_state ?? null,
          })),
        ];

        const attFacts = (attRows ?? []).map((a: any) => ({
          version: a.version,
          issued_at: a.issued_at,
          superseded_at: a.superseded_at,
          payload_sha256: a.payload_sha256,
          schema_version: a.schema_version ?? 1,
        }));
        const current = (attRows ?? []).filter((a: any) => !a.superseded_at)
          .sort((a: any, b: any) => b.version - a.version)[0] ?? null;
        // Material currency: the canonical signal is `refresh_required_at`
        // stamped by apply_partner_material_change. v1 attestations are not
        // assessable (null) and never force a caution state on their own.
        const materialCurrent = current
          ? (current.refresh_required_at ? false : ((current.schema_version ?? 1) === 2 ? true : null))
          : null;

        const versionByAttId = new Map<string, number>((attRows ?? []).map((a: any) => [a.id, a.version]));
        const grantView = grants ?? [];
        const lastViewByGrant = new Map<string, string>();
        if ((grants ?? []).length > 0) {
          const { data: views } = await admin.schema("aml").from("reliance_access_log")
            .select("grant_id, created_at").eq("case_id", caseId)
            .in("action", ["redeem", "view_attestation"])
            .order("created_at", { ascending: false }).limit(500);
          for (const v of (views ?? [])) {
            if (v.grant_id && !lastViewByGrant.has(v.grant_id)) lastViewByGrant.set(v.grant_id, v.created_at);
          }
        }
        // Authorised disclosure per organisation. Read from the stored v2
        // manifest: allowed codes minus denied classes, with denied winning.
        // A v1 grant has no manifest and therefore discloses no matrix — the
        // page says so rather than implying an empty matrix means "nothing".
        const manifestByGrant = new Map<string, any>();
        if ((grants ?? []).length > 0) {
          const { data: manifests } = await admin.schema("aml").from("disclosure_manifests")
            .select("grant_id, allowed_attribute_codes, allowed_record_classes, denied_classes, revoked_at")
            .in("grant_id", (grants ?? []).map((g: any) => g.id));
          for (const m of (manifests ?? [])) {
            if (!m.revoked_at) manifestByGrant.set(m.grant_id, m);
          }
        }
        const disclosureFor = (grantId: string | null | undefined) => {
          const m = grantId ? manifestByGrant.get(grantId) : null;
          if (!m) return [];
          const denied = new Set<string>((m.denied_classes ?? []) as string[]);
          const codes = [
            ...((m.allowed_attribute_codes ?? []) as string[]),
            ...((m.allowed_record_classes ?? []) as string[]),
          ];
          const seen = new Set<string>();
          const out: Array<{ code: string; state: "granted" | "limited" | "withheld" }> = [];
          for (const code of codes) {
            if (seen.has(code)) continue;
            seen.add(code);
            out.push({ code, state: denied.has(code) ? "withheld" : "granted" });
          }
          for (const code of denied) {
            if (!seen.has(code)) { seen.add(code); out.push({ code, state: "withheld" }); }
          }
          return out;
        };

        const grantByOrg = new Map<string, any>();
        for (const g of grantView) {
          const org = (g as any).reliance_agreements?.partner_org_name ?? "";
          const prev = grantByOrg.get(org);
          if (!prev || String(g.granted_at) > String(prev.granted_at)) grantByOrg.set(org, g);
        }
        const assessByOrg = new Map<string, any>();
        for (const a of (assessments ?? [])) {
          const org = (a as any).reliance_agreements?.partner_org_name ?? "";
          const prev = assessByOrg.get(org);
          if (!prev || String(a.decided_at) > String(prev.decided_at)) assessByOrg.set(org, a);
        }
        const partners = (links ?? []).map((l: any) => {
          const orgName = l.partner_organisations?.legal_name ?? null;
          const g = orgName ? grantByOrg.get(orgName) : undefined;
          const a = orgName ? assessByOrg.get(orgName) : undefined;
          return {
            org_name: orgName,
            org_type: l.partner_organisations?.organisation_type ?? null,
            portal_type: l.portal_type ?? null,
            link_state: l.state ?? null,
            legal_route: l.legal_route ?? null,
            grant_created_at: g?.granted_at ?? null,
            grant_expires_at: g?.expires_at ?? null,
            grant_revoked_at: g?.revoked_at ?? null,
            attestation_version: g ? (versionByAttId.get(g.attestation_id) ?? null) : null,
            last_viewed_at: g ? (lastViewByGrant.get(g.id) ?? null) : null,
            assessment_status: a?.status ?? null,
            assessment_decided_at: a?.decided_at ?? null,
            assessor_name: a?.assessor_name ?? null,
            disclosure: disclosureFor(g?.id),
          };
        });

        const reqById = new Map<string, any>((reqs ?? []).map((r: any) => [r.id, r]));
        const issuerOrg = tenant?.display_name ?? "NPC Services command centre";
        const entityDetailsTyped = await questionnairePayload(admin, caseId, "entity_details");
        const view = buildPassportView("command", {
          issuer_org: issuerOrg,
          officer_label: tenant?.mlro_contact_name ?? null,
          case: caseRow,
          attestations: attFacts,
          material_inputs_current: materialCurrent,
          open_refresh_obligations: (refreshObs ?? []).filter((r: any) => r.status === "open").length,
          personal_details: await questionnairePayload(admin, caseId, "personal_details"),
          // The entity REGISTER is canonical for particulars; the questionnaire
          // is what the client typed. Register values win where both exist.
          entity_details: (() => {
            const typed = entityDetailsTyped ?? {};
            const reg = (entityRows ?? [])[0];
            if (!reg) return Object.keys(typed).length ? typed : null;
            return {
              ...typed,
              entity_name: reg.legal_name ?? typed.entity_name,
              abn_acn: reg.acn ?? reg.abn ?? typed.abn_acn,
              registration_place: reg.jurisdiction ?? typed.registration_place,
              registered_address: reg.registered_address ?? typed.registered_address,
            };
          })(),
          documents: (docs ?? []).map((d: any) => ({
            id: d.id,
            requirement_label: reqById.get(d.requirement_id)?.label ?? null,
            requirement_code: reqById.get(d.requirement_id)?.code ?? null,
            required: reqById.get(d.requirement_id)?.required ?? null,
            status: d.status,
            created_at: d.created_at,
            version_number: d.version_number,
          })),
          transactions: txns ?? [],
          ownership,
          screening: {
            subjects: (subjects ?? []).map((s: any) => ({
              state: s.state,
              completed_at: s.adjudicated_at ?? s.last_screened_at ?? null,
              party_label: s.screened_name ?? null,
            })),
            pep_result: (pep ?? [])[0]?.result ?? null,
            pep_determined_at: (pep ?? [])[0]?.determined_at ?? null,
            list_freshness: Object.fromEntries(
              (syncs ?? []).reduce((m: Map<string, string>, s: any) => {
                if (!m.has(s.list_code)) m.set(s.list_code, s.completed_at);
                return m;
              }, new Map()),
            ),
          },
          funding: {
            sof: (sof ?? []).map((r: any) => ({ verified: r.verified, verified_at: r.verified_at })),
            sow: (sow ?? []).map((r: any) => ({ verified: r.verified, verified_at: r.verified_at })),
            edd: (edd ?? []).map((e: any) => ({ status: e.status, completed_at: e.completed_at })),
          },
          partners,
          events: events ?? [],
          client_requests: requests ?? [],
          stamp_input: {
            issuer_org: issuerOrg,
            attestations: attFacts.map((a) => ({
              version: a.version, issued_at: a.issued_at, superseded_at: a.superseded_at,
            })),
            consents: consents ?? [],
            verification_checks: checks ?? [],
            documents: (docs ?? []).map((d: any) => ({
              status: d.status, reviewed_at: d.reviewed_at, created_at: d.created_at,
            })),
            screening_subjects: (subjects ?? []).map((s: any) => ({
              state: s.state, completed_at: s.adjudicated_at ?? s.last_screened_at ?? null,
            })),
            owners: (owners ?? []).map((o: any) => ({
              verification_state: o.verification_state, verified_at: o.updated_at ?? null,
            })),

            source_of_funds: (sof ?? []).map((r: any) => ({ verified: r.verified, verified_at: r.verified_at })),
            source_of_wealth: (sow ?? []).map((r: any) => ({ verified: r.verified, verified_at: r.verified_at })),
            edd_cases: (edd ?? []).map((e: any) => ({ status: e.status, completed_at: e.completed_at })),
            grants: grantView.map((g: any) => ({
              id: g.id,
              created_at: g.granted_at,
              revoked_at: g.revoked_at,
              partner_org_name: g.reliance_agreements?.partner_org_name ?? null,
              partner_org_type: g.reliance_agreements?.partner_org_type ?? null,
              attestation_version: versionByAttId.get(g.attestation_id) ?? null,
            })),
            assessments: (assessments ?? []).map((a: any) => ({
              id: a.id, status: a.status, decided_at: a.decided_at, assessor_name: a.assessor_name,
              partner_org_name: a.reliance_agreements?.partner_org_name ?? null,
              partner_org_type: a.reliance_agreements?.partner_org_type ?? null,
            })),
            // completed_at / cancelled_at / due_at were dropped here, so the
            // stamp engine could not tell a finished refresh from an
            // outstanding one and every completed obligation still read as a
            // standing request.
            refresh_obligations: (refreshObs ?? []).map((r: any) => ({
              id: r.id, created_at: r.created_at, status: r.status,
              completed_at: r.completed_at ?? null,
              cancelled_at: r.cancelled_at ?? null,
              due_at: r.due_at ?? null,
            })),
            transactions: (txns ?? []).map((t: any) => ({
              id: t.id, status: t.status, settlement_date: t.settlement_date,
              property_address: t.property_address,
            })),
          },
        });
        return jr({ passport: view });
      }

      case "grant_access": {
        if (!isMlro) return jr({ error: "MLRO role required" }, 403);
        // Phase 9 action flag: NEW grants only — revoke_grant below is
        // deliberately ungated (revocation is a safety action).
        if (!(await flagEnabled(admin, "aml_partner_grants_write"))) {
          return jr({ error: "Issuing new reliance grants is not enabled yet for this environment.", code: "grants_write_disabled" }, 409);
        }
        const caseId = String(body.case_id ?? "");
        const agreementId = String(body.agreement_id ?? "");
        if (!caseId || !agreementId) return jr({ error: "case_id and agreement_id are required" }, 400);

        const { data: agreement } = await admin.schema("aml").from("reliance_agreements")
          .select("*").eq("id", agreementId).maybeSingle();
        if (!agreement) return jr({ error: "Agreement not found" }, 404);
        if (agreement.status !== "active") {
          return jr({ error: `Agreement is ${agreement.status}` }, 409);
        }
        // s 37A: regular review is a condition of the arrangement, so an
        // overdue review suspends NEW grants until the review is done.
        if (new Date(agreement.next_review_due).getTime() < Date.now()) {
          return jr({
            error: "This CDD arrangement's review is overdue. Review the agreement before issuing new grants.",
            code: "review_overdue",
          }, 409);
        }

        // Client consent is a precondition of disclosure (APP 6), and the
        // grant row carries the consent id so the authority is traceable.
        const { data: consent } = await admin.schema("aml").from("consents")
          .select("id, version, accepted_at").eq("case_id", caseId)
          .eq("kind", "compliance_sharing")
          .order("accepted_at", { ascending: false }).limit(1).maybeSingle();
        if (!consent) {
          return jr({
            error: "The client has not consented to sharing their completed verification. Ask them to accept the sharing consent in their portal — or the partner must approach them directly.",
            code: "sharing_consent_missing",
          }, 403);
        }

        const { data: att } = await admin.schema("aml").from("compliance_attestations")
          .select("*").eq("case_id", caseId).is("superseded_at", null)
          .order("version", { ascending: false }).limit(1).maybeSingle();
        if (!att) return jr({ error: "Issue an attestation for this case first", code: "no_attestation" }, 409);

        // Canonical partner identity (Phase 1). The organisation is resolved
        // from the STORED agreement row — a body-supplied partner_org_id is
        // never authority. With the aml_partner_identity flag on, a new
        // grant additionally requires an ACTIVE partner-case link with
        // legal_route = reliance for this exact case; with the flag off the
        // legacy behaviour is unchanged and the canonical ids are stamped
        // only when they already exist.
        const enforced = await partnerIdentityEnforced(admin);
        let partnerOrgRow: any = null;
        let linkForGrant: any = null;
        if (agreement.partner_org_id) {
          const { data: orgRow } = await admin.schema("aml").from("partner_organisations")
            .select("id, status").eq("id", agreement.partner_org_id).maybeSingle();
          partnerOrgRow = orgRow ?? null;
        }
        {
          const { data: caseRowForLink } = await admin.schema("aml").from("cases")
            .select("id, subject_type").eq("id", caseId).maybeSingle();
          const caseTenant = tenantForCase(String(caseId));
          let linkRows: any[] = [];
          if (partnerOrgRow) {
            const { data: links } = await admin.schema("aml").from("partner_case_links")
              .select("id, case_id, tenant_id, partner_org_id, legal_route, state")
              .eq("case_id", caseId).eq("partner_org_id", partnerOrgRow.id);
            linkRows = links ?? [];
          }
          const decision = evaluatePartnerLinkForReliance({
            caseId, caseTenantId: caseTenant,
            partnerOrg: partnerOrgRow, links: linkRows,
          });
          if (decision.ok) {
            linkForGrant = decision.link;
          } else if (enforced) {
            // Partner-safe code, operator-facing message. Independent CDD
            // remains available — this blocks the reliance grant only.
            return jr({ error: decision.message, code: decision.code }, 409);
          }

          // Arrangement governance (Phase 2, flag-gated). The full guard —
          // eligibility recorded, arrangement in force and in scope,
          // operative + current + suitable assessment — sits on top of the
          // legacy checks above; those stay for byte-identical behaviour
          // while the flag is off.
          if (await arrangementGovernanceEnforced(admin)) {
            const { data: assessRow } = await admin.schema("aml")
              .from("arrangement_assessments")
              .select("decision, next_due_at, status")
              .eq("agreement_id", agreementId).eq("status", "operative")
              .maybeSingle();
            const arrangementDecision = evaluateArrangementForReliance({
              arrangement: {
                id: agreement.id, status: agreement.status,
                next_review_due: agreement.next_review_due,
                eligibility_classification: agreement.eligibility_classification ?? "unassessed",
                scope_procedures: agreement.scope_procedures ?? null,
                scope_customer_types: agreement.scope_customer_types ?? null,
                effective_from: agreement.effective_from ?? null,
                expires_on: agreement.expires_on ?? null,
                partner_org_id: agreement.partner_org_id ?? null,
              },
              assessment: assessRow ?? null,
              requiredProcedure: "customer_identification",
              caseCustomerType: caseRowForLink?.subject_type ?? null,
              now: new Date(),
            });
            if (!arrangementDecision.ok) {
              return jr({ error: arrangementDecision.message, code: arrangementDecision.code }, 409);
            }
          }
        }

        // Raw token is shown exactly once; only its hash persists.
        const rawToken = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
        const grantInsert: Record<string, unknown> = {
          case_id: caseId, agreement_id: agreementId, attestation_id: att.id,
          consent_id: consent.id,
          access_token_hash: await sha256Hex(rawToken),
          granted_by: userId,
          expires_at: new Date(Date.now() + GRANT_TTL_DAYS * 864e5).toISOString(),
        };
        if (agreement.partner_org_id) grantInsert.partner_org_id = agreement.partner_org_id;
        if (linkForGrant) grantInsert.partner_case_link_id = linkForGrant.id;
        let grant: any; let grantError: any;
        {
          const first = await admin.schema("aml").from("reliance_grants")
            .insert(grantInsert).select("*").single();
          grant = first.data; grantError = first.error;
          // Contract-first deploy tolerance (same convention as aml-cases):
          // if the Phase 1 columns are not applied in this environment yet,
          // retry without them rather than failing the legacy path.
          if (grantError && /partner_org_id|partner_case_link_id/.test(String(grantError.message ?? ""))) {
            delete grantInsert.partner_org_id;
            delete grantInsert.partner_case_link_id;
            const retry = await admin.schema("aml").from("reliance_grants")
              .insert(grantInsert).select("*").single();
            grant = retry.data; grantError = retry.error;
          }
        }
        if (grantError) throw grantError;

        // v2 grants are manifest-controlled: the manifest is WHAT this
        // partner is authorised to receive from this attestation version.
        // If this insert fails the grant remains unusable for v2 reading
        // (manifest_missing at redemption) — fail closed, never open.
        if ((att.schema_version ?? 1) === 2 && await attestationV2Enabled(admin)) {
          const manifestScope = {
            allowed_attribute_codes: DEFAULT_ALLOWED_ATTRIBUTE_CODES,
            allowed_record_classes: (agreement.scope_record_classes ?? []) as string[],
            denied_classes: DEFAULT_DENIED_CLASSES,
          };
          const manifestSha = await sha256HexCanonical({
            ...manifestScope, attestation_id: att.id, grant_id: grant.id, version: 1,
          });
          const { error: manifestError } = await admin.schema("aml").from("disclosure_manifests").insert({
            attestation_id: att.id, grant_id: grant.id,
            partner_org_id: agreement.partner_org_id ?? null,
            partner_case_link_id: linkForGrant?.id ?? null,
            purpose: linkForGrant
              ? "reliance_disclosure_under_partner_case_link"
              : "reliance_disclosure",
            consent_id: consent.id,
            ...manifestScope,
            manifest_sha256: manifestSha,
            expires_at: grant.expires_at,
            created_by: userId,
          });
          if (manifestError) throw manifestError;
        }

        await appendCaseEvent(admin, caseId, "mlro_decision",
          `Reliance access granted to ${agreement.partner_org_name} (attestation v${att.version})`,
          {
            grant_id: grant.id, agreement_id: agreementId,
            consent_id: consent.id, expires_at: grant.expires_at,
            partner_org_id: agreement.partner_org_id ?? null,
            partner_case_link_id: linkForGrant?.id ?? null,
          }, userId, userEmail);

        return jr({
          grant: { id: grant.id, expires_at: grant.expires_at, attestation_version: att.version },
          access_token: rawToken,
          note: "This token is shown once. Deliver it to the partner organisation through their portal channel.",
        });
      }

      case "revoke_grant": {
        if (!isMlro) return jr({ error: "MLRO role required" }, 403);
        const reason = String(body.reason ?? "").trim();
        if (!body.grant_id) return jr({ error: "grant_id required" }, 400);
        if (reason.length < 10) return jr({ error: "reason must be at least 10 characters" }, 400);
        const { data, error } = await admin.schema("aml").from("reliance_grants").update({
          revoked_at: new Date().toISOString(), revoked_by: userId, revoke_reason: reason,
        }).eq("id", body.grant_id).is("revoked_at", null).select("*").single();
        if (error) throw error;
        await appendCaseEvent(admin, data.case_id, "mlro_decision",
          "Reliance access revoked", { grant_id: data.id, reason }, userId, userEmail);
        return jr({ grant: data });
      }

      case "list_grants": {
        if (!body.case_id) return jr({ error: "case_id required" }, 400);
        const { data, error } = await admin.schema("aml").from("reliance_grants")
          .select("id, agreement_id, attestation_id, granted_at, expires_at, revoked_at, revoke_reason, reliance_agreements:agreement_id(partner_org_name, partner_org_type, status)")
          .eq("case_id", body.case_id).order("granted_at", { ascending: false });
        if (error) throw error;
        // The token hash never leaves the database, even to staff.
        return jr({ grants: data ?? [] });
      }

      case "list_assessments": {
        if (!body.case_id) return jr({ error: "case_id required" }, 400);
        const { data, error } = await admin.schema("aml").from("independent_assessments")
          .select("*, reliance_agreements:agreement_id(partner_org_name)")
          .eq("case_id", body.case_id).order("created_at", { ascending: false });
        if (error) throw error;
        return jr({ assessments: data ?? [] });
      }

      case "list_access_log": {
        if (!body.case_id) return jr({ error: "case_id required" }, 400);
        const { data, error } = await admin.schema("aml").from("reliance_access_log")
          .select("*").eq("case_id", body.case_id)
          .order("created_at", { ascending: false }).limit(200);
        if (error) throw error;
        return jr({ access_log: data ?? [] });
      }

      /* ── canonical partner identity (Phase 1) ─────────────────────────── */
      // The organisation record is CONFIGURATION plus evidence, never a
      // legal conclusion: classification values are controlled strings an
      // authorised human records, and a reliance-capable classification is
      // impossible without recorded evidence (DB CHECK). A link is the
      // access root — creating one grants no passport and no reliance by
      // itself; grant_access still requires agreement, review currency,
      // consent and a current attestation on top.

      case "list_partner_organisations": {
        const { data, error } = await admin.schema("aml").from("partner_organisations")
          .select("*").order("legal_name", { ascending: true });
        if (error) throw error;
        return jr({ partner_organisations: data ?? [] });
      }

      case "upsert_partner_organisation": {
        if (!isMlro) return jr({ error: "MLRO role required — partner identity is outward-facing configuration" }, 403);
        const legalName = String(body.legal_name ?? "").trim();
        const orgType = String(body.organisation_type ?? "");
        if (!legalName && !body.partner_org_id) return jr({ error: "legal_name is required" }, 400);
        if (!body.partner_org_id && !PARTNER_ORG_TYPES.includes(orgType)) {
          return jr({ error: `organisation_type must be one of: ${PARTNER_ORG_TYPES.join(", ")}` }, 400);
        }
        const patch: Record<string, unknown> = {};
        if (legalName) patch.legal_name = legalName.slice(0, 300);
        if (orgType && PARTNER_ORG_TYPES.includes(orgType)) patch.organisation_type = orgType;
        if (body.trading_name !== undefined) patch.trading_name = String(body.trading_name ?? "").slice(0, 300) || null;
        if (body.abn !== undefined) patch.abn = String(body.abn ?? "").replace(/\s+/g, "").slice(0, 20) || null;
        if (body.registration_reference !== undefined) patch.registration_reference = String(body.registration_reference ?? "").slice(0, 200) || null;
        if (body.registration_country !== undefined) patch.registration_country = String(body.registration_country ?? "AU").slice(0, 2).toUpperCase();
        if (Array.isArray(body.portal_types)) {
          const portals = body.portal_types.map(String).filter((p: string) => PARTNER_PORTAL_TYPES.includes(p));
          patch.portal_types = portals;
        }
        if (body.status !== undefined) {
          const status = String(body.status);
          if (!["active", "suspended", "ended"].includes(status)) return jr({ error: "status must be active, suspended or ended" }, 400);
          patch.status = status;
        }
        // Classification fields change ONLY through classify_partner_organisation.
        if (body.partner_org_id) {
          const { data, error } = await admin.schema("aml").from("partner_organisations")
            .update(patch).eq("id", String(body.partner_org_id)).select("*").single();
          if (error) throw error;
          return jr({ partner_organisation: data });
        }
        const { data, error } = await admin.schema("aml").from("partner_organisations")
          .insert({ ...patch, created_by: userId }).select("*").single();
        if (error) {
          if (String(error.code) === "23505") {
            return jr({ error: "An active partner organisation with this ABN already exists. Use it, or end it first — organisations are never merged automatically.", code: "duplicate_abn" }, 409);
          }
          throw error;
        }
        return jr({ partner_organisation: data });
      }

      case "classify_partner_organisation": {
        if (!isMlro) return jr({ error: "MLRO role required — classification is a recorded legal determination, not a system inference" }, 403);
        const orgId = String(body.partner_org_id ?? "");
        const classification = String(body.reporting_entity_classification ?? "");
        if (!orgId) return jr({ error: "partner_org_id required" }, 400);
        if (!PARTNER_CLASSIFICATIONS.includes(classification)) {
          return jr({ error: `reporting_entity_classification must be one of: ${PARTNER_CLASSIFICATIONS.join(", ")}` }, 400);
        }
        const evidence = String(body.classification_evidence_reference ?? "").trim();
        const relianceCapable = ["eligible_relying_reporting_entity", "eligible_foreign_equivalent"].includes(classification);
        if (relianceCapable && !evidence) {
          return jr({
            error: "A reliance-capable classification requires a classification evidence reference (the legal advice / determination it rests on).",
            code: "classification_evidence_required",
          }, 400);
        }
        const { data, error } = await admin.schema("aml").from("partner_organisations").update({
          reporting_entity_classification: classification,
          classification_status: classification === "unclassified" ? "unclassified" : "classified",
          classification_evidence_reference: evidence || null,
          classification_notes: String(body.classification_notes ?? "").slice(0, 2000) || null,
          regulator_reference: String(body.regulator_reference ?? "").slice(0, 200) || null,
          verified_by: userId,
          verified_at: new Date().toISOString(),
        }).eq("id", orgId).select("*").single();
        if (error) throw error;
        return jr({ partner_organisation: data });
      }

      case "list_partner_memberships": {
        if (!body.partner_org_id) return jr({ error: "partner_org_id required" }, 400);
        const { data, error } = await admin.schema("aml").from("partner_portal_memberships")
          .select("*").eq("partner_org_id", String(body.partner_org_id))
          .order("created_at", { ascending: false });
        if (error) throw error;
        return jr({ memberships: data ?? [] });
      }

      case "upsert_partner_membership": {
        if (!isMlro) return jr({ error: "MLRO role required" }, 403);
        const orgId = String(body.partner_org_id ?? "");
        const source = String(body.portal_user_source ?? "");
        const portalUserId = String(body.portal_user_id ?? "");
        const portalType = String(body.portal_type ?? "");
        if (!orgId || !source || !portalUserId) {
          return jr({ error: "partner_org_id, portal_user_source and portal_user_id are required" }, 400);
        }
        if (!PARTNER_USER_SOURCES.includes(source)) {
          return jr({ error: `portal_user_source must be one of: ${PARTNER_USER_SOURCES.join(", ")}` }, 400);
        }
        if (!PARTNER_PORTAL_TYPES.includes(portalType)) {
          return jr({ error: `portal_type must be one of: ${PARTNER_PORTAL_TYPES.join(", ")}` }, 400);
        }
        // The portal user must actually exist in its home table — a
        // membership maps a REAL portal identity, it never mints one.
        const { data: portalUser } = await admin.from(source)
          .select("id").eq("id", portalUserId).maybeSingle();
        if (!portalUser) return jr({ error: "Portal user not found in the named portal user table" }, 404);
        const { data: org } = await admin.schema("aml").from("partner_organisations")
          .select("id, status").eq("id", orgId).maybeSingle();
        if (!org) return jr({ error: "Partner organisation not found" }, 404);
        const status = String(body.status ?? "invited");
        if (!["invited", "active", "suspended", "ended"].includes(status)) {
          return jr({ error: "status must be invited, active, suspended or ended" }, 400);
        }
        const row = {
          partner_org_id: orgId, portal_type: portalType,
          portal_user_source: source, portal_user_id: portalUserId,
          organisation_role: String(body.organisation_role ?? "member").slice(0, 100),
          compliance_role: ["compliance_officer", "operations", "read_only"].includes(String(body.compliance_role)) ? String(body.compliance_role) : null,
          status,
          activated_at: status === "active" ? new Date().toISOString() : null,
          suspended_at: status === "suspended" ? new Date().toISOString() : null,
          ended_at: status === "ended" ? new Date().toISOString() : null,
          created_by: userId,
        };
        const { data, error } = await admin.schema("aml").from("partner_portal_memberships")
          .upsert(row, { onConflict: "portal_user_source,portal_user_id,partner_org_id" })
          .select("*").single();
        if (error) throw error;
        return jr({ membership: data });
      }

      case "list_partner_case_links": {
        if (!body.case_id) return jr({ error: "case_id required" }, 400);
        const { data, error } = await admin.schema("aml").from("partner_case_links")
          .select("*, partner_organisations:partner_org_id(legal_name, organisation_type, classification_status, status)")
          .eq("case_id", String(body.case_id)).order("linked_at", { ascending: false });
        if (error) throw error;
        return jr({ links: data ?? [] });
      }

      case "link_partner_to_case": {
        // Creating an access root is a reviewer/MLRO act. It grants nothing
        // by itself: no passport, no reliance, no data flow.
        if (!(isMlro || roles.has("reviewer"))) {
          return jr({ error: "Reviewer or MLRO role required" }, 403);
        }
        const caseId = String(body.case_id ?? "");
        const orgId = String(body.partner_org_id ?? "");
        const portalType = String(body.portal_type ?? "");
        const relationshipRole = String(body.relationship_role ?? "").trim();
        const legalRoute = String(body.legal_route ?? "");
        const purpose = String(body.purpose ?? "").trim();
        if (!caseId || !orgId) return jr({ error: "case_id and partner_org_id are required" }, 400);
        if (![...PARTNER_PORTAL_TYPES, "other"].includes(portalType)) {
          return jr({ error: `portal_type must be one of: ${[...PARTNER_PORTAL_TYPES, "other"].join(", ")}` }, 400);
        }
        if (!relationshipRole) return jr({ error: "relationship_role is required" }, 400);
        if (!(LEGAL_ROUTES as readonly string[]).includes(legalRoute)) {
          return jr({ error: `legal_route must be one of: ${LEGAL_ROUTES.join(", ")} — the route is a recorded legal decision, never inferred from portal type` }, 400);
        }
        if (purpose.length < 10) return jr({ error: "purpose must be at least 10 characters — record why this organisation may access this matter" }, 400);

        const { data: caseRow } = await admin.schema("aml").from("cases")
          .select("id, client_id, purchase_file_id").eq("id", caseId).maybeSingle();
        if (!caseRow) return jr({ error: "Case not found" }, 404);
        const { data: org } = await admin.schema("aml").from("partner_organisations")
          .select("id, status, legal_name").eq("id", orgId).maybeSingle();
        if (!org) return jr({ error: "Partner organisation not found" }, 404);
        if (org.status !== "active") return jr({ error: `Partner organisation is ${org.status}` }, 409);

        // Deal-context validation: a supplied purchase file must belong to
        // this case's client and not contradict the case's own binding
        // (same rule as aml-finance import_from_purchase_file).
        const pfId = body.purchase_file_id ? String(body.purchase_file_id) : null;
        if (pfId) {
          const { data: pf } = await admin.from("purchase_files")
            .select("id, client_id").eq("id", pfId).maybeSingle();
          if (!pf) return jr({ error: "Purchase file not found" }, 404);
          if (caseRow.client_id && String(pf.client_id) !== String(caseRow.client_id)) {
            return jr({ error: "Purchase file is not linked to this AML case client" }, 403);
          }
          if (caseRow.purchase_file_id && String(caseRow.purchase_file_id) !== pfId) {
            return jr({ error: "Purchase file is not the one linked to this AML case" }, 403);
          }
        }
        const matterId = body.legal_matter_id ? String(body.legal_matter_id) : null;
        if (matterId) {
          const { data: matter } = await admin.from("legal_matters")
            .select("id").eq("id", matterId).maybeSingle();
          if (!matter) return jr({ error: "Legal matter not found" }, 404);
        }

        const { data: link, error } = await admin.schema("aml").from("partner_case_links").insert({
          tenant_id: tenantForCase(String(caseRow.id)),
          case_id: caseId,
          client_id: caseRow.client_id ?? null,
          purchase_file_id: pfId,
          legal_matter_id: matterId,
          partner_org_id: orgId,
          portal_type: portalType,
          relationship_role: relationshipRole.slice(0, 100),
          legal_route: legalRoute,
          purpose: purpose.slice(0, 2000),
          linked_by: userId,
        }).select("*").single();
        if (error) {
          if (String(error.code) === "23505") {
            return jr({ error: "An active link already exists for this partner and role on this case." , code: "link_exists" }, 409);
          }
          throw error;
        }
        await appendCaseEvent(admin, caseId, "system",
          `Partner linked: ${org.legal_name} (${legalRoute.replace(/_/g, " ")})`,
          {
            partner_case_link_id: link.id, partner_org_id: orgId,
            portal_type: portalType, relationship_role: relationshipRole,
            legal_route: legalRoute,
            note: "A link is an access root only. No passport, reliance or disclosure follows from it by itself.",
          }, userId, userEmail);
        return jr({ link });
      }

      case "set_partner_case_link_state": {
        if (!(isMlro || roles.has("reviewer"))) {
          return jr({ error: "Reviewer or MLRO role required" }, 403);
        }
        const linkId = String(body.link_id ?? "");
        const state = String(body.state ?? "");
        if (!linkId) return jr({ error: "link_id required" }, 400);
        if (!["suspended", "ended", "active"].includes(state)) {
          return jr({ error: "state must be active, suspended or ended" }, 400);
        }
        const endReason = body.end_reason_code ? String(body.end_reason_code) : null;
        if (state === "ended" && !["completed", "withdrawn", "superseded", "client_declined", "other"].includes(endReason ?? "")) {
          return jr({ error: "end_reason_code must be completed, withdrawn, superseded, client_declined or other" }, 400);
        }
        const patch: Record<string, unknown> = { state };
        const nowIso = new Date().toISOString();
        if (state === "suspended") { patch.suspended_at = nowIso; patch.suspended_by = userId; }
        if (state === "ended") { patch.ended_at = nowIso; patch.ended_by = userId; patch.end_reason_code = endReason; }
        if (state === "active") { patch.suspended_at = null; patch.suspended_by = null; }
        const { data: link, error } = await admin.schema("aml").from("partner_case_links")
          .update(patch).eq("id", linkId).select("*").single();
        if (error) throw error;
        await appendCaseEvent(admin, link.case_id, "system",
          `Partner link ${state}${endReason ? ` (${endReason})` : ""}`,
          { partner_case_link_id: link.id, partner_org_id: link.partner_org_id, state, end_reason_code: endReason },
          userId, userEmail);
        return jr({ link });
      }

      case "list_partner_mappings": {
        const { data, error } = await admin.schema("aml").from("partner_org_name_mappings")
          .select("*").order("created_at", { ascending: true });
        if (error) throw error;
        return jr({ mappings: data ?? [] });
      }

      case "resolve_partner_mapping": {
        if (!isMlro) return jr({ error: "MLRO role required — mapping a legal identity is a reviewed decision" }, 403);
        const mappingId = String(body.mapping_id ?? "");
        const action = String(body.action ?? "map");
        if (!mappingId) return jr({ error: "mapping_id required" }, 400);
        const { data: mapping } = await admin.schema("aml").from("partner_org_name_mappings")
          .select("*").eq("id", mappingId).maybeSingle();
        if (!mapping) return jr({ error: "Mapping not found" }, 404);
        if (mapping.status !== "pending") return jr({ error: `Mapping already ${mapping.status}` }, 409);

        if (action === "reject") {
          const { data, error } = await admin.schema("aml").from("partner_org_name_mappings").update({
            status: "rejected", mapped_by: userId, mapped_at: new Date().toISOString(),
            note: String(body.note ?? "").slice(0, 2000) || null,
          }).eq("id", mappingId).select("*").single();
          if (error) throw error;
          return jr({ mapping: data });
        }

        const orgId = String(body.partner_org_id ?? "");
        if (!orgId) return jr({ error: "partner_org_id required to map" }, 400);
        const { data: org } = await admin.schema("aml").from("partner_organisations")
          .select("id, status, organisation_type, legal_name").eq("id", orgId).maybeSingle();
        if (!org) return jr({ error: "Partner organisation not found" }, 404);
        // Exact review, no fuzzy tolerance: an org-type mismatch between the
        // historical agreement and the canonical record must be resolved by
        // fixing one of them, not waved through.
        if (org.organisation_type !== mapping.original_org_type) {
          return jr({
            error: `Type mismatch: agreement recorded "${mapping.original_org_type}" but the organisation is "${org.organisation_type}". Correct whichever record is wrong, then map.`,
            code: "mapping_type_mismatch",
          }, 409);
        }
        const nowIso = new Date().toISOString();
        const { data: updatedMapping, error: mapErr } = await admin.schema("aml")
          .from("partner_org_name_mappings").update({
            status: "mapped", proposed_partner_org_id: orgId,
            mapped_by: userId, mapped_at: nowIso,
            note: String(body.note ?? "").slice(0, 2000) || null,
          }).eq("id", mappingId).select("*").single();
        if (mapErr) throw mapErr;
        const { error: agErr } = await admin.schema("aml").from("reliance_agreements")
          .update({ partner_org_id: orgId, updated_at: nowIso })
          .eq("id", mapping.agreement_id);
        if (agErr) throw agErr;
        return jr({ mapping: updatedMapping });
      }

      /* ── arrangement governance (Phase 2) ─────────────────────────────── */
      // The assessment history is immutable: re-assessment supersedes, it
      // never edits. Eligibility is a recorded determination with its own
      // preconditions — the system never concludes that an organisation is
      // legally eligible, it records that an authorised human did.

      case "list_arrangement_assessments": {
        if (!body.agreement_id) return jr({ error: "agreement_id required" }, 400);
        const { data, error } = await admin.schema("aml").from("arrangement_assessments")
          .select("*").eq("agreement_id", String(body.agreement_id))
          .order("assessment_version", { ascending: false });
        if (error) throw error;
        return jr({ assessments: data ?? [] });
      }

      case "record_arrangement_assessment": {
        if (!isMlro) return jr({ error: "MLRO role required — an arrangement assessment is a governance decision" }, 403);
        const agreementId = String(body.agreement_id ?? "");
        const trigger = String(body.trigger ?? "");
        const decision = String(body.decision ?? "");
        const nextDue = String(body.next_due_at ?? "");
        const findings = String(body.findings ?? "").trim();
        if (!agreementId) return jr({ error: "agreement_id required" }, 400);
        if (!["initial", "scheduled", "significant_change", "incident", "other"].includes(trigger)) {
          return jr({ error: "trigger must be initial, scheduled, significant_change, incident or other" }, 400);
        }
        if (!["suitable", "suitable_with_conditions", "unsuitable"].includes(decision)) {
          return jr({ error: "decision must be suitable, suitable_with_conditions or unsuitable" }, 400);
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDue)) {
          return jr({ error: "next_due_at must be YYYY-MM-DD — regular review is a statutory condition" }, 400);
        }
        if (decision !== "suitable" && findings.length < 10) {
          return jr({ error: "findings of at least 10 characters are required when the decision is not plainly suitable" }, 400);
        }
        const { data: agreement } = await admin.schema("aml").from("reliance_agreements")
          .select("id").eq("id", agreementId).maybeSingle();
        if (!agreement) return jr({ error: "Agreement not found" }, 404);

        const { data: last } = await admin.schema("aml").from("arrangement_assessments")
          .select("id, assessment_version, status").eq("agreement_id", agreementId)
          .order("assessment_version", { ascending: false }).limit(1).maybeSingle();
        const version = (last?.assessment_version ?? 0) + 1;
        // Supersede-then-insert keeps the one-operative-per-agreement
        // invariant. If the insert fails after the supersede, the agreement
        // has NO operative assessment — which fails closed, never open.
        if (last && last.status === "operative") {
          await admin.schema("aml").from("arrangement_assessments")
            .update({ status: "superseded", superseded_at: new Date().toISOString() })
            .eq("id", last.id);
        }
        const conditions = String(body.conditions ?? "").trim();
        const evidence = Array.isArray(body.evidence_references)
          ? body.evidence_references.map((e: unknown) => String(e).slice(0, 500)).slice(0, 50)
          : [];
        const { data: assessment, error } = await admin.schema("aml")
          .from("arrangement_assessments").insert({
            agreement_id: agreementId, assessment_version: version,
            assessed_by: userId, assessed_by_label: userEmail,
            trigger, decision,
            findings: findings.slice(0, 4000) || null,
            conditions: conditions.slice(0, 4000) || null,
            evidence_references: evidence,
            next_due_at: nextDue,
          }).select("*").single();
        if (error) throw error;
        if (last && last.status === "operative") {
          await admin.schema("aml").from("arrangement_assessments")
            .update({ superseded_by_id: assessment.id }).eq("id", last.id);
        }
        await admin.schema("aml").from("reliance_agreements")
          .update({ current_assessment_id: assessment.id, updated_at: new Date().toISOString() })
          .eq("id", agreementId);
        return jr({ assessment });
      }

      case "update_agreement_scope": {
        if (!isMlro) return jr({ error: "MLRO role required" }, 403);
        const agreementId = String(body.agreement_id ?? "");
        if (!agreementId) return jr({ error: "agreement_id required" }, 400);
        const { data: agreement } = await admin.schema("aml").from("reliance_agreements")
          .select("*").eq("id", agreementId).maybeSingle();
        if (!agreement) return jr({ error: "Agreement not found" }, 404);

        const patch: Record<string, unknown> = {};
        const strArray = (v: unknown) =>
          Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 50) : null;
        if (body.scope_customer_types !== undefined) patch.scope_customer_types = strArray(body.scope_customer_types);
        if (body.scope_procedures !== undefined) patch.scope_procedures = strArray(body.scope_procedures);
        if (body.scope_record_classes !== undefined) patch.scope_record_classes = strArray(body.scope_record_classes);
        if (body.record_availability_sla_hours !== undefined) {
          const sla = Number(body.record_availability_sla_hours);
          patch.record_availability_sla_hours = Number.isFinite(sla) && sla > 0 ? Math.round(sla) : null;
        }
        if (body.jurisdiction !== undefined) patch.jurisdiction = String(body.jurisdiction ?? "").slice(0, 100) || null;
        if (body.cross_border_terms !== undefined) patch.cross_border_terms = String(body.cross_border_terms ?? "").slice(0, 2000) || null;
        if (body.executed_document_reference !== undefined) patch.executed_document_reference = String(body.executed_document_reference ?? "").slice(0, 300) || null;
        if (body.effective_from !== undefined) {
          const d = String(body.effective_from ?? "");
          if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return jr({ error: "effective_from must be YYYY-MM-DD" }, 400);
          patch.effective_from = d || null;
        }
        if (body.expires_on !== undefined) {
          const d = String(body.expires_on ?? "");
          if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return jr({ error: "expires_on must be YYYY-MM-DD" }, 400);
          patch.expires_on = d || null;
        }
        if (body.eligibility_classification !== undefined) {
          const cls = String(body.eligibility_classification ?? "");
          if (!["unassessed", "eligible_reporting_entity", "eligible_foreign_equivalent", "not_eligible"].includes(cls)) {
            return jr({ error: "eligibility_classification must be unassessed, eligible_reporting_entity, eligible_foreign_equivalent or not_eligible" }, 400);
          }
          // An eligible determination on the ARRANGEMENT presupposes an
          // eligible-classified canonical PARTNER — the two records must
          // agree, and neither is ever guessed.
          if (cls === "eligible_reporting_entity" || cls === "eligible_foreign_equivalent") {
            if (!agreement.partner_org_id) {
              return jr({
                error: "Map this agreement to a canonical partner organisation before recording an eligible determination.",
                code: "partner_org_unresolved",
              }, 409);
            }
            const { data: org } = await admin.schema("aml").from("partner_organisations")
              .select("reporting_entity_classification").eq("id", agreement.partner_org_id).maybeSingle();
            const orgCls = org?.reporting_entity_classification ?? "unclassified";
            if (!["eligible_relying_reporting_entity", "eligible_foreign_equivalent"].includes(orgCls)) {
              return jr({
                error: "The canonical partner organisation is not classified as reliance-capable. Record the partner classification (with evidence) first.",
                code: "partner_classification_required",
              }, 409);
            }
          }
          patch.eligibility_classification = cls;
        }
        if (Object.keys(patch).length === 0) return jr({ error: "No recognised fields to update" }, 400);
        patch.agreement_version = (agreement.agreement_version ?? 1) + 1;
        patch.updated_at = new Date().toISOString();
        const { data, error } = await admin.schema("aml").from("reliance_agreements")
          .update(patch).eq("id", agreementId).select("*").single();
        if (error) throw error;
        return jr({ agreement: data });
      }

      /* ── partner workspace: Command Center support (Phase 4) ──────────── */
      // Origin review of controlled records requests and the delivery read
      // model. Requests never auto-approve; delivering restricted classes
      // is an MLRO decision; the response message is partner-safe wording
      // authored by staff, never internal notes.

      case "staff_list_partner_records_requests": {
        if (!body.case_id) return jr({ error: "case_id required" }, 400);
        const [{ data: requests, error: reqErr }, { data: deliveries }] = await Promise.all([
          admin.schema("aml").from("partner_records_requests")
            .select("*, partner_organisations:partner_org_id(legal_name, organisation_type)")
            .eq("case_id", String(body.case_id)).order("requested_at", { ascending: false }).limit(100),
          admin.schema("aml").from("partner_evidence_deliveries")
            .select("*").eq("case_id", String(body.case_id))
            .order("delivered_at", { ascending: false }).limit(200),
        ]);
        if (reqErr) throw reqErr;
        return jr({ requests: requests ?? [], deliveries: deliveries ?? [] });
      }

      case "review_partner_records_request": {
        if (!isMlro) return jr({ error: "MLRO role required — releasing CDD records to a partner is a restricted disclosure decision" }, 403);
        const requestId = String(body.request_id ?? "");
        const decision = String(body.decision ?? "");
        if (!requestId) return jr({ error: "request_id required" }, 400);
        if (!["under_review", "approved", "partly_approved", "denied"].includes(decision)) {
          return jr({ error: "decision must be under_review, approved, partly_approved or denied" }, 400);
        }
        const { data: request } = await admin.schema("aml").from("partner_records_requests")
          .select("*").eq("id", requestId).maybeSingle();
        if (!request) return jr({ error: "Request not found" }, 404);
        if (!["submitted", "under_review"].includes(request.status)) {
          return jr({ error: `Request is already ${request.status}` }, 409);
        }
        const responseMessage = String(body.response_message ?? "").trim();
        const patch: Record<string, unknown> = { status: decision };
        if (decision !== "under_review") {
          const requested: string[] = request.requested_record_codes ?? [];
          const approved: string[] = Array.isArray(body.approved_record_codes)
            ? [...new Set<string>((body.approved_record_codes as unknown[]).map((c) => String(c)))]
              .filter((c) => requested.includes(c))
            : [];
          if (decision === "approved" && approved.length !== requested.length) {
            return jr({ error: "Full approval must approve every requested code — otherwise use partly_approved." }, 400);
          }
          if (decision === "partly_approved" && (approved.length === 0 || approved.length === requested.length)) {
            return jr({ error: "Partial approval needs a non-empty strict subset of the requested codes." }, 400);
          }
          if (decision === "denied" && approved.length > 0) {
            return jr({ error: "A denial approves nothing." }, 400);
          }
          if (responseMessage.length < 10) {
            return jr({ error: "response_message of at least 10 characters is required — it is the partner-safe explanation of the decision" }, 400);
          }
          patch.approved_record_codes = decision === "denied" ? [] : approved;
          patch.denied_record_codes = requested.filter((c) => !(patch.approved_record_codes as string[]).includes(c));
          patch.origin_response_message = responseMessage.slice(0, 2000);
          patch.reviewed_by = userId;
          patch.reviewed_by_label = userEmail;
          patch.reviewed_at = new Date().toISOString();
        }
        const { data: updated, error } = await admin.schema("aml").from("partner_records_requests")
          .update(patch).eq("id", requestId).select("*").single();
        if (error) throw error;
        await appendCaseEvent(admin, request.case_id, "mlro_decision",
          `Partner records request ${decision.replace(/_/g, " ")}`,
          {
            partner_records_request_id: requestId, decision,
            approved_record_codes: (patch.approved_record_codes as string[]) ?? null,
          }, userId, userEmail);
        return jr({ request: updated });
      }

      case "record_partner_evidence_delivery": {
        if (!isMlro) return jr({ error: "MLRO role required" }, 403);
        // Phase 9 action flag: same flag as partner object access — one
        // capability, one switch.
        if (!(await flagEnabled(admin, "aml_partner_evidence_delivery_write"))) {
          return jr({ error: "Evidence delivery is not enabled yet for this environment.", code: "evidence_delivery_write_disabled" }, 409);
        }
        const requestId = String(body.request_id ?? "");
        const recordCode = String(body.record_code ?? "");
        const safeLabel = String(body.safe_label ?? "").trim();
        if (!requestId || !recordCode || !safeLabel) {
          return jr({ error: "request_id, record_code and safe_label are required" }, 400);
        }
        const { data: request } = await admin.schema("aml").from("partner_records_requests")
          .select("*").eq("id", requestId).maybeSingle();
        if (!request) return jr({ error: "Request not found" }, 404);
        if (!["approved", "partly_approved", "delivered"].includes(request.status)) {
          return jr({ error: "Only an approved request can receive a delivery." }, 409);
        }
        if (!(request.approved_record_codes ?? []).includes(recordCode)) {
          return jr({ error: "That record code was not approved on this request." }, 403);
        }
        const days = Math.min(Math.max(Number(body.expires_days ?? 14) || 14, 1), 90);
        // Stage B: a delivery may carry an OPAQUE reference to the accepted
        // evidence document that backs it. Validated against the request's
        // own case — a document from another case can never be attached.
        let evidenceDocumentId: string | null = null;
        if (body.evidence_document_id) {
          const { data: doc } = await admin.schema("aml").from("documents")
            .select("id, case_id, status").eq("id", String(body.evidence_document_id)).maybeSingle();
          if (!doc) return jr({ error: "Evidence document not found." }, 404);
          if (doc.case_id !== request.case_id) {
            return jr({ error: "That document belongs to a different case.", code: "evidence_case_mismatch" }, 403);
          }
          if (doc.status !== "accepted") {
            return jr({ error: "Only an accepted (reviewed) document can back a delivery.", code: "evidence_not_accepted" }, 409);
          }
          evidenceDocumentId = doc.id;
        }
        const { data: delivery, error } = await admin.schema("aml").from("partner_evidence_deliveries").insert({
          request_id: requestId,
          case_id: request.case_id,
          partner_case_link_id: request.partner_case_link_id,
          partner_org_id: request.partner_org_id,
          record_code: recordCode,
          safe_label: safeLabel.slice(0, 300),
          delivered_sha256: String(body.delivered_sha256 ?? "").slice(0, 64) || null,
          evidence_document_id: evidenceDocumentId,
          delivered_by: userId,
          delivered_by_label: userEmail,
          expires_at: new Date(Date.now() + days * 864e5).toISOString(),
        }).select("*").single();
        if (error) throw error;

        // Once every approved code has at least one live delivery, the
        // request itself reads delivered.
        const { data: allDeliveries } = await admin.schema("aml").from("partner_evidence_deliveries")
          .select("record_code").eq("request_id", requestId).is("revoked_at", null);
        const deliveredCodes = new Set((allDeliveries ?? []).map((d: any) => d.record_code));
        if ((request.approved_record_codes ?? []).every((c: string) => deliveredCodes.has(c))) {
          await admin.schema("aml").from("partner_records_requests")
            .update({ status: "delivered" }).eq("id", requestId);
        }
        await appendCaseEvent(admin, request.case_id, "mlro_decision",
          `Evidence delivery recorded: ${safeLabel}`,
          {
            partner_records_request_id: requestId, delivery_id: delivery.id,
            record_code: recordCode, expires_at: delivery.expires_at,
          }, userId, userEmail);
        return jr({ delivery });
      }

      /* ── reliable events, invalidation and refresh (Phase 6) ──────────── */

      case "apply_material_change": {
        // Central material-change invalidation (§6.5). The evaluator
        // recomputes the Phase 3 material-input hash from live case data and
        // compares it, group by group, with the inputs reconstructed from
        // the stored v2 payload. Presentation-only changes cannot register.
        // Consequences apply in ONE database transaction
        // (aml.apply_partner_material_change); the origin service gate,
        // risk assessment and case outcome are never touched.
        if (!isMlro) return jr({ error: "MLRO role required — invalidation changes what partners may rely on" }, 403);
        if (!(await flagEnabled(admin, "aml_partner_event_outbox"))) {
          return jr({
            error: "Material-change invalidation is part of the partner event outbox, which is not enabled.",
            code: "events_disabled",
          }, 409);
        }
        const caseId = String(body.case_id ?? "");
        if (!caseId) return jr({ error: "case_id required" }, 400);
        const mode = body.mode === "revoke" ? "revoke" : "refresh";
        const { data: caseRow } = await admin.schema("aml").from("cases")
          .select("*").eq("id", caseId).maybeSingle();
        if (!caseRow) return jr({ error: "Case not found" }, 404);
        const { data: att } = await admin.schema("aml").from("compliance_attestations")
          .select("*").eq("case_id", caseId).is("superseded_at", null)
          .order("version", { ascending: false }).limit(1).maybeSingle();
        if (!att) return jr({ error: "No current attestation on this case." }, 404);
        if ((att.schema_version ?? 1) !== 2 || !att.material_input_hash) {
          return jr({
            error: "Material-change invalidation requires a v2 attestation with a material-input hash. Re-issue under aml_attestation_v2 first.",
            code: "attestation_v2_required",
          }, 409);
        }

        const payload = await buildAttestationPayload(admin, caseRow);
        const { data: gateDecision } = await admin.schema("aml").from("service_gate_decisions")
          .select("id").eq("case_id", caseId)
          .in("status", ["approved", "approved_with_controls"])
          .order("created_at", { ascending: false }).limit(1).maybeSingle();
        const nextInputs = materialInputsFromV2Payload(
          toV2Payload(payload as Record<string, unknown>),
          gateDecision?.id ?? att.service_gate_decision_id ?? null);
        const previousInputs = materialInputsFromV2Payload(
          att.payload, att.service_gate_decision_id ?? null);
        const evaluation = await evaluateMaterialChange(previousInputs, nextInputs);

        if (!evaluation.material) {
          return jr({
            material: false, changed_groups: [],
            message: "No material change: the current attestation's inputs are unchanged. Nothing was invalidated.",
          });
        }

        const { data: applied, error } = await admin.schema("aml").rpc("apply_partner_material_change", {
          _case_id: caseId,
          _attestation_id: att.id,
          _new_material_hash: evaluation.next_hash,
          _changed_groups: evaluation.changed_groups,
          _safe_reason_code: evaluation.safe_reason_code,
          _mode: mode,
          _actor_user_id: userId,
        });
        if (error) throw error;

        await appendCaseEvent(admin, caseId, "mlro_decision",
          `Material change recorded — attestation v${att.version} flagged for refresh`,
          {
            attestation_id: att.id,
            changed_groups: evaluation.changed_groups,
            mode,
            summary: applied,
            note: "Partner-facing surfaces stop serving the flagged content and receive safe refresh wording only. The service gate, risk assessment and case outcome are unchanged by this action.",
          }, userId, userEmail);
        return jr({ material: true, changed_groups: evaluation.changed_groups, applied });
      }

      case "staff_list_refresh_obligations": {
        const q = admin.schema("aml").from("partner_refresh_obligations")
          .select("*, partner_organisations:partner_org_id(legal_name)")
          .order("created_at", { ascending: false }).limit(200);
        if (body.case_id) q.eq("case_id", String(body.case_id));
        if (body.status) q.eq("status", String(body.status));
        const { data, error } = await q;
        if (error) throw error;
        return jr({ obligations: data ?? [] });
      }

      case "get_partner_events_health": {
        // Narrow Phase 6 ops visibility (§6.8). Every figure is read live
        // from the database, and the underlying rows travel with the counts
        // so the card can show the filtered records themselves. Flag state
        // is reported as recorded configuration — nothing here claims the
        // worker is deployed or scheduled.
        const nowIso = new Date().toISOString();
        const [flagOn, pending, retrying, dead, obligations, flaggedAttestations, agreementsDue] = await Promise.all([
          flagEnabled(admin, "aml_partner_event_outbox"),
          admin.from("integration_outbox")
            .select("id, event_type, occurred_at, attempts, last_error", { count: "exact" })
            .like("event_type", "aml.%").is("processed_at", null)
            .order("occurred_at", { ascending: true }).limit(20),
          admin.from("integration_outbox")
            .select("id", { count: "exact", head: true })
            .like("event_type", "aml.%").is("processed_at", null).gt("attempts", 0),
          admin.from("integration_dead_letters")
            .select("id, event_type, failed_at, attempts", { count: "exact" })
            .like("event_type", "aml.%").is("replayed_at", null)
            .order("failed_at", { ascending: false }).limit(20),
          admin.schema("aml").from("partner_refresh_obligations")
            .select("id, case_id, partner_case_link_id, safe_reason_code, required_action, status, due_at, created_at", { count: "exact" })
            .eq("status", "open").order("created_at", { ascending: true }).limit(20),
          admin.schema("aml").from("compliance_attestations")
            .select("id, case_id, version, refresh_required_at", { count: "exact" })
            .not("refresh_required_at", "is", null).is("superseded_at", null)
            .order("refresh_required_at", { ascending: true }).limit(20),
          admin.schema("aml").from("reliance_agreements")
            .select("id, partner_org_name, next_review_due", { count: "exact" })
            .eq("status", "active")
            .lte("next_review_due", new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10))
            .order("next_review_due", { ascending: true }).limit(20),
        ]);
        const overdueObligations = (obligations.data ?? [])
          .filter((o: any) => o.due_at && o.due_at < nowIso).length;
        return jr({
          health: {
            outbox_enabled: flagOn,
            pending_count: pending.count ?? 0,
            retrying_count: retrying.count ?? 0,
            dead_letter_count: dead.count ?? 0,
            oldest_pending_at: pending.data?.[0]?.occurred_at ?? null,
            open_obligation_count: obligations.count ?? 0,
            overdue_obligation_count: overdueObligations,
            refresh_required_attestation_count: flaggedAttestations.count ?? 0,
            arrangement_reviews_due_count: agreementsDue.count ?? 0,
            pending_events: pending.data ?? [],
            dead_letters: dead.data ?? [],
            open_obligations: obligations.data ?? [],
            refresh_required_attestations: flaggedAttestations.data ?? [],
            arrangement_reviews_due: agreementsDue.data ?? [],
            generated_at: nowIso,
          },
        });
      }

      /* ── operations, reporting and readiness (Phase 8) ────────────────── */

      case "get_partner_operations_dashboard": {
        // Compliance queues over the partner domain. Every count carries the
        // register + filter it deep-links into, so the number always leads
        // to the records behind it. Restricted queues are OMITTED for
        // callers without the capability — never zeroed or placeholdered.
        if (!(await flagEnabled(admin, "aml_partner_operations_reporting"))) {
          return jr({ error: "Partner operations reporting is not enabled.", code: "operations_disabled" }, 409);
        }
        const caps: OperationsCapabilities = {
          view: true,
          investigate: isMlro || roles.has("reviewer") || roles.has("analyst"),
          mlro: isMlro,
        };
        const now = new Date();
        const nowIso = now.toISOString();
        const soonIso = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
        const todayIso = nowIso.slice(0, 10);
        const staleIso = new Date(Date.now() - 7 * 864e5).toISOString();

        const oldest = (rows: any[] | null, col: string) =>
          rows && rows.length > 0 ? rows[0][col] ?? null : null;
        const q = async (builder: any, col: string): Promise<QueueCount> => {
          const { data, count } = await builder;
          return { count: count ?? 0, oldestAt: oldest(data, col) };
        };

        const [pendingRequests, awaitingDelivery, openObligations, dueArrangements,
          overdueArrangements, unclassified, awaitingApproval, failedItems,
          retrying, deadLetters, staleSyncs] = await Promise.all([
          q(admin.schema("aml").from("partner_records_requests")
            .select("requested_at", { count: "exact" }).in("status", ["submitted", "under_review"])
            .order("requested_at", { ascending: true }).limit(1), "requested_at"),
          q(admin.schema("aml").from("partner_records_requests")
            .select("reviewed_at", { count: "exact" }).in("status", ["approved", "partly_approved"])
            .order("reviewed_at", { ascending: true }).limit(1), "reviewed_at"),
          q(admin.schema("aml").from("partner_refresh_obligations")
            .select("created_at", { count: "exact" }).eq("status", "open")
            .order("created_at", { ascending: true }).limit(1), "created_at"),
          q(admin.schema("aml").from("reliance_agreements")
            .select("next_review_due", { count: "exact" }).eq("status", "active")
            .gte("next_review_due", todayIso).lte("next_review_due", soonIso)
            .order("next_review_due", { ascending: true }).limit(1), "next_review_due"),
          q(admin.schema("aml").from("reliance_agreements")
            .select("next_review_due", { count: "exact" }).eq("status", "active")
            .lt("next_review_due", todayIso)
            .order("next_review_due", { ascending: true }).limit(1), "next_review_due"),
          q(admin.schema("aml").from("partner_organisations")
            .select("created_at", { count: "exact" })
            .in("classification_status", ["unclassified", "pending_review"]).eq("status", "active")
            .order("created_at", { ascending: true }).limit(1), "created_at"),
          q(admin.schema("aml").from("retention_scans")
            .select("created_at", { count: "exact" }).eq("status", "awaiting_approval")
            .order("created_at", { ascending: true }).limit(1), "created_at"),
          q(admin.schema("aml").from("retention_scan_items")
            .select("processed_at", { count: "exact" }).eq("disposition", "failed")
            .order("processed_at", { ascending: true }).limit(1), "processed_at"),
          q(admin.from("integration_outbox")
            .select("occurred_at", { count: "exact" }).like("event_type", "aml.%")
            .is("processed_at", null).gt("attempts", 0)
            .order("occurred_at", { ascending: true }).limit(1), "occurred_at"),
          q(admin.from("integration_dead_letters")
            .select("failed_at", { count: "exact" }).like("event_type", "aml.%")
            .is("replayed_at", null).order("failed_at", { ascending: true }).limit(1), "failed_at"),
          q(admin.schema("aml").from("sanctions_list_syncs")
            .select("completed_at", { count: "exact" }).eq("status", "succeeded")
            .lt("completed_at", staleIso).order("completed_at", { ascending: true }).limit(1), "completed_at"),
        ]);

        // Determinations outstanding: open obligations requiring
        // re-determination are the partner-owned follow-up we can count
        // reliably; the same rows back both partner-owned queues.
        const counts: Record<string, QueueCount> = {
          partner_records_requests_pending: pendingRequests,
          evidence_delivery_approval: awaitingDelivery,
          partner_determination_pending: openObligations,
          partner_refresh_required: openObligations,
          arrangement_assessment_due: dueArrangements,
          arrangement_assessment_overdue: overdueArrangements,
          partner_classification_pending: unclassified,
          retention_approval: awaitingApproval,
          disposal_failure: failedItems,
          outbox_retry: retrying,
          outbox_failed: deadLetters,
          sanctions_freshness: staleSyncs,
        };

        const { data: targetRows } = await admin.schema("aml").from("partner_sla_targets")
          .select("queue_key, warn_hours, escalate_hours").eq("active", true);
        const targets: Record<string, SlaTarget> = { ...DEFAULT_SLA_TARGETS };
        for (const t of targetRows ?? []) {
          targets[t.queue_key] = { warnHours: t.warn_hours, escalateHours: t.escalate_hours };
        }

        return jr({
          queues: buildQueueSummary(counts, caps, targets, now),
          sla_note: SLA_TARGET_NOTE,
          generated_at: nowIso,
        });
      }

      case "list_partner_register": {
        // Filtered operational registers. Capability boundaries come from
        // the shared register catalogue; a register the caller may not see
        // answers 403, and every result set is the same one the queue counts
        // were computed from (same filters), so deep-links reproduce it.
        if (!(await flagEnabled(admin, "aml_partner_operations_reporting"))) {
          return jr({ error: "Partner operations reporting is not enabled.", code: "operations_disabled" }, 409);
        }
        const caps: OperationsCapabilities = {
          view: true,
          investigate: isMlro || roles.has("reviewer") || roles.has("analyst"),
          mlro: isMlro,
        };
        const register = String(body.register ?? "");
        if (!REGISTER_DEFS[register]) return jr({ error: "Unknown register" }, 400);
        if (!registerAllowed(register, caps)) {
          return jr({ error: "This register requires a capability your role does not hold.", code: "capability_required" }, 403);
        }
        const status = String(body.status ?? "");
        const limit = Math.min(Number(body.limit ?? 100) || 100, 200);
        const nowIso = new Date().toISOString();
        const todayIso = nowIso.slice(0, 10);
        const soonIso = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
        const aml = admin.schema("aml");

        let rows: any[] = [];
        if (register === "partner_organisations") {
          let qb = aml.from("partner_organisations")
            .select("id, legal_name, organisation_type, reporting_entity_classification, classification_status, status, created_at")
            .order("created_at", { ascending: true }).limit(limit);
          if (status === "unclassified") qb = qb.in("classification_status", ["unclassified", "pending_review"]).eq("status", "active");
          rows = (await qb).data ?? [];
        } else if (register === "partner_case_links") {
          let qb = aml.from("partner_case_links")
            .select("id, case_id, partner_org_id, portal_type, relationship_role, legal_route, state, linked_at, ended_at")
            .order("linked_at", { ascending: false }).limit(limit);
          if (status) qb = qb.eq("state", status);
          rows = (await qb).data ?? [];
        } else if (register === "arrangements") {
          let qb = aml.from("reliance_agreements")
            .select("id, partner_org_name, partner_org_type, status, eligibility_classification, next_review_due, last_reviewed_at, current_assessment_id")
            .order("next_review_due", { ascending: true }).limit(limit);
          if (status === "review_due") qb = qb.eq("status", "active").gte("next_review_due", todayIso).lte("next_review_due", soonIso);
          else if (status === "overdue") qb = qb.eq("status", "active").lt("next_review_due", todayIso);
          else if (status) qb = qb.eq("status", status);
          rows = (await qb).data ?? [];
        } else if (register === "attestations") {
          const qb = aml.from("compliance_attestations")
            .select("id, case_id, version, schema_version, payload_sha256, issued_at, superseded_at, refresh_required_at")
            .order("issued_at", { ascending: false }).limit(limit);
          rows = (await qb).data ?? [];
        } else if (register === "records_requests") {
          let qb = aml.from("partner_records_requests")
            .select("id, case_id, partner_org_id, requested_record_codes, status, requested_at, reviewed_at, due_at, approved_record_codes, denied_record_codes")
            .order("requested_at", { ascending: true }).limit(limit);
          if (status === "pending_review") qb = qb.in("status", ["submitted", "under_review"]);
          else if (status === "awaiting_delivery") qb = qb.in("status", ["approved", "partly_approved"]);
          else if (status) qb = qb.eq("status", status);
          rows = (await qb).data ?? [];
        } else if (register === "evidence_deliveries") {
          let qb = aml.from("partner_evidence_deliveries")
            .select("id, case_id, partner_org_id, record_code, safe_label, delivered_at, expires_at, revoked_at")
            .order("delivered_at", { ascending: false }).limit(limit);
          if (status === "live") qb = qb.is("revoked_at", null).gt("expires_at", nowIso);
          rows = (await qb).data ?? [];
        } else if (register === "determinations") {
          const qb = aml.from("independent_assessments")
            .select("id, case_id, partner_org_id, status, decided_at, based_on_attestation_sha256, refresh_required_at, created_at")
            .order("created_at", { ascending: false }).limit(limit);
          rows = (await qb).data ?? [];
        } else if (register === "refresh_obligations") {
          let qb = aml.from("partner_refresh_obligations")
            .select("id, case_id, partner_org_id, partner_case_link_id, safe_reason_code, required_action, status, due_at, created_at, completed_at")
            .order("created_at", { ascending: true }).limit(limit);
          if (status) qb = qb.eq("status", status);
          rows = (await qb).data ?? [];
        } else if (register === "integration_events") {
          if (status === "dead_letter") {
            rows = (await admin.from("integration_dead_letters")
              .select("id, event_type, aggregate_type, attempts, failed_at, replayed_at")
              .like("event_type", "aml.%").is("replayed_at", null)
              .order("failed_at", { ascending: true }).limit(limit)).data ?? [];
          } else {
            let qb = admin.from("integration_outbox")
              .select("id, event_type, aggregate_type, occurred_at, processed_at, attempts, last_error")
              .like("event_type", "aml.%").order("occurred_at", { ascending: true }).limit(limit);
            if (status === "retrying") qb = qb.is("processed_at", null).gt("attempts", 0);
            else if (status === "pending") qb = qb.is("processed_at", null);
            rows = (await qb).data ?? [];
          }
        } else if (register === "retention_candidates") {
          const qb = aml.from("retention_triggers")
            .select("id, entity_type, entity_id, case_id, record_category, trigger_kind, minimum_retention_date, legal_basis")
            .is("superseded_at", null).lte("minimum_retention_date", nowIso)
            .order("minimum_retention_date", { ascending: true }).limit(limit);
          rows = (await qb).data ?? [];
        } else if (register === "legal_holds") {
          // MLRO-only (capability gate above): hold REASONS stay inside the
          // Command Center; this register never feeds a partner surface.
          let qb = aml.from("legal_holds")
            .select("id, entity_type, entity_id, case_id, reason, imposed_at, imposed_by_label, released_at")
            .order("imposed_at", { ascending: false }).limit(limit);
          if (status === "active") qb = qb.is("released_at", null);
          rows = (await qb).data ?? [];
        } else if (register === "disposal_actions") {
          let qb = aml.from("retention_scans")
            .select("id, scope, status, requested_by_label, approved_by_label, approved_at, executed_at, candidates_count, held_count, disposed_count, skipped_count, created_at")
            .order("created_at", { ascending: false }).limit(limit);
          if (status === "awaiting_approval") qb = qb.eq("status", "awaiting_approval");
          else if (status === "failed") qb = qb.eq("status", "failed");
          rows = (await qb).data ?? [];
          if (status === "failed") {
            const { data: failedItems } = await aml.from("retention_scan_items")
              .select("id, scan_id, entity_type, entity_id, disposition, note, processed_at")
              .eq("disposition", "failed").order("processed_at", { ascending: true }).limit(limit);
            rows = [...rows, ...(failedItems ?? [])];
          }
        } else if (register === "sanctions_sources") {
          const qb = aml.from("sanctions_list_syncs")
            .select("id, list_code, status, completed_at")
            .order("completed_at", { ascending: false }).limit(limit);
          rows = (await qb).data ?? [];
        }
        return jr({ register, status: status || null, rows, generated_at: nowIso });
      }

      case "get_partner_management_report": {
        // Tenant-scoped management measures over the partner domain (§8.4).
        // This deployment is single-tenant ('default'); every partner-domain
        // table carries tenant_id for the day that changes.
        if (!(await flagEnabled(admin, "aml_partner_operations_reporting"))) {
          return jr({ error: "Partner operations reporting is not enabled.", code: "operations_disabled" }, 409);
        }
        const from = /^\d{4}-\d{2}-\d{2}$/.test(String(body.from ?? "")) ? String(body.from) : null;
        const to = /^\d{4}-\d{2}-\d{2}$/.test(String(body.to ?? "")) ? String(body.to) : null;
        const aml = admin.schema("aml");
        const nowIso = new Date().toISOString();
        const todayIso = nowIso.slice(0, 10);
        const ranged = (qb: any, col: string) => {
          if (from) qb = qb.gte(col, from);
          if (to) qb = qb.lte(col, `${to}T23:59:59Z`);
          return qb;
        };
        const count = async (qb: any) => (await qb).count ?? 0;

        const [linksByRoute, grantsActive, grantsRevoked, grantsExpired, accesses,
          requestsByStatus, deliveries, determinationsByStatus, refreshRequired,
          arrangementsOverdue, eligibility, triggers, holdsActive, dueItems,
          blockedItems, scanApprovals, scanFailures, receipts] = await Promise.all([
          ranged(aml.from("partner_case_links").select("legal_route", { count: "exact" }), "linked_at"),
          count(aml.from("reliance_grants").select("id", { count: "exact", head: true })
            .is("revoked_at", null).gt("expires_at", nowIso)),
          count(ranged(aml.from("reliance_grants").select("id", { count: "exact", head: true })
            .not("revoked_at", "is", null), "granted_at")),
          count(aml.from("reliance_grants").select("id", { count: "exact", head: true })
            .is("revoked_at", null).lte("expires_at", nowIso)),
          count(ranged(aml.from("reliance_access_log").select("id", { count: "exact", head: true }), "created_at")),
          ranged(aml.from("partner_records_requests").select("status", { count: "exact" }), "requested_at"),
          count(ranged(aml.from("partner_evidence_deliveries").select("id", { count: "exact", head: true }), "delivered_at")),
          ranged(aml.from("independent_assessments").select("status", { count: "exact" }), "created_at"),
          count(aml.from("partner_refresh_obligations").select("id", { count: "exact", head: true }).eq("status", "open")),
          count(aml.from("reliance_agreements").select("id", { count: "exact", head: true })
            .eq("status", "active").lt("next_review_due", todayIso)),
          aml.from("reliance_agreements").select("eligibility_classification", { count: "exact" }),
          count(ranged(aml.from("retention_triggers").select("id", { count: "exact", head: true })
            .is("superseded_at", null), "created_at")),
          count(aml.from("legal_holds").select("id", { count: "exact", head: true }).is("released_at", null)),
          count(aml.from("retention_triggers").select("id", { count: "exact", head: true })
            .is("superseded_at", null).lte("minimum_retention_date", nowIso)),
          count(aml.from("retention_scan_items").select("id", { count: "exact", head: true })
            .eq("disposition", "blocked")),
          count(ranged(aml.from("retention_scans").select("id", { count: "exact", head: true })
            .not("approved_at", "is", null), "created_at")),
          count(aml.from("retention_scan_items").select("id", { count: "exact", head: true })
            .eq("disposition", "failed")),
          count(aml.from("retention_scan_items").select("id", { count: "exact", head: true })
            .eq("disposition", "disposed")),
        ]);
        const tally = (rows: any[] | null, col: string) => {
          const out: Record<string, number> = {};
          for (const r of rows ?? []) out[r[col]] = (out[r[col]] ?? 0) + 1;
          return out;
        };
        return jr({
          report: {
            tenant_id: "default",
            range: { from, to },
            partners: {
              links_by_legal_route: tally(linksByRoute.data, "legal_route"),
              grants_active: grantsActive,
              grants_revoked: grantsRevoked,
              grants_expired: grantsExpired,
              access_events: accesses,
              records_requests_by_status: tally(requestsByStatus.data, "status"),
              evidence_deliveries: deliveries,
              determinations_by_outcome: tally(determinationsByStatus.data, "status"),
              refresh_required_open: refreshRequired,
            },
            arrangements: {
              overdue_reviews: arrangementsOverdue,
              eligibility_states: tally(eligibility.data, "eligibility_classification"),
            },
            records: {
              operative_triggers: triggers,
              active_legal_holds: holdsActive,
              retention_due_items: dueItems,
              blocked_disposals: blockedItems,
              scan_approvals: scanApprovals,
              disposal_failures: scanFailures,
              disposal_evidence_receipts: receipts,
            },
            generated_at: nowIso,
          },
        });
      }

      case "get_partner_readiness": {
        // Readiness + read-only preflight (§8.5, §8.6). Deliberately NOT
        // gated by the reporting flag: this is the check an operator runs
        // BEFORE enabling anything. Every item reports only what the
        // database can evidence — structures present, recorded flag values,
        // backlog and freshness thresholds — plus this function answering.
        // Worker scheduling, function deployment and source-side checks
        // cannot be verified from here and are reported as unknown.
        // Read-only by construction: nothing below writes.
        const items: ReadinessItem[] = [];
        const probe = async (key: string, label: string, table: string, schema = "aml") => {
          const client = schema === "aml" ? admin.schema("aml") : admin;
          const { error } = await client.from(table).select("*", { count: "exact", head: true }).limit(0);
          items.push(normaliseReadinessItem({
            key, label,
            state: error ? "missing" : "applied",
            evidence: error
              ? `probe of ${schema}.${table} failed: structure absent or not readable`
              : `${schema}.${table} answered a head-only probe`,
          }));
        };
        await probe("phase1_partner_identity", "Phase 1 — partner identity structures", "partner_organisations");
        await probe("phase2_arrangements", "Phase 2 — arrangement governance structures", "arrangement_assessments");
        await probe("phase3_manifests", "Phase 3 — disclosure manifest structures", "disclosure_manifests");
        await probe("phase4_workspace", "Phase 4 — partner workspace structures", "partner_records_requests");
        await probe("phase6_events", "Phase 6 — refresh obligation structures", "partner_refresh_obligations");
        await probe("phase6_outbox_envelope", "Phase 6 — platform outbox", "integration_outbox", "public");
        await probe("phase7_record_catalogue", "Phase 7 — record class catalogue", "record_class_catalogue");
        await probe("phase8_sla_targets", "Phase 8 — operational target configuration", "partner_sla_targets");

        const FLAG_KEYS = [
          "aml_partner_identity", "aml_arrangement_governance", "aml_attestation_v2",
          "aml_partner_compliance_workspace", "aml_partner_workspace_finance",
          "aml_partner_workspace_builder", "aml_partner_workspace_developer",
          "aml_partner_workspace_solicitor", "aml_partner_event_outbox",
          "aml_partner_records_retention", "aml_partner_operations_reporting",
        ];
        for (const key of FLAG_KEYS) {
          const { data: flagRow } = await admin.from("feature_flags")
            .select("key").eq("key", key).maybeSingle();
          const on = flagRow ? await flagEnabled(admin, key) : false;
          items.push(normaliseReadinessItem({
            key: `flag_${key}`, label: `Flag ${key}`,
            state: !flagRow ? "missing" : on ? "enabled" : "disabled",
            evidence: flagRow
              ? `recorded value in public.feature_flags — configuration, not deployment state`
              : "no row in public.feature_flags",
          }));
        }

        const { count: backlog, data: oldestPending } = await admin.from("integration_outbox")
          .select("occurred_at", { count: "exact" }).like("event_type", "aml.%")
          .is("processed_at", null).order("occurred_at", { ascending: true }).limit(1);
        const oldestAgeHours = oldestPending?.[0]
          ? (Date.now() - new Date(oldestPending[0].occurred_at).getTime()) / 3_600_000 : 0;
        items.push(normaliseReadinessItem({
          key: "outbox_backlog", label: "Partner event backlog",
          state: (backlog ?? 0) === 0 ? "healthy" : oldestAgeHours > 12 ? "action_required" : "attention",
          evidence: `${backlog ?? 0} unprocessed aml.* events; oldest ${Math.round(oldestAgeHours)}h. A growing backlog means no consumer is being invoked — consumer scheduling cannot be verified from here.`,
        }));

        const { data: lastScan } = await admin.schema("aml").from("retention_scans")
          .select("created_at, status").order("created_at", { ascending: false }).limit(1).maybeSingle();
        items.push(normaliseReadinessItem({
          key: "retention_scan_recency", label: "Retention scan recency",
          state: !lastScan ? "unknown"
            : (Date.now() - new Date(lastScan.created_at).getTime()) < 35 * 864e5 ? "healthy" : "attention",
          evidence: lastScan
            ? `last scan ${lastScan.created_at} (${lastScan.status})`
            : "no retention scan recorded — recency not verifiable",
        }));

        const { data: lastSync } = await admin.schema("aml").from("sanctions_list_syncs")
          .select("completed_at, list_code").eq("status", "succeeded")
          .order("completed_at", { ascending: false }).limit(1).maybeSingle();
        items.push(normaliseReadinessItem({
          key: "sanctions_freshness", label: "Sanctions list freshness",
          state: !lastSync ? "unknown"
            : (Date.now() - new Date(lastSync.completed_at).getTime()) < 7 * 864e5 ? "healthy" : "attention",
          evidence: lastSync
            ? `latest successful sync ${lastSync.completed_at} (${lastSync.list_code})`
            : "no successful sync recorded — freshness not verifiable",
        }));

        items.push(normaliseReadinessItem({
          key: "function_aml_reliance", label: "aml-reliance function",
          state: "responding", evidence: "produced this response",
        }));
        for (const [key, label] of [
          ["function_outbox_worker", "cross-portal-outbox-worker scheduling"],
          ["security_registry", "Security registry currency (source-side check)"],
          ["required_tests", "Required test suites (source-side check)"],
        ] as const) {
          items.push(normaliseReadinessItem({
            key, label, state: "unknown",
            evidence: "not verifiable from the database — source presence is not deployment truth; verify in the deployment pipeline",
          }));
        }

        return jr({
          readiness: {
            preflight: true,
            read_only: true,
            items,
            notice: "States report database-verifiable facts and recorded configuration only. Nothing here asserts deployment, scheduling or production state.",
            generated_at: new Date().toISOString(),
          },
        });
      }

      default:
        return jr({ error: `Unknown op: ${op}` }, 400);
    }
  } catch (e: any) {
    console.error("[aml-reliance] error", e);
    return jr({ ...internalError(e, 'aml-reliance') }, 500);
  }
});

// CORS-CREDENTIALS: rewrite the wildcard origin into an allowlisted one.
Deno.serve(async (req: Request) => withRequestOrigin(req, await __corsWrappedHandler(req)));
