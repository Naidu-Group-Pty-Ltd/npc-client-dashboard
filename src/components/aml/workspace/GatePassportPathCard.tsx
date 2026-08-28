/**
 * Stage 9's guided path: decision → gate → preview → issue, with the
 * Stage 8 outcome pulled through and every step a link to where it is
 * done. Derives nothing — states come from `gatePassportPath.pure.ts`,
 * the audited acts stay on their own surfaces (the Decision stage, the
 * reliance panel, the digital passport page).
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ArrowRight, CheckCircle2, ChevronRight, CircleDashed, Eye, Lock } from "lucide-react";
import { gatePassportComplete, type GatePassportStep } from "@/lib/aml/gatePassportPath.pure";

function StepIcon({ state }: { state: GatePassportStep["state"] }) {
  if (state === "done") return <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />;
  if (state === "blocked") return <Lock className="h-4 w-4 text-warning" aria-hidden />;
  if (state === "current") return <ChevronRight className="h-4 w-4 text-primary" aria-hidden />;
  if (state === "anytime") return <Eye className="h-4 w-4 text-muted-foreground" aria-hidden />;
  return <CircleDashed className="h-4 w-4 text-muted-foreground/60" aria-hidden />;
}

const STATE_LABEL: Record<GatePassportStep["state"], string> = {
  done: "Done",
  current: "Next",
  outstanding: "Later",
  blocked: "Blocked",
  anytime: "Anytime",
};

export function GatePassportPathCard({ steps, onStepClick, onContinue }: {
  steps: GatePassportStep[];
  onStepClick?: (key: GatePassportStep["key"]) => void;
  /** Stage 10 — partners — once the credential is in force. */
  onContinue?: () => void;
}) {
  const complete = gatePassportComplete(steps);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Gate &amp; Passport, in order</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {complete && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-success/40 bg-success/5 p-2.5">
            <p className="text-xs text-success">
              The service may proceed and the Passport is in force. Partners come next.
            </p>
            {onContinue && (
              <Button size="sm" className="h-7" onClick={onContinue}>
                Continue to Partners
                <ArrowRight aria-hidden className="ml-1.5 h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        )}
        <ol className="space-y-1.5">
          {steps.map((step, i) => {
            const inner = (
              <>
                <span className="mt-0.5 shrink-0"><StepIcon state={step.state} /></span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-sm font-medium">{i + 1}. {step.label}</span>
                    <span className={cn(
                      "text-[11px] uppercase tracking-wide",
                      step.state === "current" ? "text-primary"
                        : step.state === "blocked" ? "text-warning"
                          : "text-muted-foreground",
                    )}>
                      {STATE_LABEL[step.state]}
                    </span>
                  </span>
                  <span className="block text-xs text-muted-foreground">{step.detail}</span>
                  {step.blockedBy && (
                    <span className="block text-xs text-warning">{step.blockedBy}.</span>
                  )}
                </span>
              </>
            );
            const tone = cn(
              "flex w-full items-start gap-2.5 rounded-md border p-2.5 text-left",
              step.state === "current"
                ? "border-primary/40 bg-primary/5"
                : step.state === "blocked"
                  ? "border-warning/40 bg-warning/5"
                  : "border-border/50",
            );
            return (
              <li key={step.key}>
                {onStepClick ? (
                  <button
                    type="button"
                    className={cn(tone, "transition-colors hover:border-primary/60")}
                    onClick={() => onStepClick(step.key)}
                    aria-label={`Go to step ${i + 1}: ${step.label}`}
                  >
                    {inner}
                  </button>
                ) : (
                  <div className={tone}>{inner}</div>
                )}
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}
