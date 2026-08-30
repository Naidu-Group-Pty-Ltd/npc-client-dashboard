/**
 * BUILDER STOCK — STAGE 1 ANSWERING "NO" IS NOT STAGE 1 FAILING TO ANSWER.
 *
 * PRODUCTION, 30 AUGUST 2026. Two properties on one estate reached the
 * Marketplace blank. Each had been through the whole of stage 1: its Notion
 * row's own cover was stored and measured, and its OWN linked package — a
 * different Drive folder per product — was opened twice, killed the worker
 * twice, and was retired at MAX_PACKAGE_ATTEMPTS with
 * `no_deterministic_image`. That much is the documented, deliberate behaviour,
 * and the code that does it promises the property "loses its builder image and
 * GAINS the fallback ladder".
 *
 * It did not gain the fallback ladder, for two independent reasons.
 *
 * ONE. `wait` HAD NO EXIT. A source image that had been measured, refused as a
 * marketing tile, and whose repair question was closed too still satisfied
 * "not displayable", which was the whole of the pending test. So the ladder
 * answered `wait` — evidence that has not arrived — on every pass, for ever.
 * `wait` writes nothing and advances nothing, so stage 2 and stage 3 were
 * unreachable however many times the property was claimed.
 *
 * TWO. A SKIP WAS INDISTINGUISHABLE FROM AN EXHAUSTION. When stage 1 answers,
 * the two paid stages are recorded as skipped — "the builder supplied an image
 * for this property". Those rows were written under the same `stage-status`
 * reference as a stage that RAN and found nothing. Stage 1's answer then
 * changed: the cover was re-measured as a marketing tile eighteen hours later.
 * The skips survived, and every "is there a row for this stage?" test read
 * them as a ladder already climbed.
 *
 * Written on invented data. No estate, lot, anchor, organisation or file name
 * here belongs to any deployment.
 */
import { describe, expect, it } from 'vitest';

import {
  nextImageStage, stageWasAttempted, STAGE_SKIPPED_MESSAGE, STAGE_SKIPPED_REFERENCE,
} from '../../../supabase/functions/_shared/builderStock/imagePriority.pure';
import { classifyPrimaryImageStanding } from '../../../supabase/functions/_shared/builderStock/primaryImage';
import {
  identityDifferences, stockPropertyIdentity,
} from '../../../supabase/functions/_shared/builderStock/stockIdentity.pure';

const PROVENANCE = 5;
const ELIGIBILITY = 2;
const SANITIZATION = 2;

/** A builder-supplied candidate, with whatever verdicts it has reached. */
const builderImage = (id: string, over: Record<string, unknown> = {}) => ({
  id, source_stage: 'uploaded_document', verification_status: 'source_supplied',
  processing_status: 'ready', position: 0, storage_path: `${id}.jpg`, external_url: null,
  source_detail: {
    role: 'primary_property', provenance_version: PROVENANCE,
    stored_sha256: id, source_sha256: id,
    ...over,
  },
});

/** Measured, and convicted as a promotional tile. */
const convicted = (id: string, extra: Record<string, unknown> = {}) => builderImage(id, {
  marketplace_measured: true,
  marketplace_eligibility_version: ELIGIBILITY,
  marketplace_eligibility_state: 'ineligible',
  marketplace_rejection_reason: 'annotated_marketing_tile',
  ...extra,
});

/** Measured, and clean. */
const clean = (id: string) => builderImage(id, {
  marketplace_measured: true,
  marketplace_eligibility_version: ELIGIBILITY,
  marketplace_eligibility_state: 'eligible',
});

/** The repair ran and found nothing to lift. The question is now closed. */
const repairFailed = (image: ReturnType<typeof convicted>) => ({
  ...image,
  source_detail: {
    ...image.source_detail,
    sanitization_failure: {
      sanitization_version: SANITIZATION,
      original_sha256: image.source_detail.stored_sha256,
      reason: 'no_region',
    },
  },
});

const skipRow = (stage: string) => ({
  id: `skip-${stage}`, source_stage: stage,
  source_reference: STAGE_SKIPPED_REFERENCE,
  error_message: STAGE_SKIPPED_MESSAGE,
  verification_status: stage === 'google_maps' ? 'location_derived' : 'unverified',
  processing_status: 'unavailable', position: 0,
  storage_path: null, external_url: null, source_detail: {},
});

/** A skip written before the reference existed. Recognised by its message. */
const legacySkipRow = (stage: string) => ({
  ...skipRow(stage), source_reference: 'stage-status',
});

/** A stage that genuinely ran and found nothing. */
const ranAndFoundNothing = (stage: string) => ({
  ...skipRow(stage), source_reference: 'stage-status',
  error_message: 'No photograph could be verified as this property.',
});

const settled = { sourceSettlementComplete: true };

// ---------------------------------------------------------------------------

describe('stage 1 continues through the property\'s own builder sources', () => {
  it('a convicted row asset does not end the search while a package remains', () => {
    /*
     * The precedence rule: every primary candidate the ROW produced is
     * measured and convicted, none is clean, so the property's own linked
     * package is still to be read. `convictedOnly` is what licenses that.
     */
    const standing = classifyPrimaryImageStanding([convicted('tile-a')] as never, PROVENANCE);
    expect(standing.ready).toBe(true);
    expect(standing.clean).toBe(false);
    expect(standing.convictedOnly).toBe(true);
  });

  it('a package photograph found after the tile becomes the picture, and stops the ladder', () => {
    // Builder asset A: a marketing tile, rejected. Builder package: photo B.
    const rows = [convicted('tile-a'), clean('package-photo-b')];
    // B is displayable, so stage 1 ANSWERED. Neither paid stage may run.
    expect(nextImageStage(rows as never, settled)).toBe('none');
    // And the standing is no longer convicted-only, so the package is not
    // re-read on a later pass either.
    expect(classifyPrimaryImageStanding(rows as never, PROVENANCE).clean).toBe(true);
    expect(classifyPrimaryImageStanding(rows as never, PROVENANCE).convictedOnly).toBe(false);
  });

  it('one clean asset ends the search even beside a convicted one', () => {
    const standing = classifyPrimaryImageStanding(
      [convicted('tile-a'), clean('photo-b')] as never, PROVENANCE);
    expect(standing.convictedOnly).toBe(false);
  });
});

describe('a refused stage 1 is an ANSWER, and the ladder moves down', () => {
  it('a convicted image still owed a repair verdict waits — and only then', () => {
    // The repair has not run, so the question really is open.
    expect(nextImageStage([convicted('tile-a')] as never, settled)).toBe('wait');
  });

  it('a convicted image whose repair FAILED releases the ladder to stage 2', () => {
    /*
     * THE DEFECT. This used to answer `wait`, because the only test was "not
     * displayable" — which a measured refusal satisfies exactly as an
     * unmeasured image does. `wait` writes nothing and advances nothing, so
     * the property could never reach a paid stage however often it was
     * claimed. It is the one answer with no exit.
     */
    expect(nextImageStage([repairFailed(convicted('tile-a'))] as never, settled))
      .toBe('web_search');
  });

  it('an image never measured still waits — evidence that has not arrived', () => {
    expect(nextImageStage([builderImage('unmeasured')] as never, settled)).toBe('wait');
  });

  it('a verdict from a superseded version is not a verdict', () => {
    const stale = repairFailed(convicted('tile-a', {
      marketplace_eligibility_version: ELIGIBILITY - 1,
    }));
    expect(nextImageStage([stale] as never, settled)).toBe('wait');
  });

  it('a repair verdict bound to OTHER bytes does not close the question', () => {
    const image = convicted('tile-a');
    const mismatched = {
      ...image,
      source_detail: {
        ...image.source_detail,
        sanitization_failure: {
          sanitization_version: SANITIZATION,
          original_sha256: 'some-other-object',
          reason: 'no_region',
        },
      },
    };
    expect(nextImageStage([mismatched] as never, settled)).toBe('wait');
  });

  it('only when stage 1 is exhausted may stage 2 start, and then stage 3', () => {
    const exhausted = repairFailed(convicted('tile-a'));
    expect(nextImageStage([exhausted] as never, settled)).toBe('web_search');
    expect(nextImageStage([exhausted, ranAndFoundNothing('internet_search')] as never, settled))
      .toBe('street_view');
    expect(nextImageStage([
      exhausted, ranAndFoundNothing('internet_search'), ranAndFoundNothing('google_maps'),
    ] as never, settled)).toBe('none');
  });
});

describe('a skip is not evidence that a stage ran', () => {
  it('the skip rows written while stage 1 said YES do not block it saying NO', () => {
    /*
     * The exact production shape: a property that settled with a displayable
     * cover, both paid stages recorded as skipped, and the cover refused
     * afterwards. Every "is there a row for this stage?" test read the skips
     * as a ladder already climbed, so the card stayed blank with neither paid
     * stage ever asked.
     */
    const rows = [
      repairFailed(convicted('tile-a')),
      skipRow('internet_search'),
      skipRow('google_maps'),
    ];
    expect(nextImageStage(rows as never, settled)).toBe('web_search');
  });

  it('a skip written before the reference existed is recognised by its message', () => {
    const rows = [
      repairFailed(convicted('tile-a')),
      legacySkipRow('internet_search'),
      legacySkipRow('google_maps'),
    ];
    // Nothing has to be migrated for a property already in the table to
    // recover: the message the module itself writes is the recognition.
    expect(nextImageStage(rows as never, settled)).toBe('web_search');
  });

  it('a stage that RAN and found nothing is still counted as tried', () => {
    expect(stageWasAttempted(ranAndFoundNothing('internet_search') as never, 'internet_search'))
      .toBe(true);
    expect(stageWasAttempted(skipRow('internet_search') as never, 'internet_search'))
      .toBe(false);
    expect(stageWasAttempted(legacySkipRow('internet_search') as never, 'internet_search'))
      .toBe(false);
  });

  it('the skip carries its own reference, so the two are separable at the source', () => {
    expect(STAGE_SKIPPED_REFERENCE).not.toBe('stage-status');
  });
});

describe('two products on one lot never share a picture', () => {
  it('the same lot at two building sizes is two properties, and they differ', () => {
    const small = stockPropertyIdentity({
      address_line: 'Lot 90 - Sample Rise, Someplace VIC 3000 [3 Bed · 140 m²]',
      development_name: 'Sample Rise', building_size_sqm: '140.00',
      lot_number: null, unit_number: null, project_name: null, suburb: null,
      external_reference: null,
    } as never);
    const large = stockPropertyIdentity({
      address_line: 'Lot 90 - Sample Rise, Someplace VIC 3000 [4 Bed · 154 m²]',
      development_name: 'Sample Rise', building_size_sqm: '154.00',
      lot_number: null, unit_number: null, project_name: null, suburb: null,
      external_reference: null,
    } as never);

    // They are not the same property, so nothing may carry between them.
    expect(identityDifferences(small, large).length).toBeGreaterThan(0);
  });

  it('a candidate is attributed by the row that produced it, never by the lot', () => {
    /*
     * Each product carries its OWN package link, so the two are read
     * separately and a photograph found in one is stored against the property
     * whose row supplied the link. Nothing in the ladder reads another
     * property's rows: every function here takes ONE property's images.
     */
    const smallRows = [clean('photo-for-140')];
    const largeRows = [repairFailed(convicted('tile-for-154'))];

    expect(nextImageStage(smallRows as never, settled)).toBe('none');
    // The large product is NOT rescued by the small one's photograph.
    expect(nextImageStage(largeRows as never, settled)).toBe('web_search');
  });
});

describe('a settled property that loses its picture is not settled', () => {
  it('the re-open is driven by the ladder, never by a name or an id', () => {
    const source = readSource('supabase/functions/_shared/builderStock/primaryImage.ts');
    // Only where the ladder itself says there is somewhere left to go.
    expect(source).toContain("if (item?.image_work_stage === 'settled')");
    expect(source).toContain("nextImageStage(rows, { sourceSettlementComplete: true })");
    expect(source).toContain("remaining !== 'none'");
    // A pending verdict goes back to the stage that writes one, not to the
    // paid ladder.
    expect(source).toContain("remaining === 'wait' ? 'eligibility' : 'fallback'");
    // And it is claimable now rather than serving out a stale backoff.
    expect(source).toContain('image_work_next_attempt_at');
  });

  it('a property that still has a picture is never re-opened', () => {
    const source = readSource('supabase/functions/_shared/builderStock/primaryImage.ts');
    // Every stage field is written inside the `!primary` branch and nowhere
    // else, so a property that resolved a picture keeps the stage it had.
    const branch = source.slice(source.indexOf('if (!primary) {'),
      source.indexOf("await db.from('builder_stock_items')\n    .update(patch)"));
    for (const field of ['image_work_stage', 'image_work_next_attempt_at', 'image_work_claim_until']) {
      expect(branch).toContain(`patch.${field}`);
      // Assigned once, and only there.
      expect(source.split(`patch.${field} =`)).toHaveLength(2);
    }
  });
});

function readSource(relative: string): string {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { resolve } = require('node:path') as typeof import('node:path');
  return readFileSync(resolve(__dirname, '../../../', relative), 'utf8');
}
