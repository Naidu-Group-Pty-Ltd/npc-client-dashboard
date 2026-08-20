/**
 * "We read that package and it names no image for this property."
 *
 * A successful inspection with a negative answer is KNOWLEDGE, and the repair
 * used to throw it away. Only a recovered image was ever written down, so the
 * next sweep could not tell a property whose package had already answered from
 * one nobody had looked at, and fetched and re-parsed the same document again
 * every five minutes for ever. Production upload f7e0d4d1 is 57 rows of exactly
 * that.
 *
 * The rule lives here, as a pure function over a stored record, for the same
 * reason the eligibility rule does: the settler and its tests must not be able
 * to hold different opinions about when an answer has gone stale.
 */

/** The only result this records. There is deliberately no vocabulary to grow. */
export const NO_DETERMINISTIC_IMAGE = 'no_deterministic_image' as const;

export interface NegativeProvenanceResult {
  result: typeof NO_DETERMINISTIC_IMAGE;
  /** The extractor version that reached this answer. */
  provenance_version: number;
  /** The package this answer is ABOUT. */
  package_reference: string;
  /** The source row it was reached through, where the source names one. */
  source_anchor: string | null;
  /** Safe to surface: why the package named nothing. */
  detail: string;
  checked_at: string;
}

/** What the caller knows about the question it is currently asking. */
export interface ProvenanceQuestion {
  provenanceVersion: number;
  packageReference: string;
  sourceAnchor: string | null;
}

/**
 * Build the record. Separate from the write so a test can assert the SHAPE
 * without a database, and so the settler cannot invent a field the reader
 * below does not compare.
 */
export function recordNoDeterministicImage(
  question: ProvenanceQuestion,
  detail: string,
  now: () => Date = () => new Date(),
): NegativeProvenanceResult {
  return {
    result: NO_DETERMINISTIC_IMAGE,
    provenance_version: question.provenanceVersion,
    package_reference: question.packageReference,
    source_anchor: question.sourceAnchor,
    // Bounded: this is written to a column read by operators, not a log sink.
    detail: String(detail ?? '').slice(0, 300),
    checked_at: now().toISOString(),
  };
}

/**
 * Does a stored answer still answer the question being asked?
 *
 * FAIL OPEN IS THE SAFE DIRECTION HERE, and that is the opposite of the display
 * gate — deliberately. The worst case for this predicate is re-reading a
 * package we did not need to re-read, which costs one fetch. The worst case for
 * the other direction is a property that never gets its picture because a stale
 * answer suppressed the source for ever. So anything unrecognised, malformed or
 * merely different resolves to "ask again".
 *
 * Three things are compared, and each of them can independently reopen the
 * question:
 *
 *   VERSION — a `PROVENANCE_VERSION` bump means the extractor changed what it
 *   is capable of finding, so every negative answer it gave is stale by
 *   definition. `<` rather than `!==`: a record from a FUTURE version (a
 *   rollback, a restored snapshot) is not something this code may overrule.
 *
 *   PACKAGE — the answer is about a document. A builder who swaps package A for
 *   package B is asking a new question, and an answer about A must not suppress
 *   B.
 *
 *   ANCHOR — the same property reached through a different source row is a
 *   different question. Compared as written, with no normalisation: fuzzy
 *   matching here would silently suppress a real source.
 */
export function negativeProvenanceStillStands(
  stored: unknown,
  question: ProvenanceQuestion,
): boolean {
  if (!stored || typeof stored !== 'object') return false;
  const record = stored as Partial<NegativeProvenanceResult>;

  if (record.result !== NO_DETERMINISTIC_IMAGE) return false;

  const version = Number(record.provenance_version);
  if (!Number.isFinite(version)) return false;
  if (version < question.provenanceVersion) return false;

  if (typeof record.package_reference !== 'string') return false;
  if (record.package_reference !== question.packageReference) return false;

  // `null` and a missing key are the same statement — the source named no
  // anchor — so they must compare equal to a question that also names none.
  const storedAnchor = record.source_anchor ?? null;
  if (storedAnchor !== question.sourceAnchor) return false;

  return true;
}
