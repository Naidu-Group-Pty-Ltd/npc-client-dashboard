/**
 * Builder Stock — the PDF election worker, and the proofs that it can do
 * nothing else.
 *
 * WHY IT EXISTS, from the platform's own per-execution telemetry on 8
 * September 2026. A thirteen-property cold start killed the settler thirteen
 * times and EVERY kill was `reason: CPUTime`: successful executions ended at
 * 1,828 ms of CPU or less, killed ones at 2,031 ms or more, against a 2,000 ms
 * limit, while memory peaked at 108 MB of a 256 MB ceiling. Reading one heavy
 * brochure and electing its image is indivisible and costs about 2.4 s. It
 * does not fit, and no scheduling rule makes it fit — so that one unit runs on
 * Cloudflare and nothing else moves.
 *
 * These tests pin the facts that make that safe:
 *
 *   1. ONE IMPLEMENTATION — the worker imports the shared `electFromPdfBytes`
 *      and the shared `readPdfPageTextResult`, so a winner there is the winner
 *      here and no threshold can drift between two ends;
 *   2. the CONTEXT that crosses is the one the election actually reads, built
 *      by the shared encoder rather than hand-written at either end;
 *   3. the WIRE IS LOSSLESS — the same bytes and context elect the same image,
 *      byte for byte, through the worker as in process;
 *   4. it is NARROW — one bearer is its whole configuration; it holds no
 *      database, storage or Supabase credential and declares no binding, so
 *      every write stays in the Supabase path;
 *   5. it FAILS CLOSED — no token configured, none sent, or the wrong one, all
 *      refuse before a byte is parsed;
 *   6. its failures are OPERATIONAL — unreachable, refused, timed out, killed
 *      by Cloudflare, or answering nonsense all read as `unreachable`, which
 *      retries, and never as `not_identified`, which is banked;
 *   7. RUNTIME 2 IS UNCHANGED — until the runtime is deliberately advanced,
 *      every route resolves in process exactly as production does today;
 *   8. and under the new runtime there is NO SILENT FALLBACK to the in-process
 *      heavy election, because that is the thing measured to die.
 *
 * The end-to-end block wires the REAL Supabase client to the REAL worker
 * handler with only the page-text reader stubbed, so the two sides of the wire
 * cannot drift apart without a test noticing.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../../../supabase/functions/_shared/builderStock/pdfText', () => ({
  readPdfPageTextResult: vi.fn(async () => ({ ok: true as const, pages: [COVER_TEXT] })),
}));

import worker from '../../../cloudflare/builder-stock-pdf-worker/src/index';
import { readPdfPageTextResult } from '../../../supabase/functions/_shared/builderStock/pdfText';
import { electFromPdfBytes } from '../../../supabase/functions/_shared/builderStock/pdfElection';
import { runElectionOnRoute } from '../../../supabase/functions/_shared/builderStock/pdfElectionClient';
import {
  WORKER_RUNTIME_VERSION, electionRoute,
} from '../../../supabase/functions/_shared/builderStock/pdfElectionRoute.pure';
import {
  ELECTION_CONTEXT_HEADER, MAX_DOCUMENT_BYTES, PDF_ELECTION_PROTOCOL,
  decodeElectionContext,
} from '../../../supabase/functions/_shared/builderStock/pdfElectionBoundary.pure';
import { RUNTIME_VERSION } from '../../../supabase/functions/_shared/builderStock/runtimeVersion.pure';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');
const WORKER_SRC = 'cloudflare/builder-stock-pdf-worker/src/index.ts';

/** Source with comments removed, so prose is never the evidence. */
const stripComments = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

// ---------------------------------------------------------------------------
// Fixtures — the live package shape: a facade render on page 1, the estate
// masterplan on page 2. Same recipe the existing package tests use.
// ---------------------------------------------------------------------------

const LABEL = 'Lot 43, Lot 43 - Tringa Street, Sandpiper Estate, Tweed Heads South NSW 2486';
const COVER_TEXT =
  `${LABEL}\nFIXED PRICE CONTRACT\n$1,307,585\nLand Size 350 m2\n4 bed 2 bath 2 car`;

function jpegBytes(size = 160_000, fill = 0x42): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  bytes.fill(fill, 4, size - 2);
  bytes.set([0xff, 0xd9], size - 2);
  return bytes;
}

function concat(parts: Array<Uint8Array | string>): Uint8Array {
  const encoder = new TextEncoder();
  const chunks = parts.map((part) => typeof part === 'string' ? encoder.encode(part) : part);
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

function packagePdf(page1: Uint8Array, page2: Uint8Array): Uint8Array {
  const draw1 = 'q 516 0 0 290 40 480 cm /Im0 Do Q';
  const draw2 = 'q 580 0 0 820 5 10 cm /Im1 Do Q';
  return concat([
    '%PDF-1.4\n',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n',
    '2 0 obj<</Type/Pages/Kids[3 0 R 6 0 R]/Count 2>>endobj\n',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox [0 0 595 842]'
      + '/Resources<</XObject<</Im0 4 0 R>>>>/Contents 5 0 R>>endobj\n',
    `4 0 obj<</Type/XObject/Subtype/Image/Width 1700/Height 956/Filter/DCTDecode/Length ${page1.length}>>stream\n`,
    page1,
    '\nendstream\nendobj\n',
    `5 0 obj<</Length ${draw1.length}>>stream\n${draw1}\nendstream\nendobj\n`,
    '6 0 obj<</Type/Page/Parent 2 0 R/MediaBox [0 0 595 842]'
      + '/Resources<</XObject<</Im1 7 0 R>>>>/Contents 8 0 R>>endobj\n',
    `7 0 obj<</Type/XObject/Subtype/Image/Width 2000/Height 1414/Filter/DCTDecode/Length ${page2.length}>>stream\n`,
    page2,
    '\nendstream\nendobj\n',
    `8 0 obj<</Length ${draw2.length}>>stream\n${draw2}\nendstream\nendobj\n`,
    'trailer<</Root 1 0 R>>\n%%EOF\n',
  ]);
}

const DOCUMENT = packagePdf(jpegBytes(160_000, 0x33), jpegBytes(240_000, 0x44));
const CONTEXT = {
  label: LABEL,
  identifiedBy: 'direct_link' as const,
  design: 'Stradbroke 180',
  identityHints: ['Sandpiper Estate'],
  documentName: 'Lot 43 - Stradbroke 180 - Property Package.pdf',
  url: 'https://drive.google.com/uc?export=download&id=abc',
};
const TOKEN = 'a-long-random-worker-bearer-value';
const ENDPOINT = 'https://builder-stock-pdf-worker.example.workers.dev';

/** The real worker handler, reached the way the real client reaches it. */
function workerBackedFetch(env: { BUILDER_STOCK_PDF_WORKER_TOKEN?: string } = {
  BUILDER_STOCK_PDF_WORKER_TOKEN: TOKEN,
}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    worker.fetch(new Request(String(input), init as RequestInit), env));
}

// ---------------------------------------------------------------------------

describe('one implementation decides which image wins', () => {
  const source = read(WORKER_SRC);

  it('the worker runs the shared election rather than its own copy', () => {
    expect(source).toContain(
      "from '../../../supabase/functions/_shared/builderStock/pdfElection.ts'");
    expect(source).toContain('electFromPdfBytes(bytes, readPdfPageTextResult');
  });

  /*
   * AND THE SHARED READER. Measured during the research that preceded this: a
   * hand-written `extractText` wrapper answered `not_identified` on BOTH heavy
   * production brochures where the real reader answers `recovered`, because
   * `readPdfPageTextResult` also appends each page's AcroForm FIELD text —
   * which is what identifies those covers. A worker that reimplements the
   * reader measures its own reimplementation.
   */
  it('and the shared reader, so a verdict there is the verdict here', () => {
    expect(source).toContain(
      "from '../../../supabase/functions/_shared/builderStock/pdfText.ts'");
  });

  it('and holds no election logic of its own', () => {
    // Every judgement lives in the shared modules. Anything in the CODE naming
    // a threshold, a page rule or a role would be a second extractor — the
    // prose above may of course discuss them.
    expect(stripComments(source)).not.toMatch(/coverPage|floorPlan|facade|threshold|score/i);
  });

  it('and the Edge path calls that same module', () => {
    const pkg = read('supabase/functions/_shared/builderStock/packageImages.ts');
    expect(pkg).toContain("from './pdfElectionClient.ts'");
    expect(pkg).toContain('runElection(bytes, readPageTexts, {');
    const client = read('supabase/functions/_shared/builderStock/pdfElectionClient.ts');
    expect(client).toContain("from './pdfElection.ts'");
  });

  it('the election still takes the decode slot around the whole heavy path', () => {
    const election = read('supabase/functions/_shared/builderStock/pdfElection.ts');
    const slot = election.indexOf('withPdfDecodeSlot');
    const text = election.indexOf('await readPageTexts(bytes)');
    expect(slot).toBeGreaterThan(-1);
    expect(slot).toBeLessThan(text);
  });
});

describe('the context that crosses is the one the election reads', () => {
  /*
   * NOT A THIN HAND-WRITTEN SUBSTITUTE. The research that preceded this was
   * measured with a plausible label carrying no `design` and no
   * `identityHints`, and BOTH heavy documents answered `not_identified` in
   * ~300 ms rather than `recovered` in ~1,200 ms: with no estate name to
   * corroborate by, no cover page is recognised, nothing is decoded, and the
   * CPU-heavy half never runs. A correct answer to a different question. So
   * what the client sends is asserted to be everything the election reads.
   */
  it('carries every field the election consumes, and no identifier at all', async () => {
    const fetchSpy = workerBackedFetch();
    vi.stubGlobal('fetch', fetchSpy);
    await runElectionOnRoute(DOCUMENT, readPdfPageTextResult, CONTEXT,
      { kind: 'worker', endpoint: ENDPOINT, token: TOKEN });
    vi.unstubAllGlobals();

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    const decoded = decodeElectionContext(headers[ELECTION_CONTEXT_HEADER]);
    expect(decoded).toEqual({
      protocol: PDF_ELECTION_PROTOCOL,
      label: CONTEXT.label,
      identifiedBy: CONTEXT.identifiedBy,
      design: CONTEXT.design,
      identityHints: CONTEXT.identityHints,
      documentName: CONTEXT.documentName,
      url: CONTEXT.url,
    });
  });

  it('and names no row, organisation or upload — the worker cannot act on a property', () => {
    const boundary = read('supabase/functions/_shared/builderStock/pdfElectionBoundary.pure.ts');
    const wire = boundary.slice(boundary.indexOf('export interface WireElectionContext'));
    const fields = wire.slice(0, wire.indexOf('}'));
    expect(fields).not.toMatch(/itemId|item_id|rowId|organisation|organization|uploadId|tenant/i);
  });

  it('sends the document as the raw body rather than copying it', () => {
    // A `.slice()` would duplicate a 14 MB brochure in the isolate with the
    // least room for it, which is the resource this whole change is about.
    const client = read('supabase/functions/_shared/builderStock/pdfElectionClient.ts');
    expect(client).not.toContain('bytes.slice()');
    expect(client).toContain('body: bytes as unknown as BodyInit');
  });
});

describe('the wire is lossless: the same bytes elect the same image', () => {
  it('through the worker, byte for byte, as in process', async () => {
    const inProcess = await electFromPdfBytes(DOCUMENT, readPdfPageTextResult, CONTEXT);
    expect(inProcess.status).toBe('recovered');

    vi.stubGlobal('fetch', workerBackedFetch());
    const viaWorker = await runElectionOnRoute(DOCUMENT, readPdfPageTextResult, CONTEXT,
      { kind: 'worker', endpoint: ENDPOINT, token: TOKEN });
    vi.unstubAllGlobals();

    expect(viaWorker.status).toBe('recovered');
    if (inProcess.status !== 'recovered' || viaWorker.status !== 'recovered') return;
    // The picture itself, not merely its length: two images from one brochure
    // can share a size and only the bytes settle it.
    expect(viaWorker.image.bytes).toEqual(inProcess.image.bytes);
    expect(viaWorker.image.contentType).toBe(inProcess.image.contentType);
    expect(viaWorker.image.reference).toBe(inProcess.image.reference);
    expect(viaWorker.image.provenance).toEqual(inProcess.image.provenance);
    expect(viaWorker.image.role).toEqual(inProcess.image.role);
    // Identity fields are this side's own knowledge and are never taken on
    // trust from the answer.
    expect(viaWorker.image.documentName).toBe(CONTEXT.documentName);
    expect(viaWorker.image.documentUrl).toBe(CONTEXT.url);
  });

  it('and it is the estate masterplan that loses, on both paths', async () => {
    const inProcess = await electFromPdfBytes(DOCUMENT, readPdfPageTextResult, CONTEXT);
    if (inProcess.status !== 'recovered') throw new Error('fixture no longer elects');
    expect(inProcess.image.reference).toContain('#page1:');
  });
});

describe('the worker can hold no credential and reach no data', () => {
  const source = read(WORKER_SRC);
  const config = read('cloudflare/builder-stock-pdf-worker/wrangler.jsonc');

  it('declares exactly one environment value, and it is the bearer', () => {
    const env = source.slice(source.indexOf('interface Env'));
    const body = env.slice(0, env.indexOf('}'));
    const keys = [...body.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
    expect(keys).toEqual(['BUILDER_STOCK_PDF_WORKER_TOKEN']);
  });

  it('names no Supabase, database or storage identifier in its code', () => {
    // Import PATHS legitimately contain "supabase" — the shared modules live
    // there — so the imports are cut away and the worker's own body is judged.
    const body = stripComments(source.slice(source.indexOf('interface Env')));
    expect(body).not.toMatch(
      /supabase|createClient|SERVICE_ROLE|service_role|anon_key|postgres|storage|\.from\(/i);
  });

  /*
   * PARSED, NOT GREPPED. A first version of this searched the file for binding
   * NAMES as substrings, and `ai` matches inside "alias" and "explain" — a
   * test that fails on its own prose. Reading the keys asserts something
   * stronger anyway: not "none of the bindings I thought to list", but "no key
   * at all beyond these five".
   */
  it('and its configuration declares no binding of any kind', () => {
    const parsed = JSON.parse(config.replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, ''));
    expect(Object.keys(parsed).sort()).toEqual([
      'alias', 'compatibility_date', 'compatibility_flags', 'limits', 'main',
      'name', 'observability',
    ]);
  });

  it('writes nothing anywhere — it reads a document and answers', () => {
    const body = stripComments(source);
    expect(body).not.toMatch(/\b(insert|update|upsert|delete|put|write)\s*\(/i);
  });
});

describe('authentication fails closed', () => {
  const elect = (headers: Record<string, string>, env: Record<string, string>) =>
    worker.fetch(
      new Request(`${ENDPOINT}/v1/elect`, { method: 'POST', headers, body: DOCUMENT }),
      env as { BUILDER_STOCK_PDF_WORKER_TOKEN?: string });

  it('refuses everything while no token is configured, rather than serving openly', async () => {
    const response = await elect({ authorization: `Bearer ${TOKEN}` }, {});
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'worker_token_not_configured' });
  });

  it('refuses a request with no bearer', async () => {
    const response = await elect({}, { BUILDER_STOCK_PDF_WORKER_TOKEN: TOKEN });
    expect(response.status).toBe(401);
  });

  it('refuses the wrong bearer', async () => {
    const response = await elect(
      { authorization: 'Bearer not-the-token' }, { BUILDER_STOCK_PDF_WORKER_TOKEN: TOKEN });
    expect(response.status).toBe(401);
  });

  it('compares in constant time, so a length cannot be probed', () => {
    const source = stripComments(read(WORKER_SRC));
    expect(source).toContain('diff |=');
    // No early return inside the comparison loop.
    expect(source).not.toMatch(/for \([^)]*\) \{[^}]*return false/);
  });

  it('refuses a context it cannot vouch for rather than electing something', async () => {
    const response = await worker.fetch(
      new Request(`${ENDPOINT}/v1/elect`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, [ELECTION_CONTEXT_HEADER]: 'not-base64!!' },
        body: DOCUMENT,
      }), { BUILDER_STOCK_PDF_WORKER_TOKEN: TOKEN });
    expect(response.status).toBe(400);
  });
});

/*
 * A BOUNDARY FAILURE IS NEVER A FINDING ABOUT A BUILDER'S DOCUMENT.
 *
 * `not_identified` is banked and suppresses that source until a version bump;
 * `unreachable` records nothing and retries. So everything that can go wrong
 * on this side of the wire has to be `unreachable`.
 */
describe('every boundary failure stays operational', () => {
  const cases: Array<[string, () => unknown]> = [
    ['the worker cannot be reached', () => { throw new Error('ECONNREFUSED'); }],
    ['the request times out', () => { throw new DOMException('aborted', 'TimeoutError'); }],
    ['the worker refuses (401)', () => new Response('nope', { status: 401 })],
    ['the worker errors (500)', () => new Response('boom', { status: 500 })],
    ['Cloudflare kills it for CPU or memory (1102)',
      () => new Response('error code: 1102', { status: 500 })],
    ['the answer is not JSON', () => new Response('<html>gateway</html>', { status: 200 })],
    ['the answer speaks another protocol',
      () => Response.json({ protocol: 99, status: 'recovered' })],
    ['the answer carries an unknown status',
      () => Response.json({ protocol: PDF_ELECTION_PROTOCOL, status: 'invented' })],
    ['the answer has no usable image',
      () => Response.json({ protocol: PDF_ELECTION_PROTOCOL, status: 'recovered' })],
    ['the answer describes a different document', () => Response.json({
      protocol: PDF_ELECTION_PROTOCOL,
      status: 'recovered',
      image: {
        bytes: 'AAAA', contentType: 'image/jpeg',
        reference: 'somebody-elses.pdf#page1:Im0', provenance: {}, role: {},
      },
    })],
  ];

  for (const [name, respond] of cases) {
    it(`answers unreachable when ${name}`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => respond() as Response));
      const outcome = await runElectionOnRoute(DOCUMENT, readPdfPageTextResult, CONTEXT,
        { kind: 'worker', endpoint: ENDPOINT, token: TOKEN });
      vi.unstubAllGlobals();
      expect(outcome.status).toBe('unreachable');
    });
  }

  it('and can never invent not_identified — it may only relay one', () => {
    const client = stripComments(
      read('supabase/functions/_shared/builderStock/pdfElectionClient.ts'));
    // Every status literal this module CONSTRUCTS. `not_identified` appears
    // only in the relay branch, guarded by the worker having said it.
    const constructed = [...client.matchAll(/status:\s*'(\w+)'/g)].map((m) => m[1]);
    expect(constructed).toEqual(['unreachable', 'recovered']);
    expect(client).toContain(
      "body.status === 'not_identified' || body.status === 'unreachable'");
  });

  it('bounds the wait, so a hung worker is answered rather than awaited', () => {
    const client = read('supabase/functions/_shared/builderStock/pdfElectionClient.ts');
    expect(client).toContain('AbortSignal.timeout(ELECTION_TIMEOUT_MS)');
  });

  it('refuses a document outside the bounds without calling anyone', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const outcome = await runElectionOnRoute(new Uint8Array(0), readPdfPageTextResult, CONTEXT,
      { kind: 'worker', endpoint: ENDPOINT, token: TOKEN });
    vi.unstubAllGlobals();
    expect(outcome.status).toBe('unreachable');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(MAX_DOCUMENT_BYTES).toBeGreaterThan(14 * 1024 * 1024);
  });
});

describe('runtime 2 behaves exactly as production does today', () => {
  it('is still runtime 2, so nothing has moved yet', () => {
    expect(RUNTIME_VERSION).toBe(2);
    expect(WORKER_RUNTIME_VERSION).toBe(3);
    expect(RUNTIME_VERSION).toBeLessThan(WORKER_RUNTIME_VERSION);
  });

  it('routes in process at runtime 2 even with a worker fully configured', () => {
    expect(electionRoute({ runtimeVersion: 2, endpoint: ENDPOINT, token: TOKEN }))
      .toEqual({ kind: 'in_process' });
  });

  it('and at every runtime below the worker runtime', () => {
    for (const version of [0, 1, 2]) {
      expect(electionRoute({ runtimeVersion: version, endpoint: ENDPOINT, token: TOKEN }).kind)
        .toBe('in_process');
    }
  });

  it('runs the real election on that route, unchanged', async () => {
    const outcome = await runElectionOnRoute(DOCUMENT, readPdfPageTextResult, CONTEXT,
      { kind: 'in_process' });
    const direct = await electFromPdfBytes(DOCUMENT, readPdfPageTextResult, CONTEXT);
    expect(outcome).toEqual(direct);
  });

  it('and no migration in this change advances the runtime', () => {
    const runtime = read('supabase/functions/_shared/builderStock/runtimeVersion.pure.ts');
    expect(runtime).toContain('export const RUNTIME_VERSION = 2;');
  });
});

/*
 * THE RULE THIS CHANGE TURNS ON.
 *
 * Falling back to the in-process election when the worker is missing or broken
 * would re-run the thing measured to exceed the CPU ceiling, spend the item's
 * whole budget doing it, and re-create the exact `CPUTime` failure this change
 * exists to fix.
 */
describe('there is no silent in-process fallback for the heavy path', () => {
  /** A reader that records whether the in-process election ever ran. */
  const spyReader = () => {
    const reader = vi.fn(async () => ({ ok: true as const, pages: [COVER_TEXT] }));
    return reader;
  };

  it('answers unreachable rather than electing here when no worker is configured', async () => {
    const route = electionRoute({
      runtimeVersion: WORKER_RUNTIME_VERSION, endpoint: '', token: '' });
    expect(route.kind).toBe('no_capacity');
    const outcome = await runElectionOnRoute(DOCUMENT, readPdfPageTextResult, CONTEXT, route);
    expect(outcome.status).toBe('unreachable');
  });

  it('and a half-configured worker is no capacity, not a fallback', () => {
    expect(electionRoute({ runtimeVersion: 3, endpoint: ENDPOINT, token: '' }).kind)
      .toBe('no_capacity');
    expect(electionRoute({ runtimeVersion: 3, endpoint: '', token: TOKEN }).kind)
      .toBe('no_capacity');
  });

  it('never runs the heavy election locally when the worker route fails', async () => {
    const reader = spyReader();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const outcome = await runElectionOnRoute(DOCUMENT, reader, CONTEXT,
      { kind: 'worker', endpoint: ENDPOINT, token: TOKEN });
    vi.unstubAllGlobals();
    expect(outcome.status).toBe('unreachable');
    // The in-process election reads page texts first. It never ran.
    expect(reader).not.toHaveBeenCalled();
  });

  it('nor when there is no capacity at all', async () => {
    const reader = spyReader();
    const outcome = await runElectionOnRoute(DOCUMENT, reader, CONTEXT,
      { kind: 'no_capacity', detail: 'nowhere to run it' });
    expect(outcome.status).toBe('unreachable');
    expect(reader).not.toHaveBeenCalled();
  });

  it('and the dispatcher names no fallback in its code', () => {
    const client = read('supabase/functions/_shared/builderStock/pdfElectionClient.ts');
    const dispatch = client.slice(client.indexOf('export async function runElectionOnRoute'));
    const body = stripComments(dispatch.slice(0, dispatch.indexOf('\nasync function electViaWorker')));
    // `electFromPdfBytes` may be reached ONCE, on the in_process route.
    expect((body.match(/electFromPdfBytes\(/g) ?? []).length).toBe(1);
    expect(body.indexOf('electFromPdfBytes(')).toBeLessThan(body.indexOf("'no_capacity'"));
  });

  it('quotes around a pasted secret do not silently become no capacity', () => {
    // The failure `inpaintOverlay` records: a secret pasted with its quotes
    // produces a bearer that is silently wrong.
    const route = electionRoute({
      runtimeVersion: 3, endpoint: `${ENDPOINT}/`, token: `"${TOKEN}"` });
    expect(route).toEqual({ kind: 'worker', endpoint: ENDPOINT, token: TOKEN });
  });
});

describe('the existing image worker keeps its gate', () => {
  it('is still typechecked strictly, and only the new worker is excluded', () => {
    const config = JSON.parse(read('tsconfig.worker.json'));
    expect(config.include).toEqual(['cloudflare']);
    expect(config.exclude).toEqual(['cloudflare/builder-stock-pdf-worker']);
    expect(config.compilerOptions.strict).toBe(true);
    expect(config.compilerOptions.allowImportingTsExtensions).toBeUndefined();
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('npx tsc --noEmit -p tsconfig.worker.json');
  });

  /*
   * AND THE NEW WORKER IS VALIDATED, not merely excluded. This repo has
   * already recorded the failure that guards against: "a guard nobody runs
   * still reads as coverage".
   */
  it('while the new worker is validated by the toolchains that compile it', () => {
    const ci = read('.github/workflows/ci.yml');
    const job = ci.slice(ci.indexOf('  builder-stock-pdf-worker:'));
    expect(job).toContain('deno check cloudflare/builder-stock-pdf-worker/src/index.ts');
    expect(job).toContain('npm ci --prefix cloudflare/builder-stock-pdf-worker');
    expect(job).toMatch(/wrangler@[\d.]+ deploy --dry-run/);
    // Without this the check dies before type-checking anything.
    expect(job).toContain('DENO_NO_PACKAGE_JSON: "1"');
    // wrangler 4 refuses to start below Node 22.
    expect(job).toContain('node-version: 22');
  });
});
