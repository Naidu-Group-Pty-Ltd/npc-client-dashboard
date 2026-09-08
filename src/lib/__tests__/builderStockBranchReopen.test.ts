/**
 * Builder stock — a reopened ROW whose BRANCHES stayed shut.
 *
 * THE DEFECT, MEASURED 7 SEPTEMBER 2026 on production row `a1735941` (Lot
 * 12019, upload `bd7a0ef5`). The runtime version shipped, the migration
 * applied, and `reopen_builder_stock_runtime_failures` moved all six killed
 * properties from `settled` back to `source` at 07:49:00 exactly as designed.
 * Within one second every one of them settled again, unchanged, having fetched
 * nothing: `attempts: 4, runtime_version: null` still stood on the branch that
 * had never been read.
 *
 * THE RULE WAS WRITTEN THREE TIMES AND ONLY ONE COPY LEARNED THE RUNTIME.
 * `attemptFor` compares it. `branchTerminal` — which decides what the settler
 * opens — read `record.attempts >= MAX_PACKAGE_ATTEMPTS` off the record
 * itself, so it agreed with `attemptFor` on every question except the one the
 * runtime version exists to ask. `classifyBranchRecord` — which decides what
 * the operator is told — read it a third time, and reported four sources that
 * could not be read while the queue was busy reopening one of them.
 *
 * The contradiction was measurable in a single harness run: `attemptsSoFar`
 * answered 0 and `packageAttemptsExhausted` answered false for a branch that
 * `openBranches` would not return.
 *
 * So the test that matters is not "does a bump reopen a kill" — that one
 * passed throughout. It is that the three predicates AGREE, over the real
 * stored column, for every branch on it.
 */
import { describe, expect, it } from 'vitest';
import {
  branchTerminal, branchQuestion, openBranches, rowSourceBranches,
} from '../../../supabase/functions/_shared/builderStock/sourceBranches.pure';
import {
  classifyBranchRecord, readSuppliedEvidence,
} from '../../../supabase/functions/_shared/builderStock/suppliedEvidence.pure';
import {
  attemptsSoFar, packageAttemptsExhausted, recordPackageUnprocessable,
  recordPackageUnreachable,
} from '../../../supabase/functions/_shared/builderStock/packageAttempt.pure';
import {
  recordNoDeterministicImage,
} from '../../../supabase/functions/_shared/builderStock/negativeProvenance.pure';
import {
  RUNTIME_VERSION,
} from '../../../supabase/functions/_shared/builderStock/runtimeVersion.pure';

/**
 * The runtime that wrote the fixture below — stated, not derived.
 *
 * Records from it carry no `runtime_version` key at all, which compares equal
 * to zero, so this is 0 and stays 0 however far `RUNTIME_VERSION` advances.
 * Deriving it as `RUNTIME_VERSION - 1` made these tests quietly assert
 * something else the moment the runtime moved to 2.
 */
const KILLED_RUNTIME = 0;
const PV = 23;

const ANSWERED_A = 'https://drive.google.com/file/d/1EVweGf9xDt5G1y_oNDW8dwLhVqzmf6E4/view?usp=drive_link';
const KILLED = 'https://drive.google.com/file/d/1n89z1mZU7D0wya_-hjpAgvuwS2wCfb7I/view?usp=drive_link';
const ANSWERED_B = 'https://drive.google.com/file/d/1rohnpK6cILxM5FHTKJcKNzMjCZxXV0i0/view?usp=drive_link';
const DEAD_LINK = 'https://drive.google.com/file/d/1upxRFpHkZ6EqEcnCIjQYFDdJzERGjT6K/view?usp=drive_link';

/**
 * `source_provenance_result` for Lot 12019, copied from the production row
 * rather than composed here — a shape assembled by the test is a shape the
 * test's own assumptions already agree with, which is how this class of defect
 * survived four passing suites.
 */
const LOT_12019 = {
  branches: {
    [ANSWERED_A]: {
      detail: "That document does not present a page as this property's package cover, so it names no image for it.",
      result: 'no_deterministic_image',
      checked_at: '2026-09-07T02:19:09.028Z',
      exhaustion: 'inspected',
      source_anchor: null,
      package_reference: ANSWERED_A,
      provenance_version: 23,
    },
    [KILLED]: {
      result: 'package_recovery_attempt',
      attempts: 4,
      started_at: '2026-09-07T04:20:03.773Z',
      source_anchor: null,
      package_reference: KILLED,
      provenance_version: 23,
    },
    [ANSWERED_B]: {
      detail: "That document does not present a page as this property's package cover, so it names no image for it.",
      result: 'no_deterministic_image',
      checked_at: '2026-09-07T02:27:05.700Z',
      exhaustion: 'inspected',
      source_anchor: null,
      package_reference: ANSWERED_B,
      provenance_version: 23,
    },
    [DEAD_LINK]: {
      detail: 'That link could not be read after 6 attempts — it answered with no readable document — so no builder image was taken from it.',
      result: 'no_deterministic_image',
      checked_at: '2026-09-07T04:35:06.019Z',
      exhaustion: 'operational',
      source_anchor: null,
      package_reference: DEAD_LINK,
      provenance_version: 23,
    },
  },
};

/** The row's own link columns, in the shape `rowSourceBranches` reads. */
const LOT_12019_LINKS = {
  'Brochure V002': ANSWERED_A,
  'Estate Brochure': KILLED,
  'Siting / Masterplan': ANSWERED_B,
  'Rental Appraisal': DEAD_LINK,
};

const branches = () => rowSourceBranches(LOT_12019_LINKS);
const urls = (open: readonly { url: string }[]) => open.map((b) => b.url).sort();

describe('the row that reopened and re-settled in one second', () => {
  it('offers the killed branch, and only that one, at the new runtime', () => {
    const open = openBranches(LOT_12019, branches(), PV, null, RUNTIME_VERSION);
    expect(urls(open)).toEqual([KILLED]);
  });

  it('offered nothing at the runtime that killed it — the bump is the cause', () => {
    const open = openBranches(LOT_12019, branches(), PV, null, KILLED_RUNTIME);
    expect(urls(open)).toEqual([]);
  });

  it('does not report the killed branch as a source that could not be read', () => {
    const reading = readSuppliedEvidence({
      branches: branches(),
      stored: LOT_12019,
      provenanceVersion: PV,
      runtimeVersion: RUNTIME_VERSION,
      sourceAnchor: null,
    });
    // One branch is still owed a look, so nothing about this property is settled.
    expect(reading.state).toBe('pending');
    expect(reading.open).toBe(1);
    expect(reading.detail).not.toMatch(/could not be read/i);
  });

  it('and DID report exactly that before the bump', () => {
    const reading = readSuppliedEvidence({
      branches: branches(),
      stored: LOT_12019,
      provenanceVersion: PV,
      runtimeVersion: KILLED_RUNTIME,
      sourceAnchor: null,
    });
    expect(reading.open).toBe(0);
    expect(reading.state).toBe('retryable_failure');
  });
});

describe('the three predicates agree, branch by branch', () => {
  /*
   * THE INVARIANT THAT WOULD HAVE CAUGHT IT. The settler opens what
   * `branchTerminal` leaves open; the card says what `classifyBranchRecord`
   * reads; the attempt budget is `packageAttemptsExhausted`. Any two of them
   * disagreeing about one branch is a property that either loops or lies, and
   * both happened here.
   */
  /*
   * The production row carries no runtime-STAMPED retirement — nothing had
   * reached the four-attempt budget under a stamping runtime yet — so one is
   * added beside it. Every property this runtime retires will carry one, and
   * the next bump has to find the two predicates already agreeing about it.
   */
  const withStampedRetirement = {
    branches: {
      ...LOT_12019.branches,
      [DEAD_LINK]: recordPackageUnprocessable({
        provenanceVersion: PV,
        runtimeVersion: KILLED_RUNTIME,
        packageReference: DEAD_LINK,
        sourceAnchor: null,
      }),
    },
  };

  for (const runtime of [KILLED_RUNTIME, RUNTIME_VERSION, RUNTIME_VERSION + 1]) {
    it(`at runtime ${runtime}`, () => {
      for (const branch of branches()) {
        const question = branchQuestion(branch, PV, null, runtime);
        const terminal = branchTerminal(withStampedRetirement, branch, question);
        const verdict = classifyBranchRecord(withStampedRetirement, branch, question);
        expect(
          verdict === 'open' || verdict === 'in_flight',
          `${branch.url} @ ${runtime}: terminal=${terminal} verdict=${verdict}`,
        ).toBe(!terminal);
      }
    });
  }

  it('and the attempt budget agrees with the branch it belongs to', () => {
    const branch = branches().find((b) => b.url === KILLED)!;
    const record = LOT_12019.branches[KILLED];
    const now = branchQuestion(branch, PV, null, RUNTIME_VERSION);
    // The contradiction, asserted directly: not exhausted, therefore not shut.
    expect(attemptsSoFar(record, now)).toBe(0);
    expect(packageAttemptsExhausted(record, now)).toBe(false);
    expect(branchTerminal(LOT_12019, branch, now)).toBe(false);
  });
});

/**
 * The six cases, stated one per test.
 *
 * The half that matters as much as the reopening is the half that must NOT
 * reopen: a runtime-aware comparison that reopens everything is a provenance
 * bump wearing a different name, and this programme has already paid for one
 * of those. So each case names the record and the runtime asking, and both
 * readers are asserted over it — the settler's and the card's.
 */
describe('the runtime-aware reading, case by case', () => {
  const at = (runtime: number) => ({
    provenanceVersion: PV,
    runtimeVersion: runtime,
    packageReference: KILLED,
    sourceAnchor: null,
  });
  const branch = () => branches().find((b) => b.url === KILLED)!;
  const attempt = (over: Record<string, unknown>) => ({
    branches: {
      [KILLED]: {
        result: 'package_recovery_attempt',
        source_anchor: null,
        package_reference: KILLED,
        provenance_version: PV,
        started_at: '2026-09-07T04:20:03.773Z',
        ...over,
      },
    },
  });

  it('attempts 4, no runtime stamp, asked at runtime 1 → open', () => {
    const stored = attempt({ attempts: 4 });
    expect(branchTerminal(stored, branch(), at(RUNTIME_VERSION))).toBe(false);
    expect(classifyBranchRecord(stored, branch(), at(RUNTIME_VERSION))).toBe('open');
  });

  it('attempts 4, runtime 1, asked at runtime 1 → operational', () => {
    const stored = attempt({ attempts: 4, runtime_version: RUNTIME_VERSION });
    expect(branchTerminal(stored, branch(), at(RUNTIME_VERSION))).toBe(true);
    expect(classifyBranchRecord(stored, branch(), at(RUNTIME_VERSION))).toBe('operational');
  });

  it('attempts 2, runtime 1, asked at runtime 1 → in flight', () => {
    const stored = attempt({ attempts: 2, runtime_version: RUNTIME_VERSION });
    expect(branchTerminal(stored, branch(), at(RUNTIME_VERSION))).toBe(false);
    expect(classifyBranchRecord(stored, branch(), at(RUNTIME_VERSION))).toBe('in_flight');
  });

  it('a document that answered stays shut across the bump', () => {
    const stored = {
      branches: {
        [KILLED]: recordNoDeterministicImage(
          at(KILLED_RUNTIME), 'no cover page for this property', 'inspected'),
      },
    };
    expect(branchTerminal(stored, branch(), at(RUNTIME_VERSION))).toBe(true);
    expect(classifyBranchRecord(stored, branch(), at(RUNTIME_VERSION))).toBe('inspected');
  });

  it('a dead link stays shut across the bump', () => {
    const stored = { branches: { [KILLED]: recordPackageUnreachable(at(KILLED_RUNTIME)) } };
    expect(branchTerminal(stored, branch(), at(RUNTIME_VERSION))).toBe(true);
    expect(classifyBranchRecord(stored, branch(), at(RUNTIME_VERSION))).toBe('operational');
  });

  it('an old worker\'s attempt is handed back by openBranches', () => {
    const stored = attempt({ attempts: 4 });
    expect(urls(openBranches(stored, branches(), PV, null, RUNTIME_VERSION))).toContain(KILLED);
    expect(urls(openBranches(stored, branches(), PV, null, KILLED_RUNTIME))).not.toContain(KILLED);
  });
});

describe('which retirements a runtime bump may reach', () => {
  const ask = (runtime: number) => ({
    provenanceVersion: PV,
    runtimeVersion: runtime,
    packageReference: KILLED,
    sourceAnchor: null,
  });
  const branch = () => branches().find((b) => b.url === KILLED)!;
  const stored = (record: unknown) => ({ branches: { [KILLED]: record } });

  it('reopens the four-attempt retirement, which stamps the runtime', () => {
    const retired = stored(recordPackageUnprocessable(ask(KILLED_RUNTIME)));
    expect(branchTerminal(retired, branch(), ask(KILLED_RUNTIME))).toBe(true);
    expect(branchTerminal(retired, branch(), ask(RUNTIME_VERSION))).toBe(false);
  });

  it('never reopens a dead link, however good the worker gets', () => {
    const retired = stored(recordPackageUnreachable(ask(KILLED_RUNTIME)));
    expect(branchTerminal(retired, branch(), ask(RUNTIME_VERSION + 9))).toBe(true);
  });

  it('never reopens a document that answered', () => {
    const answered = stored(recordNoDeterministicImage(
      ask(KILLED_RUNTIME), 'no cover page for this property', 'inspected'));
    expect(branchTerminal(answered, branch(), ask(RUNTIME_VERSION + 9))).toBe(true);
  });

  it('the card stops calling a reopened retirement a source that failed', () => {
    /*
     * THE SAME DEFECT, ONE BUMP LATER. Every property the four-attempt budget
     * retires under this runtime banks a stamped `no_deterministic_image`, and
     * `branchTerminal` reopens it on the next bump. If this reader did not
     * reopen it too, the card would report a source that could not be read
     * while the queue was busy re-reading it — which is precisely the screen
     * Lot 12019 showed, reached by the other terminal shape.
     */
    const retired = stored(recordPackageUnprocessable(ask(KILLED_RUNTIME)));
    expect(classifyBranchRecord(retired, branch(), ask(KILLED_RUNTIME))).toBe('operational');
    expect(classifyBranchRecord(retired, branch(), ask(RUNTIME_VERSION))).toBe('open');
  });

  it('and goes on calling a dead link and an answered document finished', () => {
    const dead = stored(recordPackageUnreachable(ask(KILLED_RUNTIME)));
    const answered = stored(recordNoDeterministicImage(
      ask(KILLED_RUNTIME), 'no cover page for this property', 'inspected'));
    expect(classifyBranchRecord(dead, branch(), ask(RUNTIME_VERSION + 9))).toBe('operational');
    expect(classifyBranchRecord(answered, branch(), ask(RUNTIME_VERSION + 9))).toBe('inspected');
  });

  it('a claim from a superseded runtime is open, never in flight', () => {
    const surviving = stored({
      result: 'package_recovery_attempt',
      attempts: 1,
      source_anchor: null,
      package_reference: KILLED,
      provenance_version: PV,
    });
    expect(classifyBranchRecord(surviving, branch(), ask(KILLED_RUNTIME))).toBe('in_flight');
    expect(classifyBranchRecord(surviving, branch(), ask(RUNTIME_VERSION))).toBe('open');
  });
});
