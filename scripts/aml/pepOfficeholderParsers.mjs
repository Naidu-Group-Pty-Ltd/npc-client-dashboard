/**
 * Parse public office-holder sources into index rows.
 *
 * Pure: takes parsed JSON, returns rows. Every I/O concern lives in
 * `load-pep-officeholders.mjs`, so this file can be unit-tested without a
 * network or a database.
 *
 * `normaliseName` is imported from `sanctionsParsers.mjs` rather than
 * re-implemented. Names in this table are searched by the SAME token overlap
 * the sanctions screening uses; a second implementation that drifted by one
 * honorific would write rows no query can ever match, which looks exactly
 * like an index that works.
 */
import { normaliseName } from './sanctionsParsers.mjs';

/**
 * Which offices count as Australian public offices.
 *
 * ── Why P1001 and not a subclass tree ─────────────────────────────────
 * The first version of this walked `wdt:P279*` up from a single root and
 * loaded 1,254 people across TWO offices — the House of Representatives and
 * its Speaker. No senators, no ministers, no judges, nothing from any state
 * or territory. The root it used, `Q18912794`, is not a class of Australian
 * public offices at all: it IS "member of the Australian House of
 * Representatives". The load succeeded, the count looked plausible, and the
 * coverage the product then stated on screen was false.
 *
 * `P1001` ("applies to jurisdiction") is the axis that actually holds. The
 * jurisdiction is Australia itself or anything whose country (`P17`) is
 * Australia, which reaches the states and territories without naming them —
 * a hand-written list of eight is a list that goes stale silently.
 *
 * Measured 2026-08-19: 724 offices, 10,569 people.
 *
 * `FILTER EXISTS` drops offices nobody has ever held. They are not coverage,
 * they are 400 extra chunks of nothing.
 */
export const WIKIDATA_AU_OFFICES_QUERY = `
SELECT DISTINCT ?pos WHERE {
  ?pos wdt:P1001 ?jur .
  ?jur wdt:P17? wd:Q408 .
  FILTER EXISTS { ?someone p:P39/ps:P39 ?pos }
}
`.trim();

/**
 * The holders of a batch of offices, ONE ROW PER PERSON.
 *
 * The grouping is not a nicety. Asking for aliases and positions as plain
 * OPTIONALs returns their cross-product: 60 offices produced 8.5 MB, the
 * endpoint hit its own 60-second ceiling, and it answered **HTTP 200 with
 * the JSON cut off mid-value and no error in the body**. Collapsing the two
 * multi-valued things with GROUP_CONCAT moves that work to the server: the
 * same shape at 20 offices is 198 KB in 2.5 seconds.
 *
 * Labels come from `rdfs:label` rather than the label service, because a
 * grouped query cannot reference the service's generated variables, and
 * because it is faster.
 *
 * Position dates are kept and never used to FILTER. A former office holder
 * is assessed on risk rather than written off by the passage of time, so the
 * index carries them and the determination decides.
 */
export function buildWikidataOfficeholderQuery(officeQids) {
  const values = officeQids.map((q) => `wd:${q}`).join(' ');
  return `
SELECT ?person ?personLabel ?article
       (GROUP_CONCAT(DISTINCT ?alias; separator="||") AS ?aliases)
       (GROUP_CONCAT(DISTINCT ?posline; separator="||") AS ?positions)
WHERE {
  VALUES ?position { ${values} }
  ?person p:P39 ?st .
  ?st ps:P39 ?position .
  ?person rdfs:label ?personLabel . FILTER(LANG(?personLabel) = "en")
  ?position rdfs:label ?posLabel . FILTER(LANG(?posLabel) = "en")
  OPTIONAL { ?st pq:P580 ?s }
  OPTIONAL { ?st pq:P582 ?e }
  BIND(CONCAT(?posLabel, "~", COALESCE(STR(?s), ""), "~", COALESCE(STR(?e), "")) AS ?posline)
  OPTIONAL { ?article schema:about ?person ; schema:isPartOf <https://en.wikipedia.org/> . }
  OPTIONAL { ?person skos:altLabel ?alias . FILTER(LANG(?alias) = "en") }
}
GROUP BY ?person ?personLabel ?article
`.trim();
}

const text = (b, k) => {
  const v = b?.[k]?.value;
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
};

/** `2016-07-02T00:00:00Z` → `2016-07-02`; anything else → null. */
const asDate = (v) => {
  if (!v) return null;
  const m = /^(-?\d{4})-(\d{2})-(\d{2})/.exec(v);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

/**
 * A label that is really a Q-id ("Q23939864") means Wikidata has no English
 * label for the entity. Indexed as a NAME that is an unsearchable string;
 * shown as a POSITION it is a machine id where the office should be.
 */
const isQid = (s) => typeof s === 'string' && /^Q\d+$/.test(s);

/** `title~start~end` → `{ title, start, end }`, or null if unusable. */
function parsePositionLine(line) {
  const parts = String(line ?? '').split('~');
  const title = (parts[0] ?? '').trim();
  if (!title || isQid(title)) return null;
  return { title, start: asDate(parts[1]), end: asDate(parts[2]) };
}

/**
 * Merge one batch of grouped results into an accumulator keyed by person.
 *
 * The accumulator is threaded across batches because offices are queried in
 * chunks and one person holds offices in several of them — the Prime
 * Minister is also a member of the House. Merging at the end of every chunk
 * rather than upserting per chunk is what keeps a person's positions in one
 * row instead of whichever chunk wrote last.
 */
export function accumulateWikidataOfficeholders(json, into = new Map()) {
  const bindings = json?.results?.bindings;
  if (!Array.isArray(bindings)) return into;

  for (const b of bindings) {
    const uri = text(b, 'person');
    const name = text(b, 'personLabel');
    if (!uri || !name || isQid(name)) continue;

    const positions = String(b?.positions?.value ?? '')
      .split('||').map(parsePositionLine).filter(Boolean);
    if (positions.length === 0) continue;

    const qid = uri.split('/').pop();
    let row = into.get(qid);
    if (!row) {
      row = { external_id: qid, full_name: name, aliases: new Set(), positions: [], article: null };
      into.set(qid, row);
    }
    if (!row.article) row.article = text(b, 'article');
    for (const alias of String(b?.aliases?.value ?? '').split('||')) {
      const a = alias.trim();
      if (a && a !== name && !isQid(a)) row.aliases.add(a);
    }
    for (const p of positions) {
      const key = `${p.title}|${p.start ?? ''}|${p.end ?? ''}`;
      if (!row.positions.some((x) => x.key === key)) row.positions.push({ key, ...p });
    }
  }
  return into;
}

/** Turn the accumulator into index entries. */
export function officeholderEntries(acc) {
  return [...acc.values()].map((row) => {
    // The office to SHOW is the one currently held, else the most recent —
    // an operator scanning candidates needs the position that makes this
    // person worth a second look, not whichever chunk arrived first.
    const sorted = row.positions.slice().sort((a, b) => {
      const aOpen = a.end === null, bOpen = b.end === null;
      if (aOpen !== bOpen) return aOpen ? -1 : 1;
      return String(b.end ?? b.start ?? '').localeCompare(String(a.end ?? a.start ?? ''));
    });
    const lead = sorted[0];
    /*
     * `currently_held` is null when the source does not say, NEVER false.
     * An open-ended statement means "no end date recorded", which is not the
     * same as "still in office" — but a start with no end is the only
     * positive signal the source has, so that reads as true and a statement
     * with no dates at all reads as unknown.
     */
    const currentlyHeld = lead.end !== null ? false : (lead.start !== null ? true : null);
    return {
      external_id: row.external_id,
      full_name: row.full_name,
      aliases: [...row.aliases].slice(0, 12),
      position_title: lead.title,
      /*
       * NOT asserted. The AUSTRAC category — foreign, domestic or
       * international organisation — is part of the DETERMINATION a person
       * reaches, and this index does not make determinations. It also
       * cannot: an "applies to jurisdiction: Australia" office includes
       * foreign ambassadors posted here, so stamping every row `domestic`
       * would be wrong on the face of the data as well as in principle.
       */
      pep_type: null,
      jurisdiction: 'Australia',
      position_start: lead.start,
      position_end: lead.end,
      currently_held: currentlyHeld,
      confirm_url: row.article ?? `https://www.wikidata.org/wiki/${row.external_id}`,
      source_detail: {
        positions: sorted.map(({ title, start, end }) => ({ title, start, end })),
        position_count: sorted.length,
      },
    };
  });
}

/** One batch, standalone — the shape the tests exercise. */
export function parseWikidataOfficeholders(json) {
  return officeholderEntries(accumulateWikidataOfficeholders(json));
}

/**
 * Attach the searchable tokens and the sync id.
 *
 * Identical in shape to `withNormalisedNames` in `sanctionsParsers.mjs`, and
 * deliberately using the same `normaliseName`.
 */
export function withNormalisedNames(entry, sourceCode, syncId) {
  const normalised = [...new Set(
    [entry.full_name, ...(entry.aliases ?? [])].flatMap((n) => normaliseName(n)),
  )];
  return {
    source_code: sourceCode,
    external_id: entry.external_id,
    full_name: entry.full_name,
    aliases: entry.aliases ?? [],
    normalised_names: normalised,
    position_title: entry.position_title,
    pep_type: entry.pep_type ?? null,
    jurisdiction: entry.jurisdiction ?? null,
    position_start: entry.position_start ?? null,
    position_end: entry.position_end ?? null,
    currently_held: entry.currently_held ?? null,
    confirm_url: entry.confirm_url ?? null,
    source_detail: entry.source_detail ?? {},
    sync_id: syncId ?? null,
    updated_at: new Date().toISOString(),
  };
}
