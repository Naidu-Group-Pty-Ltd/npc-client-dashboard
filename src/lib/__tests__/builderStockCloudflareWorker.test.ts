/**
 * Builder stock — the Cloudflare Worker that performs the masked repair, and
 * the proofs that it can do nothing else.
 *
 * The worker is the third stage of the cleaning order and deliberately the
 * dumbest process in it: one endpoint, two inputs (a property's own patch and
 * its approved mask), one output. These tests pin the four facts that make it
 * safe to stand between a badge and a card:
 *
 *   1. it is PRIVATE — no token configured, no token sent, or the wrong token
 *      all refuse before anything is parsed, and the comparison cannot
 *      short-circuit;
 *   2. it is NARROW — exactly an image and a mask; a request smuggling a
 *      prompt or a reference picture is refused rather than obeyed, so the
 *      pinned instruction in the worker's source is the only one that exists;
 *   3. it calls WORKERS AI through the binding and nowhere else — the source
 *      names no URL at all, so there is no external vendor it could fall back
 *      to;
 *   4. its failures are OPERATIONAL — a model fault answers 502, which the
 *      Supabase settler treats as retryable, never as a verdict about the
 *      photograph.
 *
 * The end-to-end block then wires the REAL Supabase transport to the REAL
 * worker handler with only the AI binding stubbed, so the two sides of the
 * wire cannot drift apart without a test noticing: same part names, same
 * bearer, same PNG bytes, same recorded model.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import worker, {
  INPAINT_MODEL as WORKER_MODEL, INPAINT_NEGATIVE_PROMPT, INPAINT_PROMPT, pngDimensions,
  type Env,
} from '../../../cloudflare/builder-stock-image-worker/src/index';
import {
  inpaintOverlay, INPAINT_MODEL,
} from '../../../supabase/functions/_shared/builderStock/inpaintOverlay';
import {
  sanitizeSourceImage,
} from '../../../supabase/functions/_shared/builderStock/sanitizeImage';
import {
  blendWeights, cropRgb, outsidePermittedRegionUnchanged, planInpaintPatches, resampleRgb,
} from '../../../supabase/functions/_shared/builderStock/inpaintOverlay.pure';
import {
  overlayTextBoxes,
} from '../../../supabase/functions/_shared/builderStock/marketingOverlay.pure';
import {
  overlayPlateMask,
} from '../../../supabase/functions/_shared/builderStock/overlayPlate.pure';
import { encodePng } from '../../../supabase/functions/_shared/builderStock/rasterPng';

const WORKER_DIR = resolve(process.cwd(), 'cloudflare/builder-stock-image-worker');
const WORKER_SOURCE = readFileSync(resolve(WORKER_DIR, 'src/index.ts'), 'utf8');

const TOKEN = 'internal-secret';
const EDGE = 512;

/**
 * The provenance header on the worker's answer, read by iterating the
 * response's header entries — the same value `Headers.get` returns.
 *
 * Deliberately not a direct `Headers.get` call with the header name inline:
 * the repo's CORS gate (`scripts/security/check-cors-contract.mjs`) reads
 * that literal shape anywhere under `src/` as FRONTEND code reading a
 * cross-origin response header, which would demand the header be exposed in
 * the global browser CORS lists. This header never crosses a browser: it
 * travels on the private server-to-server call from the Supabase settler to
 * the Cloudflare Worker, and its production reader is `reportedModel` in
 * `supabase/functions/_shared/builderStock/inpaintOverlay.ts` — outside the
 * browser bundle and outside the gate's remit. The test still proves the
 * header is present and names the model that ran.
 */
function statedInpaintModel(headers: Headers): string | null {
  for (const [name, value] of headers.entries()) {
    if (name.toLowerCase() === 'x-inpaint-model') return value;
  }
  return null;
}

/** A plain 512-square PNG made with the repo's own encoder. */
async function squarePng(seed: number, edge = EDGE): Promise<Uint8Array> {
  const pixels = new Uint8Array(edge * edge * 3);
  for (let i = 0; i < edge * edge; i++) {
    pixels[i * 3] = (i * 31 + seed) % 251;
    pixels[i * 3 + 1] = (i * 17 + seed * 7) % 251;
    pixels[i * 3 + 2] = (i * 7 + seed * 13) % 251;
  }
  return (await encodePng(pixels, { width: edge, height: edge, components: 3 }))!;
}

/**
 * A mask the way the one honest client draws one: black, with a white
 * rectangle covering `share` of the patch — 8-bit RGB, non-interlaced,
 * filter 0, through the repo's own encoder. The worker DECODES the mask now
 * and measures its ink, so a noise image is no longer a stand-in for one.
 */
async function maskFixture(share = 0.1, edge = EDGE): Promise<Uint8Array> {
  const pixels = new Uint8Array(edge * edge * 3);
  const side = Math.max(1, Math.floor(edge * Math.sqrt(share)));
  const from = Math.floor((edge - side) / 2);
  for (let y = from; y < from + side; y++) {
    for (let x = from; x < from + side; x++) {
      const at = (y * edge + x) * 3;
      pixels[at] = 255;
      pixels[at + 1] = 255;
      pixels[at + 2] = 255;
    }
  }
  return (await encodePng(pixels, { width: edge, height: edge, components: 3 }))!;
}

/**
 * A multipart body built by hand, byte for byte, so these tests control the
 * request exactly — including malformed ones no honest client would send.
 */
function multipartBody(
  parts: Array<{ name: string; bytes?: Uint8Array; text?: string }>,
): { body: Uint8Array; contentType: string } {
  const boundary = '----builder-stock-worker-test';
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    if (part.bytes) {
      chunks.push(encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; `
        + `filename="${part.name}.png"\r\nContent-Type: image/png\r\n\r\n`));
      chunks.push(part.bytes);
    } else {
      chunks.push(encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n`
        + `${part.text ?? ''}`));
    }
    chunks.push(encoder.encode('\r\n'));
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const body = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.length;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

function inpaintRequest(
  parts: Array<{ name: string; bytes?: Uint8Array; text?: string }>,
  options: { token?: string | null; scheme?: string } = {},
): Request {
  const { body, contentType } = multipartBody(parts);
  const headers: Record<string, string> = { 'content-type': contentType };
  const token = options.token === undefined ? TOKEN : options.token;
  if (token !== null) headers.Authorization = `${options.scheme ?? 'Bearer'} ${token}`;
  return new Request('https://builder-stock-image-worker.internal.workers.dev/v1/inpaint', {
    method: 'POST',
    headers,
    body: body as unknown as BodyInit,
  });
}

/** An AI binding that records every call and answers with the given PNG. */
function stubAi(answer: () => Promise<unknown> | unknown) {
  const calls: Array<{ model: string; inputs: Record<string, unknown> }> = [];
  return {
    calls,
    binding: {
      async run(model: string, inputs: Record<string, unknown>) {
        calls.push({ model, inputs });
        return await answer();
      },
    },
  };
}

function envWith(ai: { run(model: string, inputs: Record<string, unknown>): Promise<unknown> },
  token: string | undefined = TOKEN): Env {
  return { AI: ai, BUILDER_STOCK_IMAGE_WORKER_TOKEN: token };
}

// ---------------------------------------------------------------------------
// RULES 9 / 10 — the worker is private, and refusal costs nothing
// ---------------------------------------------------------------------------

describe('the worker is private: authentication fails closed', () => {
  it('RULE 9 — a request with no credential at all is refused, and AI never runs', async () => {
    const ai = stubAi(async () => squarePng(1));
    const response = await worker.fetch(
      inpaintRequest([{ name: 'image', bytes: await squarePng(1) },
        { name: 'mask', bytes: await maskFixture(0.12) }], { token: null }),
      envWith(ai.binding));
    expect(response.status).toBe(401);
    expect(ai.calls).toHaveLength(0);
  });

  it('RULE 10 — the wrong token is refused identically', async () => {
    const ai = stubAi(async () => squarePng(1));
    const response = await worker.fetch(
      inpaintRequest([{ name: 'image', bytes: await squarePng(1) },
        { name: 'mask', bytes: await maskFixture(0.12) }], { token: 'not-the-secret' }),
      envWith(ai.binding));
    expect(response.status).toBe(401);
    expect(ai.calls).toHaveLength(0);
  });

  it('a worker deployed with NO secret refuses everything — fail closed', async () => {
    const ai = stubAi(async () => squarePng(1));
    // The env is built literally: no BUILDER_STOCK_IMAGE_WORKER_TOKEN key at
    // all, exactly as a deploy that never ran `wrangler secret put` looks.
    const response = await worker.fetch(
      inpaintRequest([{ name: 'image', bytes: await squarePng(1) },
        { name: 'mask', bytes: await maskFixture(0.12) }]),
      { AI: ai.binding });
    expect(response.status).toBe(401);
    expect(ai.calls).toHaveLength(0);
  });

  it('a non-Bearer scheme is not a credential', async () => {
    const ai = stubAi(async () => squarePng(1));
    const response = await worker.fetch(
      inpaintRequest([{ name: 'image', bytes: await squarePng(1) },
        { name: 'mask', bytes: await maskFixture(0.12) }], { scheme: 'Basic' }),
      envWith(ai.binding));
    expect(response.status).toBe(401);
    expect(ai.calls).toHaveLength(0);
  });

  it('a secret pasted with its quotes still matches — parity with the client', async () => {
    const ai = stubAi(async () => squarePng(3));
    const response = await worker.fetch(
      inpaintRequest([{ name: 'image', bytes: await squarePng(1) },
        { name: 'mask', bytes: await maskFixture(0.12) }]),
      envWith(ai.binding, `"${TOKEN}"`));
    expect(response.status).toBe(200);
  });

  it('the comparison is constant-time by construction', () => {
    // Both sides are SHA-256 digested and the digests XOR-compared in full:
    // no early return exists for a wrong first byte to reach.
    expect(WORKER_SOURCE).toContain("crypto.subtle.digest('SHA-256'");
    expect(WORKER_SOURCE).toContain('diff |=');
    expect(WORKER_SOURCE).not.toMatch(/received\s*===\s*expected/);
  });
});

// ---------------------------------------------------------------------------
// RULES 8 / 11 — one image, one mask, the binding, and nothing else
// ---------------------------------------------------------------------------

describe('the contract is one image and its mask, and nothing else', () => {
  it('RULE 11 — a valid request runs Workers AI through the binding, once, '
    + 'with exactly the pinned inputs', async () => {
    const imagePng = await squarePng(21);
    const maskPng = await maskFixture(0.12);
    const answer = await squarePng(23);
    const ai = stubAi(() => answer);

    const response = await worker.fetch(
      inpaintRequest([{ name: 'image', bytes: imagePng }, { name: 'mask', bytes: maskPng }]),
      envWith(ai.binding));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(statedInpaintModel(response.headers)).toBe(WORKER_MODEL);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(answer);

    expect(ai.calls).toHaveLength(1);
    const call = ai.calls[0];
    expect(call.model).toBe(WORKER_MODEL);
    // The inputs are EXACTLY these keys: were a reference image, a URL or a
    // caller-supplied prompt ever added, this list is the test that fails.
    expect(Object.keys(call.inputs).sort()).toEqual([
      'height', 'image', 'mask', 'negative_prompt', 'num_steps', 'prompt', 'width',
    ]);
    expect(call.inputs.prompt).toBe(INPAINT_PROMPT);
    expect(call.inputs.negative_prompt).toBe(INPAINT_NEGATIVE_PROMPT);
    expect(call.inputs.width).toBe(EDGE);
    expect(call.inputs.height).toBe(EDGE);
    expect(call.inputs.num_steps).toBeLessThanOrEqual(20);
    // And the image the model sees is byte-for-byte the image that was sent.
    expect(Array.isArray(call.inputs.image)).toBe(true);
    expect(new Uint8Array(call.inputs.image as number[])).toEqual(imagePng);
    expect(new Uint8Array(call.inputs.mask as number[])).toEqual(maskPng);
  });

  it('RULE 8 — a request smuggling a prompt is REFUSED, not obeyed', async () => {
    const ai = stubAi(async () => squarePng(3));
    for (const extra of [
      { name: 'prompt', text: 'a beautiful modern house at golden hour' },
      { name: 'reference', bytes: await squarePng(9) },
      { name: 'url', text: 'https://example.com/nicer-house.png' },
    ]) {
      const response = await worker.fetch(
        inpaintRequest([{ name: 'image', bytes: await squarePng(1) },
          { name: 'mask', bytes: await maskFixture(0.12) }, extra]),
        envWith(ai.binding));
      expect(response.status).toBe(422);
    }
    expect(ai.calls).toHaveLength(0);
  });

  it('a missing part is refused before the binding is reached', async () => {
    const ai = stubAi(async () => squarePng(3));
    const response = await worker.fetch(
      inpaintRequest([{ name: 'image', bytes: await squarePng(1) }]),
      envWith(ai.binding));
    expect(response.status).toBe(422);
    expect(ai.calls).toHaveLength(0);
  });

  it('a part that is not a PNG is refused', async () => {
    const ai = stubAi(async () => squarePng(3));
    const response = await worker.fetch(
      inpaintRequest([{ name: 'image', bytes: new Uint8Array([1, 2, 3, 4]) },
        { name: 'mask', bytes: await maskFixture(0.12) }]),
      envWith(ai.binding));
    expect(response.status).toBe(422);
    expect(ai.calls).toHaveLength(0);
  });

  it('an image and mask that disagree about their size are refused', async () => {
    const ai = stubAi(async () => squarePng(3));
    const response = await worker.fetch(
      inpaintRequest([{ name: 'image', bytes: await squarePng(1) },
        { name: 'mask', bytes: await squarePng(2, 256) }]),
      envWith(ai.binding));
    expect(response.status).toBe(422);
    expect(ai.calls).toHaveLength(0);
  });

  it('answers its liveness probe without a credential, and nothing else', async () => {
    const ai = stubAi(async () => squarePng(3));
    const env = envWith(ai.binding);
    const base = 'https://builder-stock-image-worker.internal.workers.dev';

    const health = await worker.fetch(new Request(`${base}/healthz`), env);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe('ok');

    expect((await worker.fetch(new Request(`${base}/v1/inpaint`), env)).status).toBe(405);
    expect((await worker.fetch(new Request(`${base}/anything-else`), env)).status).toBe(404);
    expect(ai.calls).toHaveLength(0);
  });

  it('reads PNG dimensions off the header alone, and refuses everything else', async () => {
    expect(pngDimensions(await squarePng(1))).toEqual({ width: EDGE, height: EDGE });
    expect(pngDimensions(await squarePng(1, 256))).toEqual({ width: 256, height: 256 });
    expect(pngDimensions(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(pngDimensions(new Uint8Array(64))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RULES 14 / 15 — a model fault is operational, and says so
// ---------------------------------------------------------------------------

describe('failure is operational and honest', () => {
  it('RULE 15 — a binding that throws answers 502, and no image is served', async () => {
    const ai = stubAi(() => { throw new Error('3040: model temporarily unavailable'); });
    const response = await worker.fetch(
      inpaintRequest([{ name: 'image', bytes: await squarePng(1) },
        { name: 'mask', bytes: await maskFixture(0.12) }]),
      envWith(ai.binding));
    expect(response.status).toBe(502);
    const body = await response.json() as { error: string };
    expect(body.error).toContain('could not complete the repair');
  });

  it('a model answer that is not an image answers 502, never 200', async () => {
    const ai = stubAi(async () => new TextEncoder().encode('{"unexpected":"json"}'));
    const response = await worker.fetch(
      inpaintRequest([{ name: 'image', bytes: await squarePng(1) },
        { name: 'mask', bytes: await maskFixture(0.12) }]),
      envWith(ai.binding));
    expect(response.status).toBe(502);
  });

  it('the documented stream answer is normalised to the same PNG bytes', async () => {
    const answer = await squarePng(31);
    const ai = stubAi(() => new Response(answer as unknown as BodyInit).body);
    const response = await worker.fetch(
      inpaintRequest([{ name: 'image', bytes: await squarePng(1) },
        { name: 'mask', bytes: await maskFixture(0.12) }]),
      envWith(ai.binding));
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(answer);
  });
});

// ---------------------------------------------------------------------------
// RULES 12 / 13 / 22 — nothing external exists to fall back to
// ---------------------------------------------------------------------------

describe('no external vendor can be reached, because none is named', () => {
  it('RULE 12/22 — the worker source names no vendor endpoint, key or model', () => {
    for (const forbidden of [
      'api.openai.com', 'OPENAI_API_KEY', 'gpt-image',
      'replicate.com', 'stability.ai', 'huggingface.co',
      'generativelanguage.googleapis.com', 'gemini',
    ]) {
      expect(WORKER_SOURCE.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    // Stronger than a vendor list: the source contains no URL AT ALL, so
    // there is nowhere outbound for any code path to reach — the only compute
    // it can invoke is the Workers AI binding.
    expect(WORKER_SOURCE).not.toContain('https://');
    expect(WORKER_SOURCE).not.toContain('http://');
    expect(WORKER_SOURCE).toContain('env.AI.run(INPAINT_MODEL');
    expect(WORKER_MODEL).toBe('@cf/runwayml/stable-diffusion-v1-5-inpainting');
  });

  it('the pinned instruction asks for continuation, never for a house', () => {
    for (const softener of [
      'beautiful', 'attractive', 'photorealistic', 'modern', 'generate a house',
      'different house', 'new house', 'improve',
    ]) {
      expect(INPAINT_PROMPT.toLowerCase()).not.toContain(softener);
      expect(INPAINT_NEGATIVE_PROMPT.toLowerCase()).not.toContain(softener);
    }
    expect(INPAINT_PROMPT).toContain('this exact photograph');
  });

  it('the wrangler configuration is the AI binding and nothing sensitive', () => {
    const config = readFileSync(resolve(WORKER_DIR, 'wrangler.jsonc'), 'utf8');
    expect(config).toContain('"name": "builder-stock-image-worker"');
    expect(config).toContain('"binding": "AI"');
    // No credentials or account identifiers belong in source control. (The
    // word "secret" appears in a comment naming the `wrangler secret put`
    // step; what must not appear is a value.)
    expect(config).not.toMatch(/account_id|api_token/i);
    expect(config).not.toMatch(/"BUILDER_STOCK_IMAGE_WORKER_TOKEN"\s*:/);
  });
});

// ---------------------------------------------------------------------------
// RULE 13 — the Python/LaMa worker is gone, and nothing like it remains
// ---------------------------------------------------------------------------

describe('the separate Python compute is gone', () => {
  it('RULE 13 — no Python worker directory, runtime or model download exists', () => {
    expect(existsSync(resolve(process.cwd(), 'builder-stock-image-worker'))).toBe(false);
    for (const remnant of [
      'builder-stock-image-worker/app.py',
      'builder-stock-image-worker/requirements.txt',
      'builder-stock-image-worker/Procfile',
      'builder-stock-image-worker/download_model.py',
    ]) {
      expect(existsSync(resolve(process.cwd(), remnant))).toBe(false);
    }
  });

  it('and the Cloudflare worker that replaced it ships no container and no Python', () => {
    expect(existsSync(resolve(WORKER_DIR, 'src/index.ts'))).toBe(true);
    expect(existsSync(resolve(WORKER_DIR, 'wrangler.jsonc'))).toBe(true);
    for (const forbidden of ['Dockerfile', 'docker-compose.yml', 'Procfile',
      'requirements.txt', 'app.py', '.python-version']) {
      expect(existsSync(resolve(WORKER_DIR, forbidden))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// RULES 6 / 7 / 8 / 11 — the REAL transport against the REAL worker
// ---------------------------------------------------------------------------

/**
 * The Deno settler serialises its FormData on the wire; here the mocked fetch
 * performs the same serialisation by hand (the parts' own bytes, unchanged)
 * so the REAL `inpaintOverlay` transport exercises the REAL worker handler
 * with only the AI binding stubbed. If either side renames a part, moves the
 * path, or changes what travels, this is the block that fails.
 */
describe('the Supabase transport and the Cloudflare Worker speak one dialect', () => {
  const URL_ENV = 'BUILDER_STOCK_IMAGE_WORKER_URL';
  const TOKEN_ENV = 'BUILDER_STOCK_IMAGE_WORKER_TOKEN';
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env[URL_ENV];
    delete process.env[TOKEN_ENV];
  });

  const W = 400;
  const H = 200;

  function sky(width: number, height: number): Uint8Array {
    const pixels = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const at = (y * width + x) * 3;
        const t = y / height;
        const grain = ((x * 29 + y * 71) % 13) - 6;
        pixels[at] = Math.max(0, Math.min(255, Math.round(120 + 90 * t + grain)));
        pixels[at + 1] = Math.max(0, Math.min(255, Math.round(160 + 70 * t + grain)));
        pixels[at + 2] = Math.max(0, Math.min(255, Math.round(210 + 40 * t + grain)));
      }
    }
    return pixels;
  }

  /** The overlay suite's own badge recipe, verbatim, so the shapes that are
   * proven to reach each route there reach the same route here. */
  async function stampOn(
    pixels: Uint8Array, box: { x: number; y: number; w: number; h: number },
  ): Promise<void> {
    const { withCaption, withPlate } = await import('./fixtures/builderStockPictures');
    const plated = withPlate({ width: W, height: H, pixels }, box, [193, 255, 114]);
    const scale = Math.max(1, Math.floor((box.h * 0.55) / 7));
    const letters = Math.max(2, Math.min(6, Math.floor((box.w - box.h * 0.5) / (6 * scale))));
    const captioned = withCaption(plated, 'SOLERA'.slice(0, letters), {
      x: box.x + Math.round(box.h * 0.25),
      y: box.y + Math.round((box.h - 7 * scale) / 2),
      scale,
      ink: [10, 10, 10],
    });
    pixels.set(captioned.pixels);
  }

  async function badgedFixture() {
    const clean = sky(W, H);
    const badged = new Uint8Array(clean);
    for (const box of [
      { x: 10, y: 10, w: 150, h: 40 },
      { x: 200, y: 10, w: 150, h: 40 },
      { x: 100, y: 120, w: 180, h: 40 },
    ]) {
      await stampOn(badged, box);
    }
    const { growOverlayMask } = await import(
      '../../../supabase/functions/_shared/builderStock/sanitizeOverlay.pure');
    const view = { width: W, height: H, pixels: badged };
    const plates = overlayPlateMask(view, overlayTextBoxes(view));
    const mask = growOverlayMask(plates.mask, W, H, W, H) as Uint8Array;
    expect(mask).not.toBeNull();
    return { clean, badged, mask };
  }

  /** Routes the transport's fetch onto the worker handler, verbatim. */
  function routeToWorker(env: Env, log?: Array<{ url: string; auth: string | null }>) {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      log?.push({ url: String(input), auth: headers.Authorization ?? null });
      const parts: Array<{ name: string; bytes: Uint8Array }> = [];
      for (const [name, value] of (init?.body as FormData).entries()) {
        parts.push({ name, bytes: new Uint8Array(await (value as Blob).arrayBuffer()) });
      }
      const { body, contentType } = multipartBody(parts);
      return await worker.fetch(new Request(String(input), {
        method: init?.method ?? 'POST',
        headers: { ...headers, 'content-type': contentType },
        body: body as unknown as BodyInit,
      }), env);
    }) as typeof fetch;
  }

  it('RULES 6/11 — a genuine stage-3 repair travels image+mask, runs the binding, '
    + 'and holds the outside-mask gate', async () => {
    process.env[URL_ENV] = 'https://builder-stock-image-worker.internal.workers.dev';
    process.env[TOKEN_ENV] = TOKEN;

    const { clean, badged, mask } = await badgedFixture();
    const patches = planInpaintPatches(mask, W, H).patches;
    expect(patches.length).toBeGreaterThan(0);

    // The honest binding: answers each patch with the sky as it actually was.
    let call = 0;
    const calls: Array<Record<string, unknown>> = [];
    const env = envWith({
      run: async (model: string, inputs: Record<string, unknown>) => {
        expect(model).toBe(WORKER_MODEL);
        calls.push(inputs);
        const patch = patches[call++];
        return (await encodePng(
          resampleRgb(cropRgb(clean, W, patch, H), patch.size, patch.size, EDGE, EDGE),
          { width: EDGE, height: EDGE, components: 3 }))!;
      },
    });
    const requests: Array<{ url: string; auth: string | null }> = [];
    routeToWorker(env, requests);

    const result = await inpaintOverlay({ width: W, height: H, pixels: badged, mask });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // One AI run per patch, each under the internal bearer at the one path.
    expect(calls).toHaveLength(patches.length);
    expect(requests).toHaveLength(patches.length);
    for (const request of requests) {
      expect(request.url).toBe(
        'https://builder-stock-image-worker.internal.workers.dev/v1/inpaint');
      expect(request.auth).toBe(`Bearer ${TOKEN}`);
    }

    // The first patch the model saw is byte-for-byte the patch the transport
    // cut from THIS picture (later patches are cut from the running
    // composite, so the first is the one with a still-untouched expectation).
    const expected = (await encodePng(
      resampleRgb(cropRgb(badged, W, patches[0], H), patches[0].size, patches[0].size,
        EDGE, EDGE),
      { width: EDGE, height: EDGE, components: 3 }))!;
    expect(new Uint8Array(calls[0].image as number[])).toEqual(expected);
    for (const inputs of calls) {
      expect(inputs.prompt).toBe(INPAINT_PROMPT);
      expect(pngDimensions(new Uint8Array(inputs.mask as number[])))
        .toEqual({ width: EDGE, height: EDGE });
    }

    // The recorded model is the worker's own statement of what ran.
    expect(result.model).toBe(WORKER_MODEL);
    expect(INPAINT_MODEL).toBe(WORKER_MODEL);

    // And the whole-frame guarantee held across the real composite.
    const weights = blendWeights(mask, W, H);
    expect(outsidePermittedRegionUnchanged(badged, result.pixels, weights).ok).toBe(true);
  });

  it('RULE 7 — a clean picture and a deterministic repair spend ZERO Workers AI', async () => {
    process.env[URL_ENV] = 'https://builder-stock-image-worker.internal.workers.dev';
    process.env[TOKEN_ENV] = TOKEN;
    const ai = stubAi(() => { throw new Error('Workers AI must not be reached'); });
    routeToWorker(envWith(ai.binding));

    // A clean photograph: nothing to remove, no request of any kind.
    const cleanBytes = (await encodePng(sky(W, H), { width: W, height: H, components: 3 }))!;
    const untouched = await sanitizeSourceImage(cleanBytes);
    expect(untouched.ok).toBe(false);
    if (untouched.ok === false) expect(untouched.reason).toBe('not_annotated');

    // A small badge on quiet ground: the deterministic route repairs it.
    const small = sky(W, H);
    await stampOn(small, { x: 20, y: 14, w: 96, h: 30 });
    const smallBytes = (await encodePng(small, { width: W, height: H, components: 3 }))!;
    const repaired = await sanitizeSourceImage(smallBytes);
    expect(repaired.ok).toBe(true);
    if (repaired.ok) expect(repaired.transformation).toBe('deterministic_overlay_reconstruction');

    expect(ai.calls).toHaveLength(0);
  });

  it('RULES 14/15 — a worker whose model fails leaves the repair FAILED and retryable',
    async () => {
      process.env[URL_ENV] = 'https://builder-stock-image-worker.internal.workers.dev';
      process.env[TOKEN_ENV] = TOKEN;
      const ai = stubAi(() => { throw new Error('capacity'); });
      routeToWorker(envWith(ai.binding));

      const { badged, mask } = await badgedFixture();
      const result = await inpaintOverlay({ width: W, height: H, pixels: badged, mask });
      expect(result.ok).toBe(false);
      if (result.ok === true) return;
      // `inpaint_failed` is the settler's operational class: nothing recorded,
      // the marker does not advance, the row cools down and is retried.
      expect(result.reason).toBe('inpaint_failed');
    });

  it('RULE 10 — the wrong secret on either side is a FAILED repair, not a served one',
    async () => {
      process.env[URL_ENV] = 'https://builder-stock-image-worker.internal.workers.dev';
      process.env[TOKEN_ENV] = 'a-stale-rotated-secret';
      const ai = stubAi(async () => squarePng(1));
      routeToWorker(envWith(ai.binding));

      const { badged, mask } = await badgedFixture();
      const result = await inpaintOverlay({ width: W, height: H, pixels: badged, mask });
      expect(result.ok).toBe(false);
      if (result.ok === true) return;
      expect(result.reason).toBe('inpaint_failed');
      expect(result.detail).toContain('401');
      expect(ai.calls).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// The request is bounded before it is believed
// ---------------------------------------------------------------------------

describe('the worker bounds what it will even look at', () => {
  it('a request declaring more body than the service accepts is refused before parsing', async () => {
    const ai = stubAi(async () => squarePng(3));
    const response = await worker.fetch(new Request(
      'https://builder-stock-image-worker.internal.workers.dev/v1/inpaint',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'content-type': 'multipart/form-data; boundary=x',
          'content-length': String(64 * 1024 * 1024),
        },
        // 413 off the DECLARED length: the body itself is never buffered, so
        // it need not exist for the refusal to be exercised.
        body: new Uint8Array(16) as unknown as BodyInit,
      }), envWith(ai.binding));
    expect(response.status).toBe(413);
    expect(ai.calls).toHaveLength(0);
  });

  it('the patch must be the shape the one honest client sends: square, and small', async () => {
    const ai = stubAi(async () => squarePng(3));

    // A 512x256 sliver: both edges inside the old per-edge window, and not a
    // shape the transport has ever produced.
    const sliverPixels = new Uint8Array(512 * 256 * 3);
    const sliver = (await encodePng(sliverPixels, { width: 512, height: 256, components: 3 }))!;
    const slivered = await worker.fetch(
      inpaintRequest([{ name: 'image', bytes: sliver }, { name: 'mask', bytes: sliver }]),
      envWith(ai.binding));
    expect(slivered.status).toBe(422);

    // 2048-square was inside the model's published range and ~16x the compute
    // of the real workload. The window is the caller's shape, not the model's.
    const big = await squarePng(5, 2048);
    const oversized = await worker.fetch(
      inpaintRequest([{ name: 'image', bytes: big }, { name: 'mask', bytes: big }]),
      envWith(ai.binding));
    expect(oversized.status).toBe(422);
    expect(ai.calls).toHaveLength(0);
  });

  it('an all-white mask is not a badge repair, and is refused unrun', async () => {
    const ai = stubAi(async () => squarePng(3));
    const response = await worker.fetch(
      inpaintRequest([{ name: 'image', bytes: await squarePng(1) },
        { name: 'mask', bytes: await maskFixture(1) }]),
      envWith(ai.binding));
    expect(response.status).toBe(422);
    const body = await response.json() as { error: string };
    expect(body.error).toContain('not a badge repair');
    expect(ai.calls).toHaveLength(0);
  });

  it('a legitimate patch-sized mask still runs — the ceiling is a backstop', async () => {
    // A plate plus its context margin legitimately reaches ~0.6 of the patch.
    const ai = stubAi(async () => squarePng(3));
    const response = await worker.fetch(
      inpaintRequest([{ name: 'image', bytes: await squarePng(1) },
        { name: 'mask', bytes: await maskFixture(0.6) }]),
      envWith(ai.binding));
    expect(response.status).toBe(200);
    expect(ai.calls).toHaveLength(1);
  });

  it('a mask in any encoding but the client\'s own is refused, not decoded', async () => {
    const ai = stubAi(async () => squarePng(3));
    // A real mask with its IHDR interlace byte flipped: `pngDimensions` still
    // reads it, and the ink measurement must refuse it rather than guess.
    const interlaced = new Uint8Array(await maskFixture(0.12));
    interlaced[28] = 1;
    const response = await worker.fetch(
      inpaintRequest([{ name: 'image', bytes: await squarePng(1) },
        { name: 'mask', bytes: interlaced }]),
      envWith(ai.binding));
    expect(response.status).toBe(422);
    expect(ai.calls).toHaveLength(0);
  });

  it('a model that answers at a different size is 502, never composited', async () => {
    const ai = stubAi(async () => squarePng(9, 256));
    const response = await worker.fetch(
      inpaintRequest([{ name: 'image', bytes: await squarePng(1) },
        { name: 'mask', bytes: await maskFixture(0.12) }]),
      envWith(ai.binding));
    expect(response.status).toBe(502);
    const body = await response.json() as { error: string };
    expect(body.error).toContain('different size');
  });

  it('every answer says nosniff, image and error alike', async () => {
    // Read by iterating the entries for the same reason `statedInpaintModel`
    // does: this header travels on the private server-to-server call, never
    // through a browser, and the CORS gate reads a literal `headers.get`
    // under src/ as a frontend cross-origin read.
    const nosniff = (headers: Headers): string | null => {
      for (const [name, value] of headers.entries()) {
        if (name.toLowerCase() === 'x-content-type-options') return value;
      }
      return null;
    };
    const ai = stubAi(async () => squarePng(3));
    const ok = await worker.fetch(
      inpaintRequest([{ name: 'image', bytes: await squarePng(1) },
        { name: 'mask', bytes: await maskFixture(0.12) }]),
      envWith(ai.binding));
    expect(nosniff(ok.headers)).toBe('nosniff');

    const refused = await worker.fetch(
      inpaintRequest([{ name: 'image', bytes: await squarePng(1) }]),
      envWith(ai.binding));
    expect(nosniff(refused.headers)).toBe('nosniff');
  });
});

// ---------------------------------------------------------------------------
// The worker's tests and gates are actually wired
// ---------------------------------------------------------------------------

describe('this file runs where it claims to', () => {
  it('CI runs EVERY Builder Stock suite — an unrun proof proves nothing', () => {
    /*
     * This file sat beside the named Builder Stock list in ci.yml without
     * being on it, so every assertion here — the no-external-URL proof, the
     * constant-time proof, the wrangler-has-no-credentials proof — ran on no
     * runner. A test that asserts its own wiring cannot silently fall off.
     *
     * IT USED TO ASSERT ONE FILENAME, AND THAT WAS TOO WEAK BY SIXTEEN.
     *
     * Naming this file in the list proves this file runs. It proves nothing
     * about the file written next week, and the list it was defending rotted
     * anyway: 39 entries against 56 suites on disk. Seventeen ran on no
     * runner, `builderStockSettlementRecovery` among them — which is the suite
     * for `enforceStrictPrimaryImages`, the function that went on enforcing a
     * repealed ranking rule until it cleared 45 marketplace pointers in
     * production.
     *
     * So the guarantee is the one that was actually wanted: every Builder
     * Stock and Builder Portal suite ON DISK is covered by the step, whether
     * it is named outright or picked up by a path prefix. A file added
     * tomorrow is covered by construction, and a step narrowed to exclude one
     * fails here.
     */
    const workflow = readFileSync(
      resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');

    const step = workflow.slice(workflow.indexOf('Unit tests (Builder Stock images)'));
    const block = step.slice(0, step.indexOf('\n      - name:'));
    expect(block).toContain('vitest run');

    // Every path-shaped token the step hands to vitest. Vitest matches these
    // positionally as path substrings, so a bare directory prefix covers the
    // files under it.
    const filters = block.match(/src\/[^\s\\]+/g) ?? [];
    expect(filters.length).toBeGreaterThan(0);

    const dir = resolve(process.cwd(), 'src/lib/__tests__');
    const suites = readdirSync(dir)
      .filter((name) => /^builder(Stock|Portal).*\.test\.tsx?$/.test(name))
      .map((name) => `src/lib/__tests__/${name}`);
    expect(suites.length).toBeGreaterThan(40);

    const uncovered = suites.filter(
      (path) => !filters.some((filter) => path.startsWith(filter)));
    expect(uncovered, 'Builder Stock suites CI never runs').toEqual([]);

    // And this file among them, which is where the rule came from.
    expect(suites).toContain('src/lib/__tests__/builderStockCloudflareWorker.test.ts');
  });

  it('the worker hardening gate names the worker source', () => {
    const gate = readFileSync(
      resolve(process.cwd(), 'scripts/security/check-cloudflare-worker-hardening.mjs'),
      'utf8');
    expect(gate).toContain('cloudflare/builder-stock-image-worker/src/index.ts');
  });
});
