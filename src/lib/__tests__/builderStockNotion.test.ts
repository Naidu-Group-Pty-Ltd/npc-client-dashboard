/**
 * Builder stock — public Notion pages, and the difference between "we may not
 * read this" and "we read it and found no properties".
 *
 * THE DEFECT THIS FILE PINS. `runImport.ts` answered `notion_not_public` for
 * any Notion source that produced no rows. Production then reported that a
 * page shared to the entire web was private: the page returned HTTP 200,
 * 19,381 bytes, no access-gate marker anywhere in it, and 70 real properties
 * one endpoint away. Telling a builder to change a sharing setting that is
 * already correct is worse than telling them nothing at all.
 *
 * The fixtures below are the SHAPE of that production response, taken from it
 * verbatim — the double `value.value` wrapping, the `spaceId` on the wrapper,
 * the punctuation-heavy schema keys, the reducer-shaped query result. The
 * column names are the real ones, which is the other half of the bug: `Deal`,
 * `Estate Tag` and `Package Status` were in no alias table, so even a
 * successful recovery would have dropped every row.
 */
import { describe, expect, it } from 'vitest';

import {
  assessNotionReadability, extractHtmlTables, extractNotionGridTables, extractReadableText,
  readHtmlSource,
} from '../../../supabase/functions/_shared/builderStock/htmlSource.pure';
import {
  describeNotionPage, extractNotionPageId, matrixToCsv, mergeNotionRecordMaps,
  notionCollectionColumns, notionCollectionMatrix, notionReadableText,
  notionSimpleTableMatrices, notionTextValue, preferredNotionViewId, toNotionUuid,
  unwrapNotionRecord,
} from '../../../supabase/functions/_shared/builderStock/notionRecordMap.pure';
import { keyRowsByHeader, parseDelimited } from '../../../supabase/functions/_shared/builderStock/table.pure';
import { normaliseStockRow } from '../../../supabase/functions/_shared/builderStock/normalise.pure';
import { importStockRecords } from '../../../supabase/functions/_shared/builderStock/importStock';
import {
  NOTION_NOT_PUBLIC_MESSAGE, NOTION_NO_PROPERTIES_MESSAGE,
} from '../../../supabase/functions/_shared/builderStock/urlSource.pure';
import { classifyFetchedSource } from '../../../supabase/functions/_shared/builderStock/fileTypes.pure';

// ---------------------------------------------------------------------------
// Fixtures, in the exact wire shape production returned
// ---------------------------------------------------------------------------

const PAGE_ID = '30ccabf9-2010-8099-b502-d7ac23995def';
const COLLECTION_ID = '30ccabf9-2010-80b2-b004-000b94db2627';
const VIEW_ID = '30ccabf9-2010-80e6-9dd6-000c26da7c45';
const SPACE_ID = '2b0cabf9-2010-8111-92c9-000329d94f98';
const PAGE_URL = `https://ionized-chalk-a63.notion.site/${PAGE_ID.replace(/-/g, '')}`
  + `?v=${VIEW_ID.replace(/-/g, '')}`;

/** `loadCachedPageChunkV2` double-wraps every record and hangs `spaceId` outside. */
const wrap = (value: Record<string, unknown>) => ({
  spaceId: SPACE_ID,
  value: { value, role: 'reader' },
});

/**
 * The 19 KB client-rendering shell. No table, no grid, no gate marker, and a
 * `<title>` of "Notion" — this is what EVERY published Notion page returns.
 */
const NOTION_SHELL = '<!doctype html><html><head><title>Notion</title>'
  + '<meta name="description" content=""></head><body>'
  + '<div id="notion-app"></div>'
  + `<script>window.__notion_boot_data=null;window.CONFIG={"pageId":"${PAGE_ID}"};</script>`
  + '<script src="/_assets/RecordMap-8f2c1d.js"></script>'
  + '</body></html>';

const CHUNK_RECORD_MAP = {
  __version__: 3,
  block: {
    [PAGE_ID]: wrap({
      id: PAGE_ID,
      type: 'collection_view_page',
      view_ids: [VIEW_ID],
      collection_id: COLLECTION_ID,
      format: {
        collection_pointer: { id: COLLECTION_ID, table: 'collection', spaceId: SPACE_ID },
      },
      permissions: [{ role: 'reader', type: 'public_permission', is_site: true }],
      alive: true,
    }),
  },
  collection_view: {
    [VIEW_ID]: wrap({
      id: VIEW_ID,
      type: 'table',
      format: {
        table_properties: [
          { width: 200, visible: true, property: 'mlCu' },
          { width: 100, visible: true, property: 'Lsfu' },
          { width: 670, visible: true, property: 'title' },
          { width: 200, visible: true, property: 'ZVPn' },
          { width: 184, visible: true, property: 'TM]Z' },
          { width: 150, visible: true, property: 'Rn:O' },
          { width: 144, visible: true, property: 'G^bL' },
          // Hidden on the page, so not part of the stock list.
          { width: 120, visible: false, property: 'PvXc' },
        ],
      },
    }),
  },
  collection: {
    [COLLECTION_ID]: wrap({
      id: COLLECTION_ID,
      name: [['LIVE STOCK LIST - August 2026 ']],
      schema: {
        'G^bL': { name: 'Estate Tag', type: 'select' },
        Lsfu: { name: 'State', type: 'select' },
        'Rn:O': { name: 'Land Size (m2)', type: 'number' },
        'TM]Z': { name: 'Property Type', type: 'select' },
        ZVPn: { name: 'Package Price', type: 'number' },
        mlCu: { name: 'Package Status', type: 'select' },
        PvXc: { name: 'Finance Clause Available', type: 'select' },
        title: { name: 'Deal', type: 'title' },
      },
    }),
  },
};

const ROW_ONE = '374cabf9-2010-8059-b681-c9aa84ff8b0d';
const ROW_TWO = '374cabf9-2010-80c4-b8e6-c109dcc8654a';

const QUERY_RESPONSE = {
  result: {
    type: 'reducer',
    reducerResults: {
      collection_group_results: { type: 'results', blockIds: [ROW_ONE, ROW_TWO], hasMore: false },
    },
  },
  recordMap: {
    __version__: 3,
    block: {
      [ROW_ONE]: wrap({
        id: ROW_ONE,
        type: 'page',
        alive: true,
        parent_id: COLLECTION_ID,
        properties: {
          title: [['Lot 60434 - Cloverton Estate, Kalkallo VIC 3064 ']],
          'G^bL': [['Cloverton Estate Kalkallo VIC 3064 - Stocklands']],
          Lsfu: [['VIC']],
          'Rn:O': [['263']],
          'TM]Z': [['House and Land']],
          ZVPn: [['643000']],
          mlCu: [['Available']],
          PvXc: [['Yes']],
          // A URL cell arrives as a text/decoration tuple.
          'O^yH': [['https://example.invalid/pack', [['a', 'https://example.invalid/pack']]]],
        },
      }),
      [ROW_TWO]: wrap({
        id: ROW_TWO,
        type: 'page',
        alive: true,
        parent_id: COLLECTION_ID,
        properties: {
          title: [['Lot 118 - Harpley Estate, Werribee VIC 3030']],
          'G^bL': [['Harpley Estate - Stocklands Werribee VIC - 3030']],
          Lsfu: [['VIC']],
          'Rn:O': [['350']],
          'TM]Z': [['House and Land']],
          ZVPn: [['712500']],
          mlCu: [['Coming Soon']],
        },
      }),
    },
  },
};

/**
 * The whole recovery, minus the two HTTP calls: chunk plus query, decoded,
 * written as CSV and read back by the pipeline that reads every other source.
 */
function recoverMatrix(): string[][] {
  const shape = describeNotionPage(CHUNK_RECORD_MAP, PAGE_ID, preferredNotionViewId(PAGE_URL));
  const merged = mergeNotionRecordMaps(CHUNK_RECORD_MAP, QUERY_RESPONSE.recordMap);
  return notionCollectionMatrix(merged, {
    collectionId: shape.collectionId as string,
    viewId: shape.collectionViewId,
    blockIds: QUERY_RESPONSE.result.reducerResults.collection_group_results.blockIds,
  });
}

/** Matrix → CSV → the ordinary delimited reader → the ordinary normaliser. */
function importedRecords(matrix: string[][]) {
  const keyed = keyRowsByHeader(parseDelimited(matrixToCsv(matrix)));
  if (!keyed) return [];
  return keyed.rows
    .map((row) => normaliseStockRow(row))
    .filter((record): record is NonNullable<typeof record> => record !== null);
}

/**
 * A `db` that records what the import wrote. Enough of PostgREST's chain for
 * `importStockRecords`, and no more — the point is to prove the rows reach it,
 * not to reimplement Postgres.
 */
function fakeStockDb() {
  const writes: Array<{ table: string; row: Record<string, unknown> }> = [];
  let sequence = 0;

  const from = (table: string) => {
    let mode: 'select' | 'insert' | 'update' = 'select';
    const api: Record<string, unknown> = {};
    Object.assign(api, {
      select: () => api,
      eq: () => api,
      or: () => api,
      in: () => api,
      is: () => api,
      neq: () => api,
      order: () => api,
      // A paged read asks for one page at a time, because the API caps every
      // response at `db-max-rows` however large a `.limit()` it is given.
      range(from: number, to: number) {
        return Promise.resolve(api as any).then((page: any) => ({ data: (page?.data ?? []).slice(from, to + 1), error: page?.error ?? null }));
      },
      limit: () => Promise.resolve({ data: [], error: null }),
      upsert: (row: Record<string, unknown>) => {
        writes.push({ table, row });
        return Promise.resolve({ data: null, error: null });
      },
      insert: (row: Record<string, unknown>) => {
        mode = 'insert';
        writes.push({ table, row });
        return api;
      },
      update: (row: Record<string, unknown>) => {
        mode = 'update';
        writes.push({ table, row });
        return api;
      },
      single: () => Promise.resolve(mode === 'select'
        ? { data: null, error: null }
        : { data: { id: `stock-item-${++sequence}` }, error: null }),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null }),
    });
    return api;
  };

  return { db: { from } as never, writes };
}

// ===========================================================================
// TEST A — an actual public Notion page
// ===========================================================================

describe('TEST A — a public Notion stock list', () => {
  it('is not classified as private: 200, no gate marker, no content', () => {
    const assessment = assessNotionReadability(NOTION_SHELL, extractReadableText(NOTION_SHELL));
    expect(assessment.gated).toBe(false);
    expect(assessment.marker).toBeNull();
    expect(assessment.state).toBe('shell');
  });

  it('produces stock rows from the collection the page displays', () => {
    const matrix = recoverMatrix();
    expect(matrix[0]).toEqual([
      'Package Status', 'State', 'Deal', 'Package Price',
      'Property Type', 'Land Size (m2)', 'Estate Tag',
    ]);
    expect(matrix).toHaveLength(3);

    const records = importedRecords(matrix);
    expect(records).toHaveLength(2);
    expect(records[0].address_line).toBe('Lot 60434 - Cloverton Estate, Kalkallo VIC 3064');
    expect(records[0].state).toBe('VIC');
    expect(records[0].price).toBe(643000);
    expect(records[0].property_type).toBe('house_and_land');
    expect(records[0].land_size_sqm).toBe(263);
    expect(records[0].availability_status).toBe('available');
    expect(records[1].availability_status).toBe('unknown');
  });

  it('imports through importStockRecords, not a Notion-specific path', async () => {
    const matrix = recoverMatrix();
    const keyed = keyRowsByHeader(parseDelimited(matrixToCsv(matrix)));
    const { db, writes } = fakeStockDb();

    const outcome = await importStockRecords(db, {
      organisationId: 'org-1',
      uploadId: 'upload-1',
      builderUserId: 'builder-1',
      rows: keyed?.rows ?? [],
      media: [],
    });

    expect(outcome.detected).toBe(2);
    expect(outcome.imported).toBe(2);
    expect(outcome.failed).toBe(0);
    /*
     * THE PLATFORM'S OWN TABLES AND NOBODY ELSE'S. No `notion_*` anything — a
     * Notion list is a SOURCE, never a schema.
     *
     * Asserted as a rule about the names rather than as a fixed set: safe
     * publication added a write to `builder_stock_uploads` (the uploads this
     * one replaces, recorded before `upload_id` is re-pointed), which is the
     * platform's own table and satisfies the rule this test exists for. A
     * hard-coded list would have failed for a change that is exactly what it
     * was asking for.
     */
    const written = new Set(writes.map((write) => write.table));
    expect([...written].every((table) => table.startsWith('builder_stock_'))).toBe(true);
    expect(written).toContain('builder_stock_items');
    expect(writes[0].row.organisation_id).toBe('org-1');
    expect(writes[0].row.upload_id).toBe('upload-1');
  });

  it('respects the view: a column the page hides is not imported', () => {
    const columns = notionCollectionColumns(CHUNK_RECORD_MAP, COLLECTION_ID, VIEW_ID);
    expect(columns.map((column) => column.name)).not.toContain('Finance Clause Available');
  });
});

// ===========================================================================
// TEST B — the client-rendered shell
// ===========================================================================

describe('TEST B — a 200 whose content lives in page state, not markup', () => {
  it('finds nothing in the markup, which is the ordinary case and not a fault', () => {
    const page = readHtmlSource(NOTION_SHELL, PAGE_URL);
    expect(extractHtmlTables(NOTION_SHELL)).toHaveLength(0);
    expect(extractNotionGridTables(NOTION_SHELL)).toHaveLength(0);
    expect(page.text.trim().length).toBeLessThan(40);
    expect(page.title).toBe('Notion');
  });

  it('is never labelled private for being a shell', () => {
    const assessment = assessNotionReadability(NOTION_SHELL, extractReadableText(NOTION_SHELL));
    expect(assessment.gated).toBe(false);
    expect(assessment.clientRendered).toBe(true);
  });

  it('recovers the page id the endpoints need, from the URL or the markup', () => {
    expect(extractNotionPageId(PAGE_URL, NOTION_SHELL)).toBe(PAGE_ID);
    expect(extractNotionPageId('https://acme.notion.site/', NOTION_SHELL)).toBe(PAGE_ID);
    expect(extractNotionPageId('https://acme.notion.site/March-Stock-List-'
      + PAGE_ID.replace(/-/g, ''), null)).toBe(PAGE_ID);
    // `?v=` is the VIEW, and asking for it as a page returns nothing.
    expect(preferredNotionViewId(PAGE_URL)).toBe(VIEW_ID);
    expect(extractNotionPageId(`https://acme.notion.site/?v=${VIEW_ID}`, '')).toBeNull();
  });

  it('reads the page state Notion actually returns, double wrapping and all', () => {
    expect(unwrapNotionRecord(wrap({ id: 'x', type: 'page' }))?.type).toBe('page');
    expect(unwrapNotionRecord({ role: 'reader', value: { id: 'y' } })?.id).toBe('y');
    expect(unwrapNotionRecord({ nothing: true })).toBeNull();

    const shape = describeNotionPage(CHUNK_RECORD_MAP, PAGE_ID, VIEW_ID);
    expect(shape.blockType).toBe('collection_view_page');
    expect(shape.collectionId).toBe(COLLECTION_ID);
    expect(shape.collectionViewId).toBe(VIEW_ID);
    expect(shape.spaceId).toBe(SPACE_ID);
    expect(shape.title).toBe('LIVE STOCK LIST - August 2026');
  });

  it('decodes rich text without inventing anything', () => {
    expect(notionTextValue([['Lot 12'], [' Cranbourne']])).toBe('Lot 12 Cranbourne');
    expect(notionTextValue([['https://x.invalid', [['a', 'https://x.invalid']]]]))
      .toBe('https://x.invalid');
    // A date mention is recoverable; a user mention is not, and contributes
    // nothing rather than a stray bullet.
    expect(notionTextValue([['‣', [['d', { type: 'date', start_date: '2026-11-01' }]]]]))
      .toBe('2026-11-01');
    expect(notionTextValue([['‣', [['u', 'user-id']]]])).toBe('');
    expect(notionTextValue(undefined)).toBe('');
    expect(toNotionUuid('30ccabf920108099b502d7ac23995def')).toBe(PAGE_ID);
    expect(toNotionUuid('not-a-uuid')).toBeNull();
  });

  it('reads a simple Notion table block as well as a database', () => {
    const map = {
      block: {
        t1: wrap({
          id: 't1',
          type: 'table',
          content: ['r1', 'r2'],
          format: { table_block_column_order: ['cA', 'cB', 'cC'] },
        }),
        r1: wrap({
          id: 'r1', type: 'table_row',
          properties: { cA: [['Lot']], cB: [['Suburb']], cC: [['Price']] },
        }),
        r2: wrap({
          id: 'r2', type: 'table_row',
          properties: { cA: [['21']], cB: [['Point Cook']], cC: [['$812,000']] },
        }),
      },
    };
    const [matrix] = notionSimpleTableMatrices(map);
    expect(matrix).toEqual([['Lot', 'Suburb', 'Price'], ['21', 'Point Cook', '$812,000']]);
    const records = importedRecords(matrix);
    expect(records[0].lot_number).toBe('21');
    expect(records[0].price).toBe(812000);
  });

  it('falls back to the page prose when there is no table at all', () => {
    const map = {
      block: {
        p1: wrap({ id: 'p1', type: 'page', properties: { title: [['March release']] } }),
        b1: wrap({ id: 'b1', type: 'text', properties: { title: [['Lot 9, Tarneit — $702,000']] } }),
      },
    };
    expect(notionReadableText(map)).toContain('Lot 9, Tarneit');
  });
});

// ===========================================================================
// TEST C — a genuinely private page
// ===========================================================================

describe('TEST C — a real login / request-access shell', () => {
  it.each([
    ['<html><body><main>You need access to this page</main></body></html>', 'you need access'],
    ['<html><body><main>Request access</main></body></html>', 'request access'],
    ['<html><body><main>Log in to Notion to continue</main></body></html>', 'log in to notion'],
    ['<html><body><main>This content does not exist</main></body></html>', 'this content does not exist'],
  ])('is gated on the evidence, and names the marker', (html, marker) => {
    const assessment = assessNotionReadability(html, extractReadableText(html));
    expect(assessment.gated).toBe(true);
    expect(assessment.state).toBe('gated');
    expect(assessment.marker).toBe(marker);
  });

  it('imports nothing from a gated page', () => {
    const html = '<html><body><main>You need access to this page</main></body></html>';
    expect(extractHtmlTables(html)).toHaveLength(0);
    expect(extractNotionGridTables(html)).toHaveLength(0);
  });

  it('keeps one safe wording for the refusal', () => {
    expect(NOTION_NOT_PUBLIC_MESSAGE).toMatch(/not publicly accessible/i);
    expect(NOTION_NOT_PUBLIC_MESSAGE).toMatch(/share it publicly/i);
  });

  it('does not gate a page because a script mentions the words', () => {
    const html = '<html><head><script>var copy="Request access";</script></head>'
      + '<body><main>Lot 4 Wollert 4 bed 350m2 available now for $688,000 with '
      + 'titles expected in March and a fixed price build contract.</main></body></html>';
    const assessment = assessNotionReadability(html, extractReadableText(html));
    expect(assessment.gated).toBe(false);
    expect(assessment.state).toBe('content');
  });
});

// ===========================================================================
// TEST D — public, reachable, and carrying no stock
// ===========================================================================

describe('TEST D — a public Notion page with no properties on it', () => {
  it('says so, and says nothing about sharing', () => {
    expect(NOTION_NO_PROPERTIES_MESSAGE).toMatch(/no properties could be read/i);
    expect(NOTION_NO_PROPERTIES_MESSAGE).not.toMatch(/public/i);
    expect(NOTION_NO_PROPERTIES_MESSAGE).not.toMatch(/private/i);
    expect(NOTION_NO_PROPERTIES_MESSAGE).not.toBe(NOTION_NOT_PUBLIC_MESSAGE);
  });

  it('a reachable page of prose is content, not a gate', () => {
    const html = '<html><body><main>Welcome to our team wiki. Meeting notes are filed by '
      + 'month and the onboarding checklist lives under People.</main></body></html>';
    const assessment = assessNotionReadability(html, extractReadableText(html));
    expect(assessment.gated).toBe(false);
    expect(assessment.state).toBe('content');
  });

  it('a collection whose rows are all empty yields no matrix rather than a header', () => {
    const empty = mergeNotionRecordMaps(CHUNK_RECORD_MAP, { block: {} });
    expect(notionCollectionMatrix(empty, {
      collectionId: COLLECTION_ID, viewId: VIEW_ID, blockIds: [],
    })).toEqual([]);
  });
});

// ===========================================================================
// TEST E — the false-positive itself
// ===========================================================================

describe('TEST E — zero rows from a Notion URL is not a permission finding', () => {
  /**
   * The regression, stated as source. `runImport.ts`'s zero-row branch is
   * allowed to answer `no_properties_found` and nothing else; the moment it
   * can reach `notion_not_public` again, the production defect is back.
   */
  it('runImport cannot answer notion_not_public at all', async () => {
    const source = await import('node:fs/promises')
      .then((fs) => fs.readFile(
        'supabase/functions/_shared/builderStock/runImport.ts', 'utf8'));
    // Comments stripped: the module explains the defect at length, and the
    // explanation naming the code must not count as the code.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toContain('notion_not_public');
    expect(code).not.toContain('NOTION_NOT_PUBLIC_MESSAGE');
    expect(code).toContain('NOTION_NO_PROPERTIES_MESSAGE');
  });

  /**
   * And the heuristic that fed it. "Under 40 characters" described every
   * published Notion page in existence, so it can never mean "gated" again.
   */
  it('shortness is not evidence of a permission gate', () => {
    for (const html of [
      '<html><body></body></html>',
      '<html><body><div id="notion-app"></div></body></html>',
      NOTION_SHELL,
      '<html><body><main>Notion</main></body></html>',
    ]) {
      const assessment = assessNotionReadability(html, extractReadableText(html));
      expect(assessment.gated).toBe(false);
      expect(assessment.clientRendered).toBe(true);
    }
  });

  it('the real production column names now reach real fields', () => {
    const record = normaliseStockRow({
      'Package Status': 'Available',
      State: 'VIC',
      Deal: 'Lot 60434 - Cloverton Estate, Kalkallo VIC 3064',
      'Package Price': '643000',
      'Estate Tag': 'Cloverton Estate Kalkallo VIC 3064 - Stocklands',
    });
    expect(record).not.toBeNull();
    expect(record?.address_line).toBe('Lot 60434 - Cloverton Estate, Kalkallo VIC 3064');
    expect(record?.development_name).toBe('Cloverton Estate Kalkallo VIC 3064 - Stocklands');
    expect(record?.availability_status).toBe('available');
  });
});

// ===========================================================================
// TEST F — the SSRF surface is unchanged
// ===========================================================================

describe('TEST F — the extra Notion request carries the same guard', () => {
  it('goes through assertPublicUrl and refuses redirects, sending no credential', async () => {
    const source = await import('node:fs/promises')
      .then((fs) => fs.readFile(
        'supabase/functions/_shared/builderStock/fetchSource.ts', 'utf8'));
    const post = source.slice(source.indexOf('export async function postGuardedJson'));
    expect(post).toContain('assertPublicUrl');
    expect(post).toContain("redirect: 'manual'");
    expect(post).toContain('source_bad_redirect');
    expect(post).toContain('readCapped');
    // Nothing credentialed is attached, and nothing reads the environment.
    expect(post).not.toMatch(/Authorization|Cookie|Deno\.env|SERVICE_ROLE/i);
  });

  it('adds no Notion credential anywhere', async () => {
    const source = await import('node:fs/promises')
      .then((fs) => fs.readFile(
        'supabase/functions/_shared/builderStock/notionPublicContent.ts', 'utf8'));
    expect(source).not.toMatch(/NOTION_API_KEY|Notion-Version|Bearer|Deno\.env/);
    // Only Notion's own hosts, only over the guarded POST.
    expect(source).toContain('isNotionHost');
    expect(source).toContain('postGuardedJson');
    expect(source).not.toContain('await fetch(');
  });
});

// ===========================================================================
// TEST G — one pipeline
// ===========================================================================

describe('TEST G — Notion rows use the platform pipeline and no other', () => {
  it('the recovered content is CSV read by the ordinary delimited reader', () => {
    const csv = matrixToCsv(recoverMatrix());
    expect(csv.split('\r\n')).toHaveLength(3);
    // A cell carrying a comma survives the round trip, header included.
    const keyed = keyRowsByHeader(parseDelimited(csv));
    expect(keyed?.headers).toContain('Deal');
    expect(keyed?.rows[0].Deal).toBe('Lot 60434 - Cloverton Estate, Kalkallo VIC 3064');
  });

  it('quotes what has to be quoted, including a newline inside a cell', () => {
    const csv = matrixToCsv([['Deal', 'Notes'], ['Lot 1, Tarneit', 'line one\nline two']]);
    expect(csv).toContain('"Lot 1, Tarneit"');
    expect(parseDelimited(csv)[1][1]).toBe('line one\nline two');
  });

  it('the decoder holds no property schema of its own', async () => {
    const source = await import('node:fs/promises')
      .then((fs) => fs.readFile(
        'supabase/functions/_shared/builderStock/notionRecordMap.pure.ts', 'utf8'));
    for (const column of ['address_line', 'availability_status', 'builder_stock_items', 'price']) {
      expect(source).not.toContain(column);
    }
  });
});

// ===========================================================================
// TEST H — the other URL formats still behave
// ===========================================================================

describe('TEST H — non-Notion sources are untouched', () => {
  it.each([
    ['text/html', 'https://acme.example/stock', 'markup'],
    ['application/pdf', 'https://acme.example/stock.pdf', 'pdf'],
    ['text/csv', 'https://acme.example/stock.csv', 'delimited'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'https://acme.example/stock.xlsx', 'spreadsheet'],
  ])('%s is still classified the same way', (declared, url, kind) => {
    expect(classifyFetchedSource({
      detectedMime: declared === 'text/html' || declared === 'text/csv' ? 'text/plain' : declared,
      declaredContentType: declared,
      finalUrl: url,
      looksLikeHtml: declared === 'text/html',
    }).kind).toBe(kind);
  });

  it('an ordinary HTML stock table still reads without any Notion path', () => {
    const html = '<html><body><table>'
      + '<tr><th>Lot</th><th>Suburb</th><th>Price</th></tr>'
      + '<tr><td>7</td><td>Wollert</td><td>$705,000</td></tr>'
      + '</table></body></html>';
    const [matrix] = extractHtmlTables(html);
    const records = importedRecords(matrix);
    expect(records).toHaveLength(1);
    expect(records[0].suburb).toBe('Wollert');
  });

  it('recovery is only ever attempted for a Notion host', () => {
    expect(extractNotionPageId('https://acme.example/stock', '<html></html>')).toBeNull();
  });
});
