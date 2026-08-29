import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { deriveAmlJourney } from "./journeyModel";
import type { AmlWorkspaceFacts } from "./workspaceViewModel";

/**
 * Where partners live, and what the rail calls each stage.
 *
 * ── The reported confusion ────────────────────────────────────────────
 * "There seems to be a little confusion on the processes involved in the
 * step and the inclusions… I'm not sure if we are going to be doubling up
 * on the partners in the Gate and Passports section 9."
 *
 * That was right. The partner roster — every organisation on the matter and
 * every act on it: send, re-issue, withdraw, onboard — has always lived on
 * the Passport stage. The stage after it carried a read-only echo of the
 * same organisations with no act attached, so neither stage was clearly the
 * partner surface.
 *
 * Worse, that echo read `get_passport_distribution_readiness`, which is
 * gated by `aml_passport_partner_distribution`. Where partners are
 * onboarded one at a time through `grant_access` that flag is off — so the
 * card announced "Passport distribution is not enabled for this deployment"
 * on the stage immediately after six partners had been given the Passport
 * successfully.
 *
 * ── The cut, and why it is here ───────────────────────────────────────
 * Issuing a credential and handing it to the partners entitled to rely on
 * it are ONE piece of work: you cannot share what has not been issued, and
 * the roster is where sharing happens. What keeps the case current
 * afterwards is a different question on a different horizon — years, not
 * days.
 */

/* The stage list as the RAIL receives it — labels and all. Facts are
   irrelevant here: the names are a property of the definitions. */
const stages = deriveAmlJourney({
  caseRow: { id: "c1", status: "cleared", case_stage: "cleared" },
} as unknown as AmlWorkspaceFacts).stages;

const byId = (id: string) => stages.find((s) => s.id === id)!;

describe("the rail calls a stage what the page calls it", () => {
  it("the tile no longer drops the half the stage is about", () => {
    /* "Partners & ongoing CDD" was abbreviated to "Partners" on the rail —
       which named the half that had just moved away, and said nothing
       about the half that stayed. */
    const distribution = byId("distribution");
    expect(distribution.label).toBe("Ongoing CDD");
    expect(distribution.shortLabel).toBe("Ongoing CDD");
  });

  it("the Passport stage says both things it now carries", () => {
    const passport = byId("passport");
    expect(passport.label).toBe("Passport & Partners");
    expect(passport.shortLabel).toBe("Passport & Partners");
  });

  it("no stage's tile contradicts its own heading", () => {
    /* An abbreviation is fine — "Identity verification" → "Identity" is the
       same name, shorter. A tile that names something the heading does not
       is two names for one stage, which is what sent an operator looking
       for partners on the wrong screen. */
    for (const stage of stages) {
      const label = stage.label.toLowerCase();
      const short = stage.shortLabel.toLowerCase();
      expect(
        label.includes(short) || short.includes(label),
        `${stage.id}: "${stage.shortLabel}" is not part of "${stage.label}"`,
      ).toBe(true);
    }
  });

  it("the gate is no longer in the name, because it is no longer decided there", () => {
    // It is granted by the cleared decision and reported here as a fact.
    expect(byId("passport").label).not.toMatch(/service gate/i);
  });
});

describe("partners are on exactly one stage", () => {
  const workspace = readFileSync("src/pages/aml/AmlCaseWorkspace.tsx", "utf8");

  it("the duplicate partner card is DELETED, not merely unmounted", () => {
    /* A dormant component is one import away from putting the second
       register back on the wrong stage. */
    expect(workspace).not.toContain("PartnerDistributionCard");
    expect(workspace).not.toContain("distributionPresentation.pure");
  });

  it("the roster — and every act on it — stays where the Passport is", () => {
    const passportSection = workspace.slice(
      workspace.indexOf('{section === "passport" && ('),
      workspace.indexOf('{section === "monitoring" &&'));
    expect(passportSection).toContain("ReliancePassportSection");
  });

  it("the ongoing-CDD stage carries monitoring and nothing else", () => {
    const monitoringSection = workspace.slice(
      workspace.indexOf('{section === "monitoring" &&'),
      workspace.indexOf("{recordMode && ("));
    expect(monitoringSection).toContain("MonitoringReviewsSection");
    expect(monitoringSection).not.toContain("PartnerDistribution");
    expect(monitoringSection).not.toContain("ReliancePassportSection");
  });

  it("the stage reading stopped reporting distribution readiness", () => {
    /* Two readings about different things, and only one of them was about
       this case. The flag's state is not a fact about a customer. */
    const journey = readFileSync("src/lib/aml/journeyModel.ts", "utf8");
    const stage = journey.slice(
      journey.indexOf("function distributionStage("),
      journey.indexOf("14. Assembly"));
    expect(stage).not.toContain("Passport distribution is not enabled");
    expect(stage).not.toContain("facts.passport");
    expect(stage).toContain("facts.monitoring");
  });

  it("but it still NAMES where the partners are", () => {
    /* Removing a duplicate must not remove the route. */
    const journey = readFileSync("src/lib/aml/journeyModel.ts", "utf8");
    const stage = journey.slice(
      journey.indexOf("function distributionStage("),
      journey.indexOf("14. Assembly"));
    expect(stage).toContain('label: "Passport & partners", section: "passport"');
  });
});
