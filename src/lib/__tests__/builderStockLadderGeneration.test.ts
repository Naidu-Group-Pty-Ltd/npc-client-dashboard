/**
 * BUILDER STOCK — THE SECOND AND THIRD REASONS 119 PROPERTIES CAME OUT BLANK.
 *
 * PRODUCTION, 30 AUGUST 2026. A stock list imported cleanly, the cutover
 * published it, every property was claimed and every property advanced through
 * source, eligibility, sanitization and fallback. Two pictures came out of it.
 *
 * The identity half is `builderStockCanonicalIdentity.test.ts`: the ladder had
 * no name to look the property up by, because an address was only ever taken
 * from a column and never composed from the lot and the estate beside it.
 * This file is the other two, and each one on its own leaves a property
 * settled and permanently blank.
 *
 *
 * TWO. AN OUTAGE WAS CREDITED AS A COMPLETED STAGE.
 *
 * `stageWasAttempted` counts any row for a stage as that stage having run —
 * a deliberate widening, because a search that returned nothing used to read
 * as a search never made and the ladder asked for it again for ever. But it
 * widened past the line: 58 properties of that upload hold an
 * `internet_search` row reading "The property search service did not respond",
 * which is the provider being down. It says nothing whatever about the
 * property, and every one of those 58 was moved down the ladder on it.
 *
 * A FINDING IS AN ANSWER; A FAILURE IS NOT. `unavailable` — nothing published,
 * no address to look up — is the stage answering, and the ladder moves on. The
 * retry is BOUNDED at `MAX_STAGE_FAILURES`, because the unbounded version of
 * this correction is the loop the widening was written to close.
 *
 *
 * THREE. AN IMPROVED LADDER COULD NOT REACH THE PROPERTIES IT WAS WRITTEN FOR.
 *
 * `settleItemImages.ts` states the rule in its own header and admits it has no
 * mechanism: a property at `settled` is never claimed again, so every ladder
 * improvement applies to future uploads only. The re-open added for a
 * re-judged IMAGE cannot see a change to the ENGINE — no image moves when the
 * ladder learns to compose an address. A generation stamp closes it.
 *
 * Written on invented data. No estate, lot, suburb, organisation, upload,
 * spreadsheet or source URL here belongs to any deployment.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  MAX_BLOCKED_PASSES, blockedPassCount, nextImageStage, stageWasAttempted,
  STAGE_SKIPPED_MESSAGE, STAGE_SKIPPED_REFERENCE,
} from '../../../supabase/functions/_shared/builderStock/imagePriority.pure';
import { geocodableAddress, normaliseStockRow } from '../../../supabase/functions/_shared/builderStock/normalise.pure';
import { repairStoredIdentity } from '../../../supabase/functions/_shared/builderStock/storedIdentityRepair.pure';
import {
  assessGeocodePrecision, assessPanoramaUsefulness,
} from '../../../supabase/functions/_shared/builderStock/streetViewHeading.pure';

const WEB = 'internet_search';
const STREET = 'google_maps';

/** A `stage-status` row: the ladder's own note about what a stage did. */
const statusRow = (stage: string, over: Record<string, unknown> = {}) => ({
  id: `${stage}-status`, source_stage: stage, source_reference: 'stage-status',
  processing_status: 'unavailable', verification_status: 'unverified',
  storage_path: null, external_url: null, position: 0, source_detail: null,
  ...over,
});

const settled = { sourceSettlementComplete: true };

// ── TWO ─────────────────────────────────────────────────────────────────────

describe('a stage that did not RUN is not a stage that answered', () => {
  /*
   * The line is not `unavailable` versus `failed`. It is whether the provider
   * was asked and replied ABOUT THIS PROPERTY. Both kinds are written to the
   * same column with the same status, which is why the row carries the answer
   * explicitly rather than being classified from its text.
   */
  const answered = (stage: string, over: Record<string, unknown> = {}) =>
    statusRow(stage, { source_detail: { stage_ran: true }, ...over });
  const blocked = (stage: string, passes = 1, over: Record<string, unknown> = {}) =>
    statusRow(stage, { source_detail: { stage_ran: false, blocked_passes: passes }, ...over });

  it('an outage does not retire the rung it interrupted', () => {
    const outage = blocked(WEB, 1, {
      processing_status: 'failed',
      error_message: 'The property search service did not respond.',
    });
    expect(stageWasAttempted(outage as never, WEB)).toBe(false);
    expect(nextImageStage([outage] as never, settled)).toBe('web_search');
  });

  it('a MISSING INPUT does not retire it either — and that is the 86', () => {
    /*
     * "This property has no street address to look up" is not a finding about
     * the property. It is this product saying it could not ask the question,
     * and the identity it needed was in the row the whole time. Crediting it
     * as a completed stage is what left 86 properties permanently blank.
     */
    const starved = blocked(STREET, 1, {
      verification_status: 'location_derived',
      error_message: 'This property has no street address to look up.',
    });
    expect(stageWasAttempted(starved as never, STREET)).toBe(false);
    expect(nextImageStage([answered(WEB), starved] as never, settled)).toBe('street_view');
  });

  it('an unconfigured provider is the same class, not a verdict', () => {
    for (const message of [
      'Location imagery is not configured for this workspace.',
      'Location imagery is temporarily switched off.',
      'The daily limit for location imagery has been reached.',
    ]) {
      const row = blocked(STREET, 1, { error_message: message });
      expect(stageWasAttempted(row as never, STREET)).toBe(false);
    }
  });

  it('a FINDING is an answer, and the ladder moves on from it', () => {
    // "No published imagery was found" is the search having run and returned
    // nothing. That is knowledge about the property, not about us.
    const empty = answered(WEB, {
      error_message: 'No published imagery was found for this property.',
    });
    expect(stageWasAttempted(empty as never, WEB)).toBe(true);
    expect(nextImageStage([empty] as never, settled)).toBe('street_view');
  });

  it('"could not be located" and "the panorama is too far" are answers too', () => {
    // Google WAS asked, about this property, and replied.
    for (const message of [
      'That address could not be located.',
      'The nearest Street View panorama is 300 m from this property, too far to be a photograph of it.',
    ]) {
      const row = answered(STREET, {
        verification_status: 'location_derived', error_message: message,
      });
      expect(stageWasAttempted(row as never, STREET)).toBe(true);
    }
  });

  it('the retry is BOUNDED — a provider that stays down stops being asked', () => {
    const spent = blocked(WEB, MAX_BLOCKED_PASSES, { processing_status: 'failed' });
    expect(stageWasAttempted(spent as never, WEB)).toBe(true);
    expect(nextImageStage([spent] as never, settled)).toBe('street_view');
  });

  it('the ceiling is small enough to be an outage and not a budget', () => {
    expect(MAX_BLOCKED_PASSES).toBeGreaterThanOrEqual(2);
    expect(MAX_BLOCKED_PASSES).toBeLessThanOrEqual(3);
  });

  it('a `failed` row is blocked whatever its detail says', () => {
    // Belt and braces: an operational failure never ran to an answer, so a
    // row that claims otherwise is still read as blocked.
    const lying = statusRow(WEB, {
      processing_status: 'failed', source_detail: { stage_ran: true },
    });
    expect(stageWasAttempted(lying as never, WEB)).toBe(false);
  });

  it('a row written before the flag existed still reads as ANSWERED', () => {
    /*
     * Undecided means answered, which is the behaviour that shipped. A
     * historical row cannot be classified from its text, and guessing would
     * either strand a property or re-buy a stage against every such row in the
     * deployment. The one-time recovery is the ladder generation, which CLEARS
     * this bookkeeping rather than reinterpreting it.
     */
    const legacy = statusRow(WEB, { source_detail: null });
    expect(stageWasAttempted(legacy as never, WEB)).toBe(true);
    // …except a legacy row that FAILED, which is unambiguous on its face.
    const legacyFailed = statusRow(WEB, {
      processing_status: 'failed', source_detail: null,
    });
    expect(blockedPassCount(legacyFailed as never)).toBe(1);
    expect(stageWasAttempted(legacyFailed as never, WEB)).toBe(false);
  });

  it('a nonsense counter is read conservatively rather than trusted', () => {
    for (const bad of [null, undefined, 'many', {}, -4, Number.NaN]) {
      const row = blocked(WEB, 1, { source_detail: { stage_ran: false, blocked_passes: bad } });
      expect(blockedPassCount(row as never)).toBeGreaterThanOrEqual(1);
    }
  });

  it('a SKIP is still not an attempt, whatever its status', () => {
    const skip = statusRow(WEB, {
      source_reference: STAGE_SKIPPED_REFERENCE, error_message: STAGE_SKIPPED_MESSAGE,
    });
    expect(stageWasAttempted(skip as never, WEB)).toBe(false);
    const legacySkip = statusRow(WEB, { error_message: STAGE_SKIPPED_MESSAGE });
    expect(stageWasAttempted(legacySkip as never, WEB)).toBe(false);
  });

  it('a stage that produced a PICTURE is never re-asked on a block elsewhere', () => {
    const outage = blocked(WEB, 1, { processing_status: 'failed' });
    const photo = {
      id: 'web-1', source_stage: WEB, source_reference: 'ref-a',
      processing_status: 'ready', verification_status: 'property_identity_verified',
      storage_path: 'web-1.jpg', external_url: null, position: 0,
      source_detail: {
        property_identity: { matched: ['lot', 'estate'], verified_at: '2026-01-01T00:00:00Z' },
      },
    };
    expect(nextImageStage([outage, photo] as never, settled)).toBe('none');
  });

  it('and when every stage really is spent, the answer is still `none`', () => {
    // ZERO BUILDER BRANCHES AND TWO EXHAUSTED STAGES IS A LEGITIMATE BLANK.
    const rows = [
      blocked(WEB, MAX_BLOCKED_PASSES, { processing_status: 'failed' }),
      answered(STREET, { verification_status: 'location_derived' }),
    ];
    expect(nextImageStage(rows as never, settled)).toBe('none');
  });

  it('every refusal in the ladder declares which kind it is', () => {
    // `ran` is a required argument precisely so a new refusal cannot be added
    // without someone deciding, and the two kinds read alike at the call site.
    const source = readFileSync(
      'supabase/functions/_shared/builderStock/images.ts', 'utf8');
    const calls = source.split('recordStageUnavailable(').slice(2);
    expect(calls.length).toBeGreaterThanOrEqual(10);
    for (const call of calls) {
      expect(call.slice(0, 400)).toMatch(/,\s*(true|false)\);/);
    }
  });
});

// ── THE SOURCE MATRIX ───────────────────────────────────────────────────────
/*
 * The starved shape is not a property of one spreadsheet. It is a property of
 * STOCK LISTS: the lot in one column, the estate in another, the locality in a
 * third, and no column that is an address. Every supported source can present
 * it, so every supported source is put through the same two questions —
 * can the ladder name this property, and does the repair recover a record
 * already stored in the older shape?
 */
const SOURCES: Array<{ name: string; headers: Record<string, string> }> = [
  { name: 'a Google Sheets tab', headers: { 'Lot #': '605', Estate: 'Sample Rise', Location: 'Northfield' } },
  { name: 'a Notion database', headers: { Lot: '12', Development: 'Second Estate', Area: 'Eastvale' } },
  { name: 'an uploaded CSV', headers: { 'Lot Number': '3', 'Estate Name': 'Third Estate', Suburb: 'Westbrook' } },
  { name: 'an XLSX workbook', headers: { LOT: '88', Project: 'Fourth Stage', 'Suburb Location': 'Southgate' } },
];

describe('every supported source presents the same starved shape', () => {
  for (const source of SOURCES) {
    it(`${source.name} — the ladder can name the property`, () => {
      const row = normaliseStockRow(source.headers);
      expect(row).not.toBeNull();
      // The builder gave no address column, and none is invented on the record.
      expect(row!.address_line).toBeNull();
      const address = geocodableAddress(row!);
      expect(address).toBeTruthy();
      expect(address).toMatch(/, Australia$/);
      // Every part of it came out of a column the builder supplied.
      for (const value of Object.values(source.headers)) {
        expect(address!.toLowerCase()).toContain(value.toLowerCase());
      }
    });
  }

  it('and a row with no place still refuses, whatever the source called it', () => {
    for (const heading of ['Lot #', 'Lot', 'Lot Number', 'LOT']) {
      const row = normaliseStockRow({ [heading]: '605' });
      expect(geocodableAddress(row!)).toBeNull();
    }
  });
});

describe('a record stored in the older shape recovers without being re-uploaded', () => {
  for (const source of SOURCES) {
    it(`${source.name} — the locality is recovered from the raw row`, () => {
      /*
       * How the record actually looks in the table: the import placed the lot
       * and the estate, and the locality heading it did not recognise went to
       * `unmapped` rather than being dropped. That is what makes this
       * recoverable at all.
       */
      const [lotHeader, placeHeader, localityHeader] = Object.keys(source.headers);
      const stored = {
        address_line: null, suburb: null, state: null, postcode: null,
        lot_number: source.headers[lotHeader], unit_number: null,
        development_name: source.headers[placeHeader], project_name: null,
      };
      const raw = { unmapped: { [localityHeader]: source.headers[localityHeader] } };

      const { patch, recovered } = repairStoredIdentity(stored, raw);
      expect(recovered).toContain('suburb');
      expect(patch.suburb).toBe(source.headers[localityHeader]);

      // And with it, the property is findable where it was not.
      expect(geocodableAddress(stored as never)).toBeNull();
      expect(geocodableAddress({ ...stored, ...patch } as never)).toBeTruthy();
    });
  }

  it('a repair is idempotent — the second pass has nothing left to do', () => {
    const stored = {
      address_line: null, suburb: null, state: null, postcode: null,
      lot_number: '605', unit_number: null,
      development_name: 'Sample Rise', project_name: null,
    };
    const raw = { unmapped: { Location: 'Northfield' } };
    const first = repairStoredIdentity(stored, raw);
    const second = repairStoredIdentity({ ...stored, ...first.patch }, raw);
    expect(second.recovered).toEqual([]);
    expect(second.patch).toEqual({});
  });

  it('a record the builder filled in properly is never touched', () => {
    const complete = {
      address_line: '12 Wattle Street', suburb: 'Northfield', state: 'VIC',
      postcode: '3000', lot_number: null, unit_number: null,
      development_name: null, project_name: null,
    };
    const { patch } = repairStoredIdentity(complete, { unmapped: { Location: 'Somewhere Else' } });
    expect(patch).toEqual({});
  });
});

// ── THREE ───────────────────────────────────────────────────────────────────

describe('the ladder generation reaches properties that already settled', () => {
  const migration = readFileSync(
    'supabase/migrations/20261027010000_builder_stock_ladder_generation.sql', 'utf8');

  it('re-opens on the ENGINE changing, not only on evidence changing', () => {
    // The sibling rule (an image re-judged after the property settled) cannot
    // see a ladder improvement, because no image moves when one ships.
    expect(migration).toContain('image_ladder_generation_at');
    expect(migration).toMatch(/i\.image_work_updated_at\s*<\s*v_generation/);
    // The evidence rule is kept, not replaced.
    expect(migration).toMatch(/x\.updated_at\s*>\s*i\.image_work_updated_at/);
  });

  it('only blank properties, so nothing already showing a picture is re-bought', () => {
    expect(migration).toMatch(/primary_image_id IS NULL/);
  });

  it('is self-limiting — re-opening stamps the timestamp it is compared against', () => {
    expect(migration).toMatch(/image_work_updated_at = now\(\)/);
  });

  it('clears the bookkeeping the old ladder left, or nothing changes', () => {
    /*
     * Re-opening alone is not enough: `nextImageStage` reads `stage-status`
     * rows to decide which rungs are owed, and the previous generation's rows
     * say they were climbed. Leave them and every property re-opens, finds
     * both stages recorded as done, and settles blank again immediately.
     */
    expect(migration).toMatch(/DELETE FROM public\.builder_stock_item_images/);
    expect(migration).toMatch(/source_reference = 'stage-status'/);
    // Scoped to the two paid stages, so no builder row or stored photograph
    // is reachable from here.
    expect(migration).toMatch(/source_stage IN \('internet_search', 'google_maps'\)/);
  });

  it('clears the terminal enrichment verdict, or the fallback queue never sees it', () => {
    // `settleFallbackImages` reads `enrichment_status IN ('pending','enriching')`.
    // A property re-opened while still `failed` would climb no rung at all.
    expect(migration).toMatch(/enrichment_status = 'pending'/);
  });

  it('re-arms the scheduler, which unschedules itself when nothing is owed', () => {
    // A deployment whose properties have all settled blank has no job left to
    // run the re-open from, so shipping a generation has to wake it.
    expect(migration).toContain('ensure_builder_stock_settlement_scheduled');
    // Through the same function the insert trigger calls — the schedule is
    // stated once and this migration cannot drift from it.
    expect(migration).not.toMatch(/cron\.schedule\s*\(/);
  });

  it('names no upload, organisation, builder, estate or source', () => {
    const withoutComments = migration
      .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*--.*$/gm, ' ');
    expect(withoutComments).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
    expect(withoutComments).not.toMatch(/https?:\/\//);
    for (const word of ['upload_id =', 'organisation_id =', 'docs.google', 'notion']) {
      expect(withoutComments.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });
});

describe('nothing in this fix is specific to anything', () => {
  const files = [
    'supabase/functions/_shared/builderStock/canonicalIdentity.pure.ts',
    'supabase/functions/_shared/builderStock/storedIdentityRepair.pure.ts',
    'supabase/functions/_shared/builderStock/imagePriority.pure.ts',
  ];

  it('carries no identifier belonging to a deployment', () => {
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
      expect(source).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
      expect(source).not.toMatch(/https?:\/\/(?!example\.invalid)/);
    }
  });

  it('decides nothing from a source type', () => {
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
      for (const word of ['sheets', 'notion', 'csv', 'xlsx', 'gid']) {
        expect(source.toLowerCase()).not.toContain(word);
      }
    }
  });
});

// ── THE HAZARD THE COMPOSITION CREATES, AND ITS GUARD ───────────────────────
/*
 * Composing an address makes stage 3 reachable for properties that could never
 * reach it, which is the point. It also makes a new way of being WRONG
 * reachable: Google answers an estate name it has never heard of by falling
 * back to the locality, and the panorama guard cannot catch that — it measures
 * the panorama against the geocode, and the nearest panorama to the middle of
 * a suburb is a street in that suburb. Every distance check passes on a
 * photograph of somewhere else.
 */
describe('a geocode of a suburb is not a geocode of a property', () => {
  it('refuses a match that resolved only as far as the locality', () => {
    const verdict = assessGeocodePrecision({ types: ['locality', 'political'] });
    expect(verdict.usable).toBe(false);
    expect(verdict.coarsestType).toBe('locality');
    // And it says so in words a builder can act on, not a type name.
    expect(verdict.reason).not.toContain('locality');
  });

  it('refuses a postcode and an administrative area too', () => {
    for (const type of ['postal_code', 'postal_town',
      'administrative_area_level_1', 'administrative_area_level_2', 'country']) {
      expect(assessGeocodePrecision({ types: [type, 'political'] }).usable).toBe(false);
    }
  });

  it('accepts every precision a NAMED ESTATE legitimately resolves to', () => {
    // This is the whole point of composing — an estate is not a street number,
    // and refusing everything short of a rooftop would refuse the feature.
    for (const type of ['street_address', 'premise', 'subpremise', 'route',
      'neighborhood', 'establishment', 'point_of_interest', 'sublocality']) {
      expect(assessGeocodePrecision({ types: [type] }).usable).toBe(true);
    }
  });

  it('a match that states no precision is accepted, never refused', () => {
    // Same rule the panorama guard follows: a missing optional field must not
    // turn a working card blank.
    for (const shape of [{}, { types: [] }, { types: null }, null, undefined]) {
      expect(assessGeocodePrecision(shape).usable).toBe(true);
    }
  });

  it('the panorama distance guard is untouched and still binds', () => {
    // The two guards answer different questions and both have to hold: this
    // one asks whether the POINT is the property, that one whether the CAMERA
    // was near the point.
    const near = assessPanoramaUsefulness(
      { lat: -37.8, lng: 144.9 }, { lat: -37.8, lng: 144.9 });
    expect(near.usable).toBe(true);
    const far = assessPanoramaUsefulness(
      { lat: -37.81, lng: 144.9 }, { lat: -37.8, lng: 144.9 });
    expect(far.usable).toBe(false);
  });

  it('a refused geocode is a FINDING, so the ladder is not asked for it again', () => {
    // It is recorded `unavailable` rather than `failed`: the lookup ran and
    // answered, and the answer is that this property cannot be photographed
    // from a location. Retrying it would buy the same answer.
    const source = readFileSync(
      'supabase/functions/_shared/builderStock/images.ts', 'utf8');
    expect(source).toMatch(/assessGeocodePrecision\(match\)/);
    expect(source).toMatch(/precision\.usable[\s\S]{0,220}'unavailable', precision\.reason/);
  });
});

// ── AND THE COHORT MUST NOT SPIN ────────────────────────────────────────────

describe('a property that has finished its ladder does not wait on the others', () => {
  const SOURCE = readFileSync(
    'supabase/functions/_shared/builderStock/settleFallbackImages.ts', 'utf8');

  it('measures what is REMAINING over the scope the work was done in', () => {
    /*
     * `settleClaimedItem` decides one property's next stage from this number —
     * `remaining > 0 ? 'fallback' : settled` — and the read used to be global
     * whatever the caller asked for. So a property that had finished its own
     * ladder was held at `fallback` while ANY other property in the deployment
     * was still owed one: re-claimed, finding its own queue empty, doing
     * nothing, re-claimed again. Quadratic invocations against a per-item claim.
     */
    const after = SOURCE.slice(SOURCE.indexOf('const after = await readFallbackQueue'));
    expect(after.slice(0, 200)).toContain('stockItemId: input.stockItemId');
  });

  it('and is still global when the caller asked for the whole deployment', () => {
    // `?? null` rather than a required argument: the cron's own sweep passes
    // no item and must keep counting everything, which is what its completion
    // rule is built on.
    const after = SOURCE.slice(SOURCE.indexOf('const after = await readFallbackQueue'));
    expect(after.slice(0, 200)).toContain('?? null');
  });
});

// ── SETTLED HAS EXACTLY ONE MEANING ─────────────────────────────────────────
/*
 * A property may be settled only where it holds a valid primary image, or
 * where every permitted stage is genuinely exhausted. Never because a provider
 * was down, a stage was skipped, or a bounded retry was still owed.
 *
 * The path that broke it: `enrichStockItem` consulted `ladderHasMore` only on
 * the `!anyReady` arm. `anyReady` means "a stage stored an image", which is a
 * different question from "this property has a picture" — a web result that
 * stores cleanly and then fails the identity check is a `ready` OUTCOME and a
 * non-displayable IMAGE. So stage 2 storing an unverified photo, plus stage 3
 * blocked by an outage in the same claim, marked the property `partial`, which
 * is terminal: `readFallbackQueue` selects `pending`/`enriching` only.
 */
describe('a property is never terminal while the ladder still owes it a rung', () => {
  const SOURCE = readFileSync(
    'supabase/functions/_shared/builderStock/images.ts', 'utf8');

  it('the ladder is asked FIRST, before anything about stored bytes', () => {
    const expr = SOURCE.slice(SOURCE.indexOf('const enrichmentStatus'));
    expect(expr.slice(0, 200)).toMatch(/const enrichmentStatus = ladderHasMore\s*\n?\s*\?\s*'pending'/);
  });

  it('`anyReady` can no longer overrule an owed stage', () => {
    // The defect in one line: `anyReady ? … : (ladderHasMore ? …)` consults the
    // ladder only when nothing was stored.
    const expr = SOURCE.slice(SOURCE.indexOf('const enrichmentStatus'), SOURCE.indexOf('const enrichmentStatus') + 200);
    expect(expr).not.toMatch(/anyReady\s*\n?\s*\?\s*\(anyProblem[\s\S]{0,60}ladderHasMore/);
  });

  it('and the terminal vocabulary is unchanged — only its timing', () => {
    const expr = SOURCE.slice(SOURCE.indexOf('const enrichmentStatus'), SOURCE.indexOf('const enrichmentStatus') + 220);
    for (const status of ['pending', 'partial', 'complete', 'failed']) {
      expect(expr).toContain(`'${status}'`);
    }
  });

  it('the ladder verdict is re-read from the rows, not planned in advance', () => {
    // What makes asking it first honest at all.
    const before = SOURCE.indexOf("from('builder_stock_item_images')\n    .select('id, source_stage");
    const decide = SOURCE.indexOf('const enrichmentStatus');
    expect(before).toBeGreaterThan(-1);
    expect(before).toBeLessThan(decide);
  });

  it('a blocked stage under the ceiling is an owed rung, so it cannot settle', () => {
    // The unit-level statement of the same invariant, through the ladder.
    const blocked = statusRow(STREET, {
      processing_status: 'unavailable', verification_status: 'location_derived',
      source_detail: { stage_ran: false, blocked_passes: 1 },
    });
    const storedButUnverified = {
      id: 'web-x', source_stage: WEB, source_reference: 'https://example.invalid/x.jpg',
      processing_status: 'ready', verification_status: 'unverified',
      storage_path: 'web-x.jpg', external_url: null, position: 0, source_detail: {},
    };
    // Stage 2 stored something; stage 3 is still owed.
    expect(nextImageStage([storedButUnverified, blocked] as never, settled)).toBe('street_view');
  });

  it('and once the ceiling is reached, the same shape IS terminal', () => {
    const spent = statusRow(STREET, {
      processing_status: 'unavailable', verification_status: 'location_derived',
      source_detail: { stage_ran: false, blocked_passes: MAX_BLOCKED_PASSES },
    });
    const storedButUnverified = {
      id: 'web-x', source_stage: WEB, source_reference: 'https://example.invalid/x.jpg',
      processing_status: 'ready', verification_status: 'unverified',
      storage_path: 'web-x.jpg', external_url: null, position: 0, source_detail: {},
    };
    expect(nextImageStage([storedButUnverified, spent] as never, settled)).toBe('none');
  });
});
