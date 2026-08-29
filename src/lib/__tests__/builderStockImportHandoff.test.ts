/**
 * BUILDER STOCK — THE IMPORT HANDS OFF TO THE BACKEND AND STOPS.
 *
 * PRODUCTION, 29 AUGUST 2026, upload `479689a0-1d09-4e4c-be8d-d09567df5c9a`.
 * The import committed 23 properties in nineteen seconds and returned HTTP 200
 * at 06:28:07.428Z. The Builder Portal then sat on "Processing supplied
 * images" at 75% for the next twenty minutes and never moved again, because
 * `uploadBuilderStockFile` ended in a `while` loop calling `enrich_images` —
 * an expensive image-processing operation — until the server reported nothing
 * outstanding.
 *
 * THAT LOOP FAILED THREE INDEPENDENT WAYS, EACH FATAL ON ITS OWN.
 *
 *   IT COULD NOT CONVERGE. All 29 calls logged byte-identical numbers
 *   (`rows_read: 23, matched: 0, images_stored: 0, package_already_answered:
 *   3`). The source stage was deadlocked against its own reserve and the
 *   browser had no way to know: the loop's only stopping conditions were
 *   "nothing left" and "nothing moved", and something WAS moving — the
 *   fallback ladder — so it kept asking.
 *
 *   IT COULD NOT SURVIVE A KILLED WORKER. Call 30, execution
 *   `08d8f54f-e7f0-413b-9c5f-f216d1f4ff55`, booted at 06:42:05.281, logged at
 *   06:42:11.492 and was terminated at 06:42:52.052 with NO row in
 *   `function_edge_logs` — no response, no status, no CORS headers. `fetch`
 *   neither resolves nor rejects for that, so the promise never settled and
 *   the dialog could not reach its own final line. A `catch` cannot help: a
 *   promise that never settles is not a rejection.
 *
 *   IT WAS NOT NEEDED. Throughout, the autonomous settler was claiming ONE
 *   property per cron tick and advancing it — twelve distinct properties in
 *   the thirteen minutes after the browser fell silent, with nobody watching.
 *
 * THE RULE THESE PIN. Once the rows are committed the import is COMPLETE from
 * the browser's point of view, and every remaining stage — source,
 * eligibility, sanitization, fallback, primary selection, publication — is the
 * backend's. The builder must be able to close the tab the moment the import
 * answers.
 *
 * Note what is deliberately NOT the fix: no budget is raised, no request cap
 * widened, no browser timeout stretched. Those would keep the browser in
 * charge of work it cannot own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const invokeBuilderFunction = vi.fn();
vi.mock('@/lib/builderPortal', () => ({
  invokeBuilderFunction: (...args: unknown[]) => invokeBuilderFunction(...args),
}));

const {
  uploadBuilderStockFile, importBuilderStockUrl, StockRequestDeadlineExceeded,
} = await import('../builderStockQueries');

import {
  PROCESSED_LIFECYCLE, SERVED_LIFECYCLE, isProcessed, isServed,
} from '../../../supabase/functions/_shared/builderStock/stockLifecycle.pure';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The shape `process_upload` / `import_url` actually answer with. */
function committed(pending: number) {
  return {
    data: {
      upload: { id: '479689a0-1d09-4e4c-be8d-d09567df5c9a', status: 'enriching' },
      summary: {
        detected: 23, imported: 23, updated: 0, failed: 0, warnings: [], failures: [],
      },
      enrichment_pending: pending,
    },
    error: null,
  };
}

const createdUpload = {
  data: {
    upload: { id: '479689a0-1d09-4e4c-be8d-d09567df5c9a', status: 'uploaded' },
    signed_url: 'https://storage.example/put',
    token: 't',
  },
  error: null,
};

/** The operations each call asked for, in order. */
function operationsCalled(): string[] {
  return invokeBuilderFunction.mock.calls.map(
    (call) => String((call[1] as { operation?: unknown })?.operation ?? ''),
  );
}

function stockFile() {
  return new File(['lot,price\n'], 'stock.csv', { type: 'text/csv' });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. The loop is gone
// ---------------------------------------------------------------------------

describe('a successful import does not drive image work from the browser', () => {
  it('a file import calls create_upload and process_upload, and nothing else', async () => {
    invokeBuilderFunction
      .mockResolvedValueOnce(createdUpload)
      .mockResolvedValueOnce(committed(23));

    await uploadBuilderStockFile(stockFile());

    expect(operationsCalled()).toEqual(['create_upload', 'process_upload']);
    // The named operation, so this cannot pass by the loop merely being
    // renamed or moved behind a helper.
    expect(operationsCalled()).not.toContain('enrich_images');
  });

  it('a URL import calls import_url exactly once', async () => {
    invokeBuilderFunction.mockResolvedValueOnce(committed(23));

    await importBuilderStockUrl('https://example.com/stock');

    expect(operationsCalled()).toEqual(['import_url']);
    expect(operationsCalled()).not.toContain('enrich_images');
  });

  it('outstanding image work does not produce a second round trip', async () => {
    // The production case exactly: everything committed, everything still
    // owed imagery. The old loop treated this as "keep going"; it is now
    // "finished, and the backend has it".
    invokeBuilderFunction.mockResolvedValueOnce(committed(23));

    await importBuilderStockUrl('https://example.com/stock');

    expect(invokeBuilderFunction).toHaveBeenCalledTimes(1);
  });

  it('the module contains no import-time enrichment loop at all', () => {
    const source = readFileSync(resolve(__dirname, '../builderStockQueries.ts'), 'utf8');
    const importSection = source.slice(
      source.indexOf('export async function uploadBuilderStockFile'),
      source.indexOf('export function useDeleteBuilderStockSource'),
    );
    expect(importSection).not.toContain('enrich_images');
    expect(importSection).not.toContain('while (');
    // `enrich_images` itself survives — as the operator's "Retry image
    // lookup" button, which is a manual act and not a loop.
    expect(source).toContain("operation: 'enrich_images'");
  });
});

// ---------------------------------------------------------------------------
// 2 & 7. Finishing while work is outstanding, and saying so
// ---------------------------------------------------------------------------

describe('the import finishes while image work remains outstanding', () => {
  it('reaches phase done with 23 properties still owed imagery', async () => {
    invokeBuilderFunction.mockResolvedValueOnce(committed(23));
    const phases: string[] = [];

    const result = await importBuilderStockUrl(
      'https://example.com/stock', (p) => phases.push(p.phase));

    expect(phases[phases.length - 1]).toBe('done');
    expect(result.summary.imported).toBe(23);
  });

  it('reports what is still outstanding rather than implying it is done', async () => {
    invokeBuilderFunction.mockResolvedValueOnce(committed(23));

    const result = await importBuilderStockUrl('https://example.com/stock');

    // A successful import must never read as "the images are finished". The
    // count is the server's own, carried through unchanged.
    expect(result.imageWorkPending).toBe(23);
  });

  it('an import with nothing outstanding reports zero, not undefined', async () => {
    invokeBuilderFunction.mockResolvedValueOnce({
      data: { ...committed(0).data, enrichment_pending: undefined },
      error: null,
    });

    const result = await importBuilderStockUrl('https://example.com/stock');

    expect(result.imageWorkPending).toBe(0);
  });

  it('no progress phase claims anything about images', () => {
    const source = readFileSync(resolve(__dirname, '../builderStockQueries.ts'), 'utf8');
    const phaseUnion = source.slice(
      source.indexOf("phase: 'requesting'"),
      source.indexOf("phase: 'requesting'") + 200,
    );
    // "Processing supplied images" and "Finding images" were rendered from
    // these two. A phase the browser can no longer reach must not survive as
    // a label somebody re-wires later.
    expect(phaseUnion).not.toContain('settling');
    expect(phaseUnion).not.toContain('enriching');
  });
});

// ---------------------------------------------------------------------------
// 5. A killed worker cannot freeze the dialog
// ---------------------------------------------------------------------------

describe('a request that never answers cannot hold the modal open', () => {
  it('a promise that never settles is ended by the deadline', async () => {
    vi.useFakeTimers();
    // Exactly what a resource-limit kill looks like to the browser: no
    // resolve, no reject, for ever.
    invokeBuilderFunction.mockImplementation(
      (_fn: string, _body: unknown, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            const abort = new Error('The operation was aborted.');
            abort.name = 'AbortError';
            reject(abort);
          });
        }),
    );

    const pending = importBuilderStockUrl('https://example.com/stock');
    const settled = vi.fn();
    void pending.then(settled, settled);

    await vi.advanceTimersByTimeAsync(400_000);
    await expect(pending).rejects.toBeInstanceOf(StockRequestDeadlineExceeded);
    expect(settled).toHaveBeenCalled();
  });

  it('the deadline reports an UNDETERMINED outcome, never a failed import', async () => {
    vi.useFakeTimers();
    invokeBuilderFunction.mockImplementation(
      (_fn: string, _body: unknown, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            const abort = new Error('aborted');
            abort.name = 'AbortError';
            reject(abort);
          });
        }),
    );

    const pending = importBuilderStockUrl('https://example.com/stock');
    void pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(400_000);

    const error = await pending.catch((e: Error & { code?: string }) => e);
    // On the production incident the work HAD committed before the request
    // died. "Could not be imported" would have been a false statement, and it
    // is what led to the same list being imported twice.
    expect((error as { code?: string }).code).toBe('deadline_exceeded');
    expect((error as Error).message).toContain('unknown');
    expect((error as Error).message).not.toMatch(/failed|could not be imported/i);
  });

  it('the real transport RESOLVES on abort, and that is still a deadline', async () => {
    vi.useFakeTimers();
    /*
     * THE SHAPE THAT ACTUALLY SHIPS. `invokeBuilderFunction` does not reject
     * on an abort — it catches `AbortError` and RETURNS
     * `{ error: { code: 'request_aborted' } }`. A deadline that only
     * recognised a rejection would pass its own test and, in a browser,
     * surface "The request was cancelled." for a request nobody cancelled.
     */
    invokeBuilderFunction.mockImplementation(
      (_fn: string, _body: unknown, options: { signal?: AbortSignal }) =>
        new Promise((resolvePromise) => {
          options?.signal?.addEventListener('abort', () => resolvePromise({
            data: null,
            error: { message: 'The request was cancelled.', code: 'request_aborted' },
          }));
        }),
    );

    const pending = importBuilderStockUrl('https://example.com/stock');
    void pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(400_000);

    const error = await pending.catch((e: Error & { code?: string }) => e);
    expect((error as { code?: string }).code).toBe('deadline_exceeded');
    expect((error as Error).message).not.toContain('cancelled');
  });

  it('a storage upload that hangs is bounded too', async () => {
    vi.useFakeTimers();
    invokeBuilderFunction.mockResolvedValueOnce(createdUpload);
    // The PUT goes straight to storage and never touches an edge function, so
    // it has its own way of hanging and needs its own ceiling.
    vi.stubGlobal('fetch', vi.fn((_url: string, init: { signal?: AbortSignal }) =>
      new Promise((_resolvePromise, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const abort = new Error('aborted');
          abort.name = 'AbortError';
          reject(abort);
        });
      })));

    const pending = uploadBuilderStockFile(stockFile());
    void pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(400_000);

    await expect(pending).rejects.toBeInstanceOf(StockRequestDeadlineExceeded);
    // And it never reached the import: nothing was committed, so the page is
    // free to say the upload did not get through.
    expect(operationsCalled()).toEqual(['create_upload']);
  });

  it('a request that answers normally is not touched by the clock', async () => {
    vi.useFakeTimers();
    invokeBuilderFunction.mockResolvedValueOnce(committed(23));

    const result = await importBuilderStockUrl('https://example.com/stock');

    expect(result.summary.imported).toBe(23);
    // The timer is cleared rather than left to fire against a settled
    // promise, so a finished import holds nothing open.
    await vi.advanceTimersByTimeAsync(400_000);
    expect(result.imageWorkPending).toBe(23);
  });

  it('the page treats a deadline exactly as it treats transport silence', () => {
    const page = readFileSync(
      resolve(__dirname, '../../pages/builder/BuilderStockList.tsx'), 'utf8');
    const undetermined = page.slice(
      page.indexOf('const undetermined ='),
      page.indexOf('const undetermined =') + 220);
    expect(undetermined).toContain('transport_failed');
    expect(undetermined).toContain('deadline_exceeded');
  });

  it('the deadline cancels the request rather than only racing it', () => {
    const source = readFileSync(resolve(__dirname, '../builderStockQueries.ts'), 'utf8');
    const helper = source.slice(
      source.indexOf('async function withDeadline'),
      source.indexOf('function invokeBounded'));
    // A raced promise leaves the connection running invisibly; the signal has
    // to reach the request itself.
    expect(helper).toContain('AbortController');
    expect(helper).toContain('controller.signal');
    expect(helper).toContain('run(controller.signal)');
  });
});

// ---------------------------------------------------------------------------
// 6. A failure before commit still surfaces
// ---------------------------------------------------------------------------

describe('an import that fails before committing still reports the failure', () => {
  it('a rejected process_upload propagates its code and message', async () => {
    invokeBuilderFunction
      .mockResolvedValueOnce(createdUpload)
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'That file could not be processed.', code: 'processing_failed', status: 400 },
      });

    const error = await uploadBuilderStockFile(stockFile())
      .catch((e: Error & { code?: string; status?: number }) => e);

    expect((error as { code?: string }).code).toBe('processing_failed');
    expect((error as { status?: number }).status).toBe(400);
    expect((error as Error).message).toBe('That file could not be processed.');
  });

  it('a duplicate file keeps its own code so the page can say "already imported"', async () => {
    invokeBuilderFunction.mockResolvedValueOnce({
      data: null,
      error: { message: 'This list has already been imported.', code: 'duplicate_file', status: 409 },
    });

    const error = await importBuilderStockUrl('https://example.com/stock')
      .catch((e: Error & { code?: string }) => e);

    expect((error as { code?: string }).code).toBe('duplicate_file');
  });

  it('a storage upload that is refused fails before process_upload is called', async () => {
    invokeBuilderFunction.mockResolvedValueOnce(createdUpload);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 403 })));

    await expect(uploadBuilderStockFile(stockFile())).rejects.toThrow(/could not be uploaded/);
    expect(operationsCalled()).toEqual(['create_upload']);
  });
});

// ---------------------------------------------------------------------------
// 3 & 4. The backend is the continuation mechanism
// ---------------------------------------------------------------------------

describe('the backend, not the browser, continues the work', () => {
  const settler = readFileSync(resolve(
    __dirname, '../../../supabase/functions/builder-stock-image-settler/index.ts'), 'utf8');
  const arming = readFileSync(resolve(
    __dirname, '../../../supabase/migrations/20261023000000_builder_stock_arm_on_upload.sql'), 'utf8');
  const publication = readFileSync(resolve(
    __dirname, '../../../supabase/migrations/20261022000000_builder_stock_safe_publication.sql'), 'utf8');

  it('the per-item claim is what the settler runs, one property at a time', () => {
    expect(settler).toContain('claimOneImageWorkItem');
    // The rule that makes one killed item unable to block another: a claim is
    // for exactly one property, never a batch processed in a loop.
    const claim = readFileSync(resolve(
      __dirname, '../../../supabase/functions/_shared/builderStock/itemWorkClaim.ts'), 'utf8');
    expect(claim).toContain('p_limit: 1');
  });

  it('a cron tick is the continuation, and it retires only on an empty queue', () => {
    // Both lifecycles are counted, so a staged replacement cannot be stranded
    // invisible by an engine that thinks it is finished.
    expect(publication).toContain("lifecycle_status IN ('active', 'staged')");
    expect(publication).toContain("image_work_stage <> 'settled'");
    expect(publication).toContain("cron.unschedule('settle-builder-stock-marketplace-eligibility')");
  });

  it('every import arms the scheduler, including one that inserts no rows', () => {
    /*
     * THE GAP THIS CLOSES. The engine was re-armed by an AFTER INSERT trigger
     * on `builder_stock_items`. A replacement import MATCHES every property
     * and UPDATEs it — #2347's identity rules doing exactly their job — so it
     * inserts nothing and fired no trigger. While the browser loop existed
     * that was survivable. It is not survivable now.
     */
    expect(arming).toContain('AFTER INSERT ON public.builder_stock_uploads');
    expect(arming).toContain('FOR EACH STATEMENT');
    expect(arming).toContain('ensure_builder_stock_settlement_scheduled');
  });

  it('the arming trigger function is not reachable from the browser', () => {
    // SECURITY DEFINER, and it reaches cron.schedule. PUBLIC first: revoking
    // from anon alone is a no-op while PUBLIC holds the grant.
    expect(arming).toContain(
      'REVOKE ALL ON FUNCTION public.builder_stock_uploads_rearm_settlement()\n'
      + '  FROM PUBLIC, anon, authenticated;');
    expect(arming).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.builder_stock_uploads_rearm_settlement\(\)\s*\n\s*TO[^;]*anon/);
  });

  it('the browser is not asked to schedule anything', () => {
    const source = readFileSync(resolve(__dirname, '../builderStockQueries.ts'), 'utf8');
    // Arming is a property of the rows, reached by a trigger. A client that
    // had to remember to schedule is a client that will one day forget — and
    // a browser that can reach the scheduler can reach it while nobody is
    // importing anything.
    expect(source).not.toContain('ensure_builder_stock_settlement_scheduled');
    expect(source).not.toContain('cron.schedule');
    // And it speaks to one function. The settler is invoked by pg_cron over a
    // signed internal call; nothing in a browser bundle may name it.
    const invoked = [...source.matchAll(/invokeBuilderFunction<[^>]*>\(\s*'([^']+)'/g)]
      .map((match) => match[1]);
    expect(new Set(invoked)).toEqual(new Set(['builder-portal-stock']));
    expect(source).not.toContain('builder-stock-image-settler');
  });
});

// ---------------------------------------------------------------------------
// 8. The Marketplace keeps serving throughout
// ---------------------------------------------------------------------------

describe('background processing never takes the Marketplace off the air', () => {
  it('serving is decided by lifecycle alone, never by how far image work got', () => {
    const marketplace = readFileSync(resolve(
      __dirname, '../../../supabase/functions/builder-stock-marketplace/index.ts'), 'utf8');
    expect(marketplace).toContain("'lifecycle_status', 'active'");
    // The 23 live properties spent the whole incident mid-ladder. A serving
    // query that read either of these would have emptied the Marketplace for
    // as long as processing ran.
    expect(marketplace).not.toContain('image_work_stage');
    expect(marketplace).not.toContain('enrichment_status');
  });

  it('a property being processed is still a property being served', () => {
    // The two questions are separate on purpose: PROCESSED is the wider set.
    expect(isServed('active')).toBe(true);
    expect(isProcessed('active')).toBe(true);
    expect(SERVED_LIFECYCLE).toBe('active');
    expect([...PROCESSED_LIFECYCLE]).toEqual(['active', 'staged']);
  });

  it('a staged replacement is processed but not served', () => {
    // Which is what lets a re-import be worked on privately while the
    // published list stays up — the guarantee the final acceptance run has to
    // exercise, and the one the deleted-then-imported run never reached.
    expect(isProcessed('staged')).toBe(true);
    expect(isServed('staged')).toBe(false);
  });
});
