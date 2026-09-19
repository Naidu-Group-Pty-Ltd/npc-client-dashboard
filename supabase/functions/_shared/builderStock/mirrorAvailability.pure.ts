/**
 * An empty Builder Stock tab: which absence is it?
 *
 * ## The defect this exists for
 *
 * A clone showed no properties under "No builder stock has been uploaded yet ·
 * Properties appear here when a builder uploads a stock list in their portal."
 * — the 19 Sep 2026 clone audit's report. Every word of that sentence is wrong
 * on a clone, and each in a different way.
 *
 * `builder_network_stock_*` is a MIRROR. Nothing is uploaded into it here: the
 * Builders Network composes `stock.item.upserted` events into the connection
 * outbox and `builder_network_apply_inbound_events` converges them on a
 * one-minute sweep. A clone with no `builder_network_connections` row — which
 * is every clone until its link is established — has no source of events at
 * all, so the mirror is empty for a reason that has nothing to do with what any
 * builder has or has not supplied.
 *
 * So the page was making a statement about BUILDERS out of a fact about the
 * LINK, and pointing the reader at a portal they cannot reach to fix something
 * that is not broken there. It is the rule this platform has paid for
 * repeatedly — `amenity_register`'s "zero rows for a state never loaded is
 * `unavailable`, never 'no schools here'", `useAmlAccess`'s "we could not
 * check is not you do not have it", `placesAvailability`'s "a lookup that
 * FAILED is not a measurement of zero".
 *
 * ## The rules
 *
 * **A link that has never delivered is its own reading**, distinct from a link
 * that delivers nothing. `no_connection` and `never_synced` say something is
 * owed by an operator; `empty` says the network genuinely holds no stock.
 *
 * **Filters outrank everything.** A filtered result with nothing in it is about
 * the filters, whatever the link is doing, because clearing them is the act in
 * front of the reader.
 *
 * **An unknown link state never claims the network is empty.** The reading
 * fails to `unknown`, which says the page cannot tell — never to the one
 * sentence that blames the builders.
 *
 * Pure + deterministic + JSON-safe: no DOM, network, secrets or clocks.
 */

/** What the server could tell us about the link this mirror is fed by. */
export type MirrorConnectionState = 'active' | 'none' | 'revoked' | 'unknown';

export interface MirrorSource {
  connection: MirrorConnectionState;
  /** The newest `last_seen_at` across mirrored items, or null if there are none. */
  lastSyncedAt?: string | null;
}

export type StockEmptyReason =
  | 'filtered'
  | 'no_connection'
  | 'revoked_connection'
  | 'never_synced'
  | 'empty'
  | 'unknown';

export interface StockEmptyReading {
  reason: StockEmptyReason;
  title: string;
  detail: string;
  /** True where somebody has to do something; false where it is just empty. */
  actionable: boolean;
}

export function readStockEmptyState(args: {
  filtersApplied: boolean;
  source?: MirrorSource | null;
}): StockEmptyReading {
  if (args.filtersApplied) {
    return {
      reason: 'filtered',
      title: 'No builder stock matches those filters',
      detail: 'Clear the filters to see everything builders have supplied.',
      actionable: false,
    };
  }

  const connection = args.source?.connection;

  if (connection === 'none') {
    return {
      reason: 'no_connection',
      title: 'This workspace is not linked to the Builders Network yet',
      detail:
        'Builder Stock mirrors properties the network sends over that link, so there is nothing '
        + 'to show until it is established. An administrator can set it up; no builder needs to '
        + 'do anything.',
      actionable: true,
    };
  }

  if (connection === 'revoked') {
    return {
      reason: 'revoked_connection',
      title: 'The Builders Network link has been revoked',
      detail:
        'No new stock will arrive while the link is revoked. An administrator can restore it.',
      actionable: true,
    };
  }

  if (connection === 'active' && !args.source?.lastSyncedAt) {
    return {
      reason: 'never_synced',
      title: 'The Builders Network link has not delivered any stock yet',
      detail:
        'The link is active and stock arrives on a sweep that runs every minute. If nothing '
        + 'appears, an administrator can check the network connection.',
      actionable: true,
    };
  }

  if (connection === 'active') {
    return {
      reason: 'empty',
      title: 'No builder stock is listed right now',
      detail:
        'The Builders Network link is working and currently carries no available properties. '
        + 'New stock appears here within a minute of a builder listing it.',
      actionable: false,
    };
  }

  // Never the "builders have nothing" sentence on a state we could not read.
  return {
    reason: 'unknown',
    title: 'Builder stock is not available to show',
    detail:
      'This workspace could not confirm the state of its Builders Network link, so it cannot '
      + 'tell whether there is stock to show. Try again shortly.',
    actionable: false,
  };
}
