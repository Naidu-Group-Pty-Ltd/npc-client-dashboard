/**
 * The upload contract between the browser helper and `secure-storage`.
 *
 * Audit items 5, 7 and 8 — "Failed to publish: Invalid upload resource", a
 * client form that vanishes after upload, and files that cannot be uploaded at
 * all — were one fault. `secure-storage` derives the destination path, the
 * owner and the client binding from a server-side authoritative row, so
 * `resolveHumanUploadBinding` requires a `resource_id` from every human caller
 * on every bucket but `branding-assets`, and answers "Invalid upload resource"
 * without one. `secureStorageUpload` never sent the field.
 *
 * Nothing failed loudly enough to notice: `client_files` records 13 uploads in
 * July 2026, 25 in June, and none afterwards.
 *
 * This pins the contract from both ends, because the two drifted apart once
 * and there is no type shared between a browser module and a Deno function to
 * stop it happening again.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..', '..');
const helper = readFileSync(join(root, 'src', 'hooks', 'useSecureStorage.ts'), 'utf8');
const server = readFileSync(
  join(root, 'supabase', 'functions', 'secure-storage', 'index.ts'),
  'utf8',
);

describe('secureStorageUpload', () => {
  it('sends the resource the server binds the upload to', () => {
    expect(helper).toMatch(/resource_id:\s*options\?\.resourceId/);
    expect(helper).toMatch(/resourceId\?: string/);
  });

  it('still matches what the server asks for', () => {
    // If the server stops requiring it, this test should be revisited rather
    // than the field quietly left behind again.
    expect(server).toMatch(/resolveHumanUploadBinding\(supabase, bucket, resource_id, actorId\)/);
    expect(server).toMatch(/reason: 'resource_required'/);
  });

  it('exempts exactly the buckets with no owning row at upload time', () => {
    // Branding has no row at all; a report template's row is written FROM the
    // upload's result, so at upload time there is none to name. Permission
    // stands in for ownership on both. Everything else must name its row.
    expect(exemptBuckets(server)).toEqual(['branding-assets', 'report-templates']);
  });
});

/**
 * The buckets the server lets through before it asks for a resource.
 *
 * Read off the server rather than listed here, so a guard on the browser side
 * cannot exempt a bucket the server still binds — which would let an upload
 * ship that production refuses with "Invalid upload resource", the defect this
 * whole file exists for.
 */
function exemptBuckets(source: string): string[] {
  const resolver = source.slice(
    source.indexOf('async function resolveHumanUploadBinding'),
    source.indexOf('Deno.serve'),
  );
  const required = resolver.indexOf("reason: 'resource_required'");
  return [...resolver.slice(0, required).matchAll(/bucket === '([^']+)'/g)].map((m) => m[1]);
}

/**
 * Found, never listed.
 *
 * This block used to enumerate the eight files that called the helper, and a
 * hand-written list of call sites goes stale in both directions:
 * `ClientReportsTab.tsx` stopped uploading and left its import behind, so the
 * guard failed on a file that has nothing to guard — while a NEW upload added
 * anywhere else would not have been checked at all, which is the failure that
 * matters. The list is now the codebase.
 */
describe('every upload names its resource', () => {
  /** Every `.ts`/`.tsx` under `src/`, excluding this spec's own directory. */
  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        out.push(...sourceFiles(full));
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  /**
   * A call to the helper, from `secureStorageUpload(` to its matching `)`.
   *
   * Counted rather than matched with a bounded regex: the previous
   * `[\s\S]{0,400}?\)\s*;` needed the call to end within 400 characters AND
   * in a semicolon, so an options object one field longer, or a call whose
   * result is `await`ed inside a larger expression, simply disappeared from the
   * guard rather than failing it.
   */
  function uploadCalls(source: string): string[] {
    const calls: string[] = [];
    const needle = 'secureStorageUpload(';
    for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + 1)) {
      let depth = 0;
      for (let i = at + needle.length - 1; i < source.length; i += 1) {
        const c = source[i];
        if (c === '(') depth += 1;
        else if (c === ')') {
          depth -= 1;
          if (depth === 0) {
            calls.push(source.slice(at, i + 1));
            break;
          }
        }
      }
    }
    return calls;
  }

  const exempt = new Set(exemptBuckets(server));

  /** The bucket a call names, when it names one literally. */
  const bucketOf = (call: string): string | null =>
    /secureStorageUpload\(\s*'([^']+)'/.exec(call)?.[1] ?? null;

  const callers = sourceFiles(join(root, 'src'))
    .map((file) => ({ file, calls: uploadCalls(readFileSync(file, 'utf8')) }))
    .filter((entry) => entry.calls.length > 0);

  it('finds the callers rather than trusting a list', () => {
    // If this ever reaches zero the scan has broken, not the codebase.
    expect(callers.length).toBeGreaterThan(0);
  });

  it.each(callers.map((c) => c.file.slice(root.length + 1)))('%s passes a resourceId', (relative) => {
    const entry = callers.find((c) => c.file.endsWith(relative))!;
    for (const call of entry.calls) {
      // A bucket the server binds to a row must name that row; a call without
      // one is refused as "Invalid upload resource". A bucket it cannot be
      // told from the source is treated as binding, which is the safe side.
      const bucket = bucketOf(call);
      if (bucket && exempt.has(bucket)) continue;
      expect(call, `${relative} (${bucket ?? 'bucket not a literal'})`).toMatch(/resourceId:/);
    }
  });
});
