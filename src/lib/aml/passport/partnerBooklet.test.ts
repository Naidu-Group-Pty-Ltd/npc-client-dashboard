import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildPartnerBooklet, type PartnerDisclosure } from "./partnerBooklet.pure";
import { BOOKLET_ZOOM_STEPS, bookletGeometry, bookletZoom, nextBookletZoom } from "./index";

/**
 * The partner receives the document, not the payload.
 *
 * A partner opening their emailed link was shown `JSON.stringify` of the
 * attestation in a `<pre>` — the literal object, braces and quoted keys and
 * all. Everyone inside the issuing business sees this record as a bound
 * booklet; the one audience the document exists FOR was handed source code.
 */

const disclosure = (over: Partial<PartnerDisclosure> = {}): PartnerDisclosure => ({
  attestation_sha256: "28099ae9048b1397aa11bb22cc33dd44ee55ff6677889900aabbccddeeff0011",
  issued_at: "2026-08-27T08:28:28.000Z",
  agreement: {
    partner_org_name: "Testing Pty Ltd",
    agreement_reference: "AML/CTF Compliance Passport Agreement",
    scope: ["customer_identification"],
  },
  notice:
    "You may rely on the customer identification procedures described here under your written "
    + "CDD arrangement (AML/CTF Act Pt 2 Div 7).",
  attestation: {
    schema: "aml.compliance_attestation.v1",
    issuer: "NPC Services command centre",
    case_reference: "AML-2026-00005",
    subject: "Rugesh Naidu",
    subject_type: "individual",
    customer_identification: {
      parties: [
        {
          party: "Rugesh Naidu", verified: true, method: "electronic_idv",
          completed_at: "2026-08-20T15:16:00.000Z", document_type: null,
        },
      ],
      questionnaire_version: "2026.2",
      sections_submitted: 6,
      consents_held: [
        { code: "compliance_sharing", version: "2026.2", accepted_at: "2026-08-15T16:51:54.000Z" },
      ],
    },
    screening: {
      performed: true,
      last_performed_at: "2026-08-20T15:16:00.000Z",
      scope: ["sanctions"],
      list_freshness: { un: "2026-08-26T20:01:53.000Z", dfat: "2026-08-26T20:02:33.000Z" },
    },
    service_readiness: true,
    limitations: ["documents_not_verified_against_issuing_authority"],
    reliance_basis: "AML/CTF Act 2006 (Cth) Pt 2 Div 7",
  },
  ...over,
});

const idsOf = (d: PartnerDisclosure) => buildPartnerBooklet(d).map((p) => p.id);
const flat = (d: PartnerDisclosure) => JSON.stringify(buildPartnerBooklet(d));

describe("the partner opens a bound document", () => {
  it("opens on the cover, naming its bearer", () => {
    const [cover] = buildPartnerBooklet(disclosure());
    expect(cover.variant).toBe("cover");
    expect(cover.sub).toBe("Rugesh Naidu");
    expect(cover.foot).toContain("AML-2026-00005");
    expect(cover.fingerprint).toBe("28099AE9048B1397");
  });

  it("leads with the reliance basis and the responsibility notice", () => {
    const pages = buildPartnerBooklet(disclosure());
    const basis = pages.find((p) => p.id === "basis")!;
    expect(basis.numeral).toBe("I");
    expect(JSON.stringify(basis.blocks)).toContain("under your written");
    // Who it was issued to, under what, by whom, when.
    expect(JSON.stringify(basis.blocks)).toContain("Testing Pty Ltd");
  });

  it("renders each party's identification in words a person reads", () => {
    // `electronic_idv` is not a phrase anybody says out loud, and a relying
    // entity is reading this to decide whether it meets their requirements.
    expect(flat(disclosure())).toContain("Electronic identity verification");
    expect(flat(disclosure())).not.toContain("electronic_idv");
  });

  it("names an unfamiliar method as it arrived rather than inventing a label", () => {
    const d = disclosure();
    (d.attestation.customer_identification as any).parties[0].method = "future_method";
    // Inventing a friendly name for a method this build has never seen would
    // be a claim about what was performed.
    expect(flat(d)).toContain("Future method");
  });

  it("prints a party the record does not show as verified, rather than omitting them", () => {
    const d = disclosure();
    (d.attestation.customer_identification as any).parties.push({
      party: "Second Party", verified: false, method: null, completed_at: null,
    });
    const text = flat(d);
    // A shortened list would read as a complete one.
    expect(text).toContain("Second Party");
    expect(text).toContain("Not verified");
  });
});

describe("what the document may not say", () => {
  it("carries no risk vocabulary of its own", () => {
    const text = flat(disclosure()).toLowerCase();
    // The server never sends these; the document must not invent them either.
    for (const forbidden of ["risk rating", "risk score", "escalat", "suspicio"]) {
      expect(text).not.toContain(forbidden);
    }
    // "Risk assessment" may appear ONLY where the document denies holding one.
    for (const at of [...text.matchAll(/risk assessment/g)].map((m) => m.index ?? 0)) {
      const context = text.slice(Math.max(0, at - 120), at + 40);
      expect(context).toMatch(/does not contain|never|not transfer/);
    }
  });

  it("states that match content is absent, so silence is not read as 'nothing found'", () => {
    expect(flat(disclosure())).toContain("carries no match content");
  });

  it("prints no page for records the disclosure does not hold", () => {
    // An empty "Screening" leaf in a bound document reads as "screening found
    // nothing", which is a different and far worse claim than "screening is
    // not part of this record".
    const d = disclosure();
    delete (d.attestation as any).screening;
    delete (d.attestation as any).limitations;
    (d.attestation.customer_identification as any).parties = [];
    (d.attestation.customer_identification as any).consents_held = [];

    const ids = idsOf(d);
    expect(ids).not.toContain("screening");
    expect(ids).not.toContain("limitations");
    expect(ids).not.toContain("identification");
    expect(ids).not.toContain("consents");
    // What always exists still does: a bearer, a basis and a way to verify.
    expect(ids).toEqual(["cover", "basis", "customer", "verify"]);
  });

  it("does not print a screening page for a screening that was not performed", () => {
    const d = disclosure();
    (d.attestation.screening as any).performed = false;
    expect(idsOf(d)).not.toContain("screening");
  });

  it("survives a payload that is missing everything", () => {
    const bare = disclosure({ attestation: {} });
    const pages = buildPartnerBooklet(bare);
    expect(pages[0].variant).toBe("cover");
    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(pages)).not.toContain("undefined");
  });

  it("never prints a seal, because there is no certification record behind it", () => {
    const kinds = buildPartnerBooklet(disclosure())
      .flatMap((p) => p.blocks.map((b) => b.kind));
    expect(kinds).not.toContain("seals");
    expect(kinds).not.toContain("hero");
    expect(kinds).not.toContain("signature");
  });
});

describe("the fingerprint a verifier checks", () => {
  it("prints in full on the verification leaf, short on the cover", () => {
    const d = disclosure();
    const pages = buildPartnerBooklet(d);
    expect(pages[0].fingerprint).toHaveLength(16);
    expect(JSON.stringify(pages.find((p) => p.id === "verify")))
      .toContain(d.attestation_sha256);
  });
});

/**
 * Magnification.
 *
 * The fit is correct and the page is still too small to read: the design
 * authors 9.5–11px body copy at 470×648, so a two-up spread in a dialog draws
 * that copy at 6–7px. The reader gets a magnification of their own on top of
 * the fit, and it never reflows anything.
 */
describe("the reader can enlarge the document", () => {
  const geometry = bookletGeometry({ availableWidth: 900, availableHeight: 620 });

  it("is the fit, unchanged, until somebody asks for more", () => {
    const view = bookletZoom(geometry, 1);
    expect(view.scale).toBe(geometry.scale);
    expect(view.width).toBe(geometry.width);
    expect(view.overflows).toBe(false);
    expect(view.canZoomOut).toBe(false);
  });

  it("multiplies the same uniform transform rather than reflowing", () => {
    const view = bookletZoom(geometry, 2);
    expect(view.scale).toBeCloseTo(geometry.scale * 2, 10);
    expect(view.width).toBeCloseTo(geometry.width * 2, 10);
    expect(view.height).toBeCloseTo(geometry.height * 2, 10);
    expect(view.overflows).toBe(true);
    expect(view.percent).toBe(200);
  });

  it("clamps whatever a control hands it", () => {
    // A scale of 0 draws nothing; a scale of 40 draws a leaf no scrollbar can
    // rescue. Both arrive from a control, so neither is trusted.
    expect(bookletZoom(geometry, 0).zoom).toBe(BOOKLET_ZOOM_STEPS[0]);
    expect(bookletZoom(geometry, -5).zoom).toBe(BOOKLET_ZOOM_STEPS[0]);
    expect(bookletZoom(geometry, 40).zoom)
      .toBe(BOOKLET_ZOOM_STEPS[BOOKLET_ZOOM_STEPS.length - 1]);
    expect(bookletZoom(geometry, Number.NaN).zoom).toBe(BOOKLET_ZOOM_STEPS[0]);
  });

  it("steps through the declared magnifications and stops at each end", () => {
    let z: number = BOOKLET_ZOOM_STEPS[0];
    const seen = [z];
    for (let i = 0; i < 10; i += 1) {
      z = nextBookletZoom(z, 1);
      if (seen[seen.length - 1] !== z) seen.push(z);
    }
    expect(seen).toEqual([...BOOKLET_ZOOM_STEPS]);
    expect(nextBookletZoom(BOOKLET_ZOOM_STEPS[BOOKLET_ZOOM_STEPS.length - 1], 1))
      .toBe(BOOKLET_ZOOM_STEPS[BOOKLET_ZOOM_STEPS.length - 1]);
    expect(nextBookletZoom(BOOKLET_ZOOM_STEPS[0], -1)).toBe(BOOKLET_ZOOM_STEPS[0]);
    expect(nextBookletZoom(1.5, -1)).toBe(1.25);
  });

  it("one leaf is worth more than any magnification, so it is offered first", () => {
    // Reading a single page roughly doubles the scale before any zoom at all.
    const single = bookletGeometry({ availableWidth: 900, availableHeight: 620, singleOnly: true });
    expect(single.scale).toBeGreaterThan(geometry.scale);
  });
});

describe("the partner page draws the document, not the payload", () => {
  const page = readFileSync("src/pages/PublicPassport.tsx", "utf8");

  it("mounts the SAME viewer the Command Centre and the Client Portal use", () => {
    // Three renderers of one instrument eventually disagree about what it
    // looks like.
    expect(page).toContain("PassportBook");
    expect(page).toContain("buildPartnerBooklet");
  });

  it("keeps the raw record available rather than removing it", () => {
    // An integration verifies the fingerprint against the exact object.
    expect(page).toContain("JSON.stringify(data.attestation, null, 2)");
    expect(page).toContain("View the underlying record (JSON)");
  });
});
