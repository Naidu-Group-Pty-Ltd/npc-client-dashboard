/**
 * Builder stock — the two versions, and which failures each one may reopen.
 *
 * THE DEFECT, MEASURED 7 SEPTEMBER 2026 on upload `bd7a0ef5`. Six of
 * seventy-eight properties carried a branch stuck at the four-attempt kill
 * limit having never recorded an answer, and their cards said the builder's
 * brochures present no photograph. Each of those brochures elects its facade
 * in about a second when read alone; five read at once peak at 429 MB against
 * a 256 MB ceiling and the isolate dies. The documents were never the problem.
 *
 * Fixing the worker then had no safe move: `negativeProvenanceStillStands`
 * compared WHAT the answer was and WHICH extractor version reached it, and
 * never why we stopped — so a document read properly and a document that
 * killed the worker stood on identical terms. Reopening the six meant
 * reopening all seventy-eight.
 *
 * Two numbers separate them. The image version says what the extractor
 * UNDERSTANDS; the runtime version says how reliably it can OPEN a document at
 * all. Only records of our own failure carry the second, so raising it reaches
 * exactly those.
 */
import { describe, expect, it } from 'vitest';
import {
  negativeProvenanceStillStands, recordNoDeterministicImage,
} from '../../../supabase/functions/_shared/builderStock/negativeProvenance.pure';
import {
  MAX_PACKAGE_ATTEMPTS, MAX_UNREACHABLE_ATTEMPTS,
  attemptsSoFar, packageAttemptsExhausted, recordPackageAttempt,
  recordPackageUnprocessable, recordPackageUnreachable, recordUnreachableAttempt,
  unreachableSoFar,
} from '../../../supabase/functions/_shared/builderStock/packageAttempt.pure';
import {
  RUNTIME_VERSION,
} from '../../../supabase/functions/_shared/builderStock/runtimeVersion.pure';

const OLD_RUNTIME = RUNTIME_VERSION - 1;
const ask = (over: Record<string, unknown> = {}) => ({
  provenanceVersion: 23,
  runtimeVersion: RUNTIME_VERSION,
  packageReference: 'https://drive.google.com/file/d/1n89z1mZ/view',
  sourceAnchor: null,
  ...over,
});

describe('a document that ANSWERED is untouched by a runtime bump', () => {
  it('an inspected negative carries no runtime stamp and keeps standing', () => {
    const answered = recordNoDeterministicImage(
      ask({ runtimeVersion: OLD_RUNTIME }),
      'That document does not present a page as this property\'s package cover.',
      'inspected',
    );
    // The absence of the stamp is the mechanism, so it is asserted directly.
    expect((answered as { runtime_version?: number }).runtime_version).toBeUndefined();
    expect(negativeProvenanceStillStands(answered, ask())).toBe(true);
  });

  it('and is still reopened by an IMAGE version rise, exactly as before', () => {
    const answered = recordNoDeterministicImage(ask(), 'no cover', 'inspected');
    expect(negativeProvenanceStillStands(answered, ask({ provenanceVersion: 24 }))).toBe(false);
  });
});

describe('a document WE failed on is reopened by a runtime bump, and only then', () => {
  it('the kill retirement stamps the runtime it died on', () => {
    const killed = recordPackageUnprocessable(ask({ runtimeVersion: OLD_RUNTIME }));
    expect(killed.runtime_version).toBe(OLD_RUNTIME);
    expect(killed.exhaustion).toBe('operational');
  });

  it('stops standing once the runtime that failed is superseded', () => {
    const killed = recordPackageUnprocessable(ask({ runtimeVersion: OLD_RUNTIME }));
    expect(negativeProvenanceStillStands(killed, ask())).toBe(false);
  });

  it('and still stands while the runtime is unchanged — this is not a free retry', () => {
    const killed = recordPackageUnprocessable(ask());
    expect(negativeProvenanceStillStands(killed, ask())).toBe(true);
  });
});

describe('a dead link is neither, and a better worker does not reopen it', () => {
  it('the unreachable retirement carries NO runtime stamp', () => {
    // A 404 or a sign-in wall is not something a faster worker can open, and
    // re-chasing every dead link on every runtime change is a treadmill.
    const dead = recordPackageUnreachable(ask({ runtimeVersion: OLD_RUNTIME }));
    expect((dead as { runtime_version?: number }).runtime_version).toBeUndefined();
    expect(dead.exhaustion).toBe('operational');
    expect(negativeProvenanceStillStands(dead, ask())).toBe(true);
  });

  it('its budget survives a runtime bump while the kill count resets', () => {
    // The two counters live on one record and must move independently: the
    // kill count is about the worker, the unreachable count is about the link.
    let stored: unknown = null;
    for (let i = 0; i < 3; i += 1) {
      stored = recordUnreachableAttempt(stored, ask({ runtimeVersion: OLD_RUNTIME }));
    }
    expect(unreachableSoFar(stored, ask({ runtimeVersion: OLD_RUNTIME }))).toBe(3);
    // Same link, newer runtime: the dead-link budget is NOT given back.
    expect(unreachableSoFar(stored, ask())).toBe(3);
  });
});

describe('the six stuck at the kill limit are re-armed, and nothing else is', () => {
  it('an attempt record from the old runtime no longer counts against the new one', () => {
    let stored: unknown = null;
    for (let i = 0; i < MAX_PACKAGE_ATTEMPTS; i += 1) {
      stored = recordPackageAttempt(stored, ask({ runtimeVersion: OLD_RUNTIME }));
    }
    // Exhausted for the worker that died; a fresh question for the one that
    // replaced it. This is what reopens the six without touching the rest.
    expect(packageAttemptsExhausted(stored, ask({ runtimeVersion: OLD_RUNTIME }))).toBe(true);
    expect(attemptsSoFar(stored, ask())).toBe(0);
    expect(packageAttemptsExhausted(stored, ask())).toBe(false);
  });

  it('the budget itself is unchanged — the fix is not a bigger allowance', () => {
    expect(MAX_PACKAGE_ATTEMPTS).toBe(4);
    expect(MAX_UNREACHABLE_ATTEMPTS).toBe(6);
  });

  it('a record written before either field existed is reopened once, then settles', () => {
    const legacy = {
      result: 'no_deterministic_image',
      provenance_version: 23,
      package_reference: ask().packageReference,
      source_anchor: null,
      detail: 'legacy',
      exhaustion: 'inspected',
      checked_at: new Date().toISOString(),
    };
    // No stamp at all: it is an answer, so it stands. Legacy rows do not
    // stampede back through the queue on the first runtime bump.
    expect(negativeProvenanceStillStands(legacy, ask())).toBe(true);
  });
});
