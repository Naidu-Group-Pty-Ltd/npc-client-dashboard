# Client-facing deployment mode

One codebase, two deployments. The internal operations console runs with
everything on; a **client-facing deployment** builds with
`VITE_CLIENT_FACING=true` and hides the developer/operator tooling from the
front-end. The client-facing repository
(`npc-client-dashboard`) is a mirror of this one with that flag committed —
it carries no code of its own, so changes land here first and are pulled over.

## What the mode is, and is not

- **It is presentation.** Module permissions, workspace entitlements and the
  edge functions' own auth checks decide *access*, exactly as before. The flag
  removes surfaces from navigation and routing; it grants and revokes nothing.
- **It is build-time only.** Unlike `editorV2Flag` / `templateLibrary` there is
  deliberately no `?param` or localStorage override: the point of a
  client-facing build is that a visitor cannot flip the operator tooling back
  on from the address bar.
- **It never touches the pipelines it hides the controls for.** Hiding the
  Integrations page does not disturb the Make.com → Airtable
  **Property Intake Master** intake (that runs server-side and never depended
  on this UI); hiding the Airtable Sync card on `/automation` stops nobody's
  scheduled sync. Nothing server-side reads this flag.

## The one list

`src/lib/clientFacing.ts` holds `CLIENT_FACING_HIDDEN_PATHS`. Both halves of
the mode read it, so what is unlinked and what is unroutable cannot drift:

- **Navigation** — `useNavigationVisibility` (`src/hooks/useNavigation.ts`)
  filters items by URL. That one hook feeds the desktop sidebar, mobile
  sidebar, bottom bar and the ⌘K command palette (including `paletteOnly`
  items, which never had a sidebar entry to lose).
- **Routing** — `ClientFacingGate` (`src/components/auth/ClientFacingGate.tsx`)
  wraps the dashboard outlet in `DashboardLayout`, so a typed URL or stale
  bookmark lands on a quiet "not available on this dashboard" screen rather
  than the tool. This also covers the internal routes that carry no
  `ModuleGuard` at all (`/admin/report-engine-inspector`,
  `/integrations/ghl-migration`, …).

A path is hidden when it equals an entry or sits beneath one. Matching is by
path segment, never raw string prefix.

## Hidden beyond the list (component-level)

Some developer tooling lives *on* client-relevant pages, so it is gated where
it renders, always through `isClientFacingDeployment()`:

| Surface | Where |
| --- | --- |
| Test Numbers / Flush Test Calls, contact-name backfill | `src/pages/CallLogs.tsx` |
| Data-integrity debug panel | `src/pages/Overview.tsx` |
| Airtable Sync card (Dry Run / Sync Now / Clear Queue) | `src/pages/Automation.tsx` |
| Comparison-score migration card | `src/pages/Settings.tsx` |
| "Change model" deep-link into the Model Hub | `src/components/agentModels/ModelUpgradeButton.tsx` (self-gates, so all six pages that mount it are covered) |
| Pricing mock (A$1 Stripe test catalogue) | `src/lib/pricingMock.ts` — forced off, banner and CTA rewrite both; a shared `?pricingMock=1` link must not sell a tier for a dollar |

## Deliberately NOT hidden

Business features a client workspace runs itself, whatever group the sidebar
files them under: the Templates management page, Branding/White-label,
Settings, User Management, the portal admin pages, the report-generation
switches on `/automation`, and the AML compliance workspace (role-gated on
its own axis). Superadmin-only cards that already hide themselves by role
(entitlement diagnostics, Mission Control key) keep that behaviour — the
operator debugging a client workspace still needs them.

## WIP cherry-pick candidates

While the client-facing surface is being perfected, this branch also carries
a menu of borderline surfaces, **one commit each**, so any can be kept or
dropped independently (`git revert <sha>` removes the entry together with its
test — the PR description lists the shas):

- Data Import, Depreciation Comps admin, Figma Templates admin, Activity
  Logs, the Aurixa agent internals (`/agent/*`, `/agent-insights`), the
  Market Q&A ops pages, the finance portal health diagnostics, the template
  authoring cluster (`/admin/template-builder/*`), AML Launch Operations,
  the whole Automation page, Billing/Support/Feedback, the portal admin
  consoles + user provisioning, and the two unguarded routes
  (`/commissions`, `/reports/analytics`) — path-list entries in the marked
  candidates section of `CLIENT_FACING_HIDDEN_PATHS`.
- The Market News "Test AI route" shortcut, the live model badges/chips, the
  AML "Seed pre-commencement" button, and the three commercial banners —
  component-level gates.

Once the picks settle, the survivors fold into the main list above and this
section goes away.

## Bundle trimming (not visibility)

Three changes reduce what is *shipped*, rather than what is *shown*. They are
separate commits from the hides, and the first two help the internal build too:

- **Four operator pages were static imports** in `App.tsx` while every other
  route is lazy, so they sat in the entry chunk and downloaded on first paint
  for everyone. Now `lazyWithRetry`: entry chunk 4,680.82 → 4,559.79 kB.
- **Two constants were written into source**, and therefore into every build's
  bundle: two real staff mobiles in `CleanupTestCalls`, and a hardcoded
  project ref that pointed the Integrations help link at the *prime's*
  Supabase dashboard. Both now come from the environment.
- **Five route chunks are no longer built at all** in a client-facing build —
  Integrations, Workflow Playground, Model Hub, Cloudflare, API Usage. Hiding
  a route does not stop its chunk being served, and these carry the vendor and
  infrastructure vocabulary (the 143-entry registry with its Supabase secret
  names, the model roster, billing internals). The `__CLIENT_FACING__`
  build-time define inlines as a literal so Rollup drops the `import()` (it is
  five `__EXCLUDE_*__` constants now, one per page, so an allowance can keep a
  named page while the rest stay out).

  This bullet used to end "**use the define only to keep a module out of the
  bundle**; `isClientFacingDeployment()` remains the API for conditional
  rendering, because it is testable and the define is not." That separation is
  what let the two halves of one decision disagree for months — see *The flag is
  ONE constant* below. `isClientFacingDeployment()` now returns the define, and
  is still testable: its fallback is exercised and a source scan pins the rule.

- **The project this build talks to is now a setting**, and it never was: 31
  source files wrote `https://dduzbchuswwbefdunfct.supabase.co` and its
  publishable key into their own module scope, so `VITE_SUPABASE_URL` moved
  nothing. All 31 now import from `src/integrations/supabase/env.ts`, the one
  module that resolves it. A build that sets neither variable behaves exactly
  as before — the prime is still the built-in fallback — so this is a no-op
  upstream and a switch here. See `BACKEND_PROVISIONING.md`.

## The flag is ONE constant (and once was two)

`isClientFacingDeployment()` returns `__CLIENT_FACING__`, the `define`
`vite.config.ts` folds in. That is the whole mechanism, and it is worth saying
why it is stated so firmly.

The function used to read the environment instead:

```ts
resolveClientFacingFlag((import.meta as { env?: … })?.env?.VITE_CLIENT_FACING)
```

which looks equivalent and is not. The TypeScript cast sends the expression
through esbuild's TS transform, which lowers the optional chain into
temporaries — `(_a = import.meta) == null ? void 0 : _a.env` — so the token
`import.meta.env` no longer exists by the time Vite substitutes it.
`import.meta` survives into the browser, where it carries `url` and `resolve`
and **no `env` at all**, so the expression is `undefined` and the flag is
`false`. Written plainly as `import.meta.env.VITE_CLIENT_FACING` it would have
folded correctly; the cast was the bug, not the idea.

Nothing reproduced it. The dev server, `vitest` and every SSR-ish consumer give
`import.meta` a real `env`, so the mode worked everywhere except in a built
bundle — and the built bundle is the only place it matters. Measured on the
deployed `npc.aurixasystems.com.au` bundle: `bw()` carried the lowered
expression verbatim, and all five `__EXCLUDE_*__` chunks were correctly absent
beside it.

What that cost, on every client-facing build ever deployed:

- **The navigation filter never engaged** — `useNavigationVisibility` asked a
  flag that answered `false`, so the sidebar, mobile sidebar, bottom bar and
  command palette all listed every operator tool.
- **`ClientFacingGate` waved every hidden URL through**, including the routes
  that carry no `ModuleGuard` at all.
- **Every component-level gate in the table above rendered its control** — Test
  Numbers, the data-integrity debug panel, the Airtable Sync card, the pricing
  mock.
- **And the one visible symptom**: `/integrations` resolved to
  `RouteExcludedFromBuild`, which was `() => null`, because the build half of
  the decision HAD worked and dropped the chunk. The page drew a blank content
  area — no title, no cards, no explanation — which reads as broken rather than
  as withheld.

Three things hold it now. The runtime reads the folded constant, so the two
halves cannot disagree. `RouteExcludedFromBuild` renders the gate's own
`NotOnThisDeployment` notice, so a route with no chunk explains itself whatever
the flag says. And the rule is asserted rather than trusted —
`src/lib/__tests__/clientFacing.test.ts` fails if `clientFacing.ts` names
`import.meta` outside a comment, `scripts/check-clone-invariants.sh` repeats it,
and `src/lib/__tests__/routeExclusionGates.test.ts` cross-checks every
`__EXCLUDE_*__` against the hidden-path list.

## Keeping one named page on a deployment

`VITE_CLIENT_FACING_ALLOW` is a comma-separated list of entries from
`CLIENT_FACING_HIDDEN_PATHS` that this build keeps. An allowance can only give
back something the list took: a path that is not in the list verbatim is
ignored, so a typo cannot name a surface nobody reviewed, and a child with its
own entry (`/admin/finance-portal/health`) keeps its own decision when the
parent is allowed.

It has to reach **both** halves of the mode or it is a trap — a routable page
whose chunk was never built is exactly the blank screen above — so
`vite.config.ts` parses it once and derives the runtime list
(`__CLIENT_FACING_ALLOW__`) and each `__EXCLUDE_*__` from that one value.
Allowing a path therefore also re-admits its chunk, which for these five is the
point of hiding them; weigh that before adding one.

This repository pins `VITE_CLIENT_FACING_ALLOW` in `vite.config.ts`, beside the
pinned mode and for the same reason — an exception in the repository can be
diffed and reverted in one line, where one in a hosting console cannot. It
currently names three paths:

| path | why |
| --- | --- |
| `/integrations` | **Temporary.** The GoHighLevel cutover is being tested on this deployment and that test types a credential into the page. The one entry here with a cost: allowing the path re-admits the page's chunk (the 143-entry registry and its Supabase secret *names*, never values). |
| `/billing` | This workspace sees its own subscription. The list hides it on the reading that billing is the operator's relationship with the workspace; that reading is wrong for this tenant. Covers the legacy `/billing/usage` redirect too. |
| `/admin/users` | This workspace administers its own seats, for the same reason. |

Neither `/billing` nor `/admin/users` is chunk-gated, so those two cost the
bundle nothing. Every other hidden page stays hidden and the four remaining
excluded chunks stay unbuilt.

Overriding here rather than editing `CLIENT_FACING_HIDDEN_PATHS` is deliberate:
the list is what the mode means for *every* client-facing deployment, and one
tenant's answer is not that.

## Which Supabase project the build talks to

A second deployment usually wants a second backend, and that used not to be
possible for a reason unrelated to this mode: **31 source files wrote
`https://dduzbchuswwbefdunfct.supabase.co` and its publishable key into their
own module scope** — `useAuth`, `secureInvoke`, `integrations/supabase/client`,
every portal hook and lib — so setting `VITE_SUPABASE_URL` moved nothing.

All 31 now import from `src/integrations/supabase/env.ts`, the one module that
resolves it. A build that sets neither variable is byte-for-byte the old
behaviour, so this changed nothing about the internal console.

Three rules that module enforces, each of which was a live defect:

- **The URL and the key are a matched pair.** The anon key is a JWT whose `ref`
  claim names its project, so a URL from one and a key from another
  authenticate to nothing. Set both or neither — a half-configured environment
  uses *both* built-in defaults rather than mixing them, and says so on the
  console. A genuinely mismatched pair is honoured and warned about by ref,
  because that is a configuration error and should read as one.
- **The fallback is never empty.** `internalMessageAttachments.ts` read
  `VITE_SUPABASE_URL ?? ''`, which made the upload PUT relative — it went to
  the app's own origin and got HTML back.
- **The project ref is derived, never named a third time.**
  `VITE_SUPABASE_PROJECT_ID` was a third spelling of the same project, free to
  disagree with the other two; unset, `TemplateSharePreview` fetched
  `https://undefined.supabase.co/functions/v1/template-share`. Nothing live
  reads it now — `SUPABASE_PROJECT_REF` comes off the resolved URL, and the
  Integrations page's "Supabase dashboard" link is built from it rather than
  sending every deployment's operator to the prime's project.

## Syncing from upstream

This repository carries no code of its own: changes land in
`npc-property-dashbord` and are pulled over.

### The merge below does not run, and why

```sh
git merge-base origin/main upstream/main    # exit 1 — no common ancestor
```

**The two repositories have unrelated histories.** `main` here is two commits
deep and its root commit has no parents: PR #13 was SQUASH-merged, which
discarded the ancestry the merge needs. `git merge upstream/main` now demands
`--allow-unrelated-histories` and then conflicts on essentially every file.

That is not a small inconvenience — it is why this repository silently fell 159
files behind between 20 and 26 August. The procedure looked correct, nobody ran
it, and nothing reported that it could not be run.

### The branch that must not be deleted

`claude/npc-dashboard-client-facing-zq1md2` on THIS repository still holds
**19,643 commits** of pre-squash history — the prime's full lineage, ending at
the commit PR #13 squashed. It is the only surviving link between the two
histories.

**Do not delete it, and do not force-push it.** A future sync based on that
branch can be a real `git merge upstream/main`, because it shares ancestry with
the prime; a sync based on `main` cannot, and has to be the tree-apply below. It
is cheap to keep and impossible to recreate.

`origin`'s fetch refspec was also narrowed to `+refs/heads/main:…` at some
point, so no branch except `main` had a remote-tracking ref and no branch could
be tracked. Restored to `+refs/heads/*:refs/remotes/origin/*` on 26 Aug; if
branches stop appearing after a fetch, check that first.

### Syncing as a tree-apply

Until a sync is based on the bridge branch, take upstream's content path by path
and restore this repo's side afterwards:

```sh
git fetch upstream main
git diff --name-status origin/main upstream/main       # what moved
# check out every changed path EXCEPT the protected list below, then:
git checkout origin/main -- <each protected path>
```

Held back every time — the list is stable, and the 26 Aug sync needed exactly
these:

| Keep this repo's side | Why |
| --- | --- |
| `supabase/config.toml` | names THIS project |
| `vite.config.ts` | pins the client-facing build mode |
| `vercel.json` | the two repos deploy differently on purpose |
| `.env.example`, `src/integrations/supabase/env.ts` | this deployment's Supabase pair |
| `deploy-supabase-functions.yml`, `apply-migration.yml` | the fail-closed guards |
| `.gitignore` | keeps `supabase/.temp` out |
| this document | — |
| `src/App.tsx` | upstream has 0 `RouteExcludedFromBuild` and 0 `__CLIENT_FACING__` gates; this repo has 6 and 5. Compare the ROUTE SETS before keeping this side — they were 194 = 194 in August, and a route only upstream has must be brought over by hand |
| `src/lib/clientFacing.ts` + its test | 46 hidden paths here against upstream's 24. Upstream's test asserts `/billing`, `/admin/users` and `/admin/template-builder` stay VISIBLE, which this repo deliberately contradicts |
| `src/components/call-logs/CleanupTestCalls.tsx` | reads `VITE_TEST_CALL_NUMBERS` (see below) |
| `src/client-facing.d.ts` | declares `__CLIENT_FACING__`, in a file that exists ONLY in this repository. It used to live in `src/vite-env.d.ts`, which upstream also has — so taking upstream's version deleted the declaration and `App.tsx` stopped type-checking with five `TS2304: Cannot find name '__CLIENT_FACING__'`. That bit during the 26 Aug sync, was repaired in place, and the next cascade deleted the repair again — a fix inside a file the cascade owns does not survive. A cascade never deletes a clone-only file, so the declaration now rides out every sync and `src/vite-env.d.ts` is free to track upstream. (The 26 Aug bite was also invisible for an hour because the typecheck was run through a pipe, so `$?` was `tail`'s exit code and always 0. **Run `tsc` without a pipe and read its own exit status.**) |

**Never take `supabase/.temp/linked-project.json`.** It is TRACKED upstream and
holds the prime's project ref; `backendIsolation.spec.ts` asserts it stays
untracked here. Bringing it over re-arms a defect this repo has already removed
once.

`CleanupTestCalls.tsx` was on that list because upstream hardcoded two real
staff mobiles while this repo read them from the environment. That fix was
cherry-picked UPWARD on 26 Aug, so the two should now agree — if a future diff
shows them differing again, check which direction moved before assuming.

Then run `npm ci && npx tsc --noEmit -p tsconfig.app.json` and compare the
error output with upstream's. **They should be identical.** Any error only
here is drift, and drift is the thing this repository cannot afford — it is
supposed to differ from upstream in exactly the ways listed in this document
and no others.

What to expect, and how it has actually gone:

- **Conflicts land in the same handful of files**: `.env.example`,
  `.gitignore`, `vercel.json`, `supabase/config.toml`, and whichever page
  upstream and this repo fixed the same way. Everything in `src/` merges.
- **Keep this repo's side** for `supabase/config.toml`'s `project_id`, the
  fail-closed workflow guards, `vite.config.ts`'s pinned mode, and
  `vercel.json` — that last one because the two repositories deploy
  differently on purpose (upstream serves the SPA alone; this one also runs
  the AML verification container, in the spelling upstream's own
  `docs/deployment/VERCEL.md` calls the only correct one).
- **Take upstream's side** for everything else, including a tidier spelling of
  a fix that landed in both.
- **Check for new surfaces.** A merge brings code, not visibility decisions:
  `git diff <base>...upstream/main -- src/lib/navigation/registry.ts src/App.tsx`
  shows whether upstream added a route or a nav entry that belongs in
  `CLIENT_FACING_HIDDEN_PATHS`. The August 2026 sync of 93 commits added
  neither.
- **Do not let dependencies drift.** Dependabot majors merged here alone once
  broke the typecheck in 36 places while upstream stayed green — every date
  picker and the whole PDF-import grounding path. Align `package.json` to
  upstream's versions unless there is a recorded reason not to.

`scripts/` carries a 28-point invariant check used for this: it asserts the
pinned build mode, the hidden-path list and its WIP candidates, the backend
isolation properties, the stripped constants and the single Supabase resolver.
Run it before and after every sync.

## Adding to (or trimming) the list

Edit `CLIENT_FACING_HIDDEN_PATHS` — nav and routing follow together.
`src/lib/__tests__/clientFacing.test.ts` cross-checks the list against the
navigation registry both ways: the named operator tools must be hidden, the
client features must not be, and with the flag off nothing changes at all.
