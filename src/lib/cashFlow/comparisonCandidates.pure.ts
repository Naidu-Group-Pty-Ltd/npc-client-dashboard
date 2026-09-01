/**
 * Which reports the cash-flow comparison picker may offer.
 *
 * Audit item 16 — one address appeared five times in "Add property". The
 * reporter's reading was that the list captures every report kind rather than
 * the Compass one, and the row counts bear that out exactly: 93 Bimbadeen
 * Avenue has one completed report of each variant — `snapshot`, `briefing`,
 * `strategic`, `financial`, `compass`.
 *
 * But filtering by variant fixes neither half of the problem, and the
 * production numbers are what show it. Measured 2026-08-31 over
 * `investment_reports`:
 *
 *   listed by the picker today                  1,169
 *   …that carry financial_calculations            185
 *   …distinct properties among those               98
 *
 *   compass, completed                          1,106
 *   …that carry financial_calculations            143   (963 do NOT)
 *   compass reports for "10 Chester Street"        20
 *
 * Two things follow.
 *
 * **A comparison needs figures, and 984 of the 1,169 entries have none.** That
 * is the larger defect and it is invisible: the row looks identical to a
 * usable one, and choosing it compares against nothing. Variant is a proxy for
 * this and a poor one — filtering to `compass` would still list 20 rows for
 * 10 Chester Street, and would drop the one property whose only report with
 * figures is not a Compass (98 distinct properties become 97).
 *
 * **It is a property picker.** It says "Add property", its search box says
 * "Search properties…", and it was listing reports. One entry per address,
 * the most recent that has figures — 185 rows become 98.
 *
 * The caller fetches newest-first, and `dedupeByProperty` preserves input
 * order, so "most recent" is a property of the query rather than a second
 * sort here.
 */

export interface ComparisonCandidate {
  id: string;
  property_address?: string | null;
  financial_calculations?: unknown;
}

/**
 * Does this report carry figures a comparison can draw?
 *
 * `financial_calculations` arrives as an object, as `{}` from a report whose
 * generation never reached the financial section, and as null. Only the first
 * is comparable.
 */
export function hasComparableFigures(report: ComparisonCandidate): boolean {
  const figures = report.financial_calculations;
  if (figures === null || figures === undefined) return false;
  if (typeof figures !== 'object') return false;
  if (Array.isArray(figures)) return figures.length > 0;
  return Object.keys(figures as Record<string, unknown>).length > 0;
}

/** A stable key for "the same property", tolerant of case and stray spacing. */
export function propertyKey(address: string | null | undefined): string {
  return String(address ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** First occurrence per address wins, and input order is preserved. */
export function dedupeByProperty<T extends ComparisonCandidate>(reports: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const report of reports) {
    const key = propertyKey(report.property_address);
    // A report with no address cannot be grouped and cannot be labelled, so it
    // is not offered — the picker would draw a blank row.
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(report);
  }
  return out;
}

/**
 * The list to offer, from the list that was fetched.
 *
 * `excludeId` is the report already open — comparing a report with itself is
 * the one entry that is certainly useless.
 */
export function comparisonCandidates<T extends ComparisonCandidate>(
  reports: T[],
  excludeId?: string | null,
): T[] {
  return dedupeByProperty(
    reports.filter((report) => report.id !== excludeId && hasComparableFigures(report)),
  );
}
