/**
 * The AUSTRAC hub — a path to lodgement, and a report that lands on a
 * customer's file.
 *
 * The page rendered a dialog with five boxes and a table of statuses.
 * Nothing said what happens next, nothing said when the report was due, and
 * nothing asked which customer it was about — so `reports.case_id`, which
 * has existed since the first migration, was never set and every report was
 * filed against nobody.
 */
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const listReports = vi.fn();
const getReport = vi.fn();
const summary = vi.fn();
const listCases = vi.fn();

vi.mock("@/lib/aml/amlReportingApi", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  amlReportingApi: {
    summary: () => summary(),
    listReports: (a: unknown) => listReports(a),
    getReport: (id: string) => getReport(id),
    upsertReport: vi.fn(), deleteReport: vi.fn(), mlroSignoff: vi.fn(),
    mlroReject: vi.fn(), withdrawReport: vi.fn(), submitRecord: vi.fn(),
    recordReceipt: vi.fn(), exportBundle: vi.fn(), createVersion: vi.fn(),
  },
}));
vi.mock("@/lib/aml/amlCasesApi", () => ({
  amlCasesApi: { list: (a: unknown) => listCases(a) },
}));
vi.mock("@/hooks/useAmlAccess", () => ({
  useAmlAccess: () => ({
    roles: new Set(["mlro"]), hasAnyRole: true, canWrite: true, isMlro: true, loading: false,
  }),
}));
vi.mock("@/lib/aml/useAmlV3Flags", () => ({
  useAmlV3Flags: () => ({ regulatoryHub: false, loading: false }),
}));

import AmlAustracReporting from "../AmlAustracReporting";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

const REPORT = {
  id: "r1", kind: "smr", case_id: "case-1", title: "SMR — unusual cash deposits",
  status: "draft", narrative: "x".repeat(300), reference_code: null,
  reporting_period_start: null, reporting_period_end: null,
  mlro_signed_at: null, submitted_at: null, acknowledged_at: null,
  metadata: { obligation_at: "2026-08-27T00:00:00.000Z" },
  created_at: "2026-08-27T00:00:00.000Z", updated_at: "2026-08-27T00:00:00.000Z",
};

beforeEach(() => {
  listReports.mockResolvedValue([REPORT]);
  getReport.mockResolvedValue({ report: REPORT, versions: [], submissions: [] });
  summary.mockResolvedValue({ drafts: 1, awaiting_mlro: 0, approved: 0, submitted: 0, acknowledged: 0, rejected: 0 });
  listCases.mockResolvedValue({
    cases: [{ id: "case-1", subject_display_name: "Rugesh Naidu", case_reference: "AML-2026-00005" }],
    total: 1,
  });
});

const renderPage = () =>
  render(<MemoryRouter><AmlAustracReporting /></MemoryRouter>);

describe("the guided path", () => {
  it("renders, and leads with what to do next", async () => {
    renderPage();
    fireEvent.click(await screen.findByText("SMR — unusual cash deposits"));
    await waitFor(() =>
      expect(screen.getByText("Suspicious Matter Report")).toBeInTheDocument());
    // Six numbered steps, one of them open.
    expect(await screen.findByText("MLRO approves it")).toBeInTheDocument();
    expect(screen.getByText("Lodge it at AUSTRAC Online")).toBeInTheDocument();
    expect(screen.getByText("Keep the receipt with the report")).toBeInTheDocument();
  });

  it("shows the statutory deadline and the section it comes from", async () => {
    /* A deadline nobody can see is a deadline nobody meets. */
    renderPage();
    fireEvent.click(await screen.findByText("SMR — unusual cash deposits"));
    await waitFor(() =>
      expect(screen.getAllByText(/AML\/CTF Act 2006 \(Cth\) s\.41/).length).toBeGreaterThan(0));
  });

  it("says the platform never lodges, on the page rather than in a tooltip", async () => {
    renderPage();
    fireEvent.click(await screen.findByText("SMR — unusual cash deposits"));
    await waitFor(() =>
      expect(screen.getByText(/holds no AUSTRAC credentials and submits nothing on your behalf/i))
        .toBeInTheDocument());
  });
});

describe("a report is filed against a customer", () => {
  it("asks which customer, in the draft dialog", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /New Draft/i }));
    expect(await screen.findByText("Customer")).toBeInTheDocument();
    expect(screen.getByText(/held on this customer's compliance file/i)).toBeInTheDocument();
  });

  it("asks what starts the clock, separately from the reporting period", async () => {
    /* An SMR is due from the day the suspicion was FORMED, which is not the
       reporting period. A deadline derived from the wrong date is worse
       than none. */
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /New Draft/i }));
    expect(await screen.findByText("Obligation arose")).toBeInTheDocument();
    expect(screen.getByText("Period start")).toBeInTheDocument();
  });
});

describe("the machinery underneath is untouched", () => {
  it("the SERVER still owns every refusal", () => {
    /* Two gates is how one of them becomes wrong. The page discloses what
       the server will say; it enforces none of it. */
    const fn = read("supabase/functions/aml-reporting/index.ts");
    expect(fn).toContain('report.status !== "approved"');
    expect(fn).toContain("Submission evidence required");
    expect(fn).toContain("SMR submissions require the AUSTRAC lodgement reference");
    expect(fn).toContain("attest_no_tipping_off");
    expect(fn).toContain("requireStepUpSession");
  });

  it("an SMR case event is still marked restricted — tipping off is an offence", () => {
    /* s.123 makes disclosing an SMR an offence. The event the submission
       writes carries `restricted` so downstream renderers can withhold it. */
    const fn = read("supabase/functions/aml-reporting/index.ts");
    expect(fn).toMatch(/report\.kind === "smr"\) eventPayload\.restricted = true/);
  });

  it("the Passport already denies SMR and AUSTRAC material to BOTH audiences", () => {
    /* Tipping off is an offence under s.123, so the protection has to be at
       the projection rather than in a caller's discretion. Both deny-lists
       already carry `smr` and `austrac`, and this pins them: a report can
       never travel to a client's copy or a partner's, whatever is added to
       the record above them. */
    const view = read("supabase/functions/_shared/aml/passport/passportView.pure.ts");
    for (const list of ["CLIENT_RESTRICTED_KEYS", "PARTNER_RESTRICTED_KEYS"]) {
      const i = view.indexOf(`const ${list}`);
      expect(i).toBeGreaterThan(0);
      const pattern = view.slice(i, view.indexOf(";", i));
      expect(pattern).toContain("smr");
      expect(pattern).toContain("austrac");
      expect(pattern).toContain("suspic");
    }
  });
});
