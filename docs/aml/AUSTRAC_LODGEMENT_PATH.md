# Lodging a report with AUSTRAC

Read this before touching `src/lib/aml/austracReportPath.pure.ts`,
`AustracReportPathCard`, the draft dialog in `AmlAustracReporting`, or the
`submit_record` / `record_receipt` operations in `aml-reporting`.

## Almost none of the machinery was missing

`aml-reporting` already refused a submission that was not MLRO-approved,
already demanded step-up MFA, already required lodgement evidence — and for
an SMR, the AUSTRAC reference specifically — and already required an explicit
no-tipping-off attestation before it would write a submission. It stamped the
SMR case event `restricted` so downstream renderers could withhold it. The
server was rigorous.

What sat in front of it was a dialog with five boxes and a table of statuses.

## The defect: every report was filed against nobody

`reports.case_id` has existed since the first migration. **The draft dialog
never set it.** So no report reached the customer's compliance file, none
appeared on their case timeline, and none could be found from their record —
the only way to a report was this page.

A report about a customer that is not on that customer's file is not on file.
The dialog now asks, and the server has always written the case event when it
was given a case; it was never given one.

## The clock is derived, and it is in BUSINESS days

| report | window | basis |
|---|---|---|
| SMR | 3 business days from the day the suspicion was formed | s.41 |
| SMR — terrorism financing | **24 hours** | s.41 |
| TTR | 10 business days from the transaction | s.43 |
| IFTI | 10 business days from the instruction | s.45 |
| Compliance report | annual, no per-report clock | s.47 |

Three rules.

**Business days, not calendar days.** A suspicion formed on a Thursday is due
the following Tuesday; a naive `+3` says Sunday, which is not a day AUSTRAC
counts. `addBusinessDays` skips weekends and a test pins that exact case.

**The clock starts at the OBLIGATION, not the reporting period.** An SMR runs
from the day the suspicion was formed, which is not the period the report
covers. It is a separate field — a deadline derived from the wrong date is
worse than no deadline — and it is kept in `reports.metadata`, so this needed
no migration.

**Terrorism financing is the same report under a tighter clock**, not a
different kind. Drafting "the wrong one" and reconciling later is not
something an operator should be able to do, so it is a flag on the SMR and it
tightens the window to 24 hours. It is also the only case that shows a TIME:
a multi-day window is a date, and printing an hour on it implies a precision
the Act does not have.

## The checks disclose; the server refuses

`austracReadiness` is what an operator sees before they set off. It blocks
nothing, because the server already refuses what must be refused. **Two gates
is how one of them becomes wrong.**

Only two checks read `blocked`, and neither is a policy the browser invented:
a report filed against no customer, and a report past its statutory window. A
late report is still a report — it says so, and asks for the lateness to be
recorded, because the lateness is itself a matter of record.

## The platform never lodges

AUSTRAC Online is the reporting entity's own account, reached with its own
credentials, by the person authorised to use it. This product holds no
AUSTRAC credentials and submits nothing.

That is said on the page rather than in a tooltip, on the step where it
matters, because the alternative is an operator waiting for a submission that
was always theirs to make. What the product does is assemble the report, hold
the evidence behind it, record who approved it, and keep the receipt on the
customer's file.

## Tipping off

Disclosing an SMR is an offence under s.123. The protection is at the
projection rather than in a caller's discretion: `CLIENT_RESTRICTED_KEYS` and
`PARTNER_RESTRICTED_KEYS` in `passportView.pure.ts` both already carry `smr`,
`austrac` and `suspic`, so a report can never travel to a client's copy of
the Passport or a partner's, whatever is added to the record above them. A
test pins both lists rather than trusting them.

## The path is the product's own shape

Six numbered steps with exactly one open, which is what Stage 5 and Stage 9
do. An operator who has learned one guided path in this product has learned
all of them, and that is worth more than a form that is locally clever.

---

## The draft dialog says why, and not only what

The first version of this work gave the report a path, a deadline and a
customer. It left the drafting itself as it found it: a narrow modal with
five boxes that explained none of them. An operator drafting their first
Suspicious Matter Report had to know, from somewhere that was not on the
screen, what the trigger is, that it covers an *attempted* service, that a
customer who walked away when identification was asked for still obliges the
report, that the customer must not be told — and that a large cash payment
with nothing else odd about it is a different report altogether.

None of that is obscure. It was simply absent from the place the decision is
made, which is the only place it is worth having.

`austracDraftGuidance.pure.ts` carries it, per obligation: **why** the report
exists, **when AUSTRAC must be informed** (the tests an operator applies),
**what that looks like** in a property-services reporting entity, **what the
report is not for** and where that belongs instead, and **what the narrative
has to answer**. The dialog renders it beside the form.

### It advises and never decides

Nothing in the guidance writes a field, chooses a kind or blocks a save. The
operator forms the suspicion and the MLRO approves the report; a module that
quietly picked for them would be this product forming a view it has no basis
to form. Two consequences are pinned by tests:

- **"Not this report" routes to the right report and never to no report.**
  A test rejects any sentence in the guidance that could be read as
  permission to lodge nothing.
- **The narrative helper inserts questions, never answers.** It is offered
  only into a narrative that is blank, so whatever it writes could be lodged
  verbatim if nobody edited it. Every line it produces is a question, which
  cannot be read as an assertion about a customer.

### The tipping-off warning is in the main column

s.123 makes disclosing a Suspicious Matter Report an offence, and it attaches
to that report alone — carrying the warning on all four kinds is how an
operator learns to read past it. It also cannot live in the reference panel:
below `lg` that panel drops underneath the entire form, and a prohibition on
what the operator may say is the one thing that must not be below the fold.
A test asserts the warning is not a descendant of the panel.

### The stored kind is translated, never used as a table key

`reports.kind` accepts five values (`smr`, `ttr`, `ifti`, `compliance`,
`annual`) and `AUSTRAC_OBLIGATIONS` is keyed by the four obligations —
`compliance` and `annual` are one obligation under two spellings. Reading the
obligation table with a raw column value returns `undefined` and throws on
the next property access, which is what the first version of the dialog did:
choosing "Compliance Report" would have crashed the screen. Nothing had ever
hit it because the table holds no rows.

`toObligationKind` is the one translation and returns **null** rather than
guessing, so a kind the table cannot place renders no clock at all instead of
asserting an SMR's three-day deadline over a report that may not have one. A
test walks exactly the values the `reports_kind_check` constraint accepts.

### An annual report is not a customer report

The same fix exposed a second wrong reading. The s.47 compliance report
accounts for the reporting entity's own programme; there is no customer to
file it against. The readiness check reported **blocked** for a customer it
can never have, and the first step of the path could never complete — a
permanent red on a correctly drafted report, which teaches an operator to
read past the checks. `isCustomerReport` is the one predicate, the customer
section explains why there is nothing to link, and the reporting period
becomes owed rather than optional.

### Numbered sections, not a wizard

The dialog is one form in four numbered parts, and deliberately not a series
of gated steps. A Suspicious Matter Report is often started the minute the
suspicion forms and finished an hour later, so requiring each part before the
next would make the obligation harder to meet rather than easier: what saves
a draft is unchanged — a kind and a title. What the numbering adds is where
the operator is, why they are being asked, and what is still owed, said in
the footer before they leave rather than discovered by the MLRO afterwards.

The panel also carries the six-step lodgement path with the two steps that
happen on this screen marked as such, so it is visible that saving a draft is
the beginning of the process and that lodgement is never made from here.

---

## Writing a report is a page, not a dialog

The draft lived in a modal. Everything about a modal was wrong for what it
held.

A report to a regulator is the **longest single piece of writing anyone does
in this product**. It is written against a statutory deadline, and it is
routinely started when the suspicion forms, left, and returned to hours
later. A dialog cannot be deep-linked, cannot be reopened where it was left,
cannot be sent to a colleague, is not reached by the browser's back button,
and closes on an outside click or the Escape key with whatever was typed in
it. Widening it — which is what the previous change did — bought room and
none of the rest.

`/admin/aml/austrac/new` and `/admin/aml/austrac/:reportId/edit` are the
draft now. Everything the dialog asked, the page asks; everything the server
refuses, it still refuses; and what saves a draft is unchanged — a kind and a
title, because a Suspicious Matter Report is often started the minute the
suspicion forms.

Four things follow from the move.

**The path sits under the hub's own.** `pathMatchesWorkspace` matches a
prefix followed by `/`, so `austrac/new` resolves to Regulatory & Assurance
and draws its secondary strip. A page listed in no workspace draws no strip
and highlights Compliance Home — reachable, and looking broken. That is how
the Passport shipped once.

**Saving hands the report back.** The dialog closed onto the report it had
just written. A page has to do that deliberately or the operator returns to a
list with nothing selected, so the draft page navigates to
`?report=<id>` and the hub opens it. `amlAustracReportPath` is where that
spelling lives.

**Leaving is not losing.** A page gives up the modal's implicit "you are in
the middle of something", so the page says it: an unsaved change guards the
browser's own unload and the page's own Back and Cancel. The handler is
registered only while there *is* an unsaved change — an always-on one makes
every navigation away from a clean page ask a question nobody needs.

**The action bar is fixed to the foot of the viewport**, not to the end of
the form. On a page carrying an eighteen-row narrative, a Save button below
it is a scroll away from wherever the operator is working, which is the one
thing the modal's own footer got right.

### The action is named for the act

"New Draft" named the row it would add to a table. An operator who has been
told they must inform AUSTRAC about something is looking for the report, not
for a draft record, so the hub's action is **"Start AUSTRAC Report"**.

### One label map

`AUSTRAC_KIND_LABEL` moved into the pure module because there were two copies
— the hub's table and the draft form each carried their own — and a report is
one thing whichever screen names it. `draftSectionsForReport` is there for
the same reason: the form and the page both ask "what is still owed" about
the same draft, and two mappings from a stored row to `DraftFacts` is how
they come to disagree.
