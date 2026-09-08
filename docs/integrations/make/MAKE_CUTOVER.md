# Make cutover — what is left, and the webhook table

> **The Airtable half of this cutover was never thrown.** The blueprints below
> are re-pointed at `appFNPL7iYiuQyHAO`, but the scenario that is actually
> running still writes `apptyShYE0yzL4IGB`, and that is where every listing the
> product serves comes from. `appFNPL7iYiuQyHAO` has held the same 148 records,
> all stamped `2026-08-18T13:20:37`, ever since the copy. Importing these
> blueprints as they stand therefore *moves* intake to a base nothing reads.
> Read
> [`AIRTABLE_KEY_OWNERSHIP.md`](../AIRTABLE_KEY_OWNERSHIP.md) before acting on
> this file.


State of the migration into the new Make account (team `2731020`, org `8699071`,
zone **us2**) as of 2026-08-18. 31 scenarios were cloned through the API; this
file covers what is not done and what has to change outside Make.

## Three things are outstanding

| | Why | Who can do it |
| --- | --- | --- |
| 6 scenarios still to import | blueprint too large to pass as an inline tool argument | a person, via **Import Blueprint** |
| 2 scenarios cannot be created | their data store does not fit on the Free plan | needs a plan decision |
| every external caller | the zone changed, so every webhook URL changed | a person, in Vapi / GHL / the website |

## The six UI imports are now fully wired

The files are in
[`../blueprints/make/_import-ready/`](../blueprints/make/_import-ready/). They
were originally prepared with the **old** Airtable base still in them. As of
2026-08-18 they point at the migrated base:

- base `apptyShYE0yzL4IGB` → **`appFNPL7iYiuQyHAO`**
- 6 table ids and **576 field references** rewritten to the new base's ids
- the three Aurixa scenarios keep the us2 hooks minted for them (2705081/2/3)

The rewrite touched **only** id tokens: masking every `app…`/`tbl…`/`fld…`
token makes the before and after byte-identical, so the 36.5 KB HTML email
bodies in the Aurixa scenarios are provably unchanged. One near-miss worth
recording: `applicantTimeZone` matches the shape of an Airtable base id
(`app` + 14 characters) and appears in Stage 3 — the rewriter substitutes only
ids it has an actual mapping for, so that string survived untouched.

### How the field map was built, and why it is trustworthy

There is no API that returns "old field id → new field id". The map was built by
resolving old id → field **name** (from the export) → new id (from the target),
and the target's name→id map was recovered by aligning creation order against
the live schema. That is an inference, so it was checked two ways before use:

- **41 (name, id) pairs** confirmed independently by earlier `get_table_schema`
  and `create_field` responses — all 41 agree.
- **374 fields** cross-checked on type: every aligned pair's live field type
  matches the type the creation plan declared. 374 match, 0 mismatch.

The first attempt failed both checks, which is the reason they exist: the four
`CREATED_TIME()` substitutes were appended after everything else rather than in
plan position, and `Aurixa Waitlist`'s computed tail was created in dependency
order (counts, then rollups, then formulas) rather than plan order. Naive
order-zipping silently produced wrong ids for those; the checks caught it.

## The two scenarios that cannot be created

`NPC Twilio - Store Active Call Context` and
`NPC Vapi - Transfer Caller to Human via Twilio Redirect` both read a data store
called **`Vapi Calls Human Transfer`**, and it cannot exist on this plan.

Creating it returns, verbatim: **`Not enough space in storage.`**

Two independent limits produce that. The org's `dsslimit` is **1,048,576 bytes
of data-store storage in total**, and a data store's minimum allocation is 1 MB —
so the one store that already exists (`GHL Contact IDs`, 133627, holding 665
bytes of its 1 MB) claims the entire org allowance. Separately the licence sets
**`dslimit: 1`**: one data store, whatever its size. Shrinking the existing store
would not help, because the count limit still binds.

So this is a plan decision, not a migration step. Either upgrade Make, or accept
that the human-transfer path does not migrate. Note the second scenario's hook
already exists (`ydaccnot9sfslqi255w651nmc428umpn`) and currently belongs to no
scenario.

While checking: `"scenarios": 2` also caps **active** scenarios at two, and
`activeScenarios` is currently 0. Everything cloned so far is inactive, so
nothing has hit that yet — but only two of them can ever run at once on Free.

## Webhook re-pointing

Every URL moved from `hook.eu2.make.com` to `hook.us2.make.com` **and** got a new
random path, because a hook is minted per account. Nothing an external system
calls today reaches the new account.

Where the "old" column is filled in, that URL was observed in the exported
blueprints; the others are blank because the old account's token is zone-bound
and `hooks_get` against it answers *Access denied*, so the old paths cannot be
read back. Match those by scenario name.

| Scenario | Old (eu2) | New (us2) |
| --- | --- | --- |
| Aurixa Stage 3 Access | — | `https://hook.us2.make.com/t1a5ihubtgkrc38rq073gw4i1v427yxm` |
| Aurixa Waitlist Stage 1 | — | `https://hook.us2.make.com/eku2vhixkfc8uw3ua43a6apuri9x45fc` |
| Aurixa Waitlist Stage 2 | — | `https://hook.us2.make.com/xqat3ism55qanlbhu67qqx4t31yvcy6h` |
| Aurixa Waitlist Stage 3 | — | `https://hook.us2.make.com/gu22njaaq9smhe87feuflr4aksd7wnnp` |
| Discovery Call Handoff | `…/2ubukyatwc0ig8zinphjjc4dciwhigqg` | `https://hook.us2.make.com/8k9ofpknay6jvcjuz9h8cg4vbpm51rrw` |
| GHL MCP - Get Contact By Phone via HTTP | — | `https://hook.us2.make.com/eexehoud6y1tfoinmepbvp8fcv1qfuj1` |
| Integration Webhooks, PDFMonkey | — | `https://hook.us2.make.com/l8laqb9a7y3kegqxe8a1b64eic1yxt74` |
| NPC Active Nurturing | — | `https://hook.us2.make.com/q4qyrh4kdblw23bwsa2rdltkkngv1snm` |
| NPC Active Nurturing Call Report | `…/wzvaxu6ye39jxx2w6l6jac9ab7rf4175` | `https://hook.us2.make.com/my4fk4f1hyvrtq3qwl88oae8ntiku3v4` |
| NPC Delete Booking Test | — | `https://hook.us2.make.com/jutejxif2dfkrqazi8ynjpq3cotdn0k7` |
| NPC Delete IFC Session | — | `https://hook.us2.make.com/h28wac173fn5xh2s28be6jdzb2gw5x5p` |
| NPC Delete IFC Session (Zoom) | — | `https://hook.us2.make.com/f87otoag2wcaol7rz4xeq93g1aythodg` |
| NPC Delete Opt In Call | — | `https://hook.us2.make.com/ert4tdi8k15qhmmxsqicexv74ia1q51i` |
| NPC Delete Quiz Sub Call | — | `https://hook.us2.make.com/s0yylebfdgytsvzo3uhsztwr44sfsvky` |
| NPC Delete Strategy Session | — | `https://hook.us2.make.com/asr1irn2e2iti84buwxvxgqnoydwtjkk` |
| NPC Delete Strategy Session (Zoom) | — | `https://hook.us2.make.com/brtnxcxdd8onngjgcxvkaiog14w5ovh1` |
| NPC Discovery Call Live | — | `https://hook.us2.make.com/otky3bah9ksxphhpvhzwm1ncsf5ndxg1` |
| NPC Discovery Call No Show Live | — | `https://hook.us2.make.com/txye1sx5fvfg5vofprxjaardu3un1vli` |
| NPC Discovery Call Test | — | `https://hook.us2.make.com/dqnothm6fwbvua1fiy32ied4fv1cja80` |
| NPC IFC Follow Up Test | — | `https://hook.us2.make.com/dwkqevibwxdftos6icdogaop9wb3tjc8` |
| NPC IFC No Show | — | `https://hook.us2.make.com/44tbnk20e6y9o0s9mxgjmn7dkk6k6fde` |
| NPC Opt-In Follow Up Test | — | `https://hook.us2.make.com/me8str56pir0gxknu3s279ti9950wgcr` |
| NPC Quiz Submission Follow Up Test | — | `https://hook.us2.make.com/xxhfg3ayu3h7yhmzgnzpfenlv76kjmvd` |
| NPC Strategy Session Follow Up Test | — | `https://hook.us2.make.com/9ebqzi0xmtorn6ynqe3j5sb2365593v8` |
| NPC Strategy Session Follow Up Zoom | — | `https://hook.us2.make.com/s8ny42w7po89hat5zplc1oj8nn7ovzvw` |
| NPC Strategy Session No Show | — | `https://hook.us2.make.com/6o13hcomme3bighypclz2d7m1b0k8g2v` |
| NPC Twilio - Store Active Call Context | — | `https://hook.us2.make.com/ydaccnot9sfslqi255w651nmc428umpn` |
| NPC Vapi - get_call_context v1 | `…/o51u3jb5g1nn1lxiluziezpr7gh5vvt8` | `https://hook.us2.make.com/7lw416w6whh5gfat56o9190vbbqc10pj` |
| Vapi - GHL Availability Intent Router (Native) | — | `https://hook.us2.make.com/ik45qbx1lvykjpndcfkdsy6ljqt9y9v9` |
| Vapi - GHL Booking Intent Router (Generic HTTP PIT) | — | `https://hook.us2.make.com/017xspgxrpxqh93feqi7bms3pmxmv19e` |
| Vapi - GHL Booking Intent Router (Native) | — | `https://hook.us2.make.com/17y0m4ovieujdl4acsrq8lgslnqrayoc` |
| Vapi - GHL Contact Resolver v3 PRODUCTION | `…/0j9gs0k50m1vgf9gv65gy1mteanfduyx` | `https://hook.us2.make.com/9t8up9akpn5a1frmkwwec05u09ueuxma` |
| Vapi - GHL Contact Resolver v4 CANONICAL VARIABLES | `…/db3ws2lmqi4qh9ozsyt1tvn3j8tbeahm` | `https://hook.us2.make.com/gukfea8c5p61cm2pmdzf3sfl74y9huws` |
| Vapi phoneNumber_inject v2 | — | `https://hook.us2.make.com/hdgcn4brzcuv4u81dao7zp4r97ov2lv8` |

**The two `vapi2` hooks are different.** `NPC Active Nurturing Call Report` and
`Discovery Call Handoff` are Vapi *app* hooks, bound to an assistant id
(`cc46d882-…` and `bfff143e-…`) through connection `10496920`. They are not
editable as plain URLs — re-pointing those means updating the assistant in Vapi.

### Where the eu2 URLs were found, and what that means

The old URLs turned up in `metadata.designer.samples` — cached payloads from Vapi
test runs, not live configuration. Two consequences, and the second is the useful
one:

- **No cloned scenario calls the old account.** Slimming dropped
  `metadata.expect`, `interface` and `restore`, and with them these samples. A
  grep for `hook.eu2.make.com` across every blueprint used to create the 31
  clones, and across the six import-ready files, returns nothing.
- **The samples record what Vapi was pointed at.** A sample containing
  `server.url: https://hook.eu2.make.com/…` is evidence that a Vapi assistant
  tool calls that URL — which is exactly the list of external callers to change.

## Still to do outside this file

- Rotate the Vapi key and both GHL keys, then apply the 7 GHL contact-cache key
  edits in the Make UI.
- `NPC Discovery Call Summary` was deliberately skipped: its Airtable step writes
  an empty value into one field of base `appFOpIVCltTyJKgM`, which is outside
  this migration.
