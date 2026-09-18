/**
 * The infrastructure a report may describe.
 *
 * The prompt asked for a pipeline whether or not a single project was
 * evidenced, and its own worked examples showed what that produces: a metro
 * line that opened in a year the prompt left blank, "planned residential and
 * commercial developments" in a suburb, and a `{{timeline:}}` ribbon with
 * horizons nobody published — each carrying a claim about capital growth.
 *
 * The fixtures below are the two registers the enrichment already holds: the
 * Queensland StatePlanning answer for 262 Pallas Street (an evidenced
 * `none_at_point`) and a New South Wales DA register summary in the shape
 * `summariseDaRows` produces.
 */
import { describe, expect, it } from 'vitest';
import {
  buildInfrastructureEvidence,
  infrastructureRules,
  readDeliveryStanding,
  renderInfrastructureOutlook,
} from '../../../../supabase/functions/_shared/planning/infrastructureEvidence.pure';

const PALLAS = {
  jurisdiction: 'QLD',
  developmentInstruments: {
    status: 'none_at_point',
    note: 'The property lies inside no declared priority development area, state development area, coordinated '
      + 'project or infrastructure designation (Queensland StatePlanning layers, checked at the coordinate).',
  },
  developmentActivity: {
    status: 'not_served',
    note: 'No state-wide development-application feed exists for this jurisdiction.',
  },
  fetchedAt: '2026-09-16T04:12:33.000Z',
};

const WITH_PROJECTS = {
  jurisdiction: 'QLD',
  developmentInstruments: {
    status: 'ok',
    source: 'Queensland StatePlanning layers',
    licence: 'CC BY 4.0',
    instruments: [
      { kind: 'priority_development_area', name: 'Maryborough PDA', status: 'Declared', gazetted: '2024-11-08', detail: 'Whole of the town centre' },
      { kind: 'coordinated_project', name: 'Northern rail link', status: 'Under construction', gazetted: '2025-03-02', detail: null },
    ],
  },
  developmentActivity: {
    status: 'ok',
    source: 'NSW Planning Portal — Online DA API',
    licence: 'CC BY 4.0',
    summary: {
      councilName: 'Fraser Coast Regional Council',
      periodFrom: '2026-03-17', periodTo: '2026-09-16',
      totalInPeriod: 62, rowsRead: 62,
      statedCostTotal: 41_250_000, rowsWithCost: 48,
      newDwellingsTotal: 214, rowsWithDwellings: 31,
      largestByCost: [
        { cost: 18_400_000, types: ['Residential — multi dwelling'], suburb: 'Maryborough', status: 'Determined - Approved', determined: '2026-06-04', lodged: '2026-01-11' },
        { cost: 6_900_000, types: ['Retail premises'], suburb: 'Pialba', status: 'Lodged', determined: null, lodged: '2026-05-22' },
      ],
    },
  },
  fetchedAt: '2026-09-16T04:12:33.000Z',
};

describe('a status is the publisher’s own word', () => {
  it('reads the ones that map, and only those', () => {
    expect(readDeliveryStanding('Lodged')).toBe('proposed');
    expect(readDeliveryStanding('Determined - Approved')).toBe('approved');
    expect(readDeliveryStanding('Under construction')).toBe('under_construction');
    expect(readDeliveryStanding('Withdrawn')).toBe('cancelled');
    expect(readDeliveryStanding('On hold')).toBe('delayed');
  });

  it('never promotes an approval to funding or a start on site', () => {
    // The three a reader most wants collapsed, and the three it would be most
    // expensive to collapse wrongly.
    expect(readDeliveryStanding('Approved')).toBe('approved');
    expect(readDeliveryStanding('Funded')).toBe('funded');
    expect(readDeliveryStanding('Approved in principle subject to funding')).toBe('approved');
  });

  it('answers nothing for a word it does not know', () => {
    for (const word of ['Stage 2 endorsement', 'Referred', '', 'Q3']) {
      expect(readDeliveryStanding(word), word).toBeNull();
    }
  });
});

describe('an evidenced negative', () => {
  const evidence = buildInfrastructureEvidence({ planningData: PALLAS });

  it('carries no items and says why, per register', () => {
    expect(evidence.items).toEqual([]);
    expect(evidence.anyEvidenced).toBe(false);
    expect(evidence.absences).toHaveLength(2);
    expect(evidence.absences[0]).toMatch(/no declared priority development area/);
    expect(evidence.absences[1]).toMatch(/No state-wide development-application feed/);
  });

  it('forbids the whole pipeline rather than inviting a plausible one', () => {
    const rules = infrastructureRules(evidence);
    expect(rules).toMatch(/Do NOT name a project, a rail line, a station/);
    expect(rules).toMatch(/Do NOT draw a `\{\{timeline: …\}\}` pipeline/);
    expect(rules).toMatch(/Do NOT say that infrastructure supports, drives or underwrites capital growth/);
  });

  it('still states coverage, so a short list reads as a short search', () => {
    const rendered = renderInfrastructureOutlook(evidence);
    expect(rendered).toMatch(/council capital works programmes/);
    expect(rendered).toMatch(/a statement about those registers rather than/);
  });
});

describe('what the registers do answer', () => {
  const evidence = buildInfrastructureEvidence({ planningData: WITH_PROJECTS });

  it('names only what a register named', () => {
    expect(evidence.items.map((i) => i.name)).toEqual([
      'Maryborough PDA', 'Northern rail link',
      'Residential — multi dwelling', 'Retail premises',
    ]);
    expect(evidence.anyEvidenced).toBe(true);
  });

  it('labels a date by what happened, never as a completion', () => {
    const rendered = renderInfrastructureOutlook(evidence);
    expect(rendered).toMatch(/Gazetted 8 Nov 2024/);
    expect(rendered).toMatch(/Determined 4 Jun 2026/);
    expect(rendered).toMatch(/Lodged 22 May 2026/);
    expect(rendered).toMatch(/not a completion date/);
    // Nothing anywhere is a forecast delivery date.
    expect(rendered).not.toMatch(/due (in|by)|expected (in|by)|completion (in|by)/i);
  });

  it('prints the publisher’s word and the reading beside it', () => {
    const rendered = renderInfrastructureOutlook(evidence);
    expect(rendered).toContain('| Declared (Approved) |');
    expect(rendered).toContain('| Determined - Approved (Approved) |');
    // A word that already IS the reading is not doubled.
    expect(rendered).toContain('| Under construction |');
    expect(rendered).not.toContain('Under construction (Under construction)');
  });

  it('reads dwellings in the pipeline both ways', () => {
    expect(evidence.pipelineDwellings).toMatchObject({ total: 214, rowsStating: 31 });
    const rendered = renderInfrastructureOutlook(evidence);
    expect(rendered).toMatch(/214 new dwellings/);
    expect(rendered).toMatch(/\$41,250,000 of stated development cost/);
    expect(rendered).toMatch(/competing supply/);
    // And never as a claim about this address.
    expect(rendered).toMatch(/not at this address/);
  });

  it('never lets the prose beside it quantify an uplift', () => {
    const rules = infrastructureRules(evidence);
    expect(rules).toMatch(/Do NOT quantify an uplift/);
    expect(rules).toMatch(/An approval is not funding, funding is not a start on site/);
    expect(rules).toMatch(/only from items in the table/);
  });
});

describe('an enrichment that never ran', () => {
  it('is the same refusal as an empty one, and says so', () => {
    const evidence = buildInfrastructureEvidence({});
    expect(evidence.enrichmentMissing).toBe(true);
    expect(infrastructureRules(evidence)).toMatch(/nothing was retrieved/);
  });
});

describe('the rules claim the whole report, and name live search', () => {
  /*
   * The 17 Sep 2026 regeneration of 262 Pallas Street drew this, from an
   * enrichment that had answered `none_at_point`:
   *
   *   {{timeline: Existing "Bruce Highway & northern rail access…",
   *     0-2y "Bruce Highway upgrades around Maryborough…",
   *     0-2y "Manufacturing Centre of Excellence – Maryborough TAFE",
   *     0-2y "One Mile State School amenities upgrade"}}
   *
   * Nothing there came from a register this platform reads; it came from the
   * model's own live search, and the horizons came from nowhere at all. The
   * rules had two gaps: they scoped themselves to a section that does not
   * exist in the Compass list, and they never said that a budget page or a
   * media release found by search is not an entry in the table.
   */
  it('on an empty register', () => {
    const rules = infrastructureRules(buildInfrastructureEvidence({ planningData: PALLAS }));
    expect(rules).toMatch(/FOR THE WHOLE REPORT/);
    expect(rules).toMatch(/live web search/);
    expect(rules).toMatch(/budget page, a news article or an agency media release/);
  });

  it('on a full one', () => {
    const rules = infrastructureRules(buildInfrastructureEvidence({ planningData: WITH_PROJECTS }));
    expect(rules).toMatch(/FOR THE WHOLE REPORT/);
    expect(rules).toMatch(/live web search/);
    expect(rules).not.toMatch(/INFRASTRUCTURE RULES — these override/);
  });
});

describe('the strategic designation the point sits inside', () => {
  /*
   * Measured at 262 Pallas Street, Maryborough on 17 Sep 2026 (pg_net request
   * id 263994). The instruments probe asks four NAMED Queensland layers —
   * priority development areas, state development areas, coordinated projects,
   * infrastructure designations — and none of them matched, so the report said
   * "the property lies inside no declared priority development area, state
   * development area, coordinated project or infrastructure designation" and
   * stopped.
   *
   * True, and it left out what the SAME service returns at the SAME
   * coordinate. This is the verbatim answer.
   */
  const WITH_CONTEXT = {
    ...PALLAS,
    constraints: [
      {
        family: 'growthArea', kind: 'context', label: 'Maryborough Priority Living Area',
        code: null, value: null, instrument: 'Priority Living Area', clause: null,
        currencyDate: null, detail: 'Wide Bay Burnett',
        standingLabel: null, region: 'Wide Bay Burnett',
        source: 'Queensland StatePlanning', licence: 'CC BY 4.0',
      },
      {
        family: 'regionalPlan', kind: 'context', label: 'Wide Bay Burnett Regional Plan',
        code: null, value: null, instrument: 'Wide Bay Burnett Regional Plan', clause: null,
        currencyDate: null, detail: 'Statutory instrument · version December 2023',
        standingLabel: 'Statutory instrument · version December 2023', region: null,
        source: 'Queensland StatePlanning', licence: 'CC BY 4.0',
      },
      // A hazard belongs to the planning section, never to this one.
      {
        family: 'flood', kind: 'hazard', label: 'Rapid Hazard Assessment',
        code: null, value: null, instrument: null, clause: null,
        currencyDate: null, detail: null, standingLabel: null, region: null,
        source: 'Queensland FloodCheck', licence: 'CC BY 4.0',
      },
    ],
  };

  const evidence = buildInfrastructureEvidence({ planningData: WITH_CONTEXT });

  it('carries the designations and nothing else from the register', () => {
    expect(evidence.items.map((i) => i.name)).toEqual([
      'Maryborough Priority Living Area', 'Wide Bay Burnett Regional Plan',
    ]);
    expect(evidence.anyEvidenced).toBe(true);
  });

  it('gives a designation no delivery standing, because it is not a project', () => {
    // Reading a plan as `approved` would put it in the same column as a road
    // under construction. A regional plan says what an area is planned to
    // BECOME; it does not control what is built on one lot.
    expect(evidence.items.every((i) => i.standing === null)).toBe(true);
    expect(evidence.items.map((i) => i.kind)).toEqual(['Growth / priority area', 'Regional plan']);
  });

  it('prints the publisher’s own standing and version', () => {
    const rendered = renderInfrastructureOutlook(evidence);
    expect(rendered).toContain('Wide Bay Burnett Regional Plan');
    expect(rendered).toContain('Statutory instrument');
    expect(rendered).toContain('version December 2023');
    // And still no forecast of any kind.
    expect(rendered).not.toMatch(/due (in|by)|expected (in|by)|completion (in|by)/i);
  });

  it('puts the register’s standing in Status and its region in Where', () => {
    /*
     * The first render of this table read
     *
     *   | Maryborough Priority Living Area | Growth / priority area |
     *     Wide Bay Burnett | No date stated | Priority Living Area | — |
     *
     * so a REGION was printed as the project's status, and the layer's own
     * name as a place. Both came from taking `detail` and `instrument`, which
     * are a join of everything published and the instrument's name — neither
     * of them a status or a location. The register's own `standingLabel` and
     * `region` are what those columns mean.
     */
    const area = evidence.items.find((i) => i.name === 'Maryborough Priority Living Area');
    expect(area?.statedStatus, 'a region is not a status').toBeNull();
    expect(area?.where).toBe('Wide Bay Burnett');

    const plan = evidence.items.find((i) => i.name === 'Wide Bay Burnett Regional Plan');
    expect(plan?.statedStatus).toBe('Statutory instrument · version December 2023');
    // The plan IS the region; repeating its own name under "Where" says
    // nothing, and an absent place is a real state.
    expect(plan?.where).toBeNull();

    // Read off the drawn row rather than the object, because the defect was
    // visible only in the table: the region must never appear in the Status
    // column of the row whose name is the living area.
    const row = renderInfrastructureOutlook(evidence)
      .split('\n').find((l) => l.startsWith('| Maryborough Priority Living Area')) ?? '';
    const cells = row.split('|').map((c) => c.trim());
    expect(cells[3], 'the Status cell').not.toBe('Wide Bay Burnett');
    expect(cells[5], 'the Where cell').toBe('Wide Bay Burnett');
  });

  it('still forbids quantifying an uplift from a designation', () => {
    const rules = infrastructureRules(evidence);
    expect(rules).toMatch(/Do NOT quantify an uplift/);
    expect(rules).toMatch(/only from items in the table/);
  });
});
