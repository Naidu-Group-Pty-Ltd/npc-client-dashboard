/**
 * Builder stock — asking a model to rebuild what a badge was covering.
 *
 * THE ONLY VISUAL INPUT IS THE BUILDER'S OWN FILE FOR THAT PROPERTY. Not a
 * reference photograph, not another facade, not a rendering of a house, not a
 * search result, not a stock image, not a second example of "what a roof looks
 * like". One image goes into each request — a square cut out of that property's
 * own primary image — with a mask marking the graphic to remove. There is no
 * conditioning image parameter anywhere in this file and there must never be
 * one.
 *
 * AND IT DOES NOT REGENERATE THE PICTURE. The model's answer is used at the
 * mask and discarded everywhere else: `compositePatch` writes only where
 * `blendWeights` is non-zero, and `outsidePermittedRegionUnchanged` then checks
 * the whole frame against the bytes that came out of storage. A response that
 * came back re-lit, re-framed or with a different house on it changes nothing
 * outside the badge, because nothing outside the badge is ever read from it.
 *
 * WHAT THIS FILE MAY REFUSE, and every one of them is recorded rather than
 * swallowed: no credential, an endpoint that errors or times out, a response
 * that is not an image, an image that will not decode, a patch count that says
 * this is a marketing tile rather than a photograph, and a result the gate
 * rejects. In none of those cases does anything else become the card's picture.
 *
 * The call goes through `meteredFetch`, so it is billed to whoever's key it
 * spent. It is a per-image cost paid ONCE — see `sanitizedDerivative.pure.ts`:
 * the answer is frozen in the bucket and the card serves that object for ever.
 */
import { meteredFetch } from '../meteredFetch.ts';
import { decodeFullRaster } from './sourceImageRaster.ts';
import { encodePng } from './rasterPng.ts';
import {
  blendWeights, compositePatch, cropMask, cropRgb, outsidePermittedRegionUnchanged,
  planInpaintPatches, resampleRgb, type Patch,
} from './inpaintOverlay.pure.ts';

/** The endpoint, named here and nowhere else. */
const ENDPOINT = 'https://api.openai.com/v1/images/edits';
/** The model. Recorded on every derivative it produces. */
export const INPAINT_MODEL = 'gpt-image-1';
/** What the endpoint works at, whatever it is sent. */
const EDGE = 1024;
/** One request's ceiling. Four patches must fit inside the worker's budget. */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * The instruction, written once.
 *
 * IT ASKS FOR A RECONSTRUCTION, NOT A PICTURE. Every clause is a constraint:
 * remove the graphic, rebuild only what was behind it, change nothing else,
 * and do not redesign the property. There is no adjective in it, nothing about
 * style, quality, lighting or appeal, and no word that invites the model to
 * improve anything — an "attractive modern home" in this string is how a
 * client comes to be shown a house that was never built.
 *
 * THE CLAUSE ABOUT NOT EXTENDING THE BUILDING IS THERE BECAUSE OF LOT 13
 * HUMMOCK RISE. Its two status pills sit across the top of the frame, half over
 * sky and half over the edge of a timber-clad upper storey, and asked to
 * "reconstruct the background" the model continued the CLADDING across both
 * rectangles — a house a foot wider and a storey taller than the one that was
 * photographed. The gate caught it, as a flat coloured block where a
 * reconstruction should be. Naming what the background is, and naming what it
 * is not, is the narrowest way to ask for the right thing.
 */
export const INPAINT_PROMPT =
  'Remove the overlaid promotional graphic or text and reconstruct only the '
  + 'background that was hidden directly behind the masked area, continuing the '
  + 'surrounding photograph: if sky was behind it, sky; if landscaping, '
  + 'landscaping. Do not extend any building, roof, wall or structure into the '
  + 'masked area. Do not change anything outside the masked area and do not '
  + 'redesign the property.';

export type InpaintResult =
  | {
    ok: true;
    pixels: Uint8Array;
    width: number;
    height: number;
    repairedShare: number;
    regionsRemoved: number;
    model: string;
  }
  | {
    ok: false;
    reason: 'inpaint_unavailable' | 'inpaint_failed' | 'validation_failed'
      | 'nothing_to_remove' | 'too_many_regions' | 'uncoverable';
    detail: string;
  };

export interface InpaintInput {
  width: number;
  height: number;
  /** The builder's own pixels, RGB, at the size they were supplied. */
  pixels: Uint8Array;
  /** The grown overlay mask, at that same size. */
  mask: Uint8Array;
  /** Injected in tests. Production passes nothing and the real endpoint runs. */
  edit?: (image: Uint8Array, mask: Uint8Array) => Promise<Uint8Array | null>;
}

/**
 * Build the mask the endpoint wants.
 *
 * The convention is the opposite of ours: the API rebuilds where the mask is
 * TRANSPARENT and leaves everything opaque alone. So alpha is 0 over the badge
 * and 255 over the photograph. The colour channels are irrelevant to the API
 * and are written as the patch's own pixels rather than as black, so that a
 * mask opened by a human during a debug looks like what it describes.
 */
async function maskPng(
  patchPixels: Uint8Array, patchMask: Uint8Array, size: number,
): Promise<Uint8Array | null> {
  const rgba = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    rgba[i * 4] = patchPixels[i * 3];
    rgba[i * 4 + 1] = patchPixels[i * 3 + 1];
    rgba[i * 4 + 2] = patchPixels[i * 3 + 2];
    rgba[i * 4 + 3] = patchMask[i] ? 0 : 255;
  }
  return await encodePng(rgba, { width: size, height: size, components: 4 });
}

/** One call. Returns the returned image's RGB pixels at `EDGE`, or null. */
async function callEndpoint(
  imagePng: Uint8Array, maskBytes: Uint8Array,
): Promise<{ pixels: Uint8Array } | { error: string }> {
  const key = Deno.env.get('OPENAI_API_KEY');
  if (!key) return { error: 'no credential is configured for image editing' };

  const form = new FormData();
  form.append('model', INPAINT_MODEL);
  form.append('prompt', INPAINT_PROMPT);
  form.append('n', '1');
  form.append('size', `${EDGE}x${EDGE}`);
  form.append('image', new Blob([imagePng as unknown as BlobPart], { type: 'image/png' }),
    'image.png');
  form.append('mask', new Blob([maskBytes as unknown as BlobPart], { type: 'image/png' }),
    'mask.png');

  let response: Response;
  try {
    response = await meteredFetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, {
      feature: 'builder-stock/overlay-inpaint',
      model: INPAINT_MODEL,
      metadata: { purpose: 'marketing_overlay_removal' },
    });
  } catch (error) {
    return { error: `the image editor could not be reached (${String(error).slice(0, 120)})` };
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return { error: `the image editor refused the request (${response.status}) ${body.slice(0, 160)}` };
  }

  let payload: { data?: Array<{ b64_json?: string }> };
  try {
    payload = await response.json();
  } catch {
    return { error: 'the image editor returned something that was not a result' };
  }
  const base64 = payload?.data?.[0]?.b64_json;
  if (typeof base64 !== 'string' || !base64) {
    return { error: 'the image editor returned no image' };
  }

  let bytes: Uint8Array;
  try {
    const binary = atob(base64);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch {
    return { error: 'the returned image could not be read' };
  }
  const raster = await decodeFullRaster(bytes);
  if (!raster) return { error: 'the returned image could not be decoded' };
  // Whatever size came back, the patch is square and so is this.
  const pixels = raster.width === EDGE && raster.height === EDGE
    ? raster.pixels
    : resampleRgb(raster.pixels, raster.width, raster.height, EDGE, EDGE);
  return { pixels };
}

/**
 * Take the graphic off with a model, patch by patch, or say why not.
 *
 * The composite is cumulative across patches — each one is laid onto the result
 * of the last — and the gate runs ONCE at the end against the untouched
 * original, so a fault in any patch fails the whole repair. There is no partial
 * success: a photograph with one of its two badges removed still has marketing
 * on it, and serving it would be the exact defect this replaces.
 */
export async function inpaintOverlay(input: InpaintInput): Promise<InpaintResult> {
  const { width, height, pixels, mask } = input;
  if (width <= 0 || height <= 0 || pixels.length < width * height * 3
    || mask.length !== width * height) {
    return { ok: false, reason: 'validation_failed', detail: 'the image and its mask disagree' };
  }

  const { patches, tooMany, uncovered } = planInpaintPatches(mask, width, height);
  if (uncovered) {
    /*
     * A graphic no square patch can contain without leaving the frame — a
     * banner across the full width of a landscape photograph, say. Refused
     * rather than partly removed: the alternative is a picture with one badge
     * gone and one still on it, handed over as clean.
     */
    return {
      ok: false,
      reason: 'uncoverable',
      detail: 'the graphic cannot be isolated inside the picture without leaving part of it',
    };
  }
  if (tooMany) {
    return {
      ok: false,
      reason: 'too_many_regions',
      detail: 'the picture carries more separate graphics than a photograph with a badge on it',
    };
  }
  if (!patches.length) {
    return { ok: false, reason: 'nothing_to_remove', detail: 'the mask marks nothing' };
  }

  const weights = blendWeights(mask, width, height);
  let masked = 0;
  for (let i = 0; i < mask.length; i++) masked += mask[i];

  let working = pixels;
  for (const patch of patches) {
    const patchPixels = cropRgb(working, width, patch, height);
    const patchMask = cropMask(mask, width, patch, height);

    const upPixels = resampleRgb(patchPixels, patch.size, patch.size, EDGE, EDGE);
    const upMask = new Uint8Array(EDGE * EDGE);
    for (let y = 0; y < EDGE; y++) {
      const sy = Math.min(patch.size - 1, Math.floor(y * patch.size / EDGE));
      for (let x = 0; x < EDGE; x++) {
        const sx = Math.min(patch.size - 1, Math.floor(x * patch.size / EDGE));
        upMask[y * EDGE + x] = patchMask[sy * patch.size + sx];
      }
    }

    let returned: Uint8Array | null = null;
    if (input.edit) {
      returned = await input.edit(upPixels, upMask);
      if (!returned) {
        return { ok: false, reason: 'inpaint_failed', detail: 'the image editor returned nothing' };
      }
    } else {
      const imagePng = await encodePng(upPixels, { width: EDGE, height: EDGE, components: 3 });
      const maskBytes = await maskPng(upPixels, upMask, EDGE);
      if (!imagePng || !maskBytes) {
        return {
          ok: false, reason: 'inpaint_failed', detail: 'the request could not be encoded',
        };
      }
      const answer = await callEndpoint(imagePng, maskBytes);
      if ('error' in answer) {
        return {
          ok: false,
          reason: answer.error.startsWith('no credential')
            ? 'inpaint_unavailable' : 'inpaint_failed',
          detail: answer.error,
        };
      }
      returned = answer.pixels;
    }

    if (returned.length < EDGE * EDGE * 3) {
      return {
        ok: false, reason: 'inpaint_failed', detail: 'the returned patch was the wrong size',
      };
    }
    const down = resampleRgb(returned, EDGE, EDGE, patch.size, patch.size);
    working = compositePatch(working, width, height, patch, down, weights);
  }

  /*
   * THE GATE, against the bytes this began with rather than against the last
   * intermediate. See `outsidePermittedRegionUnchanged`: zero is the only
   * passing answer, and there is no tolerance to relax.
   */
  const gate = outsidePermittedRegionUnchanged(pixels, working, weights);
  if (!gate.ok) {
    return {
      ok: false,
      reason: 'validation_failed',
      detail: `${gate.changed} pixels outside the permitted area were altered`,
    };
  }
  if (working.length !== pixels.length) {
    return { ok: false, reason: 'validation_failed', detail: 'the frame size changed' };
  }

  return {
    ok: true,
    pixels: working,
    width,
    height,
    repairedShare: masked / (width * height),
    regionsRemoved: patches.length,
    model: INPAINT_MODEL,
  };
}
