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
 * POST /v1/classify
 *   Headers:
 *     Authorization: Bearer <BUILDER_STOCK_IMAGE_WORKER_TOKEN>
 *   Body (multipart/form-data, `image-<key>` parts only, at most six):
 *     image-<key>: one picture taken out of ONE builder document
 *   Returns:
 *     { "model": "...", "verdicts": [{ "key", "subject", "confident" }, ...] }
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
 * The SECOND endpoint answers a different question about the same kind of
 * input and inherits every one of those properties. `/v1/classify` is handed
 * pictures taken out of one builder document and says what each one SHOWS — a
 * house from the street, a floor plan, a logo, a page of text. It decides
 * nothing: it cannot see a property, a label, a lot number or another
 * document, it cannot rank, and its whole vocabulary is a closed list this
 * source declares. The caller keeps the decision, and the only verdict that
 * can ever promote a picture is `house_exterior` on a page the document had
 * already designated for that property by its own text. Everything else this
 * can say is a demotion, and a batch it cannot answer leaves the caller
 * exactly where it was.
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
/**
 * The whole request, refused off its declared length BEFORE the body is
 * parsed. `formData()` buffers the entire body first, so without this an
 * authenticated caller could park ~100 MB (the platform's own ceiling) in a
 * 128 MB isolate before any per-part check ran. Production sends two
 * ~700 KB parts; four megabytes is generous headroom. A body with no
 * declared length (chunked) falls through to the per-part checks below —
 * availability over a pre-parse refusal nothing honest ever trips.
 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Each part is a 512-square PNG in normal operation (< 1 MB). Headroom, not invitation. */
const MAX_PART_BYTES = 2 * 1024 * 1024;
/**
 * The patch is SQUARE, and small. The transport (`inpaintOverlay.ts`) encodes
 * every patch at exactly 512x512; the model's published range reaches 2048,
 * but a 2048-square request is ~16x the compute of the real workload billed
 * to this account's own Workers AI allowance, and `Array.from` boxes each
 * byte at ~8x the input's size on the way to the binding — so the accepted
 * window is the caller's actual shape with one doubling of headroom, not the
 * model's maximum.
 */
const MODEL_MIN_EDGE = 256;
const MAX_PATCH_EDGE = 1024;
/**
 * The most of a patch a mask may paint. A BACKSTOP, deliberately looser than
 * the real bound: the Supabase side refuses any repair past 35% of the FRAME
 * before it ever calls here (Barrier B), but a patch is a plate plus a
 * context margin, so a legitimate per-patch share runs to ~0.6. What this
 * refuses is the stolen-token case — an all-white mask turning a private
 * repair endpoint into a free-form generator on this account's credit.
 */
const MAX_MASK_INK_SHARE = 0.8;

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
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
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
 * The share of the mask that is INK — pixels the model would be permitted to
 * paint — read by actually decoding the mask, in the narrow shape the one
 * honest client ever sends.
 *
 * The transport's `maskPng` writes an 8-bit, non-interlaced PNG with filter
 * byte 0 on every scanline (see `rasterPng.ts`), so that exact shape is
 * REQUIRED rather than handled generally: a mask in any other encoding is
 * refused outright, which turns a crafted input into a 422 instead of a
 * decoding job. The inflate is capped at the size the header promises, so a
 * mismatched IDAT cannot expand past it, and the dimensions were already
 * bounded before this runs.
 *
 * Returns the ink share in [0,1], or null for a mask this refuses to read.
 */
export async function maskInkShare(bytes: Uint8Array): Promise<number | null> {
  const dims = pngDimensions(bytes);
  if (!dims) return null;

  // Walk the chunks: IHDR fields first, then every IDAT concatenated.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const depth = bytes[24];
  const colour = bytes[25];
  const compression = bytes[26];
  const filter = bytes[27];
  const interlace = bytes[28];
  if (depth !== 8 || (colour !== 0 && colour !== 2)) return null;
  if (compression !== 0 || filter !== 0 || interlace !== 0) return null;
  const channels = colour === 2 ? 3 : 1;

  const idat: Uint8Array[] = [];
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const start = at + 8;
    if (start + length > bytes.length) return null;
    if (type === 'IDAT') idat.push(bytes.subarray(start, start + length));
    if (type === 'IEND') break;
    at = start + length + 4;
  }
  if (!idat.length) return null;
  let total = 0;
  for (const chunk of idat) total += chunk.length;
  const deflated = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of idat) { deflated.set(chunk, cursor); cursor += chunk.length; }

  // Inflate, capped at exactly the bytes the header promises. Written
  // against the stream's own writer rather than `new Blob(...).stream()` —
  // the same lesson the repo's PNG codec records: `Blob` has no `stream()`
  // under the test runtime, and an inflate nothing can test breaks quietly.
  const expected = (dims.width * channels + 1) * dims.height;
  let raw: Uint8Array;
  try {
    const transform = new DecompressionStream('deflate');
    const writer = transform.writable.getWriter();
    const writing = writer.write(deflated).then(() => writer.close());
    const reader = transform.readable.getReader();
    raw = new Uint8Array(expected);
    let read = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (read + value.length > expected) { await reader.cancel(); return null; }
      raw.set(value, read);
      read += value.length;
    }
    await writing;
    if (read !== expected) return null;
  } catch {
    return null;
  }

  let ink = 0;
  const rowBytes = dims.width * channels + 1;
  for (let y = 0; y < dims.height; y++) {
    const row = y * rowBytes;
    // Filter byte 0 on every scanline, or this is not the client's encoding.
    if (raw[row] !== 0) return null;
    for (let x = 0; x < dims.width; x++) {
      if (raw[row + 1 + x * channels] >= 128) ink += 1;
    }
  }
  return ink / (dims.width * dims.height);
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
  // Refused off the declared length BEFORE the body is buffered — see
  // MAX_BODY_BYTES for why parse-then-check is the wrong order here.
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return json(413, 'the request is larger than this service accepts');
  }

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
    imageDims.width !== imageDims.height
    || imageDims.width < MODEL_MIN_EDGE || imageDims.width > MAX_PATCH_EDGE
  ) {
    return json(422, `the patch must be square, between ${MODEL_MIN_EDGE} and ${MAX_PATCH_EDGE} pixels`);
  }

  /*
   * The mask is DECODED and measured, not merely sniffed: a mask that paints
   * most of the patch is not a badge repair, whatever sent it. See
   * MAX_MASK_INK_SHARE — this is the backstop behind the Supabase side's own
   * frame-level ceiling, and it is what keeps a leaked token from being a
   * free-form image generator on this account's credit.
   */
  const inkShare = await maskInkShare(mask);
  if (inkShare === null) {
    return json(422, "the 'mask' part is not a PNG this service reads");
  }
  if (inkShare > MAX_MASK_INK_SHARE) {
    return json(422, `the mask would rebuild ${(inkShare * 100).toFixed(0)}% of the patch, `
      + 'which is not a badge repair');
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
  const resultDims = bytes ? pngDimensions(bytes) : null;
  if (!bytes || !resultDims) {
    return json(502, 'the model returned something that was not an image');
  }
  // The answer must be the size of the question: a model that resized the
  // patch has not repaired it, and compositing a resized answer would smear
  // the builder's own pixels.
  if (resultDims.width !== imageDims.width || resultDims.height !== imageDims.height) {
    return json(502, 'the model returned an image of a different size');
  }

  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      'content-type': 'image/png',
      'x-inpaint-model': INPAINT_MODEL,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

// ---------------------------------------------------------------------------
// /v1/classify — what a picture SHOWS, and nothing else
// ---------------------------------------------------------------------------

/**
 * The vision model, pinned here for the same reason the inpainting one is.
 *
 * Chosen off the live Workers AI catalog: natively multimodal, Cloudflare-
 * hosted, and pinned by Cloudflare itself rather than carrying a licence gate
 * that has to be accepted out of band before the binding will answer — which
 * the alternative vision model does, and which fails as an ordinary model
 * error long after a deploy looks successful.
 */
export const CLASSIFY_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';

/**
 * THE WHOLE VOCABULARY, and a closed list on purpose.
 *
 * Every member is prefixed `shows_`, and that is not decoration. It shares no
 * value with `SourceImageRole` in `sourceImageRole.pure.ts` — which already
 * spells `site_plan`, `interior` and `floorplan` — because a subject is not a
 * role. "This shows a house from the street" is a fact about pixels; "this is
 * the property's primary image" is a conclusion about a document, and the
 * second is never inferred from the first alone. A test asserts the two
 * vocabularies cannot be confused, and the prefix is also what makes the
 * last-resort keyword scan below safe: `shows_floor_plan` is not a phrase that
 * turns up in a sentence by accident, where `floor plan` is.
 *
 * Exactly one member can ever lead a listing. Every other member is a
 * DEMOTION, so a model that is wrong in any direction other than
 * `house_exterior` costs the caller nothing it had.
 */
export const CLASSIFY_SUBJECTS = [
  'shows_house_exterior',
  'shows_house_interior',
  'shows_floor_plan',
  'shows_site_plan',
  'shows_finishes',
  'shows_logo',
  'shows_document',
  'shows_people',
  'shows_other',
] as const;

export type ClassifySubject = (typeof CLASSIFY_SUBJECTS)[number];

/** The one subject a caller may act on. Everything else can only demote. */
export const LEADING_SUBJECT: ClassifySubject = 'shows_house_exterior';

/**
 * The instruction, pinned in this reviewed source exactly as the inpainting
 * one is, and for the same reason: a request carrying anything but pictures is
 * refused, so there is no field through which a caller can tell the model what
 * it hopes to see. In particular the model is never told which property, lot,
 * estate or design the document is about — a classifier that has been told
 * what to look for will find it.
 */
export const CLASSIFY_SYSTEM_PROMPT =
  'You sort pictures taken out of a property brochure by what they SHOW. '
  + 'Report only what is visible. Never guess what a picture is for, who it '
  + 'belongs to, or what it is worth.';

export const CLASSIFY_USER_PROMPT =
  'What does this picture show? Choose one subject:\n'
  + 'shows_house_exterior - the outside of a home: its facade, roof, garage or '
  + 'street frontage, as a photograph or an architectural render.\n'
  + 'shows_house_interior - inside a home: a kitchen, living area, bedroom or '
  + 'bathroom.\n'
  + 'shows_floor_plan - a plan, elevation or dimensioned drawing of a '
  + 'building.\n'
  + 'shows_site_plan - an estate masterplan, subdivision, lot layout, aerial '
  + 'diagram or map.\n'
  + 'shows_finishes - samples of materials, colours, tiles, benchtops, tapware '
  + 'or appliances.\n'
  + 'shows_logo - a brand mark, wordmark, letterhead or badge, with no scene '
  + 'behind it.\n'
  + 'shows_document - a page of text, a table, a price panel, a list or a '
  + 'chart.\n'
  + 'shows_people - a picture led by people rather than by a building.\n'
  + 'shows_other - none of these.\n'
  + 'Set confident to false if the picture is unclear, is cut off, or could '
  + 'reasonably be two of these.';

/**
 * The answer's shape, asked for as a schema so the model returns a value
 * rather than a sentence. It is still parsed defensively below: JSON mode is
 * a request, not a guarantee, and an unparseable answer must degrade to "no
 * verdict" rather than to a guess.
 */
const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: 'string', enum: [...CLASSIFY_SUBJECTS] },
    confident: { type: 'boolean' },
  },
  required: ['subject', 'confident'],
} as const;

/** Deterministic: this is a classification, not a composition. */
const CLASSIFY_TEMPERATURE = 0;
/** A verdict is two fields. Anything longer is prose, and prose is not asked for. */
const CLASSIFY_MAX_TOKENS = 96;

/**
 * How many pictures one request may carry.
 *
 * The caller CHUNKS: a brochure page presents a handful of rasters and a
 * document presents a few pages of them, so six is a page's worth and a
 * document is a few requests. Deliberately small — each picture is a separate
 * model call (see `classifyOne` for why), and a request that fans out
 * unboundedly is one stolen token away from being this account's whole Workers
 * AI allowance.
 */
const MAX_CLASSIFY_IMAGES = 6;
/** Per picture. A brochure raster is well under this; headroom, not invitation. */
const MAX_CLASSIFY_PART_BYTES = 3 * 1024 * 1024;
/** The whole request, refused off its declared length before the body is buffered. */
const MAX_CLASSIFY_BODY_BYTES = 10 * 1024 * 1024;

/** `image-<key>`, where the key is the caller's own and comes back verbatim. */
const CLASSIFY_PART_NAME = /^image-([A-Za-z0-9_.:-]{1,64})$/;

/**
 * The picture's type, read from its own first bytes.
 *
 * Sniffed rather than taken from the part's `content-type`, because a declared
 * type is the caller's claim and the bytes are the fact — and the model is
 * handed a data URI whose type has to be the truth or the decode fails
 * somewhere with no useful error.
 */
function imageMediaType(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && PNG_MAGIC.every((byte, i) => bytes[i] === byte)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'image/webp';
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return 'image/gif';
  }
  return null;
}

/** Bytes to base64, chunked so a megabyte does not blow the argument list. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let at = 0; at < bytes.length; at += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  }
  return btoa(binary);
}

/**
 * The two documented ways Workers AI takes a picture, tried in order.
 *
 * The catalog documents the OpenAI-shaped content parts for its multimodal
 * models and a top-level `image` field for the older vision ones, and does not
 * say which this model takes. GUESSING ONE WOULD BE THE WHOLE FEATURE FAILING
 * SILENTLY — every verdict `unavailable`, which reads exactly like a model
 * that has no opinion — so both are attempted and the response says which ran.
 *
 * The one that answers is remembered FOR THE REQUEST and no longer, so a batch
 * of six costs at most one wasted call. Deliberately not remembered for the
 * isolate's life: that is invisible cross-request state whose behaviour
 * depends on which request happened to run first, and a probe poisoned by one
 * transient fault would then answer for every request after it.
 */
type ClassifyTransport = 'content_parts' | 'image_field';
const CLASSIFY_TRANSPORTS: ClassifyTransport[] = ['content_parts', 'image_field'];

function classifyInputs(transport: ClassifyTransport, dataUri: string): Record<string, unknown> {
  const shared = {
    response_format: { type: 'json_schema', json_schema: CLASSIFY_SCHEMA },
    temperature: CLASSIFY_TEMPERATURE,
    max_tokens: CLASSIFY_MAX_TOKENS,
  };
  if (transport === 'content_parts') {
    return {
      ...shared,
      messages: [
        { role: 'system', content: CLASSIFY_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: CLASSIFY_USER_PROMPT },
            { type: 'image_url', image_url: { url: dataUri } },
          ],
        },
      ],
    };
  }
  return {
    ...shared,
    messages: [
      { role: 'system', content: CLASSIFY_SYSTEM_PROMPT },
      { role: 'user', content: CLASSIFY_USER_PROMPT },
    ],
    image: dataUri,
  };
}

/**
 * The model's answer, read out of whatever it actually returned.
 *
 * A schema is a request. What comes back may be the object, a JSON string, a
 * fenced block, or a sentence with the word in it — so every shape is tried
 * and NONE of them invents a verdict: an answer that names no subject in the
 * closed vocabulary returns null, which the caller records as "not answered".
 */
export function readClassifyVerdict(
  output: unknown,
): { subject: ClassifySubject; confident: boolean } | null {
  const candidates: unknown[] = [];
  const seen = new Set<unknown>();
  const consider = (value: unknown) => {
    if (value === null || value === undefined || seen.has(value)) return;
    seen.add(value);
    candidates.push(value);
  };
  consider(output);
  if (output && typeof output === 'object') {
    const record = output as Record<string, unknown>;
    consider(record.response);
    consider(record.result);
    consider(record.output);
  }

  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') {
      const record = candidate as Record<string, unknown>;
      const subject = String(record.subject ?? '');
      if ((CLASSIFY_SUBJECTS as readonly string[]).includes(subject)) {
        return {
          subject: subject as ClassifySubject,
          // Absent is NOT confident: the field is required by the schema, so a
          // missing one means the model did not answer the question asked.
          confident: record.confident === true,
        };
      }
      continue;
    }
    if (typeof candidate !== 'string') continue;
    const text = candidate.trim();
    if (!text) continue;
    // A JSON object anywhere in the text, fenced or bare.
    const brace = text.indexOf('{');
    const close = text.lastIndexOf('}');
    if (brace >= 0 && close > brace) {
      try {
        const parsed = JSON.parse(text.slice(brace, close + 1));
        const nested = readClassifyVerdict(parsed);
        if (nested) return nested;
      } catch {
        /* not JSON after all; the keyword scan below is the last resort */
      }
    }
    /*
     * The last resort, and deliberately strict: EXACTLY ONE of the closed
     * vocabulary's words must appear. A sentence naming two of them has not
     * chosen, and picking the first would turn "this is a floor plan, not a
     * house exterior" into a promotion. `shows_house_exterior` is a token the
     * model was given rather than a phrase English produces, which is what
     * makes scanning for it something other than guessing.
     */
    const named = CLASSIFY_SUBJECTS.filter((subject) => text.includes(subject));
    if (named.length === 1) {
      // A bare word carries no confidence, and unstated confidence is not
      // confidence — see the schema.
      return { subject: named[0], confident: /"?confident"?\s*[:=]\s*true/i.test(text) };
    }
  }
  return null;
}

/** One picture, one model call, one verdict — or a stated absence. */
async function classifyOne(
  env: Env,
  bytes: Uint8Array,
  mediaType: string,
  known: ClassifyTransport | null,
): Promise<{
  subject: ClassifySubject | null;
  confident: boolean;
  transport: ClassifyTransport | null;
  unavailable: string | null;
}> {
  /*
   * ONE PICTURE PER CALL, and the batching is at the REQUEST rather than at
   * the model. A single call carrying six pictures answers about six pictures
   * in one list, and a list that comes back short, long or reordered is a
   * verdict attached to the wrong photograph — which is the one failure this
   * whole subsystem exists to prevent, and which is undetectable from the
   * answer. Six calls cost six calls; a misattributed hero costs a client's
   * card.
   */
  const dataUri = `data:${mediaType};base64,${toBase64(bytes)}`;
  const order = known ? [known] : CLASSIFY_TRANSPORTS;

  let lastError = '';
  for (const transport of order) {
    let output: unknown;
    try {
      output = await env.AI.run(CLASSIFY_MODEL, classifyInputs(transport, dataUri));
    } catch (error) {
      lastError = String(error).slice(0, 160);
      continue;
    }
    const verdict = readClassifyVerdict(output);
    if (!verdict) {
      // The call SUCCEEDED, so the transport is right and the model simply did
      // not answer in the vocabulary. Trying the other shape would only ask a
      // question that already got a reply.
      return {
        subject: null,
        confident: false,
        transport,
        unavailable: 'the model did not name a subject this service recognises',
      };
    }
    return { ...verdict, transport, unavailable: null };
  }
  return {
    subject: null,
    confident: false,
    transport: null,
    unavailable: lastError
      ? `the model could not be reached (${lastError})`
      : 'the model could not be reached',
  };
}

async function classify(request: Request, env: Env): Promise<Response> {
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_CLASSIFY_BODY_BYTES) {
    return json(413, 'the request is larger than this service accepts');
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json(422, 'the request is not multipart/form-data');
  }

  /*
   * `image-<key>` PARTS AND NOTHING ELSE. No prompt, no label, no lot, no
   * design, no reference picture, no URL: the same closed contract the repair
   * endpoint keeps, and here it is what makes the verdict a fact about pixels
   * rather than an answer the caller asked for.
   */
  const names = [...new Set(form.keys())];
  const keys: string[] = [];
  for (const name of names) {
    const match = CLASSIFY_PART_NAME.exec(name);
    if (!match) {
      return json(422, "every part must be named 'image-<key>' and carry one picture");
    }
    keys.push(match[1]);
  }
  if (!keys.length) return json(422, 'the request carries no pictures');
  if (keys.length > MAX_CLASSIFY_IMAGES) {
    return json(422, `this service classifies at most ${MAX_CLASSIFY_IMAGES} pictures `
      + 'per request; send them in smaller batches');
  }

  const pictures: Array<{ key: string; bytes: Uint8Array; mediaType: string }> = [];
  for (const name of names) {
    const key = String(CLASSIFY_PART_NAME.exec(name)?.[1]);
    const part = form.get(name);
    if (part === null || typeof part === 'string') {
      return json(422, `the '${name}' part is text, not a picture`);
    }
    if (part.size === 0) return json(422, `the '${name}' part is empty`);
    if (part.size > MAX_CLASSIFY_PART_BYTES) {
      return json(422, `the '${name}' part is larger than this service accepts`);
    }
    const bytes = new Uint8Array(await part.arrayBuffer());
    const mediaType = imageMediaType(bytes);
    if (!mediaType) return json(422, `the '${name}' part is not a picture this service reads`);
    pictures.push({ key, bytes, mediaType });
  }

  /*
   * Sequential, and that is the point rather than an omission. Six parallel
   * calls arrive at Workers AI as a burst this account is rate-limited on, and
   * a rate-limited call is indistinguishable in the answer from a picture the
   * model had no opinion about — see `unavailable`. One at a time is slower
   * and it is legible.
   */
  const verdicts: Array<Record<string, unknown>> = [];
  let answered = 0;
  let transportUsed: ClassifyTransport | null = null;
  for (const picture of pictures) {
    const verdict = await classifyOne(env, picture.bytes, picture.mediaType, transportUsed);
    if (verdict.transport) transportUsed = verdict.transport;
    if (verdict.subject) answered += 1;
    verdicts.push({
      // Echoed VERBATIM rather than returned in order: a caller that matched
      // verdicts to pictures by position would attach one photograph's subject
      // to another the moment anything reordered, and nothing in a list says
      // it has been reordered.
      key: picture.key,
      subject: verdict.subject,
      confident: verdict.confident,
      unavailable: verdict.unavailable,
    });
  }

  /*
   * A batch NONE of which was answered is an operational fault — the binding,
   * the account's allowance, the model — and the caller should retry it rather
   * than record that a document contains no house. A batch that was partly
   * answered is a normal answer: the caller's own rule decides what a missing
   * verdict means, and for every caller here it means "no promotion".
   */
  if (!answered) {
    return json(502, String(verdicts[0]?.unavailable
      ?? 'the model answered nothing about any picture in this batch'));
  }

  return new Response(JSON.stringify({ model: CLASSIFY_MODEL, verdicts }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'x-classify-model': CLASSIFY_MODEL,
      ...(transportUsed ? { 'x-classify-transport': transportUsed } : {}),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
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

    const known = url.pathname === '/v1/inpaint' || url.pathname === '/v1/classify';
    if (!known) return json(404, 'not found');
    if (request.method !== 'POST') return json(405, 'method not allowed');
    // Auth before any parsing: an unauthenticated request costs nothing and
    // learns nothing, whatever it carries. One token guards both endpoints —
    // they are one private service, and a second credential is a second thing
    // to rotate and forget.
    if (!(await authorised(request, env))) return json(401, 'unauthorized');
    if (url.pathname === '/v1/classify') return await classify(request, env);
    return await inpaint(request, env);
  },
};

export default worker;
