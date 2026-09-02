/**
 * BUILDER STOCK — "HAVE WE FINISHED LOOKING AT WHAT THE BUILDER SUPPLIED?"
 *
 * ONE AUTHORITATIVE ANSWER, ASKED BEFORE THE ONLINE FALLBACK MAY SPEND
 * ANYTHING. The stock list is the source of truth: the builder has usually
 * already handed the marketing material over, as a hyperlink behind the word
 * `Brochure`, as a Dropbox package, as a Drive folder, as a direct image. The
 * external search ladder exists for the rows where they genuinely have not,
 * and it may only run once that is a FACT rather than a guess.
 *
 *
 * WHAT WAS WRONG, AND WHY IT WAS INVISIBLE.
 *
 * The gate used to be the STAGE ORDER alone — `source` runs before `fallback`,
 * therefore source is finished. That is a statement about the scheduler, not
 * about the evidence. `settleClaimedItem` advanced a property the moment its
 * source run RETURNED, whatever the run had actually learned, so a property
 * whose brochure had never been opened reached the ladder exactly like one
 * whose brochure had been read cover to cover.
 *
 * Underneath it, a second and worse collapse: this repository has exactly one
 * negative result, `no_deterministic_image`, and THREE different things wrote
 * it.
 *
 *   1  We opened the document, read it, and it names no image for this
 *      property. That is knowledge.
 *
 *   2  This package destroyed the worker twice — `CPU Time exceeded`,
 *      `Memory limit exceeded` — so it was retired. See
 *      `recordPackageUnprocessable`.
 *
 *   3  This link answered six times with nothing we could read — a 404, a
 *      sign-in wall, a scan with no text layer. See
 *      `recordPackageUnreachable`.
 *
 * Only the first is a fact about the property. The other two are facts about
 * US, and both were being recorded in the same word — so a builder's brochure
 * that was too big to open read, downstream, as a builder who supplied
 * nothing, and the ladder went looking for the house on the open internet.
 *
 * MEASURED, 2 SEPTEMBER 2026, the live Luxton list. Lot 516 (10.6 MB) and Lot
 * 6706 (13.2 MB) both sat at `attempts: 2` — one tick from being retired as
 * "no image" — while their brochures state the lot, the street, the price and
 * the land size in AcroForm fields, and both extract in under 400 ms once the
 * decode is scoped. Lot 818's brochure had been refused before it was ever
 * fetched (the old Drive-only front door), the ladder ran, and the card was
 * given a render from a page titled `lot-118-by-simonds-homes` — a different
 * lot, by a different builder.
 *
 *
 * THE RULE: TIMEOUT IS NOT EXHAUSTION.
 *
 * A worker kill, an HTTP 5xx, a rate limit, a redirect that never resolved, a
 * database read that failed — none of them is "we looked and there was
 * nothing". They are `retryable_failure`, the ladder stays shut, and the card
 * stays BLANK with a reason an engineer can read. A correct blank beats a
 * plausible photograph of somebody else's house, and that asymmetry is the
 * whole posture of this subsystem.
 *
 * WHAT STOPS IT PINNING A PROPERTY FOR EVER is not this module — it is the
 * attempt budgets that run before retirement (`MAX_PACKAGE_ATTEMPTS`,
 * `MAX_UNREACHABLE_ATTEMPTS`) and the provenance VERSION, which is keyed into
 * every branch record. A reader that grows a new capability ships a version
 * bump, every operational retirement at the old version stops standing, and
 * the question is asked again from zero. That is the designed way out, and it
 * is the only one: nothing here may be repaired by editing a row.
 *
 * Pure: no IO, no clock, no network.
 */
import {
  NO_DETERMINISTIC_IMAGE, type ProvenanceQuestion,
} from './negativeProvenance.pure.ts';
import {
  MAX_PACKAGE_ATTEMPTS, PACKAGE_RECOVERY_ATTEMPT,
} from './packageAttempt.pure.ts';
import {
  branchQuestion, branchRecord, isTraversableBranch, type RowSourceBranch,
} from './sourceBranches.pure.ts';

/**
 * WHY A BRANCH IS FINISHED — the distinction the single verdict word lost.
 *
 * `inspected` is a statement about the DOCUMENT: we opened it and it names no
 * image for this property. `operational` is a statement about US: we could not
 * open it, or opening it destroyed the worker.
 */
export type EvidenceExhaustion = 'inspected' | 'operational';

/**
 * How far this property's supplied evidence has got.
 *
 * `no_evidence` is deliberately its own reading rather than a flavour of
 * `exhausted`: "the builder supplied nothing to look at" and "we looked at
 * everything the builder supplied" are different sentences to an operator,
 * they arise from different defects, and only the second is ever surprising.
 * Both admit the ladder.
 */
export type SuppliedEvidenceState =
  /** The row names no source this pipeline can traverse. */
  | 'no_evidence'
  /** Sources exist and at least one has never been opened. */
  | 'pending'
  /** An attempt is in flight — the claim is written and has not returned. */
  | 'processing'
  /** A builder-supplied image has been accepted for this property. */
  | 'found'
  /** Every source was OPENED and READ, and none names an image for this row. */
  | 'exhausted'
  /** At least one source ended on a fault of ours rather than an answer. */
  | 'retryable_failure';

export interface SuppliedEvidenceReading {
  state: SuppliedEvidenceState;
  /** Every traversable source this row names. */
  total: number;
  /** Those successfully opened and read, which named nothing for this row. */
  inspected: number;
  /** Those retired on a fault of ours. Never counted as exhaustion. */
  operational: number;
  /** Those still owed a look. */
  open: number;
  /**
   * Safe to log and to store on the row: why the state is what it is. Never a
   * stack, never a credential, never a signed URL.
   */
  detail: string;
}

export interface SuppliedEvidenceInput {
  /** Every traversable source the row names, from `rowSourceBranches`. */
  branches: readonly RowSourceBranch[];
  /** The property's `source_provenance_result`, whatever shape it holds. */
  stored: unknown;
  provenanceVersion: number;
  sourceAnchor: string | null;
  /**
   * Whether a builder-supplied image has already been accepted for this
   * property. Passed in rather than derived, because "is there a picture" is a
   * question about `builder_stock_item_images` and this module reads no rows.
   */
  builderImageAccepted?: boolean;
}

/**
 * How one branch's stored record classifies.
 *
 * ANYTHING UNRECOGNISED IS `open`, NOT FINISHED. A record from a different
 * question — another provenance version, another anchor — answers something
 * else and says nothing about this one; a record whose shape this does not
 * know is a record this code may not interpret. Both mean "ask again", which
 * costs a fetch. The opposite mistake costs a client a photograph of the
 * wrong house.
 */
export function classifyBranchRecord(
  stored: unknown,
  branch: RowSourceBranch,
  question: ProvenanceQuestion,
): 'open' | 'in_flight' | EvidenceExhaustion {
  /*
   * A BRANCH NOTHING CAN TRAVERSE IS INSPECTED, NOT FAILED — and that is a
   * judgement about the URL, reached without a fetch and without a clock. It
   * cannot become true or false while the code stands still, so it is exactly
   * as final as a document we read: what changes it is a reader that learns
   * the format, which ships as a provenance bump and reopens it.
   */
  if (!isTraversableBranch(branch)) return 'inspected';

  const record = branchRecord(stored, branch.url) as Record<string, unknown> | null;
  if (!record) return 'open';
  if (Number(record.provenance_version) !== question.provenanceVersion) return 'open';
  if ((record.source_anchor ?? null) !== (question.sourceAnchor ?? null)) return 'open';

  if (record.result === NO_DETERMINISTIC_IMAGE) {
    /*
     * THE DISCRIMINATOR, AND WHY AN ABSENT ONE IS `operational`.
     *
     * Records written before this field existed cannot say which of the three
     * writers produced them, and the safe reading of "we do not know" is the
     * one that keeps the ladder shut. It is not a cliff: `PROVENANCE_VERSION`
     * rises in the same change, so no legacy record is being asked this
     * question in the first place — the field is checked for the record a
     * ROLLBACK would leave behind, and for that record a blank card that
     * re-reads is the right outcome.
     */
    return record.exhaustion === 'inspected' ? 'inspected' : 'operational';
  }

  if (record.result === PACKAGE_RECOVERY_ATTEMPT) {
    /*
     * A SURVIVING ATTEMPT IS A KILLED WORKER — the claim is written before the
     * spend and overwritten by every path that returns, so its presence means
     * the step did not come back. Under budget it is still in flight; past the
     * budget the branch is retired and the retirement is OURS, never the
     * document's.
     */
    return Number(record.attempts ?? 0) >= MAX_PACKAGE_ATTEMPTS ? 'operational' : 'in_flight';
  }

  return 'open';
}

/**
 * The authoritative reading for one property.
 *
 * ORDER MATTERS AND IS DELIBERATE. A found image settles the question before
 * anything else is counted — the builder's own picture is on the card and no
 * ladder may be bought against it. Then "there was nothing to look at". Then
 * anything still owed a look, because one unfinished branch is enough to
 * refuse. Only with every branch finished does the reason they finished decide
 * between `exhausted` and `retryable_failure`, and a SINGLE operational
 * failure is enough to withhold the ladder however many of its siblings were
 * read properly.
 */
export function readSuppliedEvidence(
  input: SuppliedEvidenceInput,
): SuppliedEvidenceReading {
  if (input.builderImageAccepted) {
    return {
      state: 'found', total: input.branches.length,
      inspected: 0, operational: 0, open: 0,
      detail: 'the builder\'s own picture is on this card',
    };
  }

  const branches = input.branches ?? [];
  if (!branches.length) {
    return {
      state: 'no_evidence', total: 0, inspected: 0, operational: 0, open: 0,
      detail: 'this row names no source this pipeline can open',
    };
  }

  let inspected = 0;
  let operational = 0;
  let open = 0;
  let inFlight = 0;
  const failing: string[] = [];

  for (const branch of branches) {
    const verdict = classifyBranchRecord(
      input.stored, branch,
      branchQuestion(branch, input.provenanceVersion, input.sourceAnchor));
    if (verdict === 'inspected') inspected += 1;
    else if (verdict === 'operational') { operational += 1; failing.push(branch.column); }
    else if (verdict === 'in_flight') inFlight += 1;
    else open += 1;
  }

  if (open) {
    return {
      state: 'pending', total: branches.length, inspected, operational, open,
      detail: `${open} of ${branches.length} builder sources have not been opened yet`,
    };
  }
  if (inFlight) {
    return {
      state: 'processing', total: branches.length, inspected, operational, open,
      detail: `${inFlight} of ${branches.length} builder sources are being read`,
    };
  }
  if (operational) {
    return {
      state: 'retryable_failure', total: branches.length, inspected, operational, open,
      detail: `${operational} of ${branches.length} builder sources could not be read `
        + `(${[...new Set(failing)].join(', ').slice(0, 120)}); this is a fault on our side, `
        + 'not a document that names no image',
    };
  }
  return {
    state: 'exhausted', total: branches.length, inspected, operational, open,
    detail: `all ${branches.length} builder sources were read and none names an image `
      + 'for this property',
  };
}

/**
 * MAY THIS PROPERTY ENTER THE ONLINE FALLBACK LADDER?
 *
 * The one predicate, so no caller can hold a different opinion. Three states
 * withhold it and they are the point: `pending`, `processing` and
 * `retryable_failure` are all "we have not finished with what the builder
 * supplied", and nothing external may be spent — or accepted — until we have.
 *
 * `found` is ADMITTED, deliberately. The ladder module is also the owner of
 * the bookkeeping for "this property already holds a displayable picture":
 * `nextImageStage` answers `none`, every paid stage records itself skipped
 * ("Skipped: the builder supplied an image for this property"), nothing is
 * fetched and nothing is bought, and the property's enrichment is marked
 * complete — which is what takes it OUT of the fallback queue. Withholding a
 * `found` property would leave that bookkeeping to a second implementation,
 * and a property parked in the queue for ever is how the cron never retires.
 */
export function fallbackMayRun(state: SuppliedEvidenceState): boolean {
  return state === 'exhausted' || state === 'no_evidence' || state === 'found';
}

/**
 * The whole reading in one line, for the row's `image_work_last_result` and
 * for a structured log.
 *
 * Deliberately short and deliberately free of anything sensitive: it is stored
 * on a column operators read, so it names columns and counts and never a URL,
 * a token or a signed address.
 */
export function describeSuppliedEvidence(reading: SuppliedEvidenceReading): string {
  return `supplied evidence ${reading.state}: ${reading.detail}`;
}
