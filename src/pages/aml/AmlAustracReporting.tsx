import { useCallback, useEffect, useMemo, useState } from "react";
import { FileText, Loader2, PlusCircle, ShieldCheck, Send, Download, CheckCircle2, XCircle, History, Eye } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useAmlAccess } from "@/hooks/useAmlAccess";
import { useAmlV3Flags } from "@/lib/aml/useAmlV3Flags";
import { RegulatoryAssuranceHeader } from "@/components/aml/RegulatoryAssuranceHeader";
import { AustracReportPathCard } from "@/components/aml/AustracReportPathCard";
import { amlCasesApi, type AmlCase } from "@/lib/aml/amlCasesApi";
import { useBrand } from "@/branding/BrandProvider";
import { loadRecordBrandLogo, resolveRecordBrand } from "@/lib/aml/submissionRecordBrand";
import { generateSubmissionRecordPdf, submissionRecordPdfFilename } from "@/lib/aml/submissionRecordPdf";
import {
  austracBundleIdentity, buildAustracBundleRecord,
} from "@/lib/aml/austracBundleRecord.pure";
import { useNavigate, useSearchParams } from "react-router-dom";
import { austracReadiness, type AustracReportFacts } from "@/lib/aml/austracReportPath.pure";
import { AUSTRAC_KIND_LABEL as KIND_LABEL, toObligationKind } from "@/lib/aml/austracDraftGuidance.pure";
import { amlAustracDraftPath } from "@/lib/aml/amlRoutes";
import {
  AmlAccessGate,
  AmlLoadingState,
  AmlPageHeader,
  AmlRefreshButton,
  AmlTableEmptyRow,
  AmlTableLoadingRow,
} from "@/components/aml/primitives";
import {
  amlReportingApi,
  type AmlReport, type AmlReportStatus,
  type AmlReportSubmission, type AmlReportVersion, type AmlReportingSummary,
  type AmlSubmissionChannel,
} from "@/lib/aml/amlReportingApi";

/**
 * Colour marks ONE thing: the report whose existence must not be disclosed.
 *
 * A tone per obligation was the obvious first answer and it was wrong. In
 * the dark theme `--primary` and `--warning` are both the brand gold, so
 * five kinds in five tones rendered as five near-identical amber chips —
 * colour noise carrying no information, which is worse than no colour at
 * all. The three letters are what tells the obligations apart, and they
 * already do it.
 *
 * So the SMR alone is tinted, because s.123 makes disclosing one an offence
 * and that is a fact about how the row must be handled rather than a
 * category. Everything else is a neutral outline.
 */
const KIND_TONE: Record<string, string> = {
  smr: "border-warning/50 bg-warning/10 text-warning",
};

/** What a writer may still change, and what the MLRO may still sign off.
 *  Both mirror `aml-reporting`'s own guards — the server refuses either way;
 *  these decide whether a step is worth OFFERING. */
const DRAFT_EDITABLE = new Set(["draft", "in_review"]);
const SIGNOFF_STATUSES = new Set(["draft", "in_review", "awaiting_mlro"]);

const STATUS_TONE: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  in_review: "bg-primary/15 text-primary",
  awaiting_mlro: "bg-warning/15 text-warning",
  approved: "bg-success/15 text-success",
  submitted: "bg-primary text-primary-foreground",
  acknowledged: "bg-success text-success-foreground",
  rejected: "bg-destructive/15 text-destructive",
  withdrawn: "bg-muted text-muted-foreground",
};

function fmt(d: string | null | undefined) { return d ? new Date(d).toLocaleString('en-AU') : "—"; }

export default function AmlAustracReporting() {
  const { canWrite, isMlro, hasAnyRole, loading: accessLoading } = useAmlAccess();
  const { regulatoryHub } = useAmlV3Flags();
  const navigate = useNavigate();
  const { settings: brandSettings } = useBrand();
  /*
    `?report=` is how the draft page hands a saved report back. Without it,
    saving on a page rather than in a dialog would return the operator to a
    list with nothing selected — the dialog closed onto the report it had
    just written, and losing that is the one thing the move could have cost.
  */
  const [searchParams] = useSearchParams();
  const requestedReport = searchParams.get("report");

  const [summary, setSummary] = useState<AmlReportingSummary | null>(null);
  const [reports, setReports] = useState<AmlReport[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [loading, setLoading] = useState(false);
  /**
   * The customers a report can be filed against.
   *
   * `reports.case_id` has existed since the first migration and the draft
   * dialog never set it, so every report ever drafted here was filed against
   * nobody — findable from this page and from nowhere else, least of all the
   * customer's own record. The field is now asked for, and the server was
   * already writing the case event when it was given one.
   */
  const [cases, setCases] = useState<AmlCase[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedVersions, setSelectedVersions] = useState<AmlReportVersion[]>([]);
  const [selectedSubs, setSelectedSubs] = useState<AmlReportSubmission[]>([]);
  const [selectedReport, setSelectedReport] = useState<AmlReport | null>(null);

  /** The report whose record is being drawn, so its button can say so. */
  const [bundling, setBundling] = useState<string | null>(null);
  const [approving, setApproving] = useState<string | null>(null);

  const [openSubmit, setOpenSubmit] = useState(false);
  const [submitChannel, setSubmitChannel] = useState<AmlSubmissionChannel>("austrac_online");
  const [submitRef, setSubmitRef] = useState("");
  const [submitBundlePath, setSubmitBundlePath] = useState("");
  const [submitAttest, setSubmitAttest] = useState(false);
  const [submitNotes, setSubmitNotes] = useState("");
  const [submitReport, setSubmitReport] = useState<AmlReport | null>(null);

  const [openReceipt, setOpenReceipt] = useState<AmlReportSubmission | null>(null);
  const [receiptRef, setReceiptRef] = useState("");
  const [receiptStatus, setReceiptStatus] = useState("acknowledged");
  const [receiptNotes, setReceiptNotes] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const [sum, list] = await Promise.all([
        amlReportingApi.summary(),
        amlReportingApi.listReports({
          status: statusFilter === "all" ? undefined : statusFilter,
          kind: kindFilter === "all" ? undefined : kindFilter,
        }),
      ]);
      setSummary(sum); setReports(list);
    } catch (e: any) { toast.error(e?.message ?? "Failed to load AUSTRAC reports"); }
    finally { setLoading(false); }
  };

  const loadDetail = async (id: string) => {
    try {
      const r = await amlReportingApi.getReport(id);
      setSelectedReport(r.report ?? null);
      setSelectedVersions(r.versions);
      setSelectedSubs(r.submissions);
    } catch (e: any) { toast.error(e?.message ?? "Failed to load report detail"); }
  };

  useEffect(() => { if (hasAnyRole) load(); /* eslint-disable-next-line */ }, [statusFilter, kindFilter, hasAnyRole]);
  useEffect(() => { if (selectedId) loadDetail(selectedId); else { setSelectedReport(null); setSelectedVersions([]); setSelectedSubs([]); } }, [selectedId]);
  useEffect(() => { if (requestedReport) setSelectedId(requestedReport); }, [requestedReport]);

  useEffect(() => {
    if (!hasAnyRole) return;
    amlCasesApi.list({ limit: 200 })
      .then((r) => setCases(r.cases))
      // A report can still be drafted if the list cannot be read; the check
      // below will say it is not filed against anybody, which is true.
      .catch(() => setCases([]));
  }, [hasAnyRole]);

  /**
   * A report as the guided path reads it.
   *
   * One projection rather than two, because the approval guard needs the
   * same reading for a report in the TABLE — where no submissions have been
   * loaded — as the card has for the selected one. Two mappings from a row
   * to `AustracReportFacts` is how a confirmation comes to list checks that
   * belong to a different report.
   *
   * The lodgement reference and the receipt come from the SUBMISSIONS
   * actually recorded rather than from a status word that could disagree
   * with them.
   */
  const factsFor = useCallback((
    report: AmlReport,
    subs: AmlReportSubmission[],
  ): AustracReportFacts | null => {
    // A kind the obligation table does not carry gets no path rather than a
    // crash: `AUSTRAC_OBLIGATIONS[undefined]` is what the card would read.
    const kind = toObligationKind(report.kind);
    if (!kind) return null;
    const latestSub = subs[0] ?? null;
    const meta = (report.metadata ?? {}) as Record<string, any>;
    return {
      kind,
      status: report.status,
      caseId: report.case_id ?? null,
      subjectLabel: cases.find((c) => c.id === report.case_id)?.subject_display_name ?? null,
      title: report.title ?? null,
      narrative: report.narrative ?? null,
      periodStart: report.reporting_period_start ?? null,
      periodEnd: report.reporting_period_end ?? null,
      mlroSignedAt: report.mlro_signed_at ?? null,
      submittedAt: report.submitted_at ?? null,
      externalReference: latestSub?.external_reference ?? null,
      receiptReference: (latestSub as any)?.receipts?.[0]?.receipt_reference
        ?? (report.acknowledged_at ? "recorded" : null),
      obligationAt: meta.obligation_at ?? null,
      terrorismFinancing: meta.terrorism_financing === true,
    };
  }, [cases]);

  const pathFacts = useMemo(
    () => (selectedReport ? factsFor(selectedReport, selectedSubs) : null),
    [selectedReport, selectedSubs, factsFor],
  );

  const startNew = () => navigate(amlAustracDraftPath());
  const editExisting = (r: AmlReport) => navigate(amlAustracDraftPath(r.id));

  const removeReport = async (r: AmlReport) => {
    if (!confirm(`Delete draft "${r.title}"? This cannot be undone.`)) return;
    try { await amlReportingApi.deleteReport(r.id); toast.success("Draft deleted"); if (selectedId === r.id) setSelectedId(null); await load(); }
    catch (e: any) { toast.error(e?.message ?? "Delete failed"); }
  };

  /**
   * The decision that authorises lodgement.
   *
   * ── Why the hand-off went ─────────────────────────────────────────
   * The path used to offer "Send to the MLRO" before this, which on a
   * reporting entity where the person drafting the report IS the MLRO — most
   * of them — was a report sent from somebody to themselves before they
   * could act on it. Approval is the act; the checks are what the approver
   * reviews on the way. `mlro_signoff` accepts a plain draft and always did,
   * so nothing about the server changed.
   *
   * The confirmation the hand-off carried moved here rather than being
   * deleted, because it was always about THIS decision: approving a report
   * whose checks are outstanding is a legitimate thing to do and should
   * never happen by accident. A report with nothing outstanding approves in
   * one click, exactly as it did from the table.
   */
  const signoff = async (r: AmlReport) => {
    if (!isMlro) return;
    const facts = factsFor(r, selectedId === r.id ? selectedSubs : []);
    const outstanding = facts
      ? austracReadiness(facts).filter(
        // The lodgement and the receipt come AFTER approval — listing them
        // as outstanding would ask the approver to answer for steps their
        // own decision unlocks.
        (c) => (c.state === "blocked" || c.state === "attention")
          && c.key !== "mlro" && c.key !== "lodgement" && c.key !== "receipt",
      )
      : [];
    if (outstanding.length > 0) {
      const list = outstanding.map((c) => `• ${c.label}`).join("\n");
      if (!window.confirm(
        `${outstanding.length} check${outstanding.length === 1 ? " is" : "s are"} still outstanding:`
        + `\n\n${list}\n\nApprove it anyway? The approval is recorded against you.`,
      )) return;
    }
    setApproving(r.id);
    try { await amlReportingApi.mlroSignoff(r.id); toast.success("Approved", { description: "It can now be lodged at AUSTRAC Online." }); await load(); if (selectedId === r.id) await loadDetail(r.id); }
    catch (e: any) { toast.error(e?.message ?? "The approval could not be recorded"); }
    finally { setApproving(null); }
  };
  const reject = async (r: AmlReport) => {
    if (!isMlro) return;
    const reason = prompt("Reason for rejection?"); if (!reason) return;
    try { await amlReportingApi.mlroReject(r.id, reason); toast.success("Report returned to draft"); await load(); if (selectedId === r.id) await loadDetail(r.id); }
    catch (e: any) { toast.error(e?.message ?? "Reject failed"); }
  };
  const withdraw = async (r: AmlReport) => {
    if (!isMlro) return;
    const reason = prompt("Withdrawal reason?") ?? "";
    try { await amlReportingApi.withdrawReport(r.id, reason); toast.success("Report withdrawn"); await load(); if (selectedId === r.id) await loadDetail(r.id); }
    catch (e: any) { toast.error(e?.message ?? "Withdraw failed"); }
  };

  const openSubmitFor = (r: AmlReport) => {
    setSelectedId(r.id); setSubmitReport(r);
    setSubmitChannel("austrac_online"); setSubmitRef(""); setSubmitBundlePath("");
    setSubmitAttest(false); setSubmitNotes(""); setOpenSubmit(true);
  };
  const submitNow = async () => {
    if (!selectedId) return;
    const isSmr = submitReport?.kind === "smr";
    if (!submitAttest) { toast.error("MLRO tipping-off attestation is required"); return; }
    if (!submitRef.trim() && !submitBundlePath.trim()) { toast.error("Provide an AUSTRAC reference or an export bundle path"); return; }
    if (isSmr && !submitRef.trim()) { toast.error("SMR submissions require the AUSTRAC lodgement reference"); return; }
    try {
      await amlReportingApi.submitRecord({
        report_id: selectedId, channel: submitChannel,
        external_reference: submitRef || undefined,
        export_bundle_path: submitBundlePath || undefined,
        notes: submitNotes || undefined,
        attest_no_tipping_off: true,
      });
      toast.success("Submission recorded");
      setOpenSubmit(false); await load(); await loadDetail(selectedId);
    } catch (e: any) { toast.error(e?.message ?? "Submission failed"); }
  };

  const saveReceipt = async () => {
    if (!openReceipt) return;
    if (!receiptRef) { toast.error("Receipt reference required"); return; }
    try {
      await amlReportingApi.recordReceipt({
        submission_id: openReceipt.id,
        receipt_reference: receiptRef,
        status: receiptStatus as any,
        notes: receiptNotes || undefined,
      });
      toast.success("Receipt captured");
      setOpenReceipt(null); setReceiptRef(""); setReceiptNotes("");
      if (selectedId) await loadDetail(selectedId); await load();
    } catch (e: any) { toast.error(e?.message ?? "Receipt failed"); }
  };

  /**
   * The archive record for one AUSTRAC report, downloaded as a document.
   *
   * It used to download the edge function's JSON response — `austrac-smr-
   * <uuid>.json`, which opens in a text editor, carries no identity, no
   * branding and no statement of what it is. The archive record for a report
   * to a regulator was a developer artefact.
   *
   * It is a PDF now, drawn by the SAME renderer, under the SAME white-label
   * brand resolver, as the client submission record: the workspace's own
   * identity when it has configured one, and Aurixa Systems when it has not
   * — never an empty masthead. Everything on the page comes from the bundle
   * the server assembled and hashed; nothing here is a second source.
   */
  const exportBundle = async (r: AmlReport) => {
    setBundling(r.id);
    try {
      const { bundle, content_hash } = await amlReportingApi.exportBundle(r.id);
      const brand = resolveRecordBrand(brandSettings);
      // A logo that cannot be fetched degrades to the wordmark rather than
      // failing the download: identity is required, a picture is not.
      brand.logoDataUrl = await loadRecordBrandLogo(brandSettings, brand.tenantBranded);
      const linked = cases.find((c) => c.id === (bundle.report?.case_id ?? r.case_id));
      const record = buildAustracBundleRecord({
        bundle: { ...bundle, report: bundle.report ?? r },
        contentHash: content_hash,
        subjectLabel: linked?.subject_display_name ?? null,
        caseReference: linked?.case_reference ?? null,
        issuedBy: brand.name,
      });
      const blob = await generateSubmissionRecordPdf(
        record, brand, austracBundleIdentity(record, bundle.report ?? r),
      );
      const filename = submissionRecordPdfFilename(record);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
      toast.success("Report record downloaded", { description: `${filename} · issued by ${brand.name}` });
    } catch (e: any) { toast.error(e?.message ?? "The report record could not be produced"); }
    finally { setBundling(null); }
  };

  const tiles = useMemo(() => summary ? [
    { label: "Drafts", value: summary.draft },
    { label: "Awaiting MLRO", value: summary.awaiting_mlro },
    { label: "Approved", value: summary.approved },
    { label: "Submitted", value: summary.submitted },
    { label: "Acknowledged", value: summary.acknowledged },
    { label: "Rejected", value: summary.rejected },
  ] : [], [summary]);

  if (accessLoading) return <AmlLoadingState variant="spinner" label="Checking your access…" />;
  if (!hasAnyRole) {
    return (
      <AmlAccessGate
        title="You don't have access to the AUSTRAC Hub yet"
        body="Ask your compliance administrator to grant you AML reporting access."
      />
    );
  }

  return (
    <div className="space-y-6">
      {regulatoryHub && <RegulatoryAssuranceHeader />}
      <AmlPageHeader
        title="AUSTRAC Reporting Hub"
        description="Draft SMR, TTR, IFTI and compliance reports, capture MLRO sign-off, record submissions and receipts. Nothing auto-submits — human confirmation is required at every step."
        icon={FileText}
        actions={
          <>
            <AmlRefreshButton onClick={load} loading={loading} />
            {/*
              "New Draft" named the row it would add to a table. This names
              the act: an operator asked to inform AUSTRAC about something is
              looking for the report, not for a draft record.
            */}
            {canWrite && (
              <Button size="sm" onClick={startNew}>
                <PlusCircle aria-hidden="true" className="h-4 w-4 mr-2" /> Start AUSTRAC Report
              </Button>
            )}
          </>
        }
      />

      {tiles.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {tiles.map((t) => (
            <Card key={t.label}><CardContent className="p-4">
              <div className="text-xs uppercase text-muted-foreground">{t.label}</div>
              <div className="text-2xl font-semibold">{t.value}</div>
            </CardContent></Card>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <CardTitle>Reports</CardTitle>
              <div className="flex gap-2">
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    {["draft","in_review","awaiting_mlro","approved","submitted","acknowledged","rejected","withdrawn"].map(s => (
                      <SelectItem key={s} value={s}>{s.replace(/_/g," ")}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={kindFilter} onValueChange={setKindFilter}>
                  <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All kinds</SelectItem>
                    {Object.entries(KIND_LABEL).map(([k, l]) => <SelectItem key={k} value={k}>{k.toUpperCase()} — {l.split(" ")[0]}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <CardDescription>Filter, review, and act on AUSTRAC drafts and submissions.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table aria-label="AUSTRAC reports">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Kind</TableHead><TableHead scope="col">Title</TableHead>
                  <TableHead scope="col">Status</TableHead><TableHead scope="col">Updated</TableHead>
                  <TableHead scope="col" className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {/*
                  ── Which one am I looking at? ────────────────────────
                  The selected row was a 40%-opacity muted tint and nothing
                  else, which on the dark theme is a shade of the same
                  charcoal as the row beside it. With two reports on the
                  register an operator could not tell which one the whole
                  right-hand panel was describing.

                  Three signals rather than one, because a single tint is
                  what failed: a solid accent bar down the leading edge, a
                  tinted ground, and the word "Viewing" beside the title.
                  `aria-selected` carries the same fact to a screen reader,
                  and the row is a real button for the keyboard — it was
                  click-only, so the register could not be driven without a
                  mouse at all.
                */}
                {reports.map((r) => {
                  const active = selectedId === r.id;
                  return (
                  <TableRow
                    key={r.id}
                    aria-selected={active}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedId(r.id); }
                    }}
                    className={cn(
                      "relative cursor-pointer transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                      active
                        ? "bg-primary/10 hover:bg-primary/10"
                        : "hover:bg-muted/40",
                    )}
                    onClick={() => setSelectedId(r.id)}
                  >
                    <TableCell className="relative">
                      {active && (
                        <span
                          aria-hidden
                          className="absolute inset-y-0 left-0 w-1 rounded-r bg-primary"
                        />
                      )}
                      <Badge variant="outline" className={cn("font-semibold", KIND_TONE[r.kind] ?? "")}>
                        {r.kind.toUpperCase()}
                      </Badge>
                    </TableCell>
                    <TableCell className={cn("font-medium", active && "text-primary")}>
                      <span className="flex items-center gap-2">
                        {r.title}
                        {active && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                            <Eye aria-hidden className="h-3 w-3" /> Viewing
                          </span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell><Badge className={STATUS_TONE[r.status] ?? ""}>{r.status.replace(/_/g," ")}</Badge></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{fmt(r.updated_at)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1 flex-wrap">
                        {canWrite && ["draft","in_review"].includes(r.status) && (
                          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); editExisting(r); }}>Edit</Button>
                        )}
                        {isMlro && ["draft","in_review","awaiting_mlro"].includes(r.status) && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={approving === r.id}
                            onClick={(e) => { e.stopPropagation(); void signoff(r); }}
                          >
                            {approving === r.id
                              ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                              : <ShieldCheck className="h-4 w-4 mr-1" />}
                            Approve
                          </Button>
                        )}
                        {isMlro && r.status === "approved" && (
                          <Button size="sm" onClick={(e) => { e.stopPropagation(); openSubmitFor(r); }}><Send className="h-4 w-4 mr-1" /> Submit</Button>
                        )}
                        {isMlro && ["approved","in_review","awaiting_mlro"].includes(r.status) && (
                          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); reject(r); }}><XCircle className="h-4 w-4 mr-1" /> Reject</Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={bundling === r.id}
                          onClick={(e) => { e.stopPropagation(); void exportBundle(r); }}
                        >
                          {bundling === r.id
                            ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                            : <Download className="h-4 w-4 mr-1" />}
                          Record
                        </Button>
                        {canWrite && r.status === "draft" && (
                          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); removeReport(r); }} className="text-destructive">Delete</Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                  );
                })}
                {!reports.length && loading && <AmlTableLoadingRow colSpan={5} label="Loading reports…" />}
                {!reports.length && !loading && (
                  <AmlTableEmptyRow colSpan={5}>No reports match these filters. Try clearing the status or kind filter{canWrite ? ", or start a new draft" : ""}.</AmlTableEmptyRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/*
          The panel used to head itself "Detail" with the title in muted
          small print underneath, which named neither the obligation nor the
          status — an operator reading it had to look back at the table to
          know which report it was about, and the table did not say either.
        */}
        <Card className={selectedReport ? "border-primary/30" : undefined}>
          <CardHeader className="pb-3">
            {selectedReport ? (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className={cn("font-semibold", KIND_TONE[selectedReport.kind] ?? "")}>
                    {selectedReport.kind.toUpperCase()}
                  </Badge>
                  <Badge className={STATUS_TONE[selectedReport.status] ?? ""}>
                    {selectedReport.status.replace(/_/g, " ")}
                  </Badge>
                </div>
                <CardTitle className="text-base leading-snug">{selectedReport.title}</CardTitle>
                <CardDescription>
                  {KIND_LABEL[selectedReport.kind] ?? selectedReport.kind}
                  {selectedReport.case_id
                    ? ` · ${cases.find((c) => c.id === selectedReport.case_id)?.subject_display_name ?? "linked customer"}`
                    : " · not filed against a customer"}
                </CardDescription>
              </div>
            ) : (
              <>
                <CardTitle className="text-base">Detail</CardTitle>
                <CardDescription>Select a report to view versions and submissions.</CardDescription>
              </>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            {!selectedReport && (
              <div className="rounded-lg border border-dashed border-border/60 p-6 text-center text-sm text-muted-foreground">
                Choose a report on the left to see what it still needs, when it is due, and how to
                lodge it.
              </div>
            )}
            {/*
              The path leads, because "what now" is the question an operator
              opens a report with. The tabs below keep every existing detail
              exactly where it was.
            */}
            {selectedReport && pathFacts && (
              <AustracReportPathCard
                facts={pathFacts}
                /*
                  One entry per step this operator can actually act on. A
                  step with no entry draws no button — the MLRO's sign-off,
                  to an analyst, is a real state with no act, and offering a
                  dead "Open" is what made step 3 look broken.
                */
                stepActions={{
                  ...(canWrite && DRAFT_EDITABLE.has(selectedReport.status)
                    ? {
                      identify: { label: "Open the draft", run: () => editExisting(selectedReport) },
                      assemble: { label: "Write the narrative", run: () => editExisting(selectedReport) },
                    }
                    : {}),
                  ...(isMlro && SIGNOFF_STATUSES.has(selectedReport.status)
                    ? {
                      approve: {
                        label: "Review and approve",
                        run: () => { void signoff(selectedReport); },
                        busy: approving === selectedReport.id,
                      },
                    }
                    : {}),
                  ...(isMlro && selectedReport.status === "approved"
                    ? {
                      lodge: {
                        label: "Record the lodgement",
                        run: () => openSubmitFor(selectedReport),
                      },
                    }
                    : {}),
                  ...(isMlro && selectedSubs.length > 0
                    ? {
                      receipt: {
                        label: "Capture the receipt",
                        run: () => {
                          setOpenReceipt(selectedSubs[0]);
                          setReceiptRef(""); setReceiptNotes("");
                        },
                      },
                    }
                    : {}),
                }}
                /*
                  An open step with no button must still say whose it is. An
                  analyst reaches the approval and cannot make it — that is a
                  real state with a real next actor, and silence about it
                  reads as a broken page.
                */
                stepNotes={{
                  ...(isMlro ? {} : { approve: "The MLRO's decision" }),
                  ...(isMlro ? {} : { lodge: "The MLRO lodges it", receipt: "The MLRO records it" }),
                }}
              />
            )}
            {selectedReport && (
              <Tabs defaultValue="meta">
                <TabsList className="grid grid-cols-3">
                  <TabsTrigger value="meta">Meta</TabsTrigger>
                  <TabsTrigger value="versions">Versions</TabsTrigger>
                  <TabsTrigger value="subs">Submissions</TabsTrigger>
                </TabsList>
                <TabsContent value="meta" className="space-y-2 text-sm">
                  <div><span className="text-muted-foreground">Kind:</span> <Badge variant="outline">{selectedReport.kind.toUpperCase()}</Badge></div>
                  <div><span className="text-muted-foreground">Status:</span> <Badge className={STATUS_TONE[selectedReport.status] ?? ""}>{selectedReport.status.replace(/_/g," ")}</Badge></div>
                  <div><span className="text-muted-foreground">Reference:</span> {selectedReport.reference_code ?? "—"}</div>
                  <div><span className="text-muted-foreground">MLRO signed:</span> {fmt(selectedReport.mlro_signed_at)}</div>
                  <div><span className="text-muted-foreground">Submitted:</span> {fmt(selectedReport.submitted_at)}</div>
                  <div><span className="text-muted-foreground">Acknowledged:</span> {fmt(selectedReport.acknowledged_at)}</div>
                  {selectedReport.narrative && (
                    <div className="pt-2">
                      <div className="text-xs uppercase text-muted-foreground mb-1">Narrative</div>
                      <div className="whitespace-pre-wrap text-sm">{selectedReport.narrative}</div>
                    </div>
                  )}
                </TabsContent>
                <TabsContent value="versions" className="space-y-2">
                  {selectedVersions.length === 0 && <div className="text-sm text-muted-foreground">No versions.</div>}
                  {selectedVersions.map((v) => (
                    <div key={v.id} className="border rounded-md p-2 text-xs">
                      <div className="flex items-center justify-between">
                        <div className="font-medium">v{v.version} · {v.change_note ?? "—"}</div>
                        <History className="h-3 w-3 text-muted-foreground" />
                      </div>
                      <div className="text-muted-foreground">{fmt(v.created_at)} · {v.author_label ?? "system"}</div>
                      {v.content_hash && <div className="font-mono text-[10px] break-all mt-1">{v.content_hash.slice(0, 32)}…</div>}
                    </div>
                  ))}
                </TabsContent>
                <TabsContent value="subs" className="space-y-2">
                  {selectedSubs.length === 0 && <div className="text-sm text-muted-foreground">No submissions.</div>}
                  {selectedSubs.map((s) => (
                    <div key={s.id} className="border rounded-md p-2 text-xs space-y-1">
                      <div className="flex items-center justify-between">
                        <div className="font-medium">{s.channel.replace(/_/g," ")} · v{s.version}</div>
                        <Badge className={STATUS_TONE[s.status] ?? ""}>{s.status}</Badge>
                      </div>
                      <div className="text-muted-foreground">{fmt(s.submitted_at)}</div>
                      {s.external_reference && <div>Ref: <span className="font-mono">{s.external_reference}</span></div>}
                      {(s.receipts ?? []).map((rec) => (
                        <div key={rec.id} className="pl-2 border-l ml-1 mt-1">
                          <div className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-success" /> {rec.receipt_reference}</div>
                          <div className="text-muted-foreground">{fmt(rec.received_at)} · {rec.status}</div>
                        </div>
                      ))}
                      {isMlro && (
                        <div className="pt-1">
                          <Button size="sm" variant="ghost" onClick={() => { setOpenReceipt(s); setReceiptRef(""); setReceiptStatus("acknowledged"); setReceiptNotes(""); }}>
                            Capture receipt
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                </TabsContent>
              </Tabs>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Submit dialog */}
      <Dialog open={openSubmit} onOpenChange={setOpenSubmit}>
        <DialogContent>
          <DialogHeader><DialogTitle>Record AUSTRAC submission</DialogTitle></DialogHeader>
          <div className="space-y-3">
            {submitReport?.kind === "smr" && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
                SMR — tipping-off protections apply. Never disclose to the customer, related parties, or non-AML staff.
                AUSTRAC lodgement reference is mandatory before this can be marked submitted.
              </div>
            )}
            <div>
              <Label>Channel</Label>
              <Select value={submitChannel} onValueChange={(v) => setSubmitChannel(v as AmlSubmissionChannel)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{["austrac_online","manual_upload","api","email","other"].map(c => <SelectItem key={c} value={c}>{c.replace(/_/g," ")}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label>AUSTRAC external reference {submitReport?.kind === "smr" ? <span className="text-destructive">*</span> : null}</Label>
              <Input value={submitRef} onChange={(e) => setSubmitRef(e.target.value)} placeholder="AUSTRAC lodgement id" />
            </div>
            <div>
              <Label>Export bundle path (optional)</Label>
              <Input value={submitBundlePath} onChange={(e) => setSubmitBundlePath(e.target.value)} placeholder="storage://aml-reports/austrac-…json" />
              <p className="text-[11px] text-muted-foreground mt-1">Provide the archived bundle URL/path if the lodgement reference is not yet available. One evidence source is mandatory.</p>
            </div>
            <div><Label>Notes</Label><Textarea rows={3} value={submitNotes} onChange={(e) => setSubmitNotes(e.target.value)} /></div>
            <div className="flex items-start gap-2 rounded-md border p-3">
              <Checkbox id="mlro-tipping-off-attestation" className="mt-0.5" checked={submitAttest} onCheckedChange={(v) => setSubmitAttest(v === true)} />
              <Label htmlFor="mlro-tipping-off-attestation" className="text-xs font-normal leading-snug">
                <strong>MLRO attestation:</strong> I confirm submission evidence has been captured and no tipping-off breach has occurred.
                This attestation is written to the immutable audit trail.
              </Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpenSubmit(false)}>Cancel</Button>
            <Button
              onClick={submitNow}
              disabled={!submitAttest || (!submitRef.trim() && !submitBundlePath.trim()) || (submitReport?.kind === "smr" && !submitRef.trim())}
            >
              <Send className="h-4 w-4 mr-2" /> Record submission
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>


      {/* Receipt dialog */}
      <Dialog open={!!openReceipt} onOpenChange={(o) => !o && setOpenReceipt(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Capture AUSTRAC receipt</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Receipt reference</Label><Input value={receiptRef} onChange={(e) => setReceiptRef(e.target.value)} /></div>
            <div>
              <Label>Status</Label>
              <Select value={receiptStatus} onValueChange={setReceiptStatus}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{["acknowledged","queried","rejected","withdrawn","other"].map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div><Label>Notes</Label><Textarea rows={3} value={receiptNotes} onChange={(e) => setReceiptNotes(e.target.value)} /></div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpenReceipt(null)}>Cancel</Button>
            <Button onClick={saveReceipt}><CheckCircle2 className="h-4 w-4 mr-2" /> Save receipt</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
