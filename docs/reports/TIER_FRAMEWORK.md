# The Reporting Tier Framework — one record, six renderings

Signed off 2026-09-05. This is the locked architecture for every reporting
tier; the derivation audit that grounds it is
`REPORTING_ENGINE_AUDIT_2026_09.md` (§19 records Phase 1's implementation,
§20 Phase 2's).

**The doctrine in one sentence:** figures are typed from the record, prose is
written about the record, structure is selected from one registry — and a tier
is a depth setting, not a different machine.

## The five laws

1. **Every number is typed from the record; a model never writes a figure.**
   Authored prose may discuss a figure it was handed, never introduce one.
2. **A labelled row is a promise that a figure follows it.** Absent means the
   row is omitted and coverage disclosed — no N/A, TBD or placeholder, in any
   tier, ever.
3. **One registry is the constitution.** Structure is selected by section id,
   never by matching heading strings; a declared section with no producer
   fails CI. (Shipped — `_shared/reports/investment/sectionRegistry.pure.ts`.)
4. **Derivation reads the record, not the sibling document.**
5. **The template owns presentation and nothing else.** White-label changes
   tokens and page furniture; figures, sections and conclusions survive
   byte-identical across any template, and identity comes from the row.

## Provenance classes

Every fact carries one, and the class decides its validation and where it may
appear: **Measured** (external service, stamped source + date — Domain, ABS,
RBA, SEIFA, crime, employment, climate, SQM, risk), **Computed** (an engine —
financialEngine, stampDuty, investmentScoreEngine — validated by identity
checks), **Recorded** (facts of the engagement — specs, overrides, client),
**Authored** (model commentary, fact-checked against the record,
schema-constrained with no numeric fields). A table cell may hold only
Measured/Computed/Recorded values.

## The tiers

| Tier | Pages | Promise | Substance |
|---|---|---|---|
| Snapshot | 4–6 | "Should I look closer?" | spine + typed tables; zero model calls at assembly |
| Briefing | 10–14 | "The case in ten minutes" | condensed location case + composed financial tables + typed SWOT |
| Compass (Primary) | 20–26 | "Why this property, here" | the foundation; the only place narrative is generated |
| Financial Analysis | 14–18 | "Can I hold it, what does it return?" | chapters composed from `financial_calculations` |
| Due Diligence (stored `strategic`) | 18–24 | "What must be verified before contract" | property/location risk at depth + verification register |
| Comparison | 12–18 | "Which one?" | Computed metric matrix; model authors only the relative judgement |

The spine — mandatory in every tier: cover + report identity, verdict with
score/grade/coverage, property identity table, key-figures strip, provenance
+ disclaimer.

## The registry

`supabase/functions/_shared/reports/investment/sectionRegistry.pure.ts` is the
depth matrix as a module: 38 sections, each with its provenance class, the
headings production has actually carried for it, and a placement per tier
giving depth, order, label, surface and **producer**. Read its header before
changing it. Four things it expresses that a list of headings cannot:

- **A tier renames a section.** The label belongs to the placement, not the
  section — one "purchase and holding costs" section is spelled three ways
  across the generator, FIN and the briefings production holds.
- **A tier merges sections.** The Compass draws one `Demand Drivers` where Due
  Diligence draws four; `depth: 'merged'` with `mergedInto` says so. That fact
  lived in a code comment, which is why the compass-40 engine shipped a report
  carrying the *unmerged* v2.0 sections and nothing noticed.
- **A section is not always markdown.** The cover, property identity table and
  key-figures strip are drawn by the template from the binding projection.
- **A declaration is not a producer.** Every `spine` and `required` placement
  names what makes it — a composer, an authoring guide, a split-registry route,
  or a projection namespace — and `sectionRegistry.spec.ts` resolves each one by
  running it. Gaps are frozen in `PRODUCER_GAPS`, which can only shrink.

Two rules bite. **Nothing routes on the registry yet** — Phase 3 assembles from
it and deletes heading matching; Phase 2 makes the other definitions *checked
against* it, so `reportSplitRegistry` and `compassSectionRegistry` can drift only
by failing CI. And **a producer that resolves is not a section that appears**:
the Due Diligence tier's routed producers are all correct and still put
`Planning, Zoning and Title Due Diligence` on 1 of 11 documents, because routing
depends on the *parent* carrying a matchable heading. That is law 4's problem
and Phase 3's fix.

## Locked decisions

- **A — the Compass verdict page keeps the key-figures strip** (price, rent,
  gross yield, weekly position): four Computed facts, not modelling. Detailed
  modelling stays in the Financial tier.
- **B — "Strategic" is renamed the "Due Diligence Report"** everywhere a
  person sees it; the stored value `strategic` remains as an alias. (Lands
  with the tier's own cover identity in Phase 4.)
- **C — Primary only.** Every tier and every scope generates on the Primary
  engine; suburb/postcode/statewide get their own Primary-mode registry
  (Phase 4), and the generator's `legacy` branch is deleted once every scope
  has a producer (Phase 5). Forward rule: historical `legacy` rows stay as
  delivered.

## Build order

1. **Stop the wrong documents** (§19 — shipped): Financial chapters composed
   from the record; Briefing guide re-cut; placeholder scrub + label strip +
   snapshot trim on every derived output; DD scorer fixed; verdict sentence
   composed and guarded (template v12); engine + scope stamped on children.
2. **One registry** (§20 — shipped): the tier matrix as a module with a
   producibility test; the six competing structure definitions subordinated to
   it; the dead `TIER_CONFIG` section lists deleted; the Briefing trimmed to its
   own structure and given the sources section its tier promises.
3. **Sectioned record** — per-section storage + abstracts; assembly by id;
   heading-string matching deleted. *In progress (§21): resolution and the
   partition primitive are in; storage and assembly are not.*
4. **Tier formats** — Financial/Due Diligence/Briefing/Snapshot as first-class
   formats with proportional shells; the suburb-scope Primary registry;
   decision B's rename.
5. **Comparison & the gates** — store what the comparison asks for, stamp its
   scale, one render path; the five validation gates (input, record, section,
   assembly, render) as CI-tested modules; delete the legacy branch.
