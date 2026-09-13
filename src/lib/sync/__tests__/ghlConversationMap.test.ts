import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONVERSATION_ROW_KEYS,
  MESSAGE_ROW_KEYS,
  mapChannelType,
  mapContentType,
  mapMessageDirection,
  parseGhlDate,
  toConversationRow,
  toMessageRow,
} from "../../../../supabase/functions/_shared/ghlConversationMap.pure";

/*
  ONE SHAPE FOR A CONVERSATION AND A MESSAGE.

  These mappers existed in four copies. Two call sites writing the same message
  through two copies of `mapMessageDirection` is how one message comes to be
  `inbound` on the scheduled path and `outbound` on the browser's refresh, with
  `onConflict: 'ghl_message_id'` making whichever ran last the winner.

  The column sets below are pinned against the LIVE tables rather than against
  the migrations, because a migration in this repository
  (`20260723150000_conversation_message_delivery_safety.sql`) adds three
  columns and has never been applied to any database in the fleet — so "named
  by a migration" is not evidence a column exists. `check-edge-column-names.mjs`
  judges the generated types UNION the migrations and therefore cannot see
  this; a row assembled in a mapper module is invisible to it in any case.
*/

/** Read from `information_schema.columns` on the prime, 13 Sep 2026. */
const LIVE_CONVERSATION_COLUMNS = new Set([
  "id", "client_id", "ghl_conversation_id", "ghl_contact_id", "channel_type",
  "last_message_body", "last_message_date", "last_message_direction",
  "unread_count", "conversation_status", "assigned_to", "last_synced_at",
  "created_at", "updated_at", "new_ghl_conversation_id", "replayed_at",
]);

const LIVE_MESSAGE_COLUMNS = new Set([
  "id", "conversation_id", "ghl_message_id", "direction", "channel_type",
  "body", "content_type", "attachment_urls", "sender_name", "sender_number",
  "recipient_number", "message_status", "ghl_date_added", "created_at",
  "updated_at", "new_ghl_message_id", "replayed_at", "replay_skipped_reason",
]);

/** The migration worker's replay bookkeeping. An import must not touch it. */
const REPLAY_COLUMNS = [
  "new_ghl_conversation_id", "new_ghl_message_id", "replayed_at", "replay_skipped_reason",
];

describe("the column sets are the ones the tables actually have", () => {
  it("writes no conversation column the live table lacks", () => {
    for (const key of CONVERSATION_ROW_KEYS) expect(LIVE_CONVERSATION_COLUMNS).toContain(key);
  });

  it("writes no message column the live table lacks", () => {
    for (const key of MESSAGE_ROW_KEYS) expect(LIVE_MESSAGE_COLUMNS).toContain(key);
  });

  it("the declared key sets are exactly what the mappers produce", () => {
    // Otherwise the lists above vouch for something nothing writes.
    expect(Object.keys(toConversationRow({ id: "c" }, {
      clientId: null, ghlContactId: "g", syncedAtIso: "2026-09-13T00:00:00.000Z",
    })).sort()).toEqual([...CONVERSATION_ROW_KEYS].sort());
    expect(Object.keys(toMessageRow({ id: "m" }, "local")).sort())
      .toEqual([...MESSAGE_ROW_KEYS].sort());
  });

  it("never writes a replay column", () => {
    for (const col of REPLAY_COLUMNS) {
      expect(CONVERSATION_ROW_KEYS).not.toContain(col);
      expect(MESSAGE_ROW_KEYS).not.toContain(col);
    }
  });

  it("never writes a column that exists only in the unapplied migration", () => {
    /*
      `available_channels`, `client_request_id` and `error_message` are added by
      a committed migration that is absent from `schema_migrations` on every
      project. `message_type` is named by two send paths and by no migration at
      all. All four answer PGRST204 on a write.
    */
    for (const phantom of ["available_channels", "client_request_id", "error_message", "message_type"]) {
      expect(CONVERSATION_ROW_KEYS).not.toContain(phantom);
      expect(MESSAGE_ROW_KEYS).not.toContain(phantom);
    }
  });
});

describe("parseGhlDate", () => {
  it("reads a string of digits, which `new Date` gets wrong", () => {
    // `new Date("1731022800000")` is Invalid Date, not a timestamp.
    expect(new Date("1731022800000").getTime()).toBeNaN();
    expect(parseGhlDate("1731022800000")).toBe(new Date(1731022800000).toISOString());
  });

  it("separates seconds from milliseconds by magnitude", () => {
    expect(parseGhlDate(1731022800)).toBe(new Date(1731022800000).toISOString());
    expect(parseGhlDate(1731022800000)).toBe(new Date(1731022800000).toISOString());
  });

  it("reads an ISO string", () => {
    expect(parseGhlDate("2026-09-13T01:02:03Z")).toBe("2026-09-13T01:02:03.000Z");
  });

  it("answers null for an absence rather than an epoch", () => {
    for (const v of [null, undefined, "", "not a date", NaN]) expect(parseGhlDate(v)).toBeNull();
  });
});

describe("mapMessageDirection", () => {
  it("lets an explicit direction outrank everything else", () => {
    expect(mapMessageDirection({ direction: "inbound", incoming: false, userId: "u" })).toBe("inbound");
    expect(mapMessageDirection({ direction: 2, incoming: true })).toBe("outbound");
    expect(mapMessageDirection({ direction: "1" })).toBe("inbound");
  });

  it("falls back to `incoming`, then to a staff user id", () => {
    expect(mapMessageDirection({ incoming: true, userId: "u" })).toBe("inbound");
    expect(mapMessageDirection({ incoming: false })).toBe("outbound");
    expect(mapMessageDirection({ userId: "u" })).toBe("outbound");
    expect(mapMessageDirection({})).toBe("outbound");
  });
});

describe("mapChannelType", () => {
  it("normalises GHL's several spellings of one channel", () => {
    for (const v of ["sms", "1", "phone", "TYPE_PHONE"]) expect(mapChannelType(v)).toBe("sms");
    for (const v of ["email", "2", "TYPE_EMAIL"]) expect(mapChannelType(v)).toBe("email");
    expect(mapChannelType("FB")).toBe("facebook");
  });

  it("passes an unrecognised channel through rather than calling it a text", () => {
    // A new GHL channel should arrive in the column as itself and be visible,
    // not be silently recorded as a text message.
    expect(mapChannelType("type_something_new")).toBe("type_something_new");
    expect(mapChannelType(undefined)).toBe("sms");
  });
});

describe("mapContentType", () => {
  it("only ever answers a value the column accepts", () => {
    expect(mapContentType("image/png")).toBe("image");
    expect(mapContentType("application/pdf")).toBe("text");
    expect(mapContentType(undefined)).toBe("text");
  });
});

describe("the direction precedence the other copy got wrong", () => {
  it("reads `lastMessageDirection` as itself", () => {
    /*
      `sync-ghl-conversations` wrote
        conv.lastMessageDirection || conv.lastMessageType === 1 ? 'inbound' : 'outbound'
      and `||` binds looser than `===`, so the condition is
      `(direction || (type === 1))` — the string 'outbound' is truthy and
      selected 'inbound'. Every thread that path touched recorded its last
      message as incoming.
    */
    const row = toConversationRow(
      { id: "c", lastMessageDirection: "outbound", lastMessageType: 2 },
      { clientId: null, ghlContactId: "g", syncedAtIso: "2026-09-13T00:00:00.000Z" },
    );
    expect(row.last_message_direction).toBe("outbound");
  });

  it("and the source of that bug is gone from the repository", () => {
    const root = join(__dirname, "..", "..", "..", "..");
    for (const fn of ["sync-ghl-conversations", "conversation-sync-cron"]) {
      const src = readFileSync(join(root, "supabase", "functions", fn, "index.ts"), "utf8");
      expect(src).not.toMatch(/lastMessageDirection \|\| conv\.lastMessageType === 1 \?/);
    }
  });
});

describe("toMessageRow", () => {
  it("keeps attachments only when there are some", () => {
    expect(toMessageRow({ id: "m", attachments: [{ url: "a" }, {}, { url: "b" }] }, "c").attachment_urls)
      .toEqual(["a", "b"]);
    expect(toMessageRow({ id: "m", attachments: [] }, "c").attachment_urls).toBeNull();
    expect(toMessageRow({ id: "m" }, "c").attachment_urls).toBeNull();
  });

  it("binds the row to the LOCAL conversation id, never GHL's", () => {
    expect(toMessageRow({ id: "m", conversationId: "ghl-side" }, "local-uuid").conversation_id)
      .toBe("local-uuid");
  });
});
