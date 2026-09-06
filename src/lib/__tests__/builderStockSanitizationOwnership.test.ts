/**
 * Builder stock — the sanitization stage's keys survive every store path.
 *
 * WHY THIS IS A SOURCE SCAN AND NOT A UNIT TEST. The defect was not a wrong
 * rule; it was FOUR independent writers of one column, three of which had never
 * heard of a key the fourth writes. `source_detail` is upserted whole on
 * `(stock_item_id, source_stage, source_reference)`, so any new store path
 * reintroduces the bug by simply not knowing about it — and it reintroduces it
 * silently, because the row still looks complete and the card just goes blank.
 *
 * So the check is on the SHAPE of the code: a writer that stores a ready,
 * builder-supplied row must ask `carriedSanitizationFor` what to put back. The
 * two exclusions are stated as facts about the rows, not as a list of files.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(process.cwd(), 'supabase', 'functions');
const CONFLICT = "onConflict: 'stock_item_id,source_stage,source_reference'";
const UPSERT = "builder_stock_item_images').upsert(";

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (entry.endsWith('.ts')) found.push(path);
  }
  return found;
}

/** Every upsert body written against that conflict key, with its file. */
function storeSites(): Array<{ file: string; body: string }> {
  const sites: Array<{ file: string; body: string }> = [];
  for (const file of sourceFiles(ROOT)) {
    const source = readFileSync(file, 'utf8');
    let from = 0;
    for (;;) {
      const at = source.indexOf(CONFLICT, from);
      if (at < 0) break;
      const opened = source.lastIndexOf(UPSERT, at);
      if (opened >= 0) {
        sites.push({ file: file.slice(ROOT.length + 1), body: source.slice(opened, at) });
      }
      from = at + CONFLICT.length;
    }
  }
  return sites;
}

/** A row this table's sanitization stage writes to: builder-supplied and READY. */
function isSourceSuppliedReady(body: string): boolean {
  const supplied = body.includes("source_stage: 'uploaded_document'")
    || body.includes('source_stage: SOURCE_SUPPLIED_STAGE');
  return supplied && body.includes("processing_status: 'ready'");
}

describe('every store path preserves the sanitization record', () => {
  const sites = storeSites();

  it('finds the writers at all, so a rename cannot make this vacuous', () => {
    expect(sites.length).toBeGreaterThanOrEqual(9);
    expect(new Set(sites.map((site) => site.file)).size).toBeGreaterThanOrEqual(4);
  });

  it('carries it forward wherever a ready builder-supplied row is stored', () => {
    const owing = sites.filter((site) => isSourceSuppliedReady(site.body));
    // Four today: the importer, the downloaded-asset batch,
    // `storeSourceImageBytes` and the operator's own attach.
    expect(owing.length).toBeGreaterThanOrEqual(4);

    const missing = owing
      .filter((site) => !site.body.includes('...carried'))
      .map((site) => site.file);
    expect(missing).toEqual([]);
  });

  /*
   * The two kinds of row that own no such record, stated so the exclusions stay
   * decisions rather than gaps: a location or web-search row is never
   * sanitized, and a row recording a fetch that FAILED holds no bytes for a
   * repair to be about.
   */
  it('does not demand it of rows that hold no repairable bytes', () => {
    const exempt = sites.filter((site) => !isSourceSuppliedReady(site.body));
    expect(exempt.length).toBeGreaterThan(0);
    for (const site of exempt) {
      const locationOrWeb = site.body.includes("source_stage: 'google_maps'")
        || site.body.includes("source_stage: 'internet_search'")
        || site.body.includes('source_stage: stage');
      const failedFetch = site.body.includes("processing_status: 'failed'");
      expect(locationOrWeb || failedFetch,
        `${site.file} stores a row this test cannot classify`).toBe(true);
    }
  });
});
