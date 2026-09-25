/**
 * The address service, asked by the real geocoding chain — run only where a
 * service is standing (`ADDRESS_SERVICE_BASE=https://host/<token>`).
 *
 * `.github/workflows/address-service.yml` runs this twice: against the image
 * it has just built, running inside the CI runner, before anything is pushed;
 * and, on a deploy, against the machine on Fly before any edge function is
 * pointed at it. Both times it is the chain's own `geocodeAddress` — its plan,
 * its matchers, its gates — asked about the addresses this product's owner
 * has reports for, with ONLY the service's two providers configured, so an
 * answer cannot have come from anywhere else. The table it prints is the
 * measurement; the assertions are the floor under it.
 *
 * Everywhere else (`npx vitest run src/lib/geocode` in `ci.yml`) it is skipped:
 * there is no service to ask, and a test that reached the internet from the
 * ordinary suite would make the build depend on somebody else's uptime.
 */
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { geocodeAddress } from '../../../../supabase/functions/_shared/geocode/geocoder.ts';

const BASE = (process.env.ADDRESS_SERVICE_BASE ?? '').replace(/\/+$/, '');

/** Reports this product has written, and two addresses the chain's docs were measured on. */
const SUBJECTS = [
  '1408/5 SECOND AVE, Blacktown NSW 2148',
  '93 Schofields Farm Road (tallawong), Schofields NSW 2762',
  '60 Lawley Street, Spalding WA 6530',
  '9 Hollow Street, Golden Square VIC 3555',
  '97 Poole Road, Kellyville NSW 2155',
  '18 Annabelle Crescent, Kellyville NSW 2155',
  '262 Pallas Street, Maryborough QLD 4650',
  '291 Stone Mason Drive, Kellyville NSW 2155',
  '10 Leakes Road, Truganina VIC 3029',
];

/** An in-memory cache and a limiter that always grants: the service is all that is asked. */
function memoryDb() {
  return {
    from() {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: null, error: null }),
        upsert: async () => ({ error: null }),
      };
      return q;
    },
    rpc: () => Promise.resolve({ data: [{ allowed: true, retry_after_seconds: 0 }], error: null }),
  };
}

describe.skipIf(!BASE)('the address service answers the chain', () => {
  const env = (k: string) => ({
    GEOCODER_GNAF_URL: `${BASE}/gnaf`,
    GEOCODER_PHOTON_URL: `${BASE}/photon`,
  } as Record<string, string>)[k];

  it('places the owner\'s addresses — from the register where it knows them', async () => {
    const rows: string[] = [];
    let fromRegister = 0;
    for (const address of SUBJECTS) {
      const started = Date.now();
      const out = await geocodeAddress(memoryDb(), { address }, {
        env,
        providers: ['gnaf', 'photon'],
        allowLocalityFallback: false,
        feature: 'address-service-proof',
        timeoutMs: 10_000,
      });
      const ms = Date.now() - started;
      if (out.ok === true) {
        const r = out.result;
        // Inside Australia, whoever answered.
        expect(r.lat).toBeLessThan(-9);
        expect(r.lat).toBeGreaterThan(-44);
        expect(r.lng).toBeGreaterThan(112);
        expect(r.lng).toBeLessThan(154);
        if (r.provider === 'gnaf' && r.precision === 'address') fromRegister++;
        rows.push(`| ${address} | ${r.provider} | ${r.precision} | ${r.matchedAddress ?? ''} | ${r.providerPrecision ?? ''} | ${r.lat.toFixed(6)}, ${r.lng.toFixed(6)} | ${ms} ms |`);
      } else {
        rows.push(`| ${address} | — | — | ${out.reason}: ${out.detail.replace(/\|/g, '/')} | | | ${ms} ms |`);
      }
    }
    const table = [
      `### The chain, asked through the address service (${BASE.replace(/\/[^/]+$/, '/…')})`,
      '',
      '| Address | Answered by | Precision | Matched | Register\'s word | Point | Took |',
      '|---|---|---|---|---|---|---:|',
      ...rows,
      '',
    ].join('\n');
    console.log(table);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
    // The floor, not the measurement: established streets the register has
    // held for years must come back from it, at the address itself.
    expect(fromRegister).toBeGreaterThanOrEqual(3);
  }, 180_000);
});
