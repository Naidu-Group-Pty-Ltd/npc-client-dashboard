/**
 * Builder Stock image worker — masked overlay inpainting on Cloudflare Workers AI.
 *
 * POST /v1/inpaint
 *   Headers:
 *     Authorization: Bearer <BUILDER_STOCK_IMAGE_WORKER_TOKEN>
 *   Body (multipart/form-data, EXACTLY these two parts):
 *     image: PNG of the builder's own patch (the property's exact pixels)
 *     mask:  PNG, WHITE where the promotional graphic is, BLACK elsewhere
 *   Returns:
 *     image/png bytes (200) with `x-inpaint-model` naming what ran, or
 *     { "error": "..." } (4xx/5xx).
 *
 * GET /healthz -> 200 "ok"    (unauthenticated liveness, nothing else is)
 *
 * WHAT THIS SERVICE IS AND IS NOT. It is the third stage of Builder Stock's
 * image-cleaning order — reached only when no clean builder-supplied original
 * exists for the property AND the deterministic repair could not safely
 * complete — and it is deliberately narrow: receive one image patch and its
 * mask, repair the masked area with Cloudflare Workers AI, return the result.
 * It searches for nothing, stores nothing, and knows nothing about
 * properties: the caller (the Supabase settler) sends the pixels of ONE
 * property's own photograph, and there is no URL input, no reference-image
 * input, no property lookup and no way for this process to reach any other
 * picture. Property isolation is structural.
 *
 * THE PROMPT IS PINNED HERE AND CANNOT ARRIVE IN A REQUEST. The inpainting
 * model requires a text prompt; it is a constant in this reviewed source, a
 * request carrying a `prompt` part is refused outright, and the wording asks
 * only for the surrounding scene to be continued — never for a different or
 * nicer house. The stronger guarantee does not live here at all: the Supabase
 * side composites this worker's answer ONLY inside the approved mask and then
 * gates the whole frame against the original bytes, so nothing this model
 * does — however prompted — can alter a pixel outside the badge.
 *
 * AUTHENTICATION FAILS CLOSED, exactly as the WeasyPrint and pdf-parse
 * sidecars' does: no configured token means every request is refused, so a
 * mis-deployed instance is a broken one rather than an anonymous public
 * image-editing endpoint. Comparison is constant-time.
 *
 * WHAT THIS FILE MUST NEVER CONTAIN: an external image-API URL, key or model
 * name, a second visual input, or a fallback to any endpoint outside the AI
 * binding. A test reads this source and fails if one returns — including any
 * URL literal at all.
 */

/**
 * The model, verified against the live Workers AI catalog before this was
 * written: the catalog's only dedicated masked-inpainting model (the other
 * image models are text-to-image and take no mask). Runs entirely on
 * Cloudflare's own infrastructure through the AI binding below — no vendor
 * key, no external endpoint.
 */
export const INPAINT_MODEL = '@cf/runwayml/stable-diffusion-v1-5-inpainting';

/**
 * The one instruction the model ever receives, and it is a constant.
 *
 * It asks for continuation of what is already in the picture. Nothing in it
 * describes a house, a style or an improvement, and the negative prompt names
 * the promotional artefacts the mask exists to remove so the model does not
 * paint a new badge into the hole it was asked to fill.
 */
export const INPAINT_PROMPT =
  'continue the surrounding background of this exact photograph into the masked area, '
  + 'matching the existing scene, lighting, colours and materials seamlessly';
export const INPAINT_NEGATIVE_PROMPT =
  'text, lettering, words, numbers, logo, watermark, badge, sticker, banner, sign, '
  + 'label, graphic overlay, border, frame';

/** The Workers AI ceiling for this model; more steps than any faster answer. */
const NUM_STEPS = 20;
/** Each part is a 512-square PNG in normal operation (< 1 MB). Headroom, not invitation. */
const MAX_PART_BYTES = 12 * 1024 * 1024;
/** The model's own published input range. */
const MODEL_MIN_EDGE = 256;
const MODEL_MAX_EDGE = 2048;

/**
 * The AI binding as this worker uses it — `env.AI.run(model, inputs)`. Typed
 * locally rather than from `@cloudflare/workers-types` so the module needs no
 * dependency to be imported by the repo's vitest suite, where a stub binding
 * exercises every path.
 */
interface AiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

export interface Env {
  /** Declared in wrangler.jsonc; Cloudflare injects the real binding. */
  AI: AiBinding;
  /** `wrangler secret put BUILDER_STOCK_IMAGE_WORKER_TOKEN`. Absent = refuse all. */
  BUILDER_STOCK_IMAGE_WORKER_TOKEN?: string;
}

function json(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * Constant-time equality: both values are SHA-256 digested and the digests
 * XOR-compared, so neither length nor prefix of the expected token leaks
 * through timing, and the comparison itself cannot short-circuit.
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

/**
 * Quotes are stripped for the same reason every sidecar client strips them: a
 * secret pasted into a dashboard with its quotes produces a bearer token that
 * is silently wrong on exactly one side.
 */
function unquote(value: string): string {
  return value.trim().replace(/^["']+|["']+$/g, '');
}

async function authorised(request: Request, env: Env): Promise<boolean> {
  const expected = unquote(env.BUILDER_STOCK_IMAGE_WORKER_TOKEN ?? '');
  // No token configured: refuse everything — fail closed.
  if (!expected) return false;
  const header = request.headers.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const received = unquote(header.slice('Bearer '.length));
  if (!received) return false;
  return await tokensMatch(received, expected);
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Width and height straight off the IHDR header — the one structural fact
 * this worker needs about its inputs, read without shipping a PNG decoder.
 * Returns null for anything that is not a PNG whose first chunk is IHDR,
 * which for a PNG any real encoder wrote is every PNG.
 */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  for (let i = 0; i < PNG_MAGIC.length; i++) {
    if (bytes[i] !== PNG_MAGIC[i]) return null;
  }
  // Bytes 12..15 must spell IHDR; 16..23 are big-endian width then height.
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (!width || !height) return null;
  return { width, height };
}

/** A refusal the caller can read, or the part's bytes. */
async function readPart(form: FormData, name: string): Promise<Uint8Array | { error: string }> {
  const part = form.get(name);
  if (part === null) return { error: `the request carries no '${name}' part` };
  if (typeof part === 'string') return { error: `the '${name}' part is text, not an image` };
  if (part.size === 0) return { error: `the '${name}' part is empty` };
  if (part.size > MAX_PART_BYTES) {
    return { error: `the '${name}' part is larger than this service accepts` };
  }
  return new Uint8Array(await part.arrayBuffer());
}

/**
 * Whatever shape the binding answers in — the documented ReadableStream, or a
 * buffer from a stub or a future runtime — normalised to bytes, or null.
 */
async function resultBytes(output: unknown): Promise<Uint8Array | null> {
  try {
    if (output instanceof Uint8Array) return output;
    if (output instanceof ArrayBuffer) return new Uint8Array(output);
    if (output && typeof (output as ReadableStream).getReader === 'function') {
      return new Uint8Array(await new Response(output as ReadableStream).arrayBuffer());
    }
  } catch {
    return null;
  }
  return null;
}

async function inpaint(request: Request, env: Env): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json(422, 'the request is not multipart/form-data');
  }

  /*
   * EXACTLY two parts, and these two. A `prompt`, `reference`, `url` or any
   * other part is refused rather than ignored, so the contract "one image and
   * its mask, nothing else" is enforced here and not merely relied upon —
   * there is no field through which a caller can soften the instruction or
   * smuggle in a second picture.
   */
  const names = [...new Set(form.keys())].sort();
  if (names.length !== 2 || names[0] !== 'image' || names[1] !== 'mask') {
    return json(422, "the request must carry exactly an 'image' part and a 'mask' part");
  }

  const image = await readPart(form, 'image');
  if (!(image instanceof Uint8Array)) return json(422, image.error);
  const mask = await readPart(form, 'mask');
  if (!(mask instanceof Uint8Array)) return json(422, mask.error);

  const imageDims = pngDimensions(image);
  if (!imageDims) return json(422, "the 'image' part is not a PNG");
  const maskDims = pngDimensions(mask);
  if (!maskDims) return json(422, "the 'mask' part is not a PNG");
  if (imageDims.width !== maskDims.width || imageDims.height !== maskDims.height) {
    return json(422, 'the image and its mask disagree about their size');
  }
  if (
    imageDims.width < MODEL_MIN_EDGE || imageDims.width > MODEL_MAX_EDGE
    || imageDims.height < MODEL_MIN_EDGE || imageDims.height > MODEL_MAX_EDGE
  ) {
    return json(422, `the patch must be between ${MODEL_MIN_EDGE} and ${MODEL_MAX_EDGE} pixels on each edge`);
  }

  /*
   * The model's published schema: `image` and `mask` are the encoded file
   * bytes as arrays of 8-bit integers, the mask WHITE where the model may
   * paint. Width and height are the patch's own, so the answer comes back at
   * the size the caller sent.
   */
  let output: unknown;
  try {
    output = await env.AI.run(INPAINT_MODEL, {
      prompt: INPAINT_PROMPT,
      negative_prompt: INPAINT_NEGATIVE_PROMPT,
      image: Array.from(image),
      mask: Array.from(mask),
      width: imageDims.width,
      height: imageDims.height,
      num_steps: NUM_STEPS,
    });
  } catch (error) {
    // Operational, and said so: the Supabase settler records nothing, keeps
    // the source, and retries after its cooldown.
    return json(502, `the model could not complete the repair (${String(error).slice(0, 160)})`);
  }

  const bytes = await resultBytes(output);
  if (!bytes || !pngDimensions(bytes)) {
    return json(502, 'the model returned something that was not an image');
  }

  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      'content-type': 'image/png',
      'x-inpaint-model': INPAINT_MODEL,
      'cache-control': 'no-store',
    },
  });
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/healthz' || url.pathname === '/health') {
      if (request.method !== 'GET') return json(405, 'method not allowed');
      return new Response('ok', {
        headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
      });
    }

    if (url.pathname !== '/v1/inpaint') return json(404, 'not found');
    if (request.method !== 'POST') return json(405, 'method not allowed');
    // Auth before any parsing: an unauthenticated request costs nothing and
    // learns nothing, whatever it carries.
    if (!(await authorised(request, env))) return json(401, 'unauthorized');
    return await inpaint(request, env);
  },
};

export default worker;
