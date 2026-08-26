import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FundingEvidencePanel } from "../FundingEvidencePanel";

/**
 * Stage 6's working surface, on screen.
 *
 * The rules are pinned in `fundingEvidence.test.ts`. What is asserted here is
 * the wiring the defect was made of: the panel exists at all (nothing called
 * `upsertSof` before it), a declared source is recorded by a PERSON pressing
 * a button, verification is its own explicit act, and a failed read never
 * renders as an empty list ready to work on.
 */

const listSof = vi.fn();
const upsertSof = vi.fn();
const deleteSof = vi.fn();
const getSubmissionReview = vi.fn();
vi.mock("@/lib/aml/amlMonitoringApi", () => ({
  amlMonitoringApi: {
    listSof: (...a: unknown[]) => listSof(...a),
    upsertSof: (...a: unknown[]) => upsertSof(...a),
    deleteSof: (...a: unknown[]) => deleteSof(...a),
  },
}));
vi.mock("@/lib/aml/amlCasesApi", () => ({
  amlCasesApi: { getSubmissionReview: (...a: unknown[]) => getSubmissionReview(...a) },
}));
vi.mock("@/hooks/use-toast", () => ({ toast: vi.fn() }));

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const sof = (over = {}) => ({
  id: "s1", edd_case_id: null, case_id: CASE_ID, source_type: "savings",
  description: "Salary savings", amount: null, currency: "AUD",
  evidence_path: null, evidence_provider: null, verified: false,
  verified_by: null, verified_at: null, notes: null, metadata: {},
  created_at: "2026-08-20T00:00:00Z", updated_at: "2026-08-20T00:00:00Z",
  ...over,
});
const review = (sources: string[] = ["Salary savings", "Loan / mortgage"]) => ({
  submission: {
    sections: [{ section: "funding", payload: {
      deposit: "200000", sources, overseas: "no",
      narrative: "Family and savings", institutions: "Cba",
    } }],
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  listSof.mockResolvedValue({ items: [] });
  getSubmissionReview.mockResolvedValue(review());
  upsertSof.mockResolvedValue({ item: sof() });
});

const renderPanel = (canWrite = true, onChanged = vi.fn()) => {
  render(<FundingEvidencePanel caseId={CASE_ID} canWrite={canWrite} onChanged={onChanged} />);
  return onChanged;
};

describe("the customer's declaration reaches the analyst", () => {
  it("offers each declared source, recorded by a person's click, unverified", async () => {
    renderPanel();
    expect(await screen.findByText(/declared by the customer, not yet recorded/i)).toBeTruthy();
    const buttons = screen.getAllByRole("button", { name: /record as a source/i });
    expect(buttons.length).toBe(2);

    fireEvent.click(buttons[0]);
    await waitFor(() => expect(upsertSof).toHaveBeenCalled());
    const written = upsertSof.mock.calls[0][0];
    expect(written.case_id).toBe(CASE_ID);
    expect(written.source_type).toBe("savings");
    expect(written.description).toBe("Salary savings");
    // The line the whole flow rests on: a declaration arrives unverified.
    expect(written.verified).toBeUndefined();
    expect(written.amount).toBeNull();
  });

  it("a source already recorded is not offered again", async () => {
    listSof.mockResolvedValue({ items: [sof()] });
    renderPanel();
    expect(await screen.findByText("Salary savings")).toBeTruthy();
    const offers = screen.getAllByRole("button", { name: /record as a source/i });
    expect(offers.length).toBe(1); // only Loan / mortgage remains
  });
});

describe("verification is an explicit act", () => {
  it("verify sends verified: true and reloads the workspace", async () => {
    listSof.mockResolvedValue({ items: [sof()] });
    const onChanged = renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /verify against evidence/i }));
    await waitFor(() => expect(upsertSof).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1", verified: true })));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("a verified source can be withdrawn, never silently edited", async () => {
    listSof.mockResolvedValue({ items: [sof({ verified: true, verified_at: "2026-08-25T00:00:00Z" })] });
    renderPanel();
    expect(await screen.findByText("Verified")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /withdraw verification/i }));
    await waitFor(() => expect(upsertSof).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1", verified: false })));
  });

  it("a reader without the write role gets a reading, not buttons", async () => {
    listSof.mockResolvedValue({ items: [sof()] });
    renderPanel(false);
    expect(await screen.findByText("Salary savings")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /verify against evidence/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /record as a source/i })).toBeNull();
  });
});

describe("the Passport line tells the truth", () => {
  it("unearned while nothing is verified, and says recording is not enough", async () => {
    listSof.mockResolvedValue({ items: [sof()] });
    renderPanel();
    expect(await screen.findByText(/recording alone does not earn it/i)).toBeTruthy();
  });

  it("earned once a source is verified, with the date", async () => {
    listSof.mockResolvedValue({ items: [sof({ verified: true, verified_at: "2026-08-25T00:00:00Z" })] });
    renderPanel();
    expect(await screen.findByText(/carries SOURCE OF FUNDS REVIEWED, dated 2026-08-25/i)).toBeTruthy();
  });
});

describe("a failed read is not an empty list", () => {
  it("says the list could not be read and offers no work over it", async () => {
    listSof.mockRejectedValue(new Error("503"));
    renderPanel();
    expect(await screen.findByText(/could not be read/i)).toBeTruthy();
    // Recording against a list you cannot see risks doubling what is there.
    expect(screen.queryByRole("button", { name: /record as a source/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /record another source/i })).toBeNull();
  });

  it("an unreadable submission only mutes the seeding, never the panel", async () => {
    getSubmissionReview.mockRejectedValue(new Error("403"));
    listSof.mockResolvedValue({ items: [sof()] });
    renderPanel();
    expect(await screen.findByText("Salary savings")).toBeTruthy();
    expect(screen.queryByText(/declared by the customer, not yet recorded/i)).toBeNull();
  });
});
