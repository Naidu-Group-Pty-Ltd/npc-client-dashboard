/**
 * Stage 6's working surface: record and verify source-of-funds evidence.
 *
 * ── Why this exists ───────────────────────────────────────────────────
 * `aml.source_of_funds` had a complete server op and a client API — and no
 * UI called it. Stage 6 said "No source of funds recorded", its button
 * opened a section with nothing actionable, and the customer's own declared
 * funding sat unread in the submission snapshot one query away.
 *
 * ── The flow it creates ───────────────────────────────────────────────
 * The customer declared → the analyst records (one click per declared
 * source, or by hand) → the analyst verifies against evidence → the stage
 * settles, the journey moves to Stage 7, and the Aurixa Passport mints the
 * client-safe SOURCE OF FUNDS REVIEWED stamp.
 *
 * Every rule the panel renders is decided in `fundingEvidence.pure.ts`;
 * nothing here invents a sentence about a stage or a stamp.
 */
import { useCallback, useEffect, useState } from "react";
import {
  BadgeCheck, Banknote, Loader2, Plus, ShieldCheck, Stamp, Trash2, Undo2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";
import { amlCasesApi } from "@/lib/aml/amlCasesApi";
import { amlMonitoringApi, type AmlSofItem } from "@/lib/aml/amlMonitoringApi";
import {
  SOURCE_TYPE_LABEL, draftsFromDeclaredFunding, fundingProgress,
  passportSofStampReadiness, type DeclaredFunding, type SofDraft,
} from "@/lib/aml/fundingEvidence.pure";

export function FundingEvidencePanel({ caseId, canWrite, onChanged }: {
  caseId: string;
  canWrite: boolean;
  /** The workspace's own reload — the journey and next action move with it. */
  onChanged?: () => void;
}) {
  const [items, setItems] = useState<AmlSofItem[] | null>(null);
  const [declared, setDeclared] = useState<DeclaredFunding | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draftType, setDraftType] = useState("savings");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftAmount, setDraftAmount] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await amlMonitoringApi.listSof({ case_id: caseId });
      setItems(res?.items ?? []);
    } catch {
      // An unreadable list is unknown, never empty: `null` renders as a
      // failed read, and nothing below offers to "start" over data it
      // cannot see.
      setItems(null);
    }
    try {
      const review = await amlCasesApi.getSubmissionReview(caseId);
      const funding = review?.submission?.sections
        ?.find((s) => s.section === "funding")?.payload ?? null;
      setDeclared(funding as DeclaredFunding | null);
    } catch {
      setDeclared(null);
    }
  }, [caseId]);

  useEffect(() => { void load(); }, [load]);

  const write = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
      await load();
      onChanged?.();
    } catch (e: unknown) {
      toast({
        title: "The change could not be recorded",
        description: e instanceof Error ? e.message : "The server refused it.",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const record = (draft: SofDraft) => write(`draft:${draft.description}`, () =>
    amlMonitoringApi.upsertSof({ case_id: caseId, ...draft }));

  const drafts = items === null ? [] : draftsFromDeclaredFunding(declared, items);
  const progress = fundingProgress(items ?? []);
  const stamp = passportSofStampReadiness(items ?? []);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Banknote aria-hidden className="h-4 w-4" />
          Source of funds — record and verify
        </CardTitle>
        <p className="text-xs text-muted-foreground">{progress.sentence}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {items === null ? (
          <p className="text-xs text-muted-foreground">
            The recorded sources could not be read. That is a technical
            condition, not an empty list — retry before recording anything.
          </p>
        ) : (
          <>
            {/*
              ── What the customer declared ─────────────────────────────
              Seeded, never auto-recorded: a person presses the button, so
              the record of who put each row there is true. A draft arrives
              UNVERIFIED — the declaration is evidence towards verification
              and never the verification.
            */}
            {drafts.length > 0 && canWrite && (
              <div className="rounded-md border border-info/40 bg-info/5 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-info">
                  Declared by the customer, not yet recorded
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  From their portal submission. Recording carries their words
                  into the evidence table — unverified, until you verify each
                  against real evidence.
                </p>
                <ul className="mt-2 space-y-1.5">
                  {drafts.map((d) => (
                    <li key={d.description} className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs">
                        <span className="font-medium">{d.description}</span>
                        <span className="text-muted-foreground">
                          {" "}· {SOURCE_TYPE_LABEL[d.source_type] ?? d.source_type}
                        </span>
                      </span>
                      <Button
                        type="button" size="sm" variant="outline" className="h-7"
                        disabled={busy !== null}
                        onClick={() => void record(d)}
                      >
                        {busy === `draft:${d.description}`
                          ? <Loader2 aria-hidden className="mr-1.5 h-3 w-3 animate-spin" />
                          : <Plus aria-hidden className="mr-1.5 h-3 w-3" />}
                        Record as a source
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* ── The recorded sources ───────────────────────────────── */}
            {items.length > 0 && (
              <ul className="space-y-2">
                {items.map((item) => (
                  <li key={item.id} className={cn(
                    "rounded-md border p-3",
                    item.verified ? "border-success/40 bg-success/5" : "border-border/60",
                  )}>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          {item.description || SOURCE_TYPE_LABEL[item.source_type] || item.source_type}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {SOURCE_TYPE_LABEL[item.source_type] ?? item.source_type}
                          {item.amount !== null && ` · ${item.currency} ${Number(item.amount).toLocaleString()}`}
                          {item.verified && item.verified_at
                            && ` · verified ${String(item.verified_at).slice(0, 10)}`}
                        </p>
                        {item.notes && (
                          <p className="mt-1 text-[11px] text-muted-foreground">{item.notes}</p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Badge
                          variant={item.verified ? "outline" : "secondary"}
                          className={cn("text-[10px]",
                            item.verified && "border-success/50 bg-success/10 text-success")}
                        >
                          {item.verified ? "Verified" : "Recorded — not verified"}
                        </Badge>
                      </div>
                    </div>
                    {canWrite && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {item.verified ? (
                          <Button
                            type="button" size="sm" variant="outline" className="h-7"
                            disabled={busy !== null}
                            onClick={() => void write(`unverify:${item.id}`, () =>
                              amlMonitoringApi.upsertSof({ id: item.id, case_id: caseId, verified: false }))}
                          >
                            <Undo2 aria-hidden className="mr-1.5 h-3 w-3" />
                            Withdraw verification
                          </Button>
                        ) : (
                          <Button
                            type="button" size="sm" variant="secondary" className="h-7"
                            disabled={busy !== null}
                            onClick={() => void write(`verify:${item.id}`, () =>
                              amlMonitoringApi.upsertSof({ id: item.id, case_id: caseId, verified: true }))}
                          >
                            {busy === `verify:${item.id}`
                              ? <Loader2 aria-hidden className="mr-1.5 h-3 w-3 animate-spin" />
                              : <BadgeCheck aria-hidden className="mr-1.5 h-3 w-3" />}
                            Verify against evidence
                          </Button>
                        )}
                        <Button
                          type="button" size="sm" variant="ghost" className="h-7"
                          aria-label={`Remove ${item.description || item.source_type}`}
                          disabled={busy !== null}
                          onClick={() => void write(`delete:${item.id}`, () =>
                            amlMonitoringApi.deleteSof(item.id))}
                        >
                          <Trash2 aria-hidden className="h-3 w-3" />
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {/* ── Add by hand ────────────────────────────────────────── */}
            {canWrite && (adding ? (
              <div className="rounded-md border border-border/60 p-3">
                <div className="grid gap-2 sm:grid-cols-3">
                  <div>
                    <Label className="text-[11px]" htmlFor="sof-type">Source type</Label>
                    <Select value={draftType} onValueChange={setDraftType}>
                      <SelectTrigger id="sof-type" className="mt-1 h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(SOURCE_TYPE_LABEL).map(([code, label]) => (
                          <SelectItem key={code} value={code}>{label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-[11px]" htmlFor="sof-desc">Description</Label>
                    <Input
                      id="sof-desc" className="mt-1 h-8" value={draftDescription}
                      onChange={(e) => setDraftDescription(e.target.value)}
                      placeholder="e.g. CBA savings account"
                    />
                  </div>
                  <div>
                    <Label className="text-[11px]" htmlFor="sof-amount">Amount (AUD, optional)</Label>
                    <Input
                      id="sof-amount" className="mt-1 h-8" inputMode="decimal"
                      value={draftAmount} onChange={(e) => setDraftAmount(e.target.value)}
                    />
                  </div>
                </div>
                <div className="mt-2 flex gap-2">
                  <Button
                    type="button" size="sm" className="h-7"
                    disabled={busy !== null || !draftDescription.trim()}
                    onClick={() => void write("add", async () => {
                      const amount = Number(draftAmount.replace(/[^0-9.]/g, ""));
                      await amlMonitoringApi.upsertSof({
                        case_id: caseId,
                        source_type: draftType,
                        description: draftDescription.trim(),
                        amount: Number.isFinite(amount) && draftAmount.trim() ? amount : null,
                        currency: "AUD",
                      });
                      setAdding(false); setDraftDescription(""); setDraftAmount("");
                    })}
                  >
                    Record
                  </Button>
                  <Button
                    type="button" size="sm" variant="ghost" className="h-7"
                    onClick={() => setAdding(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                type="button" size="sm" variant="outline"
                disabled={busy !== null}
                onClick={() => setAdding(true)}
              >
                <Plus aria-hidden className="mr-1.5 h-3.5 w-3.5" />
                Record another source
              </Button>
            ))}

            {/*
              ── The Aurixa Passport, told the truth ────────────────────
              Rendered from the same rule the passport derives the stamp
              with, so this panel can never promise a stamp the passport
              will not mint. The analyst verifying evidence is producing
              something outward-facing, and should know it.
            */}
            <p className={cn(
              "flex items-start gap-1.5 rounded-md border p-2.5 text-[11px]",
              stamp.earned
                ? "border-success/40 bg-success/5 text-success"
                : "border-border/60 bg-muted/20 text-muted-foreground",
            )}>
              {stamp.earned
                ? <Stamp aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                : <ShieldCheck aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
              <span>{stamp.sentence}</span>
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
