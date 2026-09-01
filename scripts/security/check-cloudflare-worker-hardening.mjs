#!/usr/bin/env node
/**
 * The Builder Stock Cloudflare worker's request hardening, asserted at source.
 *
 * Every other scanner in this directory roots at `supabase/functions` or
 * `src`, so the one process this repository ships OUTSIDE both trees — the
 * private Workers AI inpainting worker — was covered by none of them, and the
 * vitest file that proves its properties sat beside CI's named test list
 * without being on it. This gate is the worker's own: it reads the source the
 * way `check-storage-upload-hardening.mjs` reads the storage function's, and
 * `check-gates-wired.mjs` forces it into the workflow.
 *
 * The controls asserted, each one a line an innocent refactor could drop:
 *   - authentication runs before the body is ever parsed;
 *   - the declared body length is bounded before `formData()` buffers it;
 *   - the patch is pinned to the transport's own shape (square, bounded);
 *   - the mask's ink share is measured and bounded — the backstop that keeps
 *     a leaked token from being a free-form generator on this account;
 *   - the model's answer must be the size of the question;
 *   - every response says nosniff;
 *   - and no URL literal exists in the file at all: the worker can reach the
 *     AI binding and nothing else.
 */
import { readFileSync } from 'node:fs';

const WORKER = 'cloudflare/builder-stock-image-worker/src/index.ts';
const source = readFileSync(WORKER, 'utf8');
const failures = [];

// Auth precedes parsing: inside the fetch handler, the bearer refusal comes
// before the dispatch into inpaint() — which is where the body is parsed.
// (Definition order in the file is not execution order; the handler's is.)
const authAt = source.indexOf('if (!(await authorised(request, env))) return json(401');
const dispatchAt = source.indexOf('return await inpaint(request, env)');
if (authAt < 0) failures.push('the fail-closed bearer refusal is gone');
if (dispatchAt < 0) failures.push('the inpaint dispatch is gone');
if (authAt >= 0 && dispatchAt >= 0 && authAt > dispatchAt) {
  failures.push('the request is dispatched before the caller is authorised');
}
if (!source.includes('await request.formData()')) {
  failures.push('the multipart parse is gone');
}

for (const [what, needle] of [
  ['the declared-length ceiling', 'MAX_BODY_BYTES'],
  ['the square-patch pin', 'imageDims.width !== imageDims.height'],
  ['the patch edge ceiling', 'MAX_PATCH_EDGE'],
  ['the mask ink measurement', 'maskInkShare(mask)'],
  ['the mask ink ceiling', 'MAX_MASK_INK_SHARE'],
  ['the answer-size equality check', 'resultDims.width !== imageDims.width'],
  ['the nosniff header', "'x-content-type-options': 'nosniff'"],
]) {
  if (!source.includes(needle)) failures.push(`${what} is gone (${needle})`);
}

/*
  The pre-parse length refusal, asserted as a CONTROL rather than as a string.

  This was `source.includes("request.headers.get('content-length')")`, and the
  negative-test harness caught what that really checked: the worker reads that
  header in two places, so replacing the guarding read with `const declared = 0`
  left the substring present, the gate green, and every oversized body buffered
  before anything looked at its size. A gate that passes with its control
  removed is asserting something other than the property it claims.

  What matters is the SEQUENCE — the declared length is taken from the header
  and then compared against the ceiling — so that is what is matched, within a
  short window, so a second unrelated read of the same header cannot satisfy it.
*/
const preParseRefusal =
  /const declared = Number\(\s*request\.headers\.get\('content-length'\)[\s\S]{0,200}?declared > MAX_BODY_BYTES/;
if (!preParseRefusal.test(source)) {
  failures.push(
    'the pre-parse length refusal is gone (the declared content-length must be ' +
      'compared against MAX_BODY_BYTES before the body is buffered)',
  );
}

// The worker names no endpoint: the AI binding is its whole world. Any URL
// literal — vendor API, webhook, fallback — is a new place pixels can go.
if (/https?:\/\//.test(source)) {
  failures.push('the worker source carries a URL literal; it must reach only the AI binding');
}

if (failures.length) {
  console.error(`Cloudflare worker hardening FAILED:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('Cloudflare worker hardening check passed.');
