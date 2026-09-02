/**
 * Fact reconciliation — does the prose agree with the record?
 *
 * A generated report carries two statements of the same property: the typed
 * columns (property_specs, manual overrides, the calculator's inputs) and
 * whatever the model wrote. Nothing ever compared them, so a report could
 * describe a four-bedroom home over a specs block that says three and no
 * machine would notice. This module is the comparison.
 *
 * It DISCLOSES, it does not gate: findings become `validation_flags`
 * entries (`type: 'fact'`) recorded on the report and surfaced in the
 * viewer's data-coverage disclosure. Feeding findings back into a
 * regeneration retry is deliberately not done here — a mistuned detector
 * driving model retries costs tokens and stability, so the detector earns
 * production mileage first.
 *
 * The detection rule is REPORT-LEVEL, not occurrence-level: a fact is
 * contradicted only when the recorded value never appears in the prose in
 * that fact's vocabulary AND a different value appears repeatedly. Prose
 * legitimately discusses other properties ("compared with four-bedroom
 * stock nearby"), so a single divergent mention is not a finding — this
 * trades missed single-mention errors for a near-zero false-positive rate,
 * the right trade for a disclosure surface.
 */

export interface CanonicalFacts {
  bedrooms?: number;
  bathrooms?: number;
  carSpaces?: number;
  purchasePrice?: number;
  weeklyRent?: number;
  landSizeSqm?: number;
}

export interface FactFinding {
  fact: keyof CanonicalFacts;
  expected: number;
  /** The divergent value the prose repeats. */
  found: number;
  /** How many times the divergent value appears in the fact's vocabulary. */
  occurrences: number;
  /** ±40 chars around the first divergent mention. */
  snippet: string;
}

const toCount = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

const parseMoney = (raw: string, unit?: string): number => {
  const n = Number(raw.replace(/,/g, ''));
  if (!Number.isFinite(n)) return NaN;
  return /^m(illion)?$/i.test(unit ?? '') ? n * 1_000_000 : n;
};

interface Mention {
  value: number;
  index: number;
}

const snippetAt = (text: string, index: number, length: number): string => {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
};

/**
 * Collect every mention matching `re` (which must expose the numeric value
 * in group 1, and may expose a magnitude unit in group 2).
 */
function collect(text: string, re: RegExp, money = false): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(re)) {
    const value = money ? parseMoney(m[1], m[2]) : Number(m[1].replace(/,/g, ''));
    if (Number.isFinite(value)) out.push({ value, index: m.index ?? 0 });
  }
  return out;
}

/**
 * The report-level rule: contradicted when no mention matches the record
 * (within tolerance) and some other value recurs at least `minRepeats`
 * times. Returns the modal divergent value.
 */
function judge(
  fact: keyof CanonicalFacts,
  expected: number,
  mentions: Mention[],
  text: string,
  tolerance: number,
  minRepeats: number,
  mentionLength = 20,
): FactFinding | null {
  if (!mentions.length) return null;
  const matches = (v: number) => Math.abs(v - expected) <= tolerance * Math.max(1, Math.abs(expected));
  if (mentions.some((m) => matches(m.value))) return null;

  const counts = new Map<number, Mention[]>();
  for (const m of mentions) {
    const bucket = counts.get(m.value) ?? [];
    bucket.push(m);
    counts.set(m.value, bucket);
  }
  let best: { value: number; list: Mention[] } | null = null;
  for (const [value, list] of counts) {
    if (!best || list.length > best.list.length) best = { value, list };
  }
  if (!best || best.list.length < minRepeats) return null;

  return {
    fact,
    expected,
    found: best.value,
    occurrences: best.list.length,
    snippet: snippetAt(text, best.list[0].index, mentionLength),
  };
}

/** Sentence-ish window around an index, for context-anchored money facts. */
const hasContextNearby = (text: string, index: number, context: RegExp): boolean => {
  const start = Math.max(0, index - 120);
  const end = Math.min(text.length, index + 120);
  return context.test(text.slice(start, end));
};

export function reconcileFacts(markdown: string, facts: CanonicalFacts): FactFinding[] {
  const text = String(markdown ?? '');
  if (!text.trim()) return [];
  const findings: FactFinding[] = [];

  const counted: Array<[keyof CanonicalFacts, RegExp]> = [
    ['bedrooms', /\b(\d{1,2})[\s-]*bed(?:room)?s?\b/gi],
    ['bathrooms', /\b(\d{1,2})[\s-]*bath(?:room)?s?\b/gi],
    ['carSpaces', /\b(\d{1,2})[\s-]*(?:car[\s-]*(?:space|park|port)s?|garage(?:\s+space)?s?)\b/gi],
  ];
  for (const [fact, re] of counted) {
    const expected = toCount(facts[fact]);
    if (expected === undefined) continue;
    const finding = judge(fact, expected, collect(text, re), text, 0, 2);
    if (finding) findings.push(finding);
  }

  const price = toCount(facts.purchasePrice);
  if (price !== undefined && price > 0) {
    const PRICE_CONTEXT = /purchas|asking|list(?:ed|ing)?\s+price|acquisition|buy(?:ing)?\s+price|sale\s+price|contract\s+price/i;
    const mentions = collect(
      text,
      /\$\s?([\d,]+(?:\.\d+)?)\s*(million|m\b)?/gi,
      true,
    ).filter((m) => m.value >= 50_000 && hasContextNearby(text, m.index, PRICE_CONTEXT));
    const finding = judge('purchasePrice', price, mentions, text, 0.02, 2);
    if (finding) findings.push(finding);
  }

  const rent = toCount(facts.weeklyRent);
  if (rent !== undefined && rent > 0) {
    const mentions = collect(text, /\$\s?([\d,]+)\s*(?:per\s+week|\/\s*week|\/?\s*wk\b|pw\b|p\/w|weekly)/gi);
    const finding = judge('weeklyRent', rent, mentions, text, 0.05, 2);
    if (finding) findings.push(finding);
  }

  const land = toCount(facts.landSizeSqm);
  if (land !== undefined && land > 0) {
    const LAND_CONTEXT = /\bland\b|\bblock\b|\blot\b|\bsite\b|\ballotment\b/i;
    const mentions = collect(text, /([\d,]+(?:\.\d+)?)\s*(?:sqm|m2|m²|square\s+met(?:re|er)s?)/gi)
      .filter((m) => hasContextNearby(text, m.index, LAND_CONTEXT));
    const finding = judge('landSizeSqm', land, mentions, text, 0.05, 2);
    if (finding) findings.push(finding);
  }

  return findings;
}

/** A finding, in the shape `validation_flags` already stores and renders. */
export function factFindingToFlag(f: FactFinding): {
  type: 'fact';
  severity: 'warning';
  field: string;
  message: string;
  value: { expected: number; found: number; occurrences: number; snippet: string };
} {
  const LABELS: Record<keyof CanonicalFacts, string> = {
    bedrooms: 'bedroom count',
    bathrooms: 'bathroom count',
    carSpaces: 'car spaces',
    purchasePrice: 'purchase price',
    weeklyRent: 'weekly rent',
    landSizeSqm: 'land size',
  };
  return {
    type: 'fact',
    severity: 'warning',
    field: String(f.fact),
    message: `The written analysis repeatedly states a ${LABELS[f.fact]} of ${f.found} but the property record says ${f.expected}.`,
    value: { expected: f.expected, found: f.found, occurrences: f.occurrences, snippet: f.snippet },
  };
}
