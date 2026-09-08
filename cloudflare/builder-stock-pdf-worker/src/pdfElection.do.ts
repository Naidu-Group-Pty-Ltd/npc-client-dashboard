/**
 * BUILDER STOCK — the PDF election Durable Object.
 *
 * WHY THE HEAVY WORK IS IN HERE AND NOT IN THE WORKER.
 *
 * An ordinary Worker request is charged CPU against the account's Workers
 * plan. A Durable Object is a separate execution context with its own
 * accounting: it stays resident while a request is in flight, one I/O context
 * per object, and it is the place Cloudflare's own limits documentation points
 * at when a Worker exceeds its CPU budget ("Offload work — move expensive
 * computation to Durable Objects"). So the ingress Worker stays trivial and
 * every millisecond of PDF decoding happens here.
 *
 * IT IS COMPUTE ONLY. The class is SQLite-backed because that is the only
 * storage backend the Workers Free plan offers, NOT because anything is
 * stored: this never touches `ctx.storage`, and a test asserts it. No PDF, no
 * elected image, no context, no property fact survives a request. Everything
 * that persists stays in the Supabase path, which remains the only writer.
 *
 * THE ELECTION AND THE READER ARE THE SHARED ONES. `electFromPdfBytes` and
 * `readPdfPageTextResult` are imported, never reimplemented, so a winner here
 * is the winner everywhere and no threshold, page rule, provenance field or
 * `not_identified` semantic can drift between the two ends. A measured trap
 * from the work that preceded this: a hand-written `extractText` wrapper
 * answered `not_identified` on both heavy production brochures where the real
 * reader answers `recovered`, because `readPdfPageTextResult` also appends
 * each page's AcroForm FIELD text — which is exactly what identifies those
 * covers.
 */
import { DurableObject } from 'cloudflare:workers';
import { electFromPdfBytes } from '../../../supabase/functions/_shared/builderStock/pdfElection.ts';
import { readPdfPageTextResult } from '../../../supabase/functions/_shared/builderStock/pdfText.ts';
import {
  ELECTION_CONTEXT_HEADER, MAX_DOCUMENT_BYTES, PDF_ELECTION_PROTOCOL,
  bytesToBase64, decodeElectionContext,
} from '../../../supabase/functions/_shared/builderStock/pdfElectionBoundary.pure.ts';

/**
 * The Durable Object's own environment. Deliberately EMPTY.
 *
 * It holds no bearer (the ingress already authenticated), no Supabase key, no
 * database or storage credential, and no binding of any kind. It is reachable
 * only through the internal Durable Object binding from the authenticated
 * Worker — never from the internet.
 */
// deno-lint-ignore no-empty-interface
export interface PdfElectionEnv {}

/**
 * The name of the one lane every election is serialised through.
 *
 * It lives HERE rather than in the Worker entrypoint because workerd treats
 * every named export of the entrypoint as a handler or a Durable Object class
 * and refuses to start otherwise — "Incorrect type for map entry
 * 'ELECTION_LANE': the provided value is not of type 'function or
 * ExportedHandler'". Measured: the Worker would not boot at all.
 */
export const ELECTION_LANE = 'builder-stock-pdf-election';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export class PdfElection extends DurableObject<PdfElectionEnv> {
  /*
   * ONE DOCUMENT AT A TIME, AND THE OBJECT'S OWN THREADING IS NOT ENOUGH.
   *
   * A Durable Object runs one JavaScript callback at a time, but it still
   * INTERLEAVES at every `await` — so two elections entering together would
   * both be resident, each holding a multi-megabyte document and its decoded
   * pages, in one 128 MB isolate. Memory is the ceiling that does not move
   * with the plan, and the measurement that shaped this whole change found
   * five concurrent reads peaking at 429 MB.
   *
   * This is the same promise-chain lane `withPdfDecodeSlot` uses on the
   * Supabase side: each request waits for the one before it to finish, so the
   * object's memory holds one election's worth of work at a time. It is kept
   * here rather than in the shared election because the shared election
   * already has its own slot and taking a slot twice in one stack is a
   * deadlock rather than a bound.
   */
  #lane: Promise<unknown> = Promise.resolve();

  private queue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#lane.then(work, work);
    // The lane must survive a rejection, or one failed election wedges every
    // request behind it for the life of the object.
    this.#lane = run.then(() => undefined, () => undefined);
    return run;
  }

  async fetch(request: Request): Promise<Response> {
    const context = decodeElectionContext(request.headers.get(ELECTION_CONTEXT_HEADER));
    if (!context) return json({ error: 'bad_context' }, 400);

    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_DOCUMENT_BYTES) {
      return json({ error: 'bad_document', bytes: bytes.length }, 413);
    }

    return await this.queue(async () => {
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
    });
  }
}
