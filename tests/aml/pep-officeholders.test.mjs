/**
 * The public office-holder index: the parser, and the loader's rules.
 *
 * These run under `node --test` before anything is written, exactly like the
 * sanctions parser tests, because the failure mode is the same shape: an
 * index that parses to nothing, or that normalises differently from the
 * query, looks precisely like an index that works.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  WIKIDATA_AU_OFFICES_QUERY, accumulateWikidataOfficeholders,
  buildWikidataOfficeholderQuery, officeholderEntries,
  parseWikidataOfficeholders, withNormalisedNames,
} from '../../scripts/aml/pepOfficeholderParsers.mjs';
import { normaliseName } from '../../scripts/aml/sanctionsParsers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const loader = readFileSync(join(root, 'scripts/aml/load-pep-officeholders.mjs'), 'utf8');
const migration = readFileSync(
  join(root, 'supabase/migrations/20260927000000_aml_pep_officeholder_index.sql'), 'utf8');

/*
 * The endpoint returns ONE ROW PER PERSON, with aliases and positions
 * collapsed by GROUP_CONCAT. That is not a preference: asking for both as
 * plain OPTIONALs returns their cross-product, and 60 offices produced
 * 8.5 MB — over the endpoint's own 60-second ceiling, which it answers with
 * HTTP 200 and a body cut off mid-value.
 */
const binding = (over = {}) => ({
  person: { value: 'http://www.wikidata.org/entity/Q42' },
  personLabel: { value: 'Pat Example' },
  positions: { value: 'member of the Australian House of Representatives~~' },
  ...over,
});
const results = (bindings) => ({ results: { bindings } });
const pos = (title, start = '', end = '') => `${title}~${start}~${end}`;

/* ── the parser ───────────────────────────────────────────────────────── */

test('one row per person, with every term carried rather than repeated', () => {
  const rows = parseWikidataOfficeholders(results([binding({
    positions: { value: [
      pos('member of the Australian House of Representatives', '2016-07-02T00:00:00Z', '2019-05-18T00:00:00Z'),
      pos('member of the Australian House of Representatives', '2019-05-18T00:00:00Z', '2022-05-21T00:00:00Z'),
    ].join('||') },
  })]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].external_id, 'Q42');
  assert.equal(rows[0].source_detail.position_count, 2);
});

test('a person is merged ACROSS batches, not overwritten by the last one', () => {
  // Offices are queried in chunks, and the Prime Minister is also a member
  // of the House. Upserting per chunk would keep whichever arrived last.
  const acc = accumulateWikidataOfficeholders(results([binding({
    positions: { value: pos('member of the Australian House of Representatives', '2013-09-07T00:00:00Z') },
  })]));
  accumulateWikidataOfficeholders(results([binding({
    positions: { value: pos('Prime Minister of Australia', '2018-08-24T00:00:00Z') },
    aliases: { value: 'Patricia Example' },
  })]), acc);
  const rows = officeholderEntries(acc);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_detail.position_count, 2);
  assert.deepEqual(rows[0].aliases, ['Patricia Example']);
});

test('the office SHOWN is the current one, else the most recent', () => {
  const rows = parseWikidataOfficeholders(results([binding({
    positions: { value: [
      pos('member of the Australian House of Representatives', '2010-01-01T00:00:00Z', '2013-01-01T00:00:00Z'),
      pos('Minister for Finance', '2020-01-01T00:00:00Z'),
    ].join('||') },
  })]));
  assert.equal(rows[0].position_title, 'Minister for Finance');
  assert.equal(rows[0].currently_held, true);
});

test('a former office holder is INDEXED, never filtered out', () => {
  // Leaving a position does not end the risk — the treatment is a risk
  // assessment, not an expiry date — so the index carries them and the
  // determination decides.
  const rows = parseWikidataOfficeholders(results([binding({
    positions: { value: pos('member of the Australian House of Representatives',
      '1934-09-15T00:00:00Z', '1966-02-17T00:00:00Z') },
  })]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].currently_held, false);
  assert.equal(rows[0].position_end, '1966-02-17');
});

test('"no end date recorded" is not "still in office" when there is no start either', () => {
  const rows = parseWikidataOfficeholders(results([binding()]));
  assert.equal(rows[0].currently_held, null);
});

test('the index asserts no AUSTRAC category', () => {
  // Foreign / domestic / international-organisation belongs to the
  // determination. It is also unavailable here: "applies to jurisdiction:
  // Australia" correctly includes foreign ambassadors posted to Australia,
  // so stamping every row `domestic` was wrong on the face of the data.
  assert.equal(parseWikidataOfficeholders(results([binding()]))[0].pep_type, null);
  assert.equal(withNormalisedNames({
    external_id: 'Q1', full_name: 'Pat Example', position_title: 'Senator',
  }, 'wikidata_au_public_office', null).pep_type, null);
});

test('a Q-id label is not a name and not an office', () => {
  // Wikidata emits the raw entity id when it has no English label. Indexed
  // as a name it is unsearchable noise; shown as an office it is a machine
  // id where the position should be.
  assert.deepEqual(parseWikidataOfficeholders(results([
    binding({ personLabel: { value: 'Q23939864' } }),
  ])), []);
  assert.deepEqual(parseWikidataOfficeholders(results([
    binding({ positions: { value: pos('Q12345') } }),
  ])), []);
});

test('aliases are collected, de-duplicated, and never the primary name again', () => {
  const rows = parseWikidataOfficeholders(results([
    binding({ aliases: { value: 'Patricia Example||Patricia Example||Pat Example' } }),
  ]));
  assert.deepEqual(rows[0].aliases, ['Patricia Example']);
});

test('a malformed response is no rows, never a throw', () => {
  for (const bad of [null, {}, { results: {} }, { results: { bindings: 'x' } }]) {
    assert.deepEqual(parseWikidataOfficeholders(bad), []);
  }
});

test('every row can say where to CONFIRM it', () => {
  const rows = parseWikidataOfficeholders(results([binding()]));
  assert.ok(rows[0].confirm_url.startsWith('https://'));
});

/* ── normalisation ────────────────────────────────────────────────────── */

test('names are indexed with the SAME function the query uses', () => {
  // Not a stylistic preference. The search is a token overlap against
  // `normalised_names`; a second implementation that dropped one more
  // honorific would write rows no query can ever match.
  const row = withNormalisedNames({
    external_id: 'Q42', full_name: 'Sir Pat Example',
    aliases: ['Patricia Example'], position_title: 'Senator',
  }, 'wikidata_au_public_office', null);
  assert.deepEqual(row.normalised_names,
    [...new Set([...normaliseName('Sir Pat Example'), ...normaliseName('Patricia Example')])]);
  assert.ok(!row.normalised_names.includes('sir'));
});

test('a row with no searchable tokens is dropped by the loader and refused by the column', () => {
  const row = withNormalisedNames({
    external_id: 'Q1', full_name: 'Mr', aliases: [], position_title: 'Senator',
  }, 'wikidata_au_public_office', null);
  assert.deepEqual(row.normalised_names, []);
  assert.match(loader, /filter\(\(r\) => r\.normalised_names\.length > 0\)/);
  assert.match(migration, /cardinality\(normalised_names\) > 0/);
});

/* ── the loader's rules, each of which cost a production incident ─────── */

test('an index that parsed to zero entries is never published', () => {
  // An empty index is not "nobody holds public office"; it is a download
  // that failed, and it answers a search with the same zero rows.
  assert.match(loader, /refusing to publish an empty index/);
});

test('a shrink is a truncated response until a person says otherwise', () => {
  assert.match(loader, /PRUNE_SHRINK_FLOOR/);
  assert.match(loader, /--force-prune/);
});

test("the prune names sync_id in the RETURNING projection", () => {
  // On a MUTATION, PostgREST resolves the columns inside a logical or=(…)
  // against the RETURNING projection rather than the table, and answers
  // 42703 for a column the table plainly has. On the sanctions loader that
  // failed every load it was part of.
  const prune = loader.slice(loader.indexOf("from('pep_officeholders').delete()"));
  assert.match(prune, /\.select\('id, sync_id'\)/);
  assert.match(prune, /sync_id\.is\.null,sync_id\.neq\./);
});

test('a failed load is RECORDED as failed, so a search can refuse rather than return nothing', () => {
  assert.match(loader, /status: 'failed'/);
  assert.match(loader, /error_message/);
});

test('the query carries former holders and does not filter by date', () => {
  const q = buildWikidataOfficeholderQuery(['Q42']);
  assert.match(q, /pq:P582/);
  assert.doesNotMatch(q, /FILTER\s*\(\s*!\s*BOUND/i);
});

/*
 * The defect that made this rewrite necessary.
 *
 * The first query walked `wdt:P279*` up from `wd:Q18912794` and loaded 1,254
 * people across TWO offices — the House of Representatives and its Speaker.
 * That root is not a class of Australian public offices: it IS "member of
 * the Australian House of Representatives". No senators, no ministers, no
 * judges, nothing from any state — while the product stated on screen that
 * it covered all of them.
 */
test('offices are found by JURISDICTION, not by a subclass tree from one office', () => {
  assert.match(WIKIDATA_AU_OFFICES_QUERY, /wdt:P1001/);
  assert.match(WIKIDATA_AU_OFFICES_QUERY, /wd:Q408/);
  assert.doesNotMatch(WIKIDATA_AU_OFFICES_QUERY, /Q18912794/);
  // The states and territories are reached by their country, never by a
  // hand-written list of eight that goes stale in silence.
  assert.match(WIKIDATA_AU_OFFICES_QUERY, /wdt:P17\?/);
});

test('an office nobody has ever held is not coverage', () => {
  assert.match(WIKIDATA_AU_OFFICES_QUERY, /FILTER EXISTS/);
});

test('the holder query groups per person, so the payload is not a cross-product', () => {
  // 60 offices ungrouped produced 8.5 MB and blew the endpoint's own
  // 60-second ceiling; grouped, 20 offices is 198 KB in 2.5 seconds.
  const q = buildWikidataOfficeholderQuery(['Q42', 'Q43']);
  assert.match(q, /GROUP_CONCAT\(DISTINCT \?alias/);
  assert.match(q, /GROUP_CONCAT\(DISTINCT \?posline/);
  assert.match(q, /GROUP BY \?person/);
  assert.match(q, /VALUES \?position \{ wd:Q42 wd:Q43 \}/);
});

test('a 200 with a truncated body is treated as a truncated download, by name', () => {
  // This endpoint cuts the response at its own time limit and reports
  // nothing: HTTP 200, no error field, JSON ending mid-value. The parse is
  // the only signal there is, so the loader says what it actually means.
  assert.match(loader, /truncated body/);
  assert.match(loader, /without reporting an error/);
});

test('the loader backs off on throttling rather than recording a failed load', () => {
  assert.match(loader, /res\.status === 429/);
  assert.match(loader, /retry-after/i);
  assert.match(loader, /MAX_ATTEMPTS/);
});

test('offices are read in batches, and one person is merged across them', () => {
  assert.match(loader, /OFFICES_PER_QUERY/);
  assert.match(loader, /accumulateWikidataOfficeholders\(res\.json, acc\)/);
});

test('what the load actually reached is recorded beside it', () => {
  // A coverage sentence cannot be checked against a load. A number can.
  assert.match(loader, /office_count/);
  assert.match(loader, /distinct_offices/);
  assert.match(loader, /sample_offices/);
});

test('the office count counts EVERY office recorded, not just the one shown', () => {
  /*
   * `position_title` is the office a candidate LEADS with — the current one,
   * else the most recent. Counting those answers "how many offices do people
   * lead with", which is not a coverage number: the first corrected load
   * measured 371 while 676 offices were actually represented.
   */
  assert.match(loader, /source_detail\?\.positions/);
  assert.doesNotMatch(loader, /new Set\(rows\.map\(\(r\) => r\.position_title\)\)/);
});

/* ── what the table itself promises ───────────────────────────────────── */

test('the table says out loud that it cannot clear anybody', () => {
  assert.match(migration, /A HIT is a CANDIDATE/i);
  assert.match(migration, /not a clearance/i);
});

test('reads go through the service role only, so coverage travels with the result', () => {
  assert.match(migration, /pep_officeholders_service_only/);
  assert.match(migration, /FOR ALL TO service_role/);
});
