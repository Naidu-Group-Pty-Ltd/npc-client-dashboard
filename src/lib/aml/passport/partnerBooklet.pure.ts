/**
 * The Compliance Passport as a partner receives it — the same bound document,
 * built from the disclosure and nothing else.
 *
 * ── The defect this replaces ──────────────────────────────────────────
 * A partner who opened their emailed link was shown `JSON.stringify` of the
 * attestation payload in a `<pre>`. Not a summary of it, not a rendering of
 * it — the literal object, braces and quoted keys and all. Everyone inside
 * this business has seen the passport as a navy-and-gold bound booklet; the
 * one audience the document exists FOR was handed source code.
 *
 * ── Why this is a page list and not a component ───────────────────────
 * `PassportBook` already draws a booklet, and the Command Centre and the
 * Client Portal both use it, deliberately: the officer and the client must be
 * looking at the same artefact. Handing the partner a second, hand-drawn
 * "partner version" would be a third renderer of the same document, and three
 * renderers of one instrument eventually disagree about what it looks like.
 *
 * So the partner gets the SAME viewer. All that is needed is the page list,
 * and that is what this module produces — from `PassportBook`'s own
 * `BookletPage`/`BookletBlock` vocabulary, so nothing about the drawing is
 * duplicated or reimplemented.
 *
 * ── The rule that governs every line below ────────────────────────────
 * **It renders the disclosure; it never adds to it.** The server intersects
 * the payload with the grant's manifest before sending it — the risk
 * assessment, screening match content and internal notes are not merely
 * hidden here, they never arrive. This module reads only the object it is
 * given, invents no fact, infers no conclusion, and prints no page whose
 * records the disclosure does not contain: an empty "Screening" leaf in a
 * bound document reads as "screening found nothing", which is a different and
 * far worse claim than "screening is not part of this record".
 */

import type { BookletBlock, BookletPage, BookletTone } from "./index";

/** The attestation payload, as `buildAttestationPayload` composes it. */
export interface PartnerDisclosure {
  attestation: Record<string, unknown>;
  attestation_sha256: string;
  issued_at: string;
  agreement: { partner_org_name: string; agreement_reference: string; scope?: string[] };
  /** The statutory position, restated by the server at the point of use. */
  notice: string;
}

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : null;

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function fmtDate(iso: unknown): string {
  const s = str(iso);
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" })
    .toUpperCase();
}

/**
 * `electronic_idv` is not a phrase anybody says out loud.
 *
 * A relying entity is reading this to decide whether the identification meets
 * their own requirements, so the method has to be readable. An unrecognised
 * code is printed as it arrived rather than guessed at — inventing a friendly
 * label for a method this build has never seen would be a claim about what was
 * performed.
 */
const METHOD_LABELS: Record<string, string> = {
  electronic_idv: "Electronic identity verification",
  document_sighting: "Certified document sighting",
  dvs: "Document Verification Service (DVS)",
};

const CONSENT_LABELS: Record<string, string> = {
  identity_verification: "Identity verification",
  biometric_collection: "Biometric collection",
  compliance_sharing: "Sharing of the completed verification",
  record_keeping: "Record keeping",
  regulatory_reporting: "Regulatory reporting",
  aml_ctf_program: "AML/CTF programme",
  privacy_notice: "Privacy notice",
};

const LIMITATION_LABELS: Record<string, string> = {
  documents_not_verified_against_issuing_authority:
    "Documents were not verified against the issuing authority",
  liveness_signal_is_heuristic_only: "The liveness signal is heuristic only",
};

const humanise = (code: string) =>
  code.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

const methodLabel = (code: string | null) =>
  code ? (METHOD_LABELS[code] ?? humanise(code)) : "—";

const LIST_LABELS: Record<string, string> = {
  un: "United Nations Consolidated List",
  dfat: "DFAT Consolidated List (Australia)",
  ofac: "OFAC (United States)",
};

export function buildPartnerBooklet(d: PartnerDisclosure): BookletPage[] {
  const a = d.attestation ?? {};
  const subject = str(a.subject);
  const caseReference = str(a.case_reference);
  const issuer = str(a.issuer) ?? "the issuing organisation";
  const fingerprint = (d.attestation_sha256 ?? "").slice(0, 16).toUpperCase();

  const pages: BookletPage[] = [];

  /* ── cover ─────────────────────────────────────────────────────────
     The document opens on its cover, exactly as the client's and the
     officer's do. `state.label` is "Issued" and never a compliance word:
     what a partner holds is an issued version of a record, and nothing on
     this cover may read as a verdict about the customer. */
  pages.push({
    id: "cover",
    variant: "cover",
    kicker: "Aurixa Systems",
    title: "AML/CTF Compliance Passport",
    sub: subject ?? undefined,
    numeral: null,
    foot: [caseReference, "Issued"].filter(Boolean).join("  ·  "),
    fingerprint,
    blocks: [],
  });

  const leaf = (page: Omit<BookletPage, "numeral" | "variant">) => {
    const index = pages.filter((p) => p.variant === "leaf").length;
    pages.push({ ...page, variant: "leaf", numeral: ROMAN[index] ?? String(index + 1) });
  };

  /* ── I · what this is, and what it is not ──────────────────────────
     The responsibility notice is the server's own sentence, printed as the
     document's first statement rather than as fine print underneath it.
     Reliance does not transfer an obligation, and the page a partner opens
     on should say so before it says anything else. */
  leaf({
    id: "basis",
    kicker: "Issued under a written CDD arrangement",
    title: "Reliance basis",
    sub: "AML/CTF Act 2006 (Cth) Pt 2 Div 7",
    blocks: [
      { kind: "statement", text: d.notice },
      {
        kind: "fields",
        items: [
          { k: "Issued to", v: d.agreement.partner_org_name },
          { k: "Arrangement", v: d.agreement.agreement_reference },
          { k: "Issued by", v: issuer },
          { k: "Issue date", v: fmtDate(d.issued_at) },
        ],
      },
      {
        kind: "note",
        title: "What this record contains",
        text:
          "It states the customer identification procedures that were performed. It does not "
          + "contain the issuing organisation's risk assessment, screening match content or "
          + "internal notes, and it never will.",
      },
    ],
  });

  /* ── II · the customer ─────────────────────────────────────────────── */
  const identity = obj(a.customer_identification);
  const identityFields: Array<{ k: string; v: string; mono?: boolean }> = [
    { k: "Customer", v: subject ?? "—" },
    { k: "Customer type", v: str(a.subject_type) ? humanise(str(a.subject_type)!) : "—" },
    { k: "Case reference", v: caseReference ?? "—", mono: true },
  ];
  if (identity && typeof identity.sections_submitted === "number") {
    identityFields.push({
      k: "Questionnaire sections completed",
      v: String(identity.sections_submitted),
    });
  }
  if (identity && str(identity.questionnaire_version)) {
    identityFields.push({
      k: "Questionnaire version", v: str(identity.questionnaire_version)!, mono: true,
    });
  }
  leaf({
    id: "customer",
    kicker: "Bearer of this record",
    title: "Customer identity",
    blocks: [{ kind: "fields", items: identityFields }],
  });

  /* ── III · identification, party by party ───────────────────────────
     The one page a relying entity actually reads. Each party gets a row
     naming the method and the date, because that is precisely what their
     own risk assessment needs; a party the record does not show as verified
     is printed as not verified rather than omitted, since a shortened list
     would read as a complete one. */
  const parties = arr(identity?.parties)
    .map((p) => obj(p))
    .filter((p): p is Record<string, unknown> => p !== null);

  if (parties.length > 0) {
    leaf({
      id: "identification",
      kicker: "Customer identification procedures performed",
      title: "Identification of each party",
      sub: `${parties.length} part${parties.length === 1 ? "y" : "ies"} on this record`,
      blocks: [
        {
          kind: "matrix",
          title: "Parties",
          items: parties.map((p) => {
            const verified = p.verified === true;
            const cells: Array<{ t: string; tone: BookletTone }> = [
              { t: methodLabel(str(p.method)), tone: verified ? "info" : "na" },
              { t: fmtDate(p.completed_at), tone: "na" },
            ];
            const documentType = str(p.document_type);
            if (documentType) cells.push({ t: humanise(documentType), tone: "na" });
            const certifier = str(p.certifier_capacity);
            if (certifier) cells.push({ t: `Certified by ${humanise(certifier)}`, tone: "na" });
            return {
              k: str(p.party) ?? "Party",
              v: verified ? "Verified" : "Not verified",
              tone: verified ? "ok" : "warn",
              cells,
            };
          }),
        },
      ],
    });
  }

  /* ── IV · screening ─────────────────────────────────────────────────
     Emitted only when the record holds it. The freshness of each list is
     printed because a screening is only as current as what it was run
     against — and the absence of match content is stated, so silence is
     never read as "nothing was found". */
  const screening = obj(a.screening);
  if (screening && screening.performed === true) {
    const freshness = obj(screening.list_freshness) ?? {};
    const scope = arr(screening.scope).map((s) => String(s));
    const blocks: BookletBlock[] = [
      {
        kind: "fields",
        items: [
          { k: "Screening performed", v: "Yes" },
          { k: "Last performed", v: fmtDate(screening.last_performed_at) },
        ],
      },
    ];
    if (scope.length > 0) {
      blocks.push({
        kind: "chips",
        title: "Scope screened",
        items: scope.map((s) => ({ t: humanise(s), tone: "info" as BookletTone })),
      });
    }
    const freshnessKeys = Object.keys(freshness);
    if (freshnessKeys.length > 0) {
      blocks.push({
        kind: "rows",
        title: "Lists screened against, and when each was last loaded",
        items: freshnessKeys.map((code) => ({
          k: LIST_LABELS[code] ?? code.toUpperCase(),
          v: fmtDate(freshness[code]),
        })),
      });
    }
    blocks.push({
      kind: "note",
      title: "What is deliberately absent",
      text:
        "This record states THAT screening was performed and how current the lists were. It "
        + "carries no match content: what a screening surfaced, and what was concluded about it, "
        + "belongs to the issuing organisation's own assessment.",
    });
    leaf({
      id: "screening",
      kicker: "Sanctions and watchlist screening",
      title: "Screening performed",
      blocks,
    });
  }

  /* ── V · consents ───────────────────────────────────────────────────
     The authority under which this record reached the partner at all. */
  const consents = arr(identity?.consents_held)
    .map((c) => obj(c))
    .filter((c): c is Record<string, unknown> => c !== null);
  if (consents.length > 0) {
    leaf({
      id: "consents",
      kicker: "Authority for this disclosure",
      title: "Consents held",
      blocks: [
        {
          kind: "rows",
          title: "Accepted by the customer",
          items: consents.map((c) => {
            const code = str(c.code) ?? "";
            const version = str(c.version);
            return {
              k: CONSENT_LABELS[code] ?? humanise(code),
              note: version ? `Version ${version}` : undefined,
              v: fmtDate(c.accepted_at),
            };
          }),
        },
      ],
    });
  }

  /* ── VI · limitations ───────────────────────────────────────────────
     Printed as its own leaf rather than as a footnote. A relying entity
     deciding whether these procedures meet their requirements needs the
     boundaries of the record at the same weight as the record. */
  const limitations = arr(a.limitations).map((l) => String(l));
  if (limitations.length > 0) {
    leaf({
      id: "limitations",
      kicker: "Boundaries of this record",
      title: "Limitations",
      blocks: [
        {
          kind: "rows",
          title: "Stated by the issuing organisation",
          items: limitations.map((code) => ({
            k: LIMITATION_LABELS[code] ?? humanise(code),
            v: "Disclosed",
          })),
        },
        {
          kind: "note",
          title: "Your own obligations are unchanged",
          text:
            "Relying on these procedures does not transfer your organisation's AML/CTF "
            + "obligations. Safe practice is to satisfy yourself independently — you may record "
            + "your own determination against these same records at any time, without approaching "
            + "the customer again.",
        },
      ],
    });
  }

  /* ── VII · verification ─────────────────────────────────────────────
     What a holder checks the document against. The fingerprint is on the
     cover and repeated in full here, because the cover prints a short form
     and a verifier needs the whole value. */
  leaf({
    id: "verify",
    kicker: "Integrity of this document",
    title: "Verify this record",
    blocks: [
      {
        kind: "verify",
        code: caseReference ?? "—",
        fingerprint: d.attestation_sha256,
        text:
          "This SHA-256 fingerprint is taken over the disclosed record. If the issuing "
          + "organisation re-issues the attestation, the fingerprint changes and the previous "
          + "version is superseded.",
      },
      { kind: "banner", text: `Issued by ${issuer}` },
    ],
  });

  return pages;
}
