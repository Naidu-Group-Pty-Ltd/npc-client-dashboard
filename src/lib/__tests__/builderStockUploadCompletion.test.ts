/**
 * Builder stock — an import that finished with nobody watching is RECORDED as
 * finished.
 *
 * MEASURED, 2 SEPTEMBER 2026: upload `tq.csv` imported at 14:04 (14 rows
 * detected, 14 updated, 0 failed); ninety minutes later all eleven of its live
 * properties were settled and ten were drawing the builder's own brochure
 * render, while the upload row still read `enriching` with an empty
 * `image_stage_summary`. The completion write lived only inside the Builder
 * Portal's browser loop, and every stage of the work it describes had moved
 * to the backend settler. The rule is shared now, and these are its terms.
 */
import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  ABANDONED_PARSE_MS, COMPLETABLE_UPLOAD_STATUSES, finalUploadStatus,
  parseIsAbandoned, settleCompletedUploads, settleUploadCompletion,
  summariseImageStages,
} from '../../../supabase/functions/_shared/builderStock/uploadCompletion';

interface UploadRow {
  id: string;
  organisation_id: string;
  status: string;
  records_failed: number;
  deleted_at: string | null;
}

interface Faults {
  countFails?: boolean;
  imagesFail?: boolean;
  writeFails?: boolean;
}

/** The slice of PostgREST this rule speaks, over rows in memory. */
function fakeDb(
  uploads: UploadRow[],
  items: Array<{ upload_id: string; organisation_id: string; lifecycle_status: string; enrichment_status: string }>,
  images: Array<{ id: string; upload_id: string; source_stage: string; processing_status: string }>,
  faults: Faults = {},
) {
  const writes: Array<{ id: string; patch: Record<string, unknown> }> = [];

  const db = {
    from(table: string) {
      const filters: Array<(row: any) => boolean> = [];
      let counting = false;

      const rowsFor = () => {
        const source = table === 'builder_stock_uploads' ? uploads
          : table === 'builder_stock_items' ? items
            : images;
        return (source as any[]).filter((row) => filters.every((f) => f(row)));
      };

      const chain: any = {
        select: (_columns?: unknown, options?: { count?: string }) => {
          if (options?.count) counting = true;
          return chain;
        },
        eq: (column: string, value: unknown) => {
          filters.push((row) => String(row[column]) === String(value));
          return chain;
        },
        in: (column: string, values: unknown[]) => {
          filters.push((row) => values.map(String).includes(String(row[column])));
          return chain;
        },
        is: (column: string, value: unknown) => {
          filters.push((row) => (value === null ? row[column] == null : row[column] === value));
          return chain;
        },
        order: () => chain,
        maybeSingle: async () => ({ data: rowsFor()[0] ?? null, error: null }),
        limit: async () => ({ data: rowsFor(), error: null }),
        // A real range SLICES: `readAllRows` terminates on an empty page, so a
        // double that ignores the offsets pages for ever.
        range: async (from: number, to: number) => (faults.imagesFail
          ? { data: null, error: { message: 'images unreadable' } }
          : { data: rowsFor().slice(from, to + 1), error: null }),
        // The count query is awaited on the builder itself.
        then: (onFulfilled: (value: unknown) => unknown) => Promise.resolve(
          counting && faults.countFails
            ? { count: null, error: { message: 'count unreadable' } }
            : { count: rowsFor().length, error: null },
        ).then(onFulfilled),
        update: (patch: Record<string, unknown>) => {
          const writer: any = {
            eq: (_column: string, value: unknown) => {
              writer.id = String(value);
              return writer;
            },
            then: (onFulfilled: (value: unknown) => unknown) => {
              if (!faults.writeFails) {
                writes.push({ id: writer.id, patch });
                const target = uploads.find((row) => row.id === writer.id);
                if (target) Object.assign(target, patch);
              }
              return Promise.resolve(
                faults.writeFails ? { error: { message: 'write refused' } } : { error: null },
              ).then(onFulfilled);
            },
          };
          return writer;
        },
      };
      return chain;
    },
  };
  return { db, writes };
}

const upload = (over: Partial<UploadRow> = {}): UploadRow => ({
  id: 'upload-1', organisation_id: 'org-1', status: 'enriching',
  records_failed: 0, deleted_at: null, ...over,
});

const settledItem = (over = {}) => ({
  upload_id: 'upload-1', organisation_id: 'org-1',
  lifecycle_status: 'active', enrichment_status: 'complete', ...over,
});

const image = (stage: string, state: string, id = `img-${Math.random()}`) => ({
  id, upload_id: 'upload-1', source_stage: stage, processing_status: state,
});

describe('settleUploadCompletion', () => {
  it('records a finished import as complete, with its image summary', async () => {
    const { db, writes } = fakeDb(
      [upload()],
      [settledItem(), settledItem({ enrichment_status: 'failed' })],
      [image('uploaded_document', 'ready'), image('uploaded_document', 'ready'),
        image('internet_search', 'unavailable')],
    );

    const outcome = await settleUploadCompletion(db, { uploadId: 'upload-1' });

    expect(outcome).toEqual({ status: 'complete' });
    expect(writes).toHaveLength(1);
    expect(writes[0].patch.status).toBe('complete');
    expect(writes[0].patch.image_stage_summary).toEqual({
      uploaded_document: { ready: 2 },
      internet_search: { unavailable: 1 },
    });
  });

  it('an import that could not save every row settles partially_complete', async () => {
    const { db, writes } = fakeDb([upload({ records_failed: 2 })], [settledItem()], []);
    const outcome = await settleUploadCompletion(db, { uploadId: 'upload-1' });
    expect(outcome.status).toBe('partially_complete');
    expect(writes[0].patch.status).toBe('partially_complete');
  });

  it('waits while any property is still owed enrichment', async () => {
    const { db, writes } = fakeDb(
      [upload()],
      [settledItem(), settledItem({ enrichment_status: 'pending' })],
      [],
    );
    const outcome = await settleUploadCompletion(db, { uploadId: 'upload-1' });
    expect(outcome).toEqual({ status: null, refusal: 'items_outstanding' });
    expect(writes).toHaveLength(0);
  });

  it('a FAILED count is not a count of zero — nothing is written', async () => {
    const { db, writes } = fakeDb([upload()], [settledItem()], [], { countFails: true });
    const outcome = await settleUploadCompletion(db, { uploadId: 'upload-1' });
    expect(outcome).toEqual({ status: null, refusal: 'read_failed' });
    expect(writes).toHaveLength(0);
  });

  it('an INCOMPLETE image read never becomes an empty audit summary', async () => {
    /*
     * The inline copy this replaces read `stagePage.rows` without consulting
     * `stagePage.failed`, so a database fault would have stamped the upload
     * `complete` with `image_stage_summary: {}` — a record stating, for ever,
     * that no images were processed.
     */
    const { db, writes } = fakeDb(
      [upload()], [settledItem()], [image('uploaded_document', 'ready')],
      { imagesFail: true },
    );
    const outcome = await settleUploadCompletion(db, { uploadId: 'upload-1' });
    expect(outcome).toEqual({ status: null, refusal: 'read_failed' });
    expect(writes).toHaveLength(0);
  });

  it('refuses an upload that is already finished, or deleted', async () => {
    for (const over of [{ status: 'complete' }, { deleted_at: '2026-09-02T00:00:00Z' }]) {
      const { db, writes } = fakeDb([upload(over)], [settledItem()], []);
      const outcome = await settleUploadCompletion(db, { uploadId: 'upload-1' });
      expect(outcome).toEqual({ status: null, refusal: 'not_completable' });
      expect(writes).toHaveLength(0);
    }
  });

  it('reports a missing upload rather than settling something else', async () => {
    const { db } = fakeDb([], [], []);
    expect(await settleUploadCompletion(db, { uploadId: 'nope' }))
      .toEqual({ status: null, refusal: 'not_found' });
  });
});

describe('settleCompletedUploads', () => {
  it('settles the finished ones and leaves the rest alone', async () => {
    const uploads = [
      upload({ id: 'upload-1' }),
      upload({ id: 'upload-2', status: 'partially_complete', records_failed: 1 }),
      upload({ id: 'upload-3' }),
    ];
    const items = [
      settledItem({ upload_id: 'upload-1' }),
      settledItem({ upload_id: 'upload-2' }),
      // upload-3 is still working.
      settledItem({ upload_id: 'upload-3', enrichment_status: 'enriching' }),
    ];
    const { db, writes } = fakeDb(uploads, items, [image('uploaded_document', 'ready')]);

    const outcome = await settleCompletedUploads(db);

    expect(outcome).toEqual({ inspected: 3, settled: 2 });
    expect(writes.map((w) => w.id).sort()).toEqual(['upload-1', 'upload-2']);
    expect(uploads.find((u) => u.id === 'upload-3')!.status).toBe('enriching');
  });

  it('never throws — housekeeping must not fail the tick it rides in', async () => {
    const exploding: any = { from() { throw new Error('database gone'); } };
    await expect(settleCompletedUploads(exploding)).resolves.toEqual({ inspected: 0, settled: 0 });
  });
});

describe('the rule itself', () => {
  it('counts each source stage by the state its images ended in', () => {
    expect(summariseImageStages([
      { source_stage: 'uploaded_document', processing_status: 'ready' },
      { source_stage: 'uploaded_document', processing_status: 'unavailable' },
      { source_stage: 'uploaded_document', processing_status: 'ready' },
    ])).toEqual({ uploaded_document: { ready: 2, unavailable: 1 } });
  });

  it('the import’s own verdict decides the final status', () => {
    expect(finalUploadStatus(0)).toBe('complete');
    expect(finalUploadStatus(null)).toBe('complete');
    expect(finalUploadStatus(1)).toBe('partially_complete');
  });

  it('only an unfinished upload is completable', () => {
    expect(COMPLETABLE_UPLOAD_STATUSES).toEqual(['enriching', 'partially_complete']);
    expect(COMPLETABLE_UPLOAD_STATUSES).not.toContain('complete');
  });
});

/*
 * A crashed import used to shut both doors: `process_upload` answered "This
 * file has already been processed" and `reprocess_upload` answered "This
 * source is being read right now" — neither true — so the builder's file
 * could never be imported again without deleting the source, which archives
 * its properties.
 */
describe('an abandoned parse is not an import in flight', () => {
  const parsing = (startedMinutesAgo: number | null) => ({
    status: 'parsing',
    processing_started_at: startedMinutesAgo === null
      ? null
      : new Date(Date.now() - startedMinutesAgo * 60_000).toISOString(),
  });

  it('protects a read that really is running', () => {
    expect(parseIsAbandoned(parsing(0))).toBe(false);
    expect(parseIsAbandoned(parsing(2))).toBe(false);
    // Six times the edge ceiling: no live invocation can reach it.
    expect(ABANDONED_PARSE_MS).toBeGreaterThanOrEqual(6 * 150_000);
  });

  it('releases one that died', () => {
    expect(parseIsAbandoned(parsing(16))).toBe(true);
    expect(parseIsAbandoned(parsing(60 * 24))).toBe(true);
  });

  it('a parsing row with no start stamp cannot be in flight', () => {
    // Every path that sets `parsing` stamps the start in the same write.
    expect(parseIsAbandoned(parsing(null))).toBe(true);
    expect(parseIsAbandoned({ status: 'parsing', processing_started_at: 'not a date' })).toBe(true);
  });

  it('says nothing about any other status', () => {
    for (const status of ['uploaded', 'imported', 'enriching', 'complete', 'failed']) {
      expect(parseIsAbandoned({ status, processing_started_at: null })).toBe(false);
    }
  });

  it('the reprocess door asks it before refusing', () => {
    const source = readFileSync(
      resolve(__dirname, '../../../supabase/functions/builder-portal-stock/index.ts'),
      'utf8',
    );
    expect(source).toContain(
      "if (String(upload.status) === 'parsing' && !parseIsAbandoned(upload)) {");
  });
});
