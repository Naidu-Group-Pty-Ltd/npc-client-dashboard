import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The partner's Passport page, RENDERED.
 *
 * The reported defect was visible in one screenshot and invisible to every
 * test in the repository: the page drew `JSON.stringify(attestation)` in a
 * `<pre>`. The pure composer is tested next door; what needs mounting is that
 * the page actually draws the booklet, that the reader can enlarge it, and
 * that the raw payload survives as a disclosure rather than as the offer.
 */

vi.mock("react-router-dom", () => ({ useParams: () => ({ token: "a".repeat(64) }) }));

vi.mock("@/components/branding/BrandAssets", () => ({
  BrandLockup: () => <div data-testid="brand-lockup" />,
}));

const redeem = vi.fn();
vi.mock("@/lib/aml/partnerAcknowledgementPublic", () => ({
  passportPublicApi: {
    redeem: (...a: unknown[]) => redeem(...a),
    requestNewLink: vi.fn(),
    recordIndependentAssessment: vi.fn(),
  },
}));

import PublicPassport from "@/pages/PublicPassport";

const redemption = {
  attestation_sha256: "28099ae9048b1397aa11bb22cc33dd44ee55ff6677889900aabbccddeeff0011",
  issued_at: "2026-08-27T08:28:28.000Z",
  agreement: {
    partner_org_name: "Testing Pty Ltd",
    agreement_reference: "AML/CTF Compliance Passport Agreement",
    scope: ["customer_identification"],
  },
  notice: "You may rely on the customer identification procedures described here.",
  attestation: {
    issuer: "NPC Services command centre",
    case_reference: "AML-2026-00005",
    subject: "Rugesh Naidu",
    subject_type: "individual",
    customer_identification: {
      parties: [{
        party: "Rugesh Naidu", verified: true, method: "electronic_idv",
        completed_at: "2026-08-20T15:16:00.000Z",
      }],
      sections_submitted: 6,
      consents_held: [
        { code: "compliance_sharing", version: "2026.2", accepted_at: "2026-08-15T16:51:54.000Z" },
      ],
    },
    screening: {
      performed: true, last_performed_at: "2026-08-20T15:16:00.000Z",
      scope: ["sanctions"], list_freshness: { un: "2026-08-26T20:01:53.000Z" },
    },
    limitations: ["documents_not_verified_against_issuing_authority"],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  redeem.mockResolvedValue(redemption);
});

describe("the partner is handed a document", () => {
  it("draws the booklet — cover first, with its bearer on it", async () => {
    render(<PublicPassport />);

    expect(await screen.findByLabelText("Passport cover")).toBeInTheDocument();
    expect(screen.getAllByText("Rugesh Naidu").length).toBeGreaterThan(0);
    // The bar names the document and the cover prints it — both deliberate.
    expect(screen.getAllByText("AML/CTF Compliance Passport").length).toBeGreaterThan(0);
  });

  it("offers the pages of the record, not one wall of text", async () => {
    render(<PublicPassport />);
    await screen.findByLabelText("Passport cover");

    // Every leaf the disclosure supports is reachable from the page chips.
    for (const title of ["Reliance basis", "Customer identity", "Screening performed"]) {
      expect(screen.getByRole("button", { name: new RegExp(title, "i") })).toBeInTheDocument();
    }
  });

  it("keeps the raw payload as a disclosure rather than as the offer", async () => {
    render(<PublicPassport />);
    await screen.findByLabelText("Passport cover");

    // An integration verifies the fingerprint against the exact object, so
    // removing it to make the page prettier would take away the one artefact
    // that can be checked.
    const details = screen.getByText(/View the underlying record \(JSON\)/i);
    expect(details).toBeInTheDocument();
    expect(document.querySelector("details")?.hasAttribute("open")).toBe(false);
  });

  it("still leads with the responsibility notice", async () => {
    render(<PublicPassport />);
    expect(await screen.findByText(/You may rely on the customer identification/i))
      .toBeInTheDocument();
    expect(screen.getByText(/Make your own determination/i)).toBeInTheDocument();
  });
});

describe("the reader can enlarge it", () => {
  it("starts at the fit and steps up from there", async () => {
    render(<PublicPassport />);
    await screen.findByLabelText("Passport cover");

    const reset = screen.getByRole("button", { name: /Magnification 100 percent/i });
    expect(reset).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Zoom out$/i })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /^Zoom in$/i }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Magnification 125 percent/i }))
        .toBeInTheDocument());
    expect(screen.getByRole("button", { name: /^Zoom out$/i })).not.toBeDisabled();
  });

  it("returns to the fit when the reader asks", async () => {
    render(<PublicPassport />);
    await screen.findByLabelText("Passport cover");

    fireEvent.click(screen.getByRole("button", { name: /^Zoom in$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /Magnification 125 percent/i }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Magnification 100 percent/i })).toBeDisabled());
  });

  it("offers one page at a time, which is the cheapest magnification there is", async () => {
    render(<PublicPassport />);
    await screen.findByLabelText("Passport cover");

    const toggle = screen.getByRole("button", { name: /Show one page at a time/i });
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Show two pages side by side/i }))
        .toBeInTheDocument());
  });
});
