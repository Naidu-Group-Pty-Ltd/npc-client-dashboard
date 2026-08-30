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
