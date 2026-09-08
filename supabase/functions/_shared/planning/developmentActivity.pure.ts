/**
 * Development-application intelligence — summarising what a council's DA
 * register actually says, and resolving which register that is.
 *
 * Two measured facts shape this module (probe log in
 * `docs/reports/ZONING_BY_JURISDICTION.md`, 2026-09-06):
 *
 *  1. **The NSW Online DA API's council filter is exact-match**:
 *     `CouncilName: ["MUSWELLBROOK"]` matches nothing, `["MUSWELLBROOK SHIRE
 *     COUNCIL"]` matches 62. The zoning layer answers `LGA_NAME:
 *     "MUSWELLBROOK"`; the DA rows say `"Muswellbrook Shire Council"`. The
 *     suffix varies by council (Shire/City/Regional/Municipal/none), so it is
 *     resolved by comparing NORMALISED token sets against the register's own
 *     council list — and an ambiguous or absent match REFUSES rather than
 *     guessing, because a confident answer for the wrong council is worse
 *     than none.
 *
 *  2. **A page is a sample unless it is the whole register.** The API states
 *     `TotalCount`; the summary carries how many applications it actually
 *     read against that total, so "the largest projects" can never silently
 *     mean "the largest of the first page".
 *
 * Everything here is arithmetic over rows the register returned. Nothing is
 * estimated; a field a row does not carry is skipped and the counts say how
 * many rows carried it.
 */

export interface NswDaRow {
  PlanningPortalApplicationNumber?: unknown;
  CouncilApplicationNumber?: unknown;
  LodgementDate?: unknown;
  DeterminationDate?: unknown;
  CostOfDevelopment?: unknown;
  NumberOfNewDwellings?: unknown;
  ApplicationStatus?: unknown;
  ApplicationType?: unknown;
  Council?: { CouncilName?: unknown };
  DevelopmentType?: Array<{ DevelopmentType?: unknown }>;
  Location?: Array<{ Suburb?: unknown; Postcode?: unknown; FullAddress?: unknown }>;
}

export interface DaSummary {
  councilName: string;
  periodFrom: string;
  periodTo: string;
  /** How many applications the register states for the filter. */
  totalInPeriod: number;
  /** How many rows this summary actually read. */
  rowsRead: number;
  byStatus: Array<{ status: string; count: number }>;
  /** Sum of stated costs, with how many rows stated one. */
  statedCostTotal: number;
  rowsWithCost: number;
  /** Sum of stated new dwellings, with how many rows stated one. */
  newDwellingsTotal: number;
  rowsWithDwellings: number;
  topDevelopmentTypes: Array<{ type: string; count: number }>;
  largestByCost: Array<{
    cost: number;
    types: string[];
    suburb: string | null;
    status: string | null;
    determined: string | null;
    lodged: string | null;
  }>;
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;

/**
 * Strip the organisational dressing from a council name so `MUSWELLBROOK`
 * (a zoning layer's LGA) and `Muswellbrook Shire Council` (the DA register)
 * compare equal — and `CANTERBURY-BANKSTOWN` never matches `BANKSTOWN`.
 */
export function normaliseCouncilTokens(name: string): string {
  const DRESSING = new Set([
    'THE', 'COUNCIL', 'OF', 'CITY', 'SHIRE', 'MUNICIPAL', 'MUNICIPALITY',
    'REGIONAL', 'REGION', 'AREA', 'GREATER',
  ]);
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9\s-]/g, ' ')
    .split(/[\s]+/)
    .filter((t) => t !== '' && !DRESSING.has(t))
    .sort()
    .join(' ');
}

/**
 * The register filters by exact name, but it accepts a LIST — so the lookup
 * sends every dressing of the LGA's own tokens and lets the register say
 * which one exists. A variant that names no real council matches nothing and
 * costs nothing; the resolved name is then read off the ANSWER's rows (the
 * answering service's own field, the same rule the jurisdiction router
 * follows) and validated by `resolveCouncilName` before it is trusted.
 */
export function councilNameCandidates(lgaName: string): string[] {
  const base = lgaName.trim().toUpperCase().replace(/\s+/g, ' ');
  if (base === '') return [];
  const variants = new Set<string>([
    `${base} COUNCIL`,
    `${base} SHIRE COUNCIL`,
    `${base} CITY COUNCIL`,
    `${base} REGIONAL COUNCIL`,
    `${base} MUNICIPAL COUNCIL`,
    `CITY OF ${base}`,
    `COUNCIL OF THE CITY OF ${base}`,
    base,
  ]);
  return [...variants];
}

/**
 * Resolve an LGA name to the register's own council name. Exactly one match
 * resolves; zero or several refuse with the candidates named, because the DA
 * filter is exact-match and a wrong council is a confidently wrong answer.
 */
export function resolveCouncilName(
  lgaName: string,
  registerCouncilNames: readonly string[],
): { resolved: string } | { resolved: null; reason: string } {
  const want = normaliseCouncilTokens(lgaName);
  if (want === '') return { resolved: null, reason: 'LGA name empty after normalisation' };
  const matches = registerCouncilNames.filter((c) => normaliseCouncilTokens(c) === want);
  if (matches.length === 1) return { resolved: matches[0] };
  if (matches.length === 0) {
    return { resolved: null, reason: `no council in the register matches "${lgaName}"` };
  }
  return {
    resolved: null,
    reason: `"${lgaName}" matches ${matches.length} councils (${matches.join('; ')})`,
  };
}

/** Summarise the rows a register returned. Pure arithmetic; nothing inferred. */
export function summariseDaRows(
  rows: readonly NswDaRow[],
  councilName: string,
  periodFrom: string,
  periodTo: string,
  totalInPeriod: number,
): DaSummary {
  const byStatus = new Map<string, number>();
  const byType = new Map<string, number>();
  let statedCostTotal = 0;
  let rowsWithCost = 0;
  let newDwellingsTotal = 0;
  let rowsWithDwellings = 0;

  const costed: DaSummary['largestByCost'] = [];

  for (const row of rows) {
    const status = str(row.ApplicationStatus) ?? 'Not stated';
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);

    const types = (row.DevelopmentType ?? [])
      .map((t) => str(t?.DevelopmentType))
      .filter((t): t is string => t !== null);
    for (const t of types) byType.set(t, (byType.get(t) ?? 0) + 1);

    const cost = num(row.CostOfDevelopment);
    if (cost !== null && cost > 0) {
      statedCostTotal += cost;
      rowsWithCost += 1;
      costed.push({
        cost,
        types,
        suburb: str(row.Location?.[0]?.Suburb),
        status: str(row.ApplicationStatus),
        determined: str(row.DeterminationDate)?.slice(0, 10) ?? null,
        lodged: str(row.LodgementDate)?.slice(0, 10) ?? null,
      });
    }

    const dwellings = num(row.NumberOfNewDwellings);
    if (dwellings !== null && dwellings > 0) {
      newDwellingsTotal += dwellings;
      rowsWithDwellings += 1;
    }
  }

  const sortDesc = <T,>(arr: T[], key: (t: T) => number) =>
    [...arr].sort((a, b) => key(b) - key(a));

  return {
    councilName,
    periodFrom,
    periodTo,
    totalInPeriod,
    rowsRead: rows.length,
    byStatus: sortDesc([...byStatus.entries()].map(([status, count]) => ({ status, count })), (e) => e.count),
    statedCostTotal: Math.round(statedCostTotal),
    rowsWithCost,
    newDwellingsTotal,
    rowsWithDwellings,
    topDevelopmentTypes: sortDesc([...byType.entries()].map(([type, count]) => ({ type, count })), (e) => e.count).slice(0, 6),
    largestByCost: sortDesc(costed, (c) => c.cost).slice(0, 5),
  };
}
