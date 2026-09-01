/**
 * BUILDER STOCK — A PROPERTY ROW MAY OWN SEVERAL BUILDER SOURCES.
 *
 * WHAT THIS REPLACES, VERBATIM:
 *
 *     function solePackageUrl(unmapped: Record<string, string>): string | null {
 *       …
 *       return links.size === 1 ? [...links][0] : null;
 *     }
 *
 * "Two different package links on one row is a row that does not say which
 * package is its own, and the answer to that is no image." That was written
 * for a source whose rows carried at most one link, where a second one really
 * did mean ambiguity. It is wrong for a spreadsheet: a stock row legitimately
 * carries a brochure, a siting plan, an estate map, a plan of subdivision and
 * a rental appraisal, and the old rule declines ALL FIVE — a property with
 * five builder documents was treated as a property with none, and stage 1
 * began at its second rung.
 *
 * THE CORRECTION IS NOT A BETTER CHOICE. It is to stop choosing. Every
 * supported link deterministically attached to a row is a branch of that
 * property's stage 1 source graph, and stage 1 is finished when all of them
 * are, not when one of them is.
 *
 *     PROPERTY
 *       ├── brochure          → a document; read it
 *       ├── siting plan       → a document; read it
 *       ├── estate map        → a document; read it
 *       ├── plan of sub       → a document; read it
 *       └── rental appraisal  → a document; read it
 *
 * NOTHING HERE READS A COLUMN NAME. The heading travels with the branch as
 * provenance and is never consulted to decide anything: the next builder will
 * call the same thing `Package`, `Downloads`, `Property Documents` or `Plans`,
 * and a rule keyed on any of those is one spreadsheet's structure compiled
 * into the product. What a branch can yield is decided by the URL and then by
 * the bytes.
 *
 * Pure: no IO, no clock, no network.
 */
import { driveFileId, driveFolderId } from './drivePackage.pure.ts';
import {
  NO_DETERMINISTIC_IMAGE, type ProvenanceQuestion,
} from './negativeProvenance.pure.ts';
import { PACKAGE_RECOVERY_ATTEMPT, MAX_PACKAGE_ATTEMPTS } from './packageAttempt.pure.ts';

/** What a link can be asked for, decided by the URL alone. */
export type BranchKind =
  /** The bytes are the picture. */
  | 'direct_image'
  /** One Drive object: a file that may be an image or a document. */
  | 'drive_file'
  /** A Drive folder: a listing to choose from. */
  | 'drive_folder'
  /** A document this pipeline can open — PDF, DOCX, XLSX and the rest. */
  | 'document'
  /** Reachable, but nothing here can take a photograph out of it. */
  | 'unsupported';

export interface RowSourceBranch {
  url: string;
  /**
   * The spreadsheet heading the link sat under.
   *
   * PROVENANCE AND DIAGNOSTICS ONLY. Never an input to a decision — see the
   * header. It is here so an operator can see WHICH of a row's five documents
   * answered, which is unreadable from a URL alone.
   */
  column: string;
  kind: BranchKind;
}

const IMAGE_EXTENSION = /\.(jpe?g|png|webp|gif|bmp|tiff?|avif|heic)(?:[?#]|$)/i;
const DOCUMENT_EXTENSION = /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf)(?:[?#]|$)/i;

/** What kind of source a URL is, before anything has been fetched. */
export function classifyBranch(url: string): BranchKind {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'unsupported';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'unsupported';

  if (driveFolderId(url)) return 'drive_folder';
  if (driveFileId(url)) return 'drive_file';
  if (IMAGE_EXTENSION.test(parsed.pathname)) return 'direct_image';
  if (DOCUMENT_EXTENSION.test(parsed.pathname)) return 'document';
  return 'unsupported';
}

/** A branch this pipeline can actually try to take a photograph out of. */
export function isTraversableBranch(branch: RowSourceBranch): boolean {
  return branch.kind !== 'unsupported';
}

/**
 * Every supported source link a row owns, with the heading it came from.
 *
 * ATTRIBUTION IS THE ROW AND ONLY THE ROW. The links are read out of THIS
 * record's own cells; nothing is looked up by lot, address, estate or design,
 * so two products on one lot cannot reach each other's documents however alike
 * their other columns are.
 *
 * Ordered by column so a run is repeatable, and de-duplicated by URL so a
 * builder who pastes the same brochure into two columns is asked once — the
 * first column keeps the provenance, because a stable answer beats a tidier
 * one.
 */
export function rowSourceBranches(
  unmapped: Record<string, string> | null | undefined,
): RowSourceBranch[] {
  const seen = new Set<string>();
  const branches: RowSourceBranch[] = [];

  for (const column of Object.keys(unmapped ?? {}).sort()) {
    const value = String((unmapped ?? {})[column] ?? '');
    for (const candidate of value.split(/\s+/)) {
      if (!/^https?:\/\//i.test(candidate)) continue;
      const url = candidate.replace(/[),.]+$/, '');
      if (seen.has(url)) continue;
      seen.add(url);
      const kind = classifyBranch(url);
      if (kind === 'unsupported') continue;
      branches.push({ url, column, kind });
    }
  }
  return branches;
}

/**
 * THE ROW AS THE DOCUMENT STATES IT, PLUS THE TARGETS ONLY RECOVERY COULD SEE.
 *
 * A Google Sheet carries its documents as HYPERLINKS, and a sheet whose owner
 * has turned off "viewers can download, print, copy" publishes no
 * representation carrying a link target at all — every CSV of it shows the
 * word `Brochure` and no address. The recovery reads those cells through an
 * authorised connection and writes each row's own targets onto that row, so
 * for such a document the stored row is the ONLY place the address exists.
 *
 * Re-reading the source stays right — a builder edits their sheet and those
 * edits must land. But a re-read must not LOSE what the re-read can never
 * contain, so the recovered columns are laid over the freshly parsed row: the
 * document remains the authority on everything it can express, and the row is
 * the authority on the one thing it cannot.
 *
 * Only columns the recovery NAMED are overlaid, and only where what it stored
 * actually carries a link — so this can never invent a source, and a row that
 * has had no recovery is returned exactly as the document stated it.
 *
 * Measured in production before this existed: 350 targets recovered onto 86
 * properties, correctly attributed, and every one invisible to stage 1, which
 * re-read the sheet, saw five labels and no addresses, and reported
 * `stored 0, matched 0` for all eighty properties.
 */
export function unmappedWithRecoveredLinks(
  unmapped: Record<string, string> | null | undefined,
  storedRow: Record<string, unknown> | null | undefined,
): Record<string, string> {
  const base = { ...(unmapped ?? {}) };
  const row = (storedRow ?? {}) as Record<string, unknown>;
  const columns = Array.isArray(row.recovered_link_columns)
    ? row.recovered_link_columns as unknown[] : [];
  if (!columns.length) return base;

  const stored = (row.unmapped ?? {}) as Record<string, unknown>;
  for (const column of columns) {
    if (typeof column !== 'string') continue;
    const value = stored[column];
    if (typeof value !== 'string' || !/https?:\/\//i.test(value)) continue;
    base[column] = value;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Per-branch state
// ---------------------------------------------------------------------------

/**
 * One branch's standing, stored under its own URL.
 *
 * WHY A MAP RATHER THAN A COLUMN PER BRANCH. `source_provenance_result` already
 * holds exactly one record — an attempt or a verdict — keyed by version,
 * package reference and anchor. A row with five documents needs five of those,
 * and they must not overwrite one another: a heavy Drive folder retiring at
 * MAX_PACKAGE_ATTEMPTS must leave the brochure's answer standing, or one toxic
 * branch retires the property exactly as one toxic package used to retire the
 * upload.
 *
 * A RECORD WRITTEN BEFORE THIS EXISTED IS STILL READ. The legacy shape is a
 * bare record carrying its own `package_reference`, so it is lifted into the
 * map under that key and answers for that branch alone. Nothing has to be
 * migrated, and a property mid-flight keeps the attempts it has already spent.
 */
export interface BranchState {
  [url: string]: unknown;
}

const BRANCHES_KEY = 'branches';

/** Read the per-branch map out of whatever shape the column holds. */
export function readBranchState(stored: unknown): BranchState {
  if (!stored || typeof stored !== 'object') return {};
  const record = stored as Record<string, unknown>;

  const map = record[BRANCHES_KEY];
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    return { ...(map as BranchState) };
  }

  // The legacy single record: it names the branch it belongs to.
  const reference = record.package_reference;
  if (typeof reference === 'string' && reference) return { [reference]: record };
  return {};
}

/** Put a branch's record back, leaving every other branch exactly as it was. */
export function writeBranchState(stored: unknown, url: string, value: unknown): unknown {
  const map = readBranchState(stored);
  if (value === null || value === undefined) delete map[url];
  else map[url] = value;
  return { [BRANCHES_KEY]: map };
}

/** This branch's record, or nothing. */
export function branchRecord(stored: unknown, url: string): unknown {
  return readBranchState(stored)[url] ?? null;
}

/** The question asked of one branch. Its URL is the reference. */
export function branchQuestion(
  branch: RowSourceBranch,
  provenanceVersion: number,
  sourceAnchor: string | null,
): ProvenanceQuestion {
  return { provenanceVersion, packageReference: branch.url, sourceAnchor };
}

/**
 * Is this branch finished — for any reason?
 *
 * Three ways, and they are deliberately different things. It was READ and named
 * nothing for this property; it exhausted its attempts and was retired; or
 * nothing here can take a photograph out of it at all. Only the first two are
 * findings about the document.
 *
 * A branch whose record belongs to a DIFFERENT question — a bumped version, a
 * changed anchor — is not finished, because that record answers something else.
 */
export function branchTerminal(
  stored: unknown,
  branch: RowSourceBranch,
  question: ProvenanceQuestion,
): boolean {
  if (!isTraversableBranch(branch)) return true;

  const record = branchRecord(stored, branch.url) as Record<string, unknown> | null;
  if (!record) return false;
  if (Number(record.provenance_version) !== question.provenanceVersion) return false;
  if ((record.source_anchor ?? null) !== (question.sourceAnchor ?? null)) return false;

  if (record.result === NO_DETERMINISTIC_IMAGE) return true;
  if (record.result === PACKAGE_RECOVERY_ATTEMPT) {
    return Number(record.attempts ?? 0) >= MAX_PACKAGE_ATTEMPTS;
  }
  return false;
}

/**
 * The branches still owed a look, in order.
 *
 * A FAILED BRANCH NEVER SHORTENS THE LIST. The whole point: a brochure that
 * parsed and named nothing, a masterplan nothing can read and a Drive folder
 * that killed the worker twice are three finished branches, and the rental
 * appraisal beside them is still owed a look. Stage 1 answers only when this
 * is empty.
 */
export function openBranches(
  stored: unknown,
  branches: RowSourceBranch[],
  provenanceVersion: number,
  sourceAnchor: string | null,
): RowSourceBranch[] {
  return branches.filter((branch) => !branchTerminal(
    stored, branch, branchQuestion(branch, provenanceVersion, sourceAnchor)));
}

/**
 * WHICH open branch this attempt takes.
 *
 * A run opens ONE branch: it downloads a multi-megabyte document and
 * classifies its rasters, and that budget is what keeps a killed worker from
 * pinning a whole upload. So the property comes back for the rest — and which
 * one it takes next has to ADVANCE, or it never gets to the rest at all.
 *
 * Always taking the first open branch does not advance. An `unreachable`
 * branch deliberately records nothing (a sign-in wall may open tomorrow, and
 * banking "no image" for it would suppress a document that reads perfectly
 * well), so it is open again on the next tick, and first again, for ever.
 *
 * PRODUCTION, 31 AUGUST 2026, upload `43ffa452`. Forty-nine properties sat on
 * `source` across ten attempts each, answering in ~2.4 seconds with
 * `progressed: false`. Each had answered its `Brochure V002` and `Estate
 * Brochure` branches and had two more behind a `Siting  / Masterplan` link
 * that could never answer — so those two were never asked once.
 *
 * Rotating on the property's own claim counter fixes it with no new state: the
 * settler already increments it once per claim and resets it on a stage
 * change, and every open branch therefore comes up within `open.length`
 * attempts however any of them answers.
 */
export function branchForAttempt<T>(open: readonly T[], attempts: number): T | null {
  if (!open.length) return null;
  const n = Number(attempts);
  const safe = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  return open[safe % open.length];
}

/**
 * May stage 1 answer "no deterministic builder image" for this property?
 *
 * ONLY WITH EVERY APPLICABLE BRANCH TERMINAL. A property with no traversable
 * branch at all is trivially finished; a property with one unresolved branch
 * is not, however many of its siblings have answered.
 */
export function allBranchesTerminal(
  stored: unknown,
  branches: RowSourceBranch[],
  provenanceVersion: number,
  sourceAnchor: string | null,
): boolean {
  return openBranches(stored, branches, provenanceVersion, sourceAnchor).length === 0;
}
