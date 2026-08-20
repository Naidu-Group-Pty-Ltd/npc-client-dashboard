/**
 * What the office-holder index holds, said on the step itself.
 *
 * ── Why this is not inside the dialog ─────────────────────────────────
 * It was. The coverage was reachable only as a side-effect of running a
 * search, which means an operator learned whether the index was loaded
 * AFTER they had already leaned on it — and the reading that matters most
 * is the one they get before.
 *
 * It also made a whole working integration invisible: the index loaded,
 * the endpoint answered, and Stage 5 looked exactly as it had the day
 * before, because every sign of it was two clicks deep.
 *
 * ── What it may and may not say ───────────────────────────────────────
 * The same rule as everywhere else here: this describes a TOOL, never a
 * subject. It reports how many people and offices are loaded and how
 * current they are. It says nothing about the party being determined, and
 * an index in perfect health is not evidence about anybody.
 *
 * An index that has not loaded says so plainly and does not hide the step:
 * the determination is made from the sources an operator checks, and this
 * only saves them typing.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, Database, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { amlCasesApi } from "@/lib/aml/amlCasesApi";
import { indexIsUsable, type PepIndexCoverage } from "@/lib/aml/pepOfficeholderIndex";

type State =
  | { kind: "loading" }
  | { kind: "unreadable" }
  | { kind: "read"; coverage: PepIndexCoverage[]; usable: boolean };

export function PepIndexReadiness({ className }: { className?: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await amlCasesApi.pepOfficeholderIndexStatus();
        if (!live) return;
        const coverage = res?.coverage ?? [];
        setState({ kind: "read", coverage, usable: indexIsUsable(coverage) });
      } catch {
        // Unknown is not empty. An index whose state could not be read must
        // never render as an index holding nothing.
        if (live) setState({ kind: "unreadable" });
      }
    })();
    return () => { live = false; };
  }, []);

  if (state.kind === "loading") {
    return (
      <p className={cn("flex items-center gap-1.5 text-xs text-muted-foreground", className)}>
        <Loader2 aria-hidden className="h-3 w-3 animate-spin" />
        Checking the office-holder index…
      </p>
    );
  }

  if (state.kind === "unreadable") {
    return (
      <p className={cn("flex items-start gap-1.5 text-xs text-muted-foreground", className)}>
        <AlertTriangle aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
        The office-holder index state could not be read. The determination is
        unaffected — it is made from the sources you check.
      </p>
    );
  }

  const loaded = state.coverage.filter(
    (c) => c.entryCount > 0 && c.lastSyncStatus === "succeeded");
  const people = loaded.reduce((n, c) => n + c.entryCount, 0);
  const offices = loaded.reduce((n, c) => n + (c.officeCount ?? 0), 0);
  const asAt = loaded.map((c) => c.sourceAsAt).filter(Boolean).sort().reverse()[0] ?? null;

  return (
    <p
      className={cn(
        "flex items-start gap-1.5 text-xs",
        state.usable ? "text-muted-foreground" : "text-warning",
        className,
      )}
    >
      {state.usable
        ? <Database aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
        : <AlertTriangle aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />}
      {state.usable ? (
        <span>
          <span className="font-medium text-foreground">
            Office-holder index ready
          </span>
          {" — "}
          {people.toLocaleString()} people
          {offices > 0 && ` across ${offices.toLocaleString()} offices`}
          {asAt && `, current to ${asAt}`}. Searched from inside the
          determination. A hit is a candidate to confirm; it never clears
          anybody.
        </span>
      ) : (
        <span>
          <span className="font-medium">Office-holder index not loaded.</span>{" "}
          The public sources still open from inside the determination, and the
          determination is made from what you record.
        </span>
      )}
    </p>
  );
}
