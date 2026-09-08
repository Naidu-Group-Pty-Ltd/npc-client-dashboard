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
import { join, resolve } from 'node:path';

import {
  ABANDONED_PARSE_MS, COMPLETABLE_UPLOAD_STATUSES, finalUploadStatus,
  parseIsAbandoned, settleCompletedUploads, settleUploadCompletion,
  summariseImageStages, mergeStageSummary, isStageCountEntry,
} from '../../../supabase/functions/_shared/builderStock/uploadCompletion';

interface UploadRow {
  id: string;
  organisation_id: string;
  status: string;
  records_failed: number;
  deleted_at: string | null;
  image_stage_summary?: Record<string, unknown>;
}

interface Faults {
  countFails?: boolean;
  imagesFail?: boolean;
  itemsFail?: boolean;
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
        /*
         * `neq` is SQL `<>`, which is NULL — and therefore NOT TRUE — for a
         * NULL column, so PostgREST drops those rows. Emulated exactly rather
         * than plausibly: a double that is merely reasonable is how code and
         * test come to agree while only the server disagrees.
         *
         * `builder_stock_items.image_work_stage` is NOT NULL DEFAULT 'source',
         * so no production row reaches this branch; the fixtures carry the
         * column for the same reason.
         */
        neq: (column: string, value: unknown) => {
          filters.push((row) => row[column] != null && String(row[column]) !== String(value));
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
        range: async (from: number, to: number) => {
          if (faults.imagesFail && table === 'builder_stock_item_images') {
            return { data: null, error: { message: 'images unreadable' } };
          }
          if (faults.itemsFail && table === 'builder_stock_items') {
            return { data: null, error: { message: 'items unreadable' } };
          }
          return { data: rowsFor().slice(from, to + 1), error: null };
        },
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
  records_failed: 0, deleted_at: null, image_stage_summary: {}, ...over,
});

/*
 * `image_work_stage` mirrors the real column, which is NOT NULL DEFAULT
 * 'source'. A fixture that omitted it would exercise a row shape the table
 * cannot hold.
 */
let itemSeq = 0;
const settledItem = (over: Record<string, unknown> = {}) => {
  itemSeq += 1;
  return {
    id: `item-${itemSeq}`,
    upload_id: 'upload-1', organisation_id: 'org-1',
    lifecycle_status: 'active', enrichment_status: 'complete',
    image_work_stage: 'settled', ...over,
  };
};

/*
 * An image belongs to a PROPERTY. `upload_id` is whatever upload happened to
 * store it and is deliberately not what the summary is gathered by any more —
 * these fixtures set it to the shapes production actually holds: a superseded
 * upload's id, or nothing at all.
 */
let imageSeq = 0;
const image = (
  stage: string,
  state: string,
  over: { stock_item_id?: string; upload_id?: string | null } = {},
) => {
  imageSeq += 1;
  return {
    id: `img-${String(imageSeq).padStart(4, '0')}`,
    stock_item_id: 'item-1',
    upload_id: 'upload-1',
    source_stage: stage,
    processing_status: state,
    ...over,
  };
};

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
      [settledItem(),
        settledItem({ enrichment_status: 'pending', image_work_stage: 'source' })],
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
      // upload-3 is still working: its ladder has not reached the last rung.
      settledItem({
        upload_id: 'upload-3',
        enrichment_status: 'enriching',
        image_work_stage: 'fallback',
      }),
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

/**
 * The latch that never opened.
 *
 * `enrichment_status` is written by the fallback ladder from the ladder's own
 * opinion of what a property still owes. A property whose picture came from
 * the builder's own document never needs that ladder, so nothing ever writes
 * the column and it keeps the `pending` its import gave it — for ever.
 *
 * MEASURED 7 SEPTEMBER 2026: 83 of 91 active properties were
 * `image_work_stage = 'settled'` and carrying their image while still reading
 * `enrichment_status = 'pending'`, so 15 of 17 uploads made in two days sat at
 * `enriching` permanently. The two that did complete were first-time imports.
 * A builder is told an import is still churning hours after every photograph
 * has landed.
 */
describe('a settled ladder finishes a property, whatever the legacy latch says', () => {
  it('completes an upload whose properties are settled but still read pending', async () => {
    const { db, writes } = fakeDb(
      [upload()],
      [settledItem({ enrichment_status: 'pending' }),
        settledItem({ enrichment_status: 'pending' })],
      [image('uploaded_document', 'ready')],
    );

    const outcome = await settleUploadCompletion(db, { uploadId: 'upload-1' });

    expect(outcome).toEqual({ status: 'complete' });
    expect(writes[0].patch.status).toBe('complete');
  });

  it('still waits on a property whose ladder has NOT settled', async () => {
    for (const stage of ['source', 'eligibility', 'sanitization', 'fallback']) {
      const { db, writes } = fakeDb(
        [upload()],
        [settledItem(), settledItem({ enrichment_status: 'pending', image_work_stage: stage })],
        [],
      );
      const outcome = await settleUploadCompletion(db, { uploadId: 'upload-1' });
      expect(outcome, `stage ${stage} must still be outstanding`)
        .toEqual({ status: null, refusal: 'items_outstanding' });
      expect(writes).toHaveLength(0);
    }
  });

  it('only ever makes completion MORE reachable, never less', async () => {
    // Everything that completed before this rule existed still completes: the
    // two conditions are ANDed, so a terminal `enrichment_status` alone is
    // still enough however the ladder reads.
    const { db, writes } = fakeDb(
      [upload()],
      [settledItem({ enrichment_status: 'complete', image_work_stage: 'fallback' }),
        settledItem({ enrichment_status: 'failed', image_work_stage: 'source' })],
      [image('uploaded_document', 'ready')],
    );
    const outcome = await settleUploadCompletion(db, { uploadId: 'upload-1' });
    expect(outcome).toEqual({ status: 'complete' });
    expect(writes).toHaveLength(1);
  });

  it('reads the column and never writes it, so the fallback queue is untouched', () => {
    /*
     * `readFallbackQueue` selects on `enrichment_status` alone. Marking a
     * property terminal THERE is how one stops being offered a ladder it is
     * still owed — a worse failure than a stale label — so this rule may only
     * ever read the column.
     */
    const source = readFileSync(
      join(process.cwd(), 'supabase/functions/_shared/builderStock/uploadCompletion.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/enrichment_status\s*:/);
    expect(source).toContain(".in('enrichment_status', UNFINISHED_ENRICHMENT_STATUSES)");
    expect(source).toContain(".neq('image_work_stage', SETTLED_ITEM_WORK_STAGE)");
  });
});

/**
 * The audit record that said no images were processed.
 *
 * `image_stage_summary` is declared "per-stage image counts" for the upload and
 * the Builder Portal renders it as `Images: uploaded document 78 · …`. It was
 * gathered by asking for image rows carrying THIS upload's id — but an image
 * keeps the id of the upload that STORED it, so on a re-upload, where every row
 * is matched and re-pointed to the new upload, not one image carries the new id.
 *
 * MEASURED 7 SEPTEMBER 2026 on upload `5412982c`, 78 properties each carrying
 * its builder's own photograph: 78 images carried the superseded upload's id,
 * 156 carried none at all, none carried the current upload's. The record then
 * stated, permanently, that no images were processed — the same falsehood the
 * paged read already refuses to write on a database fault, by another route.
 */
describe('the summary follows the properties, not the image row upload_id', () => {
  it('counts images left behind by the SUPERSEDED upload', () => {
    const items = [settledItem(), settledItem()];
    const { db, writes } = fakeDb(
      [upload()],
      items,
      [
        image('uploaded_document', 'ready',
          { stock_item_id: items[0].id, upload_id: 'upload-0-superseded' }),
        image('uploaded_document', 'ready',
          { stock_item_id: items[1].id, upload_id: 'upload-0-superseded' }),
      ],
    );

    return settleUploadCompletion(db, { uploadId: 'upload-1' }).then((outcome) => {
      expect(outcome).toEqual({ status: 'complete' });
      expect(writes[0].patch.image_stage_summary)
        .toEqual({ uploaded_document: { ready: 2 } });
    });
  });

  it('counts images carrying NO upload id at all', async () => {
    const items = [settledItem()];
    const { db, writes } = fakeDb(
      [upload()],
      items,
      [image('uploaded_document', 'ready', { stock_item_id: items[0].id, upload_id: null }),
        image('internet_search', 'unavailable',
          { stock_item_id: items[0].id, upload_id: null })],
    );

    const outcome = await settleUploadCompletion(db, { uploadId: 'upload-1' });

    expect(outcome).toEqual({ status: 'complete' });
    expect(writes[0].patch.image_stage_summary).toEqual({
      uploaded_document: { ready: 1 },
      internet_search: { unavailable: 1 },
    });
  });

  it('never counts another upload\'s properties', async () => {
    const mine = settledItem();
    const theirs = settledItem({ id: 'item-elsewhere', upload_id: 'upload-2' });
    const { db, writes } = fakeDb(
      [upload()],
      [mine, theirs],
      [image('uploaded_document', 'ready', { stock_item_id: mine.id }),
        image('street_view', 'ready', { stock_item_id: theirs.id })],
    );

    const outcome = await settleUploadCompletion(db, { uploadId: 'upload-1' });

    expect(outcome).toEqual({ status: 'complete' });
    expect(writes[0].patch.image_stage_summary)
      .toEqual({ uploaded_document: { ready: 1 } });
  });

  it('a FAILED property read is not an upload with no properties', async () => {
    // The same rule the image read has always had: anything short of the whole
    // set writes nothing, because a partial summary understates the work
    // permanently and this column is never revisited.
    const { db, writes } = fakeDb(
      [upload()], [settledItem()], [image('uploaded_document', 'ready')],
      { itemsFail: true },
    );
    const outcome = await settleUploadCompletion(db, { uploadId: 'upload-1' });
    expect(outcome).toEqual({ status: null, refusal: 'read_failed' });
    expect(writes).toHaveLength(0);
  });

  it('keeps the other tenant of this document', async () => {
    /*
     * `repairSourceImages` records `notion_row_assets_version` in the same
     * jsonb — its own comment says the key "is MERGED, never written over the
     * stage counts beside it" — while this write replaced the document whole
     * and dropped it, costing that upload a re-fetch of its live source on
     * every later run.
     */
    const items = [settledItem()];
    const { db, writes } = fakeDb(
      [upload({ image_stage_summary: { notion_row_assets_version: 23 } })],
      items,
      [image('uploaded_document', 'ready', { stock_item_id: items[0].id })],
    );

    await settleUploadCompletion(db, { uploadId: 'upload-1' });

    expect(writes[0].patch.image_stage_summary).toEqual({
      notion_row_assets_version: 23,
      uploaded_document: { ready: 1 },
    });
  });

  it('gathers by the property and never by the image row\'s upload id', () => {
    const source = readFileSync(
      join(process.cwd(), 'supabase/functions/_shared/builderStock/uploadCompletion.ts'),
      'utf8',
    );
    const imageRead = source.slice(source.indexOf("from('builder_stock_item_images')"));
    expect(imageRead).toContain(".in('stock_item_id', chunk)");
    expect(imageRead.slice(0, 400)).not.toContain("eq('upload_id'");
  });
});

/**
 * Recomputed means RECOMPUTED.
 *
 * Spreading the old document under the new one preserves the co-tenant key it
 * was added for — and it also preserves any stage the recomputation no longer
 * produces. An upload whose Street View image has since been retired would
 * carry `street_view: { ready: 1 }` for ever beside its true counts, while the
 * contract for this column is that its stage counts are recomputed.
 */
describe('stage counts are replaced as a set, other tenants are carried', () => {
  it('drops a stage the new calculation no longer produces, and keeps the metadata', async () => {
    const items = [settledItem()];
    const { db, writes } = fakeDb(
      [upload({
        image_stage_summary: {
          // A stage this upload once had, since retired.
          street_view: { ready: 1 },
          // A stale count for a stage that still exists: also replaced, never merged.
          uploaded_document: { ready: 99, failed: 4 },
          // Another module's key, which must survive.
          notion_row_assets_version: 23,
        },
      })],
      items,
      [image('uploaded_document', 'ready', { stock_item_id: items[0].id })],
    );

    await settleUploadCompletion(db, { uploadId: 'upload-1' });

    expect(writes[0].patch.image_stage_summary).toEqual({
      notion_row_assets_version: 23,
      uploaded_document: { ready: 1 },
    });
    // Stated separately, because this is the claim that matters.
    expect(writes[0].patch.image_stage_summary)
      .not.toHaveProperty('street_view');
  });

  it('classifies a stage count by its shape, not by a list of names', () => {
    expect(isStageCountEntry({ ready: 2, failed: 1 })).toBe(true);
    // A stage that counted nothing is still a stage key.
    expect(isStageCountEntry({})).toBe(true);
    // Scalars, nulls and arrays are somebody else's business.
    expect(isStageCountEntry(23)).toBe(false);
    expect(isStageCountEntry('23')).toBe(false);
    expect(isStageCountEntry(null)).toBe(false);
    expect(isStageCountEntry([1, 2])).toBe(false);
    expect(isStageCountEntry({ nested: { ready: 1 } })).toBe(false);
  });

  it('merges an absent or malformed document without throwing', () => {
    const fresh = { uploaded_document: { ready: 1 } };
    for (const existing of [null, undefined, 'nonsense', 42, []]) {
      expect(mergeStageSummary(existing, fresh)).toEqual(fresh);
    }
  });

  it('the fresh count wins where a carried key shares a stage name', () => {
    /*
     * Carried keys and fresh stage keys are disjoint by construction — one is
     * everything that is NOT stage-shaped — so this can only arise if a
     * non-stage value is filed under a stage's name. It must still be the
     * recomputed count that survives, or a stale scalar would shadow the real
     * number the whole change exists to produce.
     */
    const merged = mergeStageSummary(
      { uploaded_document: 'stale', notion_row_assets_version: 23 },
      { uploaded_document: { ready: 7 } },
    );
    expect(merged.uploaded_document).toEqual({ ready: 7 });
    expect(merged.notion_row_assets_version).toBe(23);
  });

  it('carries every non-stage key, not just the one we know about', () => {
    const merged = mergeStageSummary(
      { notion_row_assets_version: 23, some_future_marker: 'kept', old_stage: { ready: 9 } },
      { uploaded_document: { ready: 3 } },
    );
    expect(merged).toEqual({
      notion_row_assets_version: 23,
      some_future_marker: 'kept',
      uploaded_document: { ready: 3 },
    });
  });
});
