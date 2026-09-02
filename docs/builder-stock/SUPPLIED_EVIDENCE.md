# Supplied evidence — the gate in front of the online fallback

Read this before touching `suppliedEvidence.pure.ts`, the fallback stage in
`settleItemImages.ts`, the gate in `settleFallbackImages.ts`,
`negativeProvenance.pure.ts`, `packageAttempt.pure.ts`, or
`PROVENANCE_VERSION` (`provenanceVersion.pure.ts`).

## The rule

**The stock list is the source of truth.** A builder usually hands the
marketing material over inside it — a hyperlink behind the word `Brochure`, a
Dropbox package, a Drive folder, a direct image. The external search ladder
(`internet_search`, `google_maps`) exists for the rows where they genuinely
have not, and it may only run once that is a **fact**:

```
UPLOAD → discover every supplied source (rowSourceBranches over the stored row)
       → open and read each one, bounded, with the claim written BEFORE the spend
       → accept a builder image, or record WHY none came of a source
       → only when every source was INSPECTED and named nothing:
             the online fallback may run
       → and it may only accept an image the page pins to the EXACT property
       → otherwise: BLANK, with the reason on the row
```

## The state, and who answers it

`readSuppliedEvidence` (pure) is the one interpreter. Its inputs are the
row's own link columns (`source_row.unmapped`, overlaid with
`recovered_link_columns` — pass **both** halves; `null` as the base silently
drops every link that never needed recovery) and the per-branch records in
`source_provenance_result`.

| state | meaning | ladder |
|---|---|---|
| `no_evidence` | the row names no source this pipeline can open | may run |
| `pending` | at least one source has never been opened | shut |
| `processing` | an attempt claim is standing (a recovery in flight, or a killed worker under budget) | shut |
| `found` | a builder-supplied image is accepted | enters, spends nothing¹ |
| `exhausted` | every source was **opened and read**, none names an image for this row | may run |
| `retryable_failure` | every source finished, at least one on a fault of OURS | **shut** |

¹ A success **clears its branch record**, so by the provenance column alone a
just-recovered property reads `pending` for ever — the accepted picture (one
indexed read of `builder_stock_item_images`) is what answers the question. A
`found` property is admitted because the ladder module owns the bookkeeping
for "picture already here": every paid stage records itself skipped, nothing
is fetched, and the enrichment is marked complete, which is what takes the
property out of the queue.

Enforcement is in `settleFallbackImages` — the one module that buys the
ladder — as a skip that spends nothing, counts as `withheld`, and logs a
structured `fallback withheld` line. Routing is in `settleItemImages`:
`pending`/`processing` go back to `source`; `retryable_failure` settles blank
(and leaves the ladder queue as `failed`). Both read the same pure function,
so they cannot disagree.

## A timeout is not exhaustion

`no_deterministic_image` used to be written by **three** different things, in
the same word: a document read that names nothing; a package that destroyed
the worker twice (`recordPackageUnprocessable`); a link that answered six
times with nothing readable (`recordPackageUnreachable`). Only the first is
knowledge about the property. The record now carries
`exhaustion: 'inspected' | 'operational'`, the argument is **required** (an
omitted flag must never mean the permissive reading — the same rule as the
router's `meterUsage`), and an absent field on a legacy record reads as
`operational`, because "we do not know" must keep the ladder shut.

Measured the day this was built (2 Sep 2026, the live Luxton list): Lot 516
(10.6 MB) and Lot 6706 (13.2 MB) sat at `attempts: 2` — one tick from being
retired as "no image" and handed to the ladder — while both brochures state
the lot, street, price and land size in AcroForm fields. Lot 818, whose
brochure had been refused *before it was ever fetched* by the old Drive-only
front door, had already been given a render taken from a page titled
`lot-118-by-simonds-homes` — another lot, by another builder, on a client's
card. That page passed the identity check because the *image filename* said
`lot-818`; the lot is now read from the **page** alone, and a page naming any
other lot is refused (`webImageIdentity.pure.ts`).

## What stops a retryable failure pinning a property for ever

Not this gate. The **attempt budgets** run first (`MAX_PACKAGE_ATTEMPTS` = 2
kills, `MAX_UNREACHABLE_ATTEMPTS` = 6 empty answers), and the claim is held
**until the recovered picture is durable** — it used to be released when the
recovery returned, and storing the 3000×1875 raster is where the worker
actually died, so Lot 824 cycled for eight one-hour backoffs holding exactly
`{"branches": {}}`: no attempt, no verdict, no image. A store that fails now
leaves the claim standing, so the next attempt counts.

Past its budget a branch retires as `operational`: the property **settles
blank**, with `supplied evidence retryable_failure: …` on
`image_work_last_result`, and the ladder never runs. The way back is the
designed one: **`PROVENANCE_VERSION`** is keyed into every branch record, so
a reader that grows a capability ships a bump (with a migration that requeues
the affected rows — see `20261104000000`) and every operational retirement
stops standing. Never a hand-edited row, never a hand-set pointer, never a
hand-scheduled cron job — the requeue trigger re-arms the engine itself.

## The heavy-document rule

Which page can be a property's cover is decided by **text**, which is already
in hand and costs nothing. `coverSearchPages` (a **superset** of every page
`assignPdfMediaRoles` could choose — that superset property is what makes the
scoping safe) tells `discoverPdfSourceAssets` which pages are worth decoding;
an empty answer means "no opinion" and the unscoped walk is unchanged.
Decoding twelve pages of 5334×3334 JPEGs before deciding anything is what was
killing the worker.

## The mutation test

`builderStockSuppliedEvidence.test.ts` was run against a deliberately
bypassed gate (`if (false && !fallbackMayRun(...))`): six tests failed — the
ladder ran for a pending brochure, a recovery in flight, a killed worker, and
a row whose links were its own, plus two source-level assertions — and all
went green when the gate was restored. If you change the gate, repeat that
experiment; a barrier test that passes without the barrier is worse than no
test.
