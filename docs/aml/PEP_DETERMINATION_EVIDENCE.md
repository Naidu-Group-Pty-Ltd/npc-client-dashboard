# The PEP determination — what it rests on

Read this before touching `_shared/aml/pepEvidence.pure.ts`,
`src/lib/aml/pepSearchLinks.pure.ts`, `PepDeterminationDialog`, or the
`record_pep_determination` / `defer_pep_determination` operations in
`aml-cases`.

Stage 5 asks two different questions and they are answered in two different
places. Sanctions screening is a **match against a register**, run by a
provider or by an MLRO by hand
([`SCREENING_EXECUTION.md`](./SCREENING_EXECUTION.md)). A politically-exposed-
person determination is a **conclusion a person reaches**, and there is no
register that settles it. This document is about the second one.

## The standard

The statutory test is that the reporting entity establishes the position **on
reasonable grounds**. AUSTRAC reads that as an objective standard: somebody in
the same position, reviewing the same material with similar experience, should
be capable of reaching the same conclusion.

There is no prescribed form, no mandated database and no mandated sequence.
What there is, is a record that has to show **how** the conclusion was
reached — which sources were consulted, what was searched, and what came back.
That is exactly the part the old flow did not collect.

## What was wrong

A generic prompt dialog with two free-text boxes. Three faults, and none of
them was a line of code:

**1. It had already decided the answer before it opened.** The stage CTA
called `recordPep(subject, "not_pep")`, so pressing a button labelled "Record
PEP determination" opened a dialog headed "Record not-PEP determination". The
conclusion *is* the determination. An operator who had found a PEP had to
cancel and hunt for the other button, and a pre-selected "not a PEP" is the
one default this product cannot carry.

**2. Its own worked example of a source was a sanctions register.** The
placeholder read `DFAT consolidated list — screened via case screening`. The
DFAT Consolidated List is a **targeted financial sanctions** register. It is
the authoritative Australian source for sanctions and it is not a PEP register
of any kind, so absence from it is not evidence about political exposure — and
the product was teaching operators to write exactly that down.

The asymmetry matters, because the instinct is not silly. A sanctions **hit**
is genuine evidence *towards* exposure: designation lists are full of
ministers, officials and state-enterprise directors. A sanctions **miss** says
nothing at all. A source that can only ever support the negative conclusion is
a source that can only ever mislead. So a sanctions list is **refused** as a
PEP source, and a live sanctions match is surfaced **separately**, as a signal
the determination must consider — `sanctionsSignalForPep` speaks for
`confirmed` and `candidate` and is deliberately **silent** for "screened, no
match".

**3. There was nowhere to say "I could not tell".** The dialog offered two
outcomes, both of them determinations. An operator who had reached the end of
the available checking and was not satisfied had to pick one anyway, which is
how an unfounded conclusion gets written down.

## The shape now

Three numbered steps, all on screen at once. This is a checklist, not a
wizard: an operator writing down why a conclusion is reasonable has to be able
to see what they found while they write it.

| | |
| --- | --- |
| **1 · What the customer told us** | Read-only, seeded as a source, labelled as a declaration. |
| **2 · Check the sources** | One click opens a source and adds the row; the operator records what was searched and what came back. |
| **3 · The determination** | Not a PEP · PEP (with category, relationship, office, jurisdiction and *currently held*) · **Cannot determine yet**. |

The footer never scrolls and it **says what is missing** rather than leaving a
disabled button to be interpreted — `verdict.errors[0].message`, from the same
module the server enforces.

## The rules

**One rule, rendered and enforced.** `assessPepEvidence` lives in
`supabase/functions/_shared/aml/pepEvidence.pure.ts`. The dialog renders from
it and `record_pep_determination` enforces it at the write boundary, so what
an operator is asked for and what the server accepts cannot become two
standards. `src/lib/aml/pepEvidence.ts` is a re-export and nothing else.

Above the statutory floor it holds three Aurixa controls:

- **A sanctions register is not a PEP source.** Matched case-insensitively
  against the source *and* the reference. The term list is deliberately small
  and explicit rather than a clever pattern — a broad regex would reject
  "register of members' interests, checked for a sanctions-related
  directorship", which is a perfectly good source.
- **At least one source independent of the customer.** Their own declaration
  is evidence towards the determination and never the whole of it; it is the
  thing being tested. It is seeded so nobody retypes it, and it is counted
  separately so it can never stand alone.
- **A searched source must say what came back.** "Checked the Government
  Directory" is not a record of a check. "Checked the Government Directory for
  <name> — no entry" is. A declaration is not a search, so it is exempt.

**A deferral is not a third outcome.** `defer_pep_determination` writes **no**
determination row. It appends a case event carrying the reason, what is needed
and what was checked, stamped `determination_recorded: false` so no future
reader can mistake it for a conclusion. The scope stays outstanding and
Stage 5 stays open. `assessPepDeferral` requires a reason from the list and a
statement of what is missing, because "could not determine" reads, six months
later, exactly like nobody having tried.

**Leaving office is not an expiry date.** `holds_position_currently` is an
attribute of the determination, not a softer outcome. FATF and AUSTRAC treat a
former PEP on a **risk-sensitive** basis — there is no period after which the
status lapses — so the answer feeds the risk assessment rather than quietly
switching the controls off.

## The assisted search

`src/lib/aml/pepSearchLinks.pure.ts` builds **search URLs**. It performs no
request, reads no result and decides nothing. It removes the two minutes of
typing a name into four sites and the risk of searching a different spelling
in each; a person opens the source, looks, and records what they saw.

That is the compliance point rather than a disclaimer. **Nothing here can
return "no match", because nothing here matches anything** — a partial index
reporting "no match" is the confident-clear-against-nothing failure this
platform has already had once, with an empty `sanctions_entries`.

The sources are public and none requires a licence: the **Australian
Government Directory** (Commonwealth office holders, which AUSTRAC's own
guidance points at), the **Parliament of Australia** parliamentarian search
(the elected limb the Directory does not carry), **ABN Lookup**, and open-
source and media searches on the subject's own name. `pep_database` remains a
manual row precisely because this product has no such subscription, and
offering it in a dropdown would invite an operator to tick a source they never
used.

**What the searches do not reach is rendered beside them, every time.**
Foreign office holders are not comprehensively covered; family members and
close associates are not published anywhere and are reached by asking; and
somebody who has left a position may not appear in a current directory. An
operator who has run five searches and found nothing needs to know which parts
of the definition those searches never covered — otherwise "nothing found"
quietly becomes "nobody is exposed".

## One act is said once on a screen

The reported screen carried the same act three times — the stage header's CTA,
the numbered path's open step, and the rail's "Go to stage 5" — in three sets
of words, above **two** progress readings that counted different things ("2 of
3 items on this stage complete" beside "3 of 5 settled"). Both counts were
true, which is what made it worse than either alone.

`AmlJourneyStageHeader` takes `deferToSurfaceBelow` and
`AmlLivePositionRail` takes `currentSection`. The repeat is suppressed at the
header and the rail, **never at the path**, because the path is the surface
the work happens in and the header is the surface an operator orients by.
Every other stage, which has no such surface, behaves exactly as it did.

## Where the tests are

| | |
| --- | --- |
| the contract itself | `src/lib/aml/pepEvidence.test.ts` |
| the searches | `src/lib/aml/pepSearchLinks.test.ts` |
| the dialog, end to end | `src/components/aml/__tests__/partyScreeningPanel.test.tsx` |
| the endpoints hold the same rule | `src/lib/aml/amlScreeningRepair.contract.test.ts` |
| one act, said once | `src/components/aml/workspace/__tests__/oneActOnce.test.tsx` |
