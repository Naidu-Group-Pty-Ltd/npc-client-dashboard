/**
 * The public office-holder index: what it holds, and what it can never say.
 *
 * ── The one rule ──────────────────────────────────────────────────────
 * A HIT is a candidate. A MISS is nothing.
 *
 * No public source lists every prominent public function, none lists family
 * members or close associates at all, and the sources that do exist disagree
 * with each other about spelling, titles and dates. An index built from them
 * is useful for the same reason a commercial PEP database is useful — it
 * surfaces a name worth looking at — and it is dangerous for exactly one
 * reason: it returns zero rows for a person it never covered in the first
 * place, and zero rows reads like an answer.
 *
 * This platform has already had that failure once. `aml.sanctions_entries`
 * was empty from the day it was built, and every screening against it would
 * have cleared everybody. So `describeCoverage` exists, it is attached to
 * every search result, and `searchVerdict` will not produce the word "clear"
 * in any branch.
 *
 * ── Why these sources ─────────────────────────────────────────────────
 * All public, all machine-readable, none licensed:
 *
 *   `wikidata_au_public_office` — office holders with a position, a start
 *   and an end. It is the only reachable source that carries FORMER holders,
 *   which is the gap the current government directory leaves and the one
 *   AUSTRAC is most explicit about: leaving office does not end the risk.
 *
 * Wikidata is collaboratively edited, which is precisely why a hit from it
 * is a lead rather than a source. Every row carries `confirm_url` — the
 * official register the operator confirms against — and the evidence a
 * determination rests on is what they record from THAT, never from here.
 *
 * ── Coverage is MEASURED, not claimed ─────────────────────────────────
 * `covers` used to be a sentence: "Commonwealth, state and territory
 * parliamentarians, ministers, judges, heads of agency…". The first real
 * load wrote 1,254 people across TWO offices — the House of Representatives
 * and its Speaker — because the query walked the wrong root. The load was
 * green, the number was plausible, and the sentence on screen was false.
 *
 * A claim nobody measures is a claim nobody can check, and an overstated
 * coverage line is worse than an unavailable index: it tells an operator
 * that an absence means more than it does. So the prose now describes the
 * SHAPE of the source, and the specifics an operator relies on — how many
 * offices were reached, how many people, which ones — are read off the load
 * itself and rendered beside it.
 */

export const PEP_INDEX_SOURCES = [
  {
    code: "wikidata_au_public_office",
    label: "Australian public office holders (Wikidata)",
    /** The register an operator confirms a candidate against. */
    confirmAgainst: "the official register for the office named",
    /**
     * The SHAPE of what the source holds. Anything countable — how many
     * offices, how many people, which ones — comes off the load instead.
     */
    covers:
      "offices whose jurisdiction is Australia or one of its states and "
      + "territories, and the people recorded as having held them — current "
      + "and former",
    excludes:
      "family members and close associates, office holders with no public "
      + "record, and foreign offices held overseas",
    collaborative: true,
  },
] as const;

export type PepIndexSourceCode = (typeof PEP_INDEX_SOURCES)[number]["code"];

export interface PepIndexCoverage {
  sourceCode: string;
  label: string;
  covers: string;
  excludes: string;
  /** Whether the source is collaboratively edited, said out loud. */
  collaborative: boolean;
  entryCount: number;
  /**
   * How many distinct offices the load actually reached, and a sample.
   *
   * Measured by the loader and rendered on screen, because this is exactly
   * the fact a coverage sentence got wrong: a load holding two offices read
   * identically to one holding seven hundred.
   */
  officeCount: number | null;
  sampleOffices: string[];
  /** When the source itself says it is current to — not when we synced. */
  sourceAsAt: string | null;
  lastSyncedAt: string | null;
  lastSyncStatus: "succeeded" | "failed" | "running" | "never" | string;
}

export interface PepIndexCandidate {
  externalId: string;
  sourceCode: string;
  fullName: string;
  aliases: string[];
  positionTitle: string;
  /**
   * Null, and it stays null. The AUSTRAC category is part of the
   * determination the operator reaches, not something an index asserts.
   */
  pepType: "foreign" | "domestic" | "international_organisation" | null;
  jurisdiction: string | null;
  positionStart: string | null;
  positionEnd: string | null;
  currentlyHeld: boolean | null;
  confirmUrl: string | null;
  /** 0–1, from the same matcher the sanctions screening uses. */
  score: number;
}

/**
 * What a search RESULT means. Four readings, and none of them is "clear".
 *
 * `unavailable` is deliberately distinct from `no_candidates`: an index that
 * has never loaded, or whose last load failed, has not looked. Reporting that
 * as "nothing found" is the exact shape of the sanctions defect — a technical
 * condition wearing a customer outcome's clothes.
 */
export type PepIndexReading =
  | "candidates"
  | "no_candidates"
  | "unavailable"
  | "not_searchable";

export interface PepIndexVerdict {
  reading: PepIndexReading;
  /** One sentence, in the operator's language. Never a conclusion. */
  message: string;
  candidates: PepIndexCandidate[];
  coverage: PepIndexCoverage[];
}

/** Coverage prose for one source, from its row in the sync table. */
export function describeCoverage(
  sourceCode: string,
  sync: {
    entry_count?: number | null;
    source_as_at?: string | null;
    completed_at?: string | null;
    started_at?: string | null;
    status?: string | null;
    detail?: {
      office_count?: number | null;
      distinct_offices?: number | null;
      sample_offices?: unknown;
    } | null;
  } | null,
): PepIndexCoverage {
  const source = PEP_INDEX_SOURCES.find((s) => s.code === sourceCode);
  const detail = sync?.detail ?? null;
  const offices = detail?.distinct_offices ?? detail?.office_count ?? null;
  const sample = Array.isArray(detail?.sample_offices)
    ? (detail!.sample_offices as unknown[])
      .map((o) => String(o ?? "").trim()).filter(Boolean).slice(0, 12)
    : [];
  return {
    sourceCode,
    label: source?.label ?? sourceCode,
    covers: source?.covers ?? "",
    excludes: source?.excludes ?? "",
    collaborative: source?.collaborative ?? true,
    entryCount: Number(sync?.entry_count ?? 0),
    officeCount: typeof offices === "number" && Number.isFinite(offices) ? offices : null,
    sampleOffices: sample,
    sourceAsAt: sync?.source_as_at ?? null,
    lastSyncedAt: sync?.completed_at ?? sync?.started_at ?? null,
    lastSyncStatus: sync?.status ?? "never",
  };
}

/**
 * Whether the index is in a state where a search means anything.
 *
 * Fails the same way the sanctions provider does: an empty index, or one
 * whose latest load failed, is UNAVAILABLE rather than empty. Refusal is
 * visible; a confident nothing is not.
 */
export function indexIsUsable(coverage: PepIndexCoverage[]): boolean {
  return coverage.some((c) => c.entryCount > 0 && c.lastSyncStatus === "succeeded");
}

/**
 * Turn a set of candidates into a reading, with the sentence that goes on
 * screen beside it.
 *
 * Every branch is written so that it cannot be paraphrased into a
 * determination. "No candidate" says what was searched and what the search
 * does not reach; it never says the person is not a PEP.
 */
export function searchVerdict(input: {
  hasSearchableName: boolean;
  candidates: PepIndexCandidate[];
  coverage: PepIndexCoverage[];
}): PepIndexVerdict {
  const { candidates, coverage } = input;
  if (!input.hasSearchableName) {
    return {
      reading: "not_searchable",
      message: "There is no name on this party that can be searched.",
      candidates: [], coverage,
    };
  }
  if (!indexIsUsable(coverage)) {
    return {
      reading: "unavailable",
      message: "The office-holder index has not loaded, so nothing was searched. "
        + "Check the public sources directly.",
      candidates: [], coverage,
    };
  }
  if (candidates.length === 0) {
    return {
      reading: "no_candidates",
      message: "No candidate in the index. The index does not cover family members, "
        + "close associates or foreign office holders, so this is not an answer to "
        + "the question — check the sources and record what you find.",
      candidates: [], coverage,
    };
  }
  return {
    reading: "candidates",
    message: `${candidates.length} possible office holder`
      + `${candidates.length === 1 ? "" : "s"} with a similar name. `
      + "Confirm against the official register before relying on any of them.",
    candidates, coverage,
  };
}

/**
 * The source row a confirmed candidate becomes.
 *
 * `result` is deliberately EMPTY. The operator has to say what they saw when
 * they confirmed it — an index hit auto-filled as its own result would be the
 * platform writing the operator's evidence for them, which is the thing that
 * makes a record indefensible.
 */
export function candidateToMethodDraft(c: PepIndexCandidate): {
  kind: string; source: string; reference: string; result: string;
} {
  const held = c.currentlyHeld === false ? "former" : c.currentlyHeld === true ? "current" : null;
  const span = [c.positionStart, c.positionEnd].filter(Boolean).join(" – ");
  return {
    kind: "official_register",
    source: c.confirmUrl
      ? `${c.positionTitle}${c.jurisdiction ? `, ${c.jurisdiction}` : ""} — confirmed against the official register`
      : `${c.positionTitle}${c.jurisdiction ? `, ${c.jurisdiction}` : ""}`,
    reference: [c.fullName, held, span].filter(Boolean).join(" · "),
    result: "",
  };
}
