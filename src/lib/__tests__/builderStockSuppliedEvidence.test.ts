/**
 * BUILDER STOCK — THE ONLINE FALLBACK MAY NOT RUN UNTIL THE BUILDER'S OWN
 * SOURCES ARE FINISHED WITH.
 *
 * WHAT THESE PIN, AND WHY EACH OF THEM COST A REAL CARD.
 *
 * The stock list is the source of truth. A builder usually hands the marketing
 * material over inside it — a hyperlink behind the word `Brochure`, a Dropbox
 * package, a Drive folder — and the external search ladder exists only for the
 * rows where they genuinely have not. The gate used to be the STAGE ORDER:
 * `source` runs before `fallback`, therefore source is finished. That is a
 * statement about the scheduler, not about the evidence.
 *
 * Underneath it, a worse collapse. This repository has exactly one negative
 * result, `no_deterministic_image`, and THREE different things wrote it: a
 * document we read that names nothing; a package that destroyed the worker
 * twice; and a link that answered six times with nothing readable. Only the
 * first is knowledge about the property. So a brochure too big to open read,
 * downstream, as a builder who supplied nothing.
 *
 * MEASURED IN PRODUCTION, 2 SEPTEMBER 2026, the live Luxton list:
 *
 *   Lot 516 (10.6 MB) and Lot 6706 (13.2 MB)  attempts: 2, one tick from being
 *   retired as documents that "name no image" — while both brochures state the
 *   lot, the street, the price and the land size, and both yield a 2000x1250
 *   render in under six seconds once the decode is scoped to the cover page.
 *
 *   Lot 818  its brochure refused before it was ever fetched (the old
 *   Drive-only front door), the ladder allowed to run, and the card given
 *   `…/verve-estate-clyde-north-lot-818-render.jpg` off the page
 *   `openlot.com.au/…/lot-118-by-simonds-homes-52221` — a different lot, by a
 *   different builder, on a client's screen.
 *
 * THE RULE: a timeout is not exhaustion. A worker kill, a 5xx, a rate limit,
 * an unreadable link — none of them is "we looked and there was nothing". The
 * ladder stays shut, the card stays BLANK, and the way back is a
 * `PROVENANCE_VERSION` bump rather than a hand-edited row.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  classifyBranchRecord, describeSuppliedEvidence, fallbackMayRun,
  readSuppliedEvidence,
} from '../../../supabase/functions/_shared/builderStock/suppliedEvidence.pure';
import {
  branchQuestion, rowSourceBranches, writeBranchState,
} from '../../../supabase/functions/_shared/builderStock/sourceBranches.pure';
import {
  recordNoDeterministicImage,
} from '../../../supabase/functions/_shared/builderStock/negativeProvenance.pure';
import {
  MAX_PACKAGE_ATTEMPTS, recordPackageAttempt, recordPackageUnprocessable,
  recordPackageUnreachable,
} from '../../../supabase/functions/_shared/builderStock/packageAttempt.pure';
import {
  PROVENANCE_VERSION,
} from '../../../supabase/functions/_shared/builderStock/provenanceVersion.pure';
import {
  settleFallbackImages,
} from '../../../supabase/functions/_shared/builderStock/settleFallbackImages';

// The shape of a live Luxton row: the label is the visible cell, the address
// is the hyperlink underneath it that `mergeHyperlinkColumns` put beside it.
const BROCHURE = 'https://www.dropbox.com/scl/fi/34rh1r9avi7v09k208igp/Lot-824-Verve.pdf'
  + '?rlkey=f2bzhpxqv13dqep0k9wo5ajyv&dl=0';
const SECOND = 'https://www.dropbox.com/scl/fi/aaaaaaaaaaaa/Lot-824-Siting.pdf?dl=0';

const unmappedWith = (...urls: string[]): Record<string, string> =>
  Object.fromEntries(urls.map((url, index) => [`column_${20 + index}`, url]));

const branchesOf = (...urls: string[]) => rowSourceBranches(unmappedWith(...urls));

const ask = (url: string) =>
  branchQuestion({ url, column: 'DOWNLOAD', kind: 'document' }, PROVENANCE_VERSION, null);

const read = (stored: unknown, urls: string[] = [BROCHURE]) => readSuppliedEvidence({
  branches: branchesOf(...urls), stored, provenanceVersion: PROVENANCE_VERSION,
  sourceAnchor: null,
});

// ---------------------------------------------------------------------------
// The state itself
// ---------------------------------------------------------------------------

describe('what "finished looking" means for one property', () => {
  it('a row that names no source at all has nothing to look at', () => {
    const reading = readSuppliedEvidence({
      branches: [], stored: null, provenanceVersion: PROVENANCE_VERSION, sourceAnchor: null,
    });
    expect(reading.state).toBe('no_evidence');
    expect(fallbackMayRun(reading.state)).toBe(true);
  });

  it('a brochure nobody has opened is PENDING, and the ladder stays shut', () => {
    const reading = read(null);
    expect(reading.state).toBe('pending');
    expect(reading.open).toBe(1);
    expect(fallbackMayRun(reading.state)).toBe(false);
  });

  it('a recovery in flight is PROCESSING, and the ladder stays shut', () => {
    const stored = writeBranchState(null, BROCHURE, recordPackageAttempt(null, ask(BROCHURE)));
    const reading = read(stored);
    expect(reading.state).toBe('processing');
    expect(fallbackMayRun(reading.state)).toBe(false);
  });

  it('a document READ that names nothing is EXHAUSTED, and the ladder may run', () => {
    const stored = writeBranchState(null, BROCHURE,
      recordNoDeterministicImage(ask(BROCHURE), 'read it; no page names this lot', 'inspected'));
    const reading = read(stored);
    expect(reading.state).toBe('exhausted');
    expect(reading.inspected).toBe(1);
    expect(fallbackMayRun(reading.state)).toBe(true);
  });

  it('the builder\'s own picture settles it — even though a success CLEARS its branch record', () => {
    /*
     * The branch record is erased when a recovery succeeds, so by the
     * provenance column alone this property looks `pending` for ever. The
     * accepted picture is the fact that answers the question, and it is
     * ADMITTED to the ladder module deliberately: the ladder spends nothing
     * on it (`nextImageStage` answers `none`, the paid stages record
     * themselves skipped) and owns the bookkeeping that marks the enrichment
     * complete and takes the property out of the queue. Measured live: Lot
     * 824 gained its brochure image and then bounced fallback→source on
     * every claim, because the reader could not see the picture.
     */
    const reading = readSuppliedEvidence({
      branches: branchesOf(BROCHURE), stored: null, provenanceVersion: PROVENANCE_VERSION,
      sourceAnchor: null, builderImageAccepted: true,
    });
    expect(reading.state).toBe('found');
    expect(fallbackMayRun(reading.state)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A TIMEOUT IS NOT EXHAUSTION — the requirement this whole file exists for
// ---------------------------------------------------------------------------

describe('an operational failure never becomes evidence exhaustion', () => {
  it('a package that DESTROYED the worker is retryable, not exhausted', () => {
    // `recordPackageUnprocessable` is what Lot 516 and Lot 6706 were one tick
    // away from. It writes `no_deterministic_image` — the same word a genuine
    // read writes — and it must not mean the same thing.
    const stored = writeBranchState(null, BROCHURE, recordPackageUnprocessable(ask(BROCHURE)));
    const reading = read(stored);
    expect(reading.state).toBe('retryable_failure');
    expect(reading.operational).toBe(1);
    expect(reading.inspected).toBe(0);
    expect(fallbackMayRun(reading.state)).toBe(false);
  });

  it('a link that could never be READ is retryable, not exhausted', () => {
    const stored = writeBranchState(null, BROCHURE, recordPackageUnreachable(ask(BROCHURE)));
    expect(read(stored).state).toBe('retryable_failure');
    expect(fallbackMayRun(read(stored).state)).toBe(false);
  });

  it('a surviving attempt past its budget is a KILLED worker, not an answer', () => {
    let record: unknown = null;
    for (let n = 0; n < MAX_PACKAGE_ATTEMPTS; n += 1) {
      record = recordPackageAttempt(record, ask(BROCHURE));
    }
    const verdict = classifyBranchRecord(
      writeBranchState(null, BROCHURE, record),
      { url: BROCHURE, column: 'DOWNLOAD', kind: 'document' }, ask(BROCHURE));
    expect(verdict).toBe('operational');
  });

  it('a record from BEFORE the reason was recorded is treated as operational', () => {
    /*
     * The safe reading of "we do not know which of the three wrote this" is
     * the one that keeps the ladder shut. It is not a cliff — the version rose
     * in the same change, so no legacy record is asked this question — but a
     * rollback must not reopen the hole.
     */
    const legacy = recordNoDeterministicImage(ask(BROCHURE), 'legacy', 'inspected') as
      unknown as Record<string, unknown>;
    delete legacy.exhaustion;
    expect(read(writeBranchState(null, BROCHURE, legacy)).state).toBe('retryable_failure');
  });

  it('ONE failed source withholds the ladder however many siblings were read', () => {
    const stored = writeBranchState(
      writeBranchState(null, BROCHURE,
        recordNoDeterministicImage(ask(BROCHURE), 'read it', 'inspected')),
      SECOND, recordPackageUnprocessable(ask(SECOND)));
    const reading = read(stored, [BROCHURE, SECOND]);
    expect(reading.inspected).toBe(1);
    expect(reading.operational).toBe(1);
    expect(reading.state).toBe('retryable_failure');
    expect(fallbackMayRun(reading.state)).toBe(false);
  });

  it('and one UNOPENED source withholds it however many siblings answered', () => {
    const stored = writeBranchState(null, BROCHURE,
      recordNoDeterministicImage(ask(BROCHURE), 'read it', 'inspected'));
    expect(read(stored, [BROCHURE, SECOND]).state).toBe('pending');
  });

  it('a version bump re-opens an operational retirement — the only way back', () => {
    const stored = writeBranchState(null, BROCHURE, recordPackageUnprocessable(ask(BROCHURE)));
    const laterReader = readSuppliedEvidence({
      branches: branchesOf(BROCHURE), stored,
      provenanceVersion: PROVENANCE_VERSION + 1, sourceAnchor: null,
    });
    expect(laterReader.state).toBe('pending');
    expect(laterReader.open).toBe(1);
  });

  it('says which it is in words an operator can act on', () => {
    const stored = writeBranchState(null, BROCHURE, recordPackageUnprocessable(ask(BROCHURE)));
    const said = describeSuppliedEvidence(read(stored));
    expect(said).toContain('retryable_failure');
    expect(said).toContain('fault on our side');
    // Never a URL, a token or a signed address on a column operators read.
    expect(said).not.toContain('dropbox.com');
    expect(said).not.toContain('rlkey');
  });
});

// ---------------------------------------------------------------------------
// THE ENFORCEMENT, at the one place the ladder is bought
// ---------------------------------------------------------------------------

interface Row { [key: string]: unknown }

function fakeDb(items: Row[]) {
  const tables: Record<string, Row[]> = {
    builder_stock_items: items,
    builder_organisations: [{ id: 'org-a', trading_name: 'Luxton Homes' }],
  };
  const matches = (row: Row, filters: Array<[string, string, unknown]>) =>
    filters.every(([op, column, value]) => {
      if (op === 'eq') return row[column] === value;
      if (op === 'in') return Array.isArray(value) && value.includes(row[column]);
      return true;
    });
  const selectBuilder = (table: string) => {
    const filters: Array<[string, string, unknown]> = [];
    const builder: any = {
      eq(c: string, v: unknown) { filters.push(['eq', c, v]); return builder; },
      in(c: string, v: unknown) { filters.push(['in', c, v]); return builder; },
      order() { return builder; },
      limit() { return builder; },
      maybeSingle: () => Promise.resolve({
        data: (tables[table] ?? []).filter((row) => matches(row, filters))[0] ?? null,
        error: null,
      }),
      then(resolve: (v: unknown) => unknown, reject?: unknown) {
        return Promise.resolve({
          data: (tables[table] ?? []).filter((row) => matches(row, filters)), error: null,
        }).then(resolve, reject as never);
      },
    };
    return builder;
  };
  return {
    from: (table: string) => ({
      select: () => selectBuilder(table),
      update: () => {
        const builder: any = {
          eq: () => builder,
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: null, error: null }).then(resolve),
        };
        return builder;
      },
    }),
  } as any;
}

const property = (over: Row = {}): Row => ({
  id: 'item-824',
  organisation_id: 'org-a',
  lifecycle_status: 'active',
  enrichment_status: 'pending',
  primary_image_id: null,
  address_line: 'Lot 824 Sorrel Way, Clyde North',
  suburb: 'Clyde', state: 'VIC', postcode: '3978',
  development_name: 'Verve Estate', project_name: null,
  lot_number: '824', unit_number: null,
  source_row: { unmapped: unmappedWith(BROCHURE) },
  source_provenance_result: null,
  ...over,
});

async function runLadder(items: Row[]) {
  const enrich = vi.fn(async () => ({ outcomes: [{ status: 'ok' }] }));
  const outcome = await settleFallbackImages(
    fakeDb(items), { limit: 5, stockItemId: null }, { enrich: enrich as never },
  );
  return { enrich, outcome };
}

describe('the ladder itself refuses to run — this is the enforcement', () => {
  it('spends NOTHING while the builder\'s brochure has not been opened', async () => {
    const { enrich, outcome } = await runLadder([property()]);
    expect(enrich).not.toHaveBeenCalled();
    expect(outcome.attempted).toBe(0);
    expect(outcome.withheld).toBe(1);
    expect(outcome.problems[0].reason).toContain('pending');
  });

  it('spends NOTHING while a recovery is in flight', async () => {
    const { enrich, outcome } = await runLadder([property({
      source_provenance_result: writeBranchState(
        null, BROCHURE, recordPackageAttempt(null, ask(BROCHURE))),
    })]);
    expect(enrich).not.toHaveBeenCalled();
    expect(outcome.withheld).toBe(1);
  });

  it('spends NOTHING after a worker kill — the case that used to buy the ladder', async () => {
    const { enrich, outcome } = await runLadder([property({
      source_provenance_result: writeBranchState(
        null, BROCHURE, recordPackageUnprocessable(ask(BROCHURE))),
    })]);
    expect(enrich).not.toHaveBeenCalled();
    expect(outcome.withheld).toBe(1);
    expect(outcome.problems[0].reason).toContain('fault on our side');
  });

  it('RUNS once the document has been read and names nothing', async () => {
    const { enrich, outcome } = await runLadder([property({
      source_provenance_result: writeBranchState(null, BROCHURE,
        recordNoDeterministicImage(ask(BROCHURE), 'read it; names no lot', 'inspected')),
    })]);
    // Called at all is the assertion; the ladder climbs up to two rungs per
    // property and how many it climbs is `settleFallbackImages`' own business.
    expect(enrich).toHaveBeenCalled();
    expect(outcome.attempted).toBe(1);
    expect(outcome.withheld).toBe(0);
  });

  it('RUNS for a property whose row names no source at all', async () => {
    const { enrich } = await runLadder([property({ source_row: { unmapped: {} } })]);
    expect(enrich).toHaveBeenCalled();
  });

  it('reads the row\'s OWN link columns, not only recovered ones', async () => {
    /*
     * `unmappedWithRecoveredLinks(null, row)` returns the RECOVERED columns
     * alone, which for a row that never needed recovery is `{}` — no branches,
     * no evidence, and a gate that opens for every property it was meant to
     * hold. Every live Luxton brochure arrived this way, on the row's own
     * `unmapped`, so this is the difference between the gate working and the
     * gate being decorative.
     */
    const { enrich, outcome } = await runLadder([property({
      source_row: { unmapped: unmappedWith(BROCHURE), recovered_link_columns: [] },
    })]);
    expect(enrich).not.toHaveBeenCalled();
    expect(outcome.withheld).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// THE MUTATION GUARD
// ---------------------------------------------------------------------------

describe('the barrier is a barrier, not a comment', () => {
  /*
   * A test that passes whether or not the protection exists is worse than no
   * test. The tests above were run against a deliberately mutated
   * `settleFallbackImages` in which the gate was bypassed
   * (`if (false && !fallbackMayRun(...))`), and SIX of them failed: four
   * behavioural — `enrich` was called for a pending brochure, for a recovery
   * in flight, for a killed worker, and for a row whose links were its own —
   * and the two source-level assertions below. Restoring the gate turned all
   * six green again (22 passed, 0 failed).
   *
   * What a source-level assertion adds is that the SHAPE cannot rot back: the
   * enforcement must sit in the module that buys the ladder, ask the shared
   * predicate, and `continue` rather than fall through.
   */
  const source = readFileSync(
    'supabase/functions/_shared/builderStock/settleFallbackImages.ts', 'utf8');

  it('asks the one shared predicate, in the module that spends the money', () => {
    expect(source).toContain('fallbackMayRun');
    expect(source).toContain('readSuppliedEvidence');
  });

  it('refuses BEFORE the ladder is loaded or a provider is called', () => {
    const gate = source.indexOf('if (!fallbackMayRun(');
    const spend = source.indexOf('const builderName = await builderNameFor(');
    expect(gate).toBeGreaterThan(-1);
    expect(spend).toBeGreaterThan(gate);
  });

  it('the refusal is a skip, never a failure and never an attempt', () => {
    const gate = source.indexOf('if (!fallbackMayRun(');
    const block = source.slice(gate, source.indexOf('continue;', gate) + 'continue;'.length);
    expect(block).toContain('outcome.withheld += 1');
    // The refused property is skipped, not counted as a spend and not failed.
    expect(block).not.toContain('outcome.attempted');
    expect(block).not.toContain('enrich(');
  });
});
