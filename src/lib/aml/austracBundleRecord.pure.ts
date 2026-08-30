/**
 * The AUSTRAC bundle as a document somebody can actually keep.
 *
 * ── What "Bundle" used to do ──────────────────────────────────────────
 * It downloaded the edge function's JSON response, `JSON.stringify`d with
 * two-space indentation, as `austrac-smr-<uuid>.json`. It opened in a text
 * editor. It carried no identity, no branding, no statement of what it was,
 * and nothing an auditor, a colleague or a regulator's file could use — the
 * archive record for a report to a regulator was a developer artefact.
 *
 * This turns the same bundle into the same kind of document every other
 * white-labelled export in this product produces, and it does it by
 * projecting onto `SubmissionRecord` — the structure the submission-record
 * download already renders. There is no second PDF generator, no second
 * masthead, no second brand resolver: `generateSubmissionRecordPdf` draws
 * this, under the workspace's own brand or the Aurixa Systems fallback.
 *
 * ── Nothing here is a second source ───────────────────────────────────
 * Every value comes from the bundle the SERVER assembled and hashed. This
 * module formats; it does not read the database, does not recompute a
 * deadline the report did not carry, and cannot state anything the export
 * did not contain.
 */
import {
  formatUtc, type RecordField, type RecordSection, type SubmissionRecord,
} from "@/lib/aml/submissionRecord";
import type { RecordDocumentIdentity } from "@/lib/aml/submissionRecordPdf";
import { AUSTRAC_OBLIGATIONS, lodgementClock } from "@/lib/aml/austracReportPath.pure";
import { AUSTRAC_KIND_LABEL, toObligationKind } from "@/lib/aml/austracDraftGuidance.pure";

export interface BundleReport {
  id: string;
  kind: string;
  case_id: string | null;
  reference_code: string | null;
  title: string | null;
  status: string;
  narrative: string | null;
  reporting_period_start: string | null;
  reporting_period_end: string | null;
  mlro_signed_at: string | null;
  submitted_at: string | null;
  acknowledged_at: string | null;
  metadata?: unknown;
  created_at: string | null;
  updated_at: string | null;
}

export interface BundleVersion {
  version: number;
  author_label?: string | null;
  change_note?: string | null;
  created_at?: string | null;
  content_hash?: string | null;
}

export interface BundleReceipt {
  receipt_reference?: string | null;
  status?: string | null;
  received_at?: string | null;
  created_at?: string | null;
}

export interface BundleSubmission {
  channel?: string | null;
  external_reference?: string | null;
  export_bundle_path?: string | null;
  submitted_at?: string | null;
  submitted_by_label?: string | null;
  status?: string | null;
  evidence_source?: string | null;
  receipts?: BundleReceipt[] | null;
}

export interface AustracBundle {
  report: BundleReport;
  versions?: BundleVersion[] | null;
  submissions?: BundleSubmission[] | null;
  exported_at?: string | null;
  exported_by?: string | null;
}

const dash = (v: string | null | undefined) => {
  const t = (v ?? "").toString().trim();
  return t.length > 0 ? t : "—";
};

/** Database vocabulary never reaches the page: `awaiting_mlro` → "Awaiting mlro". */
function readable(value: string | null | undefined): string {
  const t = (value ?? "").trim();
  if (!t) return "—";
  const words = t.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The archive document for one AUSTRAC report.
 *
 * `subjectLabel` and `caseReference` are passed in rather than read: the
 * bundle carries `case_id` and nothing else about the customer, and a
 * document that named a customer this export did not identify would be
 * asserting a link nobody recorded.
 */
export function buildAustracBundleRecord(args: {
  bundle: AustracBundle;
  /** The hash the server computed over the bundle it returned. */
  contentHash: string;
  subjectLabel: string | null;
  caseReference: string | null;
  /** Who the document is issued by — the white-label identity. */
  issuedBy: string;
  generatedBy?: string | null;
  now?: Date;
}): SubmissionRecord {
  const { bundle, contentHash, subjectLabel, caseReference, issuedBy } = args;
  const r = bundle.report;
  const kind = toObligationKind(r.kind);
  const obligation = kind ? AUSTRAC_OBLIGATIONS[kind] : null;
  const meta = (r.metadata as Record<string, unknown> | undefined) ?? {};
  const obligationAt = meta.obligation_at ? String(meta.obligation_at) : null;
  const terrorismFinancing = meta.terrorism_financing === true;

  const clock = kind
    ? lodgementClock({ kind, obligationAt, terrorismFinancing, now: args.now })
    : null;

  const headerFields: RecordField[] = [
    { label: "Obligation", value: AUSTRAC_KIND_LABEL[r.kind as keyof typeof AUSTRAC_KIND_LABEL] ?? readable(r.kind) },
    { label: "Status", value: readable(r.status) },
    { label: "Customer", value: dash(subjectLabel ?? caseReference) },
  ];

  const sections: RecordSection[] = [];

  sections.push({
    key: "report",
    title: "The report",
    blocks: [{
      fields: [
        { label: "Obligation", value: obligation ? `${obligation.label} — ${obligation.basis}` : readable(r.kind) },
        { label: "Title", value: dash(r.title) },
        { label: "Your reference", value: dash(r.reference_code) },
        { label: "Customer", value: dash(subjectLabel) },
        { label: "Compliance case", value: dash(caseReference ?? r.case_id) },
        { label: "Status", value: readable(r.status) },
        { label: "Obligation arose", value: formatUtc(obligationAt) },
        ...(terrorismFinancing
          ? [{ label: "Terrorism financing", value: "Yes — the 24-hour window applies" }]
          : []),
        {
          label: "Due",
          value: clock?.dueAt ? `${formatUtc(clock.dueAt)} (${clock.window})` : "No per-report clock",
        },
        { label: "Reporting period", value: r.reporting_period_start || r.reporting_period_end
          ? `${formatUtc(r.reporting_period_start)} — ${formatUtc(r.reporting_period_end)}`
          : "—" },
        { label: "Drafted", value: formatUtc(r.created_at) },
        { label: "Last changed", value: formatUtc(r.updated_at) },
      ],
    }],
  });

  sections.push({
    key: "narrative",
    title: "What happened",
    blocks: [{
      paragraph: (r.narrative ?? "").trim() || "No narrative was recorded on this report.",
    }],
  });

  const versions = bundle.versions ?? [];
  sections.push({
    key: "versions",
    title: "Version history",
    blocks: versions.length
      ? [{
        table: {
          columns: ["Version", "Recorded", "By", "Note", "Content hash"],
          rows: versions.map((v) => [
            `v${v.version}`,
            formatUtc(v.created_at),
            dash(v.author_label),
            dash(v.change_note),
            (v.content_hash ?? "").slice(0, 16) || "—",
          ]),
        },
      }]
      : [{ paragraph: "No versions have been recorded against this report." }],
  });

  const submissions = bundle.submissions ?? [];
  sections.push({
    key: "lodgement",
    title: "Lodgement",
    blocks: submissions.length
      ? [{
        table: {
          columns: ["Lodged", "Channel", "AUSTRAC reference", "By", "Evidence"],
          rows: submissions.map((sub) => [
            formatUtc(sub.submitted_at),
            readable(sub.channel),
            dash(sub.external_reference),
            dash(sub.submitted_by_label),
            dash(sub.export_bundle_path ? "Export bundle" : readable(sub.evidence_source)),
          ]),
        },
      }]
      : [{
        paragraph: "This report has not been lodged. Lodgement is made in the reporting entity's "
          + "own AUSTRAC Online account; this platform holds no AUSTRAC credentials and submits "
          + "nothing on anybody's behalf.",
      }],
  });

  const receipts = submissions.flatMap((sub) => sub.receipts ?? []);
  if (receipts.length) {
    sections.push({
      key: "receipts",
      title: "AUSTRAC acknowledgement",
      blocks: [{
        table: {
          columns: ["Receipt", "Status", "Received"],
          rows: receipts.map((rc) => [
            dash(rc.receipt_reference),
            readable(rc.status),
            formatUtc(rc.received_at ?? rc.created_at),
          ]),
        },
      }],
    });
  }

  sections.push({
    key: "integrity",
    title: "Integrity",
    blocks: [{
      fields: [
        { label: "Report id", value: r.id },
        { label: "Bundle hash (SHA-256)", value: contentHash || "—" },
        { label: "Exported", value: formatUtc(bundle.exported_at) },
        { label: "Exported by", value: dash(bundle.exported_by) },
        { label: "Issued by", value: issuedBy },
      ],
    }, {
      paragraph: "The hash is computed by the server over the exported bundle. It is what a later "
        + "copy of this record is compared against.",
    }],
  });

  const notice = kind === "smr"
    // s.123 makes disclosing a suspicious matter report an offence, and this
    // document is printable, e-mailable and leaveable on a desk. The warning
    // travels with it or it does not travel at all.
    ? "This is an internal record of a Suspicious Matter Report held by the reporting entity. "
      + "It is not the lodgement: lodgement is made in the entity's own AUSTRAC Online account. "
      + "Disclosing to the customer, or to anyone else, that this report has been made or "
      + "considered is an offence under s.123 of the AML/CTF Act 2006 (Cth). Do not provide this "
      + "document to the customer."
    : "This is an internal record of an AUSTRAC report held by the reporting entity. It is not "
      + "the lodgement: lodgement is made in the entity's own AUSTRAC Online account, and this "
      + "platform holds no AUSTRAC credentials.";

  return {
    reference: caseReference ?? r.reference_code ?? r.id,
    subject: (r.title ?? "").trim() || (obligation?.label ?? "AUSTRAC report"),
    version: versions.length ? Math.max(...versions.map((v) => v.version)) : 1,
    audience: "internal",
    generatedAt: formatUtc((args.now ?? new Date()).toISOString()),
    generatedBy: args.generatedBy ?? bundle.exported_by ?? null,
    headerFields,
    sections,
    notice,
    filename: austracBundleFilename(r, caseReference),
  };
}

/** `austrac-smr-AML-2026-00005.html` — the `.pdf` swap is the shared rule's. */
export function austracBundleFilename(
  report: Pick<BundleReport, "id" | "kind">,
  caseReference: string | null,
): string {
  const slug = (caseReference ?? report.id).replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return `austrac-${report.kind.toLowerCase()}-${slug || report.id}.html`;
}

/** What the bundle document calls itself, for the shared PDF renderer. */
export function austracBundleIdentity(
  record: Pick<SubmissionRecord, "reference" | "generatedAt">,
  report: Pick<BundleReport, "kind">,
): RecordDocumentIdentity {
  const kind = toObligationKind(report.kind);
  const label = kind ? AUSTRAC_OBLIGATIONS[kind].label : "AUSTRAC report";
  return {
    title: "AUSTRAC report record",
    identityLine: `${record.reference}  ·  ${label}`,
    footLine: `${record.reference} · ${label} · ${record.generatedAt}`,
  };
}
