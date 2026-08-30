/**
 * The AUSTRAC path — the rules that make it a compliance record rather than
 * a form.
 */
import { describe, it, expect } from "vitest";
import {
  AUSTRAC_OBLIGATIONS, MIN_NARRATIVE_CHARS, TERRORISM_FINANCING_HOURS,
  addBusinessDays, austracHeadline, austracReadiness, deriveAustracPath,
  lodgementClock, type AustracReportFacts,
} from "./austracReportPath.pure";

const facts = (over: Partial<AustracReportFacts> = {}): AustracReportFacts => ({
  kind: "smr", status: "draft", caseId: "case-1", subjectLabel: "Rugesh Naidu",
  title: "SMR — unusual cash deposits", narrative: "x".repeat(MIN_NARRATIVE_CHARS),
  periodStart: null, periodEnd: null, mlroSignedAt: null, submittedAt: null,
  externalReference: null, receiptReference: null,
  obligationAt: "2026-08-27T00:00:00.000Z", ...over,
});

describe("the statutory clock", () => {
  it("counts BUSINESS days, not calendar days", () => {
    /* A suspicion formed on a Thursday is due the following Tuesday. A naive
       +3 would say Sunday, which is not a day AUSTRAC counts. */
    const thursday = new Date("2026-08-27T00:00:00.000Z");
    expect(thursday.getUTCDay()).toBe(4);
    expect(addBusinessDays(thursday, 3).toISOString().slice(0, 10)).toBe("2026-09-01");
  });

  it("gives each report the window the Act gives it, and names the section", () => {
    expect(AUSTRAC_OBLIGATIONS.smr.businessDays).toBe(3);
    expect(AUSTRAC_OBLIGATIONS.ttr.businessDays).toBe(10);
    expect(AUSTRAC_OBLIGATIONS.ifti.businessDays).toBe(10);
    // The annual compliance report is not a per-report clock.
    expect(AUSTRAC_OBLIGATIONS.compliance_report.businessDays).toBeNull();
    for (const o of Object.values(AUSTRAC_OBLIGATIONS)) {
      expect(o.basis).toMatch(/AML\/CTF Act 2006 \(Cth\) s\.\d+/);
    }
  });

  it("tightens an SMR to 24 hours where terrorism financing is suspected", () => {
    /* The same report under a tighter clock, not a different kind — drafting
       "the wrong one" and reconciling later is not a thing an operator
       should be able to do. */
    const c = lodgementClock({
      kind: "smr", obligationAt: "2026-08-27T00:00:00.000Z", terrorismFinancing: true,
    });
    expect(c.window).toContain(String(TERRORISM_FINANCING_HOURS));
    expect(c.dueAt).toBe("2026-08-28T00:00:00.000Z");
  });

  it("says it is overdue rather than hiding it", () => {
    const c = lodgementClock({
      kind: "smr", obligationAt: "2026-08-01T00:00:00.000Z", now: new Date("2026-09-01T00:00:00Z"),
    });
    expect(c.overdue).toBe(true);
    expect(c.daysRemaining).toBeLessThan(0);
  });

  it("answers with no deadline rather than a wrong one", () => {
    expect(lodgementClock({ kind: "smr", obligationAt: null }).dueAt).toBeNull();
    expect(lodgementClock({ kind: "smr", obligationAt: "not-a-date" }).dueAt).toBeNull();
  });
});

describe("the pre-lodgement checks", () => {
  it("treats a report filed against nobody as the blocker it is", () => {
    /* `reports.case_id` existed from the first migration and the draft
       dialog never set it. A report about a customer that is not on that
       customer's file is not on file. */
    const c = austracReadiness(facts({ caseId: null })).find((x) => x.key === "customer")!;
    expect(c.state).toBe("blocked");
    expect(austracHeadline(facts({ caseId: null }))).toMatch(/not yet filed against a customer/i);
  });

  it("says the platform never lodges, on the step where it matters", () => {
    const c = austracReadiness(facts({ mlroSignedAt: "2026-08-28T00:00:00Z" }))
      .find((x) => x.key === "lodgement")!;
    expect(c.detail).toMatch(/your own AUSTRAC Online account/i);
    expect(c.detail).toMatch(/never submits on your behalf/i);
  });

  it("never blocks what the SERVER is responsible for refusing", () => {
    /* Two gates is how one of them becomes wrong. The server already
       refuses an unapproved report, a submission with no evidence, an SMR
       with no AUSTRAC reference and a missing tipping-off attestation. */
    const states = austracReadiness(facts()).map((c) => c.state);
    expect(states).not.toContain(undefined);
    // Only two things can read `blocked`: no customer, and past the clock.
    const blocked = austracReadiness(facts({ caseId: null, obligationAt: "2020-01-01T00:00:00Z" }))
      .filter((c) => c.state === "blocked").map((c) => c.key);
    expect(blocked.sort()).toEqual(["clock", "customer"]);
  });

  it("keeps the receipt as evidence the obligation was discharged", () => {
    const done = austracReadiness(facts({
      mlroSignedAt: "a", submittedAt: "b", externalReference: "AUS-1", receiptReference: "RCPT-9",
    }));
    expect(done.every((c) => c.state === "done")).toBe(true);
  });
});

describe("the path", () => {
  it("has exactly one open step, and it is the first unfinished one", () => {
    const open = deriveAustracPath(facts()).filter((s) => s.state === "open");
    expect(open).toHaveLength(1);
    expect(open[0].key).toBe("review");
  });

  it("opens on the customer when there is none", () => {
    expect(deriveAustracPath(facts({ caseId: null }))[0].state).toBe("open");
  });

  it("runs out of open steps once the receipt is on file", () => {
    const done = deriveAustracPath(facts({
      mlroSignedAt: "a", submittedAt: "b", receiptReference: "c", status: "acknowledged",
    }));
    expect(done.every((s) => s.state === "done")).toBe(true);
    expect(austracHeadline(facts({
      mlroSignedAt: "a", submittedAt: "b", receiptReference: "c",
    }))).toMatch(/discharged/i);
  });

  it("is numbered from one, in order", () => {
    expect(deriveAustracPath(facts()).map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
