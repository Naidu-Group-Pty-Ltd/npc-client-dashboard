# The property's photographs in a client's report

Read this before touching `_shared/reportPhotographs.pure.ts`,
the `photographs` option on `get-investment-reports`,
`src/lib/reportTemplate/adapters/reportPhotographs.ts`, or the `property.images`
binding in the Investment Compass masters.

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

At most six photographs are carried: the largest number any master binds.

## 4. What this does not do

- **A report made through URL extract has no photographs.** The scrape reads
  the page as text and the report carries no listing id. The listing's lead
  photograph is in the page metadata the scrape already receives, so capturing
  it would cost nothing extra. It is not captured, and the reason is a licence
  rather than code: a portal's photographs belong to the agency or its
  photographer, and this platform's standing rule is that *readable is not
  republishable*. Whether a client report may carry them is the owner's
  decision.
- **Forty-five masters have no photo slot.** The Lawley PDF was drawn with
  one of them: a dark cover with a large empty band where a photograph would
  sit. Adding a photograph to those covers is a design change. It goes
  through the design source and the generator (`07-investment-compass-families.md`),
  then a new seed version and the active-master refresh. It is not hand-written
  here.
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
