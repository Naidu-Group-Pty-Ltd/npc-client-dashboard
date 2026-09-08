/**
 * BUILDER STOCK — the PDF election worker. A THIN INGRESS.
 *
 * WHAT IT IS FOR. Per-execution platform telemetry, 8 September 2026: thirteen
 * settler kills in one cold start, EVERY one `reason: CPUTime` — successes at
 * 1,828 ms of CPU or less, kills at 2,031 ms or more, against a 2,000 ms
 * limit — while memory peaked at 108 MB of 256. Reading one heavy brochure and
 * electing its image is indivisible and costs about 2.4 s. So that one unit
 * runs on Cloudflare, and nothing else moves.
 *
 * WHY THIS FILE DOES ALMOST NOTHING. Every millisecond spent here is charged
 * against the account's Workers plan, so the ingress is four cheap things —
 * a health answer, a bearer check, a route check, and a hand-off — and the
 * expensive work happens inside the `PdfElection` Durable Object, which is a
 * separate execution context. This Worker never parses a PDF, never decodes
 * one, and never even reads the request body: the raw body is STREAMED to the
 * Durable Object by passing the original `Request` to the stub, so a 14 MB
 * brochure is not copied and never base64-encoded at the edge.
 *
 * IT DECIDES NOTHING ABOUT A PROPERTY. It is handed a document and a label and
 * it returns which image the shared election chose. It is never told which
 * property ROW it is looking at — no row id, no organisation, no upload — so
 * it could not act on one even in principle. Every write stays in the Supabase
 * path: the image, the provenance, the work stage, the settlement, the
 * availability. This has no database client, no Supabase key, no storage
 * credential and no storage.
 *
 * This mirrors `builder-stock-image-worker`: narrowly scoped Cloudflare
 * compute, bearer-authenticated, with Supabase authoritative for everything
 * else.
 */
import { PDF_ELECTION_PROTOCOL } from '../../../supabase/functions/_shared/builderStock/pdfElectionBoundary.pure.ts';

/*
 * ONLY handlers and Durable Object classes may be named exports of a Worker
 * entrypoint. workerd validates this at startup and refuses to boot on
 * anything else, so the lane NAME is imported rather than re-exported here.
 */
export { PdfElection } from './pdfElection.do.ts';
import { ELECTION_LANE } from './pdfElection.do.ts';

/**
 * The two methods this ingress uses on the Durable Object binding, declared
 * rather than pulled from Cloudflare's ambient types.
 *
 * `deno check` is what type-checks the SHARED election modules through this
 * worker's import graph in CI, and Deno has no `@cloudflare/workers-types`.
 * Naming the surface we actually touch keeps that check working, keeps the
 * worker free of a types dependency, and states the whole of what the ingress
 * is allowed to do with the object: name one, and hand it a request.
 */
interface ElectionLaneStub {
  fetch(request: Request): Promise<Response>;
}
interface ElectionLaneNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): ElectionLaneStub;
}

interface Env {
  /** The only secret this worker has. */
  BUILDER_STOCK_PDF_WORKER_TOKEN?: string;
  /** The internal binding to the compute object. Not reachable from outside. */
  PDF_ELECTION: ElectionLaneNamespace;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/**
 * Constant-time equality: both values are SHA-256 digested and the digests
 * XOR-compared, so neither length nor prefix of the expected token leaks
 * through timing, and the comparison itself cannot short-circuit.
 *
 * The SAME implementation `builder-stock-image-worker` uses, deliberately
 * rather than coincidentally: two workers on one account guarding one kind of
 * secret should not have two answers to how a bearer is compared.
 */
async function tokensMatch(received: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(received)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const va = new Uint8Array(a);
  const vb = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({
        ok: Boolean(env.BUILDER_STOCK_PDF_WORKER_TOKEN),
        service: 'builder-stock-pdf-worker',
        protocol: PDF_ELECTION_PROTOCOL,
      }, env.BUILDER_STOCK_PDF_WORKER_TOKEN ? 200 : 503);
    }

    /*
     * FAILS CLOSED. With no token configured this serves nothing at all,
     * rather than serving openly — a PDF processor reachable without a bearer
     * is an open decode endpoint for anyone who finds the URL.
     */
    const expected = env.BUILDER_STOCK_PDF_WORKER_TOKEN ?? '';
    if (!expected) return json({ error: 'worker_token_not_configured' }, 503);
    const auth = request.headers.get('authorization') ?? '';
    const presented = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : '';
    if (!presented || !(await tokensMatch(presented, expected))) {
      return json({ error: 'unauthorised' }, 401);
    }

    if (url.pathname !== '/v1/elect' || request.method !== 'POST') {
      return json({ error: 'not_found' }, 404);
    }

    /*
     * ONE NAMED OBJECT, ON PURPOSE.
     *
     * `idFromName` on a fixed string resolves to the same Durable Object for
     * every election, so all of them queue in one lane rather than fanning out
     * across many objects that would each hold a multi-megabyte document in a
     * shared 128 MB isolate. Memory is the ceiling that does not move, and
     * this is the deliberate opposite of the usual sharding advice: the point
     * is a bottleneck, not throughput.
     *
     * The original Request is handed over untouched, so the PDF streams
     * through as the raw body it arrived as — not read here, not copied here,
     * not encoded here.
     */
    const stub = env.PDF_ELECTION.get(env.PDF_ELECTION.idFromName(ELECTION_LANE));
    return await stub.fetch(request);
  },
};
