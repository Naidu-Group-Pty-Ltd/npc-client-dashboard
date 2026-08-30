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
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const listReports = vi.fn();
const getReport = vi.fn();
const summary = vi.fn();
const listCases = vi.fn();
const exportBundle = vi.fn();
const upsertReport = vi.fn();
const mlroSignoff = vi.fn();

vi.mock("@/lib/aml/amlReportingApi", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  amlReportingApi: {
    summary: () => summary(),
    listReports: (a: unknown) => listReports(a),
    getReport: (id: string) => getReport(id),
    deleteReport: vi.fn(),
    mlroSignoff: (id: string) => mlroSignoff(id),
    mlroReject: vi.fn(), withdrawReport: vi.fn(), submitRecord: vi.fn(),
    recordReceipt: vi.fn(), createVersion: vi.fn(),
    exportBundle: (id: string) => exportBundle(id),
    upsertReport: (d: unknown) => upsertReport(d),
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
/* An unbranded workspace: every download must issue under the Aurixa
   Systems fallback, never an empty masthead. */
vi.mock("@/branding/BrandProvider", () => ({
  useBrand: () => ({
    settings: {
      companyName: "Dashboard", brandColor: null,
      authLogo: null, sidebarLogo: null, sidebarIcon: null,
      favicon: null, reportLogo: null, reportMonoLogo: null,
    },
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
  // Call history must not leak between tests: one of these asserts that a
  // write was NOT made, which the previous test had already made.
  vi.clearAllMocks();
  listReports.mockResolvedValue([REPORT]);
  getReport.mockResolvedValue({ report: REPORT, versions: [], submissions: [] });
  summary.mockResolvedValue({ drafts: 1, awaiting_mlro: 0, approved: 0, submitted: 0, acknowledged: 0, rejected: 0 });
  exportBundle.mockResolvedValue({
    bundle: { report: REPORT, versions: [], submissions: [], exported_at: "2026-08-30T05:00:00.000Z", exported_by: "R Naidu" },
    content_hash: "f".repeat(64),
  });
  upsertReport.mockResolvedValue({ ...REPORT, status: "awaiting_mlro" });
  mlroSignoff.mockResolvedValue({ report: { ...REPORT, status: "approved" } });
  listCases.mockResolvedValue({
    cases: [{ id: "case-1", subject_display_name: "Rugesh Naidu", case_reference: "AML-2026-00005" }],
    total: 1,
  });
});

/** Shows where the router ended up, so a navigation can be asserted. */
function Where() {
  return <span data-testid="where">{useLocation().pathname + useLocation().search}</span>;
}

const renderPage = (entry = "/admin/aml/austrac") =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <AmlAustracReporting />
      <Where />
    </MemoryRouter>,
  );

describe("drafting is a page, not a dialog", () => {
  /*
    A report to a regulator is the longest single piece of writing anyone
    does in this product, written against a statutory deadline and usually
    over more than one sitting. A modal could not be linked to, returned to
    with the back button, or reopened where it was left, and it closed on an
    outside click with whatever was in it.
  */
  it("names the act rather than the record it would add", async () => {
    renderPage();
    expect(await screen.findByRole("button", { name: "Start AUSTRAC Report" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New Draft/i })).not.toBeInTheDocument();
  });

  it("opens no dialog at all — it navigates", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Start AUSTRAC Report" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/admin/aml/austrac/new");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("edits an existing report at its own address", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /^Edit$/ }));
    expect(screen.getByTestId("where")).toHaveTextContent("/admin/aml/austrac/r1/edit");
  });

  it("selects the report the draft page hands back", async () => {
    /* The dialog closed onto the report it had just written. Losing that on
       the move to a page is the one thing it could have cost, so the page
       returns with `?report=` and the hub opens it. */
    renderPage("/admin/aml/austrac?report=r1");
    await waitFor(() => expect(getReport).toHaveBeenCalledWith("r1"));
  });
});

describe("the guided path", () => {
  it("renders, and leads with what to do next", async () => {
    renderPage();
    fireEvent.click(await screen.findByText("SMR — unusual cash deposits"));
    await waitFor(() =>
      expect(screen.getByText("Suspicious Matter Report")).toBeInTheDocument());
    /* Five numbered steps, one of them open. It was six: a "clear the
       checks" step whose only completion was routing the report to the
       MLRO, and the MLRO's approval. Without the routing the two count the
       same fact, and two steps counting one thing is how a header comes to
       disagree with the list under it. */
    /* Twice: the header leads with the open step, and the list names it. */
    expect((await screen.findAllByText("Review the checks and approve it")).length)
      .toBeGreaterThan(0);
    expect(screen.queryByText("MLRO approves it")).not.toBeInTheDocument();
    expect(screen.queryByText("Clear the pre-lodgement checks")).not.toBeInTheDocument();
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

describe("the record download", () => {
  /*
    "Bundle" downloaded the edge function's JSON response — a file that opens
    in a text editor, carries no identity and no branding, and is a developer
    artefact rather than the archive record for a report to a regulator.
  */
  it("names the act rather than the payload", async () => {
    renderPage();
    expect(await screen.findByRole("button", { name: /Record/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Bundle$/i })).not.toBeInTheDocument();
  });

  it("produces a real PDF, under the Aurixa Systems fallback", async () => {
    /* End to end: the export is fetched, the record is built, jsPDF draws
       it, and what reaches the anchor is a PDF whose bytes start `%PDF`.
       The workspace in this test has no brand, so it must issue under the
       platform identity rather than an empty masthead. */
    const created: HTMLAnchorElement[] = [];
    const realCreate = document.createElement.bind(document);
    const spy = vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = realCreate(tag);
      if (tag === "a") { (el as HTMLAnchorElement).click = () => {}; created.push(el as HTMLAnchorElement); }
      return el;
    });
    const blobs: Blob[] = [];
    const realUrl = URL.createObjectURL;
    URL.createObjectURL = ((b: Blob) => { blobs.push(b); return "blob:x"; }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;

    try {
      renderPage();
      fireEvent.click(await screen.findByRole("button", { name: /Record/i }));
      await waitFor(() => expect(blobs.length).toBe(1));
      const head = new Uint8Array(await blobs[0].arrayBuffer()).slice(0, 4);
      expect(String.fromCharCode(...head)).toBe("%PDF");
      expect(blobs[0].size).toBeGreaterThan(1000);
      expect(created.at(-1)?.download).toBe("austrac-smr-AML-2026-00005.pdf");
    } finally {
      spy.mockRestore();
      URL.createObjectURL = realUrl;
    }
  });
});

describe("the guided path leads somewhere", () => {
  it("offers the open step an act that actually runs", async () => {
    /* The card drew "Open" on whichever step was open and the page handled
       three of six keys, so a saved draft rendered a button that did
       nothing at all. */
    renderPage();
    fireEvent.click(await screen.findByText("SMR — unusual cash deposits"));
    const approve = await screen.findByRole("button", { name: /Review and approve/i });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(approve);
    await waitFor(() => expect(mlroSignoff).toHaveBeenCalledWith("r1"));
    expect(screen.queryByRole("button", { name: /^Open$/ })).not.toBeInTheDocument();
  });

  it("never asks anybody to send the report to themselves", async () => {
    /* On a reporting entity where the person drafting the report IS the
       MLRO — most of them — a hand-off step is a report sent from somebody
       to themselves before they can act on it. */
    renderPage();
    fireEvent.click(await screen.findByText("SMR — unusual cash deposits"));
    await screen.findByRole("button", { name: /Review and approve/i });
    expect(screen.queryByRole("button", { name: /Send to the MLRO/i })).not.toBeInTheDocument();
    expect(upsertReport).not.toHaveBeenCalled();
  });

  /* Complete enough to reach the approval, and past its statutory window —
     the one check that can still be outstanding when the approval is the
     open step. A suspicion formed in January is long past three business
     days. */
  const withGaps = { ...REPORT, metadata: { obligation_at: "2026-01-05T00:00:00.000Z" } };

  it("approves a complete report in one click, as the table always did", async () => {
    renderPage();
    fireEvent.click(await screen.findByText("SMR — unusual cash deposits"));
    const confirmed = vi.spyOn(window, "confirm");
    fireEvent.click(await screen.findByRole("button", { name: /Review and approve/i }));
    await waitFor(() => expect(mlroSignoff).toHaveBeenCalledWith("r1"));
    expect(confirmed).not.toHaveBeenCalled();
  });

  it("asks before approving a report whose checks are still outstanding", async () => {
    /* Approving an incomplete report is legitimate and is recorded against
       the person who did it — but it should never happen by accident. */
    listReports.mockResolvedValue([withGaps]);
    getReport.mockResolvedValue({ report: withGaps, versions: [], submissions: [] });
    renderPage();
    fireEvent.click(await screen.findByText("SMR — unusual cash deposits"));
    const confirmed = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(await screen.findByRole("button", { name: /Review and approve/i }));
    expect(confirmed).toHaveBeenCalled();
    expect(mlroSignoff).not.toHaveBeenCalled();
  });

  it("does not count the steps the approval itself unlocks against it", async () => {
    /* Lodgement and the receipt come AFTER approval. Listing them as
       outstanding would ask the approver to answer for the steps their own
       decision unlocks. */
    listReports.mockResolvedValue([withGaps]);
    getReport.mockResolvedValue({ report: withGaps, versions: [], submissions: [] });
    renderPage();
    fireEvent.click(await screen.findByText("SMR — unusual cash deposits"));
    const confirmed = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(await screen.findByRole("button", { name: /Review and approve/i }));
    const asked = String(confirmed.mock.calls[0]?.[0] ?? "");
    expect(asked).toMatch(/Within the statutory window/);
    expect(asked).not.toMatch(/Lodged at AUSTRAC Online/);
    expect(asked).not.toMatch(/Receipt on file/);
    expect(asked).not.toMatch(/MLRO approval/);
  });
});

describe("which report am I looking at", () => {
  it("marks the selected row, and says so in words", async () => {
    /* A 40%-opacity muted tint on a dark theme is the same charcoal as the
       row beside it. Three signals rather than one. */
    renderPage();
    fireEvent.click(await screen.findByText("SMR — unusual cash deposits"));
    const row = screen.getByText("SMR — unusual cash deposits").closest("tr")!;
    await waitFor(() => expect(row).toHaveAttribute("aria-selected", "true"));
    expect(within(row).getByText(/Viewing/i)).toBeInTheDocument();
  });

  it("can be driven from the keyboard", async () => {
    /* The row was click-only, so the register could not be worked without
       a mouse at all. */
    renderPage();
    const row = (await screen.findByText("SMR — unusual cash deposits")).closest("tr")!;
    expect(row).toHaveAttribute("tabIndex", "0");
    fireEvent.keyDown(row, { key: "Enter" });
    await waitFor(() => expect(getReport).toHaveBeenCalledWith("r1"));
  });

  it("heads the detail panel with the obligation and the status", async () => {
    /* It said "Detail" with the title in muted small print, naming neither
       the obligation nor the status. */
    renderPage();
    fireEvent.click(await screen.findByText("SMR — unusual cash deposits"));
    await waitFor(() =>
      expect(screen.getByText("Suspicious Matter Report")).toBeInTheDocument());
    expect(screen.getAllByText(/^SMR$/).length).toBeGreaterThan(0);
  });

  it("tints the suspicious matter report and nothing else", () => {
    /* In the dark theme `--primary` and `--warning` are both the brand gold,
       so a tone per obligation renders as five near-identical amber chips.
       The three letters tell the obligations apart; colour is reserved for
       the one whose existence may not be disclosed. */
    const src = read("src/pages/aml/AmlAustracReporting.tsx");
    const i = src.indexOf("const KIND_TONE");
    const block = src.slice(i, src.indexOf("};", i));
    expect(block).toContain("smr:");
    for (const other of ["ttr:", "ifti:", "compliance:", "annual:"]) {
      expect(block).not.toContain(other);
    }
  });

  it("invites a choice when nothing is selected", async () => {
    listReports.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText(/Choose a report on the left/i)).toBeInTheDocument();
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
