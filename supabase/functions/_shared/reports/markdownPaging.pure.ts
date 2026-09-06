/**
 * Packing rendered Markdown into fixed-height page buckets.
 *
 * This lives on the shared side, and is imported by both the `markdown-block`
 * renderer in `src/lib/reportTemplate/blocks/` and the narrative projections,
 * for a reason that is not tidiness. A master makes page N conditional on
 * `narrative.pages > N` (or `qa.answerPages > N`), and the block decides what
 * page N contains. If the two disagreed by a single line the document would
 * either print a blank page or silently drop its tail — and the tail is the
 * end of something a client is reading. They have to be the same arithmetic,
 * so they are the same functions, and a format that opts into the calibrated
 * profile below must do so on BOTH sides through `resolveNarrativeProfile`.
 *
 * ## The 2026-09 calibration
 *
 * `scripts/reports/markdownCalibration.mts` rendered probes through the real
 * seeded Investment Compass master (WeasyPrint 69, the pinned engine) twice:
 * once with the pager in charge, once with the bucket cap lifted so the page
 * geometry decided. The pager was sending pages at **40–47% of what they
 * hold**: a continuation page really fits ~54.5 rendered line-units and the
 * first narrative page ~42.5 (part-header furniture), while the legacy charge
 * model (65 chars/line, integer rounding) summed the same content to 34 units.
 * Real prose wraps at ~98 characters on this measure, not 65. That under-fill
 * is where every "large sectional gap" in a narrative page came from — the
 * page broke long before it was full.
 *
 * The calibrated profile pairs the measured charge model in `markdown.pure.ts`
 * (`charging: 'measured'`) with budgets set 8% under the measured capacity,
 * because template families set their own body size and a slightly larger face
 * must not push the last line past the box. `DEFAULT_LINES_PER_PAGE` (34) is
 * ALSO the value baked into every deployed master's block props, so it doubles
 * as the legacy sentinel: a schema still carrying 34 is read as "use the
 * calibrated profile" by the formats that opt in, while any other explicit
 * value is honoured verbatim — a hand-tuned master keeps its tuning.
 */
import type { MarkdownBlock } from './markdown.pure.ts';
import { splitTableBlock } from './markdown.pure.ts';

/**
 * The legacy bucket size, and the sentinel every pre-calibration master baked
 * into its block props. Overridable per master.
 */
export const DEFAULT_LINES_PER_PAGE = 34;

/** Measured on the Compass continuation page; see the header. */
export const CALIBRATED_CONT_LINES = 50;
/** Measured on the Compass first narrative page (part-header furniture). */
export const CALIBRATED_FIRST_LINES = 39;

export interface NarrativeProfile {
  /** Charge model `renderMarkdown` must be called with. */
  charging: 'measured';
  /** Bucket size for continuation pages, in measured line-units. */
  linesPerPage: number;
  /** Bucket size for the first page (its box is shorter). */
  firstPageLines: number;
  /** Never end a page on a heading or a lead-in line. */
  keepWithNext: true;
  /** Split a taller-than-a-page table by rows, repeating its head. */
  splitTables: true;
}

const INVESTMENT_PROFILE: NarrativeProfile = {
  charging: 'measured',
  linesPerPage: CALIBRATED_CONT_LINES,
  firstPageLines: CALIBRATED_FIRST_LINES,
  keepWithNext: true,
  splitTables: true,
};

/**
 * The formats whose narrative path has been calibrated. Both sides of the
 * contract — the block renderer and the format's projection — resolve through
 * this one function, so they cannot disagree about whether a format is on the
 * calibrated arithmetic. Formats not named here keep the legacy behaviour
 * byte for byte; they join by being measured, not by being assumed
 * (`scripts/reports/markdownCalibration.mts` is the instrument).
 */
export function resolveNarrativeProfile(reportType: string | null | undefined): NarrativeProfile | null {
  const t = String(reportType ?? '').toLowerCase();
  if (t === 'investment' || t === 'investment_compass' || t === 'compass') return INVESTMENT_PROFILE;
  return null;
}

export interface PackOptions {
  /** Bucket size for page 0; defaults to `linesPerPage`. */
  firstPageLines?: number;
  /**
   * When a page break would strand a heading, or a lead-in paragraph ending
   * in a colon, as the last block of a page, carry it (and at most one
   * companion) onto the next page instead. A heading at a page foot promises
   * content the page does not deliver, and "The key considerations are:"
   * followed by white space is the exact defect this was measured from.
   */
  keepWithNext?: boolean;
  /**
   * A table taller than a whole page used to get a bucket of its own and then
   * overflow its fixed-height box — the overflow was clipped at the page edge
   * and the severed row was simply lost (measured on a real risk register:
   * the word "dependency" sliced through by the row rule, its remainder never
   * printed). With this on, such a table is split by rows into page-sized
   * chunks, each repeating the header row, which is what a paper ledger does.
   * A table that fits a page whole still moves whole.
   */
  splitTables?: boolean;
}

/**
 * Pack blocks into buckets of at most `linesPerPage` estimated lines.
 *
 * A block taller than a whole page gets a bucket of its own rather than being
 * split — unless it is a table and `splitTables` is on, because a clipped
 * table row is lost content, which is worse than either alternative.
 */
export function packMarkdownPages(
  blocks: readonly MarkdownBlock[],
  linesPerPage: number = DEFAULT_LINES_PER_PAGE,
  options: PackOptions = {},
): MarkdownBlock[][] {
  const contBudget = Math.max(1, linesPerPage);
  const firstBudget = Math.max(1, options.firstPageLines ?? contBudget);
  const pages: MarkdownBlock[][] = [];
  let current: MarkdownBlock[] = [];
  let used = 0;

  const budgetFor = (pageIndex: number) => (pageIndex === 0 ? firstBudget : contBudget);

  const breakPage = () => {
    if (!current.length) return;
    if (options.keepWithNext) {
      // Peel a trailing heading / lead-in so it opens the next page instead of
      // closing this one. At most two blocks (a heading over a lead-in), and
      // never the whole page.
      const peeled: MarkdownBlock[] = [];
      while (current.length > 1 && peeled.length < 2) {
        const last = current[current.length - 1];
        const isHeading = last.kind === 'heading';
        const isLeadIn = last.kind === 'paragraph' && /[:：]\s*<\/p>\s*$/.test(last.html);
        if (!isHeading && !isLeadIn) break;
        peeled.unshift(current.pop()!);
      }
      pages.push(current);
      current = peeled;
      used = peeled.reduce((n, b) => n + b.lines, 0);
      return;
    }
    pages.push(current);
    current = [];
    used = 0;
  };

  for (const block of blocks) {
    const budget = budgetFor(pages.length);
    let pieces: readonly MarkdownBlock[] = [block];
    if (options.splitTables && block.kind === 'table' && block.table && block.lines > budget) {
      // First chunk sizes to the space left on the current page when that is
      // worth using (head + a few rows); otherwise every chunk is page-sized
      // and the pack loop opens a fresh page for the first one naturally.
      const remaining = budget - used;
      const firstChunk = current.length && remaining >= 8 ? remaining : contBudget;
      pieces = splitTableBlock(block, firstChunk, contBudget);
    }

    for (const piece of pieces) {
      const pageBudget = budgetFor(pages.length);
      if (current.length && used + piece.lines > pageBudget) breakPage();
      current.push(piece);
      used += piece.lines;
    }
  }
  if (current.length) pages.push(current);
  return pages;
}

/**
 * The one call both sides of a calibrated format make.
 *
 * `schemaLinesPerPage` is the value baked into the master's block props. The
 * legacy sentinel (34) — and any absent value — resolves to the calibrated
 * budgets; an explicit different value is a hand-tuned master and is honoured
 * with the profile's packing behaviours but its own bucket size.
 */
export function packNarrativePages(
  blocks: readonly MarkdownBlock[],
  profile: NarrativeProfile,
  schemaLinesPerPage?: number,
): MarkdownBlock[][] {
  const custom = schemaLinesPerPage !== undefined
    && schemaLinesPerPage !== DEFAULT_LINES_PER_PAGE
    && schemaLinesPerPage > 0;
  const lines = custom ? schemaLinesPerPage! : profile.linesPerPage;
  const first = custom ? schemaLinesPerPage! : profile.firstPageLines;
  return packMarkdownPages(blocks, lines, {
    firstPageLines: first,
    keepWithNext: profile.keepWithNext,
    splitTables: profile.splitTables,
  });
}
