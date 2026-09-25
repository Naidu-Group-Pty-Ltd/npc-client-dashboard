# The property's photographs in a client's report

Read this before touching `_shared/reportPhotographs.pure.ts`,
`_shared/listingPagePhotographs.pure.ts`, the `photographs` option on
`get-investment-reports`, the `capture_report` operation on `listing-images`,
`src/lib/reports/urlExtractPhotographs.ts`,
`src/lib/reportTemplate/adapters/reportPhotographs.ts`, `withCoverPhotograph`, or
the `property.images` binding in the Investment Compass masters. §6 is the
URL-extract path; §7 is the cover photograph on the other masters.

## 1. What was asked, and what was actually wrong

On 25 Sep 2026 the owner asked for images to reach the report automatically,
without managing them by hand. They had opened Hero Image Studio for the
60 Lawley Street Compass, and it answered "Couldn't load library". That error
was the Studio's own. It is fixed in `6d7b750b7`: the function imports the
shared request guards again.

Behind it was a finding that mattered more. **Nothing the Studio places reaches
the document a client receives.** `report_hero_placements` is read by one
consumer only: the standard (pdf-lib) presentation. That presentation draws
the placements stacked on a figures page after the body, and only when
`includeHeroImages` is switched on, which it is not by default. The
template-drawn document never read placements at all. That is the WeasyPrint
render through a chosen design, and it is the one the Lawley PDF was. The
legacy renderer did read them per chapter, and nothing calls it any more.

The design system had been built for photographs, and waited on a producer.
Five of the fifty Investment Compass masters bind `{{property.images.N}}`:

| Master | Cover photograph | Full-page plates |
|---|---|---|
| Atelier (`le-01`) | yes | 4 |
| Atelier Plate (`le-02`) | yes | 6 |
| Grand Folio (`le-03`) | yes | 4 |
| Frontispiece (`le-04`) | — | 3 |
| Elevation (`ap-03`) | — | 4, captioned as figures |

`platePage`'s own header called the binding "forward-looking": the day an
adapter carries photographs, every plate fills itself with no template change.
No adapter ever did. Meanwhile the image library held the photographs of every
listing-sourced report, stored, de-duplicated, classified by the server, and
signed for the marketplace. The report pointed at the same listing through
`property_listing_id`, which every fork and condense child inherits.

## 2. The path

1. `investmentReportAdapter.buildBindingContext` asks `get-investment-reports`
   for the report with `photographs: true`. It is one read, behind the same
   `reports` permission as the row.
2. The broker reads the listing's stored images and the reuse reading.
   `photographsForReport` decides which of them may lead a client's document,
   and the broker signs only those, for ten minutes, from the private
   `listing-images` bucket.
3. The adapter turns each signed URL into a `data:` URI
   (`inlineReportPhotographs`). The renderer may make no network request of its
   own (`RENDER_BOUNDARY.md`), and a signed URL expires minutes after it is
   minted. A web-sized JPEG, PNG or WebP goes through byte for byte. A camera
   original, or a format the print engine may not decode, is redrawn to 2,000 px
   on its long edge. That is an A4 plate at about 240 dpi, and it keeps six
   photographs well inside the 25 MB document ceiling.
4. They bind as `property.images`, set after the projection so nothing
   overwrites them. Every photo slot is conditional, so a report with no
   photographs draws exactly the document it drew before.

Every failure costs one photograph and nothing else: an unreadable image table,
a reuse reading that failed, a signing error, a fetch that timed out or an image
that would not decode. A missing picture is what every slot is designed for. A
document that fails to draw because a photograph could not be fetched is not.

## 3. The rule: the gallery's own judgement, tightened for a document

A marketplace gallery and a client's report differ in what an absence costs. A
gallery must never blank a card, so `bandOf` demotes and never filters. A report
has a designed absence. The cost of leaving a picture out is a cover without a
photograph; the cost of putting the wrong one in is somebody else's house on a
client's document. So a report takes, in the gallery's own order and after its
de-duplication:

1. **Positive evidence that it is a photograph.** That means
   `visual_kind = 'photo'`, the server's verdict on the pixels. An image nobody
   has looked at can be a floor plan behind an opaque Google Drive id; 6 of 16
   sampled marketplace heroes once were.
2. **Nothing the gallery would demote.** `bandOf` must say `standard`: not a
   graphic, not chrome, not a thumbnail, and not a photograph another listing
   also holds (a stock render once led seventeen listings). If the reuse
   reading cannot be taken at all, nothing is taken, because "unique" cannot be
   read from a failure.
3. **Enough pixels to print.** A picture known to be under 1,000 px on its long
   edge prints soft at plate size. Unknown dimensions are evidence of neither,
   so they pass.
4. **Of the report's own address and property.** The owner's rule
   (25 Sep 2026): the photographs must be only of that address and property,
   and a slot is never filled with a picture chosen to fill it. The
   photographs are always their source's own. What can differ is the report:
   its address is typed before it is generated and can be edited in the
   report editor afterwards. So on every read the report's address is held
   against the address the photographs belong to
   (`photographsAreOfReportAddress`):
   - on the listing path, the listing's own address, composed from its record
     exactly as the marketplace composes it;
   - on the URL-extract path, the address the extraction read (§6).

   The comparison is `isSameProperty`, the rule the marketplace applies
   before it attaches a photograph to a card:
   - street number, street name and suburb must agree after normalisation;
   - units must agree whenever either side names one;
   - an address with only a lot number never matches, because a lot is not a
     street number.

   Anything that cannot be verified takes nothing: a missing suburb, a
   suburb-only address, or a listing the cache no longer holds.

At most six photographs are carried: the largest number any master binds.

## 4. What this does not do

- **A report made through URL extract had no photographs.** The owner has
  since decided it should carry the listing's own (25 Sep 2026); §6 is how.
- **Eleven masters have no photograph on the cover.** Since seed v21 the
  other thirty-four carry the lead photograph (§7). The eleven are paper
  covers, which need a different design to carry one, not an added block.
- **Duplicate intake records lose their photographs.** One property forwarded
  twice is two listings holding the same pictures, and rule 2 cannot tell that
  from a stock render, because the reuse reading carries counts, not addresses.
  This is the conservative side on purpose.
- **The standard presentation's cover is unchanged.** It is a static page.
- **A document already produced in a tab is not redrawn** when a photograph is
  harvested later, because the template path's cache fingerprint does not
  include the images.

## 5. Verified, and not

Verified locally:

- `reportPhotographs.spec.ts` (the rule, the reuse reading, the broker's shape)
  and `reportTemplate/__tests__/reportPhotographs.spec.ts` (inlining) pass.
- `investmentReportAdapter.photographs.spec.ts` passes.
- Each rule was removed in turn and the tests failed.
- The Deno type-check of `get-investment-reports` adds no error.

**Not verified: that a real listing-sourced report draws a photograph through
a photographic master.** That needs this deployed, a report whose listing holds
analysed photographs, and one of the five masters above chosen for it. It is
PENDING until someone does that and reads the PDF.

## 6. A report made through URL extract

The owner's decision, 25 Sep 2026: a report made from a listing link carries the
photographs that listing publishes. It reverses the caution recorded in §4 for
this one route, and only for the listing's own pictures.

### The path

1. **The extraction names them.** `scrape-property-listing` now asks the page
   reader for the page as served (`rawHtml`) beside the markdown it already
   read, and `photographCandidatesFromPage` names the listing's own
   photographs from it. On realestate.com.au that is the gallery in the page's
   embedded data, attributed by the listing id in the URL: the "similar
   properties" beside it carry other ids and are never taken, and floor plans
   are a separate list. **Anywhere else, nothing.** A page's `og:image` was
   the fallback in the first version. It says what the page wants shown when
   it is shared, not which property a picture is of; on a portal or an agency
   site it is as often a banner, an office or a stock photograph as the house.
   It is not read any more. Domain answers this sandbox 403 on every page, so
   its embedded gallery was never measured and a Domain listing names
   nothing. The names are URLs stored on the job; nothing is fetched, and
   nothing about naming can fail the extraction.
2. **The report asks for them to be kept.** Once the report row exists the
   browser sends `listing-images` one request, `op: 'capture_report'`, naming
   the report and the job. Only the report's author may start a capture, only
   from their own finished extraction, and never for a derived report (a fork
   or a condensed child reads its parent's photographs). And only when the
   address the extraction read (`extractedAddress`, `extractedSuburb`) is the
   report's own address (rule 4). Otherwise the request is refused before
   anything is fetched or written. That address goes into the record, and a
   resume stops if the report has since been re-pointed at another address.
3. **The server keeps what passes.** Each photograph is fetched through the
   SSRF guard, must state at least 1,000 px on its long edge, must be judged a
   photograph by the server's own reading of its pixels (a floor plan or a
   graphic is refused), and must not be a copy of one already kept, by checksum
   or by picture. It is filed under the report:
   `report-photographs/<report id>/<place>-<w>x<h>-<checksum>-<signature>.<ext>`.
   Nothing is written to `listing_images`, so the marketplace's reuse reading
   is untouched.
4. **Every document in the family reads them.** `get-investment-reports`
   falls back to the report's folder when the report has no listing, reading
   the parent's folder for a derived document, and signs them exactly as it
   signs a listing's. It serves them only where a readable record vouches
   that they are of the report's address as the report reads now.

### "What if the photographs are not fetched within the browser's minute?"

The owner asked this, and the first version of this route deserved the
question: it did all the work inside the one request the browser sent, so a
closed tab, a dropped connection or a slow host could leave the report with
none, and nothing tried again. Three changes answer it.

- **The minute no longer matters.** The server writes down what was asked, in
  a small record beside the photographs (`capture.json`: the job, the author,
  the attempts, and which candidates are decided), answers at once, and does
  the work after answering (`EdgeRuntime.waitUntil`, as the extraction job
  itself runs). A report takes minutes to generate, and the photographs are
  only needed when its document is drawn.
- **An unfinished capture is finished by the next document drawn.** A picture
  its host did not answer for, or one the time allowance could not reach, is
  left for another attempt; a verdict about the picture itself (not a
  photograph, too small, a copy, a 404) is final. The broker reports a capture
  with work left over as `pending`, and the Investment adapter asks for the rest
  before it draws, waiting at most 45 seconds and never failing the document.
  After four attempts, whatever was kept is what the report carries.
- **The listing's order survives a late photograph.** A photograph's file name
  carries its place in the listing's gallery, not the order it was kept in, and
  a capture is not final while a place ahead of the sixth kept one is
  undecided. So a lead photograph whose host failed on the first attempt still
  becomes the cover on the second.

The start itself is sent again, twice, if it fails in transit (a network
failure, a 429 or a 5xx), never after a refusal. The one case nothing recovers
is a start that never reaches the server at all while the tab is closed within
the same instant; that report is drawn without photographs, which is how every
report was drawn before.

### Why the record is a file and not a table

The link from a report to the extraction it came from is stored nowhere else.
`data_sources` is rebuilt when the report finishes, `manual_overrides` is the
operator's own figures and reaches prompts and templates, and a new column is a
migration. The report's own folder already holds everything else about its
photographs, and the object names describe the photographs, so the two extra
facts (the extraction, and the address its photographs are of) sit beside
them. If the bucket refuses the record, nothing is fetched: no reader may serve
a photograph that no record says is of the report's address.

### Verified locally

- `listingPagePhotographs.spec.ts` (which photographs a page attributes to its
  listing) and `urlExtractPhotographs.spec.ts` pass. The second drives the
  capture's decisions over several attempts against a scripted host: a lead
  photograph that failed first still leads, a host that never answers is given
  four attempts and no more, and a floor plan or a removed picture is never
  asked about twice.
- The same spec pins the joins by reading the source: who may start and who may
  resume, the record written before anything is fetched, the answer given
  before the work, fetches only through the SSRF guard, nothing written to
  `listing_images`, the broker's reading of the family's folder, and the
  adapter's bounded wait.
- Rule 4 is pinned the same way:
  - the address cases: typed differently but the same property; another
    number, street or suburb; a unit against its building; a lot; a suburb
    alone; a street with no suburb;
  - the order of the checks in `listing-images` (address before the record,
    the record before the fetch) and in both of the broker's paths;
  - the page reader naming nothing from an `og:image`.

  With the comparison replaced by an unconditional yes, three of the spec's
  tests fail. With any one of the three checks removed (the capture's start,
  the broker's listing path, the broker's captured path), that check's own
  test fails.
- The REA image host was measured from this sandbox: it serves JPEG whatever
  the request's `Accept` header says, so the server can always read the size and
  judge the picture, and both renditions pass the page-furniture and
  property-image rules.
- The Deno type-check adds no error to `listing-images`,
  `get-investment-reports` or `scrape-property-listing`.

### Not verified

- **A real capture has not run.** It needs the function deployed and an
  extraction of a live listing. It is PENDING until someone does that and reads
  the PDF: the cover should be the listing's lead photograph.
- **Photographs are not removed when a report is deleted.** The folder stays,
  as the image library's files do; at about 4 MB a report it is recorded rather
  than built.
- **How many existing listing reports rule 4 withholds photographs from.** A
  report whose address was written in a form `isSameProperty` cannot match to
  its listing loses its photographs, on the conservative side. Measuring that
  needs a read of production rows this environment is not permitted to make.
  After deploy, the broker logs `listing photographs are of another address`
  for each one, which is where to count them. PENDING.

## 7. A cover photograph on thirty-four more masters (seed v21)

The Lawley PDF was drawn with one of the forty-five masters that had no photo
slot: a dark cover with an empty field where a reader expected the house.
The owner asked for the photograph on those covers (25 Sep 2026). Seed v21
sets the report's lead photograph (`property.images.0`) by the cover's
ground (`withCoverPhotograph`, and the table in
[`07-investment-compass-families.md`](../template-library/07-investment-compass-families.md)):

- **Sixteen field covers** take it behind the whole sheet, under two passes
  of the field colour's scrim.
- **Eighteen banded covers** take it inside the band, under the same two
  passes.
- **Eleven paper covers** are left as drawn.

Two passes, where Atelier uses one, because these covers carry small type
designed for a flat field. Over a white facade one pass leaves it at 3.48:1;
two come to 7.89:1, above the 7:1 print floor.

It is the same photograph whichever route found it: the listing's own
library (§2) or the URL-extract capture (§6). The rules in §3 still decide
which photographs a report may carry, rule 4 included: only this address.
A report with none draws exactly the cover it drew before. Nothing is ever
put in the space to fill it: no stock image, no photograph of the suburb and
no picture of a similar house. The binding has no fallback.

### Verified locally

- `investmentCompassCoverPhotograph.spec.ts` renders all 34 masters through
  the production renderer. Without a photograph, each draws exactly the HTML
  of the same master with the three new blocks removed. With one, every other
  box on the cover stands where it stood without it. With the slot removed,
  38 of its 74 tests fail. With the layer rule in `closeDroppedBlocks`
  removed, 32 fail: the sixteen field covers, whose cover would otherwise
  rise when the photograph is absent.
- Parsed and compared against v20, row by row: 34 of 543 rows differ, each
  by exactly those three blocks (in `schema` and `preview_schema`), plus
  `property.images.0` in `required_bindings` and, on fifteen field masters,
  `hero` in the block types.
- `templates:library:seed:check` confirms the migration is what the
  definitions produce.

### Not verified

- **A real report drawn through one of these covers.** It needs the two
  migrations applied (`20261222090000` seed, then `20261222100000`
  refresh, through the reviewed workflow), a report whose photographs pass
  §3, and the PDF read. PENDING.
- **The Claude Design catalogue does not draw it.** The slot is composed in
  code from a ground the catalogue declares. `source.json` is untouched, so
  the Design file still shows these covers without a photograph.
