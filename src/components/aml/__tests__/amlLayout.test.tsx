import { readFileSync } from "node:fs";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AmlLayout } from "../AmlLayout";
import type { AmlRole } from "@/hooks/useAmlAccess";

class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
Object.defineProperty(globalThis, "ResizeObserver", { writable: true, value: TestResizeObserver });

let mockRoles = new Set<AmlRole>(["analyst", "reviewer", "mlro", "auditor"]);
let mockV3Nav = false;

vi.mock("@/hooks/useAmlAccess", () => ({
  useAmlAccess: () => ({
    loading: false, flagEnabled: true, roles: mockRoles,
    hasAnyRole: mockRoles.size > 0,
    canWrite: true, isMlro: mockRoles.has("mlro"), refresh: vi.fn(),
  }),
}));
vi.mock("@/lib/aml/useAmlTerminology", () => ({
  useAmlTerminology: () => ({ t: (s: string) => s, overrides: {}, refresh: vi.fn() }),
}));
vi.mock("@/lib/aml/useAmlV3Flags", () => ({
  useAmlV3Flags: () => ({
    v3Nav: mockV3Nav, startClientCompliance: false, complianceHome: false,
    caseWorkspace: false, regulatoryHub: false, terminologyEditor: false,
    metricsRelocation: false, orgSettings: false, loading: false,
  }),
}));

function renderShell(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/aml" element={<AmlLayout />}>
          <Route index element={<div data-testid="page-home" />} />
          <Route path="cases" element={<div data-testid="page-cases" />} />
          <Route path="monitoring" element={<div data-testid="page-monitoring" />} />
          <Route path="configuration" element={<div data-testid="page-configuration" />} />
          <Route path="counterparty" element={<div data-testid="page-counterparty" />} />
          <Route path="transactions" element={<div data-testid="page-transactions" />} />
          <Route path="governance" element={<div data-testid="page-governance" />} />
          <Route path="launch-ops" element={<div data-testid="page-launch-ops" />} />
          <Route path="partner-operations" element={<div data-testid="page-partner-ops" />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockRoles = new Set<AmlRole>(["analyst", "reviewer", "mlro", "auditor"]);
  mockV3Nav = false;
});

describe("AmlLayout — legacy (V2) navigation", () => {
  it("renders the three workspaces compliance work happens in", () => {
    /* Transaction Compliance was retired (a workspace holding one tab is not
       a workspace) and Organisation Settings followed once nothing in it was
       an operator's daily work. Organisation Settings still EXISTS — it owns
       its URLs so those pages keep their chrome — it is simply not drawn. */
    renderShell("/admin/aml");
    const nav = screen.getByRole("navigation", { name: "AML workspaces" });
    for (const label of [
      "Compliance Home", "Customer Compliance", "Regulatory & Assurance",
    ]) {
      expect(within(nav).getByText(label)).toBeInTheDocument();
    }
    for (const gone of ["Transaction Compliance", "Organisation Settings"]) {
      expect(within(nav).queryByText(gone)).not.toBeInTheDocument();
    }
  });

  it("keeps the Transactions page inside a workspace after the fold", () => {
    /* The rule the file's own comment records: a destination missing from
       `paths` renders with no secondary strip and Compliance Home
       highlighted — reachable, and looking broken. */
    renderShell("/admin/aml/transactions");
    const nav = screen.getByRole("navigation", { name: "AML workspaces" });
    const customer = within(nav).getByText("Customer Compliance").closest("a")!;
    expect(customer).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("navigation", { name: /Customer Compliance sections/ }),
    ).toBeInTheDocument();
  });

  it("marks the active workspace and secondary entry with aria-current", () => {
    renderShell("/admin/aml/cases");
    const nav = screen.getByRole("navigation", { name: "AML workspaces" });
    const customer = within(nav).getByText("Customer Compliance").closest("a")!;
    expect(customer).toHaveAttribute("aria-current", "page");
    const secondary = screen.getByRole("navigation", { name: /Customer Compliance sections/ });
    const register = within(secondary).getByText("Register").closest("a")!;
    expect(register).toHaveAttribute("aria-current", "page");
    // Legacy customer workspace still publishes the per-discipline pages.
    /* The strip carries the two CROSS-CASE entry points and no per-case
       topic. Asserting the absence as well as the presence is the point:
       Verification, Screening, Risk and Funding & Finance are stages inside
       a named customer's case now, and a seat here is what let an operator
       act on whichever case happened to be created last. */
    expect(within(secondary).getByText("Compliance Passport")).toBeInTheDocument();
    for (const gone of ["Verification", "Screening", "Risk", "Funding & Finance"]) {
      expect(within(secondary).queryByText(gone)).not.toBeInTheDocument();
    }
  });

  it("offers no build or platform tooling in the navigation", () => {
    /* The rule, not the roster: an operator running AML/CTF is offered
       compliance surfaces. Launch Operations is rollout stages, acceptance
       scenarios and release certification; Partner Operations renders a
       deployment preflight table; and Governance, on a deployment where
       `aml_v3_org_settings` is off, renders five platform tabs and no AML
       content at all. All three keep their routes. */
    renderShell("/admin/aml");
    const nav = screen.getByRole("navigation", { name: "AML workspaces" });
    for (const gone of ["Launch Operations", "Partner Operations", "Governance"]) {
      expect(within(nav).queryByText(gone)).not.toBeInTheDocument();
    }
  });

  it("keeps every compliance surface in Regulatory & Assurance", () => {
    renderShell("/admin/aml/monitoring");
    const secondary = screen.getByRole("navigation", { name: /Regulatory & Assurance sections/ });
    for (const kept of ["Monitoring", "Investigations & EDD", "AUSTRAC Hub", "Records & Privacy"]) {
      expect(within(secondary).getByText(kept)).toBeInTheDocument();
    }
    expect(within(secondary).queryByText("Governance")).not.toBeInTheDocument();
  });

  it("Configuration is reachable, and no longer offered in the navigation", () => {
    /* It leaves the strip but not the product: step-up protected, set once
       and revisited rarely, and the place Stage 5 sends an administrator
       when screening cannot run. Hiding the PAGE would strand the sanctions
       register's health behind a blocked case again. */
    renderShell("/admin/aml/configuration");
    const nav = screen.getByRole("navigation", { name: "AML workspaces" });
    expect(within(nav).queryByText("Organisation Settings")).not.toBeInTheDocument();
    expect(screen.getByTestId("page-configuration")).toBeInTheDocument();
    expect(readFileSync("src/pages/aml/AmlConfiguration.tsx", "utf8"))
      .toContain("<SanctionsListHealth />");
    expect(readFileSync("src/lib/aml/amlRoutes.ts", "utf8"))
      .toContain("ADMIN_AML_LIST_HEALTH_PATH");
  });

  it("offers exactly ONE door to Configuration, and it is capability-gated", () => {
    /* Compliance Home carried two — a tile, and a button sitting directly
       under a comment saying restricted affordances live in the tiles. The
       tile survives, gated on `aml.configure`, so an operator holding only
       `aml.view` sees Configuration nowhere at all. */
    const home = readFileSync("src/pages/aml/AmlOverview.tsx", "utf8");
    const code = home.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(code.match(/\/admin\/aml\/configuration/g) ?? []).toHaveLength(1);
    expect(home).toContain('capability: "aml.configure"');
  });

  it("a page with no tab still BELONGS to one workspace", () => {
    /* The failure this guards is the one the file records twice: a path
       belonging to nothing renders with no section strip and Compliance Home
       highlighted — reachable, and looking broken. A hidden workspace still
       owns its URLs, so the trail names where the page lives even though no
       tab is drawn for it. */
    for (const path of [
      "/admin/aml/configuration",
      "/admin/aml/governance",
      "/admin/aml/launch-ops",
      "/admin/aml/partner-operations",
    ]) {
      const { unmount } = renderShell(path);
      const header = screen.getByRole("banner");
      expect(within(header).getAllByText("Organisation Settings").length)
        .toBeGreaterThan(0);
      unmount();
    }
  });

  it("shows the workspace › section context trail off the home page", () => {
    renderShell("/admin/aml/monitoring");
    const header = screen.getByRole("banner");
    expect(within(header).getAllByText("Regulatory & Assurance").length).toBeGreaterThan(0);
    expect(within(header).getAllByText("Monitoring").length).toBeGreaterThan(0);
  });

  it("hides capability-restricted entries: an auditor sees no Configuration", () => {
    mockRoles = new Set<AmlRole>(["auditor"]);
    renderShell("/admin/aml");
    const nav = screen.getByRole("navigation", { name: "AML workspaces" });
    expect(within(nav).queryByText("Transaction Compliance")).not.toBeInTheDocument();
    expect(within(nav).getByText("Regulatory & Assurance")).toBeInTheDocument();
    // Secondary Configuration entry (aml.configure) never renders for auditors.
    renderShell("/admin/aml/configuration");
    expect(screen.queryByText("Configuration")).not.toBeInTheDocument();
  });

  it("exposes labelled mobile selects instead of a horizontally-scrolling nav", () => {
    renderShell("/admin/aml/cases");
    expect(screen.getByRole("combobox", { name: "AML workspace" })).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Customer Compliance section" }),
    ).toBeInTheDocument();
  });

  it("never renders role chips or internal role metadata in the shell", () => {
    renderShell("/admin/aml");
    const header = screen.getByRole("banner");
    expect(within(header).queryByText(/analyst/i)).not.toBeInTheDocument();
    expect(within(header).queryByText(/mlro/i)).not.toBeInTheDocument();
    expect(within(header).queryByText(/aml_v3/)).not.toBeInTheDocument();
  });
});

describe("AmlLayout — V3 navigation (aml_v3_nav)", () => {
  beforeEach(() => { mockV3Nav = true; });

  it("limits Customer Compliance to Cases and the Compliance Passport", () => {
    /* The rule, not the roster: the workspace offers only the two CROSS-CASE
       entry points, and every per-case topic is reached by opening a named
       customer. The Intake Queue that used to sit here was a placeholder page
       and is gone entirely. */
    renderShell("/admin/aml/cases");
    const secondary = screen.getByRole("navigation", { name: /Customer Compliance sections/ });
    expect(within(secondary).getByText("Cases")).toBeInTheDocument();
    expect(within(secondary).getByText("Compliance Passport")).toBeInTheDocument();
    for (const gone of ["My Queue", "Intake Queue", "Verification", "Screening", "Risk"]) {
      expect(within(secondary).queryByText(gone)).not.toBeInTheDocument();
    }
  });


  it("keeps legacy alias URLs inside the customer workspace for matching", () => {
    // /admin/aml/counterparty belongs to Transaction Compliance in V3.
    renderShell("/admin/aml/counterparty");
    const nav = screen.getByRole("navigation", { name: "AML workspaces" });
    const tx = within(nav).getByText("Transaction Compliance").closest("a")!;
    expect(tx).toHaveAttribute("aria-current", "page");
    const secondary = screen.getByRole("navigation", { name: /Transaction Compliance sections/ });
    const due = within(secondary).getByText("Counterparty Due").closest("a")!;
    expect(due).toHaveAttribute("aria-current", "page");
  });

  it("puts Governance & Contacts first in Organisation Settings", () => {
    renderShell("/admin/aml/configuration");
    const secondary = screen.getByRole("navigation", { name: /Organisation Settings sections/ });
    const labels = within(secondary).getAllByRole("link").map((a) => a.textContent);
    expect(labels[0]).toBe("Governance & Contacts");
    expect(labels).toContain("Configuration");
  });
});
