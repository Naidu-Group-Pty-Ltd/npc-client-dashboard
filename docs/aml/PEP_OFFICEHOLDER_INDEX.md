# The public office-holder index

Read this before touching `_shared/aml/pepOfficeholderIndex.pure.ts`,
`scripts/aml/load-pep-officeholders.mjs`, `pepOfficeholderParsers.mjs`, the
`search_pep_officeholders` operation, or `PepOfficeholderIndexPanel`.

It is the second register this platform loads, and it is **not the same kind
of thing** as the first. Read
[`SANCTIONS_LIST_LOADING.md`](./SANCTIONS_LIST_LOADING.md) for that one and
[`PEP_DETERMINATION_EVIDENCE.md`](./PEP_DETERMINATION_EVIDENCE.md) for what a
determination has to rest on.

## The one rule

**A hit is a candidate. A miss is nothing.**

A sanctions list is authoritative: DFAT publishes who is designated, and a
match against it is an outcome. No such register exists for political
exposure. Every public source is partial, none lists family members or close
associates at all, and they disagree with each other about spelling, titles
and dates.

So an index built from them is useful for exactly the reason a commercial PEP
database is useful — it surfaces a name worth looking at — and dangerous for
exactly one reason: **it returns zero rows for a person it never covered, and
zero rows reads like an answer.**

This platform has already shipped that shape once. `aml.sanctions_entries` was
empty from the day it was built, and every screening against it would have
cleared everybody. The lesson is written into the **read** path here, not into
a policy document:

- `searchVerdict` produces four readings and **none of them is a clearance** —
  a test asserts no branch can be paraphrased into one.
- **Coverage travels with every result**, including the empty one, which is
  the one that needs it. What the sources hold, what they do not, how many
  entries loaded, and the source's own as-at.
- An index that has never loaded, or whose **latest load failed**, reads as
  `unavailable` rather than as no candidates. It has not looked.
- A database fault answers `pep_index_search_failed` with a 503. A technical
  condition returned as "nothing found" is how an error becomes an outcome —
  the same defect the screening consumers had when they discarded a claim's
  error.

## What is in it, and why

| | |
| --- | --- |
| `wikidata_au_public_office` | Offices whose **jurisdiction** is Australia or one of its states and territories, and the people recorded as having held them — current and former. Measured 2026-08-19: **724 offices, 10,569 people**. |

### The query, and the one that was wrong

Offices are found by `P1001` — *applies to jurisdiction* — where the
jurisdiction is Australia itself or anything whose country (`P17`) is
Australia. That reaches the states and territories without naming them; a
hand-written list of eight is a list that goes stale in silence.

**The first version walked a subclass tree from `wd:Q18912794` and was
wrong.** That entity is not a class of Australian public offices — it *is*
"member of the Australian House of Representatives". The load succeeded, wrote
**1,254 people across two offices** (the House and its Speaker), and the
product then told operators on screen that it covered ministers, judges, heads
of agency and every state. No senators. No ministers. Nothing from any state.

That is the worst failure this feature can have, and it is not the empty one.
An unavailable index says it has not looked. An **overstated** index tells an
operator that an absence means more than it does.

### Coverage is measured, not claimed

So the prose in `PEP_INDEX_SOURCES` now describes only the *shape* of the
source, and a test asserts it **contains no digits at all**. Everything
countable — how many offices were reached, how many people, which ones — is
recorded by the loader into `pep_officeholder_syncs.detail` and rendered from
there. A sentence somebody typed once cannot be checked against a load; a
number the loader measured can be.

`officeCount` is `null` when a load recorded no detail, never `0` — unknown
and none are different facts and only one of them is alarming.

The count is over **every office a row records**, not the one it leads with.
`position_title` is the office shown on the candidate — the current one, else
the most recent — so counting those answers "how many offices do people lead
with", which is not a coverage number: the first corrected load measured 371
while 676 offices were actually represented, out of 724 queried.

### `pep_type` is left NULL, deliberately

The AUSTRAC category — foreign, domestic, international organisation — belongs
to the **determination a person reaches**, not to an index that surfaces a
candidate. It is also not available here: an Australian-jurisdiction office
correctly includes foreign ambassadors posted to Australia, so stamping every
row `domestic` was wrong on the face of the data as well as in principle.

Wikidata is the only reachable public source that carries **former** holders,
which is the gap the current government directory leaves and the one AUSTRAC
is most explicit about: leaving office does not end the risk, and the
treatment is a risk assessment rather than an expiry date. So the loader
carries the dates and never filters on them.

### The endpoint fails by lying

`query.wikidata.org` enforces a 60-second limit, and it does **not** fail
cleanly when a query exceeds it. A batch of 60 offices answered **HTTP 200
with 8.5 MB of JSON cut off mid-value** — no error field, no marker, nothing
to test but the parse.

Two consequences are built in. The holder query collapses aliases and
positions with `GROUP_CONCAT` so the server does that work: the same shape at
20 offices is 198 KB in about 2.5 seconds, which leaves the ceiling a wide
margin. And a response that does not parse is reported as a **truncated
download by name**, because that is what it is and because the distinction
tells the next person which lever to pull. Offices are read in batches of 20,
and the accumulator is threaded through all of them so a person holding
offices in several batches ends up as one row rather than as whichever batch
wrote last.

Throttling (`429`) and gateway errors are retried with backoff, honouring
`Retry-After` where the server states one. Neither is a failed load.

It is also **collaboratively edited**, which is precisely why a hit from it is
a lead rather than a source. Every row carries `confirm_url`, the panel says
"collaboratively edited" on screen, and `candidateToMethodDraft` produces a
source row whose `result` is **empty** — the operator confirms the candidate
against the official register and writes what they saw. The platform writing
that sentence for them is what would make the record indefensible. A test
asserts the drafted source never names the index itself.

**The APH parliamentarian search is not a source here**, though it is offered
as a one-click search in the dialog: `aph.gov.au` answers a scripted client
with a WAF block page, exactly as DFAT does. OpenSanctions' PEP dataset is
deliberately not used for the same reason its sanctions data is not — the
aggregation is CC-BY-NC and we are a commercial user.

## Loading it

`npm run test:aml-pep-index` runs the parser and loader contracts, and the
workflow runs them **before** anything is written.

```
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
  node scripts/aml/load-pep-officeholders.mjs [--dry-run] [--file q.json]
```

`.github/workflows/aml-pep-officeholders-refresh.yml` runs it weekly. Weekly
rather than nightly, and this asymmetry is deliberate: a stale sanctions list
is a live compliance failure and fails screening closed, while a stale
office-holder index degrades an **assistance** — the searches still open, the
operator still checks the official register, and the determination is still
made on what they record.

Every rule the sanctions loader learned the expensive way is repeated here,
because each one cost a production incident:

- **Never publish a source that parsed to zero entries.** An empty index is
  not "nobody holds public office"; it is a download that failed, and it
  answers a search with the same zero rows a real search would.
- **A shrink is a truncated response until a person says otherwise.**
  `PRUNE_SHRINK_FLOOR` keeps the old entries and exits non-zero.
- **The prune's `or()` must name `sync_id` in the RETURNING projection.** On a
  mutation PostgREST resolves those columns against the projection rather than
  the table and answers `42703 column … does not exist` for a column the table
  plainly has. On the sanctions loader that failed **every** load it was part
  of.
- **Node 22.** `createClient` builds a `RealtimeClient` whose constructor
  demands a native WebSocket. On 20 the loader dies before reading a byte.
- **Missing credentials fail the job.** A refresh that silently downgrades
  itself to a dry run is how a register goes stale behind a green tick.

## Normalisation is server-side, always

`normalised_names` is written by the **same** `normaliseName` the query uses —
imported from `sanctionsParsers.mjs` rather than re-implemented. A second
implementation that dropped one more honorific would write rows no query can
ever match, which looks exactly like an index that works. A row with no
searchable tokens is dropped by the loader **and** refused by a column
constraint, because such a row is not an entry, it is a silent hole in
coverage.

The search overlaps on **any** token and scores in code with `scoreNames`, the
same matcher the sanctions screening uses — recall first, because requiring
every token would miss the partial-name cases the search exists to catch.

## Access

Service role only, both tables, exactly like the sanctions tables. Every read
goes through `search_pep_officeholders`, which is where the coverage statement
is attached: a direct client grant would let a caller obtain a bare "0 rows"
with nothing beside it, which is the reading this whole table is built to
prevent.

## Where the tests are

| | |
| --- | --- |
| the readings, and that none is a clearance | `src/lib/aml/pepOfficeholderIndex.test.ts` |
| the parser and the loader's rules | `tests/aml/pep-officeholders.test.mjs` (`npm run test:aml-pep-index`) |
| the panel, including the empty state | `src/components/aml/__tests__/pepOfficeholderIndexPanel.test.tsx` |
| the edge operation | `src/lib/aml/amlScreeningRepair.contract.test.ts` |
