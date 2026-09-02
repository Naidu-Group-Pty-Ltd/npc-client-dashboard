/**
 * Builder stock — URL sources, the formats they arrive in, and deletion.
 *
 * The SSRF cases are the reason this file exists. Everything else here can be
 * fixed after the fact; a stock-list importer that will fetch
 * `http://169.254.169.254/` is a credential leak, so the refusals are asserted
 * at both layers: the scheme policy that never reaches a socket, and the
 * address guard the fetch applies to the original URL and to every redirect.
 */
import { describe, expect, it } from 'vitest';
import {
  isNotionUrl, normaliseStockSourceUrl, snapshotFileName, stockSourceDisplayName,
  NOTION_NOT_PUBLIC_MESSAGE,
  type NormalisedSourceUrl, type RejectedSourceUrl,
} from '../../../supabase/functions/_shared/builderStock/urlSource.pure';

import {
  isPrivateOrReservedAddress, assertPublicUrl,
} from '../../../supabase/functions/_shared/ssrfGuard';
import {
  assessNotionReadability, extractHtmlTables, extractHtmlTitle, extractNotionGridTables,
  extractReadableText, readHtmlSource, stripChrome,
} from '../../../supabase/functions/_shared/builderStock/htmlSource.pure';
import {
  readOpenDocument, readPresentation, readRichText, readStructured, readXml,
} from '../../../supabase/functions/_shared/builderStock/otherFormats.pure';
import {
  classifyFetchedSource, classifyStockFile, stockFileAcceptAttribute, STOCK_EXTENSIONS,
} from '../../../supabase/functions/_shared/builderStock/fileTypes.pure';
import { keyRowsByHeader } from '../../../supabase/functions/_shared/builderStock/table.pure';
import { normaliseStockRow } from '../../../supabase/functions/_shared/builderStock/normalise.pure';
import {
  describeSourceDeletion, itemsToArchiveOnSourceDelete, shouldArchiveOnSourceDelete,
} from '../../../supabase/functions/_shared/builderStock/sourceDeletion.pure';

/**
 * This repo compiles `src/` with `strict: false`, which switches off
 * discriminated-union narrowing — `if (!result.ok)` does not give TypeScript
 * the rejected branch here the way it does under the edge functions' own
 * strict config. These two helpers assert the branch instead.
 */
function expectRefused(candidate: string): RejectedSourceUrl {
  const result = normaliseStockSourceUrl(candidate);
  expect(result.ok).toBe(false);
  return result as RejectedSourceUrl;
}

function expectAccepted(candidate: string): NormalisedSourceUrl {
  const result = normaliseStockSourceUrl(candidate);
  expect(result.ok).toBe(true);
  return result as NormalisedSourceUrl;
}

/** Rows the way the pipeline produces them: extract → key → normalise. */
function importRows(matrices: string[][][]) {
  const rows: Array<Record<string, unknown>> = [];
  for (const matrix of matrices) {
    const keyed = keyRowsByHeader(matrix);
    if (keyed) rows.push(...keyed.rows);
  }
  return rows.map(normaliseStockRow).filter((row) => row !== null);
}

// ===========================================================================
// TEST G — SSRF
// ===========================================================================

describe('TEST G — SSRF: schemes that never reach a socket', () => {
  it.each([
    ['file:///etc/passwd'],
    ['ftp://example.com/stock.csv'],
    ['data:text/csv;base64,QQ=='],
    ['javascript:alert(1)'],
    ['blob:https://example.com/abc'],
    ['ws://example.com'],
    ['gopher://example.com'],
    ['mailto:sales@example.com'],
  ])('refuses %s', (candidate: string) => {
    // The refusal is a sentence the builder can act on, not "invalid URL".
    expect(expectRefused(candidate).reason.length).toBeGreaterThan(10);
  });

  it('accepts http and https, and assumes https for a bare host', () => {
    expectAccepted('https://acme.example/stock.csv');
    expectAccepted('http://acme.example/stock.csv');
    expect(expectAccepted('acme.example/stock.csv').url.startsWith('https://')).toBe(true);
  });

  it('strips credentials embedded in the URL rather than forwarding them', () => {
    const result = expectAccepted('https://user:secret@acme.example/stock.csv');
    expect(result.url).not.toContain('secret');
    expect(result.url).not.toContain('user');
  });

  it('a scheme cannot be smuggled in by omitting it', () => {
    // "javascript:..." has a scheme, so it is refused rather than prefixed.
    expectRefused('javascript:alert(1)');
  });
});

describe('TEST G — SSRF: address space the fetch refuses', () => {
  it.each([
    ['127.0.0.1'], ['127.5.5.5'], ['0.0.0.0'],
    ['10.0.0.7'], ['172.16.4.4'], ['172.31.255.1'], ['192.168.1.1'],
    ['169.254.169.254'], ['169.254.0.1'],
    ['100.64.0.1'], ['192.0.0.1'], ['198.18.0.1'],
    ['224.0.0.1'], ['240.0.0.1'],
    ['::1'], ['fe80::1'], ['fc00::1'], ['::ffff:127.0.0.1'], ['::ffff:169.254.169.254'],
  ])('treats %s as private or reserved', (address) => {
    expect(isPrivateOrReservedAddress(address)).toBe(true);
  });

  it('allows ordinary public addresses', () => {
    expect(isPrivateOrReservedAddress('8.8.8.8')).toBe(false);
    expect(isPrivateOrReservedAddress('2404:6800:4006::200e')).toBe(false);
  });

  const publicDns = async () => ['93.184.216.34'];
  const privateDns = async () => ['127.0.0.1'];
  const metadataDns = async () => ['169.254.169.254'];

  it('refuses localhost by name, before DNS', async () => {
    await expect(assertPublicUrl('http://localhost/stock.csv', publicDns))
      .rejects.toThrow(/private|internal/i);
    await expect(assertPublicUrl('http://something.local/stock.csv', publicDns))
      .rejects.toThrow(/private|internal/i);
    await expect(assertPublicUrl('http://svc.internal/stock.csv', publicDns))
      .rejects.toThrow(/private|internal/i);
  });

  it('refuses a public hostname that RESOLVES to a private address', async () => {
    await expect(assertPublicUrl('https://rebind.example/stock.csv', privateDns))
      .rejects.toThrow(/private|internal/i);
  });

  it('refuses a public hostname that resolves to the metadata endpoint', async () => {
    await expect(assertPublicUrl('https://metadata.example/', metadataDns))
      .rejects.toThrow(/private|internal/i);
  });

  it('refuses a literal private IP in the URL', async () => {
    await expect(assertPublicUrl('http://127.0.0.1:8000/stock.csv', publicDns))
      .rejects.toThrow(/private|internal/i);
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data/', publicDns))
      .rejects.toThrow(/private|internal/i);
  });

  it('allows a genuinely public destination', async () => {
    const url = await assertPublicUrl('https://acme.example/stock.csv', publicDns);
    expect(url.hostname).toBe('acme.example');
  });

  /**
   * A redirect is re-checked with the SAME call the original URL went through,
   * which is what makes "public URL redirects to a private IP" refusable. The
   * fetch loop applies it per hop; this asserts the guard behind it.
   */
  it('refuses a redirect target that lands on a private address', async () => {
    const hop1 = await assertPublicUrl('https://acme.example/stock', publicDns);
    expect(hop1.hostname).toBe('acme.example');
    await expect(assertPublicUrl('http://192.168.0.5/internal', publicDns))
      .rejects.toThrow(/private|internal/i);
  });
});

// ===========================================================================
// TEST D — an HTML stock list
// ===========================================================================

describe('TEST D — HTML stock list', () => {
  const page = `<!doctype html>
<html><head><title>Acme Homes — March Stock</title></head>
<body>
  <nav class="site-header"><a href="/">Home</a><a href="/contact">Contact</a></nav>
  <div class="cookie-banner">We use cookies. <button>Accept</button></div>
  <script>window.analytics = 'tracked'; document.write('Lot 999');</script>
  <style>.x { color: red }</style>
  <h1>March stock</h1>
  <table>
    <thead><tr><th>Lot</th><th>Address</th><th>Suburb</th><th>State</th><th>Beds</th><th>Price</th><th>Status</th></tr></thead>
    <tbody>
      <tr><td>108</td><td>12 Wattle St</td><td>Tarneit</td><td>VIC</td><td>4</td><td>$749,000</td><td>Available</td></tr>
      <tr><td>109</td><td>14 Wattle St</td><td>Tarneit</td><td>VIC</td><td>3</td><td>From $699,000</td><td>Sold</td></tr>
    </tbody>
  </table>
  <footer class="site-footer">© Acme</footer>
</body></html>`;

  it('extracts the table and imports it through the normal path', () => {
    const { tables, title } = readHtmlSource(page, 'https://acme.example/stock');
    expect(title).toBe('Acme Homes — March Stock');

    const rows = importRows(tables);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.lot_number).toBe('108');
    expect(rows[0]?.suburb).toBe('Tarneit');
    expect(rows[0]?.state).toBe('VIC');
    expect(rows[0]?.price).toBe(749000);
    expect(rows[0]?.availability_status).toBe('available');
    // The wording of a "from" price survives, as it does for a spreadsheet.
    expect(rows[1]?.price_display).toBe('From $699,000');
    expect(rows[1]?.availability_status).toBe('sold');
  });

  it('drops navigation, cookie banners, scripts and styles', () => {
    const stripped = stripChrome(page);
    expect(stripped).not.toContain('window.analytics');
    expect(stripped).not.toContain('color: red');
    expect(stripped).not.toContain('We use cookies');
    expect(stripped).not.toContain('Contact');
    // A script that writes a lot number must not become a property.
    expect(stripped).not.toContain('Lot 999');
    // …and the table survives all of that.
    expect(stripped).toContain('12 Wattle St');
  });

  it('never executes anything it reads', () => {
    // The readable text is text. There is no evaluation step to assert around:
    // the only thing that touches the markup is string replacement.
    const text = extractReadableText(page);
    expect(text).toContain('12 Wattle St');
    expect(text).not.toContain('window.analytics');
  });

  it('reads a page whose rows are in the markup without a <thead>', () => {
    const bare = `<table>
      <tr><td>Lot</td><td>Suburb</td><td>Price</td></tr>
      <tr><td>7</td><td>Truganina</td><td>620000</td></tr>
    </table>`;
    const rows = importRows(extractHtmlTables(bare));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.suburb).toBe('Truganina');
    expect(rows[0]?.price).toBe(620000);
  });

  it('takes the title from og:title or <h1> when there is no <title>', () => {
    expect(extractHtmlTitle('<meta property="og:title" content="Estate stock"/>')).toBe('Estate stock');
    expect(extractHtmlTitle('<h1>Release 4</h1>')).toBe('Release 4');
    expect(extractHtmlTitle('<p>nothing</p>')).toBeNull();
  });
});

// ===========================================================================
// TEST E / F — Notion
// ===========================================================================

describe('TEST E — a public Notion page', () => {
  const notionPage = `<!doctype html><html><head><title>Riverbend Stock</title></head><body>
    <div class="notion-page-content">
      <div class="notion-collection">
        <div class="notion-collection-item">
          <div class="notion-collection-cell">Lot</div>
          <div class="notion-collection-cell">Suburb</div>
          <div class="notion-collection-cell">Beds</div>
          <div class="notion-collection-cell">Price</div>
        </div>
        <div class="notion-collection-item">
          <div class="notion-collection-cell">21</div>
          <div class="notion-collection-cell">Point Cook</div>
          <div class="notion-collection-cell">4</div>
          <div class="notion-collection-cell">$812,000</div>
        </div>
        <div class="notion-collection-item">
          <div class="notion-collection-cell">22</div>
          <div class="notion-collection-cell">Point Cook</div>
          <div class="notion-collection-cell">3</div>
          <div class="notion-collection-cell">$754,500</div>
        </div>
      </div>
    </div>
  </body></html>`;

  it('recognises Notion hosts', () => {
    expect(isNotionUrl('https://www.notion.so/Stock-abc123')).toBe(true);
    expect(isNotionUrl('https://acme.notion.site/March-Stock')).toBe(true);
    expect(isNotionUrl('https://acme.example/stock')).toBe(false);
  });

  it("extracts Notion's own grid, which is not a <table>", () => {
    const rows = importRows(extractNotionGridTables(notionPage));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.lot_number).toBe('21');
    expect(rows[0]?.suburb).toBe('Point Cook');
    expect(rows[0]?.price).toBe(812000);
    expect(rows[1]?.bedrooms).toBe(3);
  });

  it('is judged readable, so no permission error is raised', () => {
    const text = extractReadableText(notionPage);
    expect(assessNotionReadability(notionPage, text).gated).toBe(false);
  });
});

describe('TEST F — a private or missing Notion page fails safely', () => {
  it.each([
    ['<html><body><div>You need access to this page</div></body></html>'],
    ['<html><body><div>Request access</div></body></html>'],
    ['<html><body><div>Log in to Notion</div></body></html>'],
    ['<html><body><div>This content does not exist</div></body></html>'],
  ])('detects the gate shell', (html) => {
    const assessment = assessNotionReadability(html, extractReadableText(html));
    expect(assessment.gated).toBe(true);
  });

  /**
   * This assertion used to read `.gated === true`, and that is precisely the
   * production defect: every published Notion page returns an empty
   * client-rendered shell, so the rule reported that pages shared to the whole
   * web were private. A shell is a shell — the content arrives from Notion's
   * public endpoints afterwards, which `builderStockNotion.test.ts` covers.
   */
  it('does not call an empty client-rendered shell gated', () => {
    const shell = '<html><body><div id="notion-app"></div></body></html>';
    const assessment = assessNotionReadability(shell, extractReadableText(shell));
    expect(assessment.gated).toBe(false);
    expect(assessment.clientRendered).toBe(true);
    expect(assessment.state).toBe('shell');
  });

  it('creates no rows from a gated page', () => {
    const html = '<html><body><div>You need access to this page</div></body></html>';
    expect(importRows(extractHtmlTables(html))).toHaveLength(0);
    expect(importRows(extractNotionGridTables(html))).toHaveLength(0);
  });

  it('has one wording for the refusal, shared by both paths', () => {
    expect(NOTION_NOT_PUBLIC_MESSAGE).toMatch(/not publicly accessible/i);
    expect(NOTION_NOT_PUBLIC_MESSAGE).toMatch(/upload/i);
  });
});

// ===========================================================================
// TEST C — what a URL actually returned decides how it is read
// ===========================================================================

describe('TEST C — a direct document URL', () => {
  it('reads a PDF by its bytes whatever the link says', () => {
    const classification = classifyFetchedSource({
      detectedMime: 'application/pdf',
      declaredContentType: 'application/octet-stream',
      finalUrl: 'https://acme.example/download?id=7',
    });
    expect(classification.kind).toBe('pdf');
  });

  it('reads a spreadsheet served from an extensionless share link', () => {
    expect(classifyFetchedSource({
      detectedMime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      declaredContentType: 'application/octet-stream',
      finalUrl: 'https://docs.example/d/abc/export?format=xlsx',
    }).kind).toBe('spreadsheet');
  });

  it("believes the server's Content-Type when the bytes are just text", () => {
    expect(classifyFetchedSource({
      detectedMime: 'text/plain', declaredContentType: 'text/csv',
      finalUrl: 'https://acme.example/export',
    }).kind).toBe('delimited');

    expect(classifyFetchedSource({
      detectedMime: 'text/csv', declaredContentType: 'text/html',
      finalUrl: 'https://acme.example/stock',
    }).kind).toBe('markup');

    expect(classifyFetchedSource({
      detectedMime: 'text/plain', declaredContentType: 'application/json',
      finalUrl: 'https://acme.example/api/stock',
    }).kind).toBe('structured');
  });

  it('falls back to the path extension, then to the body shape', () => {
    expect(classifyFetchedSource({
      detectedMime: 'text/plain', declaredContentType: '',
      finalUrl: 'https://acme.example/stock.csv',
    }).kind).toBe('delimited');

    expect(classifyFetchedSource({
      detectedMime: 'text/plain', declaredContentType: '',
      finalUrl: 'https://acme.example/stock', looksLikeHtml: true,
    }).kind).toBe('markup');
  });

  /**
   * The failure this ordering exists for: a link that ends `.xlsx` but serves
   * an HTML login page must be read as the page it is, not as a spreadsheet.
   */
  it('does not trust an extension over the response', () => {
    expect(classifyFetchedSource({
      detectedMime: 'text/plain', declaredContentType: 'text/html',
      finalUrl: 'https://acme.example/stock.xlsx', looksLikeHtml: true,
    }).kind).toBe('markup');
  });

  it('names a snapshot after the URL and what was actually downloaded', () => {
    expect(snapshotFileName('https://acme.example/files/march-stock.aspx', 'xlsx'))
      .toBe('march-stock.xlsx');
    expect(snapshotFileName('https://acme.example/', 'html')).toBe('acme.example.html');
  });

  it('labels a source with its title, or a shortened URL', () => {
    expect(stockSourceDisplayName('https://acme.example/a/b/march', 'March Stock')).toBe('March Stock');
    expect(stockSourceDisplayName('https://www.acme.example/a/b/march')).toBe('acme.example/…/march');
    expect(stockSourceDisplayName(`https://acme.example/${'x'.repeat(200)}`).length)
      .toBeLessThanOrEqual(90);
  });
});

// ===========================================================================
// TEST B — the additional file formats
// ===========================================================================

describe('TEST B — OpenDocument (.ods / .odt)', () => {
  const contentXml = `<?xml version="1.0"?><office:document-content>
    <office:body><office:spreadsheet>
      <table:table table:name="Stock">
        <table:table-row>
          <table:table-cell><text:p>Lot</text:p></table:table-cell>
          <table:table-cell><text:p>Suburb</text:p></table:table-cell>
          <table:table-cell><text:p>Beds</text:p></table:table-cell>
          <table:table-cell><text:p>Price</text:p></table:table-cell>
        </table:table-row>
        <table:table-row>
          <table:table-cell><text:p>301</text:p></table:table-cell>
          <table:table-cell><text:p>Werribee</text:p></table:table-cell>
          <table:table-cell><text:p>4</text:p></table:table-cell>
          <table:table-cell><text:p>$690,000</text:p></table:table-cell>
        </table:table-row>
      </table:table>
    </office:spreadsheet></office:body></office:document-content>`;

  it('reads the grid and imports it', () => {
    const { tables } = readOpenDocument(contentXml);
    const rows = importRows(tables);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lot_number).toBe('301');
    expect(rows[0]?.suburb).toBe('Werribee');
    expect(rows[0]?.price).toBe(690000);
  });

  it('expands repeated cells so later columns do not shift', () => {
    const withGap = `<table:table>
      <table:table-row>
        <table:table-cell><text:p>Lot</text:p></table:table-cell>
        <table:table-cell table:number-columns-repeated="2"/>
        <table:table-cell><text:p>Price</text:p></table:table-cell>
      </table:table-row>
      <table:table-row>
        <table:table-cell><text:p>12</text:p></table:table-cell>
        <table:table-cell table:number-columns-repeated="2"/>
        <table:table-cell><text:p>500000</text:p></table:table-cell>
      </table:table-row>
    </table:table>`;
    const { tables } = readOpenDocument(withGap);
    expect(tables[0][0]).toEqual(['Lot', '', '', 'Price']);
    const rows = importRows(tables);
    expect(rows[0]?.price).toBe(500000);
  });

  it('reads an .odt as prose when it has no grid', () => {
    const odt = `<office:document-content><office:body><office:text>
      <text:h>Riverbend release</text:h>
      <text:p>Lot 4 at 9 Iris Way, Tarneit VIC 3029 — 4 bed, $712,000.</text:p>
    </office:text></office:body></office:document-content>`;
    const { tables, text } = readOpenDocument(odt);
    expect(tables).toHaveLength(0);
    expect(text).toContain('9 Iris Way');
  });
});

describe('TEST B — PowerPoint (.pptx)', () => {
  const slide = `<p:sld><p:cSld><p:spTree>
    <a:tbl>
      <a:tr>
        <a:tc><a:txBody><a:p><a:r><a:t>Lot</a:t></a:r></a:p></a:txBody></a:tc>
        <a:tc><a:txBody><a:p><a:r><a:t>Suburb</a:t></a:r></a:p></a:txBody></a:tc>
        <a:tc><a:txBody><a:p><a:r><a:t>Price</a:t></a:r></a:p></a:txBody></a:tc>
      </a:tr>
      <a:tr>
        <a:tc><a:txBody><a:p><a:r><a:t>55</a:t></a:r></a:p></a:txBody></a:tc>
        <a:tc><a:txBody><a:p><a:r><a:t>Clyde North</a:t></a:r></a:p></a:txBody></a:tc>
        <a:tc><a:txBody><a:p><a:r><a:t>$845,000</a:t></a:r></a:p></a:txBody></a:tc>
      </a:tr>
    </a:tbl>
  </p:spTree></p:cSld></p:sld>`;

  it('reads a slide table and imports it', () => {
    const { tables } = readPresentation([slide]);
    const rows = importRows(tables);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lot_number).toBe('55');
    expect(rows[0]?.suburb).toBe('Clyde North');
    expect(rows[0]?.price).toBe(845000);
  });

  it('falls back to slide text when there is no table', () => {
    const textOnly = `<p:sld><a:p><a:r><a:t>Lot 9, 3 Fern Ct, Officer</a:t></a:r></a:p></p:sld>`;
    const { tables, text } = readPresentation([textOnly]);
    expect(tables).toHaveLength(0);
    expect(text).toContain('3 Fern Ct');
  });
});

describe('TEST B — RTF', () => {
  it('recovers a tab-separated schedule', () => {
    const rtf = String.raw`{\rtf1\ansi\deff0{\fonttbl{\f0 Calibri;}}
\trowd Lot\cell Suburb\cell Price\cell\row
\trowd 88\cell Cranbourne\cell 655000\cell\row
}`;
    const text = readRichText(rtf);
    expect(text).toContain('Lot\tSuburb\tPrice');
    const rows = importRows([text.split('\n').map((line) => line.split('\t'))]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.suburb).toBe('Cranbourne');
    expect(rows[0]?.price).toBe(655000);
  });

  it('drops the font and colour tables rather than reading them as content', () => {
    const rtf = String.raw`{\rtf1{\fonttbl{\f0 Calibri;}{\f1 Arial;}}{\colortbl;\red255\green0\blue0;}\par Lot 3 Tarneit\par}`;
    const text = readRichText(rtf);
    expect(text).not.toContain('Calibri');
    expect(text).not.toContain('Arial');
    expect(text).toContain('Lot 3 Tarneit');
  });

  it('decodes escaped characters', () => {
    expect(readRichText(String.raw`{\rtf1 caf\'e9 舒 ? done}`)).toContain('café');
  });
});

describe('TEST B — JSON and XML', () => {
  it('imports an array of property objects', () => {
    const json = JSON.stringify([
      { lot_number: '17', suburb: 'Wollert', bedrooms: 4, price: '$705,000', status: 'Available' },
      { lot_number: '18', suburb: 'Wollert', bedrooms: 3, price: 'POA', status: 'Sold' },
    ]);
    const { rows } = readStructured(json, 'json');
    const normalised = rows.map(normaliseStockRow).filter(Boolean);
    expect(normalised).toHaveLength(2);
    expect(normalised[0]?.suburb).toBe('Wollert');
    expect(normalised[0]?.price).toBe(705000);
    // "POA" is not a number and must not become one.
    expect(normalised[1]?.price).toBeNull();
    expect(normalised[1]?.price_display).toBe('POA');
  });

  it('finds the list nested under a wrapper object', () => {
    const json = JSON.stringify({
      generated: '2026-03-01',
      properties: [{ lot: '2', suburb: 'Kalkallo', price: 640000 }],
    });
    const { rows } = readStructured(json, 'json');
    expect(rows).toHaveLength(1);
    expect(normaliseStockRow(rows[0])?.suburb).toBe('Kalkallo');
  });

  it('flattens one level so a nested address is not lost', () => {
    const json = JSON.stringify([
      { reference: 'A-1', address: { suburb: 'Officer', state: 'VIC', postcode: '3809' } },
    ]);
    const { rows } = readStructured(json, 'json');
    const row = normaliseStockRow(rows[0]);
    expect(row?.suburb).toBe('Officer');
    expect(row?.state).toBe('VIC');
    expect(row?.postcode).toBe('3809');
  });

  it('imports repeated XML records', () => {
    const xml = `<?xml version="1.0"?><stock>
      <property><lot>41</lot><suburb>Donnybrook</suburb><price>688000</price></property>
      <property><lot>42</lot><suburb>Donnybrook</suburb><price>702000</price></property>
    </stock>`;
    const { rows } = readXml(xml);
    expect(rows).toHaveLength(2);
    const normalised = rows.map(normaliseStockRow).filter(Boolean);
    expect(normalised[1]?.lot_number).toBe('42');
    expect(normalised[1]?.price).toBe(702000);
  });

  it('hands malformed JSON to the model rather than failing the import', () => {
    const { rows, text } = readStructured('{ not json ', 'json');
    expect(rows).toHaveLength(0);
    expect(text).toContain('not json');
  });
});

describe('TEST A + B — the picker and the classifier agree', () => {
  it('still routes every original format', () => {
    expect(classifyStockFile('s.csv', 'text/csv').kind).toBe('delimited');
    expect(classifyStockFile('s.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').kind).toBe('spreadsheet');
    expect(classifyStockFile('s.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document').kind).toBe('word');
    expect(classifyStockFile('s.pdf', 'application/pdf').kind).toBe('pdf');
    expect(classifyStockFile('s.jpg', 'image/jpeg').kind).toBe('image');
    expect(classifyStockFile('s.xls', null, 'ambiguous_legacy_office_container').kind).toBe('spreadsheet');
    expect(classifyStockFile('s.doc', null, 'ambiguous_legacy_office_container').kind).toBe('word');
  });

  it('routes each newly claimed format', () => {
    // OpenDocument and pptx sniff as an ambiguous zip; the extension decides.
    expect(classifyStockFile('s.ods', null, 'unsupported_or_ambiguous_zip').kind).toBe('opendocument');
    expect(classifyStockFile('s.odt', null, 'unsupported_or_ambiguous_zip').kind).toBe('opendocument');
    expect(classifyStockFile('s.pptx', null, 'unsupported_or_ambiguous_zip').kind).toBe('presentation');
    // Text-shaped formats sniff as text/plain.
    expect(classifyStockFile('s.html', 'text/plain').kind).toBe('markup');
    expect(classifyStockFile('s.htm', 'text/plain').kind).toBe('markup');
    expect(classifyStockFile('s.json', 'text/plain').kind).toBe('structured');
    expect(classifyStockFile('s.xml', 'text/plain').kind).toBe('structured');
    expect(classifyStockFile('s.rtf', 'text/plain').kind).toBe('richtext');
  });

  it('offers exactly the formats it can read, and no more', () => {
    const accept = stockFileAcceptAttribute();
    for (const extension of Object.values(STOCK_EXTENSIONS).flat()) {
      expect(accept).toContain(`.${extension}`);
    }
    for (const forbidden of ['.exe', '.sh', '.bat', '.msi', '.zip', '.dmg', '.jar']) {
      expect(accept).not.toContain(forbidden);
    }
  });

  it('still refuses executables and unreadable archives', () => {
    expect(classifyStockFile('setup.exe', null, 'executable_signature').kind).toBe('unsupported');
    expect(classifyStockFile('bundle.zip', null, 'unsupported_or_ambiguous_zip').kind).toBe('unsupported');
    expect(classifyStockFile('thing.xyz', null, 'unknown_content_signature').kind).toBe('unsupported');
  });
});

// ===========================================================================
// TEST I — deleting a source
// ===========================================================================

describe('TEST I — delete semantics', () => {
  const march = 'upload-march';
  const april = 'upload-april';

  it('deactivates stock the deleted source is CURRENTLY supplying', () => {
    expect(shouldArchiveOnSourceDelete(
      { id: 'a', upload_id: march, first_upload_id: march, lifecycle_status: 'active' },
      march,
    )).toBe(true);
  });

  it('keeps stock a NEWER source has since re-supplied', () => {
    // Imported in March, updated by April's list. Deleting March must not
    // remove a property April is still offering.
    expect(shouldArchiveOnSourceDelete(
      { id: 'b', upload_id: april, first_upload_id: march, lifecycle_status: 'active' },
      march,
    )).toBe(false);
  });

  it('leaves unrelated stock alone', () => {
    expect(shouldArchiveOnSourceDelete(
      { id: 'c', upload_id: 'upload-other', first_upload_id: 'upload-other' },
      march,
    )).toBe(false);
  });

  it('is a no-op for stock already archived', () => {
    expect(shouldArchiveOnSourceDelete(
      { id: 'd', upload_id: march, lifecycle_status: 'archived' }, march,
    )).toBe(false);
  });

  it('selects exactly the right ids from a mixed set', () => {
    const items = [
      { id: 'current', upload_id: march, first_upload_id: march, lifecycle_status: 'active' },
      { id: 'resupplied', upload_id: april, first_upload_id: march, lifecycle_status: 'active' },
      { id: 'unrelated', upload_id: 'other', first_upload_id: 'other', lifecycle_status: 'active' },
      { id: 'already-archived', upload_id: march, lifecycle_status: 'archived' },
    ];
    expect(itemsToArchiveOnSourceDelete(items, march)).toEqual(['current']);
  });

  it('says what will happen, in counts and never in client names', () => {
    const message = describeSourceDeletion({
      archived: 3, retainedBecauseResupplied: 2, affectedSelections: 1,
    });
    expect(message).toContain('3 properties');
    expect(message).toContain('newer stock list');
    expect(message).toMatch(/selected for a buyer/);
    expect(message).toMatch(/kept/);
  });
});
