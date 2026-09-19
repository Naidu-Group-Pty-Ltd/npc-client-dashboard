/**
 * Hygiene for derived report markdown — the two deterministic passes every
 * fork and condense output goes through before it is stored.
 *
 * Both exist because of measured production defects:
 *
 *  - `stripPlaceholderRows`: the Executive Briefing's structure guide demanded
 *    financial tables from a parent that carries no financials, and the model
 *    filled them — 87 occurrences of "N/A" on the newest briefing, six-row
 *    tables reading N/A / N/A on a client's page. A labelled row is a promise
 *    that a figure follows it, so a row whose every value cell is a
 *    placeholder loses the row, and a table that loses every body row loses
 *    the table.
 *
 *  - `trimToDeclaredSections`: the newest Snapshot carried its eight declared
 *    sections and then the parent Compass's nine section headings copied in
 *    after them — 17 headings and 2.5× the length of a five-page format
 *    (row 8c6edc56). A tier's output is trimmed to the sections its structure
 *    declares; anything else the model volunteered is dropped and named.
 */

import { enforceChartEvidence, type EvidenceInventory } from './chartEvidence.pure.ts';
import { alignChartScales } from './chartScale.pure.ts';
import { dedupeChartDirectives } from './blockHygiene.pure.ts';
import { foldStraySections } from './sectionFolding.pure.ts';

const PLACEHOLDER_CELL = /^(?:n\/?a|tbd|to be determined|not available|not provided|unknown|—|-|–)\.?$/i;

const isSeparatorRow = (cells: string[]): boolean =>
  cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c.trim()));

const splitRow = (line: string): string[] | null => {
  const t = line.trim();
  if (!t.startsWith('|') || !t.endsWith('|') || t.length < 2) return null;
  return t.slice(1, -1).split('|').map((c) => c.trim());
};

/**
 * A whole line that is nothing but a placeholder confession — the model
 * narrating an absence it was wrongly asked to fill:
 *   "N/A (Historical price growth data not provided…)"
 *   "- Source attribution: N/A (Specific market performance data…)"
 *   "- Job Growth Trends table: N/A"
 * A sentence that merely mentions N/A is prose and is left alone.
 */
const PLACEHOLDER_LINE = /^(?:-\s+[^:|]{0,80}:\s*)?(?:n\/?a|tbd|not available|not provided)\b\s*(?:\/\s*\d+)?\s*(?:\([^)]*\))?\s*\.?$/i;

export interface PlaceholderScrubResult {
  markdown: string;
  removedRows: number;
  removedTables: number;
  removedLines: number;
  blankedCells: number;
}

/**
 * Enforce "a labelled row is a promise that a figure follows it" on stored
 * markdown:
 *
 *  - a table row whose FIRST value cell is a placeholder loses the row — the
 *    promise its label makes is broken whatever a trailing note says;
 *  - a surviving row's later placeholder cells are blanked — an empty cell
 *    states nothing, "N/A" states a failure;
 *  - a table left with no body rows loses the table;
 *  - a line that is nothing but a placeholder confession loses the line.
 *
 * Prose is otherwise untouched: an "N/A" inside a real sentence is the
 * author's to answer for.
 */
export function stripPlaceholderRows(markdown: string): PlaceholderScrubResult {
  const lines = (markdown || '').split('\n');
  const out: string[] = [];
  let removedRows = 0;
  let removedTables = 0;
  let removedLines = 0;
  let blankedCells = 0;

  const isPlaceholder = (c: string): boolean => c === '' || PLACEHOLDER_CELL.test(c);

  let i = 0;
  while (i < lines.length) {
    const cells = splitRow(lines[i]);
    if (!cells) {
      if (PLACEHOLDER_LINE.test(lines[i].trim())) {
        removedLines += 1;
      } else {
        out.push(lines[i]);
      }
      i += 1;
      continue;
    }

    // Collect the whole contiguous table.
    const table: string[][] = [];
    const raw: string[] = [];
    while (i < lines.length) {
      const rowCells = splitRow(lines[i]);
      if (!rowCells) break;
      table.push(rowCells);
      raw.push(lines[i]);
      i += 1;
    }

    const kept: string[] = [];
    let bodyKept = 0;
    table.forEach((rowCells, idx) => {
      const isHeader = idx === 0;
      const isSeparator = isSeparatorRow(rowCells);
      if (isHeader || isSeparator) {
        kept.push(raw[idx]);
        return;
      }
      const valueCells = rowCells.slice(1);
      if (valueCells.length > 0 && isPlaceholder(valueCells[0])) {
        removedRows += 1;
        return;
      }
      const cleaned = rowCells.map((c, ci) => {
        if (ci <= 1 || !PLACEHOLDER_CELL.test(c)) return c;
        blankedCells += 1;
        return '';
      });
      kept.push(`| ${cleaned.join(' | ')} |`);
      bodyKept += 1;
    });

    if (bodyKept === 0) {
      removedTables += 1;
      // Swallow one trailing blank the table owned, so its removal does not
      // leave a double gap.
      if (out.length && out[out.length - 1].trim() === '' && i < lines.length && lines[i].trim() === '') i += 1;
    } else {
      out.push(...kept);
    }
  }

  return {
    markdown: out.join('\n').replace(/\n{3,}/g, '\n\n'),
    removedRows,
    removedTables,
    removedLines,
    blankedCells,
  };
}

export interface EmptySectionResult {
  markdown: string;
  /** The headings dropped, in document order. */
  dropped: string[];
}

/**
 * A heading with nothing under it is dropped — a promise of a section that
 * never comes.
 *
 * `stripPlaceholderRows` takes a table whose every row was a placeholder, and
 * leaves the heading that introduced it standing over the next heading:
 * measured through the real journey on the production Snapshot of 4 Sep 2026,
 * "Key Market Stats" and "Score Breakdown" printed as headings with no body.
 * A section is empty when the next non-blank line is a heading of the same or
 * a higher level, or the end of the document; a heading over a deeper heading
 * that holds prose is a section with sub-sections and is kept. Run to a
 * fixed point, so a parent left empty by its emptied children goes with them.
 */
export function dropEmptySections(markdown: string): EmptySectionResult {
  const HEADING = /^(#{1,6})\s+\S/;
  const levelOf = (line: string): number => (line.match(HEADING)?.[1].length ?? 0);
  let lines = (markdown || '').split('\n');
  const dropped: string[] = [];
  for (let pass = 0; pass < 8; pass += 1) {
    const next: string[] = [];
    let changed = false;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const level = levelOf(line);
      if (level > 0) {
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === '') j += 1;
        const empty = j >= lines.length || (levelOf(lines[j]) > 0 && levelOf(lines[j]) <= level);
        if (empty) {
          dropped.push(line.replace(/^#{1,6}\s+/, '').trim());
          changed = true;
          continue;
        }
      }
      next.push(line);
    }
    lines = next;
    if (!changed) break;
  }
  return {
    markdown: dropped.length === 0
      ? (markdown || '')
      // The blank lines a dropped heading owned go with it: no doubled gap
      // inside, no blank opening line, one newline at the end.
      : lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n{2,}$/, '\n'),
    dropped,
  };
}

/**
 * The read-path application of the placeholder rule.
 *
 * `stripPlaceholderRows` ran on the WRITE path alone — every fork and condense
 * since 4 Sep 2026 — and every derived report stored before it rendered its
 * placeholders verbatim for every reader. Measured on production, 14 Sep 2026:
 * all seven Executive Briefings produced in the preceding 120 days carry 36 to
 * 97 "N/A" cells (every one of them predates the write-path scrub), the newest
 * Snapshot carries 19, and 268 of 1,122 Compass reports hold at least one
 * table row whose first value cell is a placeholder. The owner's rule is that
 * neither "N/A" nor "unavailable" ever reaches a client document, so the same
 * scrub is applied where stored content is READ — the browser projection both
 * presentations draw from, the template adapter, the legacy server renderer
 * and the on-screen document view — the way `healFinanceIdentity` repairs the
 * finance block for every reader without a migration and without a stored
 * byte changing. One implementation, imported by every end.
 *
 * Prose is untouched (the scrub's own contract): a sentence that mentions an
 * absence is the author's, and rewriting prose by pattern is how a true
 * statement gets deleted from a client's document. What this removes is the
 * structured placeholder — a table cell, a `label: N/A` line — which states a
 * failure where a figure was promised.
 *
 * A heading the scrub leaves over nothing goes with its table
 * (`dropEmptySections`). A document that carries neither is returned
 * untouched, byte for byte, so a clean report's packing, charges and goldens
 * are exactly what they were.
 */
/**
 * A cell that reports OUR gap rather than a finding about the property.
 *
 * Measured in the S6 acceptance run, 18 Sep 2026, on two issued documents:
 *
 *     {{glance: ✓ Matches workaday local demand | ✓ Functional over flashy
 *              | ⚠ Exact bed/bath/car details not provided
 *              | ★ Best for practical occupiers}}
 *     {{glance: ✓ Established township amenity
 *              | ⚠ Exact facility distances not provided | …}}
 *
 * `compassDocumentContract` forbids this by name and quotes the first string
 * verbatim — *"which a client reads as a defect in the house rather than a gap
 * in our file"* — and that rule reaches the MODEL. It does nothing for a
 * document already stored, and both of these were written before it existed.
 * §8 of `RUNTIME_CONSOLIDATION.md` is the precedent: the scrub runs where
 * stored content is READ.
 *
 * `stripPlaceholderRows` could not see them because they are neither a table
 * row nor a bullet — they are cells inside a `{{glance:}}` payload, which the
 * renderer draws as a strip.
 *
 * **The rule is narrow on purpose.** A gap phrase alone is not enough: "⚠ NBN
 * not available" is a finding ABOUT THE PROPERTY, and dropping it would remove
 * real evidence. The cell must also name an INFORMATION noun — details, data,
 * figures, distances, a breakdown — which is what makes it a statement about
 * the record rather than about the house.
 */
const GAP_PHRASE = /\b(?:not (?:provided|available|stated|specified|disclosed|supplied|recorded)|no data|unavailable)\b/i;
const INFORMATION_NOUN =
  /\b(?:details?|data|figures?|information|distances?|breakdowns?|dimensions?|specifications?|specs|measurements?|records?)\b/i;

const isOwnGapCell = (cell: string): boolean =>
  GAP_PHRASE.test(cell) && INFORMATION_NOUN.test(cell);

export interface GlanceScrubResult {
  markdown: string;
  /** Every cell removed, verbatim, so the caller can say what went. */
  removedCells: string[];
  /** Directives dropped entirely because every cell was a gap. */
  removedDirectives: number;
}

/**
 * Remove a gap cell from every at-a-glance strip, keeping the strip.
 *
 * The contract's own words: *"three cells that each carry a finding is a
 * complete strip, and a fourth reporting our own gap is not."* So the CELL
 * goes and the strip stays — and a strip left with no cells at all is dropped,
 * because an empty directive draws nothing anyway.
 *
 * A document with no gap cell is returned byte for byte.
 */
export function stripOwnGapCells(markdown: string): GlanceScrubResult {
  const removedCells: string[] = [];
  let removedDirectives = 0;
  const out = markdown.replace(/\{\{(glance|tiles|chips)\s*:([^}]*)\}\}/gi, (whole, kind: string, body: string) => {
    const cells = body.split('|').map((c) => c.trim()).filter(Boolean);
    if (!cells.some(isOwnGapCell)) return whole;
    const kept = cells.filter((c) => {
      if (!isOwnGapCell(c)) return true;
      removedCells.push(c);
      return false;
    });
    if (!kept.length) { removedDirectives += 1; return ''; }
    return `{{${kind}: ${kept.join(' | ')}}}`;
  });
  return removedCells.length === 0
    ? { markdown, removedCells, removedDirectives: 0 }
    : { markdown: out.replace(/\n{3,}/g, '\n\n'), removedCells, removedDirectives };
}

export interface EmptyColumnResult {
  markdown: string;
  /** `[table index, header text]` for each column removed. */
  removed: Array<{ table: number; header: string }>;
}

/**
 * Remove a table column that is empty in every body row.
 *
 * A column with a header and nothing under it is a promise the record could
 * not keep: the reader is shown a heading — `Source`, `Period`, `Evidence` —
 * and is left to decide whether it means *nothing was found* or *nothing was
 * printed*. It was on the supplied documents beside the placeholders
 * `stripPlaceholderRows` already removes, and the two are the same defect at
 * different grains.
 *
 * Three guards keep it from removing a meaningful limitation.
 *
 * **Only a LITERALLY empty cell counts.** A dash is a value in this product —
 * `builderStock/manualStats` pays for that rule: an em dash says the record
 * holds nothing here, which is a fact worth printing, and a column of them is
 * a column of facts. So `—`, `-`, `n/a` and every worded absence are left
 * exactly where they are; the caller's earlier passes decide those.
 *
 * **The first column is never removed**, because it is the row's label and a
 * table with no labels is unreadable however empty the column is.
 *
 * **A table is never reduced below two columns**, so the degenerate case
 * produces a narrower table rather than a list of headings.
 */
export function dropEmptyTableColumns(markdown: string): EmptyColumnResult {
  const lines = markdown.split('\n');
  const removed: EmptyColumnResult['removed'] = [];
  const out: string[] = [];
  let tableIndex = 0;
  let i = 0;
  const cellsAt = (n: number): string[] | null =>
    (n >= 0 && n < lines.length ? splitRow(lines[n]) : null);
  while (i < lines.length) {
    const headerCells = cellsAt(i);
    const ruleCells = cellsAt(i + 1);
    if (!headerCells || !ruleCells || !isSeparatorRow(ruleCells)) {
      out.push(lines[i]); i += 1; continue;
    }
    let end = i + 2;
    while (cellsAt(end)) end += 1;
    const block = lines.slice(i, end);
    const header = headerCells;
    const body = block.slice(2).map((l) => splitRow(l) ?? []);
    const width = header.length;
    const drop = new Set<number>();
    // Body rows only: a rule row carries alignment, never content.
    if (body.length && width > 2) {
      for (let c = 1; c < width; c++) {
        const everyCellEmpty = body.every((row) => (row[c] ?? '') === '');
        if (everyCellEmpty) drop.add(c);
      }
    }
    // Never below two columns: drop the rightmost candidates back in until the
    // table is wide enough to still be a table.
    const ordered = [...drop].sort((a, b) => b - a);
    while (width - drop.size < 2 && ordered.length) drop.delete(ordered.pop()!);
    if (drop.size === 0) {
      out.push(...block); tableIndex += 1; i = end; continue;
    }
    for (const c of drop) removed.push({ table: tableIndex, header: header[c] ?? '' });
    const keep = (cells: string[]) => cells.filter((_, c) => !drop.has(c));
    out.push(`| ${keep(header).join(' | ')} |`);
    out.push(`| ${keep(ruleCells).join(' | ')} |`);
    for (const row of body) out.push(`| ${keep(row).join(' | ')} |`);
    tableIndex += 1;
    i = end;
  }
  return { markdown: out.join('\n'), removed };
}

/**
 * An inline citation with nothing in it.
 *
 * `[Source: ]`, `[ ]`, `[Source]` — a bracket the model opened and could not
 * fill. It reads as a reference the reader is expected to follow, and there is
 * nothing to follow. It is removed with the space in front of it so the
 * sentence closes normally; the sentence itself is untouched, because prose is
 * never regex-scrubbed and this is punctuation rather than prose.
 */
export function stripEmptyCitations(markdown: string): { markdown: string; removed: number } {
  let removed = 0;
  const out = markdown.replace(/[ \t]*\[\s*(?:source|ref|reference|citation)?\s*:?\s*\]/gi, () => {
    removed += 1;
    return '';
  });
  return { markdown: out, removed };
}

/**
 * The prompt's own scaffolding, quoted back at the reader.
 *
 * `generate-investment-report` pins the planning and infrastructure evidence
 * into every section under four headings, and those headings are INSTRUCTIONS:
 * nobody reading the document has ever seen them. The pinned block carries a
 * rule saying so in as many words — "**never write a bracketed pointer** such
 * as `[Zoning & Planning table]` … A bracket like that lands mid-sentence in a
 * client document and refers to nothing they can open" — and the delivered
 * suite carried them anyway: nine of ten documents with at least one, one
 * Compass with nine.
 *
 * That is the lesson `stripEditorialBlocks` already wrote down one file over:
 * **an instruction is a request; this is the guarantee.** The v2.0 prompt said
 * "at most one per section" twice and production carried ninety.
 *
 * ## Why this substitutes rather than deletes
 *
 * The claim behind the pointer is SOUND. Both tables are appended verbatim to
 * the finished document under `## Planning controls and development
 * registers`, so there is a real section to point at. Deleting the bracket
 * would leave the sentence unsourced, which is worse than an ugly sentence
 * that is sourced — the pinned rule says exactly that, and it is right.
 *
 * So the pointer is rewritten into the reference the rule asks for: the
 * report's own section, named in the sentence, where the reader can turn to
 * it. Nothing else in the sentence is touched. This is punctuation, not prose:
 * a closed set of four strings the prompt itself wrote, not a pattern over
 * what a model might say.
 *
 * ## It runs on READ
 *
 * Every document already stored carries these. A write-path fix repairs
 * nothing that has shipped, which is the same argument that moved the
 * placeholder scrub and the chart-evidence contract here.
 */
const SCAFFOLDING_POINTERS = [
  'Zoning & Planning table',
  'Zoning & Planning notes',
  'Infrastructure table',
  'Infrastructure section',
] as const;

/** The section those tables are appended under, verbatim, by the generator. */
export const PLANNING_REGISTER_SECTION = 'Planning controls and development registers';

const SCAFFOLDING_RE = new RegExp(
  `\\[\\s*(?:${SCAFFOLDING_POINTERS.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*\\]`,
  'gi',
);

export function rewriteScaffoldingPointers(
  markdown: string,
): { markdown: string; rewritten: number } {
  let rewritten = 0;
  const out = (markdown || '').replace(SCAFFOLDING_RE, (_whole, offset: number, whole: string) => {
    rewritten += 1;
    // "See [Zoning & Planning notes]" must not become "See (see …)". Where the
    // sentence already introduces the reference, only the section is named.
    const before = whole.slice(Math.max(0, offset - 12), offset);
    return /\b(?:see|in|under|per)\s*$/i.test(before)
      ? `*${PLANNING_REGISTER_SECTION}*`
      : ` (see *${PLANNING_REGISTER_SECTION}*)`;
  })
    // The pointer is usually set hard against the sentence it closes —
    // "…resale expectations.[Infrastructure section] The recorded 680…" — so
    // the reference is introduced with its own space and any double space the
    // substitution leaves is closed up. A space before a full stop or comma is
    // closed the same way, for the form that sits mid-sentence.
    .replace(/[ 	]{2,}\(see \*/g, ' (see *')
    .replace(/\(see \*([^*]+)\*\)([.,;:])/g, '(see *$1*)$2');
  return { markdown: out, rewritten };
}

export function presentStoredMarkdown(
  markdown: string | null | undefined,
  /*
   * The record the markdown was stored against, where the caller has it.
   *
   * Optional, and omitting it is byte-identical to the behaviour before the
   * chart-evidence contract existed — which is what lets the four readers
   * adopt it one at a time and what keeps every other caller untouched. With
   * it, a quantitative visual the record contradicts is withheld from the
   * DRAWING and set as a table of its own labels and values instead.
   *
   * This is the read path on purpose. The three guards that already judged
   * figures all ran in `generate-investment-report` and nowhere else, so a
   * stored document kept its unsupported graphics for ever and so did every
   * child forked from it; `presentStoredMarkdown` is the one scrub all four
   * renderers already apply, which is the same reason the placeholder scrub
   * moved here.
   */
  evidence?: EvidenceInventory | null,
): string {
  if (!markdown) return '';
  const r = stripPlaceholderRows(markdown);
  const scrubbed = r.removedRows + r.removedTables + r.removedLines + r.blankedCells === 0 ? markdown : r.markdown;
  // A gap cell inside an at-a-glance strip is the same defect one layer down,
  // and `stripPlaceholderRows` cannot see it — it is neither a row nor a
  // bullet. Found on two issued documents in the S6 acceptance run.
  const glance = stripOwnGapCells(scrubbed);
  // A column with a header and nothing under it, and a citation bracket with
  // nothing in it — both were on the documents supplied for acceptance, both
  // are a promise the record could not keep, and neither is prose.
  const columns = dropEmptyTableColumns(glance.markdown);
  const cited = stripEmptyCitations(columns.removed.length ? columns.markdown : glance.markdown);
  const tidied = cited.removed ? cited.markdown : (columns.removed.length ? columns.markdown : glance.markdown);
  const sections = dropEmptySections(tidied);
  const clean = sections.dropped.length === 0 ? tidied : sections.markdown;
  // A bracketed pointer into the prompt's own scaffolding, rewritten into the
  // report's own section. See `rewriteScaffoldingPointers`.
  const pointed = rewriteScaffoldingPointers(clean);
  const sourced = pointed.rewritten ? pointed.markdown : clean;
  /*
   * The same section, written twice.
   *
   * On the regenerated 262 Pallas Street Compass the Due Diligence Checklist
   * ran on pages 24–25 and again on 25–26, and the Final Recommendation on
   * page 25 and again on page 26 — the model wrote both inside the Risk
   * Dashboard's own chunk and then again as their own sections. See
   * `foldStraySections`, which carries the nested copy forward rather than
   * dropping it, because the nested copy was the complete one.
   *
   * READ path only, and deliberately. `report_content` is the source of truth
   * and `SECTION_STORAGE.md`'s rule is that a repeat is an occurrence to be
   * walked in order — folding it into storage would make the record disagree
   * with what the model actually produced and would re-key the section index.
   * What a reader is shown is this module's business; what is kept is not.
   */
  const one = foldStraySections(sourced);
  const onceEach = one.folded.length ? one.markdown : sourced;
  /*
   * The same chart, drawn five times.
   *
   * `dedupeChartDirectives` has existed since Stage 4 and ran on the WRITE
   * path alone — the post-processor, the fork and the condense. So a document
   * stored before that wiring, or one whose repeats arrive after it, keeps
   * every copy for ever and so does every child forked from it. On the
   * 42 Patya Circuit Compass the identical three-bar price chart was drawn on
   * five pages and the planning controls table on four.
   *
   * It is the same implementation, imported rather than repeated, and it is a
   * no-op on a document that carries each drawing once — which is what makes
   * adopting it on the read path safe for everything already correct.
   */
  const deduped = dedupeChartDirectives(onceEach);
  const single = deduped.removed ? deduped.markdown : onceEach;
  // One scale per quantity across the whole document. Unconditional, because
  // it needs no record to know that two charts of kilometres must agree, and
  // it is a no-op on a document with one chart per unit.
  const scaled = alignChartScales(single);
  const levelled = scaled.aligned.length ? scaled.markdown : single;
  if (!evidence) return levelled;
  const judged = enforceChartEvidence(levelled, evidence);
  return judged.findings.length ? judged.markdown : levelled;
}

const normalizeHeading = (h: string): string =>
  h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export interface SectionTrimResult {
  markdown: string;
  dropped: string[];
}

/**
 * Keep only the H2 sections a tier's structure declares (plus anything before
 * the first H2). A heading is allowed when its normalised form equals a
 * declared heading, or extends one ("Score Breakdown (simplified)" is still
 * "Score Breakdown"). Dropped headings are returned by name so the caller can
 * say what went, rather than shortening the document silently.
 */
export function trimToDeclaredSections(
  markdown: string,
  declaredHeadings: readonly string[],
): SectionTrimResult {
  const declared = declaredHeadings.map(normalizeHeading).filter(Boolean);
  const allowed = (heading: string): boolean => {
    const n = normalizeHeading(heading);
    return declared.some((d) => n === d || n.startsWith(`${d} `));
  };

  const lines = (markdown || '').split('\n');
  const out: string[] = [];
  const dropped: string[] = [];
  let dropping = false;

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      if (allowed(h2[1])) {
        dropping = false;
        out.push(line);
      } else {
        dropping = true;
        dropped.push(h2[1]);
      }
      continue;
    }
    if (!dropping) out.push(line);
  }

  return {
    markdown: out.join('\n').replace(/\n{3,}/g, '\n\n'),
    dropped,
  };
}
