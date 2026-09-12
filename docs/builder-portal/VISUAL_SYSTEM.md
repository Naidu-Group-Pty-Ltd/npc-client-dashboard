# The Builder / Developer Portal's drawing set

The portal's visual language is taken from the artefact a builder already
lives in: a drawing sheet. Setout grid, three line weights, annotation type,
a dimension line, a title block, a ruled schedule.

Read this before touching `src/styles/builder-drafting.css`,
`src/components/builder-portal/ui/*`, `src/lib/builderConstructionRail.pure.ts`
or the `aside` on `BuilderPortalShell`.

---

## 1. The defect this exists to prevent: a system nobody mounted

The first pass shipped the whole language and **three of its components had
zero call sites**. `DimensionRail`, `TitleBlock` and `bd-chip` were written,
documented, reviewed, merged and deployed without ever being rendered. 19
builder pages mounted `BuilderPortalShell`; **none** passed an `aside`.

What reached production was the half that re-skins existing markup — the
field, the annotation type, the schedule, the ledger, the nav — so every page
changed just enough to look finished. The half that makes the portal read as
*construction* rather than as a competent dark admin panel was dead code, and
nothing in the gate could see it: it typechecks, it lints, it has tests, the
build succeeds, and an unused export is not an error.

**A component is not shipped until something renders it.** The cheap check is
one grep per exported component; the honest check is a render.

## 2. The rail draws construction, and construction is already in the schema

`BuilderConstructionStageKey` has always been
`site_preparation | base | frame | lockup | fixing | practical_completion |
handover`, and `BuilderConstructionStage` carries `sequence_number`, `status`
and `actual_start_date`. The extent the rail needed was in the database from
the first migration. The page drew it as *"4 of 7 stages complete"* under a
progress bar — a percentage, which answers **how much** and never **which**.

`builderConstructionRail.pure.ts` is the one module that projects a build onto
the line, so the detail page, the list and anything added later cannot come to
different answers about the same case.

### Three rules

**Off-sequence is not a position.** `on_hold` and `cancelled` are real
statuses and they are *not* points on the line: a paused build is somewhere on
the extent and the status does not say where. They resolve to `null`, and the
rail draws the whole extent in the pending weight with the absence stated.
Placing them at an index invents a fact; placing them at the end would say a
cancelled build had completed.

**The case's own stages outrank the catalogue.** Where a build carries stage
rows the extent is built from those, in their own `sequence_number` order — a
builder may not run every stage, and a rail showing stations this build does
not have is measuring somebody else's job. The fixed key order is only the
tie-break.

**A short label is a prefix of the full one.** The rail *draws* `short` and
*speaks* `label`. Keeping one a prefix of the other is what makes shortening
safe: the two cannot come to name different things. Asserted by a test, not
trusted.

Two more, inherited from the component and still load-bearing: nothing has
started is **no position**, not station one; and an index outside the stations
is treated as absent rather than clamped, because a clamp invents a position
too.

## 3. What only a render could find

Every item here passed typecheck, lint and tests, and was wrong on screen.

**`@layer components` does not lose to utilities here.** Tailwind v3's
`@layer` is build-time bucketing, not native CSS cascade layers, so
**specificity decides**: `.builder-portal-theme .luxury-badge` (0,2,0) beats
`.rounded-full` (0,1,0). That is what lets one rule re-skin ~40 shadcn badges
without touching a page — and it was confirmed by measuring a rendered badge
with `rounded-full` present, not by reading the spec.

**A dimension line has a natural length.** Run across a 1,550px sheet its
stations read as unrelated points rather than one measured extent, so
`bd-rail` bounds it. The class also replaces the root's `w-full`.

**Extension lines at `0.7` alpha did not survive the dark ground**, and the
setout grid at `0.05` was a rumour rather than a sheet.

**A dense rail must draw three stations, not all of them.** Seven names across
a ~500px table cell is ~70px each and *"Practical completion"* alone is twice
that, so every row overlapped its own labels. The ends carry the extent and
the current station carries the answer; the ticks still mark every station, so
nothing leaves the drawing — only the annotation.

**Buttons were omitted from the first re-skin**, which left the loudest
control on every page as a rounded pill on a sheet of square ones.
`.rounded-full` is re-exempted so avatars and icon toggles stay round.

## 4. The schedule, and what a figure owes the reader

Eight figures are **one** ruled schedule, not two four-across slabs stacked:
at 1,920px that was a 400px cell holding a single digit, and a second border
where a drawing would rule another row.

`ScheduleFigure.baseline` is **required** by the type. A bare `0` reads as a
broken page; `0` above *"Nothing waiting on you"* reads as finished. The
dashboard used to paper over this with a footnote under the whole grid, which
is an apology for a number that does not explain itself.

## 5. The title block is a revision panel

`TitleBlock` carries what a drawing sheet carries in its corner: who it is
for, under what authority, and when it was last revised. On the dashboard that
is Organisation / Access / Membership / Figures as at — all facts the page
already held and drew nowhere, on a page whose entire content is counts behind
a Refresh button.

**An absent fact is named, not dashed.** A title block's cells are fixed
positions, so a dropped cell would make the grid lie about which key a value
belongs to; `null` renders *"Not recorded"* in annotation type, because a dash
reads as a value somebody entered.

## 6. Rules the language inherits and must keep

- **Every selector is scoped under `.builder-portal-theme`**, applied by
  exactly two roots (`BuilderPortalLayout`, `BuilderAuthShell`). Nothing here
  can reach the Client, Finance or Solicitor portals, the command centre, or a
  generated report.
- **Never write a colour.** Every value resolves from the semantic tokens, so
  a tenant who retunes `--primary` retunes the whole language. A raw hex trips
  `npm run audit:style`.
- **Category B stays fixed.** The badge re-skin sets shape and type only;
  each variant's colour comes from utilities, so `success` / `warning` /
  `destructive` keep their semantic tones. A caution chip must never read as a
  brand one.
- **No `backdrop-filter` on anything that repeats.** The setout grid is one
  background-image on one container; cards take a translucent fill and a lit
  edge.
- **No component declares a font-family.** Annotation type is `--font-mono`.
- **A dialog is deliberately not caught** — Radix portals to `body`, outside
  the theme root, and a modal is the platform's surface rather than the
  portal's sheet.
- **Every hook goes above the early returns.** `BuilderConstructionDetail`
  returns early while loading and again on error; the clock the rail's extent
  annotation needs is read once, at the top, by a lazy `useState` initialiser
  — a `Date.now()` during render is impure and two renders can disagree.
