import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Distribution to several partners, RENDERED.
 *
 * The reported defect — "the existing portals do not seem to be receiving
 * the links, notifications or any communication through" — was invisible to
 * every source-reading test in this repository, because no rule was wrong.
 * `grant_access` emails the link when it is given a `deliver_to`; the caller
 * did not give it one; the grant succeeded; the register was correct; and
 * the screen said "live". So these tests mount the panel and assert on the
 * two things only a render can see: that the workspace tells the truth about
 * a grant nobody was emailed, and that clicking the act actually reaches
 * `grantAccess` WITH a delivery address.
 */

const listAttestations = vi.fn();
const listGrants = vi.fn();
const listAssessments = vi.fn();
const listAgreements = vi.fn();
const listPartnerCaseLinks = vi.fn();
const listPartnerOrganisations = vi.fn();
const staffListPartnerRecordsRequests = vi.fn();
const listPartnerAcknowledgements = vi.fn();
const getPassportDistributionStatus = vi.fn();
const getPartnerEventsHealth = vi.fn();
const grantAccess = vi.fn();

vi.mock("@/lib/aml/amlRelianceApi", () => ({
  amlRelianceApi: {
    listAttestations: (...a: unknown[]) => listAttestations(...a),
    listGrants: (...a: unknown[]) => listGrants(...a),
    listAssessments: (...a: unknown[]) => listAssessments(...a),
    listAgreements: (...a: unknown[]) => listAgreements(...a),
    listPartnerCaseLinks: (...a: unknown[]) => listPartnerCaseLinks(...a),
    listPartnerOrganisations: (...a: unknown[]) => listPartnerOrganisations(...a),
    staffListPartnerRecordsRequests: (...a: unknown[]) => staffListPartnerRecordsRequests(...a),
    listPartnerAcknowledgements: (...a: unknown[]) => listPartnerAcknowledgements(...a),
    getPassportDistributionStatus: (...a: unknown[]) => getPassportDistributionStatus(...a),
    getPartnerEventsHealth: (...a: unknown[]) => getPartnerEventsHealth(...a),
    grantAccess: (...a: unknown[]) => grantAccess(...a),
  },
}));

const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ toast: (...a: unknown[]) => toast(...a) }));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/components/aml/PartnerOnboardingWizard", () => ({
  PartnerOnboardingWizard: () => null,
}));
vi.mock("@/lib/aml/usePartnerWorkspaceFlags", () => ({
  usePartnerWorkspaceEnabled: () => ({ loading: false, enabled: false }),
  useAnyPartnerWorkspaceEnabled: () => ({ loading: false, enabled: false }),
}));

/** The address dialog, resolved with whatever the operator "typed". */
const prompt = vi.fn();
vi.mock("@/components/aml/usePromptDialog", () => ({
  usePromptDialog: () => ({ prompt: (...a: unknown[]) => prompt(...a), dialog: null }),
}));

import { ReliancePassportSection } from "../ReliancePassportSection";

const CASE_ID = "8b668f2f-0132-436f-b32c-d6709ea69526";
const AG_FINANCE = "5b83cb1e-6676-4457-9b48-3e5fcc7a92a6";
const AG_BUILDER = "1f0c9d54-2f6f-4d19-9d1c-27d2f0b2ee31";

const agreement = (id: string, name: string, type: string) => ({
  id, partner_org_name: name, partner_org_type: type,
  partner_abn: null, agreement_reference: "ref", executed_on: "2026-08-01",
  next_review_due: "2027-08-01", last_reviewed_at: null,
  scope: ["customer_identification"], status: "active", notes: null,
  created_at: "2026-08-01T00:00:00.000Z",
});

const grant = (over: Record<string, unknown> = {}) => ({
  id: "gr-1", agreement_id: AG_FINANCE,
  granted_at: "2026-08-20T00:00:00.000Z",
  expires_at: "2027-08-20T00:00:00.000Z",
  revoked_at: null, revoke_reason: null,
  delivered_to_email: null, delivered_at: null, link_requested_at: null,
  reliance_agreements: { partner_org_name: "Meridian Finance Group" },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  listAttestations.mockResolvedValue({
    attestations: [{
      id: "att-1", version: 3, issued_at: "2026-08-27T08:28:28.000Z",
      payload_sha256: "28099ae9048b1397aaaa", superseded_at: null,
    }],
  });
  listGrants.mockResolvedValue({ grants: [] });
  listAssessments.mockResolvedValue({ assessments: [] });
  listAgreements.mockResolvedValue({
    agreements: [
      agreement(AG_FINANCE, "Meridian Finance Group", "finance"),
      agreement(AG_BUILDER, "Ridgeline Builders", "builder"),
    ],
  });
  listPartnerCaseLinks.mockResolvedValue({ links: [] });
  listPartnerOrganisations.mockResolvedValue({ partner_organisations: [] });
  staffListPartnerRecordsRequests.mockResolvedValue({ requests: [] });
  listPartnerAcknowledgements.mockResolvedValue({ acknowledgements: [] });
  getPassportDistributionStatus.mockResolvedValue({ passport: { state: { code: "current" } } });
  getPartnerEventsHealth.mockResolvedValue({ health: { outbox_enabled: false } });
});

afterEach(() => { vi.useRealTimers(); });

describe("every partner with an arrangement is a row that can be sent to", () => {
  it("renders one row per active arrangement, not one grant total", async () => {
    render(<ReliancePassportSection caseId={CASE_ID} isMlro />);
    const panel = await screen.findByRole("region", { name: /passport recipients/i });
    expect(panel).toHaveTextContent("Meridian Finance Group");
    expect(panel).toHaveTextContent("Ridgeline Builders");
    // Both are offered the act; multiple distribution is the ordinary case.
    expect(await screen.findAllByRole("button", { name: /Send the Passport/i })).toHaveLength(2);
  });

  it("a grant that was never emailed is reported as such, not as live", async () => {
    listGrants.mockResolvedValue({ grants: [grant()] });
    render(<ReliancePassportSection caseId={CASE_ID} isMlro />);
    const panel = await screen.findByRole("region", { name: /passport recipients/i });
    expect(panel).toHaveTextContent(/never emailed/i);
    expect(panel).toHaveTextContent(/they have no link/i);
    // And the act is offered on that row.
    expect(await screen.findByRole("button", { name: /Send their link/i })).toBeInTheDocument();
  });

  it("a delivered grant names where it went", async () => {
    listGrants.mockResolvedValue({
      grants: [grant({ delivered_to_email: "ops@meridian.example", delivered_at: "2026-08-20T00:00:00.000Z" })],
    });
    render(<ReliancePassportSection caseId={CASE_ID} isMlro />);
    const panel = await screen.findByRole("region", { name: /passport recipients/i });
    expect(panel).toHaveTextContent("ops@meridian.example");
  });
});

describe("clicking the act actually delivers", () => {
  it("calls grantAccess WITH deliver_to — the omission that caused the defect", async () => {
    prompt.mockResolvedValue({ deliver_to: "ops@meridian.example" });
    grantAccess.mockResolvedValue({
      grant: { id: "gr-new", expires_at: "2027-08-20T00:00:00.000Z", attestation_version: 3 },
      access_token: "raw-token", passport_link: "https://npc.example/passport/raw-token",
      delivered_to: "ops@meridian.example", link_email_sent: true, link_email_error: null,
      note: "ok",
    });
    render(<ReliancePassportSection caseId={CASE_ID} isMlro />);
    const buttons = await screen.findAllByRole("button", { name: /Send the Passport/i });
    fireEvent.click(buttons[0]);

    await waitFor(() => expect(grantAccess).toHaveBeenCalled());
    const [, agreementId, options] = grantAccess.mock.calls[0];
    expect([AG_FINANCE, AG_BUILDER]).toContain(agreementId);
    expect(options.deliver_to).toBe("ops@meridian.example");
    // A first send supersedes nothing.
    expect(options.reissue_of).toBeUndefined();
  });

  it("a holder's send supersedes the link they have — it is never re-read", async () => {
    listGrants.mockResolvedValue({
      grants: [grant({ delivered_to_email: "ops@meridian.example" })],
    });
    prompt.mockResolvedValue({ deliver_to: "ops@meridian.example" });
    grantAccess.mockResolvedValue({
      grant: { id: "gr-new", expires_at: "2027-08-20T00:00:00.000Z", attestation_version: 3 },
      access_token: "raw-token", passport_link: "https://npc.example/passport/raw-token",
      delivered_to: "ops@meridian.example", link_email_sent: true, link_email_error: null,
      note: "ok",
    });
    render(<ReliancePassportSection caseId={CASE_ID} isMlro />);
    fireEvent.click(await screen.findByRole("button", { name: /Re-issue and send/i }));
    await waitFor(() => expect(grantAccess).toHaveBeenCalled());
    expect(grantAccess.mock.calls[0][2].reissue_of).toBe("gr-1");
  });

  it("the address box OPENS with the address the platform already knows", async () => {
    listGrants.mockResolvedValue({
      grants: [grant({ delivered_to_email: "ops@meridian.example" })],
    });
    prompt.mockResolvedValue(null);
    render(<ReliancePassportSection caseId={CASE_ID} isMlro />);
    fireEvent.click(await screen.findByRole("button", { name: /Re-issue and send/i }));
    await waitFor(() => expect(prompt).toHaveBeenCalled());
    /* A placeholder is not a value — the whole class of defect this replaces.
       The field must open holding the address, so the operator confirms
       rather than retypes. */
    expect(prompt.mock.calls[0][0].fields[0].value).toBe("ops@meridian.example");
  });

  it("the one-time link is handed over as a real value, not a placeholder", async () => {
    prompt.mockResolvedValue({ deliver_to: "ops@meridian.example" });
    grantAccess.mockResolvedValue({
      grant: { id: "gr-new", expires_at: "2027-08-20T00:00:00.000Z", attestation_version: 3 },
      access_token: "raw-token", passport_link: "https://npc.example/passport/raw-token",
      delivered_to: "ops@meridian.example", link_email_sent: true, link_email_error: null,
      note: "ok",
    });
    render(<ReliancePassportSection caseId={CASE_ID} isMlro />);
    const buttons = await screen.findAllByRole("button", { name: /Send the Passport/i });
    fireEvent.click(buttons[0]);
    const field = await screen.findByLabelText(/One-time Passport link/i);
    expect(field).toHaveValue("https://npc.example/passport/raw-token");
  });

  it("refuses to mint against something that is not an address", async () => {
    prompt.mockResolvedValue({ deliver_to: "not an email" });
    render(<ReliancePassportSection caseId={CASE_ID} isMlro />);
    const buttons = await screen.findAllByRole("button", { name: /Send the Passport/i });
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(grantAccess).not.toHaveBeenCalled();
  });
});

describe("what stops a send is on the row, before the click", () => {
  it("an analyst is told who can send rather than shown a dead button", async () => {
    render(<ReliancePassportSection caseId={CASE_ID} isMlro={false} />);
    const panel = await screen.findByRole("region", { name: /passport recipients/i });
    expect(panel).toHaveTextContent(/Only the MLRO can send a Passport/i);
    /* The act is named and visible, and it cannot be performed — a blocked
       act that disappears teaches an analyst the feature does not exist. */
    for (const b of screen.getAllByRole("button", { name: /Send the Passport/i })) {
      expect(b).toBeDisabled();
    }
  });

  it("with no attestation, every row says there is nothing to send yet", async () => {
    listAttestations.mockResolvedValue({ attestations: [] });
    render(<ReliancePassportSection caseId={CASE_ID} isMlro />);
    const panel = await screen.findByRole("region", { name: /passport recipients/i });
    expect(panel).toHaveTextContent(/Issue the attestation first/i);
  });
});

describe("where the Passport actually appears", () => {
  it("says the emailed link is the only channel when no portal surface exists", async () => {
    render(<ReliancePassportSection caseId={CASE_ID} isMlro />);
    const panel = await screen.findByRole("region", { name: /passport recipients/i });
    expect(panel).toHaveTextContent(/nothing will appear inside their portal/i);
  });
});
