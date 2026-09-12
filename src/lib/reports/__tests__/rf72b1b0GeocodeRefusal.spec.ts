import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RF-7.2B.1B0 — a refusal by the geocoder is not a fact about the address.
 *
 * Measured in production on 2026-09-12: 24 of 24 geocode attempts over 24
 * hours answered `REQUEST_DENIED`, 0 answered `ZERO_RESULTS`, 0 succeeded. So
 * every report generated in that window carried no coordinate, no geography,
 * and therefore no demographics, SEIFA or employment — while the only reason
 * the platform recorded was `address_not_resolved`, whose message reads "the
 * address could not be resolved to a location in Australia".
 *
 * That is the expensive kind of false: it blames the customer's address for
 * this deployment's own credential, and sends whoever reads it to re-check an
 * address that was never wrong. Same class as the faults this repository has
 * already paid for — a read that FAILED is not a row that is ABSENT; a
 * provider configured but in simulator mode reported as no provider at all.
 *
 * `location-intelligence-service` is an edge function whose internals are not
 * importable from here (it calls `serve()` at module scope and `geocodeAddress`
 * is private), so these assert the rules against its source — the same
 * treatment the RF-7.2B.1A.2 call-path tests use, and the reason
 * `check-edge-functions.mjs` exists.
 */
const SERVICE = resolve(
  __dirname,
  '../../../../supabase/functions/location-intelligence-service/index.ts',
);
const src = readFileSync(SERVICE, 'utf8');

/** The body of `geocodeAddress`, from its signature to the next top-level `}`. */
function geocodeAddressBody(): string {
  const start = src.indexOf('async function geocodeAddress(');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

/**
 * The same source with comments removed.
 *
 * Every rule below is about what the code DOES, and this file explains itself
 * at length — `generateMockLocationData` is named in a comment recording what
 * used to be there, and matching that would assert the opposite of the truth.
 */
const codeOnly = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** The `if (…) { … }` block whose head contains `head`, brace-matched. */
function blockContaining(text: string, head: string): string {
  const at = text.indexOf(head);
  expect(at).toBeGreaterThan(-1);
  const open = text.indexOf('{', at);
  expect(open).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(at, i + 1);
    }
  }
  throw new Error(`unbalanced block for ${head}`);
}

describe('RF-7.2B.1B0 — the geocoder says which kind of failure it was', () => {
  it('every exit from geocodeAddress carries a verdict, never a bare null', () => {
    const body = geocodeAddressBody();
    // A bare `return null` is the whole defect: it makes a denied credential
    // and a genuine miss indistinguishable to every caller.
    expect(body).not.toMatch(/return\s+null\s*;/);
    // Five exits: no address, HTTP error, no point, rejected point, success.
    const verdicts = body.match(/return\s*\{\s*ok:\s*(?:true|false)/g) ?? [];
    expect(verdicts.length).toBeGreaterThanOrEqual(5);
  });

  it('declares an outcome type that carries providerRefused', () => {
    expect(src).toMatch(/type GeocodeOutcome[\s\S]{0,200}providerRefused:\s*boolean/);
    expect(src).toContain('Promise<GeocodeOutcome>');
  });

  it('treats ZERO_RESULTS as the ONLY statement about the address', () => {
    expect(src).toContain("const ADDRESS_IS_THE_ANSWER = 'ZERO_RESULTS'");
    // The test that matters: an unrecognised status must count as OURS.
    // `status !== ADDRESS_IS_THE_ANSWER` gives that for free; an allow-list of
    // "our" statuses would not, and would let a new Google status be blamed
    // on the customer's address.
    expect(geocodeAddressBody()).toContain('status !== ADDRESS_IS_THE_ANSWER');
  });

  it('never enumerates the refusal statuses, so a new one is still ours', () => {
    const body = geocodeAddressBody();
    for (const status of [
      'REQUEST_DENIED', 'OVER_QUERY_LIMIT', 'OVER_DAILY_LIMIT', 'INVALID_REQUEST',
    ]) {
      // Naming them in the decision would make the rule an allow-list by the
      // back door. They may appear in prose; they may not appear in code.
      expect(codeOnly(body)).not.toContain(status);
    }
  });

  it('a transport failure and a thrown request are ours', () => {
    const body = geocodeAddressBody();
    // HTTP non-ok
    const http = blockContaining(body, 'if (!response.ok)');
    expect(http).toContain('providerRefused: true');
    // Never reached the provider, or its body could not be read
    const thrown = blockContaining(body, 'catch (error)');
    expect(thrown).toContain('providerRefused: true');
  });

  it('a point we rejected as not-in-Australia is NOT a provider refusal', () => {
    // The provider answered about this address; we declined the answer. That
    // is ours to explain but it is not a service fault, and calling it one
    // would send an operator to the Google console over a bad address.
    //
    // Brace-matched rather than measured in bytes: a window test fails when a
    // comment above the return grows, which says nothing about whether the
    // code is right.
    const branch = blockContaining(geocodeAddressBody(), 'if (!verdict.ok)');
    expect(branch).toContain('providerRefused: false');
    expect(branch).not.toContain('providerRefused: true');
  });

  it('an empty address is not a provider refusal either', () => {
    const branch = blockContaining(geocodeAddressBody(), 'if (!address)');
    expect(branch).toContain('providerRefused: false');
    expect(branch).not.toContain('providerRefused: true');
  });
});

describe('RF-7.2B.1B0 — the reason reaches the caller', () => {
  it('the vocabulary carries geocoder_unavailable', () => {
    expect(src).toMatch(/type UnresolvedReason[\s\S]{0,200}'geocoder_unavailable'/);
    expect(src).toMatch(/UNRESOLVED_MESSAGE[\s\S]{0,600}geocoder_unavailable:/);
  });

  it('maps providerRefused onto it, and nothing else onto it', () => {
    // Asserted on the ASSIGNMENT rather than on a byte window. The window was
    // 400 characters from `coordinates = geocoded.ok`, which RF-7.2B.1B1 pushed
    // the mapping out of by adding one line above it — a failure that says
    // nothing about whether the mapping is right. The statement itself is the
    // rule: which of the two reasons is chosen, decided from the provider's own
    // refusal flag and from nothing else.
    const assignment = src.match(/reason\s*=\s*geocoded\.ok[\s\S]*?;/)?.[0] ?? '';
    expect(assignment).toBeTruthy();
    expect(assignment).toContain('geocoded.providerRefused');
    expect(assignment).toContain("'geocoder_unavailable'");
    expect(assignment).toContain("'address_not_resolved'");
    // A refused provider is the ONLY route to `geocoder_unavailable`.
    expect(assignment).toMatch(/!geocoded\.providerRefused[\s\S]*'address_not_resolved'[\s\S]*'geocoder_unavailable'/);
  });

  it('its message says the fault is ours and clears the address', () => {
    const at = src.indexOf('geocoder_unavailable:');
    expect(at).toBeGreaterThan(-1);
    const message = src.slice(at, src.indexOf('\n  supplied_coordinates_rejected:', at));
    // It must not repeat the claim that was false.
    expect(message).not.toContain('The address could not be resolved');
    // It must say whose fault it is, and say the address was not rejected.
    expect(message).toMatch(/map service access/);
    expect(message).toMatch(/never rejected as invalid/);
  });

  it('leaves the genuine address reading exactly as it was', () => {
    // A widening that quietly reworded the true case would be a second change
    // hiding inside this one.
    expect(src).toContain(
      "'The address could not be resolved to a location in Australia — "
      + "location intelligence is unavailable for this property.'",
    );
    expect(src).toContain(
      "'The supplied coordinates are not a location in Australia — "
      + "location intelligence is unavailable for this property.'",
    );
  });

  it('still refuses to invent a location, whichever reason it was', () => {
    // The whole point of the unresolved branch. `generateMockLocationData` is
    // gone and must stay gone: a reason code is an explanation, never a
    // licence to answer with sample data. It survives as PROSE — a comment
    // recording what used to be here — so the assertion is against code
    // alone, or it would fail on the very note that says the thing is gone.
    expect(codeOnly(src)).not.toContain('generateMockLocationData');
    expect(src).toContain('generateMockLocationData');
    expect(src).toMatch(/success:\s*false,\s*\n\s*resolved:\s*false/);
  });
});
