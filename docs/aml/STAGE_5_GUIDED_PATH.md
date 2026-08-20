# Stage 5 — the guided path

Stage 5 had every fact it needed and no order. This is the order.

## What it replaced

The stage rendered every true thing it knew at once, with equal weight: a
next-action card, an alert repeating it, a second next-action card repeating
it again, a classification prompt, a screening scope, a required-determinations
list, a not-required collapse, a perimeter statement, an answers collapse, a
people list, a party panel carrying two more buttons for the same act, an empty
checks panel and an ownership panel.

On `AML-2026-00005` all of it reduced to **one act** — record a PEP
determination for one party. "Record PEP determination" appeared **four times**
in four sets of words, and nothing said that everything else was already
settled.

Nothing there was wrong. What was missing was ORDER.

## The shape

`screeningSteps.pure.ts` arranges the same server-decided facts as the steps of
one path; `ScreeningPathCard` renders them, one line each until a step is the
one being worked. Everything the stage showed before is still there, behind
**Show the full screening detail**.

| # | step | settled when |
| --- | --- | --- |
| 1 | Confirm what this case is | a perimeter classification is recorded |
| 2 | Confirm who must be assessed | at least one party is enrolled |
| 3 | Screen for targeted financial sanctions | the scope's own outcome is settled |
| — | Adverse media / watchlists | *only appears when one is actually owed* |
| 4 | Record the PEP determination | recorded for every party in scope |
| 5 | Resolve what screening found | no candidate is outstanding |

## Four rules carry it

**It derives nothing new.** Obligation, method and outcome all come from
`buildDeterminationRows`, which reads the server's per-scope decision. A browser
reaching its own conclusion would be a second compliance engine, and the two
would drift on the day it mattered.

**`not_required` is not `done`.** A step nobody owes settles the path but is
never ticked, never counted as work done and never described as a result: it
renders `—` rather than a check, and says in words that nobody was screened and
nobody was cleared. This is the same distinction the determination rows carry,
and the reason Stage 5 exists in this shape.

**The server owns "what next".** When `next_action` maps onto a step
(`ACTION_STEP`), that step is the open one whatever the local ordering would
have said. The spine can be wrong about order; it must never ask for something
the server is not asking for.

**A closed case has no current step.** It leads with the retained record and the
authorised reopen — a numbered next step on a case that is not progressing
asserts a journey that is not happening.

### Two things that bit while building it

- **`record_pep` was missing from the reviewer-or-MLRO list** in
  `screeningActionAccess`, so it fell through to `canWrite` and an **analyst**
  was shown the one button Stage 5 was asking for — while
  `record_pep_determination` answers a non-reviewer with 403. That module exists
  to prevent exactly this. `screeningActionAccess.test.ts` now reads the edge
  function's own role guards rather than trusting a hand-kept list.
- **A candidate is not a finding.** The first cut announced "a screening finding
  is recorded on this case" whenever the resolve step was blocked — which is also
  true of a candidate nobody has looked at yet. `path.finding` is a **confirmed**
  match and nothing else.

### The step that is outstanding without blocking

A reopened enquiry gets its own state, `review` — "Confirm this still holds".
The recorded perimeter finding **stands** (nothing is inferred from a reopen),
so it does not block; but it is not settled either, because the whole sanctions
obligation hangs off it. It is raised in sequence rather than left at the foot
of the page for somebody to know to look for.

## The political-exposure declaration

The client portal asked *"Are you a Politically Exposed Person (PEP)?"* with two
radio buttons and no explanation, and stored a bare `yes`/`no`.

That is close to useless in both directions. A customer who has never met the
term answers "no" to a phrase they do not know — and the definition they were
never shown covers **immediate family members and close associates**, which is
exactly what that question never reaches. A customer who answers "yes" tells the
MLRO nothing they can act on, so the determination cannot start without going
back to ask what should have been asked once.

Whatever they answered then reached the command centre only as
`personal_details.pep` inside the policy's material inputs — one collapse down,
as the string `no`. **The person making the determination could not see what the
person it is about had said.**

Now: the portal explains the three limbs in plain words and asks the position,
the jurisdiction and the relationship when the answer is yes; `readPepDeclaration`
reads it; `sync_screening_stage` returns it as `pep_declaration`; and the PEP step
renders it in its own block, labelled as the customer's declaration.

Four rules hold it:

- **A declaration is evidence. It is never a determination.** Nothing in
  `pepDeclaration.pure.ts` records one, prefills a conclusion or changes an
  obligation, and a test asserts the module never mentions `pep_determinations`.
- **The stored answer is still `yes`/`no`**, so `screeningPolicy.pure.ts` is
  untouched — a test asserts the policy still cannot see the new fields.
- **An unanswered question reads as unanswered**, never as a "no". A customer who
  was never asked is not a customer who declared no exposure.
- **A corrected answer leaves nothing behind.** `prunePepDeclaration` drops the
  detail in the same state write that changes the answer, and again at the write
  boundary — a field nobody can see is still a field that saves.

The relationship vocabulary is deliberately the same triple
`record_pep_determination` accepts, so a reviewer can compare what the customer
said with what they concluded without translating it by hand. That is not
prefilling: the conclusion is still theirs to reach.

### Why the prune lives in `questionnaireValidation.ts`

`aml-client-portal/index.ts` is held to a contract that **no line of its code may
mention risk, screening, PEP or sanctions** (`amlPortalContracts.test.ts`) — a
blunt rule, deliberately, because the portal must never become a surface that
returns screening detail to a customer. Pruning a declaration travels the other
way, but the guard cannot tell one from the other and should not have to. So the
write boundary owns both prunes behind `normaliseQuestionnaireSection`, and the
caller applies one neutrally-named rule.

## The deployment order is not interchangeable

`aml-cases` and `aml-client-portal` change here, and only ONE of them may ship
ahead of the front end.

`aml-cases` adds `pep_declaration` to the `sync_screening_stage` response. That
is purely additive — a browser that has never heard of the field ignores it —
so it is safe to deploy at any time.

**`aml-client-portal` is not.** Its validation now refuses a declared exposure
that does not name the position, the jurisdiction and the relationship, and the
inputs that collect those three ship with the SPA. Deploy the function ahead of
the site build and a customer who answers "yes" is blocked at submit, on three
fields the page they are looking at does not contain.

Measured on 2026-08-19: both functions were deployed from the branch before
merge, the hazard was spotted in review, and `aml-client-portal` was
redeployed from `main` within four minutes. The rule that follows is simply:
**a validation the customer's own page cannot satisfy ships with that page,
never before it** — which the ordinary merge does by itself, since the deploy
workflow and the site build both run off `main`.

## Verified in a browser, not only in jsdom

`tests-e2e/stage5-path` builds the real component and measures it at 1280, 1366,
1440, 1920 and 390: one open step, one button, settled steps under half the open
one's height, no sideways scroll, and the whole list inside a 900px viewport
(763px measured — it was over 820px until the obligation/method/outcome grid was
folded). jsdom has no layout, and the complaint this answers was visual.

Run with `npm run test:e2e:stage5-path`.
