# What the page actually draws

**Read this before changing a declared block height, the verdict block, the
running head, `presentStoredMarkdown`, or `SAMPLE_REPORT_DATA`.**

Four defects, reported by the owner against one 36-page Investment Compass on
19 September 2026 — *"the layout, the overlapping, the headers to be clearer,
and duplication of information"*. Each of them passed every gate this
programme has, and they failed for the same reason in four different places:
**the thing that was checked was not the thing the page draws.**

| what shipped | what the gate measured instead |
| --- | --- |
| the verdict heading printed through the KPI band | a 35-character fixture verdict, in a real browser, on 510 renders |
| `Part 05 · Report` on 29 of 36 pages | the call site's *argument*, which 39 masters discard |
| a bracketed pointer into the prompt, mid-sentence | a rule in the prompt telling the model not to write one |
| the same chart drawn five times | the write path, which every stored report predates |

---

## 1. The verdict heading printed over the figures

### What it drew

Page 3 of the 42 Patya Circuit report, under the eyebrow "The verdict":

```
HOLD - Average investment with mixed indicators, monitor market
conditions. Assessed on 4 of 5 dimensions: capital growth, location,
rental yield and demand.
```

156 characters, set at 29pt. `$1,975,000` and `$850` in the KPI band beneath
were struck through by its last two lines.

### Why nothing stopped it

`verdict()` declared `Math.round(c.scale.verdict * 2.2 + c.scale.body * 4.6) + 18`.
At a heading leading of 1.1, `verdict * 2.2` is exactly **two lines** — and
that reservation was never measured against the sentence that fills it.

Measured across all fifty masters at this catalogue's own 0.52 display advance
— the ratio `sectionHeading` has used since it was measured, and the one
`fitToLines` sizes against:

| what `{{recommendation.headline}}` resolves to | length | masters past 2 lines |
| --- | ---: | ---: |
| `RECOMMENDATION_BY_GRADE`, unqualified | 59–89 | **27 of 50** |
| the claim alone, after `splitVerdictScope` | 59–99 | 33 of 50 |
| the whole qualified string, as shipped | 142–181 | **50 of 50** |

So this was wrong from the day the masters shipped. The appended coverage
sentence only made it universal.

**Three measurements, and they do not agree — say which one you mean.** The
table above is the 0.52 model, read deliberately WIDE so an unknown face packs
sparser rather than overflowing. It is what the sizing answers to, and it is an
upper bound rather than a count of collisions. Rendered in Chromium at the
production string with the fit removed, ONE master collides (§3). And the
document the owner reported overlapped visibly at print metrics, which is a
third measurement again. Sizing to the conservative model is what makes all
three safe.

`flow()` fixes the next block's `y` from the DECLARED height and the renderer
positions absolutely, so an overlong block does not push the page down and does
not overflow it. It lays over what comes next, and every arithmetic check in
the build passes.

### The bound is 99, not 89

`qualifyRecommendation` does not only append a sentence. It **rewrites** the
base one first — "across all metrics" becomes "across the metrics assessed",
"in most areas" becomes "in most of the areas assessed" — because a coverage
caveat beside "across all metrics" contradicts itself in one line. That
narrowing is right, and it takes the A+ claim from 89 characters to 99.

**Reading `RECOMMENDATION_BY_GRADE` is therefore not enough to know what the
page receives.** A block sized against that table is sized against a string the
product no longer prints. `verdictVocabulary.ts` walks the qualified forms —
8 grades × 31 coverages, de-duplicated to 16 distinct headlines — and
`VERDICT_HEADLINE_CHARS` is the longest of them, derived on every seed build
rather than typed.

### Why the type moves and the box does not

The dashboard page carries **15pt of slack above the footer on 49 of the 50
masters**. It is full. Growing the verdict block to fit four lines would push
the KPI band, the callout and the footer off the page on every one of them.

So the block keeps its footprint exactly — no other block moves, no page can
gain or lose one — and `fitToLines` picks the largest quarter-point size at
which `headingChars` still sets in the two lines the block declares. Designed
sizes were 11.5–34.25pt; fitted they are 11.5–19.5pt, and the **23 masters
already inside the model are byte-identical**.

Two rules in that primitive:

- **It never enlarges.** A slot whose vocabulary fits gets its designed size.
- **It steps down until `displayLines` agrees**, rather than trusting the
  closed form. At 481pt of measure and 50 characters a line the arithmetic is
  exact — `481 / (50 × 0.52) = 18.5` — but in binary `18.5 × 0.52` is
  `9.620000000000001`, `481 / 9.620000000000001` is `49.999999999999993`, and
  `Math.floor` takes it to 49. The closed form called a perfect fit one
  character short, on five of the fifty masters. **Deriving a size and then not
  checking it is the same mistake as declaring a height and not measuring it.**

`boundChars` throws when the heading is a binding and no length is declared,
for the reason it already gave for `sectionHeading`: a guessed default is the
silent mis-size the check exists to stop.

### The coverage sentence leaves the heading

`splitVerdictScope` cuts the appended sentence off at the boundary
`qualifyRecommendation` itself creates and publishes it as
`recommendation.scopeNote`. Nothing is dropped and nothing is truncated — and
the report already states the same fact one line below, because `gradedLine`
names the same dimensions in the body of the very same block.

The split is exact rather than a guess: it matches only the sentence that
appender writes, anchored at the end, and returns anything else whole.

---

## 2. Twenty-nine pages that said the same thing

v15 made the running head name the chapter rather than the part. It reached
**eleven of the fifty masters**.

`furniture()` branches on `navigation_style`. A **railed** family draws the
part as an eyebrow and the section beneath it. A **running-head** family draws
the part and **discards the section argument entirely**. So the chapter binding
was composed, published, passed in on all fifty — and drawn on eleven.

The body is ONE part, correctly; renumbering it would be wrong. What was
missing is that a reader thirty pages in had no way to tell the zoning chapter
from the transport one.

`furniture()` now takes an optional `headMarker`, read only by the running-head
branch. The Compass passes `Part NN · {{narrative.chapters.i}}` on its report
pages. The railed eleven, the Compass's own non-report pages and the other nine
formats' 450 masters pass nothing and are byte-identical.

The longest marker the product can compose is `'Part NN · '` plus
`CHAPTER_MAX_CHARS` (64) — anything longer is already the document-name
fallback. 74 characters, measured against the two lines `runningHead` reserves,
on all 39 running-head masters: the narrowest is Sovereign Folio at 6.5pt in
152pt, 38 characters a line, two lines.

### The test that could not see it

`runningChapters.spec.ts` asserted the call site contained
`furniture(DOCUMENT_LABEL, reportPart, '{{narrative.chapters.0}}')`. It did.
The argument is there and on 39 masters it goes nowhere. The call sites are
still checked there, because the railed half reads them; what a source string
cannot vouch for is now asserted against the **built** masters.

---

## 3. A fixture shorter than the product

This is the most useful finding of the four.

`templates:compass:qa` renders all 510 masters in a real Chromium, walks every
text node, takes its client rects and compares every box with every other. It
is a genuine overlap measure — exactly the gate defect #1 belongs to — and it
reported **"no block overflows its page, and none prints over another"** on
every run, while the shipped verdict was printing over the figures beneath it.

Swap the fixture for the longest publishable verdict, take the fit away, and
the same gate answers:

```
✖ 1 block(s) print over another:
  Bullion Rail / p3 "Executive dashboard": 3pt —
    "The verdict STRONG BUY - Excellent investmen"
    over "Purchase price $1,285,000 Contract, before c"
```

With the fit in place it is clean again — 510 renders, nothing over anything.
That before-and-after is the acceptance evidence for §1, and it exists only
because the fixture stopped being shorter than the product.

`SAMPLE_REPORT_DATA.recommendation.headline` read
`'Proceed to offer at or below $1.29m'`. **35 characters.** Every graded
production row carries one of the 59–99 character vocabulary sentences instead.

**A fixture shorter than what the product publishes turns a real measurement
into a statement about the fixture.** The sample now carries the longest
publishable verdict, so the existing 510-render measure catches this class for
every future change — which is a far stronger guarantee than any static
assertion about a number.

This is the same rule the catalogue already records one level up: *resolve
every bound path against a row taken verbatim from production, never against
`SAMPLE_REPORT_DATA`, which is written in the catalogue's own vocabulary and
passes while production is empty.* The sample is not only too *narrow*; where
it is used as the subject of a geometric measure it must also be the
**longest** thing that can land there.

---

## 4. Two things a stored document must not carry

Both are scrubs that existed and ran where they could not reach a document
already stored. Both now run in `presentStoredMarkdown`, the one read-path
scrub all four renderers apply — the same argument that already moved the
placeholder scrub and the chart-evidence contract there.

### The prompt, quoted back at the reader

The generator pins its planning and infrastructure evidence under four
headings that are INSTRUCTIONS: nobody reading the document has ever seen them.
The pinned block already carries a rule saying so in as many words. The
delivered suite carried the pointers anyway — nine of ten documents with at
least one, one Compass with nine, set mid-sentence:

> …must factor into rental and resale expectations.[Infrastructure section] The
> recorded 680 new dwellings…

`stripEditorialBlocks` wrote the lesson down one file over: the v2.0 prompt
said "at most one per section" twice and production carried ninety a report.
**An instruction is a request; this is the guarantee.**

It **substitutes rather than deletes**, because the claim behind the pointer is
sound — both tables are appended verbatim to the finished document under
*Planning controls and development registers*, so there is a real section to
send the reader to. Deleting the bracket would leave the sentence unsourced,
which is worse than an ugly sentence that is sourced. Where the sentence
already introduces the reference ("See …", "as set out in …"), only the section
is named, so nothing reads "see (see …)".

It is a closed set of four strings the prompt itself wrote. **Prose is never
regex-scrubbed**, and this cannot reach a sentence a model composed.

### The same chart, five times

`dedupeChartDirectives` has existed since Stage 4 and ran on the write path
alone — the post-processor, the fork and the condense. A document stored before
that wiring, or one whose repeats arrive after it, keeps every copy for ever,
and so does every child forked from it. On the reported Compass the identical
three-bar price chart was drawn on five pages and the planning controls table
on four.

The same implementation is imported rather than repeated, and it is a **no-op
on a document that carries each drawing once** — which is what makes adopting
it on the read path safe for everything already correct.

---

## Release

Shipped as seed **v16** (`20261207000000`) plus the active-master refresh
(`20261207010000`), which is identical in mechanism to v15's: a master is
replaced only where it is proven an unedited copy of what the library last
published, everything else is snapshotted and recorded as deferred.

## What is still outstanding

Two items from the same report are **not** closed here, because closing them
from a description rather than from the document would be guessing:

- **the clipped tail** — a note reading that a further ~25,800 characters are
  not shown; and
- **the repeated planning table and growth figures across sections**, beyond
  the identical-directive repeats §4 closes.

Both need measuring against a regenerated document rather than against a
recollection of the one that was reviewed. They are the next pass.
