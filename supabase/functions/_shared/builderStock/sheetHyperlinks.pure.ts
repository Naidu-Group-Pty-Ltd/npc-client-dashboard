/**
 * BUILDER STOCK — A SPREADSHEET CELL CAN SAY "Brochure" AND MEAN A URL.
 *
 * A stock list kept in Google Sheets carries its documents as HYPERLINKS: the
 * cell displays a label — `Brochure`, `Masterplan`, `Stage 6 - POS` — and the
 * address lives underneath it. Every CSV export, Google's own included, writes
 * the displayed value and throws the target away. Measured on a real builder
 * list: five link-bearing columns, 119 rows, and ZERO plain-text URLs anywhere
 * in the tab. Read as CSV alone, not one property has a builder source for
 * stage 1 to follow, and the whole ladder starts at its second rung.
 *
 * XLSX keeps them. SheetJS surfaces one as `cell.l.Target` beside the
 * displayed `cell.v`, and a labelled cell with no link — `N/A` — carries none,
 * so the two are distinguishable rather than inferred.
 *
 *
 * MEMBERSHIP DOES NOT MOVE. THIS ONLY ADDS COLUMNS.
 *
 * The exact requested gid remains the only thing that says which properties
 * exist: its CSV supplies the rows, their order and their values, and this
 * appends a URL column beside each link-bearing one. No row is added, removed
 * or reordered — asserted here rather than promised, because a workbook export
 * is the WHOLE workbook and letting it near membership is how another tab's
 * rows become a builder's stock.
 *
 * WHICH WORKSHEET, THOUGH. An XLSX export contains every tab and nothing in it
 * records the gid, so the worksheet has to be identified by what it CONTAINS.
 * Position is not identity: the requested tab is routinely not the first, and
 * a workbook's sheet order is not the order the tabs were created in. So each
 * worksheet is scored against the proven CSV and exactly one must win
 * decisively. Zero matches means the links are unavailable and the import
 * proceeds on the CSV alone; an ambiguous match means the same, because
 * borrowing a near-identical tab's links is precisely the failure this exists
 * to prevent.
 *
 * Pure: no IO, no clock, no network.
 */

/** One worksheet as the caller read it out of the workbook. */
export interface WorkbookSheet {
  name: string;
  /** Visible values, row-major, exactly as the grid renders them. */
  values: (string | null)[][];
  /** `[row][col]` hyperlink targets, sparse. Absent where the cell has none. */
  links: (string | null)[][];
}

export type WorksheetMatch =
  | { ok: true; sheet: WorkbookSheet; score: number }
  | { ok: false; reason: 'no_match' | 'ambiguous'; best: number; runnerUp: number };

/**
 * A cell as two grids can agree on it.
 *
 * A CSV export and an XLSX export of the same tab render the same value
 * slightly differently — thousands separators, a currency symbol, a trailing
 * space, casing in a heading. None of those is a different worksheet, and all
 * of them would break an equality test, so they are normalised away. Nothing
 * that could distinguish two REAL tabs is: digits, letters and their order all
 * survive.
 */
export function normaliseCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/\s+/g, ' ')
    .replace(/[$,]/g, '')
    .trim()
    .toLowerCase();
}

/** How much of the CSV this worksheet reproduces, cell for cell. */
export function worksheetScore(csv: string[][], sheet: WorkbookSheet): number {
  let compared = 0;
  let agreed = 0;
  const rows = Math.min(csv.length, 40);
  for (let r = 0; r < rows; r += 1) {
    const csvRow = csv[r] ?? [];
    const sheetRow = sheet.values[r] ?? [];
    for (let c = 0; c < csvRow.length; c += 1) {
      const want = normaliseCell(csvRow[c]);
      // Empty cells agree with everything, so they measure nothing.
      if (!want) continue;
      compared += 1;
      if (normaliseCell(sheetRow[c]) === want) agreed += 1;
    }
  }
  return compared === 0 ? 0 : agreed / compared;
}

/** A worksheet must reproduce almost all of the CSV to be the same tab. */
export const MATCH_FLOOR = 0.95;
/** …and beat every other worksheet by this much, or the answer is ambiguous. */
export const MATCH_MARGIN = 0.2;

/**
 * Which worksheet is the tab the gid named?
 *
 * NEVER BY POSITION. `SheetNames[0]` is not the requested tab, the workbook
 * carries no gid, and a sheet's index is not its identity. It is decided by
 * content, and it is decided decisively or not at all.
 */
export function matchWorksheet(csv: string[][], sheets: WorkbookSheet[]): WorksheetMatch {
  const scored = (sheets ?? [])
    .map((sheet) => ({ sheet, score: worksheetScore(csv, sheet) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const runnerUp = scored[1];
  const bestScore = best?.score ?? 0;
  const nextScore = runnerUp?.score ?? 0;

  if (!best || bestScore < MATCH_FLOOR) {
    return { ok: false, reason: 'no_match', best: bestScore, runnerUp: nextScore };
  }
  if (runnerUp && bestScore - nextScore < MATCH_MARGIN) {
    return { ok: false, reason: 'ambiguous', best: bestScore, runnerUp: nextScore };
  }
  return { ok: true, sheet: best.sheet, score: bestScore };
}

/** The suffix a resolved link column carries. */
export const LINK_COLUMN_SUFFIX = ' URL';

export interface HyperlinkMerge {
  matrix: string[][];
  /** Headings whose links were resolved, in the order they were added. */
  columnsAdded: string[];
  linksResolved: number;
}

/**
 * Put each row's own links beside it, and never beside another's.
 *
 * A link is read from the worksheet cell at THIS row and THIS column and
 * written into a new column on THIS row. There is no lookup by lot, by
 * address, by design or by anything else two rows could share — which is what
 * makes two products on one lot safe by construction rather than by a rule
 * that has to remember them.
 *
 * A column is added only where at least one row actually carries a link, so a
 * sheet of plain labels gains nothing and reads exactly as it did.
 */
export function mergeHyperlinkColumns(
  csv: string[][],
  sheet: WorkbookSheet,
): HyperlinkMerge {
  const header = csv[0] ?? [];
  const body = csv.slice(1);

  const linkColumns: number[] = [];
  for (let c = 0; c < header.length; c += 1) {
    const carries = body.some((_row, r) => !!sheet.links[r + 1]?.[c]);
    if (carries) linkColumns.push(c);
  }
  if (!linkColumns.length) {
    return { matrix: csv.map((row) => [...row]), columnsAdded: [], linksResolved: 0 };
  }

  const added = linkColumns.map((c) => `${header[c] ?? `Column ${c + 1}`}${LINK_COLUMN_SUFFIX}`);
  const out: string[][] = [[...header, ...added]];
  let linksResolved = 0;

  for (let r = 0; r < body.length; r += 1) {
    const row = [...body[r]];
    for (const c of linkColumns) {
      const target = sheet.links[r + 1]?.[c] ?? '';
      if (target) linksResolved += 1;
      row.push(target);
    }
    out.push(row);
  }

  return { matrix: out, columnsAdded: added, linksResolved };
}

/**
 * THE TARGET OF A CELL, HOWEVER THE BUILDER WROTE IT.
 *
 * A spreadsheet stores "this text points somewhere" two different ways, and
 * the reader only ever knew one of them.
 *
 *   the relationship   the cell carries a link record; SheetJS surfaces it as
 *                      `cell.l.Target`. This is what Sheets and Excel write
 *                      when somebody uses Insert > Link.
 *
 *   the formula        the cell IS `=HYPERLINK("…","Brochure")`. There is no
 *                      link record at all — the target is an argument inside
 *                      `cell.f`, and `cell.l` is null.
 *
 * Proved by round-trip through the reader this runtime already loads: a
 * relationship survives as `l.Target`, a HYPERLINK formula survives only as
 * `f`, and plain text carries neither. Reading just the first silently drops
 * every brochure a builder typed as a formula — which is an ordinary way to
 * write one, and indistinguishable on screen from the other.
 *
 * ONLY http(s) IS A SOURCE. A formula can name anything — a local file, an
 * anchor within the workbook, a mail link — and none of those is a document
 * this pipeline can open. Anything else answers null rather than being passed
 * downstream to fail later with a worse message.
 */
export function hyperlinkTargetOf(cell: {
  link?: string | null; formula?: string | null;
}): string | null {
  const relationship = typeof cell.link === 'string' ? cell.link.trim() : '';
  if (relationship && /^https?:\/\//i.test(relationship)) return relationship;

  const formula = typeof cell.formula === 'string' ? cell.formula : '';
  if (!formula) return null;

  /*
   * The first argument of the outermost HYPERLINK. Excel escapes a quote
   * inside a string by doubling it, so the capture runs to the first quote
   * that is not doubled and the pairs are collapsed afterwards.
   */
  const match = formula.match(/\bHYPERLINK\s*\(\s*"((?:[^"]|"")*)"/i);
  if (!match) return null;
  const target = match[1].replace(/""/g, '"').trim();
  return /^https?:\/\//i.test(target) ? target : null;
}

/** What the import may honestly say about the links it did or did not get. */
export type HyperlinkAvailability =
  /** The workbook was read and this tab's links are on the rows. */
  | 'resolved'
  /**
   * The document refused to hand over the workbook at all. Every documented
   * public representation of a Sheet was probed and only `/export` carries
   * link targets, so a document that will not export cannot yield them by any
   * other route — and NOTHING is known about its links, not even whether it
   * has any.
   */
  | 'unavailable_source_export'
  /**
   * We GOT the file and could not make sense of it. Our problem rather than
   * the document's, kept separate because it points at a different remedy.
   */
  | 'unavailable_workbook_unreadable'
  /** The workbook was read and no worksheet is decisively this tab. */
  | 'unavailable_no_worksheet_match'
  /** Two worksheets are equally like this tab, so neither may lend its links. */
  | 'unavailable_ambiguous_worksheet'
  /** The workbook was read, the tab matched, and it carries no links. */
  | 'none_present';

/**
 * Whether stage 1 may be described as having seen this row's builder sources.
 *
 * A LABEL WHOSE TARGET WAS NEVER RESOLVED IS NOT AN ABSENT SOURCE. It is a
 * source nobody looked at, and calling the two the same is how a property gets
 * recorded as having no builder imagery when its package was one unread
 * hyperlink away. Only `resolved` and `none_present` are readings of the
 * SPREADSHEET; the rest are readings of our access to it.
 */
export function sourcesFullyEnumerable(availability: HyperlinkAvailability): boolean {
  return availability === 'resolved' || availability === 'none_present';
}
