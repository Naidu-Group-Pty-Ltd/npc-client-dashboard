/**
 * A score a document may print is a score the record holds.
 *
 * The audit of 291 Stone Mason Drive (QA-18) found the Briefing announcing an
 * "overall investment fit … rated 68/100", a "Metro-linked accessibility score
 * of 82" and a "suburb fit score of 82 for commuter families" — none of which
 * exists in `investment_score` (financial score 39, grade D) or anywhere in
 * the parent document the Briefing condenses. The condense guide already
 * forbids restating the score; a guide is an instruction to a model, and this
 * is the check that the instruction was obeyed.
 *
 * Two rules. **A claim is recognised by its shape, never by its topic**:
 * `NN/100`, "score of NN", "rated NN", "scored NN" — the forms the corpus
 * uses — so a new name for an invented number ("fit score", "accessibility
 * score") cannot slip past a list of known score names. And **a claim is
 * supported by the record or by the parent, never by itself**: the recorded
 * set is the total and every dimension the engine actually scored; a claim
 * the parent document already made with the same number (a walk score the
 * generator measured, say) is the parent's to answer for and is kept.
 *
 * Suppression removes the SENTENCE carrying the claim — the unit of the
 * assertion — and reports what went, so the hygiene log can say "the model
 * invented a score" rather than the document silently reading differently
 * from the model's draft. Tables and chart directives are never edited here:
 * a composed table prints only recorded figures, and a directive is drawn
 * from its own numbers.
 *
 * Deno-compatible: no imports.
 */

/** Where the claim sits and what it asserted. */
export interface ScoreClaim {
  /** The number asserted as a score. */
  value: number;
  /** The matched text, for the log. */
  text: string;
}

/**
 * `NN/100`, `NN out of 100`, `score of NN`, `scored NN`, `rated NN`,
 * `rating of NN`, `score is NN`, `score at NN`, `NN-point`. One alternation so
 * the forms cannot drift apart between the finder and the suppressor.
 */
const CLAIM_RE = /\b(\d{1,3})\s*(?:\/|out of)\s*100\b|\b(?:score|scores|scored|scoring|rated|rating)\s+(?:of|at|is|was)?\s*(\d{1,3})\b(?!\s*(?:%|per\s*cent|km|m\b|,\d))/gi;

/** Every score-shaped claim in a piece of prose. */
export function findScoreClaims(text: string): ScoreClaim[] {
  const out: ScoreClaim[] = [];
  for (const m of text.matchAll(CLAIM_RE)) {
    const raw = m[1] ?? m[2];
    const value = Number(raw);
    if (!Number.isFinite(value) || value > 100) continue;
    out.push({ value, text: m[0] });
  }
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The numbers `investment_score` actually holds: the total and every
 * dimension the engine scored (`dimensionWasScored`'s rule, restated here
 * without the import so this module stays free of dependencies). A
 * placeholder 50 on an excluded dimension is not a recorded score.
 */
export function recordedScoreValues(score: unknown): number[] {
  if (!isRecord(score)) return [];
  const values = new Set<number>();
  const total = score.totalScore;
  if (typeof total === 'number' && Number.isFinite(total)) values.add(Math.round(total));
  if (isRecord(score.breakdown)) {
    for (const raw of Object.values(score.breakdown)) {
      if (!isRecord(raw)) continue;
      if (raw.excluded === true) continue;
      if ((raw.hasData ?? raw.available) === false) continue;
      const weight = raw.weight;
      if (typeof weight === 'number' && weight <= 0) continue;
      const s = raw.score;
      if (typeof s === 'number' && Number.isFinite(s)) values.add(Math.round(s));
    }
  }
  return [...values];
}

export interface SuppressedClaim extends ScoreClaim {
  /** The sentence that carried it, as removed. */
  sentence: string;
}

export interface ScoreSuppressionResult {
  markdown: string;
  removed: SuppressedClaim[];
}

const isProseLine = (t: string): boolean =>
  t !== '' && !t.startsWith('#') && !t.startsWith('|') && !t.startsWith('{{')
  && !t.startsWith(':::') && !/^(-{3,}|\*{3,}|_{3,})$/.test(t);

/** Split a paragraph into sentences, keeping each terminator with its sentence. */
function sentencesOf(text: string): string[] {
  const parts = text.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g);
  return parts ? parts.map((s) => s.trim()).filter(Boolean) : [text];
}

/**
 * Remove every sentence asserting a score the record does not hold and the
 * parent did not state. Prose lines only — a bullet is a prose line and loses
 * its sentence like any other; a bullet left with nothing goes.
 */
export function suppressUnrecordedScores(
  markdown: string,
  opts: { recorded: number[]; parentText?: string },
): ScoreSuppressionResult {
  const supported = new Set(opts.recorded.map((n) => Math.round(n)));
  if (opts.parentText) {
    for (const c of findScoreClaims(opts.parentText)) supported.add(c.value);
  }
  const removed: SuppressedClaim[] = [];
  const out: string[] = [];
  for (const line of markdown.split('\n')) {
    const t = line.trim();
    if (!isProseLine(t)) { out.push(line); continue; }
    const claims = findScoreClaims(t).filter((c) => !supported.has(c.value));
    if (!claims.length) { out.push(line); continue; }

    const bullet = t.match(/^([-*+]\s+|\d+[.)]\s+)/);
    const prefix = bullet ? bullet[1] : '';
    const body = t.slice(prefix.length);
    const kept = sentencesOf(body).filter((sentence) => {
      const bad = findScoreClaims(sentence).filter((c) => !supported.has(c.value));
      if (!bad.length) return true;
      for (const c of bad) removed.push({ ...c, sentence });
      return false;
    });
    if (!kept.length) continue; // the whole line was the claim
    const indent = line.match(/^\s*/)?.[0] ?? '';
    out.push(`${indent}${prefix}${kept.join(' ')}`);
  }
  // A paragraph that lost its only line leaves two blank lines behind.
  const markdownOut = out.join('\n').replace(/\n{3,}/g, '\n\n');
  return { markdown: markdownOut, removed };
}
