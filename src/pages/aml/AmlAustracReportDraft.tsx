/**
 * Writing an AUSTRAC report — a page of its own.
 *
 * ── Why this exists ───────────────────────────────────────────────────
 * The draft was a modal. Everything about it was wrong for what it holds:
 * a report to a regulator is the longest single piece of writing anyone
 * does in this product, it is written against a statutory deadline, and it
 * is frequently started, left, and returned to hours later. A dialog cannot
 * be deep-linked, cannot be reopened where it was left, cannot be sent to a
 * colleague, is not reached by the browser's back button — and closes on an
 * outside click or the Escape key with whatever was in it.
 *
 * Everything the dialog asked, this asks. Everything the server refuses, it
 * still refuses. What changed is that the draft now has a URL, room for the
 * narrative, and the reasons for the report in view beside it while it is
 * written rather than competing with it for a modal's worth of height.
 *
 * ── Leaving is not losing ─────────────────────────────────────────────
 * The one thing a page gives up is the modal's implicit "you are in the
 * middle of something", so the page says it: an unsaved change guards both
 * the browser's own unload and this page's own Back, because a narrative
 * somebody spent twenty minutes on is not recoverable from anywhere.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AlertTriangle, ArrowLeft, Check, FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAmlAccess } from "@/hooks/useAmlAccess";
import { AmlAccessGate, AmlLoadingState, AmlPageHeader } from "@/components/aml/primitives";
import { AustracReportDraftForm, type DraftCaseOption } from "@/components/aml/AustracReportDraftForm";
import { draftSectionsForReport, draftSummary } from "@/lib/aml/austracDraftGuidance.pure";
import { amlAustracReportPath, ADMIN_AML_AUSTRAC_PATH } from "@/lib/aml/amlRoutes";
import { amlCasesApi } from "@/lib/aml/amlCasesApi";
import { amlReportingApi, type AmlReport } from "@/lib/aml/amlReportingApi";

/** A fresh draft. Same starting shape the dialog used. */
const BLANK: Partial<AmlReport> = { kind: "smr", title: "", narrative: "" };

export default function AmlAustracReportDraft() {
  const { reportId } = useParams<{ reportId: string }>();
  const navigate = useNavigate();
  const { canWrite, hasAnyRole, loading: accessLoading } = useAmlAccess();

  const [draft, setDraft] = useState<Partial<AmlReport>>(BLANK);
  const [cases, setCases] = useState<DraftCaseOption[]>([]);
  const [casesFailed, setCasesFailed] = useState(false);
  const [loading, setLoading] = useState(Boolean(reportId));
  const [notFound, setNotFound] = useState(false);
  const [saving, setSaving] = useState(false);
  /** Set by the first edit, cleared by a save. Guards leaving. */
  const [dirty, setDirty] = useState(false);
  const savedRef = useRef(false);

  useEffect(() => {
    if (!hasAnyRole) return;
    amlCasesApi.list({ limit: 200 })
      .then((r) => setCases(r.cases as DraftCaseOption[]))
      // A report can still be drafted if the list cannot be read; the form
      // says the customer can be linked afterwards, which is true.
      .catch(() => { setCases([]); setCasesFailed(true); });
  }, [hasAnyRole]);

  useEffect(() => {
    if (!hasAnyRole) return;
    if (!reportId) { setDraft(BLANK); setLoading(false); return; }
    let live = true;
    setLoading(true);
    amlReportingApi.getReport(reportId)
      .then((r) => {
        if (!live) return;
        if (!r.report) { setNotFound(true); return; }
        setDraft({ ...r.report });
      })
      .catch((e: unknown) => {
        if (!live) return;
        toast.error((e as Error)?.message ?? "The report could not be loaded");
        setNotFound(true);
      })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [reportId, hasAnyRole]);

  /*
    A narrative somebody spent twenty minutes on is not recoverable from
    anywhere, so an unsaved change guards the browser's own unload. It is
    registered only while there IS one — an always-on handler makes every
    navigation away from a clean page ask a question nobody needs.
  */
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const onChange = useCallback((next: (d: Partial<AmlReport>) => Partial<AmlReport>) => {
    setDraft(next);
    setDirty(true);
  }, []);

  const sections = useMemo(() => draftSectionsForReport(draft), [draft]);
  const outstanding = sections.some((s) => s.state === "outstanding");
  const canSave = Boolean(draft.kind && (draft.title ?? "").trim());

  const leave = (to: string) => {
    if (dirty && !savedRef.current
      && !window.confirm("This draft has changes that have not been saved. Leave without saving?")) return;
    navigate(to);
  };

  const save = async () => {
    // The same two fields the dialog required. The server owns everything
    // that matters after this — approval, evidence, the attestation.
    if (!draft.kind || !(draft.title ?? "").trim()) {
      toast.error("Kind and title are required");
      return;
    }
    setSaving(true);
    try {
      const saved = await amlReportingApi.upsertReport(draft);
      savedRef.current = true;
      setDirty(false);
      toast.success(reportId ? "Draft saved" : "Draft started");
      navigate(amlAustracReportPath(saved.id));
    } catch (e: unknown) {
      toast.error((e as Error)?.message ?? "Save failed");
    } finally { setSaving(false); }
  };

  if (accessLoading) return <AmlLoadingState variant="spinner" label="Checking your access…" />;
  if (!hasAnyRole || !canWrite) {
    return (
      <AmlAccessGate
        title="You don't have access to draft AUSTRAC reports"
        body="Ask your compliance administrator to grant you AML reporting access."
      />
    );
  }
  if (loading) return <AmlLoadingState variant="spinner" label="Opening the report…" />;
  if (notFound) {
    return (
      <AmlAccessGate
        title="That report could not be opened"
        body="It may have been deleted, or the reference in the address may be wrong. The AUSTRAC hub lists every report on file."
      />
    );
  }

  return (
    <div className="space-y-6 pb-28">
      <AmlPageHeader
        title={reportId ? "Edit AUSTRAC report" : "Start an AUSTRAC report"}
        description="Assemble the report, hold it on the customer's compliance file, and record who approved it. Lodgement is made in your organisation's own AUSTRAC Online account — nothing here is sent to AUSTRAC."
        icon={FileText}
        actions={
          <Button variant="ghost" size="sm" onClick={() => leave(ADMIN_AML_AUSTRAC_PATH)}>
            <ArrowLeft aria-hidden="true" className="mr-2 h-4 w-4" /> Back to the AUSTRAC hub
          </Button>
        }
      />

      <AustracReportDraftForm
        draft={draft}
        onChange={onChange}
        cases={cases}
        casesFailed={casesFailed}
      />

      {/*
        The action bar is fixed to the foot of the viewport rather than the
        end of the form. On a page this long, a Save button below an
        eighteen-row narrative is a scroll away from wherever the operator is
        working, which is exactly the thing the modal's own footer got right.
      */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border/60 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
          <p className="flex min-w-0 flex-1 items-start gap-2 text-xs leading-relaxed text-muted-foreground">
            {outstanding
              ? <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
              : <Check aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />}
            <span>{draftSummary(sections)}</span>
          </p>
          <div className="flex shrink-0 gap-2">
            <Button variant="ghost" onClick={() => leave(ADMIN_AML_AUSTRAC_PATH)}>Cancel</Button>
            <Button onClick={save} disabled={saving || !canSave}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {reportId ? "Save draft" : "Save and continue"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
