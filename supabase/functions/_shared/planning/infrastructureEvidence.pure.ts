/**
 * The infrastructure and development a report may describe, and what each
 * item's status actually rests on.
 *
 * ## The defect this exists to end
 *
 * The prompt asked for an infrastructure pipeline whether or not a single
 * project was evidenced. Its own worked examples were the shape of the
 * problem: a SWOT strength reading *"**Metro connectivity:** [Metro Line]
 * opened [Year], fundamentally improving transport profile … This
 * infrastructure investment typically drives long-term capital growth"*, an
 * opportunity reading *"**Infrastructure development:** Planned residential
 * and commercial developments in [Suburb] region support continued population
 * growth and property appreciation"*, and a directive requiring every
 * pipeline to be drawn as a `{{timeline: Existing … 0-2y … 3-5y … 5y+}}`
 * ribbon. None of that is a question a model can answer from the record, so
 * what came back was a plausible pipeline: named projects, horizons, and a
 * causal claim about capital growth, with nothing behind any of it.
 *
 * Meanwhile the enrichment already holds evidenced development facts and the
 * outlook sections used none of them — the same shape as the zoning section
 * (`planningFacts.pure.ts`). Queensland's StatePlanning layers answer, at the
 * property's own coordinate, whether it sits inside a declared priority
 * development area, state development area, coordinated project or
 * infrastructure designation, each with the publisher's own status word and
 * its gazettal date. New South Wales' Online DA register answers what has
 * been lodged and determined in the council over a stated window, with costs,
 * dwelling counts and the largest applications by cost.
 *
 * ## The rules
 *
 * 1. **A project is named only where a register named it.** There is no
 *    inferred pipeline and no horizon a publisher did not state.
 * 2. **A status is the publisher's own word.** The vocabulary a reader needs
 *    — proposed, approved, funded, under construction, completed, delayed,
 *    cancelled — is added in parentheses ONLY where the publisher's word maps
 *    onto it unambiguously. An unrecognised word is printed as it stands
 *    rather than forced into a category it may not belong in. Approval is not
 *    funding and funding is not delivery, so nothing here promotes one to
 *    another.
 * 3. **A completion date is never invented.** A gazettal or determination
 *    date is a date something HAPPENED, and it is labelled as that. Where a
 *    register states no delivery date, the item says so.
 * 4. **An announcement is never a capital-growth claim.** Nothing composed
 *    here quantifies an uplift or asserts that a project will raise values,
 *    and the rules handed to the model forbid it in the prose beside this.
 * 5. **Coverage is stated honestly, every time.** What these two registers do
 *    NOT cover — council capital works, state budget programmes, agency
 *    announcements, transport and utility projects — is named on the page, so
 *    a short list reads as a short search rather than a quiet area.
 * 6. **Development nearby cuts both ways.** Dwellings in the pipeline are
 *    competing supply as well as a sign of confidence, and the reading says
 *    so rather than filing them under opportunity.
 *
 * Pure: no fetch, no Deno, no clock.
 */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** What a reader needs to know about where a project has got to. */
export type DeliveryStanding =
  | 'proposed'
  | 'approved'
  | 'funded'
  | 'under_construction'
  | 'completed'
  | 'delayed'
  | 'cancelled';

export const DELIVERY_STANDING_LABEL: Readonly<Record<DeliveryStanding, string>> = {
  proposed: 'Proposed',
  approved: 'Approved',
  funded: 'Funded',
  under_construction: 'Under construction',
  completed: 'Completed',
  delayed: 'Delayed',
  cancelled: 'Cancelled',
};

/**
 * A publisher's status word, read onto the reader's vocabulary — or not.
 *
 * Deliberately narrow (rule 2). Every entry is a phrase a register actually
 * publishes, and anything else answers null so the publisher's own word is
 * printed unmapped. "Approved" is never read as funded and "funded" is never
 * read as under construction: those are the three a reader most wants
 * collapsed and the three it would be most expensive to collapse wrongly.
 */
export function readDeliveryStanding(raw: string | null): DeliveryStanding | null {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) return null;
  if (/^(lodged|under assessment|pending|on exhibition|proposed|nominated)\b/.test(s)) return 'proposed';
  if (/^(approved|determined - approved|determination - approved|granted|declared|gazetted)\b/.test(s)) return 'approved';
  if (/^(funded|committed|budgeted)\b/.test(s)) return 'funded';
  if (/^(under construction|construction|commenced|in delivery)\b/.test(s)) return 'under_construction';
  if (/^(complete|completed|finalised|operational)\b/.test(s)) return 'completed';
  if (/^(deferred|delayed|on hold|paused)\b/.test(s)) return 'delayed';
  if (/^(withdrawn|refused|rejected|cancelled|lapsed|discontinued)\b/.test(s)) return 'cancelled';
  return null;
}

export interface InfrastructureItem {
  /** What it is, in the publisher's own words. */
  name: string;
  /** The kind of instrument or application. */
  kind: string;
  /** The publisher's status word, verbatim. Null where it stated none. */
  statedStatus: string | null;
  /** That word read onto the reader's vocabulary, where it maps (rule 2). */
  standing: DeliveryStanding | null;
  /** A date something HAPPENED, with what happened. Never a forecast (rule 3). */
  dateLabel: string | null;
  date: string | null;
  /** Where, as the register states it. Null where it states nothing. */
  where: string | null;
  /** Stated cost of development, where a register carries one. */
  statedCost: number | null;
  /** The publisher and dataset. */
  source: string;
  licence: string | null;
  /** When this deployment retrieved it. */
  retrievedAt: string | null;
}

export interface InfrastructureEvidence {
  items: InfrastructureItem[];
  /** Dwellings the register says are in the pipeline nearby, and over what. */
  pipelineDwellings: { total: number; rowsStating: number; window: string; council: string } | null;
  /** Aggregate stated investment, with how many rows stated one. */
  pipelineInvestment: { total: number; rowsStating: number } | null;
  /** Why an empty list is empty, per register. */
  absences: string[];
  /** What these registers do not reach at all (rule 5). */
  coverageLimits: string[];
  retrievedAt: string | null;
  /** True when at least one register answered with something. */
  anyEvidenced: boolean;
  /** True when the enrichment never ran. */
  enrichmentMissing: boolean;
}

const INSTRUMENT_LABEL: Record<string, string> = {
  priority_development_area: 'Priority development area',
  state_development_area: 'State development area',
  coordinated_project: 'Coordinated project',
  infrastructure_designation: 'Infrastructure designation',
};

/**
 * What these two registers cannot see.
 *
 * Named on every reading, including a full one, because a list of two
 * instruments with no coverage statement reads as "these are the projects
 * around this property" — which is a claim neither register makes.
 */
export const INFRASTRUCTURE_COVERAGE_LIMITS: readonly string[] = [
  'council capital works programmes and their budgets',
  'state and federal budget infrastructure programmes',
  'transport, water, energy and health agency project announcements',
  'projects outside the local government area the registers were asked about',
];

export interface InfrastructureEvidenceInput {
  /** `enhancedData.planningData` — the planning service's answer, or absent. */
  planningData?: unknown;
}

export function buildInfrastructureEvidence(input: InfrastructureEvidenceInput): InfrastructureEvidence {
  const data = isRecord(input.planningData) ? input.planningData : null;
  const retrievedAt = data ? str(data.fetchedAt) : null;
  const items: InfrastructureItem[] = [];
  const absences: string[] = [];

  // ── state development instruments, at the property's own coordinate ───────
  const inst = isRecord(data?.developmentInstruments) ? data!.developmentInstruments : null;
  if (inst?.status === 'ok' && Array.isArray(inst.instruments)) {
    const source = str(inst.source) ?? 'state planning layers';
    const licence = str(inst.licence);
    for (const raw of inst.instruments as unknown[]) {
      if (!isRecord(raw)) continue;
      const name = str(raw.name);
      if (!name) continue;
      const statedStatus = str(raw.status);
      items.push({
        name,
        kind: INSTRUMENT_LABEL[str(raw.kind) ?? ''] ?? (str(raw.kind) ?? 'Instrument'),
        statedStatus,
        standing: readDeliveryStanding(statedStatus),
        // A gazettal is a declaration, not a delivery. Rule 3.
        dateLabel: str(raw.gazetted) ? 'Gazetted' : null,
        date: str(raw.gazetted),
        where: str(raw.detail),
        statedCost: null,
        source,
        licence,
        retrievedAt,
      });
    }
  } else if (inst) {
    absences.push(str(inst.note) ?? 'No state development-instrument reading for this point.');
  }

  /*
   * ── the strategic designations the point sits inside ─────────────────────
   *
   * Added 17 Sep 2026, and the measurement is why. The instruments probe asks
   * four named Queensland layers — priority development areas, state
   * development areas, coordinated projects, infrastructure designations — and
   * at 262 Pallas Street none of them matched, so the report said "the
   * property lies inside no declared priority development area, state
   * development area, coordinated project or infrastructure designation" and
   * stopped. True, and it left out what the SAME service returns at the SAME
   * coordinate: `Maryborough Priority Living Area`, inside the `Wide Bay
   * Burnett Regional Plan`, **Legal status: Statutory, Version: December
   * 2023**.
   *
   * A regional plan does not control what is built on one lot, and nothing
   * here says it does — `standing` is null and the kind is the register's own
   * word. What it does is state, in the publisher's own instrument, what the
   * area is planned to BECOME, which is the most reliable published statement
   * about long-term direction a report of this kind can carry. The legacy
   * long-form report filled that space by inventing a station, a freeway
   * extension and a dwelling target.
   *
   * It is drawn from the constraint register's `context` readings alone.
   * Anything the register filed as a hazard, a development control or a
   * protected value belongs to the planning section, not to this one.
   */
  const contextual = Array.isArray(data?.constraints) ? data!.constraints as unknown[] : [];
  for (const raw of contextual) {
    if (!isRecord(raw)) continue;
    if (str(raw.kind) !== 'context') continue;
    const name = str(raw.label);
    if (!name) continue;
    const family = str(raw.family);
    items.push({
      name,
      kind: family === 'regionalPlan' ? 'Regional plan'
        : family === 'growthArea' ? 'Growth / priority area'
          : 'Strategic designation',
      /*
       * The publisher's own word for the instrument's standing, and NOT
       * `detail`.
       *
       * `detail` is a join of everything the layer published — legal status,
       * version, region, hazard class — which reads correctly in the planning
       * register's "What the register returned" column and is wrong in a
       * column called **Status**. On 262 Pallas Street the Priority Living
       * Area's `detail` is `Wide Bay Burnett`, so the first render of this
       * table gave a project the status "Wide Bay Burnett", which is a region.
       *
       * Where the register stated no standing the cell is empty, and the
       * renderer prints an em dash: a designation with no published standing
       * is a real state, and inventing one is the defect above in the other
       * direction.
       */
      statedStatus: str(raw.standingLabel),
      // A designation is not a project and has no delivery standing. Reading
      // one as `approved` would put a plan in the same column as a road under
      // construction.
      standing: null,
      dateLabel: str(raw.currencyDate) ? 'Current at' : null,
      date: str(raw.currencyDate),
      // The region the register named — a place. It used to be `instrument`,
      // which is a layer or plan name: "Priority Living Area" is not a WHERE,
      // and on the regional-plan row it repeated the project's own name.
      where: str(raw.region),
      statedCost: null,
      source: str(raw.source) ?? 'state planning layers',
      licence: str(raw.licence),
      retrievedAt,
    });
  }

  // ── the council's own development-application register ────────────────────
  const act = isRecord(data?.developmentActivity) ? data!.developmentActivity : null;
  const summary = act?.status === 'ok' && isRecord(act.summary) ? act.summary : null;
  let pipelineDwellings: InfrastructureEvidence['pipelineDwellings'] = null;
  let pipelineInvestment: InfrastructureEvidence['pipelineInvestment'] = null;
  if (summary) {
    const source = str(act?.source) ?? 'the council development-application register';
    const licence = str(act?.licence);
    const council = str(summary.councilName) ?? 'the council';
    const window = `${str(summary.periodFrom) ?? ''} to ${str(summary.periodTo) ?? ''}`.trim();
    const dwellings = num(summary.newDwellingsTotal);
    if (dwellings !== null) {
      pipelineDwellings = {
        total: dwellings,
        rowsStating: num(summary.rowsWithDwellings) ?? 0,
        window,
        council,
      };
    }
    const cost = num(summary.statedCostTotal);
    if (cost !== null) {
      pipelineInvestment = { total: cost, rowsStating: num(summary.rowsWithCost) ?? 0 };
    }
    for (const raw of Array.isArray(summary.largestByCost) ? summary.largestByCost as unknown[] : []) {
      if (!isRecord(raw)) continue;
      const types = Array.isArray(raw.types) ? (raw.types as unknown[]).map((t) => str(t)).filter((t): t is string => !!t) : [];
      const statedStatus = str(raw.status);
      const determined = str(raw.determined);
      const lodged = str(raw.lodged);
      items.push({
        name: types.length ? types.join(', ') : 'Development application',
        kind: 'Development application',
        statedStatus,
        standing: readDeliveryStanding(statedStatus),
        // A determination date is when a decision was made; a lodgement date
        // is when one was asked for. Neither is a completion date (rule 3).
        dateLabel: determined ? 'Determined' : lodged ? 'Lodged' : null,
        date: determined ?? lodged,
        where: str(raw.suburb),
        statedCost: num(raw.cost),
        source,
        licence,
        retrievedAt,
      });
    }
  } else if (act) {
    absences.push(str(act.note) ?? 'No development-application register reading for this jurisdiction.');
  }

  return {
    items,
    pipelineDwellings,
    pipelineInvestment,
    absences,
    coverageLimits: [...INFRASTRUCTURE_COVERAGE_LIMITS],
    retrievedAt,
    anyEvidenced: items.length > 0 || pipelineDwellings !== null,
    enrichmentMissing: !data,
  };
}

// ---------------------------------------------------------------------------
// Rendering

/** `1 Jan 2026` from an ISO date, or the string back if it is not one. */
function auDate(iso: string | null): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
}

const money = (v: number): string => `$${Math.round(v).toLocaleString('en-AU')}`;

/** The status cell: the publisher's word, and the reading where one is certain. */
function statusCell(item: InfrastructureItem): string {
  if (!item.statedStatus) return 'Status not stated by the register';
  const read = item.standing ? DELIVERY_STANDING_LABEL[item.standing] : null;
  return read && read.toLowerCase() !== item.statedStatus.toLowerCase()
    ? `${item.statedStatus} (${read})`
    : item.statedStatus;
}

/**
 * The evidenced outlook a client reads.
 *
 * Composed here rather than asked of a model, because every row is either
 * retrieved or absent and neither is a writing task.
 */
export function renderInfrastructureOutlook(evidence: InfrastructureEvidence): string {
  const lines: string[] = [];

  if (evidence.items.length) {
    lines.push('| Project or instrument | Type | Status | Date recorded | Where | Stated cost |');
    lines.push('|---|---|---|---|---|---|');
    for (const i of evidence.items) {
      const when = i.date ? `${i.dateLabel ?? 'Recorded'} ${auDate(i.date)}` : 'No date stated';
      lines.push(
        `| ${i.name} | ${i.kind} | ${statusCell(i)} | ${when} | ${i.where ?? '—'} | `
        + `${i.statedCost !== null ? money(i.statedCost) : '—'} |`,
      );
    }
    lines.push('');
    const sources = [...new Set(evidence.items.map((i) => `${i.source}${i.licence ? ` (${i.licence})` : ''}`))];
    lines.push(`Sources: ${sources.join('; ')}. Retrieved ${auDate(evidence.retrievedAt) ?? 'this run'}.`);
    lines.push('');
  }

  if (evidence.pipelineDwellings) {
    const d = evidence.pipelineDwellings;
    lines.push(
      `**Dwellings in the register's pipeline.** ${d.total.toLocaleString('en-AU')} new dwellings were stated across `
      + `${d.rowsStating} application${d.rowsStating === 1 ? '' : 's'} in ${d.council}${d.window ? `, ${d.window}` : ''}`
      + `${evidence.pipelineInvestment
        ? `, with ${money(evidence.pipelineInvestment.total)} of stated development cost across `
          + `${evidence.pipelineInvestment.rowsStating} application${evidence.pipelineInvestment.rowsStating === 1 ? '' : 's'}`
        : ''}. `
      + 'That is activity in the local government area, not at this address, and it reads both ways: it is a sign of '
      + 'confidence in the area and it is competing supply for a landlord letting a comparable dwelling.',
    );
    lines.push('');
  }

  for (const note of evidence.absences) {
    lines.push(`**Not retrieved.** ${note}`);
    lines.push('');
  }

  // Rule 5, stated whether the list is long or empty.
  lines.push(
    '**What this covers, and what it does not.** These entries come from the planning registers this platform '
    + 'reads at the property\'s own coordinate and for its local government area. They do NOT cover '
    + `${evidence.coverageLimits.join(', ')}. A short list here is a statement about those registers rather than `
    + 'a finding that nothing is planned nearby.',
  );
  lines.push('');
  lines.push(
    '**What a status means.** Each status above is the register\'s own word. An approval is not funding, funding is '
    + 'not a start on site, and a date recorded above is the date something was decided or declared — not a '
    + 'completion date. No delivery date is stated here unless a publisher stated one.',
  );

  return lines.join('\n');
}

/** The rules the prose beside the table must obey. */
export function infrastructureRules(evidence: InfrastructureEvidence): string {
  if (evidence.enrichmentMissing || !evidence.anyEvidenced) {
    return [
      'INFRASTRUCTURE RULES FOR THE WHOLE REPORT — nothing was retrieved for this property. They apply in '
      + 'every section and override anything a live web search returns.',
      '1. Say in one sentence that no infrastructure project or development instrument was retrieved for this '
      + 'location, and that this is a statement about the registers searched rather than a finding that nothing '
      + 'is planned.',
      '2. Do NOT name a project, a rail line, a station, a hospital, a road upgrade, a town-centre renewal or a '
      + 'delivery horizon — not from a budget page, a news article or an agency media release found by search. '
      + 'Do NOT draw a `{{timeline: …}}` pipeline. There is nothing to put in it.',
      '3. Do NOT say that infrastructure supports, drives or underwrites capital growth for this property. That is '
      + 'a causal claim, and there is no project here to hang it on.',
    ].join('\n');
  }
  return [
    'INFRASTRUCTURE RULES FOR THE WHOLE REPORT — they apply in every section and override any example '
    + 'elsewhere in this prompt AND anything a live web search returns:',
    '1. The evidenced table above is supplied complete. Name only the projects in it. Do NOT add a rail line, a '
    + 'station, a hospital, a road upgrade or a town-centre renewal that is not in it — including one found by '
    + 'live web search — and do not invent a bracketed placeholder for one.',
    '2. Use each item\'s status as the table states it. An approval is not funding, funding is not a start on site, '
    + 'and none of them is a completion. Do NOT state or imply a completion date; the dates above are dates a '
    + 'decision or declaration was recorded.',
    '3. Do NOT quantify an uplift, a percentage or a dollar effect on value from any project, and do not assert '
    + 'that a project will raise prices or rents. Describe what is proposed or approved and let the reader weigh it.',
    '4. Dwellings in the pipeline are competing supply as well as a sign of confidence. Say both.',
    '5. Draw a `{{timeline: …}}` only from items in the table, using the dates the table carries. If the table '
    + 'carries no dates, draw no timeline.',
    '6. Repeat the coverage limitation in your own words: these registers do not cover council capital works, '
    + 'budget programmes or agency announcements, so a short list is a short search.',
  ].join('\n');
}
