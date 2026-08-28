/**
 * BUILDER STOCK — A PREVIEW MAY LOOK, AND MAY NOT TOUCH.
 *
 * `previewSanitization` exists so a repair candidate can be inspected before
 * anybody lets it become the picture on a client's card. That is only worth
 * anything if two things hold, and both are asserted here rather than assumed:
 *
 *   IT PROVES THE PREMISE BEFORE IT SPENDS — the row, its organisation, its
 *   role, the bytes' own hash and every repair-region rule are checked first,
 *   and a refusal on any of them costs ZERO model calls.
 *
 *   IT WRITES NOTHING — no update, insert, upsert or delete on any table, and
 *   no upload to storage. The database double here THROWS on all of them, so a
 *   preview that ever learns to write fails this file instead of production.
 *
 * The one side effect a preview is allowed is the model call itself, which is
 * real spend and is metered exactly as the settler's is. Reading the metering
 * ledger back to count those calls is a SELECT, and is the only reason this
 * double answers `api_usage_log` at all.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  previewSanitization,
} from '../../../supabase/functions/_shared/builderStock/previewSanitization';
import { encodePng, sha256Hex } from '../../../supabase/functions/_shared/builderStock/rasterPng';
import {
  sanitizeSourceImage,
} from '../../../supabase/functions/_shared/builderStock/sanitizeImage';
import {
  MAX_REPAIRED_SHARE, MAX_REGION_BOXES,
} from '../../../supabase/functions/_shared/builderStock/repairRegion.pure';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');
const SETTLER = 'supabase/functions/builder-stock-image-settler/index.ts';
const PREVIEW_MODULE = 'supabase/functions/_shared/builderStock/previewSanitization.ts';

const ORG = 'org-a';
const IMAGE = 'image-1';
const PATH = 'org-a/items/item-1/source/cover.png';
const W = 400;
const H = 200;

/** A badge-sized set of rectangles, well under the ceiling. */
const GOOD_BOXES = [
  { left: 0.05, top: 0.06, right: 0.30, bottom: 0.20 },
  { left: 0.62, top: 0.80, right: 0.98, bottom: 0.95 },
];

async function seed(overrides: Record<string, unknown> = {}) {
  const pixels = new Uint8Array(W * H * 3);
  // A gradient rather than a flat fill: a flat frame is not a photograph and
  // the repair path treats it differently.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const at = (y * W + x) * 3;
      pixels[at] = 90 + ((x * 7 + y * 3) % 60);
      pixels[at + 1] = 110 + ((x * 3 + y * 5) % 50);
      pixels[at + 2] = 160 + ((x * 5 + y * 2) % 40);
    }
  }
  const bytes = (await encodePng(pixels, { width: W, height: H, components: 3 }))!;
  const sha = await sha256Hex(bytes);
  const row = {
    id: IMAGE,
    stock_item_id: 'item-1',
    organisation_id: ORG,
    storage_bucket: 'builder-stock-images',
    storage_path: PATH,
    source_detail: {
      role: 'primary_property',
      role_evidence_level: 3,
      stored_sha256: sha,
      source_sha256: sha,
      ...overrides,
    } as Record<string, unknown>,
  };
  return { row, bytes, sha };
}

/**
 * A database that answers reads and EXPLODES on every write.
 *
 * `writes` is never expected to be non-empty; it exists so a failure names
 * what was attempted instead of only that something was.
 */
function readOnlyDb(rows: Array<Record<string, any>>, objects: Record<string, Uint8Array>) {
  const writes: string[] = [];
  const downloads: string[] = [];
  const uploads: string[] = [];
  const forbid = (what: string) => () => {
    writes.push(what);
    throw new Error(`a preview attempted to ${what}`);
  };

  const db = {
    writes,
    downloads,
    uploads,
    from(table: string) {
      const filters: Array<[string, string, unknown]> = [];
      const builder: any = {
        select(_cols: string, opts?: { count?: string; head?: boolean }) {
          builder._count = Boolean(opts?.count);
          return builder;
        },
        eq(column: string, value: unknown) { filters.push(['eq', column, value]); return builder; },
        gte(column: string, value: unknown) { filters.push(['gte', column, value]); return builder; },
        maybeSingle() {
          const match = rows.find((row) => filters
            .filter(([op]) => op === 'eq')
            .every(([, column, value]) => row[column] === value));
          return Promise.resolve({ data: match ?? null, error: null });
        },
        // The metering read-back. No worker ran in these tests, so it is zero.
        then(resolve: any, reject?: any) {
          return Promise.resolve({ data: [], error: null, count: 0 }).then(resolve, reject);
        },
        update: forbid(`update ${table}`),
        insert: forbid(`insert into ${table}`),
        upsert: forbid(`upsert into ${table}`),
        delete: forbid(`delete from ${table}`),
      };
      return builder;
    },
    storage: {
      from() {
        return {
          download(path: string) {
            downloads.push(path);
            const bytes = objects[path];
            if (!bytes) {
              return Promise.resolve({ data: null, error: { message: 'missing' } });
            }
            return Promise.resolve({
              data: { arrayBuffer: () => Promise.resolve(bytes.buffer.slice(0)) },
              error: null,
            });
          },
          upload(path: string) {
            uploads.push(path);
            throw new Error('a preview attempted to upload an object');
          },
          remove: forbid('remove an object'),
        };
      },
    },
  };
  return db;
}

/** A sanitizer stub that records what it was handed and never invents pixels. */
function spySanitize(outcome?: 'ok') {
  const seen = { calls: 0, region: null as unknown, modelCalls: 0 };
  const sanitize = (async (bytes: Uint8Array, options?: Record<string, any>) => {
    seen.calls += 1;
    seen.region = options?.repairRegion ?? null;
    if (outcome !== 'ok') {
      return {
        ok: false, reason: 'inpaint_unavailable', transformation: 'generative_overlay_inpaint',
        model: null, detail: 'no worker in a test',
      };
    }
    return {
      ok: true, bytes, width: W, height: H,
      transformation: 'generative_overlay_inpaint',
      repairedShare: 0.0812, regionsRemoved: 2, model: '@cf/test/model',
    };
  }) as never;
  return { sanitize, seen };
}

/**
 * A and K are properties of the HANDLER rather than of the module, and a rule
 * inside a `Deno.serve` callback is a rule nothing can execute from here. So
 * they are asserted against the function's own source, which is what actually
 * ships: the ordering of the auth gate against the preview branch, and the
 * fact that the branch is entered only by an explicit operation.
 */
describe('A,K — the handler gates the preview and leaves the tick alone', () => {
  const source = read(SETTLER);

  it('A — the preview is unreachable without the internal signature', () => {
    const gate = source.indexOf('await verifyInternal(');
    const forbidden = source.indexOf("return json({ error: 'Forbidden' }, 403)");
    const branch = source.indexOf("'preview_sanitization'");
    const call = source.indexOf('await previewSanitization(');

    expect(gate).toBeGreaterThan(-1);
    expect(branch).toBeGreaterThan(-1);
    // The signature check, and its refusal, both come first. An unsigned
    // caller has already been answered 403 before the body is even read for an
    // operation, so there is no preview-shaped way past the gate.
    expect(gate).toBeLessThan(branch);
    expect(forbidden).toBeGreaterThan(gate);
    expect(forbidden).toBeLessThan(branch);
    expect(call).toBeGreaterThan(branch);

    // And the gate is the real one: nothing here relaxes it for a preview.
    expect(source).not.toMatch(/preview[\s\S]{0,200}verifyInternal[\s\S]{0,80}(skip|bypass|allow)/i);
  });

  it('K — a tick with no operation runs the settlement exactly as before', () => {
    const branch = source.indexOf("if (String(body.operation ?? '') === 'preview_sanitization')");
    const tick = source.indexOf('const startedAt = Date.now();');

    expect(branch).toBeGreaterThan(-1);
    // The preview is a guarded early return ABOVE the tick, so a cron call —
    // which sends no operation — falls straight through to the work it always
    // did, with the same budget, deadline and phase rotation.
    expect(branch).toBeLessThan(tick);
    expect(source).toContain('runSettlementTick(');
    expect(source).toContain('choosePhase(');
  });

  it('the preview never reaches for the worker credential itself', () => {
    // The secret is resolved inside `inpaintOverlay`, where every other caller
    // resolves it. A handler that read it here could log it or return it.
    const preview = read(PREVIEW_MODULE);
    expect(preview).not.toContain('BUILDER_STOCK_IMAGE_WORKER_TOKEN');
    expect(preview).not.toContain('BUILDER_STOCK_IMAGE_WORKER_URL');

    // Nor does the response it builds hand any of it back. Scoped to the
    // preview's own header block, because the file's CORS docstring legitimately
    // names `x-step-up-token` as one of the allowed REQUEST headers.
    const start = source.indexOf('const headers: Record<string, string> = {');
    const block = source.slice(start, source.indexOf('return new Response(preview.bytes', start));
    expect(start).toBeGreaterThan(-1);
    expect(block).not.toMatch(/token|secret|authorization|worker_url/i);
  });

  it('the preview module cannot write: it names no mutating call at all', () => {
    const preview = read(PREVIEW_MODULE);
    // Belt and braces beside the behavioural tests below: a mutating verb
    // added to this module fails here even if a test forgets to exercise it.
    for (const forbidden of ['.update(', '.insert(', '.upsert(', '.delete(', '.upload(', '.remove(']) {
      expect(preview.includes(forbidden), forbidden).toBe(false);
    }
  });
});

describe('the preview proves the premise before it spends', () => {
  it('B — an image belonging to another organisation is refused as absent', async () => {
    const { row, bytes, sha } = await seed();
    const db = readOnlyDb([row], { [PATH]: bytes });
    const spy = spySanitize();

    const out = await previewSanitization(db as never, {
      organisationId: 'org-somebody-else',
      imageId: IMAGE,
      originalSha256: sha,
      boxes: GOOD_BOXES,
    }, { sanitize: spy.sanitize });

    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.status).toBe(404);
      // Indistinguishable from "no such image": a service-role reader must not
      // confirm another tenant's row exists.
      expect(out.reason).toBe('image_not_found');
    }
    expect(spy.seen.calls).toBe(0);
    expect(db.writes).toEqual([]);
  });

  it('C — an image id nothing matches is refused', async () => {
    const { row, bytes, sha } = await seed();
    const db = readOnlyDb([row], { [PATH]: bytes });
    const spy = spySanitize();

    const out = await previewSanitization(db as never, {
      organisationId: ORG, imageId: 'image-nope', originalSha256: sha, boxes: GOOD_BOXES,
    }, { sanitize: spy.sanitize });

    expect(out.ok).toBe(false);
    if (out.ok === false) expect(out.reason).toBe('image_not_found');
    expect(spy.seen.calls).toBe(0);
  });

  it('D — a sha the row does not hold is refused, and so is one the OBJECT does not', async () => {
    const { row, bytes, sha } = await seed();

    // The row disagrees.
    const dbA = readOnlyDb([row], { [PATH]: bytes });
    const spyA = spySanitize();
    const wrongRow = await previewSanitization(dbA as never, {
      organisationId: ORG, imageId: IMAGE, originalSha256: 'b'.repeat(64), boxes: GOOD_BOXES,
    }, { sanitize: spyA.sanitize });
    expect(wrongRow.ok).toBe(false);
    if (wrongRow.ok === false) expect(wrongRow.reason).toBe('sha_mismatch');
    expect(spyA.seen.calls).toBe(0);

    // The row agrees and the BUCKET does not — a replaced object. This is the
    // case a region must never be applied through: same row, different bytes.
    const other = (await encodePng(new Uint8Array(W * H * 3).fill(7),
      { width: W, height: H, components: 3 }))!;
    const dbB = readOnlyDb([row], { [PATH]: other });
    const spyB = spySanitize();
    const wrongBytes = await previewSanitization(dbB as never, {
      organisationId: ORG, imageId: IMAGE, originalSha256: sha, boxes: GOOD_BOXES,
    }, { sanitize: spyB.sanitize });
    expect(wrongBytes.ok).toBe(false);
    if (wrongBytes.ok === false) expect(wrongBytes.reason).toBe('object_sha_mismatch');
    expect(spyB.seen.calls).toBe(0);
  });

  it('E — a non-primary image is refused', async () => {
    const { row, bytes, sha } = await seed({ role: 'interior' });
    const db = readOnlyDb([row], { [PATH]: bytes });
    const spy = spySanitize();

    const out = await previewSanitization(db as never, {
      organisationId: ORG, imageId: IMAGE, originalSha256: sha, boxes: GOOD_BOXES,
    }, { sanitize: spy.sanitize });

    expect(out.ok).toBe(false);
    if (out.ok === false) expect(out.reason).toBe('not_primary');
    expect(spy.seen.calls).toBe(0);
  });

  it('F — malformed rectangles are refused, and one bad box voids the set', async () => {
    const { row, bytes, sha } = await seed();
    const bad: Array<[string, Array<Record<string, number>>]> = [
      ['inverted', [{ left: 0.9, top: 0.1, right: 0.2, bottom: 0.3 }]],
      ['empty', [{ left: 0.5, top: 0.5, right: 0.5, bottom: 0.9 }]],
      ['outside the frame', [{ left: -0.1, top: 0, right: 0.2, bottom: 0.1 }]],
      ['one honest and one not', [GOOD_BOXES[0], { left: 0.9, top: 0.1, right: 0.2, bottom: 0.3 }]],
      ['past the cap', [0, 1, 2, 3, 4].map((n) => ({
        left: n * 0.15, top: 0, right: n * 0.15 + 0.05, bottom: 0.05,
      }))],
    ];
    for (const [name, boxes] of bad) {
      const db = readOnlyDb([row], { [PATH]: bytes });
      const spy = spySanitize();
      const out = await previewSanitization(db as never, {
        organisationId: ORG, imageId: IMAGE, originalSha256: sha, boxes: boxes as never,
      }, { sanitize: spy.sanitize });
      expect(out.ok, name).toBe(false);
      if (out.ok === false) expect(out.reason, name).toBe('region_malformed');
      expect(spy.seen.calls, name).toBe(0);
      expect(db.writes, name).toEqual([]);
    }
    expect(MAX_REGION_BOXES).toBe(4);
  });

  it('G — a raw union past the ceiling is refused, and costs ZERO model calls', async () => {
    const { row, bytes, sha } = await seed();
    const db = readOnlyDb([row], { [PATH]: bytes });
    const spy = spySanitize();

    // Four disjoint bands of 10% each: none alarming alone, 40% together.
    const bands = [0, 1, 2, 3].map((n) => ({
      left: 0, right: 1, top: n * 0.25, bottom: n * 0.25 + 0.1,
    }));

    const out = await previewSanitization(db as never, {
      organisationId: ORG, imageId: IMAGE, originalSha256: sha, boxes: bands,
    }, { sanitize: spy.sanitize });

    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.reason).toBe('region_too_large');
      expect(out.detail).toContain('40.0%');
      expect(out.detail).toContain(`${MAX_REPAIRED_SHARE * 100}%`);
    }
    // THE WHOLE POINT: nothing was spent establishing that this is unsafe.
    expect(spy.seen.calls).toBe(0);
    expect(db.writes).toEqual([]);
  });

  it('H — Barrier B still refuses inside the real sanitizer, with zero model calls', async () => {
    // Barrier A passes (raw union 0.34) and the grown, feathered mask does not.
    // No sanitizer stub here: this runs the production path, and the model
    // callback counts what would have been spent.
    const { row, bytes, sha } = await seed();
    const db = readOnlyDb([row], { [PATH]: bytes });
    let modelCalls = 0;

    const out = await previewSanitization(db as never, {
      organisationId: ORG, imageId: IMAGE, originalSha256: sha,
      boxes: [{ left: 0, top: 0, right: 1, bottom: 0.34 }],
    }, {
      // The real sanitizer, with an edit that records rather than invents.
      sanitize: ((input: Uint8Array, options: Record<string, any>) =>
        sanitizeSourceImage(input, {
          ...options,
          edit: async (patch: Uint8Array) => { modelCalls += 1; return patch; },
        })) as never,
    });

    expect(out.ok).toBe(false);
    if (out.ok === false) expect(out.reason).toBe('too_much_to_rebuild');
    expect(modelCalls).toBe(0);
    expect(db.writes).toEqual([]);
  });
});

describe('a preview writes nothing', () => {
  it('I,J — a SUCCESSFUL preview reads and downloads only: no writes, no uploads', async () => {
    const { row, bytes, sha } = await seed();
    const db = readOnlyDb([row], { [PATH]: bytes });
    const spy = spySanitize('ok');

    const out = await previewSanitization(db as never, {
      organisationId: ORG, imageId: IMAGE, originalSha256: sha, boxes: GOOD_BOXES,
    }, { sanitize: spy.sanitize });

    expect(out.ok).toBe(true);
    // The sanitizer WAS called, and with the rectangles as a list.
    expect(spy.seen.calls).toBe(1);
    expect(spy.seen.region).toEqual(GOOD_BOXES);
    // And nothing was written or uploaded. The double throws on either, so an
    // empty list here is the assertion and not merely its evidence.
    expect(db.writes).toEqual([]);
    expect(db.uploads).toEqual([]);
    expect(db.downloads).toEqual([PATH]);
  });

  it('L,M — the row is untouched: no attempt stamp, no markers, no records', async () => {
    const { row, bytes, sha } = await seed();
    const before = JSON.stringify(row.source_detail);
    const db = readOnlyDb([row], { [PATH]: bytes });
    const spy = spySanitize('ok');

    await previewSanitization(db as never, {
      organisationId: ORG, imageId: IMAGE, originalSha256: sha, boxes: GOOD_BOXES,
    }, { sanitize: spy.sanitize });

    // Byte-for-byte the detail it started with: no `sanitization_attempt`, no
    // derivative, no clearance, no failure, no repair_region, no marker.
    expect(JSON.stringify(row.source_detail)).toBe(before);
    const detail = row.source_detail as Record<string, unknown>;
    for (const key of [
      'sanitization_attempt', 'sanitized_derivative', 'sanitization_clearance',
      'sanitization_failure', 'repair_region',
    ]) {
      expect(detail[key] ?? null, key).toBeNull();
    }
  });

  it('N — a candidate is returned only through the sanitizer, with its own facts', async () => {
    const { row, bytes, sha } = await seed();
    const db = readOnlyDb([row], { [PATH]: bytes });
    const spy = spySanitize('ok');

    const out = await previewSanitization(db as never, {
      organisationId: ORG, imageId: IMAGE, originalSha256: sha, boxes: GOOD_BOXES,
    }, { sanitize: spy.sanitize });

    expect(out.ok).toBe(true);
    if (out.ok === true) {
      // The bytes are the sanitizer's, and the numbers are reported rather
      // than recomputed here — a preview that measured its own share would be
      // a second opinion about the thing it is previewing.
      expect(out.bytes.length).toBeGreaterThan(0);
      expect(out.transformation).toBe('generative_overlay_inpaint');
      expect(out.repairedShare).toBeCloseTo(0.0812, 6);
      expect(out.repairedShare).toBeLessThanOrEqual(MAX_REPAIRED_SHARE);
      expect(out.regionsRemoved).toBe(2);
      expect(out.model).toBe('@cf/test/model');
    }
  });

  it('an operational failure is 503 and a finding is 422 — they are not the same thing', async () => {
    const { row, bytes, sha } = await seed();
    const db = readOnlyDb([row], { [PATH]: bytes });
    // The default stub reports the worker unreachable.
    const spy = spySanitize();

    const out = await previewSanitization(db as never, {
      organisationId: ORG, imageId: IMAGE, originalSha256: sha, boxes: GOOD_BOXES,
    }, { sanitize: spy.sanitize });

    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.reason).toBe('inpaint_unavailable');
      // Worth retrying, so it must not read as a verdict about the picture.
      expect(out.status).toBe(503);
    }
  });

  it('a request missing its identifiers never reaches the database', async () => {
    const db = readOnlyDb([], {});
    const spy = spySanitize('ok');
    const bad: Array<[string, Record<string, unknown>]> = [
      ['no organisation', { organisationId: '', imageId: IMAGE, originalSha256: 'a'.repeat(64), boxes: GOOD_BOXES }],
      ['no image', { organisationId: ORG, imageId: '', originalSha256: 'a'.repeat(64), boxes: GOOD_BOXES }],
      ['a short sha', { organisationId: ORG, imageId: IMAGE, originalSha256: 'abc', boxes: GOOD_BOXES }],
      ['no boxes', { organisationId: ORG, imageId: IMAGE, originalSha256: 'a'.repeat(64), boxes: [] }],
    ];
    for (const [name, input] of bad) {
      const out = await previewSanitization(db as never, input as never,
        { sanitize: spy.sanitize });
      expect(out.ok, name).toBe(false);
      if (out.ok === false) expect(out.status, name).toBe(400);
    }
    expect(db.downloads).toEqual([]);
    expect(spy.seen.calls).toBe(0);
  });
});
