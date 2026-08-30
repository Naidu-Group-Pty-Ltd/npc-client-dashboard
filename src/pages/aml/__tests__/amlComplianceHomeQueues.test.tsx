/**
 * Compliance Home — what belongs in "Your queues", and how much of the page
 * six single-digit numbers are allowed to take.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const listCases = vi.fn();
const monitoringSummary = vi.fn();

vi.mock("@/lib/aml/amlCasesApi", () => ({
  amlCasesApi: { list: (a: unknown) => listCases(a) },
}));
vi.mock("@/lib/aml/amlMonitoringApi", () => ({
  amlMonitoringApi: { summary: () => monitoringSummary() },
}));
vi.mock("@/hooks/useAmlAccess", () => ({
  useAmlAccess: () => ({
    roles: new Set(["mlro"]), hasAnyRole: true, canWrite: true, isMlro: true, loading: false,
  }),
}));
vi.mock("@/lib/aml/useAmlV3Flags", () => ({
  useAmlV3Flags: () => ({ complianceHomeV3: false, loading: false }),
}));

import AmlOverview from "../AmlOverview";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

beforeEach(() => {
  vi.clearAllMocks();
  listCases.mockResolvedValue({
    cases: [{
      id: "c1", case_reference: "AML-2026-00005", subject_display_name: "Rugesh Naidu",
      status: "cleared", risk_rating: "low", subject_type: "individual",
      opened_at: "2026-08-01T00:00:00Z", created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-01T00:00:00Z", metadata: {},
    }],
    total: 6,
  });
  monitoringSummary.mockResolvedValue({
    open_alerts: 0, critical_alerts: 0, unprocessed_events: 0,
    pending_reviews: 2, overdue_reviews: 0,
  });
});

const renderHome = () => render(<MemoryRouter><AmlOverview /></MemoryRouter>);

describe("a queue is work that is waiting for somebody", () => {
  const queueList = async () =>
    (await screen.findByText("Your queues")).closest("div[class]")!.parentElement!;

  it("does not offer Transactions", async () => {
    /* `aml.transactions` and `aml.transaction_parties` both hold zero rows,
       and the page it pointed at is a PER-CASE surface that loads with
       `cases[0]` selected. That is exactly why the navigation audit folded
       Transactions into Customer Compliance as a stage inside a named
       customer's case and took it out of the strip — leaving it here
       contradicted a decision the product had already made. */
    renderHome();
    await screen.findByText("Your queues");
    expect(screen.queryByRole("link", { name: /Open transactions/i })).not.toBeInTheDocument();
  });

  it("does not offer Configuration as a queue", async () => {
    /* Nothing waits there. It is set once, revisited rarely, and step-up
       protected — an administrator's destination rather than a shift's
       work. */
    renderHome();
    const queues = await queueList();
    expect(within(queues).queryByRole("link", { name: /Open configuration/i })).not.toBeInTheDocument();
  });

  it("keeps the four that are", async () => {
    renderHome();
    await screen.findByText("Your queues");
    for (const cta of [/Open register/i, /Open monitoring/i, /Open investigations/i]) {
      expect(screen.getByRole("link", { name: cta })).toBeInTheDocument();
    }
    /* Two of these: the queue tile, and the "jump back into your queue"
       hint above it, which is the MLRO's landing suggestion. */
    expect(screen.getAllByRole("link", { name: /Open AUSTRAC Hub/i }).length).toBeGreaterThan(0);
  });
});

describe("Configuration left the list, not the product", () => {
  it("is still reachable from the page, for somebody who may configure", async () => {
    /* This is the whole reason it was not simply deleted: it is the only
       discoverable route to the sanctions register's health, and hiding the
       page is what once stranded that behind a blocked case. */
    renderHome();
    const link = await screen.findByRole("link", { name: /Configuration/i });
    expect(link).toHaveAttribute("href", "/admin/aml/configuration");
  });

  it("the route itself is untouched", () => {
    /* Hiding is never deleting. Every AML route is declared
       unconditionally, so a bookmark and a deep link both still land. */
    expect(read("src/App.tsx")).toContain('path="configuration"');
    expect(read("src/App.tsx")).toContain('path="transactions"');
  });

  it("Stage 5 still sends a blocked screening to the register's health", () => {
    const routes = read("src/lib/aml/amlRoutes.ts");
    expect(routes).toContain("ADMIN_AML_LIST_HEALTH_PATH");
    expect(routes).toContain("sanctions-list-health");
  });
});

describe("six numbers, one strip", () => {
  it("draws the case and monitoring readings without six cards around them", async () => {
    /* Six borders, six paddings and six headers around six single-digit
       numbers took more height than the case list underneath them. */
    renderHome();
    expect(await screen.findByRole("heading", { name: "Customer cases" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Monitoring" })).toBeInTheDocument();
    const page = read("src/pages/aml/AmlOverview.tsx");
    expect(page).not.toContain("AmlPageSection");
    expect((page.match(/dense\n/g) ?? []).length).toBe(6);
  });

  it("still deep-links every reading to where it is worked", async () => {
    renderHome();
    await waitFor(() => expect(monitoringSummary).toHaveBeenCalled());
    expect(screen.getByRole("link", { name: /Awaiting decision/i }))
      .toHaveAttribute("href", "/admin/aml/cases?view=awaiting_decision");
    expect(screen.getAllByRole("link", { name: /Periodic reviews/i })[0])
      .toHaveAttribute("href", "/admin/aml/monitoring");
  });

  it("never paints a fabricated zero before the fetch settles", async () => {
    /* The dense cell keeps the loading and unavailable readings the card
       had: a zero that has not been measured is a lie about a queue. */
    monitoringSummary.mockReturnValue(new Promise(() => {}));
    renderHome();
    expect(await screen.findByText(/Loading Open alerts/i)).toBeInTheDocument();
  });
});
