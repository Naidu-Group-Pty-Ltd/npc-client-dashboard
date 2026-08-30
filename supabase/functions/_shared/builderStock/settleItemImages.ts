/**
 * Builder Stock — one claimed property, one stage, one invocation.
 *
 * WHAT THIS REPLACES. `settleUploadSourceImages` settles an UPLOAD: it re-reads
 * the source document, walks every active property `created_at` ascending under
 * per-run caps, and ends the whole run on the first cap it hits. The marker is
 * not written, so the next tick starts again from row 1. On 29 August that walk
 * had reached item 13 of 23 in twenty-six hours, and items 14 to 23 — Lot 13
 * Hummock Rise and Lot 1663 Ringer Street among them — had never been read once.
 *
 * Here the caller has CLAIMED exactly one property. Nobody else holds it and
 * nobody is queued behind it, so the four stages become a state machine on that
 * property alone:
 *
 *     source -> eligibility -> sanitization -> fallback -> settled
 *
 * SOURCE FIRST, because it is the stage that DISCOVERS images; the next two
 * judge and repair pictures it has already found. FALLBACK LAST, because
 * #2305's rule stands: the three-stage ladder may not be bought against a card
 * that is about to receive the builder's own photograph. That rule is now
 * enforced PER PROPERTY rather than per deployment, which is the point of
 * requirement 8 — this property's source is finished, so this property's ladder
 * may run, whatever some other property is still waiting on.
 *
 * A VERSION BUMP MUST RE-OPEN THE PROPERTIES IT AFFECTS, and nothing here can
 * do that for it. The upload markers this replaces went stale on their own when
 * a classifier version rose, and the sweep noticed; `image_work_stage` does
 * not — a property at `settled` is never claimed again. So a bump to
 * `MARKETPLACE_ELIGIBILITY_VERSION`, `SANITIZATION_VERSION` or
 * `PROVENANCE_VERSION` ships, as it already must, with a migration that raises
 * `builder_stock_settlement_target`, and that migration is now also the place
 * to send the affected properties back to the stage that has to re-run them.
 * The old path still exists and still reads the markers, so this is a
 * completeness rule rather than a cliff — but a bump that moves no stage will
 * simply not be re-applied by the per-item path.
 *
 * NOTHING HERE DECIDES ANYTHING ABOUT AN IMAGE. Source discovery, the Drive
 * rendition rule, web verification, the Street View distance guard, image
 * priority and the sanitizer are all called exactly as they were and are not
 * touched. This module is orchestration: which property, which stage, and what
 * to write down afterwards.
 */
import { repairSourceImagesForUpload } from './repairSourceImages.ts';
import { settleMarketplaceEligibility } from './settleMarketplaceEligibility.ts';
import {
  settleImageSanitization, type RepairBudget,
} from './settleImageSanitization.ts';
import { settleFallbackImages } from './settleFallbackImages.ts';
import { chooseAndStorePrimaryImage } from './primaryImage.ts';
import { repairStoredIdentity } from './storedIdentityRepair.pure.ts';
import { reverifyStoredWebImages } from './reverifyWebImages.ts';
import type { ClaimedItem, ItemWorkStage } from './itemWorkClaim.ts';

export interface ItemSettlement {
  itemId: string;
  stage: ItemWorkStage;
  /** Where the property goes next. Same stage means "not finished". */
  nextStage: ItemWorkStage;
  /**
   * The step DID something, even if it did not finish. Clears the attempt
   * count so a healthy resumable property does not walk its own backoff up to
   * the hour cap. See `completeItemWork`.
   */
  progressed: boolean;
  /** Safe to log and to store on the row. Never a stack. */
  result: string;
  error?: string;
  /** True when this settlement wrote or corrected the card's picture. */
  primarySet: boolean;
}

/** The order the stages run in. */
const NEXT_STAGE: Record<ItemWorkStage, ItemWorkStage> = {
  source: 'eligibility',
  eligibility: 'sanitization',
  sanitization: 'fallback',
  fallback: 'settled',
  settled: 'settled',
};

function readStage(value: unknown): ItemWorkStage {
  const stage = String(value ?? 'source');
  return (stage in NEXT_STAGE ? stage : 'source') as ItemWorkStage;
}

export interface ItemSettlementDeps {
  repairSource?: typeof repairSourceImagesForUpload;
  settleEligibility?: typeof settleMarketplaceEligibility;
  settleSanitization?: typeof settleImageSanitization;
  settleFallback?: typeof settleFallbackImages;
  choosePrimary?: typeof chooseAndStorePrimaryImage;
}

/**
 * Do this property's current stage, and say where it goes next.
 *
 * THE PRIMARY POINTER IS SETTLED AFTER EVERY STAGE, not at the end of the
 * ladder and not at the end of the upload. `chooseAndStorePrimaryImage` is
 * already idempotent and already decides from that property's own rows alone —
 * a pure total order over clean-original, evidence level, position and id — so
 * running it here cannot make the card flicker and cannot depend on which
 * property was processed first. That is requirement 9, and it is the difference
 * between a builder photograph appearing on the card the minute it is approved
 * and waiting, as seven properties did on 29 August, for an unrelated walk over
 * twenty-three properties to finish. Those seven held a `ready`,
 * `primary_property`, `eligible` builder photograph and a NULL pointer.
 */
export async function settleClaimedItem(
  db: any,
  item: ClaimedItem,
  input: { deadlineAt?: number; repairBudget?: RepairBudget } = {},
  deps: ItemSettlementDeps = {},
): Promise<ItemSettlement> {
  const stage = readStage(item.image_work_stage);
  const repairSource = deps.repairSource ?? repairSourceImagesForUpload;
  const settleEligibility = deps.settleEligibility ?? settleMarketplaceEligibility;
  const settleSanitization = deps.settleSanitization ?? settleImageSanitization;
  const settleFallback = deps.settleFallback ?? settleFallbackImages;
  const choosePrimary = deps.choosePrimary ?? chooseAndStorePrimaryImage;

  const settlement: ItemSettlement = {
    itemId: item.id, stage, nextStage: stage, progressed: false,
    result: 'nothing to do', primarySet: false,
  };

  /*
   * NAME THE PROPERTY BEFORE ASKING ANYONE TO PHOTOGRAPH IT.
   *
   * Stage 2 identifies a property and stage 3 geocodes it, and both are
   * refused outright without an `address_line` — so a property that was
   * imported before its identity could be resolved reaches the bottom of the
   * ladder and finds it has no rungs. Measured: 89 properties claimed, every
   * stage advanced, 3 addresses between them and not one photograph.
   *
   * Fixing the normaliser fixes the NEXT import; this is what recovers the
   * ones already written down, from the raw row every source stores on the
   * property. It only ever fills an empty field, it is idempotent, and it runs
   * inside the claim so it needs no scheduler of its own.
   */
  await ensureCanonicalIdentity(db, item.id);

  /*
   * AND THEN ASK AGAIN ABOUT THE PICTURES ALREADY FOUND FOR IT.
   *
   * In that order, and the order is the whole point: the step above may have
   * just recovered the locality that a candidate was refused for lacking. A
   * search result's verdict was written once, when it was found, against
   * whatever the property knew about itself at that moment — so an identity
   * that improves reaches every future search and none of the results already
   * in the table. It spends nothing; the evidence was stored beside each
   * candidate for exactly this.
   */
  await reverifyWebImagesFor(db, item.id);

  try {
    if (stage === 'source') {
      /*
       * A property with no upload has no source to re-read — it cannot be the
       * source stage's business, so it moves on rather than being retried for
       * ever against a document that does not exist.
       */
      if (!item.upload_id) {
        settlement.nextStage = NEXT_STAGE.source;
        settlement.result = 'no source document';
        settlement.progressed = true;
      } else {
        const repair = await repairSource(db, {
          organisationId: item.organisation_id,
          uploadId: item.upload_id,
          deadlineAt: input.deadlineAt,
          // The whole change. Identity is still resolved over every row of the
          // document; only the WORK belongs to this property.
          onlyItemId: item.id,
        });
        settlement.progressed = repair.imagesStored > 0
          || repair.matched > 0 || repair.demoted > 0 || repair.primaryUpdated > 0;
        settlement.result = `source: stored ${repair.imagesStored}, matched ${repair.matched}`;
        /*
         * `incomplete` means this property's source work has more to do — a
         * package it declined to open on the remaining budget, say. It stays
         * on `source`, and because a claim that RETURNED reports progress
         * rather than silence, it is claimable again immediately rather than
         * backing off.
         *
         * A package that has exhausted MAX_PACKAGE_ATTEMPTS does NOT come back
         * here: `repairSourceImages` writes it the terminal
         * `no_deterministic_image` verdict itself and the run reports complete,
         * so the property moves to the next stage and reaches its own fallback
         * ladder. That counter is the package's, is written before the
         * download begins, and is untouched by anything in this module.
         */
        settlement.nextStage = repair.incomplete ? 'source' : NEXT_STAGE.source;
      }
    } else if (stage === 'eligibility') {
      const eligibility = await settleEligibility(db, item.organisation_id, {
        deadlineAt: input.deadlineAt, stockItemId: item.id,
      });
      settlement.progressed = eligibility.assessed > 0 || eligibility.scanned > 0;
      settlement.result = `eligibility: assessed ${eligibility.assessed} of ${eligibility.scanned}`;
      settlement.nextStage = eligibility.incomplete ? 'eligibility' : NEXT_STAGE.eligibility;
    } else if (stage === 'sanitization') {
      const sanitization = await settleSanitization(db, item.organisation_id, {
        deadlineAt: input.deadlineAt, stockItemId: item.id, budget: input.repairBudget,
      });
      settlement.progressed = sanitization.repaired > 0
        || sanitization.cleared > 0 || sanitization.scanned > 0;
      settlement.result = `sanitization: repaired ${sanitization.repaired}, `
        + `cleared ${sanitization.cleared}`;
      settlement.nextStage = sanitization.incomplete ? 'sanitization' : NEXT_STAGE.sanitization;
    } else if (stage === 'fallback') {
      const fallback = await settleFallback(db, {
        limit: 1, deadlineAt: input.deadlineAt, stockItemId: item.id,
      });
      settlement.progressed = fallback.attempted > 0;
      settlement.result = `fallback: attempted ${fallback.attempted}, `
        + `resolved ${fallback.resolved}`;
      /*
       * The ladder is climbed one rung per claim. `remaining` counts THIS
       * property's outstanding rungs, so a property still owed a stage comes
       * straight back rather than being declared settled with a blank card.
       */
      settlement.nextStage = fallback.remaining > 0 ? 'fallback' : NEXT_STAGE.fallback;
    }
  } catch (error) {
    /*
     * A failed stage is reported and left where it is. The claim's own backoff
     * decides when it is tried again, and the message is stored on the row so
     * an operator can see WHY a property is not progressing — which is the
     * thing the upload-level markers could never say about a single card.
     */
    settlement.error = String((error as { message?: string })?.message ?? error).slice(0, 400);
    settlement.result = `${stage} failed`;
    settlement.nextStage = stage;
    settlement.progressed = false;
  }

  /*
   * AND THE CARD'S PICTURE, WHATEVER THE STAGE DID — including a stage that
   * failed. The pointer is decided from rows already in the table, so a
   * photograph approved by an earlier tick must not stay unpointed because a
   * later stage threw.
   */
  try {
    const primary = await choosePrimary(db, item.id);
    settlement.primarySet = !!primary;
  } catch {
    // Never fatal. The pointer is settled again on the next claim, and by the
    // organisation-wide enforcement the old path still runs.
  }

  return settlement;
}


/**
 * Fill a stored property's canonical identity from its own source row.
 *
 * Reads the record the import persisted, maps the columns it could not place
 * through the CURRENT alias table, and writes back only what is still empty.
 * A property whose identity is already complete costs one indexed read and
 * writes nothing.
 */
async function ensureCanonicalIdentity(db: any, itemId: string): Promise<void> {
  // BEST EFFORT, ALWAYS. This enriches the inputs a later stage uses; it is
  // never the work itself, so anything it cannot do leaves the stage running
  // exactly as it did before. A caller whose client cannot answer this read at
  // all — a narrower double, a deployment mid-migration — simply skips it.
  if (typeof db?.from !== 'function') return;
  try {
    await repairCanonicalIdentity(db, itemId);
  } catch (error) {
    console.warn('[builderStock] canonical identity could not be repaired', {
      phase: 'identity_repair', stock_item_id: itemId,
      detail: String((error as { message?: string })?.message ?? error).slice(0, 200),
    });
  }
}

async function repairCanonicalIdentity(db: any, itemId: string): Promise<void> {
  const { data: row } = await db
    .from('builder_stock_items')
    .select('id, address_line, suburb, state, postcode, lot_number, unit_number, '
      + 'development_name, project_name, source_row')
    .eq('id', itemId)
    .maybeSingle();
  /*
   * NO SHORT CIRCUIT ON `address_line`. A record that HAS a street address can
   * still be missing the locality beside it, and `geocodableAddress` needs two
   * parts — so an early return here would leave exactly the properties whose
   * address is real but unqualified unfindable. `repairStoredIdentity` already
   * refuses to write over any field the import resolved, which is the guard
   * that actually matters.
   */
  if (!row) return;

  const { patch, recovered } = repairStoredIdentity(
    row as never, row.source_row as never);
  if (!recovered.length) return;

  const { error } = await db.from('builder_stock_items').update(patch).eq('id', itemId);
  if (error) {
    // Not fatal: the stage below simply runs with what the property already
    // had, exactly as it did before. Saying so is what makes it findable.
    console.warn('[builderStock] canonical identity could not be written', {
      phase: 'identity_repair', stock_item_id: itemId, recovered,
      detail: (error as { message?: string }).message ?? 'unknown',
    });
  }
}


/**
 * Re-ask the identity question for this property's stored web candidates.
 *
 * Reads the property's identity as it now stands and hands it to the one
 * module that decides. Best effort throughout: this improves what a later step
 * may rank and is never the stage's own work.
 */
async function reverifyWebImagesFor(db: any, itemId: string): Promise<void> {
  if (typeof db?.from !== 'function') return;
  try {
    const { data: row } = await db
      .from('builder_stock_items')
      .select('id, organisation_id, address_line, suburb, state, postcode, '
        + 'lot_number, unit_number, development_name, project_name')
      .eq('id', itemId)
      .maybeSingle();
    if (!row) return;

    /*
     * The builder's trading name, read from the property's OWN organisation.
     * A name supplied from anywhere else would verify one builder's picture
     * against another's identity.
     */
    let builderName: string | null = null;
    try {
      const { data: org } = await db
        .from('builder_organisations')
        .select('trading_name, legal_name')
        .eq('id', row.organisation_id)
        .maybeSingle();
      const named = (org ?? {}) as { trading_name?: string; legal_name?: string };
      builderName = named.trading_name || named.legal_name || null;
    } catch {
      // A name we could not read is one the check does without.
    }

    await reverifyStoredWebImages(db, itemId, {
      addressLine: row.address_line,
      lotNumber: row.lot_number,
      unitNumber: row.unit_number,
      developmentName: row.development_name,
      projectName: row.project_name,
      suburb: row.suburb,
      state: row.state,
      postcode: row.postcode,
      builderName,
    });
  } catch (error) {
    console.warn('[builderStock] stored web candidates could not be re-judged', {
      phase: 'web_identity_reverify', stock_item_id: itemId,
      detail: String((error as { message?: string })?.message ?? error).slice(0, 200),
    });
  }
}
