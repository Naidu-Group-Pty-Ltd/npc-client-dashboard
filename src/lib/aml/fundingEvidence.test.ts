import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DECLARED_SOURCE_TYPE,
  draftsFromDeclaredFunding,
  fundingProgress,
  passportSofStampReadiness,
} from "@/lib/aml/fundingEvidence.pure";

/**
 * The customer declared; the analyst records and verifies; the Passport
 * stamps. Each hand-off has a rule, and each rule has a way to go quietly
 * wrong that these tests hold shut.
 */

const declared = (over = {}) => ({
  deposit: "200000",
  sources: ["Salary savings", "Loan / mortgage"],
  overseas: "no",
  narrative: "Family and savings ",
  institutions: "Cba",
  ...over,
});

const item = (over = {}) => ({
  id: "s1", source_type: "savings", description: "Salary savings",
  amount: null, currency: "AUD", verified: false, verified_at: null,
  ...over,
});

describe("drafts from the customer's declaration", () => {
  it("maps the portal's labels onto source types, keeping the words", () => {
    const drafts = draftsFromDeclaredFunding(declared(), []);
    expect(drafts.map((d) => d.source_type)).toEqual(["savings", "loan"]);
    // The customer's own words survive as the description — the record shows
    // what they said, not what a mapping renamed it to.
    expect(drafts.map((d) => d.description)).toEqual(["Salary savings", "Loan / mortgage"]);
  });

  it("NEVER invents a per-source amount", () => {
    /*
     * The declared deposit is a total across every source. Writing
     * deposit / sources.length against each row would put a number the
     * customer never stated into a CDD evidence table — a fabricated figure
     * is worse than a blank one. The total travels in the notes as context.
     */
    for (const d of draftsFromDeclaredFunding(declared(), [])) {
      expect(d.amount).toBeNull();
      expect(d.notes).toMatch(/declared deposit \$200000 \(total across all sources\)/);
    }
  });

  it("a draft cannot spell verified", () => {
    // A declaration is evidence towards verification, never the
    // verification. The type has no `verified` field at all, and the note
    // says where the words came from.
    for (const d of draftsFromDeclaredFunding(declared(), [])) {
      expect("verified" in d).toBe(false);
      expect(d.notes).toMatch(/declared by the customer/i);
    }
  });

  it("an already-recorded source is not offered again", () => {
    const drafts = draftsFromDeclaredFunding(declared(), [item()]);
    expect(drafts.map((d) => d.description)).toEqual(["Loan / mortgage"]);
  });

  it("an unrecognised label becomes `other` with the label kept verbatim", () => {
    // The failure mode of a new portal option is an ugly code, never a
    // silently wrong classification.
    const drafts = draftsFromDeclaredFunding(
      declared({ sources: ["Cryptocurrency windfall"] }), []);
    expect(drafts[0].source_type).toBe("other");
    expect(drafts[0].description).toBe("Cryptocurrency windfall");
  });

  it("no declaration, or no sources, seeds nothing", () => {
    expect(draftsFromDeclaredFunding(null, [])).toEqual([]);
    expect(draftsFromDeclaredFunding(declared({ sources: [] }), [])).toEqual([]);
    expect(draftsFromDeclaredFunding(declared({ sources: "not-an-array" }), [])).toEqual([]);
  });
});

describe("where the stage stands", () => {
  it("an unverified source is named a claim, not evidence", () => {
    const p = fundingProgress([item(), item({ id: "s2", verified: true, verified_at: "2026-08-25T00:00:00Z" })]);
    expect(p.settled).toBe(false);
    expect(p.sentence).toMatch(/a claim, not evidence/i);
  });

  it("settled means every recorded source verified, and at least one", () => {
    expect(fundingProgress([]).settled).toBe(false);
    expect(fundingProgress([item({ verified: true })]).settled).toBe(true);
  });
});

describe("what the Passport is promised", () => {
  it("recording alone earns nothing, and says so", () => {
    const r = passportSofStampReadiness([item()]);
    expect(r.earned).toBe(false);
    expect(r.sentence).toMatch(/recording alone does not earn it/i);
  });

  it("one verified source earns the stamp, dated by the latest verification", () => {
    const r = passportSofStampReadiness([
      item({ verified: true, verified_at: "2026-08-20T10:00:00Z" }),
      item({ id: "s2", verified: true, verified_at: "2026-08-25T10:00:00Z" }),
      item({ id: "s3", verified: false }),
    ]);
    expect(r.earned).toBe(true);
    expect(r.earnedAt).toBe("2026-08-25T10:00:00Z");
    expect(r.sentence).toContain("2026-08-25");
  });

  it("mirrors the passport's own rule, so it cannot promise a stamp the passport will not mint", () => {
    /*
     * The stamp derivation lives in `passportStamps.pure.ts`:
     *
     *   const sofAt = maxDate(input.source_of_funds.filter((r) => r.verified)
     *     .map((r) => r.verified_at));
     *   if (sofAt) make("source_of_funds_reviewed", ...)
     *
     * — at least one verified row, dated by the newest `verified_at`. If that
     * rule ever changes shape, this fails and the mirror gets updated with
     * it, instead of the panel quietly telling analysts something the
     * passport no longer does.
     */
    const src = readFileSync(join(
      __dirname,
      "../../../supabase/functions/_shared/aml/passport/passportStamps.pure.ts",
    ), "utf8");
    expect(src).toMatch(
      /const sofAt = maxDate\(input\.source_of_funds\.filter\(\(r\) => r\.verified\)\.map\(\(r\) => r\.verified_at\)\);/);
    expect(src).toMatch(/if \(sofAt\) make\("source_of_funds_reviewed", sofAt/);
    // And it is client-safe — the sentence tells the analyst the stamp is
    // outward-facing, which is only true while the vocabulary says so.
    expect(src).toMatch(
      /source_of_funds_reviewed: \{ title: "SOURCE OF FUNDS REVIEWED", shape: "rect", tone: "green", client_safe: true \}/);
  });
});

describe("the label map", () => {
  it("is declared lowercase, so lookups cannot miss on case", () => {
    for (const key of Object.keys(DECLARED_SOURCE_TYPE)) {
      expect(key).toBe(key.toLowerCase());
    }
  });
});
