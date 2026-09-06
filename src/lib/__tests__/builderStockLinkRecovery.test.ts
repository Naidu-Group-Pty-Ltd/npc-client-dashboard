/**
 * BUILDER STOCK — GOOGLE SHEETS HYPERLINK RECOVERY THROUGH MAKE.
 *
 * A Google Sheet whose owner has not enabled file export answers `/export`
 * with a sign-in page, and `/export` is the only public representation that
 * carries a cell's link target. Measured against a live document: `/export`
 * (xlsx and csv) and `/pubhtml` all 401, while `gviz` in every output mode
 * returns the cell TEXT with zero anchors and zero file ids. The brochure
 * address never reaches this product, so stage 1 has nothing to open.
 *
 * The recovery is performed by a Make scenario holding its own authorised
 * Google connection. That makes the callback an inbound write path deciding
 * what a client sees on a property card, and these tests are mostly about the
 * three properties that keep it safe:
 *
 *   THE CALLER CANNOT NAME ITS OWN AUTHORITY — organisation, upload and
 *   property come from the row this product wrote when it asked.
 *
 *   A ROW IS MATCHED BY WHAT IT IS — never by position, order or count.
 *
 *   IT FAILS CLOSED — every refusal writes nothing.
 *
 * Written on invented data. No spreadsheet, estate, lot, builder, secret or
 * URL here belongs to any deployment.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import {
  AUTHENTICATED_REFUSALS, CALLBACK_TOKEN_BYTES, MAX_CALLBACK_BYTES,
  MAX_WORKBOOK_BYTES, RECOVERABLE_AVAILABILITY, RECOVERABLE_AVAILABILITY_LEGACY,
  RECOVERY_REQUEST_TTL_MINUTES, callbackRefusal, constantTimeEquals, decodeWorkbook,
  isRecoverableStoredAvailability, mergeRecoveredLink,
  outboundRecoveryPayload, projectUploadListRow, recoveredRowsFromWorksheet,
  shouldRequestLinkRecovery,
} from '../../../supabase/functions/_shared/builderStock/linkRecovery.pure';
import {
  alignWorksheetRows, hyperlinkTargetOf, locateHeaderRow, matchWorksheet,
  mergeHyperlinkColumns, worksheetScore,
} from '../../../supabase/functions/_shared/builderStock/sheetHyperlinks.pure';
import {
  GridTooLargeError, MAX_GRID_CELLS, gridToWorkbookSheets,
} from '../../../supabase/functions/_shared/builderStock/sheetGrid.pure';
import { rowSourceBranches } from '../../../supabase/functions/_shared/builderStock/sourceBranches.pure';

/** The same construction both sides of the token use. */
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const TOKEN = 'a'.repeat(64);
const TOKEN_HASH = sha256(TOKEN);

const OK = {
  importSucceeded: true,
  availability: 'unavailable_source_export' as const,
  spreadsheetId: 'sheet-abc',
  webhookConfigured: true,
};

// ── Trigger ────────────────────────────────────────────────────────────────

describe('the one condition worth asking about', () => {
  it('asks when all four hold', () => {
    expect(shouldRequestLinkRecovery(OK)).toBe(true);
  });

  it('never asks for a reading that already has the links', () => {
    for (const availability of ['resolved', 'none_present'] as const) {
      expect(shouldRequestLinkRecovery({ ...OK, availability })).toBe(false);
    }
  });

  it('never asks where the workbook DID arrive — a re-read learns nothing', () => {
    for (const availability of ['unavailable_workbook_unreadable',
      'unavailable_no_worksheet_match', 'unavailable_ambiguous_worksheet'] as const) {
      expect(shouldRequestLinkRecovery({ ...OK, availability })).toBe(false);
    }
  });

  it('never asks for a source that is not a Google Sheet', () => {
    // CSV, XLSX, Notion and an ordinary URL all parse to no spreadsheet id.
    for (const spreadsheetId of [null, undefined, '', '   ']) {
      expect(shouldRequestLinkRecovery({ ...OK, spreadsheetId })).toBe(false);
    }
  });

  it('asks for EVERY organisation — there is no tenant gate', () => {
    /*
     * A sheet whose link targets cannot be read is the same defect whoever
     * uploaded it. Gating the fix per tenant means every builder nobody
     * remembered to enable goes on silently losing its brochures, so the only
     * things that narrow this are the conditions above and the rate limiting.
     */
    expect(shouldRequestLinkRecovery({ ...OK })).toBe(true);
    // No property of the input names an organisation, a tenant or a flag.
    for (const key of Object.keys(OK)) {
      expect(key).not.toMatch(/organisation|tenant|allow|enabled|flag/i);
    }
  });

  it('no allowlist, feature flag or hardcoded organisation survives anywhere', () => {
    for (const file of [
      'supabase/functions/_shared/builderStock/linkRecovery.pure.ts',
      'supabase/functions/_shared/builderStock/requestLinkRecovery.ts',
      'supabase/functions/builder-portal-stock/index.ts',
      'supabase/functions/builder-stock-link-callback/index.ts',
      'supabase/migrations/20261030000000_builder_stock_link_recovery.sql',
    ]) {
      const source = readFileSync(file, 'utf8');
      for (const gone of [
        'builder_stock_link_recovery_orgs',
        'linkRecoveryEnabledFor',
        'organisationEnabled',
      ]) {
        expect(`${file}: ${source.includes(gone)}`).toBe(`${file}: false`);
      }
      // And no production organisation may be named in code either.
      expect(source).not.toMatch(/kopi\s*jantan/i);
    }
  });

  it('never asks when no webhook is configured', () => {
    expect(shouldRequestLinkRecovery({ ...OK, webhookConfigured: false })).toBe(false);
  });

  it('never asks when the import itself did not succeed', () => {
    expect(shouldRequestLinkRecovery({ ...OK, importSucceeded: false })).toBe(false);
  });

  it('the availability it keys on is a single named constant', () => {
    expect(RECOVERABLE_AVAILABILITY).toBe('unavailable_source_export');
  });
});

// ── Outbound ───────────────────────────────────────────────────────────────

describe('what leaves this product', () => {
  const request = {
    id: 'req-1', organisation_id: 'org-secret', upload_id: 'upload-secret',
    spreadsheet_id: 'sheet-abc', gid: '0',
    expires_at: new Date().toISOString(), callback_token_hash: TOKEN_HASH,
  };

  it('is four fields and nothing else', () => {
    expect(outboundRecoveryPayload(request, TOKEN)).toEqual({
      request_id: 'req-1', spreadsheet_id: 'sheet-abc', gid: '0',
      callback_token: TOKEN,
    });
  });

  it('carries no organisation, upload, property or customer data', () => {
    const serialised = JSON.stringify(outboundRecoveryPayload(request, TOKEN));
    for (const secret of ['org-secret', 'upload-secret', 'organisation', 'upload_id']) {
      expect(serialised).not.toContain(secret);
    }
  });

  it('sends the token itself and NEVER the stored hash', () => {
    const serialised = JSON.stringify(outboundRecoveryPayload(request, TOKEN));
    expect(serialised).toContain(TOKEN);
    expect(serialised).not.toContain('callback_token_hash');
    // Belt and braces: the hash of a different value must not appear either.
    expect(serialised).not.toContain(sha256('anything-else'));
  });

  it('a sheet-wide link with no tab still sends an explicit null', () => {
    expect(outboundRecoveryPayload({ ...request, gid: null }, TOKEN).gid).toBeNull();
  });

  it('the dispatch can never fail the import', () => {
    const source = readFileSync(
      'supabase/functions/_shared/builderStock/requestLinkRecovery.ts', 'utf8');
    // Every path returns an outcome; nothing propagates.
    expect(source).not.toMatch(/^\s*throw /m);
    // And it does not read the webhook's body, which is neither trusted nor needed.
    expect(source).not.toMatch(/response\.(json|text)\(\)/);
  });

  it('logs an outcome and never a secret, a URL or a document id', () => {
    const source = readFileSync(
      'supabase/functions/_shared/builderStock/requestLinkRecovery.ts', 'utf8');
    const logged = source.slice(source.indexOf('console.info('));
    expect(logged).toContain('request_id');
    for (const forbidden of ['spreadsheet_id', 'webhook', 'secret', 'token']) {
      expect(logged.slice(0, 400)).not.toContain(forbidden);
    }
  });
});

// ── Callback authority ─────────────────────────────────────────────────────

describe('the callback cannot name its own authority', () => {
  const now = Date.parse('2026-08-30T12:00:00Z');
  const request = {
    id: 'req-1', organisation_id: 'org-a', upload_id: 'upload-a',
    spreadsheet_id: 'sheet-abc', gid: '0',
    expires_at: new Date(now + 60_000).toISOString(), consumed_at: null,
    callback_token_hash: TOKEN_HASH,
  };
  const body = {
    request_id: 'req-1', spreadsheet_id: 'sheet-abc', gid: '0',
    workbook_base64: 'UEsDBBQAAAAIAA==',
  };

  it('accepts a well-formed, bound, unconsumed, unexpired, authorised request', () => {
    expect(callbackRefusal(request, body, now, TOKEN_HASH)).toBeNull();
  });

  it('refuses an unknown request id', () => {
    expect(callbackRefusal(null, body, now, TOKEN_HASH))
      .toEqual({ code: 'unknown_request', status: 404 });
  });

  it('refuses a replay of a consumed request', () => {
    expect(callbackRefusal(
      { ...request, consumed_at: '2026-08-30T11:59:00Z' }, body, now, TOKEN_HASH))
      .toEqual({ code: 'request_already_consumed', status: 409 });
  });

  it('refuses an expired request', () => {
    expect(callbackRefusal(
      { ...request, expires_at: new Date(now - 1).toISOString() }, body, now, TOKEN_HASH))
      .toEqual({ code: 'request_expired', status: 409 });
  });

  it('refuses a document that is not the one we asked about', () => {
    expect(callbackRefusal(
      request, { ...body, spreadsheet_id: 'sheet-other' }, now, TOKEN_HASH))
      .toEqual({ code: 'spreadsheet_mismatch', status: 409 });
  });

  it('refuses a TAB that is not the one we asked about', () => {
    expect(callbackRefusal(request, { ...body, gid: '7' }, now, TOKEN_HASH))
      .toEqual({ code: 'gid_mismatch', status: 409 });
  });

  it('treats absent, null and empty gid as the same statement', () => {
    const sheetWide = { ...request, gid: null };
    for (const gid of [null, undefined, '']) {
      expect(callbackRefusal(sheetWide, { ...body, gid }, now, TOKEN_HASH)).toBeNull();
    }
    // ...and a numeric gid is the same tab as its digits, either way round.
    expect(callbackRefusal(request, { ...body, gid: 0 }, now, TOKEN_HASH)).toBeNull();
    expect(callbackRefusal({ ...request, gid: '0' }, { ...body, gid: '0' }, now, TOKEN_HASH))
      .toBeNull();
  });

  it('refuses a malformed payload before looking anything up', () => {
    for (const bad of [{}, { request_id: 'req-1' }, { spreadsheet_id: 'sheet-abc' },
      { request_id: 'req-1', spreadsheet_id: 'sheet-abc' },
      { request_id: 'req-1', spreadsheet_id: 'sheet-abc', workbook_base64: '' },
      { request_id: 'req-1', spreadsheet_id: 'sheet-abc', workbook_base64: 42 }]) {
      expect(callbackRefusal(request, bad as never, now, TOKEN_HASH)?.code)
        .toBe('malformed_payload');
    }
  });

  it('a body naming another organisation changes nothing — it is never read', () => {
    const hostile = {
      ...body,
      organisation_id: 'org-b', upload_id: 'upload-b', property_id: 'prop-b',
    };
    expect(callbackRefusal(request, hostile, now, TOKEN_HASH)).toBeNull();
    // The refusal check passes, and the function reads authority from the row:
    const callback = readFileSync(
      'supabase/functions/builder-stock-link-callback/index.ts', 'utf8');
    expect(callback).toContain('authority.organisation_id');
    expect(callback).toContain('authority.upload_id');
    expect(callback).not.toMatch(/body\.(organisation_id|upload_id|property_id)/);
  });

  it('the request window is thirty minutes', () => {
    expect(RECOVERY_REQUEST_TTL_MINUTES).toBe(30);
  });
});

// ── The one-time capability token ──────────────────────────────────────────

describe('authorisation is a per-request capability, not a shared secret', () => {
  const now = Date.parse('2026-08-30T12:00:00Z');
  const request = {
    id: 'req-1', organisation_id: 'org-a', upload_id: 'upload-a',
    spreadsheet_id: 'sheet-abc', gid: '0',
    expires_at: new Date(now + 60_000).toISOString(), consumed_at: null,
    callback_token_hash: TOKEN_HASH,
  };
  const body = {
    request_id: 'req-1', spreadsheet_id: 'sheet-abc', gid: '0',
    workbook_base64: 'UEsDBBQAAAAIAA==',
  };

  it('accepts the token minted for this request', () => {
    expect(callbackRefusal(request, body, now, sha256(TOKEN))).toBeNull();
  });

  it('refuses a wrong token', () => {
    expect(callbackRefusal(request, body, now, sha256('not-the-token')))
      .toEqual({ code: 'invalid_token', status: 401 });
  });

  it('refuses a missing token, and says so distinctly from a wrong one', () => {
    expect(callbackRefusal(request, body, now, null))
      .toEqual({ code: 'missing_token', status: 401 });
  });

  it('refuses a token that belongs to a DIFFERENT request', () => {
    const other = sha256('b'.repeat(64));
    expect(callbackRefusal(request, body, now, other)?.code).toBe('invalid_token');
  });

  it('refuses when the row carries no hash at all, rather than letting it through', () => {
    expect(callbackRefusal(
      { ...request, callback_token_hash: '' }, body, now, sha256(''))?.code)
      .toBe('invalid_token');
  });

  it('checks the token BEFORE the binding, so a wrong token never reveals the binding', () => {
    // Wrong token AND wrong document: the token failure is what is reported.
    expect(callbackRefusal(
      request, { ...body, spreadsheet_id: 'sheet-other' }, now, sha256('wrong'))?.code)
      .toBe('invalid_token');
  });

  it('checks existence, use and expiry before the token — those reveal nothing', () => {
    expect(callbackRefusal(null, body, now, null)?.code).toBe('unknown_request');
    expect(callbackRefusal(
      { ...request, consumed_at: 'x' }, body, now, null)?.code)
      .toBe('request_already_consumed');
  });

  it('only an AUTHENTICATED refusal may cause a write', () => {
    // A caller that has not proven possession must not be able to make this
    // product write, even a diagnostic status.
    for (const unauthenticated of ['malformed_payload', 'unknown_request',
      'request_already_consumed', 'request_expired', 'missing_token', 'invalid_token']) {
      expect(AUTHENTICATED_REFUSALS.has(unauthenticated)).toBe(false);
    }
    for (const authenticated of ['spreadsheet_mismatch', 'gid_mismatch']) {
      expect(AUTHENTICATED_REFUSALS.has(authenticated)).toBe(true);
    }
  });

  it('compares in constant time and never short-circuits on content', () => {
    expect(constantTimeEquals(TOKEN_HASH, TOKEN_HASH)).toBe(true);
    expect(constantTimeEquals(TOKEN_HASH, sha256('other'))).toBe(false);
    expect(constantTimeEquals('abc', 'abcd')).toBe(false);
  });

  it('carries 256 bits of randomness, minted from the platform CSPRNG', () => {
    expect(CALLBACK_TOKEN_BYTES).toBe(32);
    const source = readFileSync(
      'supabase/functions/_shared/builderStock/requestLinkRecovery.ts', 'utf8');
    expect(source).toContain('crypto.getRandomValues');
    // Nothing about the request may feed the token — that would be guessable.
    const mint = source.slice(source.indexOf('export function mintCallbackToken'));
    for (const derived of ['request', 'organisation', 'Date.now', 'upload']) {
      expect(mint.slice(0, 400)).not.toContain(derived);
    }
  });

  it('stores only the hash, and never the token', () => {
    const source = readFileSync(
      'supabase/functions/_shared/builderStock/requestLinkRecovery.ts', 'utf8');
    const from = source.indexOf('.insert({');
    const insert = source.slice(from, source.indexOf('.select(', from));
    expect(insert).toContain('callback_token_hash: callbackTokenHash');
    expect(insert).not.toMatch(/callback_token:/);
  });

  it('the database refuses to hold anything but a sha256 digest', () => {
    const migration = readFileSync(
      'supabase/migrations/20261030000000_builder_stock_link_recovery.sql', 'utf8');
    expect(migration).toContain('callback_token_hash text NOT NULL');
    expect(migration).toContain("CHECK (callback_token_hash ~ '^[0-9a-f]{64}$')");
  });

  it('the callback reads a Bearer token and hashes it before comparing', () => {
    const callback = readFileSync(
      'supabase/functions/builder-stock-link-callback/index.ts', 'utf8');
    expect(callback).toContain("bearerToken(req.headers.get('authorization'))");
    expect(callback).toContain('await sha256Hex(presented)');
    // The plaintext must never meet a stored value.
    expect(callback).not.toMatch(/callback_token_hash\s*===\s*presented\b/);
  });

  it('bounds the body before it reads or parses anything', () => {
    const callback = readFileSync(
      'supabase/functions/builder-stock-link-callback/index.ts', 'utf8');
    const bound = callback.indexOf('enforceRawBodyLimit');
    const parse = callback.indexOf('JSON.parse');
    const lookup = callback.indexOf('.from(REQUEST_TABLE)');
    expect(bound).toBeGreaterThan(0);
    expect(bound).toBeLessThan(parse);
    expect(parse).toBeLessThan(lookup);
    expect(MAX_CALLBACK_BYTES).toBe(5 * 1024 * 1024);
  });

  it('claims the request atomically, so only one concurrent callback proceeds', () => {
    const callback = readFileSync(
      'supabase/functions/builder-stock-link-callback/index.ts', 'utf8');
    // A conditional UPDATE ... WHERE consumed_at IS NULL is the claim: the
    // database, not this code, decides which of two racing callers wins.
    expect(callback).toMatch(/\.update\(\{\s*consumed_at:[\s\S]{0,200}?\.is\('consumed_at', null\)/);
    expect(callback).toContain('request_already_consumed');
    // And the claim happens before any property is touched.
    const claim = callback.indexOf("is('consumed_at', null)\n    .select('id')");
    const mutate = callback.indexOf('applyRecoveredLinks(supabase');
    expect(callback.indexOf('consumed_at: new Date')).toBeLessThan(mutate);
    expect(claim === -1 || claim < mutate).toBe(true);
  });

  it('rate limits on recovered authority, after the token is proven', () => {
    const callback = readFileSync(
      'supabase/functions/builder-stock-link-callback/index.ts', 'utf8');
    const token = callback.indexOf('callbackRefusal(');
    const limit = callback.indexOf('consumeRateLimit(');
    expect(token).toBeGreaterThan(0);
    expect(token).toBeLessThan(limit);
    expect(callback).toContain('bs:link-recovery:${authority.organisation_id}');
  });
});

// ── The workbook ───────────────────────────────────────────────────────────

/** One worksheet as the shared reader hands it over. */
const worksheet = (name: string, rows: Array<[string, string, string | null]>) => ({
  name,
  values: [
    ['Lot #', 'Estate', 'Brochure V002'],
    ...rows.map(([lot, estate]) => [lot, estate, 'Brochure']),
  ] as (string | null)[][],
  links: [
    [null, null, null],
    ...rows.map(([, , link]) => [null, null, link]),
  ] as (string | null)[][],
});

const STOCK = worksheet('Stock', [
  ['605', 'Sample Rise', 'https://example.invalid/b-605.pdf'],
  ['606', 'Sample Rise', 'https://example.invalid/b-606.pdf'],
]);

describe('the workbook is decoded before anything is believed', () => {
  const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

  it('decodes a workbook the callback can read', () => {
    const out = decodeWorkbook(b64('PK\u0003\u0004 not really a zip'));
    expect(out.ok).toBe(true);
  });

  it('refuses an oversized workbook by ARITHMETIC, before allocating it', () => {
    // Four base64 characters per three bytes, so this describes a decoded
    // length past the cap without ever building one.
    const oversized = 'A'.repeat(Math.ceil(((MAX_WORKBOOK_BYTES + 1024) * 4) / 3));
    const out = decodeWorkbook(oversized);
    expect(out).toEqual({ ok: false, reason: 'too_large' });
  });

  it('refuses something that is not base64 at all', () => {
    expect(decodeWorkbook('').ok).toBe(false);
    expect(decodeWorkbook('%%%%').ok).toBe(false);
  });

  it('the decoded cap is well inside the body cap, because base64 inflates', () => {
    expect(MAX_WORKBOOK_BYTES).toBeLessThan(MAX_CALLBACK_BYTES);
  });
});

describe('the worksheet is chosen by content, never by position', () => {
  const csv = [
    ['Lot #', 'Estate', 'Brochure V002'],
    ['605', 'Sample Rise', 'Brochure'],
    ['606', 'Sample Rise', 'Brochure'],
  ];

  const decoy = worksheet('Summary', [
    ['Status', 'Count', null],
    ['Available', '12', null],
  ]);

  it('takes the matching tab wherever it sits in the workbook', () => {
    const first = matchWorksheet(csv, [STOCK, decoy]);
    const last = matchWorksheet(csv, [decoy, STOCK]);
    expect(first.ok && first.sheet.name).toBe('Stock');
    expect(last.ok && last.sheet.name).toBe('Stock');
  });

  it('refuses when NO worksheet is decisively this tab', () => {
    const out = matchWorksheet(csv, [decoy]);
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toBe('no_match');
  });

  it('refuses when two worksheets are equally like it', () => {
    const twin = { ...STOCK, name: 'Stock (copy)' };
    const out = matchWorksheet(csv, [STOCK, twin]);
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toBe('ambiguous');
  });

  it('an empty workbook decides nothing rather than something', () => {
    expect(matchWorksheet(csv, []).ok).toBe(false);
  });
});

describe('a worksheet becomes headed rows, and a link stays on its own row', () => {
  it('reads each row with its own heading and its own target', () => {
    const rows = recoveredRowsFromWorksheet(STOCK);
    expect(rows).toHaveLength(2);
    expect(rows[0].values['Lot #']).toBe('605');
    expect(rows[0].links['Brochure V002']).toBe('https://example.invalid/b-605.pdf');
    expect(rows[1].values['Lot #']).toBe('606');
    expect(rows[1].links['Brochure V002']).toBe('https://example.invalid/b-606.pdf');
  });

  it('never lets one row\u2019s link reach another row', () => {
    const rows = recoveredRowsFromWorksheet(STOCK);
    expect(rows[0].links['Brochure V002']).not.toBe(rows[1].links['Brochure V002']);
  });

  it('carries several document columns independently on one row', () => {
    const many = {
      name: 'Stock',
      values: [
        ['Lot #', 'Brochure V002', 'Siting / Masterplan', 'Rental Appraisal'],
        ['605', 'Brochure', 'Masterplan', 'N/A'],
      ] as (string | null)[][],
      links: [
        [null, null, null, null],
        [null, 'https://example.invalid/b.pdf', 'https://example.invalid/m.pdf', null],
      ] as (string | null)[][],
    };
    const rows = recoveredRowsFromWorksheet(many);
    expect(Object.keys(rows[0].links).sort())
      .toEqual(['Brochure V002', 'Siting / Masterplan']);
    // A label with no link is not a link, and must not become one.
    expect(rows[0].links['Rental Appraisal']).toBeUndefined();
    expect(rows[0].values['Rental Appraisal']).toBe('N/A');
  });

  it('keeps only http(s) targets', () => {
    const odd = {
      name: 'Stock',
      values: [['Lot #', 'Brochure V002'], ['605', 'Brochure']] as (string | null)[][],
      links: [[null, null], [null, 'mailto:sales@example.invalid']] as (string | null)[][],
    };
    expect(recoveredRowsFromWorksheet(odd)[0].links['Brochure V002']).toBeUndefined();
  });

  it('an empty or headerless worksheet recovers nothing and does not throw', () => {
    expect(recoveredRowsFromWorksheet(undefined)).toEqual([]);
    expect(recoveredRowsFromWorksheet({ values: [], links: [] })).toEqual([]);
    expect(recoveredRowsFromWorksheet({ values: [['Lot #']], links: [[null]] })).toEqual([]);
  });
});

describe('both ways a builder can write a link survive', () => {
  it('an ordinary Excel link relationship', () => {
    expect(hyperlinkTargetOf({ link: 'https://example.invalid/b.pdf', formula: null }))
      .toBe('https://example.invalid/b.pdf');
  });

  it('a HYPERLINK formula, which carries no relationship at all', () => {
    expect(hyperlinkTargetOf({
      link: null, formula: 'HYPERLINK("https://example.invalid/f.pdf","Brochure")',
    })).toBe('https://example.invalid/f.pdf');
  });

  it('and plain text carries neither', () => {
    expect(hyperlinkTargetOf({ link: null, formula: null })).toBeNull();
    expect(hyperlinkTargetOf({ link: null, formula: 'CONCAT(A1," ")' })).toBeNull();
  });
});

describe('a recovered link enters the row the existing pipeline already reads', () => {
  const URL_A = 'https://example.invalid/b-605.pdf';

  it('keeps the display text and adds the address beside it', () => {
    expect(mergeRecoveredLink('Brochure', URL_A)).toBe(`Brochure ${URL_A}`);
  });

  it('an empty cell becomes the address alone', () => {
    expect(mergeRecoveredLink(null, URL_A)).toBe(URL_A);
    expect(mergeRecoveredLink('   ', URL_A)).toBe(URL_A);
  });

  it('a duplicate callback changes nothing', () => {
    // Idempotence is what makes a retried Make run harmless.
    expect(mergeRecoveredLink(`Brochure ${URL_A}`, URL_A)).toBeNull();
    expect(mergeRecoveredLink(URL_A, URL_A)).toBeNull();
  });

  it('refuses anything that is not a document this pipeline can open', () => {
    for (const bad of ['', '   ', 'file:///c:/b.pdf', 'mailto:a@example.invalid',
      '#Sheet1!A1', 'javascript:alert(1)']) {
      expect(mergeRecoveredLink('Brochure', bad)).toBeNull();
    }
  });

  it('and `rowSourceBranches` discovers it with no stage 1 change at all', () => {
    // The whole reason for storing it this way.
    const merged = mergeRecoveredLink('Brochure', URL_A)!;
    const branches = rowSourceBranches({ 'Brochure V002': merged });
    expect(branches).toHaveLength(1);
    expect(branches[0].url).toBe(URL_A);
    // The original heading travels as provenance, unchanged.
    expect(branches[0].column).toBe('Brochure V002');
  });

  it('two headings on one row stay two independent branches', () => {
    const branches = rowSourceBranches({
      'Brochure V002': mergeRecoveredLink('Brochure', URL_A)!,
      'Estate Brochure': mergeRecoveredLink('Estate Brochure',
        'https://example.invalid/estate.pdf')!,
    });
    expect(branches.map((b) => b.column).sort())
      .toEqual(['Brochure V002', 'Estate Brochure']);
  });
});

// ── Matching and reopening ─────────────────────────────────────────────────

describe('a row is matched by what it is, never by where it sits', () => {
  const callback = readFileSync(
    'supabase/functions/builder-stock-link-callback/index.ts', 'utf8');

  it('uses the same normalisation and identity the import used', () => {
    expect(callback).toContain('normaliseStockRow');
    expect(callback).toContain('stockPropertyIdentity');
    expect(callback).toContain('identityDifferences');
  });

  it('applies only on exactly one match, and discards zero or several', () => {
    expect(callback).toMatch(/matches\.length !== 1/);
  });

  it('never consults a row index, offset or count alignment', () => {
    const body = callback.slice(callback.indexOf('async function applyRecoveredLinks'));
    for (const forbidden of ['rowIndex', 'row_index', 'rows[index]', '.length ===  rows']) {
      expect(body).not.toContain(forbidden);
    }
  });

  it('reads only the stored upload\u2019s properties, scoped by the stored organisation', () => {
    expect(callback).toMatch(/\.eq\('organisation_id', authority\.organisation_id\)/);
    expect(callback).toMatch(/authority\.upload_id/);
  });

  it('reopens only properties that gained a link and hold no stage 1 image', () => {
    expect(callback).toMatch(/if \(!target\.primary_image_id\) reopen\.push/);
    expect(callback).toMatch(/\.in\('id', reopen\)/);
  });

  it('never bumps the deployment-wide ladder generation', () => {
    expect(callback).not.toContain('image_ladder_generation_at');
    expect(callback).not.toContain('reopen_builder_stock_stranded_items');
  });

  it('decides nothing about an image', () => {
    for (const untouched of ['imagePriority', 'sanitizeImage', 'chooseCardImage',
      'streetViewHeading', 'webImageIdentity', 'marketplaceEligibility']) {
      expect(callback).not.toContain(untouched);
    }
  });
});

// ── Scope ──────────────────────────────────────────────────────────────────

describe('nothing here names a deployment', () => {
  it('carries no spreadsheet, organisation, secret or live URL', () => {
    for (const file of [
      'supabase/functions/_shared/builderStock/linkRecovery.pure.ts',
      'supabase/functions/_shared/builderStock/requestLinkRecovery.ts',
      'supabase/functions/builder-stock-link-callback/index.ts',
      'supabase/migrations/20261030000000_builder_stock_link_recovery.sql',
    ]) {
      const source = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*(\/\/|--).*$/gm, ' ');
      expect(source).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
      /*
       * A LITERAL DOCUMENT, not the vendor's host. The callback builds a
       * spreadsheet URL from the id on the stored request row, which is the
       * whole point — the host has to appear somewhere. What must never appear
       * is a document id written into the source, so this matches an id after
       * `/d/` and lets an interpolated one through.
       */
      expect(source).not.toMatch(/spreadsheets\/d\/[A-Za-z0-9_-]{10,}/);
      expect(source).not.toMatch(/1bPh8W|npcservices/i);
    }
  });

  it('the webhook URL is read from the environment and never written down', () => {
    const source = readFileSync(
      'supabase/functions/_shared/builderStock/requestLinkRecovery.ts', 'utf8');
    expect(source).toContain("Deno.env.get('MAKE_SHEET_LINKS_WEBHOOK_URL')");
    // No default, no fallback, no literal.
    expect(source).not.toMatch(/MAKE_SHEET_LINKS_WEBHOOK_URL'\s*\)\s*\?\?\s*'h[^']+'/);
    expect(source).not.toMatch(/hook\.[a-z0-9]+\.make\.com/);
  });
});

// ── The architecture that was removed ──────────────────────────────────────

describe('the static shared secret is gone, not merely unused', () => {
  /*
   * A dead compatibility path is one import away from coming back, and this
   * one had a distribution problem rather than a bug: a secret that must be
   * byte-identical in two systems, where the side that can write one cannot
   * write the other. Nothing about the old design should survive as something
   * a future change could reach for, so this asserts absence rather than
   * trusting it.
   */
  const FILES = [
    'supabase/functions/_shared/builderStock/linkRecovery.pure.ts',
    'supabase/functions/_shared/builderStock/requestLinkRecovery.ts',
    'supabase/functions/builder-stock-link-callback/index.ts',
    'supabase/functions/builder-portal-stock/index.ts',
    'supabase/migrations/20261030000000_builder_stock_link_recovery.sql',
    'supabase/config.toml',
    '.github/workflows/set-builder-stock-link-secrets.yml',
  ];

  it('names no shared secret, signature header or timestamp signing anywhere', () => {
    for (const file of FILES) {
      const source = readFileSync(file, 'utf8');
      for (const gone of [
        'MAKE_SHEET_LINKS_SHARED_SECRET',
        'REPLACE_ME_MAKE_SHEET_LINKS_SHARED_SECRET',
        'x-make-signature',
        'x-make-timestamp',
        'x-aurixa-signature',
        'x-aurixa-timestamp',
        'timestampWithinSkew',
        'signedPayload',
        'MAX_TIMESTAMP_SKEW_SECONDS',
      ]) {
        expect(`${file}: ${source.includes(gone)}`).toBe(`${file}: false`);
      }
    }
  });

  it('signs nothing with HMAC on this path', () => {
    for (const file of [
      'supabase/functions/_shared/builderStock/requestLinkRecovery.ts',
      'supabase/functions/builder-stock-link-callback/index.ts',
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toContain('hmacHex');
      expect(source).not.toMatch(/name:\s*'HMAC'/);
    }
  });

  it('refuses no request for a reason that only a shared secret could produce', () => {
    const callback = readFileSync(
      'supabase/functions/builder-stock-link-callback/index.ts', 'utf8');
    for (const gone of ['recovery_not_configured', 'stale_timestamp', 'invalid_signature']) {
      expect(callback).not.toContain(gone);
    }
  });
});

// ── The reading, under both of its names ────────────────────────────────────
/*
 * `unavailable_source_sharing` covered both "the document refused to hand over
 * the workbook" and "we got it and could not read it" until those were split,
 * because they have different remedies. Rows written before that split still
 * carry the old name — including, at the time this shipped, the one production
 * upload this feature exists for.
 */
describe('a stored row may carry either spelling of the same reading', () => {
  it('the manual path accepts the historical name', () => {
    expect(isRecoverableStoredAvailability(RECOVERABLE_AVAILABILITY)).toBe(true);
    expect(isRecoverableStoredAvailability(RECOVERABLE_AVAILABILITY_LEGACY)).toBe(true);
  });

  it('and nothing else, including the readings that had the workbook', () => {
    for (const other of ['resolved', 'none_present', 'unavailable_workbook_unreadable',
      'unavailable_no_worksheet_match', 'unavailable_ambiguous_worksheet',
      null, undefined, '']) {
      expect(isRecoverableStoredAvailability(other)).toBe(false);
    }
  });

  it('the AUTOMATIC trigger stays narrow — the old name can no longer be emitted', () => {
    // Widening the live path would accept a value the current reader cannot
    // produce, which is how a condition quietly stops meaning anything.
    expect(shouldRequestLinkRecovery({
      ...OK, availability: RECOVERABLE_AVAILABILITY_LEGACY as never,
    })).toBe(false);
  });

  it('the portal control renders the server\'s answer, not its own reading', () => {
    /*
     * The predecessor of this test asserted only that both files NAMED the
     * rule — and under it the control never rendered for anyone, twice over:
     * the page fed the rule `upload.error_detail.reason` (a field the list
     * deliberately never sends), and an automated type-fix then fed it
     * `upload.error_code` (the notice code, never an availability reason).
     * Both were always false. So this pins what the rule is FED, on both
     * sides: the server derives the answer beside the data only it may read,
     * and the page renders that answer.
     */
    const page = readFileSync('src/pages/builder/BuilderStockList.tsx', 'utf8');
    const server = readFileSync(
      'supabase/functions/builder-portal-stock/index.ts', 'utf8');
    expect(page).toContain('upload.link_recovery_available === true');
    // The page never re-derives from fields the wire does not carry.
    expect(page).not.toContain('upload.error_detail');
    expect(page).not.toContain('isRecoverableStoredAvailability');
    // The list read selects the reason for itself and sends only the answer…
    expect(server).toMatch(/\$\{STOCK_UPLOAD_SELECT\}, error_detail/);
    expect(server).toMatch(/\.map\(projectUploadListRow\)/);
    // …and the server is still the authority: the act re-checks its own row.
    expect(server).toMatch(/if \(!isRecoverableStoredAvailability\(availability\)\)/);
  });
});

/*
 * The projection that carries that answer. `error_detail` holds the internal
 * diagnosis and must stay behind the server; the browser gets the one fact it
 * can act on.
 */
describe('the browser is handed the answer, never the diagnosis', () => {
  const upload = (error_detail: unknown) => ({
    id: 'upload-1', status: 'completed', error_code: 'source_links_unavailable',
    error_message: 'Links were not readable from this export.', error_detail,
  });

  it('a recoverable reason — either spelling — answers true', () => {
    for (const reason of [RECOVERABLE_AVAILABILITY, RECOVERABLE_AVAILABILITY_LEGACY]) {
      const row = projectUploadListRow(upload({ reason }));
      expect(row.link_recovery_available).toBe(true);
      expect('error_detail' in row).toBe(false);
    }
  });

  it('anything else answers false — including the rows that had the workbook', () => {
    for (const detail of [
      { reason: 'resolved' }, { reason: 'none_present' },
      { reason: 'unavailable_workbook_unreadable' },
      { reason: 'unavailable_no_worksheet_match' },
      { detail: 'internal diagnosis with no reason at all' },
      null, undefined,
    ]) {
      expect(projectUploadListRow(upload(detail)).link_recovery_available).toBe(false);
    }
  });

  it('carries every other field through untouched', () => {
    const row = projectUploadListRow(upload({ reason: RECOVERABLE_AVAILABILITY }));
    expect(row).toMatchObject({
      id: 'upload-1', status: 'completed', error_code: 'source_links_unavailable',
      error_message: 'Links were not readable from this export.',
    });
  });

  it('asks exactly the question the refresh operation asks of the same row', () => {
    // One rule, imported by both: the projection may not drift from the act.
    const reason = RECOVERABLE_AVAILABILITY_LEGACY;
    expect(projectUploadListRow(upload({ reason })).link_recovery_available)
      .toBe(isRecoverableStoredAvailability(reason));
  });
});

// ---------------------------------------------------------------------------
// The grid — the representation a builder does not have to enable
// ---------------------------------------------------------------------------

/**
 * A BUILDER SHARES A SHEET AND NOTHING ELSE.
 *
 * Turning off "viewers can download, print, copy" is an ordinary thing to do
 * with a price list, and Drive honours it: the workbook cannot be fetched at
 * all. Reading CELLS is a different permission, so `spreadsheets.get` answers
 * on the same document for the same reader. These tests pin that the grid
 * becomes the SAME worksheet shape the workbook reader produces, so every rule
 * that puts a brochure on the right lot is the one already proven.
 */
describe('a grid is adapted into the shape the workbook reader produces', () => {
  const grid = {
    sheets: [
      {
        properties: { title: 'STOCKLIST V002', sheetId: 0 },
        data: [{
          // startRow and startColumn omitted — proto3 leaves out a zero.
          rowData: [
            { values: [{ formattedValue: 'Lot #' }, { formattedValue: 'Brochure' }] },
            {
              values: [
                { formattedValue: '1002' },
                {
                  formattedValue: 'BROCHURE',
                  hyperlink: 'https://example.invalid/lot-1002.pdf',
                },
              ],
            },
            {}, // a genuinely empty row, exactly as the live sheet carries one
            {
              values: [
                { formattedValue: '1003' },
                {
                  formattedValue: 'BROCHURE',
                  hyperlink: 'https://example.invalid/lot-1003.pdf',
                },
              ],
            },
          ],
        }],
      },
    ],
  };

  it('reads a zero offset that Google omitted rather than making it NaN', () => {
    const [sheet] = gridToWorkbookSheets(grid);
    expect(sheet.values[0]?.[0]).toBe('Lot #');
    expect(sheet.values[1]?.[0]).toBe('1002');
  });

  it('keeps an empty row in its own slot, so no lot inherits the next one\'s link', () => {
    const [sheet] = gridToWorkbookSheets(grid);
    // Row 2 is the blank one; 1003 must stay at row 3, where the CSV has it.
    expect(sheet.values[2]).toEqual([]);
    expect(sheet.values[3]?.[0]).toBe('1003');
    expect(sheet.links[3]?.[1]).toBe('https://example.invalid/lot-1003.pdf');
  });

  it('places a range at its own offset', () => {
    const offset = gridToWorkbookSheets({
      sheets: [{
        properties: { title: 'Tab' },
        data: [{ startRow: 2, startColumn: 1, rowData: [{ values: [{ formattedValue: 'x' }] }] }],
      }],
    });
    expect(offset[0].values[2]?.[1]).toBe('x');
    expect(offset[0].values[0]).toEqual([]);
  });

  it('carries a link written as a HYPERLINK formula, not only as a relationship', () => {
    const [sheet] = gridToWorkbookSheets({
      sheets: [{
        properties: { title: 'Tab' },
        data: [{
          rowData: [{
            values: [{
              formattedValue: 'Brochure',
              userEnteredValue: {
                formulaValue: '=HYPERLINK("https://example.invalid/f.pdf","Brochure")',
              },
            }],
          }],
        }],
      }],
    });
    expect(sheet.links[0]?.[0]).toBe('https://example.invalid/f.pdf');
  });

  it('keeps only http(s), so an internal or mail target never becomes a source', () => {
    const [sheet] = gridToWorkbookSheets({
      sheets: [{
        properties: { title: 'Tab' },
        data: [{
          rowData: [{
            values: [
              { formattedValue: 'a', hyperlink: 'mailto:someone@example.invalid' },
              { formattedValue: 'b', hyperlink: '#gid=0&range=A1' },
              { formattedValue: 'c', hyperlink: 'https://example.invalid/ok.pdf' },
            ],
          }],
        }],
      }],
    });
    expect(sheet.links[0]?.[0]).toBeNull();
    expect(sheet.links[0]?.[1]).toBeNull();
    expect(sheet.links[0]?.[2]).toBe('https://example.invalid/ok.pdf');
  });

  it('feeds the SAME worksheet match and row rules the workbook path uses', () => {
    const sheets = gridToWorkbookSheets(grid);
    const csv = [['Lot #', 'Brochure'], ['1002', 'BROCHURE'], [], ['1003', 'BROCHURE']];
    const match = matchWorksheet(csv, sheets);
    expect(match.ok).toBe(true);

    const rows = recoveredRowsFromWorksheet(match.ok ? match.sheet : null);
    const byLot = new Map(rows.map((row) => [row.values['Lot #'], row.links.Brochure]));
    expect(byLot.get('1002')).toBe('https://example.invalid/lot-1002.pdf');
    expect(byLot.get('1003')).toBe('https://example.invalid/lot-1003.pdf');
  });

  it('refuses a pathological grid rather than expanding it into memory', () => {
    const wide = Array.from({ length: 400 }, () => ({ formattedValue: 'x' }));
    const huge = {
      sheets: [{
        properties: { title: 'Tab' },
        data: [{ rowData: Array.from({ length: 1100 }, () => ({ values: wide })) }],
      }],
    };
    expect(() => gridToWorkbookSheets(huge)).toThrow(GridTooLargeError);
    expect(MAX_GRID_CELLS).toBeLessThan(1100 * 400);
  });

  it('answers with no worksheets rather than throwing on a shape it cannot read', () => {
    expect(gridToWorkbookSheets(null)).toEqual([]);
    expect(gridToWorkbookSheets({})).toEqual([]);
    expect(gridToWorkbookSheets({ sheets: 'nonsense' })).toEqual([]);
  });
});

describe('the contract takes either representation and never neither', () => {
  const request = {
    id: '11111111-2222-4333-8444-555555555555',
    organisation_id: 'org', upload_id: 'up',
    spreadsheet_id: 'SHEET_ID_FOR_TESTS_0001',
    gid: '0',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    consumed_at: null, status: 'dispatched',
    callback_token_hash: 'a'.repeat(64),
  };
  const base = {
    request_id: request.id,
    spreadsheet_id: request.spreadsheet_id,
    gid: '0',
  };

  it('accepts a grid with no workbook', () => {
    expect(callbackRefusal(
      request, { ...base, grid: { sheets: [] } }, Date.now(), 'a'.repeat(64),
    )).toBeNull();
  });

  it('accepts a workbook with no grid', () => {
    expect(callbackRefusal(
      request, { ...base, workbook_base64: 'UEsDBAo=' }, Date.now(), 'a'.repeat(64),
    )).toBeNull();
  });

  it('refuses a body carrying neither, on shape, before the row is consulted', () => {
    expect(callbackRefusal(request, base, Date.now(), 'a'.repeat(64)))
      .toEqual({ code: 'malformed_payload', status: 400 });
    // …and with no request row at all, the same answer: shape comes first.
    expect(callbackRefusal(null, base, Date.now(), null))
      .toEqual({ code: 'malformed_payload', status: 400 });
  });

  it('still puts the token before the binding when a grid is what arrived', () => {
    const wrongDocument = { ...base, spreadsheet_id: 'SOMETHING_ELSE_0001', grid: { sheets: [] } };
    expect(callbackRefusal(request, wrongDocument, Date.now(), null))
      .toEqual({ code: 'missing_token', status: 401 });
    expect(callbackRefusal(request, wrongDocument, Date.now(), 'b'.repeat(64)))
      .toEqual({ code: 'invalid_token', status: 401 });
    expect(callbackRefusal(request, wrongDocument, Date.now(), 'a'.repeat(64)))
      .toEqual({ code: 'spreadsheet_mismatch', status: 409 });
  });

  it('expires a grid callback exactly as it expires a workbook one', () => {
    const stale = { ...request, expires_at: new Date(Date.now() - 1_000).toISOString() };
    expect(callbackRefusal(stale, { ...base, grid: { sheets: [] } }, Date.now(), 'a'.repeat(64)))
      .toEqual({ code: 'request_expired', status: 409 });
  });

  it('refuses a replay of a grid callback', () => {
    const used = { ...request, consumed_at: new Date().toISOString() };
    expect(callbackRefusal(used, { ...base, grid: { sheets: [] } }, Date.now(), 'a'.repeat(64)))
      .toEqual({ code: 'request_already_consumed', status: 409 });
  });
});

describe('the grid path is an adapter, not a second parser', () => {
  const adapter = readFileSync(
    'supabase/functions/_shared/builderStock/sheetGrid.pure.ts', 'utf8');

  it('decides a link with the one rule that decides it everywhere', () => {
    expect(adapter).toContain('hyperlinkTargetOf');
    // No second opinion about what a link is.
    expect(adapter).not.toMatch(/\/\^https\?:\\\/\\\//);
  });

  it('does not re-implement the worksheet match or the row identity', () => {
    // Naming them in prose is the point of the header; CALLING them here, or
    // importing anything but the shared cell rules, would be a second opinion.
    expect(adapter).not.toMatch(/\bmatchWorksheet\s*\(/);
    expect(adapter).not.toMatch(/\bstockPropertyIdentity\s*\(/);
    expect(adapter).not.toMatch(/\bMATCH_FLOOR\b\s*=/);

    const imports = [...adapter.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports).toEqual(['./sheetHyperlinks.pure.ts']);
  });

  it('names no deployment, builder or document', () => {
    expect(adapter).not.toMatch(/spreadsheets\/d\/[A-Za-z0-9_-]{10,}/);
    expect(adapter.toLowerCase()).not.toContain('kopi');
    expect(adapter).not.toMatch(/\bsupabase\.co\b/);
  });
});

describe('the callback reads whichever representation arrived', () => {
  const callback = readFileSync(
    'supabase/functions/builder-stock-link-callback/index.ts', 'utf8');

  it('adapts a grid and parses a workbook, through the one shared reader', () => {
    expect(callback).toContain('gridToWorkbookSheets');
    expect(callback).toContain('readWorkbookSheets');
  });

  it('keeps the single-use claim ahead of the work, whichever arrived', () => {
    const claim = callback.indexOf(".is('consumed_at', null)");
    const match = callback.indexOf('matchWorksheet(');
    expect(claim).toBeGreaterThan(0);
    expect(match).toBeGreaterThan(claim);
  });

  it('does not raise the transport limit to make a large sheet fit', () => {
    expect(MAX_CALLBACK_BYTES).toBe(5 * 1024 * 1024);
    expect(MAX_WORKBOOK_BYTES).toBe(3 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// The layout the production sheet actually has
// ---------------------------------------------------------------------------

/**
 * THE ROW NUMBERS NEVER AGREED, AND NOTHING NOTICED.
 *
 * The live stocklist opens with a banner and spacer rows and names its columns
 * on the EIGHTH row; between Lot 605 and Lot 606 it carries a blank row. The
 * CSV the import proves the tab from comes from `gviz`, which compacts all of
 * that away — merging the banner into the heading and dropping the blanks.
 * Two true readings of one tab, seven rows apart and drifting further at every
 * blank.
 *
 * Scored index-for-index the document reproduced 0.22 of itself, refused its
 * own worksheet and applied nothing. Had the floor been lower it would have
 * done something far worse: handed every property below the blank row the NEXT
 * one's brochure. These reproduce that layout exactly.
 */
describe('the production layout: banners above the header, blanks between properties', () => {
  const HEADINGS = ['Contract Type', 'Product Type', 'Lot #', 'Estate', 'Brochure'];

  /** The tab as the SHEET holds it: banner, spacers, header at 7, a blank at 9. */
  function productionSheet(overrides: { lot606Link?: string; extra?: unknown[] } = {}) {
    const cell = (v: string | null, link?: string) => (
      v === null ? {} : { formattedValue: v, ...(link ? { hyperlink: link } : {}) });
    const rowData: unknown[] = [{}, {}, {}, {}, {}, {}, {}];
    rowData[2] = { values: [cell('[VG] MASTER STOCKLIST - V002')] };
    rowData.push({ values: HEADINGS.map((h) => cell(h)) });                    // 7
    rowData.push({                                                             // 8
      values: [cell('2-Part'), cell('Detached SS'), cell('605'), cell('Acclaim Estate'),
        cell('Brochure', 'https://example.invalid/lot-605.pdf')],
    });
    rowData.push({});                                                          // 9 — blank
    rowData.push({                                                             // 10
      values: [cell('2-Part'), cell('Detached SS'), cell('606'), cell('Acclaim Estate'),
        cell('Brochure', overrides.lot606Link ?? 'https://example.invalid/lot-606.pdf')],
    });
    for (const row of overrides.extra ?? []) rowData.push(row);
    return gridToWorkbookSheets({
      sheets: [{ properties: { title: 'STOCKLIST V002', sheetId: 0 }, data: [{ rowData }] }],
    });
  }

  /** The tab as `gviz` reports it: compacted, banner merged, blanks gone. */
  const provenCsv = [
    ['[VG] MASTER STOCKLIST - V002 Contract Type', 'Product Type', 'Lot #', 'Estate', 'Brochure'],
    ['2-Part', 'Detached SS', '605', 'Acclaim Estate', 'Brochure'],
    ['2-Part', 'Detached SS', '606', 'Acclaim Estate', 'Brochure'],
  ];

  it('finds the header seven rows down, not at row 0', () => {
    const [sheet] = productionSheet();
    expect(locateHeaderRow(provenCsv, sheet)).toBe(7);
  });

  it('matches the tab it could not previously recognise as itself', () => {
    const match = matchWorksheet(provenCsv, productionSheet());
    expect(match.ok).toBe(true);
    if (match.ok) {
      expect(match.score).toBe(1);
      expect(match.headerRow).toBe(7);
    }
  });

  it('gives Lot 606 its OWN brochure across the blank row', () => {
    const match = matchWorksheet(provenCsv, productionSheet());
    expect(match.ok).toBe(true);
    const rows = recoveredRowsFromWorksheet(
      match.ok ? match.sheet : null, match.ok ? match.headerRow : 0);

    const byLot = new Map(rows.map((row) => [row.values['Lot #'], row.links.Brochure]));
    expect(byLot.get('605')).toBe('https://example.invalid/lot-605.pdf');
    expect(byLot.get('606')).toBe('https://example.invalid/lot-606.pdf');
    // The blank row contributed no row at all — it is not a property.
    expect(rows).toHaveLength(2);
  });

  it('never lets 606 inherit 605\'s link, which is what index alignment did', () => {
    const [sheet] = productionSheet();
    const aligned = alignWorksheetRows(provenCsv, sheet);
    // CSV row 1 is Lot 605 at worksheet row 8; CSV row 2 is Lot 606 at row 10.
    expect(aligned[1]).toBe(8);
    expect(aligned[2]).toBe(10);
    // Under the old reading 606 sat at row 9 — the blank — and would have been
    // handed whatever the row beneath it carried.
    expect(aligned[2]).not.toBe(9);
  });

  it('puts each row\'s own link beside it when the columns are merged', () => {
    const [sheet] = productionSheet();
    const merged = mergeHyperlinkColumns(provenCsv, sheet);
    expect(merged.columnsAdded).toEqual(['Brochure URL']);
    expect(merged.linksResolved).toBe(2);
    const urlAt = merged.matrix[0].indexOf('Brochure URL');
    expect(merged.matrix[1][urlAt]).toBe('https://example.invalid/lot-605.pdf');
    expect(merged.matrix[2][urlAt]).toBe('https://example.invalid/lot-606.pdf');
    // Membership is untouched: no row added, removed or reordered.
    expect(merged.matrix).toHaveLength(provenCsv.length);
    expect(merged.matrix.map((r) => r[2])).toEqual(['Lot #', '605', '606']);
  });

  it('applies nothing to a row two worksheet rows both claim to be', () => {
    // The same lot listed twice, as this builder's sheet genuinely does.
    const cell = (v: string, link?: string) => ({
      formattedValue: v, ...(link ? { hyperlink: link } : {}) });
    const twin = {
      values: [cell('2-Part'), cell('Detached SS'), cell('606'), cell('Acclaim Estate'),
        cell('Brochure', 'https://example.invalid/SOMEONE-ELSES.pdf')],
    };
    const [sheet] = productionSheet({ extra: [twin] });

    const aligned = alignWorksheetRows(provenCsv, sheet);
    // Two rows say exactly what CSV row 2 says, so neither may lend its link.
    expect(aligned[2]).toBe(-1);

    const merged = mergeHyperlinkColumns(provenCsv, sheet);
    const urlAt = merged.matrix[0].indexOf('Brochure URL');
    expect(merged.matrix[1][urlAt]).toBe('https://example.invalid/lot-605.pdf');
    expect(merged.matrix[2][urlAt]).toBe('');
    expect(merged.matrix[2][urlAt]).not.toContain('SOMEONE-ELSES');
  });

  it('refuses a worksheet whose header it cannot find at all', () => {
    const headerless = gridToWorkbookSheets({
      sheets: [{
        properties: { title: 'Notes' },
        data: [{ rowData: [{ values: [{ formattedValue: 'just some prose' }] }] }],
      }],
    });
    expect(locateHeaderRow(provenCsv, headerless[0])).toBe(-1);
    expect(worksheetScore(provenCsv, headerless[0])).toBe(0);
    const match = matchWorksheet(provenCsv, headerless);
    expect(match.ok).toBe(false);
    if (match.ok === false) expect(match.reason).toBe('no_match');
  });

  it('applies zero links when two tabs are equally like the proven CSV', () => {
    const twinTabs = [...productionSheet(), ...productionSheet()];
    twinTabs[1] = { ...twinTabs[1], name: 'STOCKLIST V002 (copy)' };
    const match = matchWorksheet(provenCsv, twinTabs);
    expect(match.ok).toBe(false);
    if (match.ok === false) expect(match.reason).toBe('ambiguous');
    // Nothing decisive means nothing applied — the caller gets no worksheet.
    expect(recoveredRowsFromWorksheet(match.ok ? match.sheet : null)).toEqual([]);
  });

  it('reads the same links whether they arrived as a workbook or as a grid', () => {
    // The adapter's output IS the workbook reader's output; one pipeline reads
    // both, so a builder who may not be downloaded from is not a second case.
    const [fromGrid] = productionSheet();
    const asWorkbook: typeof fromGrid = {
      name: fromGrid.name,
      values: fromGrid.values.map((r) => [...r]),
      links: fromGrid.links.map((r) => [...r]),
    };
    expect(matchWorksheet(provenCsv, [asWorkbook]).ok).toBe(true);
    expect(mergeHyperlinkColumns(provenCsv, asWorkbook))
      .toEqual(mergeHyperlinkColumns(provenCsv, fromGrid));
  });
});

describe('row position may never decide which brochure belongs to which property', () => {
  const source = readFileSync(
    'supabase/functions/_shared/builderStock/sheetHyperlinks.pure.ts', 'utf8');

  it('scores and aligns through the located header, never from row 0', () => {
    expect(source).toContain('locateHeaderRow');
    expect(source).toContain('alignWorksheetRows');
    // The old reading — a CSV row index used to index the worksheet — is gone.
    expect(source).not.toMatch(/sheet\.links\[r \+ 1\]/);
  });

  it('gives the same answer however far down the sheet the table starts', () => {
    // Behaviour, not spelling: pushing the whole table down must change
    // nothing, because nothing may depend on where a row physically sits.
    const csv = [['Lot #', 'Brochure'], ['1002', 'Brochure'], ['1003', 'Brochure']];
    const build = (padding: number) => {
      const cell = (v: string, link?: string) => ({
        formattedValue: v, ...(link ? { hyperlink: link } : {}) });
      const rowData: unknown[] = Array.from({ length: padding }, () => ({}));
      rowData.push({ values: [cell('Lot #'), cell('Brochure')] });
      rowData.push({ values: [cell('1002'), cell('Brochure', 'https://example.invalid/a.pdf')] });
      rowData.push({});
      rowData.push({ values: [cell('1003'), cell('Brochure', 'https://example.invalid/b.pdf')] });
      return gridToWorkbookSheets({
        sheets: [{ properties: { title: 'T' }, data: [{ rowData }] }],
      })[0];
    };

    for (const padding of [0, 1, 7, 40]) {
      const sheet = build(padding);
      expect(locateHeaderRow(csv, sheet)).toBe(padding);
      expect(worksheetScore(csv, sheet)).toBe(1);
      const merged = mergeHyperlinkColumns(csv, sheet);
      const urlAt = merged.matrix[0].indexOf('Brochure URL');
      expect(merged.matrix[1][urlAt]).toBe('https://example.invalid/a.pdf');
      expect(merged.matrix[2][urlAt]).toBe('https://example.invalid/b.pdf');
    }
  });

  it('pairs a row only when one worksheet row beats every other', () => {
    const cell = (v: string, link?: string) => ({
      formattedValue: v, ...(link ? { hyperlink: link } : {}) });
    const csv = [['Lot #', 'Estate', 'Beds', 'Brochure'],
      ['605', 'Acclaim', '4', 'Brochure']];

    // Near-identical neighbours must NOT block a row: the true row agrees on
    // every cell, the neighbour on all but the lot, so the winner is strict.
    const distinguishable = gridToWorkbookSheets({
      sheets: [{ properties: { title: 'T' }, data: [{ rowData: [
        { values: [cell('Lot #'), cell('Estate'), cell('Beds'), cell('Brochure')] },
        { values: [cell('606'), cell('Acclaim'), cell('4'),
          cell('Brochure', 'https://example.invalid/606.pdf')] },
        { values: [cell('605'), cell('Acclaim'), cell('4'),
          cell('Brochure', 'https://example.invalid/605.pdf')] },
      ] }] }],
    })[0];
    expect(alignWorksheetRows(csv, distinguishable)[1]).toBe(2);
    const merged = mergeHyperlinkColumns(csv, distinguishable);
    expect(merged.matrix[1][merged.matrix[0].indexOf('Brochure URL')])
      .toBe('https://example.invalid/605.pdf');

    // A genuine tie — the same row twice — lends nothing to either.
    const tied = gridToWorkbookSheets({
      sheets: [{ properties: { title: 'T' }, data: [{ rowData: [
        { values: [cell('Lot #'), cell('Estate'), cell('Beds'), cell('Brochure')] },
        { values: [cell('605'), cell('Acclaim'), cell('4'),
          cell('Brochure', 'https://example.invalid/first.pdf')] },
        { values: [cell('605'), cell('Acclaim'), cell('4'),
          cell('Brochure', 'https://example.invalid/second.pdf')] },
      ] }] }],
    })[0];
    expect(alignWorksheetRows(csv, tied)[1]).toBe(-1);
    expect(mergeHyperlinkColumns(csv, tied).linksResolved).toBe(0);
  });

  it('is still the one shared implementation, with no Google-specific twin', () => {
    const twin = 'supabase/functions/_shared/builderStock/sheetGrid.pure.ts';
    const adapter = readFileSync(twin, 'utf8');
    expect(adapter).not.toMatch(/\bworksheetScore\s*\(/);
    expect(adapter).not.toMatch(/\balignWorksheetRows\s*\(/);
    expect(adapter).not.toMatch(/\blocateHeaderRow\s*\(/);
  });
});
