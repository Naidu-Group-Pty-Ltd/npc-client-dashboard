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
export function presentStoredMarkdown(markdown: string | null | undefined): string {
  if (!markdown) return '';
  const r = stripPlaceholderRows(markdown);
  const scrubbed = r.removedRows + r.removedTables + r.removedLines + r.blankedCells === 0 ? markdown : r.markdown;
  const sections = dropEmptySections(scrubbed);
  return sections.dropped.length === 0 ? scrubbed : sections.markdown;
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
