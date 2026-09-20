# A premium document — what the 97 Poole Road Compass got wrong

Everything here was measured on one delivered PDF: the Investment Compass
issued for **97 Poole Road, Kellyville NSW 2155 on 20 September 2026**, 38
pages, read page by page and then measured mechanically out of the file
itself rather than from the source that produced it.

That distinction matters twice in this document. Reading the PDF by *font*
is what turned "too much bold" into 18.6%. And reading it by *wording* is
what proved that one of the reported defects was already fixed and the
document simply predated the deploy.

---

## 1. Emphasis — 18.6% of the body copy was bold

`supabase/functions/_shared/reports/investment/emphasisDensity.pure.ts`

Read out of the PDF by font:

```
body copy (Inter, 14 device px)   41,773 chars regular
                                   9,570 chars BOLD   = 18.6%
274 bold runs, median 26 chars, mean 35, longest 246
```

7.2 emphasised spans a page. A well-set document runs at one to three per
cent. The five longest spans were 160–246 characters each — a complete
sentence apiece, in bold, inside a paragraph of the same words.

Four structural rules take that document to **4.1% and 1.9 spans a page**:

| rule | what it catches | spans |
| --- | --- | ---: |
| clause | a span carrying its own comma, full stop or dashed aside, or running past `EMPHASIS_PHRASE_WORDS` | 71 |
| figure | a number with at most four words around it | 76 |
| repeat | the second and later emphasis in one paragraph | 45 |
| table | any emphasis inside a table cell | — |

**The phrase ceiling is derived, not chosen.** With the punctuation rule
alone applied, the surviving spans fall into two populations with a clean gap
between them: 80% at eight words or fewer, **not one at nine**, and every span
from ten words up carrying its own subject and verb.

**A run-in label is kept** — a phrase closed by a colon or full stop standing
in for a heading (`**Local government area:** The Hills Shire Council`). The
register lists depend on it, and it does not spend the paragraph's one
emphasis, so a labelled fact keeps its phrase too.

**This is not the prose regex-scrub `RUNTIME_CONSOLIDATION.md` §8 forbids.**
`**` is markup, not a word. Strip the markers from the input and the output
and they are byte-identical, and `emphasisDensity.spec.ts` asserts that rather
than promising it. If that assertion ever fails, the module has started
rewriting prose and must come out.

---

## 2. The glance strip — twelve boxes of dingbats

`supabase/functions/_shared/reports/glanceStrip.pure.ts`

`{{glance: …}}` drew a washed, left-ruled callout carrying raw `✓ ⚠ ◆ ★`.
`vizFigures.pure.ts`'s own header said why: *"a new `.glance-strip` rule would
be a new thing to style, test and keep in print contrast for no gain over a
callout."* A reasonable call about implementation cost and a wrong one about
the page — twelve of those boxes reached this document, three on page 28 and
three more on page 29.

Three things were wrong and none of them was the content.

**A dingbat is not a category.** The glyph carried the whole meaning — good,
watch, fact, bottom line — in a way that survives neither greyscale, nor a
screen reader, nor a reader who has not been told the key. `★` against `◆` is
a distinction nobody can look up.

**A wash and a rule say "separate object."** Border, fill and rule are the
expensive signals in print, and this block spent all three on a summary of the
prose directly beneath it.

**The findings did not align.** Each item started where the previous glyph
ended, so four findings sat on four different left edges inside one box.

It is a ruled key now — hairlines above and below, no ground, no left bar, the
meaning set as a **word** in a fixed column so every finding hangs on one axis.
Rendered against the real stylesheet in Chromium it is calmer and 17% shorter.

Three rules hold it. **The meaning is a word and the colour is second**, so it
reads in greyscale and out loud. **The glyph never reaches the page** — it is
an input vocabulary, `glanceTone` is the one place that mapping lives, it is
generous on each side, and an unrecognised marker is `context` rather than a
dropped finding. **It stays a `<ul>` of `<li>`**, because `render-template-pdf`
asks WeasyPrint for `pdf/ua-1` and the structure tree is built from element
names.

---

## 3. The running head said `Part 07` twenty-six times

`scripts/template-library/investmentCompass/templates.ts`

v16 fixed the half of the running head that was **discarded** and left the half
that was **repeated**. It passed `Part NN · {{narrative.chapters.i}}`, so this
document carried `Part 07 · <chapter>` on twenty-six consecutive pages: true —
the body is one part — and saying nothing twenty-six times over.

A running head exists to say where the reader is. Across a single part the part
number does not; the chapter does. The part structure is on the contents page,
which is where it varies. The marker is the chapter alone.

**The ten characters that frees are not a line.** The marker sits in 34% of the
measure, about 43 characters, against `CHAPTER_MAX_CHARS` of 64 — so the worst
case still takes both lines the rule reserves. What it buys, measured on the
twelve chapters this report actually produced: **three wrapped** to a second
ragged right-aligned line with the prefix, **one wraps** without it.

The railed eleven masters are untouched and stay right: there the part is an
eyebrow *above* the chapter rather than a prefix beside it, so the repetition is
subordinate by construction and carries the orientation for free.

Shipped as seed **v17** plus the active-master refresh. Proven by the
migration's own bytes: **0** markers still carry `Part NN · <chapter>`, 2,000
carry the chapter alone, 1,507 rail markers untouched.

---

## 4. Eight drawings, two datasets

`supabase/functions/_shared/reports/investment/blockHygiene.pure.ts`

`directiveKey` normalised the **whole** directive, so a caption was enough to
make a repeat look new to the pass that exists to stop repeats. The identical
three bars

```
Other offences 22 | Robbery 16 | Arson 9
```

were drawn on pages 20, 23, 24 **and** 25 under four different titles, and
`$1,650,000 / $1,808,000 / $1,110,000` on pages 21, 29 and 31 under three more.
Eight drawings, two datasets, and the de-duplicator saw seven distinct charts.

**The data is the chart; a caption is what a section calls it.** `title` and
`caption` leave the key and nothing else does — a directive differing in a
digit, a label, a unit or a maximum is still a different chart, because each of
those changes what a reader takes from it.

---

## 5. More than one unit on one track

`supabase/functions/_shared/reports/investment/chartUnits.pure.ts`

Page 13 plotted `99.1%`, `100%` and `~2.1 km` together, so 2.1 kilometres drew
as a 2% sliver of a percentage axis. Page 28 plotted `241` new dwellings
against `$163,527,942`, so the count drew as a hairline.

Both are correct arithmetic and neither says anything. A bar's length is the
only thing a bar chart says, and it says it by putting every value on one
track; a reader takes "short bar" as "small quantity" because that is the only
reading the form admits.

`chartScale.pure.ts` already keeps one scale per unit **across** a document.
This is the defect one level down — two units **inside** one chart, where no
choice of maximum can help.

**A chart of more than one unit is not drawn; it is set as the table its data
already is.** Nothing is dropped: every label, every value and their order
survive, and the title becomes a caption rather than a heading so the
document's own outline and contents page are untouched. It does not unify
(converting km to m so the axis agrees would invent a comparison the writer did
not make), it does not guess, and it never touches a single-unit chart — which
is every chart in a document that was already right.

---

## 6. A column that says the same thing on every row

`foldConstantTableColumns` in
`supabase/functions/_shared/reports/investment/derivedHygiene.pure.ts`

Page 34 ran its nine-column infrastructure register off the right page edge:
the header cut to `Deliver / timing` and every cell under it to
`Not / publish / by this / registe`.

Two of those nine columns held one identical value on all five rows —
`Not stated — the figure is the applicant's own cost of development` and
`Not published by this register` — repeated down the page, carrying nothing per
row, and costing the measure the width that then guillotined the table.

**A column whose every cell is identical is a footnote, not a column.** Stated
once below the table, verbatim, never abbreviated. Three bounds keep it off a
table that was already right: only a table of `CONSTANT_COLUMN_MIN_WIDTH` (6)
columns or more, only with `CONSTANT_COLUMN_MIN_ROWS` (3) body rows or more,
never the first column, and never below two columns.

---

## 7. Demand 13, from one demographic drift reading

`supabase/functions/_shared/reports/market/demandScoring.pure.ts`

The report published Grade C, **48 out of 100**. Every figure reproduces
exactly from the record:

```
Growth   56 × 42.1%  = 23.58
Location 64 × 26.3%  = 16.84
Yield    32 × 15.8%  =  5.05     3.467% gross, $1,100/wk over $1,650,000
Demand   13 × 15.8%  =  2.05     ← ABS ERP 17,911 → 17,584, −0.368%/yr
                       ------
                        47.53 → 48
```

Demand's 13 is `interpolate(−0.368, POPULATION_ANCHORS)` = 12.64, and the
population driver was the **only** component that reached the scorer.
`scoreDemand` renormalises over what was measured, so a weight of 0.15 divided
by a coverage of 0.15 is **1.00** — and the module's own header had forbidden
that since it was written: *"It carries 0.15, so it can inform a Demand score
and cannot carry one."*

A rule stated in a comment that the arithmetic did not enforce. The class this
repository keeps paying for.

### A dimension is scored only where something measured it directly

`DEMAND_PRIMARY` names the four components that may carry it. A driver is a
reason to *expect* demand, not an observation of it, and no renormalisation
turns one into the other. Nothing but drivers now yields `null` and a named
`missing` list. The reading is not discarded — it stays in `components`, it
still carries its own 0.15 wherever a primary measure is present, and a report
may still print it as evidence.

### And the primary measure the register was already publishing

Every other primary component comes from a vendor feed nobody here is entitled
to. The open sales register prints a transaction **count** beside every median
it prints, and until now only the latest row's count was read — as a confidence
sample size, never as a measurement.

`salesVolumeSeries` carries those counts and `scoreTransactionVolume` measures
the latest period against this market's own trailing mean: a ratio, not a
count, because 162 sales means nothing without knowing whether this postcode
usually does 90 or 300. 1.0 scores 50 for the same reason 3.0% vacancy does — a
market transacting at exactly its own recent rate is in balance with itself.
Three prior periods minimum, because a mean of two moves further on one unusual
period than the reading it is meant to judge.

### What this is not

**Yield's 32 is correct and is untouched.** 3.467% gross against a corpus
median of 4.36% is what this property is; re-anchoring to raise it would raise
every yield in the book, which `SCORE_CRITERIA_AND_CALIBRATION.md` §5 and
S5/S6 §4 forbid by name. Growth and Location are untouched.

**Risk still cannot score.** Hazard and planning are one independent category,
`MINIMUM_INDEPENDENT_CATEGORIES` is 2, and the only other category a house
offers needs a construction year held on 0 of 1,230 stored reports. Four of
five scored remains the honest maximum until an acquisition lands.

### The honest tail

Withholding Demand redistributes its weight across three dimensions whose
weighted mean is 54, so a measured Demand only lifts the composite above that:
a balance-point 50 gives **53**, and it takes about **57** to break even.

**The change is a correction, not a lift.** What it buys is a number that means
something — 48 was a demographic drift reading wearing a demand label.

---

## 8. What was already fixed, and what is still open

### Already fixed — the PDF predated the deploy

Page 36 read *"A further 41,431 characters of this answer are not shown. The
complete text is in the Markdown export."* Both halves of that wording are
Report Q&A's, and `REPORT_BODY_RENDER` has set `truncationSubject: 'report'`
with an empty destination since PR #2715 merged at 05:41 AEST on 20 Sep 2026.

Proven by execution rather than inferred: at the old 65,536 bound the notice
draws with **the exact wording the delivered PDF carries**; at the current
131,072 a body of that size draws whole with **no notice at all**. The report
was generated before that deploy reached production.

### Still open

Read page by page and not yet acted on:

* **Citation markers** — page 21 prints `.12` where markers 1 and 2 run
  together and page 22 prints `23` three times; the Notes list on page 36 has
  four entries. Page 25 reads `sofuture`, a space eaten where a marker was
  stripped. **The bare-digit half of this is closed in §9**; the `sofuture`
  space and the page-36 Notes count are not, and are still open.
* **Page 27** ends a sentence mid-phrase: *"the land is zoned R2 – Low Density
  Residential, which is intended"*.
* **Pages 19 and 31** draw a planning-read callout with a large empty area and a
  lone green horizontal bar.
* **Page 21** draws a red zigzag sparkline mid-sentence, described in the
  sentence as *"a gradually rising line"*, in a colour that appears nowhere else
  in the document.
* **Page 22**'s *"Local vs NSW house price growth"* area chart has one series
  where the title promises two. Measured from the PDF's text positions, the
  drawing occupies **180 units between `top=530` and `top=710` and contains
  zero text nodes** — not one axis tick, value label or legend entry, so a
  reader can take no number off it at all. Both figures the title compares are
  in the document's own prose (6.3% on p21, 4.4% on p22), so the data existed
  and the drawing did not use it. The shape of the fix is `chartUnits`': a
  chart that cannot show what its title claims is set as the table its data
  already is. What is NOT established is whether the single series is the
  directive's or the primitive's — that needs the stored directive, which this
  branch has not read.

## 9. A register is printed once, where the register is

Three tables, printed three times each, in a 38-page document. Measured from
the delivered PDF's own text positions rather than from the source that made
it:

| Table | Drawn on pages |
|---|---|
| Planning controls (`Control / Reading / Standing / Evidence`) | 15, 26–27, 32 |
| Residential land use | 16, 27, 33 |
| What is mapped over this land | 17, 33 |

And page 15 carried the heading **"Planning controls table (reproduced
exactly)"** over the first of them, which is the instruction to the writer
reaching a client's page.

### Why it happens, and why the prompt cannot fix it

`generate-investment-report` composes each table once, from what the registers
answered, and does two things with the one string: it pins it into the context
every section call receives, and it appends it to the finished document under
`## Planning controls and development registers`. The append exists because
"asking a model to reproduce a table is how a table comes back paraphrased" —
the generator says so in those words.

The model, handed a table and asked to write a planning section, reproduces it.
That is not disobedience; it is what a writer does. **An instruction is a
request; this is the guarantee.**

`dedupeChartDirectives`' own header has recorded this since Stage 4 — "the
identical three-bar price chart was drawn on five pages **and the planning
controls table on four**" — because that pass de-duplicates `{{…}}` directives
and a register is a Markdown table. The half that was seen is the half that was
never closed.

### Which copy survives, and why that is not a coin toss

**The copy inside the register section.** It is the composed retrieval; every
other copy is a reproduction of it.

That has teeth, because on this document the copies **disagreed**: the land-use
table carried five rows on pages 16 and 33 and **thirteen** on page 27. Keeping
the longest would keep a model's expansion; keeping the register's keeps what
the platform retrieved. A row the register did not produce has no provenance,
which is `PLANNING_CONTROLS_IN_THE_REPORT.md` rule 1 applied to a row rather
than to a cell.

### The three bounds

* **A closed set of headers**, composed by `planningFacts.pure.ts` and by
  nothing else — so this recognises this platform's own output rather than
  guessing at a pattern a model might write. Two tables that merely look alike
  are untouched.
* **A dropped table leaves a pointer**, naming the section that carries it, so
  a lead-in ending in a colon is never left with nothing under it — the
  substitution `rewriteScaffoldingPointers` already makes, for the same reason.
* **With no register section appended** — an area report, a format that appends
  none — the FIRST copy stands, because the prose copy is then all the reader
  has.

Read path, in `presentStoredMarkdown`, so it repairs every stored document with
no regeneration; first in that pipeline, because `dropEmptyTableColumns` and
`foldConstantTableColumns` both rewrite header rows, and before
`dropEmptySections` so an emptied heading is collected by the rule that exists
for it.

### An open question this does NOT settle

The land-use table's **five rows against thirteen** is a fact about the
document; which number is correct is not settled, and guessing is not a way to
settle it.

What is established:

* `readResidentialStanding` walks a fixed list of twelve secondary residential
  uses. Where the table's group term "residential accommodation" is prohibited,
  **every one of the twelve is emitted**; where it is not, only those the
  register names explicitly survive.
* Page 33 prints the group-term sentence — *"Every other form of residential
  accommodation … sits in the prohibited item of the same table"* — which
  `residentialSentence` emits **only** when that flag is true. So the composed
  table should have carried thirteen rows.
* Page 33's table carries five, ending at `Dual occupancies (detached)` with
  the next block starting 38 units below it — no page break, no continuation.
* Page 27's model-written copy carries exactly `SECONDARY_RESIDENTIAL` plus the
  dwelling house, in the module's own order and casing.

What was excluded by execution: `presentStoredMarkdown` keeps all thirteen
rows; `renderMarkdown` emits all fourteen `<tr>`; and `packMarkdownPages` at
the production options never loses a row at any page budget from 46 lines down
to 6 (it only ever adds, when it repeats a head across a split).

So either the retrieval emitted five where the code says thirteen, or the
deployed bundle differs from this tree. **It is not resolved here**, and the
de-duplication above is deliberately safe under either answer: it prints what
the register produced, whatever that turns out to be.

## 10. A footnote marker with nothing it can refer to

Five sentences ended in a bare digit glued to the full stop before them, set in
the body face at body size:

```
p21  …which medians do not capture.12 Median house prices in postcode 2155…
p21  …over both the short and medium term.2 The 4-period median price series…
p22  …rather than a thinly traded niche.2 This volume is specific to the…
p22  …according to the Australian Bureau of Statistics.4 This very modest…
p23  …than as a safety score.3 Latest recorded counts by offence category…
```

### The correction: the Compass DOES carry an apparatus

The first reading of this recorded "the Compass carries no footnote apparatus,
so each digit refers to nothing", and that was measured against a fixture of
the document rather than against the document. **Page 36 carries a `Notes`
list of four entries**, drawn by `markdown.pure.ts:1659` (`<h4>Notes</h4>` plus
an `<ol class="fn-notes">`) from `[^id]:` definitions the stored body holds —
confirmed in the file by font and geometry: the label is Playfair-Display at
14, the four entries are body Inter at 14 indented to `left=104`, and the
ordered-list markers sit in the gutter at `left=86` on the same four baselines
(`top=236 / 283 / 330 / 378`).

So the guard returned **true** and `stripFootnoteDebris` was a **no-op on the
one document it was written for**. Both halves of the same lesson §5 records:
the module was checked against a fixture shorter than the product, and a spec
asserting `hasFootnoteApparatus(DELIVERED)` was `false` was asserting a
property of the fixture.

Reading the digits against that list is what settles the rule:

```
p21  .12  ->  there are four notes; 12 is not one of them
p21  .2   ->  note 2 is the ABS population series; the sentence is house values
p22  .2   ->  note 2 again; the sentence is sales volume
p22  .4   ->  note 4 IS the population note                       (correct)
p23  .3   ->  note 3 IS the crime note                            (correct)
```

Two of five land, two land on the wrong source, one lands on nothing. **A bare
digit beside a rendered apparatus is worse than one beside no apparatus at
all**: a reader follows it into the Notes list and arrives at the wrong
publisher.


### What wrote them, by execution rather than inference

Every other form a citation could take was driven through the real write-path
stripper in `generate-investment-report` and then through `renderMarkdown`.
Each survives **visibly different**, so none of them can be the source:

```
capture.[12] Median     ->  capture. Median          (stripped, correctly)
capture.[^12] Median    ->  capture.[^12] Median     (numeric id kept as prose)
capture.¹² Median       ->  capture.¹² Median
capture.\[12\] Median   ->  capture.\[12\] Median
capture.**[12]** Median ->  capture.* Median
capture.<sup>12</sup>   ->  capture.&lt;sup&gt;12&lt;/sup&gt;
capture.(12) Median     ->  capture.(12) Median
capture.12 Median       ->  capture.12 Median        <- the only match
```

The model wrote the marker with **no markup at all** — what a writer does when
it wants a superscript and the format has none. The prompt asks for `[^id]`
and the stripper handles `[1]`, `[1][2]` and `[citation]`; this is the one form
neither reaches, and it is the form that shipped.

### Why this is not the prose scrub this repository forbids

Two things, both checkable rather than argued.

**It is conditional on the document, and on which KIND of apparatus.** The two
kinds do not behave alike, which is the correction above, and
`footnoteApparatusOf` is the one place that tells them apart.

* **`rendered`** — an `[^id]: text` definition. Its markers are the `[^id]`
  references, which the renderer sets as superscripts in their own nodes. A
  bare digit in body copy is not one of them and can never become one, so it is
  debris here exactly as in a document with no notes.
* **`literal`** — a `**Notes**` line, or `[1] text` entries as
  `resolveFootnotes` emits. That list has no markup of its own, so the bare
  digits may be the only thing pointing at it, and the document is left
  byte-identical, markers and all.
* A body carrying **both** answers `literal`, which is the conservative side.

The document says which case it is; nothing here is configured. Same shape as
"asserted by effect, never by configuration".

**A digit between two sentences is in neither of them.** Removing it cannot
change a claim, a figure or a source — which is what makes it punctuation
rather than prose, the distinction `rewriteScaffoldingPointers` draws in those
words one file over.

### The four bounds

* **Three or more lowercase letters before the stop** — what a word ends with
  and an abbreviation does not. It is what keeps `No.3 Smith Street`, `Fig.2`
  and `p.12` out.
* **A closed `ABBREVIATIONS` list** for the longer ones (`para`, `approx`,
  `vol`, `sec`, …).
* **One or two digits**, because footnotes run 1..99 and a third digit is a
  number.
* **Then whitespace and a capital, or the end of the block** — a new sentence,
  never a continuing phrase.

Measured over all 38 pages of the delivered document: **5 matches, all five the
markers, 0 false positives.** `s.10.7 planning certificate`, `(CC BY 4.0)`,
`api.apps1.nsw.gov.au` and `Clause 4.3` are excluded by shape.

One document is not a distribution and the module says so. The bounds fail
closed: a marker left standing is the defect that shipped, and an edited
sentence would be worse.

### Still open from the same finding

The **page-36 Notes list** is closed and was never a layout defect: measured,
the four `1.`–`4.` markers sit in the gutter on the same four baselines as
their entries, which is an ordered list rendering correctly.

The **`sofuture` eaten space on page 25** is narrowed but not closed. The same
construct appears twice on that page, eight lines apart, and only one breaks:

```
top=330  'numbers'    (f29) + ', so future price and rent performance will…'  (f12)   OK
top=600  'directions' (f29) + ', sofuture changes in incident numbers…'       (f12)   glued
```

Node offsets foot exactly in both cases (`86+62=148`, `86+70=156`), so the
layout is consistent and the glue is **in the text, not in the positioning** —
it is in the stored content or in a content transform, not the packer or the
renderer. Which of those needs the stored bytes of that report, which this
branch has not read.

## 11. One date format in a planning reading

Page 32 printed, in a sentence a client reads:

> Under The Hills Local Environmental Plan 2019, **as read on 2026-09-20**, a
> dwelling house is permitted with development consent on this land.

while every table on that page and the two either side of it said `7 Aug 2026`,
`27 Feb 2026` and `20 Sep 2026`. One document, two date formats, and the
machine-readable one in the prose.

`instrumentAnchor` built its date with `retrievedAt.slice(0, 10)` — an ISO
prefix, which is the right thing to STORE and never the right thing to print —
while `planningFacts` and `infrastructureEvidence` each carried a private,
byte-identical `auDate` that their tables went through. **Two copies of one
rule, and the one place that reached prose had neither.**

`auDate.pure.ts` is that rule, named once and imported by all three. It is a
pure string transform rather than `toLocaleDateString`, deliberately: the AML
defect the `AU_LOCALE` rule came from was a formatter taking the READER'S
machine, and an edge function has no reader's machine to take. What it cannot
parse it hands back unchanged, because a publisher's own wording for a period
("Q2 2026", "2025-26") is a fact and reformatting it would be inventing one.

**A contract test had to be renegotiated and it was pinning the defect.**
`landUsePermissibility.spec.ts` asserted `/^Under .+, as read on
\d{4}-\d{2}-\d{2},/` and `AT.slice(0, 10)` — it REQUIRED the ISO form that
shipped. Its intent (the sentence must name its instrument and the day it was
read, or it reads as a permanent property of the land) is kept whole, beside a
second test forbidding an ISO date in any sentence a client reads.

## 12. The front matter of a list is not an entry in it

Page 2 opened its twenty-two-row contents with:

```
1. Cover                                              1
2. Contents                                           2
3. Executive dashboard                                3
```

The first row points at the sheet before this one; the second at the sheet the
reader is holding. A contents entry whose destination is the contents is a link
to itself — `tpl-page-1`, from the block drawn on page 1. They are also two of
twenty-two rows on a page `fitTocEntries` can be forced to truncate, so they are
not free.

`renderTocHtml`'s filter kept both by construction: a page with no narrative
section is listed unless it declares `tocContinues`, and `i === 0` **forced the
cover in past even that test**.

### Structurally, never by name

Both are identified by the list's own `ctx.pageIndex` and by page 0. A master
may call its cover anything, and matching on the word "Contents" would drop a
report section that happens to be called that.

### The two bounds

* **It never drops a page that opens a section.** A master that draws narrative
  on its cover lists that page as content — the caller passes `opensSection`, so
  this cannot be decided from a page's furniture alone.
* **It never empties the list.** A one-page document keeps what it had, because
  a blank contents page reads as a broken render.

**Five tests were renegotiated and every one was pinning this defect** — four in
`sectionNavigation.spec.ts` required `1. Cover` and `2. Contents` as the first
two rows, and one in `contentsBlock.spec.ts` asserted the same strings. Each
test's own subject is kept whole (the list names the report's sections rather
than the archetypes carrying them, a section row links to its own heading, a
`tocContinues` sheet folds, a document with no narrative still lists its pages)
and each now also asserts the front matter is absent.
