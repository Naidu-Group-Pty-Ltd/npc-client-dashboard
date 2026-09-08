/**
 * The macro-economic reading served to reports, composed from stored RBA
 * statistical-table observations (`rba_observations` / `rba_series_meta`,
 * loaded by rba-tables-ingest) — replacing a path that asked a search model
 * for "exact current values" and coerced whatever came back with `|| 0`.
 *
 * Rules:
 *  - **Every figure carries its own reference period**, read from the
 *    observation's date — "4.35% (monthly average, August 2026)" — because
 *    freshness of a load is not currency of the data.
 *  - **The cash-rate month is a monthly average, never a decision date.**
 *    F1.1's own Description row says "Cash Rate Target; monthly average";
 *    the old path invented `lastDecisionDate` (defaulting to *today*). The
 *    honest derivable fact is the month the monthly average last moved,
 *    which is arithmetic on the series and is labelled as exactly that.
 *  - **Absent is absent**: a series with no stored observation contributes
 *    no figure, and nothing here fills a gap with a plausible number. GDP,
 *    unemployment and participation are not in these tables and are
 *    deliberately not in this reading.
 *  - **A projection is an assumption and says so.** The 10-year CPI path
 *    the financial engine indexes against converges from the measured
 *    year-ended CPI toward the RBA target midpoint; every year's `source`
 *    names it an assumption. The old labels claimed "RBA SMP forecast" for
 *    numbers no one had read from any forecast.
 */

export interface RbaMetaRow {
  series_id: string;
  table_code: string;
  title: string | null;
  description: string | null;
  units: string | null;
  publication_date: string | null;
}

export interface RbaObsRow {
  series_id: string;
  /** ISO date (YYYY-MM-DD). */
  obs_date: string;
  value: number;
}

/** A measured figure with its own reference period. */
export interface MacroFigure {
  value: number;
  /** '2026-08' for monthly series, '2026-06' (quarter-end month) for quarterly. */
  period: string;
  /** 'August 2026' / 'June quarter 2026' — for prose and table cells. */
  periodLabel: string;
}

export interface MacroReading {
  cashRate: {
    current: MacroFigure;
    /** The series' own Description ("Cash Rate Target; monthly average"). */
    basis: string;
    /** The month the monthly average last moved — arithmetic, not a board date. */
    lastMove: { periodLabel: string; from: number; to: number } | null;
    publicationDate: string | null;
    source: string;
  } | null;
  inflation: {
    yearEnded: MacroFigure | null;
    trimmedMeanYearEnded: MacroFigure | null;
    quarterly: MacroFigure | null;
    index: (MacroFigure & { base: string }) | null;
    /** The RBA's published medium-term target — a fact about the target, not a reading. */
    targetBand: string;
    publicationDate: string | null;
    source: string;
  } | null;
  lendingRates: {
    ownerOccupier: {
      standardVariable: MacroFigure | null;
      discountedVariable: MacroFigure | null;
      threeYearFixed: MacroFigure | null;
    };
    investor: {
      standardVariable: MacroFigure | null;
      discountedVariable: MacroFigure | null;
      threeYearFixed: MacroFigure | null;
    };
    basis: string;
    publicationDate: string | null;
    source: string;
  } | null;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/** 'August 2026' from a monthly observation's date. */
export function monthLabel(isoDate: string): string {
  const [y, m] = isoDate.split('-');
  return `${MONTHS[Number(m) - 1]} ${y}`;
}

/** 'June quarter 2026' from a quarter-end observation's date (ABS wording). */
export function quarterLabel(isoDate: string): string {
  return `${monthLabel(isoDate).replace(' ', ' quarter ')}`;
}

const period = (isoDate: string): string => isoDate.slice(0, 7);

function latestOf(obs: RbaObsRow[], seriesId: string): RbaObsRow | null {
  let best: RbaObsRow | null = null;
  for (const o of obs) {
    if (o.series_id !== seriesId) continue;
    if (!Number.isFinite(o.value)) continue;
    if (!best || o.obs_date > best.obs_date) best = o;
  }
  return best;
}

const monthly = (obs: RbaObsRow[], id: string): MacroFigure | null => {
  const o = latestOf(obs, id);
  return o ? { value: o.value, period: period(o.obs_date), periodLabel: monthLabel(o.obs_date) } : null;
};

const quarterly = (obs: RbaObsRow[], id: string): MacroFigure | null => {
  const o = latestOf(obs, id);
  return o ? { value: o.value, period: period(o.obs_date), periodLabel: quarterLabel(o.obs_date) } : null;
};

/**
 * The month the series' value last differed from the month before it —
 * found by walking the ordered series, never asserted from anywhere else.
 * Null when the series never moves in the window supplied.
 */
export function lastMoveOf(obs: RbaObsRow[], seriesId: string): { periodLabel: string; from: number; to: number } | null {
  const series = obs
    .filter((o) => o.series_id === seriesId && Number.isFinite(o.value))
    .sort((a, b) => (a.obs_date < b.obs_date ? -1 : 1));
  for (let i = series.length - 1; i >= 1; i--) {
    if (series[i].value !== series[i - 1].value) {
      return { periodLabel: monthLabel(series[i].obs_date), from: series[i - 1].value, to: series[i].value };
    }
  }
  return null;
}

const metaOf = (meta: RbaMetaRow[], id: string): RbaMetaRow | null =>
  meta.find((m) => m.series_id === id) ?? null;

/**
 * Compose the reading. Null only when nothing at all is loaded; otherwise
 * each component is present exactly where its series holds observations.
 */
export function buildMacroReading(meta: RbaMetaRow[], obs: RbaObsRow[]): MacroReading | null {
  const cash = monthly(obs, 'FIRMMCRT');
  const cashMeta = metaOf(meta, 'FIRMMCRT');

  const yearEnded = quarterly(obs, 'GCPIAGYP');
  const trimmed = quarterly(obs, 'GCPIOCPMTMYP');
  const qtr = quarterly(obs, 'GCPIAGSAQP');
  const indexFig = quarterly(obs, 'GCPIAG');
  const indexMeta = metaOf(meta, 'GCPIAG');
  const g1Meta = metaOf(meta, 'GCPIAGYP') ?? indexMeta;

  const ooStd = monthly(obs, 'FILRHLBVS');
  const ooDisc = monthly(obs, 'FILRHLBVD');
  const ooFixed = monthly(obs, 'FILRHL3YF');
  const invStd = monthly(obs, 'FILRHLBVSI');
  const invDisc = monthly(obs, 'FILRHLBVDI');
  const invFixed = monthly(obs, 'FILRHL3YFI');
  const f5Meta = metaOf(meta, 'FILRHLBVS');

  const cashRate = cash
    ? {
      current: cash,
      basis: cashMeta?.description ?? 'Cash Rate Target; monthly average',
      lastMove: lastMoveOf(obs, 'FIRMMCRT'),
      publicationDate: cashMeta?.publication_date ?? null,
      source: 'RBA statistical table F1.1',
    }
    : null;

  const inflation = (yearEnded || trimmed || qtr || indexFig)
    ? {
      yearEnded,
      trimmedMeanYearEnded: trimmed,
      quarterly: qtr,
      index: indexFig && indexMeta?.units ? { ...indexFig, base: indexMeta.units } : null,
      targetBand: '2–3 per cent',
      publicationDate: g1Meta?.publication_date ?? null,
      source: 'RBA statistical table G1 (ABS Consumer Price Index)',
    }
    : null;

  const anyLending = ooStd || ooDisc || ooFixed || invStd || invDisc || invFixed;
  const lendingRates = anyLending
    ? {
      ownerOccupier: { standardVariable: ooStd, discountedVariable: ooDisc, threeYearFixed: ooFixed },
      investor: { standardVariable: invStd, discountedVariable: invDisc, threeYearFixed: invFixed },
      basis: 'Banks’ indicator housing lending rates',
      publicationDate: f5Meta?.publication_date ?? null,
      source: 'RBA statistical table F5',
    }
    : null;

  if (!cashRate && !inflation && !lendingRates) return null;
  return { cashRate, inflation, lendingRates };
}

// ---------------------------------------------------------------------------
// The 10-year CPI path the financial engine indexes against
// ---------------------------------------------------------------------------

export interface CpiProjectionYear {
  year: number;
  cpiPercent: number;
  source: string;
}

export const RBA_TARGET_MIDPOINT = 2.5;

/**
 * A named assumption, not a forecast: converge from the measured year-ended
 * CPI toward the RBA target midpoint (the same arithmetic the old path used
 * as its silent fallback — kept because it is a reasonable indexation
 * assumption, and now labelled as one on every year). With no measured CPI
 * the path is flat at the target midpoint and says that too.
 */
export function cpiProjectionsFromMeasured(measured: MacroFigure | null): CpiProjectionYear[] {
  const years = Array.from({ length: 10 }, (_, i) => i + 1);
  if (!measured) {
    return years.map((year) => ({
      year,
      cpiPercent: RBA_TARGET_MIDPOINT,
      source: 'Assumption — RBA inflation target midpoint of 2.5% (no measured CPI reading was available)',
    }));
  }
  const label =
    `Assumption — convergence from measured year-ended CPI (${measured.value}%, ${measured.periodLabel}) toward the RBA inflation target midpoint of 2.5%`;
  return years.map((year) => {
    const convergence = 1 - Math.pow(0.8, year);
    const projected = measured.value + (RBA_TARGET_MIDPOINT - measured.value) * convergence;
    return { year, cpiPercent: Math.round(projected * 10) / 10, source: label };
  });
}
