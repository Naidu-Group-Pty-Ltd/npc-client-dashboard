/**
 * The AUSTRAC bundle as a document — what it says, and what it must never
 * leave out.
 */
import { describe, it, expect } from "vitest";
import {
  austracBundleFilename, austracBundleIdentity, buildAustracBundleRecord,
  type AustracBundle,
} from "./austracBundleRecord.pure";
import { resolveRecordBrand, AURIXA_FALLBACK_NAME } from "./submissionRecordBrand";

const NOW = new Date("2026-08-30T05:00:00.000Z");

const bundle = (over: Partial<AustracBundle["report"]> = {}, rest: Partial<AustracBundle> = {}): AustracBundle => ({
  report: {
    id: "5bb2c2dc-b556-4148-8549-6bbcee72a581",
    kind: "smr",
    case_id: "8b668f2f-0132-436f-b32c-d6709ea69526",
    reference_code: "1234567",
    title: "Unexplained third-party funds",
    status: "draft",
    narrative: "Funds arrived from a third party with no explained connection to the buyer.",
    reporting_period_start: null,
    reporting_period_end: null,
    mlro_signed_at: null,
    submitted_at: null,
    acknowledged_at: null,
    metadata: { obligation_at: "2026-08-27T09:00:00.000Z", terrorism_financing: false },
    created_at: "2026-08-30T07:28:37.000Z",
    updated_at: "2026-08-30T07:28:37.000Z",
    ...over,
  },
  versions: [{ version: 1, author_label: "R Naidu", change_note: "Draft created", created_at: "2026-08-30T07:28:37.000Z", content_hash: "abc123def4567890aa" }],
  submissions: [],
  exported_at: "2026-08-30T05:00:00.000Z",
  exported_by: "R Naidu",
  ...rest,
});

const build = (b = bundle()) => buildAustracBundleRecord({
  bundle: b, contentHash: "f".repeat(64),
  subjectLabel: "Rugesh Naidu", caseReference: "AML-2026-00005",
  issuedBy: "Aurixa Systems", now: NOW,
});

const allText = (r: ReturnType<typeof build>) =>
  JSON.stringify([r.headerFields, r.sections, r.notice, r.subject]);

describe("the document says what it is", () => {
  it("names the obligation, the customer and the deadline", () => {
    const text = allText(build());
    expect(text).toContain("Suspicious Matter Report");
    expect(text).toContain("AML/CTF Act 2006 (Cth) s.41");
    expect(text).toContain("Rugesh Naidu");
    expect(text).toContain("AML-2026-00005");
    // 27 August 2026 is a Thursday; three business days is Tuesday 1 September.
    expect(text).toContain("1 Sep 2026");
  });

  it("carries the narrative in full", () => {
    expect(allText(build())).toContain("no explained connection to the buyer");
  });

  it("says the platform never lodges, when nothing has been lodged", () => {
    const lodgement = build().sections.find((s) => s.key === "lodgement");
    expect(JSON.stringify(lodgement)).toMatch(/holds no AUSTRAC credentials/i);
  });

  it("carries the server's hash rather than computing one of its own", () => {
    expect(allText(build())).toContain("f".repeat(64));
  });

  it("never renders a database identifier as a label", () => {
    /* `awaiting_mlro` is vocabulary the schema uses and an operator does
       not. A test in the Passport register pins the same rule. */
    const b = bundle({ status: "awaiting_mlro" });
    const rendered = JSON.stringify([build(b).headerFields, build(b).sections.map((s) => s.blocks)]);
    expect(rendered).not.toMatch(/awaiting_mlro/);
    expect(rendered).toContain("Awaiting mlro");
  });
});

describe("tipping off travels with the document", () => {
  it("warns on a suspicious matter report", () => {
    /* This document is printable, e-mailable and leaveable on a desk. s.123
       makes disclosing an SMR an offence, so the prohibition is ON the page
       or it does not travel at all. */
    expect(build().notice).toMatch(/s\.123/);
    expect(build().notice).toMatch(/Do not provide this document to the customer/i);
  });

  it("does not warn on a threshold transaction report", () => {
    /* s.123 attaches to the suspicious matter alone. Carrying it everywhere
       is how an operator learns to read past it. */
    expect(build(bundle({ kind: "ttr" })).notice).not.toMatch(/s\.123/);
  });
});

describe("the identity and the filename", () => {
  it("calls itself an AUSTRAC record, not a submission", () => {
    /* The shared renderer used to write "Submission v1" across every
       document it drew, which is wrong for a report that is not a
       submission and has no submission version. */
    const record = build();
    const identity = austracBundleIdentity(record, { kind: "smr" });
    expect(identity.title).toBe("AUSTRAC report record");
    expect(identity.identityLine).toContain("Suspicious Matter Report");
    expect(identity.identityLine).not.toMatch(/Submission v/);
    expect(identity.footLine).not.toMatch(/Submission v/);
  });

  it("names the file by the customer's reference, not a uuid", () => {
    expect(austracBundleFilename({ id: "uuid-x", kind: "smr" }, "AML-2026-00005"))
      .toBe("austrac-smr-AML-2026-00005.html");
    // No case linked: the report id is all there is, and it still downloads.
    expect(austracBundleFilename({ id: "uuid-x", kind: "ttr" }, null))
      .toBe("austrac-ttr-uuid-x.html");
  });
});

describe("white labelling", () => {
  it("falls back to Aurixa Systems when the workspace has no brand", () => {
    const brand = resolveRecordBrand({ companyName: "Dashboard", brandColor: null } as never);
    expect(brand.name).toBe(AURIXA_FALLBACK_NAME);
    expect(brand.tenantBranded).toBe(false);
    expect(allText(build())).toContain("Aurixa Systems");
  });

  it("issues under the workspace's own name when it has one", () => {
    const brand = resolveRecordBrand({
      companyName: "Naidu Property Consulting Services", brandColor: null,
    } as never);
    expect(brand.name).toBe("Naidu Property Consulting Services");
    expect(brand.tenantBranded).toBe(true);
    const record = buildAustracBundleRecord({
      bundle: bundle(), contentHash: "x", subjectLabel: null, caseReference: null,
      issuedBy: brand.name, now: NOW,
    });
    expect(allText(record)).toContain("Naidu Property Consulting Services");
  });
});

describe("it survives a thin bundle", () => {
  it("renders with no versions, no submissions and no narrative", () => {
    const thin = bundle({ narrative: null, title: null, metadata: {} }, { versions: [], submissions: [] });
    const record = build(thin);
    expect(record.sections.length).toBeGreaterThan(3);
    expect(allText(record)).toContain("No narrative was recorded");
    expect(allText(record)).toContain("No versions have been recorded");
  });

  it("does not throw on a kind the obligation table cannot place", () => {
    /* `reports.kind` accepts five values and the table is keyed by four. */
    const record = build(bundle({ kind: "annual" }));
    expect(record.subject).toBeTruthy();
    expect(austracBundleIdentity(record, { kind: "annual" }).title).toBe("AUSTRAC report record");
  });
});
