import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The onboarding wizard, RENDERED, at the moment it grants.
 *
 * ── The defect, in one argument ───────────────────────────────────────
 * `grant_access` emails the Passport link when — and only when — it is given
 * a `deliver_to`. The wizard called it as `grantAccess(caseId, agreement.id)`.
 * Nothing failed: the grant was minted, the register was correct, the audit
 * trail was complete, `delivered_to_email` was null, and the partner was
 * never told anything. The operator was then handed a raw bearer token with
 * the instruction to deliver it "through their usual channel".
 *
 * No source-scanning test could see that, because the call was present and
 * spelled correctly. So this one drives the wizard to the end and asserts on
 * the ARGUMENTS, and on what the final screen leads with.
 */

const upsertPartnerOrganisation = vi.fn();
const createAgreement = vi.fn();
const linkPartnerToCase = vi.fn();
const grantAccess = vi.fn();
const listAgreements = vi.fn();
const listPartnerOrganisations = vi.fn();
const listAttestations = vi.fn();
const sendPartnerAcknowledgement = vi.fn();

vi.mock("@/lib/aml/amlRelianceApi", () => ({
  amlRelianceApi: {
    upsertPartnerOrganisation: (...a: unknown[]) => upsertPartnerOrganisation(...a),
    createAgreement: (...a: unknown[]) => createAgreement(...a),
    linkPartnerToCase: (...a: unknown[]) => linkPartnerToCase(...a),
    grantAccess: (...a: unknown[]) => grantAccess(...a),
    listAgreements: (...a: unknown[]) => listAgreements(...a),
    listPartnerOrganisations: (...a: unknown[]) => listPartnerOrganisations(...a),
    listAttestations: (...a: unknown[]) => listAttestations(...a),
    sendPartnerAcknowledgement: (...a: unknown[]) => sendPartnerAcknowledgement(...a),
  },
}));

const consentStatus = vi.fn();
vi.mock("@/lib/aml/amlCasesApi", () => ({
  amlCasesApi: { consentStatus: (...a: unknown[]) => consentStatus(...a) },
}));

const invokeSecureFunction = vi.fn();
vi.mock("@/lib/secureInvoke", () => ({
  invokeSecureFunction: (...a: unknown[]) => invokeSecureFunction(...a),
}));

const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ toast: (...a: unknown[]) => toast(...a) }));

import { PartnerOnboardingWizard } from "../PartnerOnboardingWizard";

const CASE_ID = "8b668f2f-0132-436f-b32c-d6709ea69526";
const CONTACT = "ops@meridian.example";

beforeEach(() => {
  vi.clearAllMocks();
  listPartnerOrganisations.mockResolvedValue({ partner_organisations: [] });
  listAgreements.mockResolvedValue({ agreements: [] });
  listAttestations.mockResolvedValue({
    attestations: [{ id: "att-1", version: 3, issued_at: "2026-08-27T00:00:00.000Z", payload_sha256: "abc", superseded_at: null }],
  });
  consentStatus.mockResolvedValue({
    documents: [{ code: "compliance_sharing", accepted_at: "2026-08-01T00:00:00.000Z" }],
  });
  // Every portal-provisioning call succeeds; the invite is not under test.
  invokeSecureFunction.mockResolvedValue({ data: { users: [], organisation: { id: "o", row_version: 1, status: "active" }, user: { id: "u" } }, error: null });
  upsertPartnerOrganisation.mockResolvedValue({ partner_organisation: { id: "org-1" } });
  createAgreement.mockResolvedValue({ agreement: { id: "ag-1", partner_org_name: "Meridian Finance Group" } });
  linkPartnerToCase.mockResolvedValue({});
  grantAccess.mockResolvedValue({
    grant: { id: "gr-1", expires_at: "2027-08-20T00:00:00.000Z", attestation_version: 3 },
    access_token: "raw-token",
    passport_link: "https://npc.example/passport/raw-token",
    delivered_to: CONTACT,
    link_email_sent: true,
    link_email_error: null,
    note: "ok",
  });
});

const renderWizard = () => render(
  <PartnerOnboardingWizard
    open
    caseId={CASE_ID}
    attestationVersion={3}
    organisations={[]}
    agreements={[]}
    onOpenChange={() => {}}
    onDone={async () => {}}
  />,
);

/** Drive the three steps to the confirm button. */
async function runWizard() {
  renderWizard();
  fireEvent.change(await screen.findByLabelText(/Legal name/i), {
    target: { value: "Meridian Finance Group Pty Ltd" },
  });
  fireEvent.change(screen.getByLabelText(/Contact email/i), { target: { value: CONTACT } });
  fireEvent.change(screen.getByLabelText(/Contact name/i), { target: { value: "Dana Reyes" } });
  fireEvent.click(screen.getByRole("button", { name: /^Continue$/ }));
  fireEvent.click(await screen.findByRole("button", { name: /^Continue$/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Record, invite & grant/i }));
}

describe("a grant is not finished until it has been delivered", () => {
  it("passes deliver_to — the argument whose absence emailed nobody", async () => {
    await runWizard();
    await waitFor(() => expect(grantAccess).toHaveBeenCalled());
    const [caseId, , options] = grantAccess.mock.calls[0];
    expect(caseId).toBe(CASE_ID);
    expect(options).toBeDefined();
    expect(options.deliver_to).toBe(CONTACT);
  });

  it("the link goes to the same address the portal invite did", async () => {
    await runWizard();
    await waitFor(() => expect(grantAccess).toHaveBeenCalled());
    // One person, one address: the Passport and the account it is read
    // alongside must not reach two different inboxes.
    expect(grantAccess.mock.calls[0][2].deliver_to).toBe(CONTACT);
  });

  it("the review screen states the Passport delivery BEFORE the click", async () => {
    renderWizard();
    fireEvent.change(await screen.findByLabelText(/Legal name/i), {
      target: { value: "Meridian Finance Group Pty Ltd" },
    });
    fireEvent.change(screen.getByLabelText(/Contact email/i), { target: { value: CONTACT } });
    fireEvent.change(screen.getByLabelText(/Contact name/i), { target: { value: "Dana Reyes" } });
    fireEvent.click(screen.getByRole("button", { name: /^Continue$/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^Continue$/ }));
    expect(await screen.findByText(/Passport link:/i)).toBeInTheDocument();
  });
});

describe("the final screen leads with delivery, not with a bearer token", () => {
  it("says where the link went", async () => {
    await runWizard();
    expect((await screen.findAllByText(/has been emailed to/i)).length).toBeGreaterThan(0);
  });

  it("hands over the LINK as a real, copyable value", async () => {
    await runWizard();
    const field = await screen.findByLabelText(/Their Passport link/i);
    expect(field).toHaveValue("https://npc.example/passport/raw-token");
  });

  it("puts the raw token behind a disclosure that says who it is for", async () => {
    await runWizard();
    const summary = await screen.findByText(/for system-to-system integrations/i);
    expect(summary).toBeInTheDocument();
    // It is a disclosure, so it is closed: an everyday operator never opens it.
    expect(summary.closest("details")?.hasAttribute("open")).toBe(false);
  });

  it("a failed email says so, and the link is still the copy that survives", async () => {
    grantAccess.mockResolvedValue({
      grant: { id: "gr-1", expires_at: "2027-08-20T00:00:00.000Z", attestation_version: 3 },
      access_token: "raw-token",
      passport_link: "https://npc.example/passport/raw-token",
      delivered_to: CONTACT,
      link_email_sent: false,
      link_email_error: "The mail provider refused it.",
      note: "ok",
    });
    await runWizard();
    expect(await screen.findByText(/did not send/i)).toBeInTheDocument();
    expect(await screen.findByLabelText(/Their Passport link/i))
      .toHaveValue("https://npc.example/passport/raw-token");
  });
});
