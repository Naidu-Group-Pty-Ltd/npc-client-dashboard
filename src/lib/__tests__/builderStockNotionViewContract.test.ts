/**
 * BUILDER STOCK — THE LINKED NOTION VIEW IS THE STOCK LIST.
 *
 * A Notion view is a QUERY over a collection — a filter, a sort, a grouping —
 * and the rows a reader sees are the rows that query returns. Two rules follow,
 * and the importer honoured neither.
 *
 * ONE. `?v=` NAMES THE VIEW, AND IT IS HONOURED OR THE READ FAILS. The
 * selection used to be
 *
 *     viewIds.includes(preferred) ? preferred : (viewIds[0] ?? preferred)
 *
 * so a link naming a view the page does not have was served the page's FIRST
 * view instead — a different set of properties, silently, with nothing
 * reporting it. Which rows belong to a stock list is the one question an
 * importer may never guess at: a wrong answer replaces a builder's stock with
 * somebody else's.
 *
 * TWO. THE VIEW'S OWN QUERY TRAVELS WITH IT. `queryCollection` was sent
 * `sortQuery: []` and no filter, which asks the COLLECTION rather than the
 * view — so a builder linking a filtered view of a large database would have
 * every row of it imported. It is passed verbatim now rather than translated:
 * Notion supplies the canonical structure, and re-deriving it would be a
 * second implementation of somebody else's filter language, free to disagree
 * with the page the builder is looking at.
 *
 * These are written against arbitrary views, because the contract is about
 * every future Builder Portal upload rather than any page in front of us today.
 */
import { describe, expect, it } from 'vitest';

import {
  describeNotionPage, preferredNotionViewId, viewMembershipQuery,
} from '../../../supabase/functions/_shared/builderStock/notionRecordMap.pure';

const PAGE = 'aaaaaaaa-0000-4000-8000-000000000001';
const COLLECTION = 'bbbbbbbb-0000-4000-8000-000000000002';
const SPACE = 'cccccccc-0000-4000-8000-000000000003';
const VIEW_A = 'dddddddd-0000-4000-8000-00000000000a';
const VIEW_B = 'dddddddd-0000-4000-8000-00000000000b';
const VIEW_ABSENT = 'eeeeeeee-0000-4000-8000-0000000000ff';

/** A filter of the shape Notion actually stores on a view's `query2`. */
const VIEW_B_QUERY = {
  filter: {
    operator: 'and',
    filters: [{
      property: 'ZVPn',
      filter: { operator: 'enum_is', value: { type: 'exact', value: 'Available' } },
    }],
  },
  sort: [{ property: 'title', direction: 'ascending' }],
};

function recordMap(over: { viewIds?: string[] } = {}) {
  return {
    block: {
      [PAGE]: {
        value: {
          value: {
            id: PAGE,
            type: 'collection_view_page',
            collection_id: COLLECTION,
            space_id: SPACE,
            view_ids: over.viewIds ?? [VIEW_A, VIEW_B],
            properties: { title: [['Stock']] },
          },
        },
      },
    },
    collection_view: {
      [VIEW_A]: { value: { value: { id: VIEW_A, type: 'table', name: 'All' } } },
      [VIEW_B]: { value: { value: { id: VIEW_B, type: 'table', name: 'Available', query2: VIEW_B_QUERY } } },
    },
    collection: {
      [COLLECTION]: { value: { value: { id: COLLECTION, name: [['Stock']] } } },
    },
  } as never;
}

describe('the view named on the link', () => {
  it('reads the view id out of ?v= whatever the slug looks like', () => {
    expect(preferredNotionViewId(`https://x.notion.site/Page-30ccabc?v=${VIEW_B.replace(/-/g, '')}`))
      .toBe(VIEW_B);
    expect(preferredNotionViewId('https://x.notion.site/Page-30ccabc')).toBeNull();
  });

  it('honours the requested view even when it is not the first', () => {
    const shape = describeNotionPage(recordMap(), PAGE, VIEW_B);
    expect(shape.collectionViewId).toBe(VIEW_B);
    expect(shape.requestedViewMissing).toBe(false);
  });

  it('FAILS CLOSED when the requested view is not on the page', () => {
    const shape = describeNotionPage(recordMap(), PAGE, VIEW_ABSENT);
    // Not view A, not any view — nothing. The caller refuses the source read.
    expect(shape.collectionViewId).toBeNull();
    expect(shape.requestedViewMissing).toBe(true);
  });

  it('never substitutes the first view for an explicitly requested one', () => {
    const shape = describeNotionPage(recordMap(), PAGE, VIEW_ABSENT);
    expect(shape.collectionViewId).not.toBe(VIEW_A);
    expect(shape.collectionViewId).not.toBe(VIEW_B);
  });

  it('with no ?v= it takes the page\'s own first view, and says nothing is missing', () => {
    const shape = describeNotionPage(recordMap(), PAGE, null);
    expect(shape.collectionViewId).toBe(VIEW_A);
    expect(shape.requestedViewMissing).toBe(false);
  });

  it('a page with no views at all is not a missing REQUEST when none was made', () => {
    const shape = describeNotionPage(recordMap({ viewIds: [] }), PAGE, null);
    expect(shape.collectionViewId).toBeNull();
    expect(shape.requestedViewMissing).toBe(false);
  });
});

describe('the view\'s own query', () => {
  it('carries the selected view\'s filter and sort verbatim', () => {
    const shape = describeNotionPage(recordMap(), PAGE, VIEW_B);
    // Verbatim: not re-derived, not simplified, not re-ordered.
    expect(shape.viewQuery).toEqual(VIEW_B_QUERY);
  });

  it('carries the query of the view that was SELECTED, not of another', () => {
    // View A has no query of its own; selecting it must not borrow B's filter.
    const shape = describeNotionPage(recordMap(), PAGE, VIEW_A);
    expect(shape.collectionViewId).toBe(VIEW_A);
    expect(shape.viewQuery).toBeNull();
  });

  it('carries nothing when the view was refused', () => {
    const shape = describeNotionPage(recordMap(), PAGE, VIEW_ABSENT);
    expect(shape.viewQuery).toBeNull();
  });

  it('the query is spread into the collection request, replacing the empty one', () => {
    /*
     * The request is built inside an edge function no test can import, so the
     * contract is pinned on the source — the way this repository already pins
     * its other deploy-shaped invariants.
     */
    const source = readSource();
    const call = source.slice(
      source.indexOf("'/api/v3/queryCollection"),
      source.indexOf("'/api/v3/queryCollection") + 1400);
    expect(call).toContain('...(shape.viewQuery ?? {})');
    // The empty query that asked the collection instead of the view is gone.
    expect(call).not.toContain('sortQuery: []');
  });

  it('a link naming a view the page lacks refuses the import outright', () => {
    const portal = readPortalSource();
    expect(portal).toContain("recovery.reason === 'requested_view_missing'");
    expect(portal).toContain('notion_view_not_found');
  });

  it('the refusal is a DECLARED diagnostic, not a field invented at the call site', () => {
    /*
     * A refusal nobody can see afterwards is the same operator conversation
     * over again. The field is on `NotionRecoveryDiagnostics` and defaulted in
     * `blankDiagnostics`, so every recovery answers the question — and the
     * edge type-check enforces it rather than a stray property assignment
     * silently doing nothing.
     */
    const source = readSource();
    expect(source).toContain('requested_view_missing: boolean;');
    expect(source).toContain('requested_view_missing: false,');
    expect(source).toContain('diagnostics.requested_view_missing = true;');
  });
});

function readSource(): string {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { resolve } = require('node:path') as typeof import('node:path');
  return readFileSync(resolve(
    __dirname, '../../../supabase/functions/_shared/builderStock/notionPublicContent.ts'), 'utf8');
}

function readPortalSource(): string {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { resolve } = require('node:path') as typeof import('node:path');
  return readFileSync(resolve(
    __dirname, '../../../supabase/functions/builder-portal-stock/index.ts'), 'utf8');
}

/* ==========================================================================
 * THE VIEW'S FILTER LIVES IN TWO PLACES, AND WE READ ONE OF THEM.
 *
 * PRODUCTION, 29 AUGUST 2026. A builder's page showed eighteen properties and
 * the importer took twenty-three. The five extra were the five their view
 * withholds. `query2` was innocent — it held a sort and no filter at all — and
 * the filtering was entirely in `collection_view.format.property_filters`, the
 * CHIPS above the table. Both narrow what a reader sees; Notion applies them
 * together; we sent one.
 *
 * The chips are one click in Notion's toolbar, on any column, at any time. So
 * this is not a story about one page: any builder can silently redefine their
 * stock list and, until this, we would have gone on importing the database
 * underneath it.
 *
 * Written with invented columns and invented status words. If any value below
 * appeared in the implementation, that would be the hard-coded status rule
 * this must never become.
 * ======================================================================== */

const P_STATE = 'qq01';   // an arbitrary select column
const P_STAGE = 'zz99';   // another
const VIEW_C = 'dddddddd-0000-4000-8000-00000000000c';

/** 23 rows: 18 carrying one status, 5 carrying another. */
const UNDERLYING = [
  ...Array.from({ length: 18 }, (_, i) => ({ id: `row-a-${i}`, [P_STAGE]: 'Listed', [P_STATE]: 'North' })),
  ...Array.from({ length: 5 }, (_, i) => ({ id: `row-b-${i}`, [P_STAGE]: 'Withheld', [P_STATE]: 'North' })),
];

/** The chip shape Notion stores, verbatim. `value` is an ARRAY of accepted values. */
const chip = (id: string, property: string, values: string[]) => ({
  id,
  filter: {
    filter: { value: values.map((value) => ({ type: 'exact', value })), operator: 'enum_is' },
    property,
  },
});

function viewPage(view: Record<string, unknown>) {
  return {
    block: {
      [PAGE]: { value: { value: {
        id: PAGE, type: 'collection_view_page', collection_id: COLLECTION,
        space_id: SPACE, view_ids: [VIEW_C], properties: { title: [['Stock']] },
      } } },
    },
    collection_view: { [VIEW_C]: { value: { value: { id: VIEW_C, type: 'table', ...view } } } },
    collection: { [COLLECTION]: { value: { value: { id: COLLECTION, name: [['Stock']] } } } },
  } as never;
}

/**
 * Apply a produced filter to the fixture.
 *
 * It reads the filter it is GIVEN — it knows no column and no status word — so
 * what it measures is whether the query we send expresses the view's own
 * membership, which is the only thing a unit test here can honestly measure.
 * That the shape is one Notion accepts was established against the live
 * endpoint: the same structure returned 18 of 23 while an empty filter
 * returned all 23.
 */
function membersOf(filter: unknown, rows: Record<string, string>[]): Record<string, string>[] {
  const passes = (node: unknown, row: Record<string, string>): boolean => {
    if (!node || typeof node !== 'object') return true;
    const n = node as Record<string, unknown>;
    if (Array.isArray(n.filters)) {
      const kids = n.filters.map((child) => passes(child, row));
      return n.operator === 'or' ? kids.some(Boolean) : kids.every(Boolean);
    }
    const property = n.property as string;
    const clause = n.filter as { operator?: string; value?: unknown } | undefined;
    if (!property || !clause) return true;
    const accepted = Array.isArray(clause.value)
      ? (clause.value as { value: string }[]).map((v) => v.value)
      : [(clause.value as { value: string } | undefined)?.value as string];
    return clause.operator === 'enum_is' ? accepted.includes(row[property]) : true;
  };
  if (!filter) return rows;
  return rows.filter((row) => passes(filter, row));
}

describe('membership is whatever the view says, and the view says it twice', () => {
  it('a filtered view imports its 18 — never the 23 underneath it', () => {
    const shape = describeNotionPage(viewPage({
      name: 'Live list',
      query2: { sort: [{ property: P_STAGE, direction: 'ascending' }] },
      format: { property_filters: [chip('c1', P_STAGE, ['Listed'])] },
    }), PAGE, VIEW_C);

    // The chip reached the query, and the sort it sat beside is still there.
    expect(shape.viewQuery?.sort).toEqual([{ property: P_STAGE, direction: 'ascending' }]);
    expect(membersOf(shape.viewQuery?.filter, UNDERLYING)).toHaveLength(18);
  });

  it('a view that admits BOTH statuses imports all 23', () => {
    const shape = describeNotionPage(viewPage({
      name: 'Everything',
      query2: { sort: [] },
      format: { property_filters: [chip('c1', P_STAGE, ['Listed', 'Withheld'])] },
    }), PAGE, VIEW_C);

    expect(membersOf(shape.viewQuery?.filter, UNDERLYING)).toHaveLength(23);
  });

  it('a view with no filter of any kind still imports all 23', () => {
    const shape = describeNotionPage(viewPage({
      name: 'Unfiltered', query2: { sort: [] }, format: {},
    }), PAGE, VIEW_C);

    expect(shape.viewQuery).toEqual({ sort: [] });
    expect(membersOf(shape.viewQuery?.filter, UNDERLYING)).toHaveLength(23);
  });

  it('several chips narrow together, the way the page does', () => {
    const rows = [
      ...UNDERLYING,
      { id: 'elsewhere', [P_STAGE]: 'Listed', [P_STATE]: 'South' },
    ];
    const shape = describeNotionPage(viewPage({
      query2: {},
      format: {
        property_filters: [chip('c1', P_STAGE, ['Listed']), chip('c2', P_STATE, ['North'])],
      },
    }), PAGE, VIEW_C);

    const members = membersOf(shape.viewQuery?.filter, rows);
    expect(members).toHaveLength(18);
    expect(members.some((row) => row.id === 'elsewhere')).toBe(false);
  });

  it('a chip narrows the view\'s OWN filter — it never replaces or widens it', () => {
    const menuFilter = {
      operator: 'and',
      filters: [{ property: P_STATE, filter: { operator: 'enum_is', value: { type: 'exact', value: 'North' } } }],
    };
    const shape = describeNotionPage(viewPage({
      query2: { filter: menuFilter },
      format: { property_filters: [chip('c1', P_STAGE, ['Listed'])] },
    }), PAGE, VIEW_C);

    const filter = shape.viewQuery?.filter as { operator: string; filters: unknown[] };
    expect(filter.operator).toBe('and');
    // The Filter menu's own group survives whole, beside the chip.
    expect(filter.filters).toContainEqual(menuFilter);
    expect(filter.filters).toHaveLength(2);
  });

  it('the chip clause travels VERBATIM, array value and all', () => {
    /*
     * Re-deriving this was tried against the live endpoint and returned zero
     * rows: a chip accepting several values is one `enum_is` whose `value` is
     * an ARRAY, which no hand-written equivalent guessed. Notion supplies the
     * canonical structure; we lift it.
     */
    const only = chip('c1', P_STAGE, ['Listed', 'Pending']);
    const shape = describeNotionPage(viewPage({
      query2: {}, format: { property_filters: [only] },
    }), PAGE, VIEW_C);

    const filter = shape.viewQuery?.filter as { filters: unknown[] };
    expect(filter.filters[0]).toEqual(only.filter);
  });

  it('no status word and no column id is written into the reader', () => {
    // The rule is "import the membership the view defines", never
    // "import the ones that say Available".
    const source = readRecordMapSource();
    for (const forbidden of ['Available', 'Coming Soon', 'Reserved', 'EOI', 'Sold', 'mlCu', 'Lsfu']) {
      expect(source).not.toContain(`'${forbidden}'`);
      expect(source).not.toContain(`"${forbidden}"`);
    }
  });

  it('a malformed chip is skipped rather than guessed at', () => {
    const shape = describeNotionPage(viewPage({
      query2: { sort: [] },
      format: { property_filters: [{ id: 'c1' }, { id: 'c2', filter: {} }, null, 'nonsense'] },
    }), PAGE, VIEW_C);
    // Nothing recognisable, so the query is exactly what it was.
    expect(shape.viewQuery).toEqual({ sort: [] });
  });

  it('reads a view record directly, for a caller that already has one', () => {
    expect(viewMembershipQuery(null)).toBeNull();
    expect(viewMembershipQuery({ query2: { sort: [] } })).toEqual({ sort: [] });
  });
});

function readRecordMapSource(): string {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { resolve } = require('node:path') as typeof import('node:path');
  return readFileSync(resolve(
    __dirname, '../../../supabase/functions/_shared/builderStock/notionRecordMap.pure.ts'), 'utf8');
}
