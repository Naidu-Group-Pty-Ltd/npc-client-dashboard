/**
 * Builder stock — a re-import must not throw away a repair that is still good.
 *
 * THE DEFECT, MEASURED. Lot 1731 Hornsea Street's cover render carries a
 * promotional graphic, so the card can only draw the repaired copy. The builder
 * uploaded the same brochure a second time on 4 September 2026 and the card
 * went blank: every store path composes `source_detail` as a fresh object and
 * upserts it on `(stock_item_id, source_stage, source_reference)`, so the
 * re-import took `sanitized_derivative` with it — although the bytes were
 * byte-identical (`3f37fb4d…`), the record was a repair OF those bytes, and the
 * repaired PNG was still in the bucket. The card stayed blank until a fresh
 * repair landed, and the generative model call was paid for again.
 *
 * THE RULE PINNED HERE is the one the readers already apply: a sanitization
 * record belongs to the bytes named by its `original_sha256`. Identical bytes
 * keep it; changed bytes drop it. There is no version test and no third state.
 */
import { describe, expect, it } from 'vitest';

import {
  CLEARANCE_KEY, DERIVATIVE_KEY, FAILURE_KEY, SANITIZATION_KEYS,
  sanitizationCarryForward,
} from '../../../supabase/functions/_shared/builderStock/sanitizedDerivative.pure';
import {
  storeSourceImageBytes,
} from '../../../supabase/functions/_shared/builderStock/sourceImages';
import { cleanPicture, jpegOf } from './fixtures/builderStockPictures';

const SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);

const derivative = (sha = SHA) => ({
  transformation: 'generative_overlay_inpaint',
  sanitization_version: 2,
  original_image_id: 'img-1',
  original_sha256: sha,
  derivative_sha256: 'c'.repeat(64),
  storage_bucket: 'builder-stock-images',
  storage_path: 'org/upload/document/sanitized/v2/img-1.png',
  verdict: 'eligible',
  repaired_share: 0.151,
});

const clearance = (sha = SHA) => ({
  sanitization_version: 2, original_image_id: 'img-1', original_sha256: sha,
  cleared_at: '2026-09-04T02:00:00.000Z',
});

const failure = (sha = SHA) => ({
  sanitization_version: 2, original_image_id: 'img-1', original_sha256: sha,
  reason: 'nothing_to_remove', detail: 'nothing to remove', model: null,
  transformation: null, failed_at: '2026-09-04T02:00:00.000Z',
});

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

describe('sanitizationCarryForward', () => {
  it('keeps a repair of the very bytes being stored', () => {
    const carried = sanitizationCarryForward(
      { stored_sha256: SHA, [DERIVATIVE_KEY]: derivative() }, SHA);
    expect(carried[DERIVATIVE_KEY]).toEqual(derivative());
  });

  it('drops a repair of bytes that are no longer the ones being stored', () => {
    const carried = sanitizationCarryForward(
      { [DERIVATIVE_KEY]: derivative(OTHER_SHA) }, SHA);
    expect(carried).toEqual({});
  });

  it('carries nothing when the bytes being stored have no hash', () => {
    expect(sanitizationCarryForward({ [DERIVATIVE_KEY]: derivative() }, null)).toEqual({});
    expect(sanitizationCarryForward({ [DERIVATIVE_KEY]: derivative() }, '')).toEqual({});
  });

  it('treats a clearance and a failure on exactly the same terms', () => {
    const detail = {
      [CLEARANCE_KEY]: clearance(), [FAILURE_KEY]: failure(),
    };
    expect(sanitizationCarryForward(detail, SHA)).toEqual(detail);
    expect(sanitizationCarryForward(detail, OTHER_SHA)).toEqual({});
  });

  /*
   * The cooldown is not a finding. A freshly imported row is entitled to be
   * looked at now, and carrying the stamp would make it wait out somebody
   * else's ten minutes.
   */
  it('never carries the attempt cooldown', () => {
    const carried = sanitizationCarryForward({
      [DERIVATIVE_KEY]: derivative(),
      sanitization_attempt: { at: '2026-09-04T02:25:01.588Z', operational: true },
    }, SHA);
    expect(carried).toEqual({ [DERIVATIVE_KEY]: derivative() });
    expect(carried.sanitization_attempt).toBeUndefined();
  });

  it('carries only the three keys the sanitization stage owns', () => {
    expect([...SANITIZATION_KEYS].sort())
      .toEqual([CLEARANCE_KEY, DERIVATIVE_KEY, FAILURE_KEY].sort());
    const carried = sanitizationCarryForward({
      [DERIVATIVE_KEY]: derivative(),
      role: 'primary_property',
      provenance_version: 13,
      marketplace_eligibility_state: 'ineligible',
    }, SHA);
    expect(Object.keys(carried)).toEqual([DERIVATIVE_KEY]);
  });

  it('ignores a record that is not an object or names no original', () => {
    expect(sanitizationCarryForward({ [DERIVATIVE_KEY]: 'yes' }, SHA)).toEqual({});
    expect(sanitizationCarryForward({ [DERIVATIVE_KEY]: null }, SHA)).toEqual({});
    expect(sanitizationCarryForward({ [DERIVATIVE_KEY]: { verdict: 'eligible' } }, SHA))
      .toEqual({});
    expect(sanitizationCarryForward(null, SHA)).toEqual({});
    expect(sanitizationCarryForward(undefined, SHA)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// The store path — the defect itself
// ---------------------------------------------------------------------------

interface Row { [key: string]: unknown }

function fakeDb(seed: Row[] = []) {
  const rows: Row[] = [...seed];
  const matches = (row: Row, filters: Array<[string, unknown]>) =>
    filters.every(([column, value]) => row[column] === value);

  return {
    rows,
    from() {
      return {
        select() {
          const filters: Array<[string, unknown]> = [];
          const builder: any = {
            eq(column: string, value: unknown) { filters.push([column, value]); return builder; },
            limit() { return builder; },
            then(resolve: (value: unknown) => unknown, reject?: unknown) {
              return Promise.resolve({ data: rows.filter((row) => matches(row, filters)), error: null })
                .then(resolve, reject as never);
            },
          };
          return builder;
        },
        upsert(row: Row) {
          const index = rows.findIndex((existing) =>
            existing.stock_item_id === row.stock_item_id
            && existing.source_stage === row.source_stage
            && existing.source_reference === row.source_reference);
          // PostgREST replaces the whole column, which is the point: a fresh
          // `source_detail` object takes the old one's keys with it.
          if (index >= 0) rows[index] = { ...rows[index], ...row };
          else rows.push({ id: 'img-1', ...row });
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
    storage: {
      from() {
        return {
          upload: () => Promise.resolve({ data: { path: 'p' }, error: null }),
        };
      },
    },
  };
}

const REFERENCE = 'page1:Im3#12';

async function reStore(db: any, bytes: Uint8Array, storedSha: string) {
  return await storeSourceImageBytes(db, {
    organisationId: 'org-1',
    uploadId: 'upload-2',
    stockItemId: 'item-1',
    bytes,
    contentType: 'image/jpeg',
    reference: REFERENCE,
    provider: 'uploaded_file',
    origin: 'document_media',
    pageUrl: null,
    position: 1,
    detail: { role: 'primary_property', stored_sha256: storedSha },
  });
}

describe('re-importing the same brochure', () => {
  const bytes = jpegOf(cleanPicture(400, 200));

  const seedRow = (detail: Row): Row => ({
    id: 'img-1',
    stock_item_id: 'item-1',
    source_stage: 'uploaded_document',
    source_reference: REFERENCE,
    source_detail: detail,
  });

  it('leaves the repaired copy on a row whose bytes have not changed', async () => {
    const db = fakeDb([seedRow({ stored_sha256: SHA, [DERIVATIVE_KEY]: derivative() })]);

    expect(await reStore(db, bytes, SHA)).toBe(true);

    const detail = db.rows[0].source_detail as Row;
    expect(detail[DERIVATIVE_KEY]).toEqual(derivative());
    // And the re-import still did its own job.
    expect(detail.role).toBe('primary_property');
    expect(detail.provenance_version).toBeGreaterThan(0);
  });

  it('drops a repair of bytes the source has since replaced', async () => {
    const db = fakeDb([seedRow({ stored_sha256: OTHER_SHA, [DERIVATIVE_KEY]: derivative(OTHER_SHA) })]);

    expect(await reStore(db, bytes, SHA)).toBe(true);

    const detail = db.rows[0].source_detail as Row;
    expect(detail[DERIVATIVE_KEY]).toBeUndefined();
  });

  it('writes a first import with nothing to carry', async () => {
    const db = fakeDb();

    expect(await reStore(db, bytes, SHA)).toBe(true);

    const detail = db.rows[0].source_detail as Row;
    expect(detail[DERIVATIVE_KEY]).toBeUndefined();
    expect(detail.role).toBe('primary_property');
  });
});
