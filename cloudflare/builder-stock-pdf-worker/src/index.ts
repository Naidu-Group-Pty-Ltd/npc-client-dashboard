/**
 * BUILDER STOCK — the PDF election worker.
 *
 * WHAT IT IS FOR. Per-execution platform telemetry, 8 September 2026: thirteen
 * settler kills in one cold start, EVERY one `reason: CPUTime` — successes at
 * 1,828 ms of CPU or less, kills at 2,031 ms or more, against a 2,000 ms
 * limit — while memory peaked at 108 MB of 256. Reading one heavy brochure and
 * electing its image is indivisible and costs about 2.4 s. So that one unit
 * runs here, where there is CPU for it, and nothing else moves.
 *
 * IT DECIDES NOTHING ABOUT A PROPERTY. It is handed a document and a label and
 * it answers which image the shared election chose. It is never told which
 * property ROW it is looking at — no row id, no organisation, no upload — so
 * it could not act on one even in principle. Every write stays in the Supabase
 * path: the image, the provenance, the work stage, the settlement, the
 * availability. This has no database client, no Supabase key, no storage
 * credential and no storage.
 *
 * THE ELECTION IS THE SHARED ONE, AND SO IS THE READER. `electFromPdfBytes`
 * and `readPdfPageTextResult` are imported, never reimplemented, so a winner
 * here is the winner everywhere and no threshold can drift between the two
 * ends. A measured trap from the research that preceded this: a hand-written
 * `extractText` wrapper answered `not_identified` on both heavy production
 * brochures where the real reader answers `recovered`, because
 * `readPdfPageTextResult` also appends each page's AcroForm FIELD text, which
 * is what identifies those covers. The esm.sh specifier is resolved to the
 * same pinned npm package by a build alias in `wrangler.jsonc`.
 *
 * This mirrors `builder-stock-image-worker`: narrowly scoped Cloudflare
 * compute, bearer-authenticated, with Supabase authoritative for everything
 * else.
 */
import { electFromPdfBytes } from '../../../supabase/functions/_shared/builderStock/pdfElection.ts';
import { readPdfPageTextResult } from '../../../supabase/functions/_shared/builderStock/pdfText.ts';
import {
  ELECTION_CONTEXT_HEADER, MAX_DOCUMENT_BYTES, PDF_ELECTION_PROTOCOL,
  bytesToBase64, decodeElectionContext,
} from '../../../supabase/functions/_shared/builderStock/pdfElectionBoundary.pure.ts';

interface Env {
  /** The only configuration this worker has. */
  BUILDER_STOCK_PDF_WORKER_TOKEN?: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/**
 * Constant-time bearer comparison, as `builder-stock-image-worker` does it: a
 * length-leaking early return on a shared secret is worth avoiding even behind
 * an unadvertised URL.
 */
function tokenMatches(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < presented.length; i += 1) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
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
    if (!presented || !tokenMatches(presented, expected)) {
      return json({ error: 'unauthorised' }, 401);
    }

    if (url.pathname !== '/v1/elect' || request.method !== 'POST') {
      return json({ error: 'not_found' }, 404);
    }

    const context = decodeElectionContext(request.headers.get(ELECTION_CONTEXT_HEADER));
    if (!context) return json({ error: 'bad_context' }, 400);

    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_DOCUMENT_BYTES) {
      return json({ error: 'bad_document', bytes: bytes.length }, 413);
    }

    const outcome = await electFromPdfBytes(bytes, readPdfPageTextResult, {
      label: context.label,
      identifiedBy: context.identifiedBy,
      design: context.design,
      identityHints: context.identityHints,
      documentName: context.documentName,
      url: context.url,
    });

    if (outcome.status === 'recovered') {
      return json({
        protocol: PDF_ELECTION_PROTOCOL,
        status: 'recovered',
        image: {
          bytes: bytesToBase64(outcome.image.bytes),
          contentType: outcome.image.contentType,
          reference: outcome.image.reference,
          provenance: outcome.image.provenance,
          role: outcome.image.role,
        },
      });
    }
    /*
     * The election's own verdicts, relayed unchanged. `not_identified` is a
     * finding it earned by reading the document; `unreachable` is its own
     * operational answer (a reader that failed, a page list that came back
     * empty). Neither is invented here.
     */
    return json({
      protocol: PDF_ELECTION_PROTOCOL,
      status: outcome.status,
      detail: 'detail' in outcome ? outcome.detail : undefined,
    });
  },
};
