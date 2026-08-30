import { useEffect, useMemo, useState } from "react";
import { FileText, Loader2, PlusCircle, ShieldCheck, Send, Download, CheckCircle2, XCircle, History } from "lucide-react";
import { toast } from "sonner";
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
import {
  AUSTRAC_OBLIGATIONS, type AustracReportFacts, type AustracReportKind,
} from "@/lib/aml/austracReportPath.pure";
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
  type AmlReport, type AmlReportKind, type AmlReportStatus,
  type AmlReportSubmission, type AmlReportVersion, type AmlReportingSummary,
  type AmlSubmissionChannel,
} from "@/lib/aml/amlReportingApi";

const KIND_LABEL: Record<AmlReportKind, string> = {
  smr: "Suspicious Matter Report",
  ttr: "Threshold Transaction Report",
  ifti: "International Funds Transfer Instruction",
  compliance: "Compliance Report",
  annual: "Annual Compliance Report",
};
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

  const [openDraft, setOpenDraft] = useState(false);
  const [draft, setDraft] = useState<Partial<AmlReport>>({ kind: "smr", title: "", narrative: "" });
  const [saving, setSaving] = useState(false);

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

  useEffect(() => {
    if (!hasAnyRole) return;
    amlCasesApi.list({ limit: 200 })
      .then((r) => setCases(r.cases))
      // A report can still be drafted if the list cannot be read; the check
      // below will say it is not filed against anybody, which is true.
      .catch(() => setCases([]));
  }, [hasAnyRole]);

  const obligationAt = (draft.metadata as any)?.obligation_at ?? null;

  /**
   * The selected report as the guided path reads it.
   *
   * Assembled here rather than inside the card so the card stays pure
   * presentation over one shape, and so the lodgement reference and receipt
   * come from the SUBMISSIONS actually recorded rather than from a status
   * word that could disagree with them.
   */
  const pathFacts: AustracReportFacts | null = useMemo(() => {
    if (!selectedReport) return null;
    const latestSub = selectedSubs[0] ?? null;
    const meta = (selectedReport.metadata ?? {}) as Record<string, any>;
    return {
      kind: selectedReport.kind as AustracReportKind,
      status: selectedReport.status,
      caseId: selectedReport.case_id ?? null,
      subjectLabel: cases.find((c) => c.id === selectedReport.case_id)?.subject_display_name ?? null,
      title: selectedReport.title ?? null,
      narrative: selectedReport.narrative ?? null,
      periodStart: selectedReport.reporting_period_start ?? null,
      periodEnd: selectedReport.reporting_period_end ?? null,
      mlroSignedAt: selectedReport.mlro_signed_at ?? null,
      submittedAt: selectedReport.submitted_at ?? null,
      externalReference: latestSub?.external_reference ?? null,
      receiptReference: (latestSub as any)?.receipts?.[0]?.receipt_reference
        ?? (selectedReport.acknowledged_at ? "recorded" : null),
      obligationAt: meta.obligation_at ?? null,
      terrorismFinancing: meta.terrorism_financing === true,
    };
  }, [selectedReport, selectedSubs, cases]);

  const startNew = () => { setDraft({ kind: "smr", title: "", narrative: "" }); setOpenDraft(true); };
  const editExisting = (r: AmlReport) => { setDraft({ ...r }); setOpenDraft(true); };

  const saveDraft = async () => {
    if (!draft.kind || !draft.title) { toast.error("Kind and title are required"); return; }
    setSaving(true);
    try {
      const saved = await amlReportingApi.upsertReport(draft);
      toast.success("Draft saved");
      setOpenDraft(false); setSelectedId(saved.id); await load();
    } catch (e: any) { toast.error(e?.message ?? "Save failed"); }
    finally { setSaving(false); }
  };

  const removeReport = async (r: AmlReport) => {
    if (!confirm(`Delete draft "${r.title}"? This cannot be undone.`)) return;
    try { await amlReportingApi.deleteReport(r.id); toast.success("Draft deleted"); if (selectedId === r.id) setSelectedId(null); await load(); }
    catch (e: any) { toast.error(e?.message ?? "Delete failed"); }
  };

  const signoff = async (r: AmlReport) => {
    if (!isMlro) return;
    try { await amlReportingApi.mlroSignoff(r.id); toast.success("MLRO sign-off recorded"); await load(); if (selectedId === r.id) await loadDetail(r.id); }
    catch (e: any) { toast.error(e?.message ?? "Sign-off failed"); }
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

  const exportBundle = async (r: AmlReport) => {
    try {
      const { bundle, content_hash } = await amlReportingApi.exportBundle(r.id);
      const blob = new Blob([JSON.stringify({ ...bundle, content_hash }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `austrac-${r.kind}-${r.id}.json`; a.click();
      URL.revokeObjectURL(url);
      toast.success("Bundle exported");
    } catch (e: any) { toast.error(e?.message ?? "Export failed"); }
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
            {canWrite && <Button size="sm" onClick={startNew}><PlusCircle aria-hidden="true" className="h-4 w-4 mr-2" /> New Draft</Button>}
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
                {reports.map((r) => (
                  <TableRow key={r.id} className={selectedId === r.id ? "bg-muted/40" : ""} onClick={() => setSelectedId(r.id)}>
                    <TableCell><Badge variant="outline">{r.kind.toUpperCase()}</Badge></TableCell>
                    <TableCell className="font-medium">{r.title}</TableCell>
                    <TableCell><Badge className={STATUS_TONE[r.status] ?? ""}>{r.status.replace(/_/g," ")}</Badge></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{fmt(r.updated_at)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1 flex-wrap">
                        {canWrite && ["draft","in_review"].includes(r.status) && (
                          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); editExisting(r); }}>Edit</Button>
                        )}
                        {isMlro && ["draft","in_review","awaiting_mlro"].includes(r.status) && (
                          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); signoff(r); }}><ShieldCheck className="h-4 w-4 mr-1" /> Sign-off</Button>
                        )}
                        {isMlro && r.status === "approved" && (
                          <Button size="sm" onClick={(e) => { e.stopPropagation(); openSubmitFor(r); }}><Send className="h-4 w-4 mr-1" /> Submit</Button>
                        )}
                        {isMlro && ["approved","in_review","awaiting_mlro"].includes(r.status) && (
                          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); reject(r); }}><XCircle className="h-4 w-4 mr-1" /> Reject</Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); exportBundle(r); }}><Download className="h-4 w-4 mr-1" /> Bundle</Button>
                        {canWrite && r.status === "draft" && (
                          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); removeReport(r); }} className="text-destructive">Delete</Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {!reports.length && loading && <AmlTableLoadingRow colSpan={5} label="Loading reports…" />}
                {!reports.length && !loading && (
                  <AmlTableEmptyRow colSpan={5}>No reports match these filters. Try clearing the status or kind filter{canWrite ? ", or start a new draft" : ""}.</AmlTableEmptyRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Detail</CardTitle>
            <CardDescription>{selectedReport ? selectedReport.title : "Select a report to view versions and submissions."}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!selectedReport && <div className="text-sm text-muted-foreground">Nothing selected.</div>}
            {/*
              The path leads, because "what now" is the question an operator
              opens a report with. The tabs below keep every existing detail
              exactly where it was.
            */}
            {selectedReport && pathFacts && (
              <AustracReportPathCard
                facts={pathFacts}
                onOpenStep={(key) => {
                  if (key === "identify" || key === "assemble") editExisting(selectedReport);
                  else if (key === "lodge") { setSubmitRef(""); setOpenSubmit(true); }
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

      {/* Draft dialog */}
      <Dialog open={openDraft} onOpenChange={setOpenDraft}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>{draft.id ? "Edit report draft" : "New AUSTRAC report draft"}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Kind</Label>
                <Select value={String(draft.kind ?? "smr")} onValueChange={(v) => setDraft((d) => ({ ...d, kind: v as AmlReportKind }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{Object.entries(KIND_LABEL).map(([k, l]) => <SelectItem key={k} value={k}>{k.toUpperCase()} — {l}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div>
                <Label>Reference code</Label>
                <Input value={draft.reference_code ?? ""} onChange={(e) => setDraft((d) => ({ ...d, reference_code: e.target.value }))} />
              </div>
            </div>
            {/*
              ── Which customer this is about ──────────────────────────
              The field the dialog never had. Without it the report is
              filed against nobody: it does not reach the customer's
              compliance file, does not appear on their case timeline, and
              cannot be found from their record. The server has always
              written the case event when given a case; it was never given
              one.
            */}
            <div>
              <Label>Customer</Label>
              <Select
                value={draft.case_id ?? "none"}
                onValueChange={(v) => setDraft((d) => ({ ...d, case_id: v === "none" ? null : v }))}
              >
                <SelectTrigger><SelectValue placeholder="Choose the customer this report is about" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not yet chosen</SelectItem>
                  {cases.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.subject_display_name} — {c.case_reference}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-[11px] text-muted-foreground">
                The report is held on this customer's compliance file, and the drafting is
                recorded on their case timeline.
              </p>
            </div>
            <div>
              <Label>Title</Label>
              <Input value={draft.title ?? ""} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} />
            </div>
            <div>
              <Label>Narrative</Label>
              <Textarea rows={6} value={draft.narrative ?? ""} onChange={(e) => setDraft((d) => ({ ...d, narrative: e.target.value }))} />
            </div>
            {/*
              ── What starts the statutory clock ────────────────────────
              An SMR is due 3 business days after the suspicion was FORMED
              (24 hours where it concerns terrorism financing); a TTR and an
              IFTI 10 business days after the transaction or instruction.
              None of those is the reporting period, so the date is asked
              for separately and kept in `metadata` — a deadline derived
              from the wrong date is worse than none.
            */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Obligation arose</Label>
                <Input
                  type="datetime-local"
                  value={obligationAt ? String(obligationAt).slice(0, 16) : ""}
                  onChange={(e) => setDraft((d) => ({
                    ...d,
                    metadata: {
                      ...(d.metadata ?? {}),
                      obligation_at: e.target.value ? new Date(e.target.value).toISOString() : null,
                    },
                  }))}
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {AUSTRAC_OBLIGATIONS[(draft.kind ?? "smr") as AustracReportKind].clockStarts
                    .replace(/^the /, "The ")} — this is what the deadline is counted from.
                </p>
              </div>
              {(draft.kind ?? "smr") === "smr" && (
                <div className="flex items-start gap-2 pt-6">
                  <Checkbox
                    id="draft-tf"
                    checked={Boolean((draft.metadata as any)?.terrorism_financing)}
                    onCheckedChange={(v) => setDraft((d) => ({
                      ...d,
                      metadata: { ...(d.metadata ?? {}), terrorism_financing: v === true },
                    }))}
                  />
                  <Label htmlFor="draft-tf" className="text-xs font-normal leading-snug">
                    The suspicion concerns terrorism financing
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                      Tightens the deadline to 24 hours.
                    </span>
                  </Label>
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Period start</Label>
                <Input type="datetime-local" value={draft.reporting_period_start ? String(draft.reporting_period_start).slice(0, 16) : ""} onChange={(e) => setDraft((d) => ({ ...d, reporting_period_start: e.target.value ? new Date(e.target.value).toISOString() : null }))} />
              </div>
              <div>
                <Label>Period end</Label>
                <Input type="datetime-local" value={draft.reporting_period_end ? String(draft.reporting_period_end).slice(0, 16) : ""} onChange={(e) => setDraft((d) => ({ ...d, reporting_period_end: e.target.value ? new Date(e.target.value).toISOString() : null }))} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpenDraft(false)}>Cancel</Button>
            <Button onClick={saveDraft} disabled={saving}>{saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Save draft</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
