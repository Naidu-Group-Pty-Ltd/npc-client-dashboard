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
import { readFileSync } from 'node:fs';
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

  it('exempts only branding assets, which have no owning row', () => {
    const resolver = server.slice(
      server.indexOf('async function resolveHumanUploadBinding'),
      server.indexOf('Deno.serve'),
    );
    // The bucket that returns before the resource check.
    expect(resolver).toMatch(/bucket === 'branding-assets'/);
    expect(resolver.indexOf("bucket === 'branding-assets'"))
      .toBeLessThan(resolver.indexOf("reason: 'resource_required'"));
  });
});

describe('every client-facing upload names its resource', () => {
  const clientFacing = [
    'src/components/clients/ClientSentReportsTab.tsx',
    'src/components/clients/ClientFormaraUpload.tsx',
    'src/components/clients/ClientFormaraForms.tsx',
    'src/components/clients/FormaraPDFGenerator.tsx',
    'src/components/clients/ClientReportsTab.tsx',
    'src/components/clients/PortfolioAnalysisPDFGenerator.tsx',
    'src/components/reports/CashFlowAnalysisModal.tsx',
    'src/components/reports/PixelPerfectPDFGenerator.tsx',
  ];

  it.each(clientFacing)('%s passes a resourceId', (relative) => {
    const source = readFileSync(join(root, relative), 'utf8');
    // Each of these uploads on behalf of a client or a report, so each has an
    // owning row to name. A call without one is refused by the server.
    const uploads = source.match(/secureStorageUpload\([\s\S]{0,400}?\)\s*;/g) ?? [];
    expect(uploads.length).toBeGreaterThan(0);
    for (const call of uploads) {
      expect(call).toMatch(/resourceId:/);
    }
  });
});
