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
  build-time define inlines as a literal so Rollup drops the `import()`.
  **Use the define only to keep a module out of the bundle**;
  `isClientFacingDeployment()` remains the API for conditional rendering,
  because it is testable and the define is not.

- **The project this build talks to is now a setting**, and it never was: 31
  source files wrote `https://dduzbchuswwbefdunfct.supabase.co` and its
  publishable key into their own module scope, so `VITE_SUPABASE_URL` moved
  nothing. All 31 now import from `src/integrations/supabase/env.ts`, the one
  module that resolves it. A build that sets neither variable behaves exactly
  as before — the prime is still the built-in fallback — so this is a no-op
  upstream and a switch here. See `BACKEND_PROVISIONING.md`.

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

## Adding to (or trimming) the list

Edit `CLIENT_FACING_HIDDEN_PATHS` — nav and routing follow together.
`src/lib/__tests__/clientFacing.test.ts` cross-checks the list against the
navigation registry both ways: the named operator tools must be hidden, the
client features must not be, and with the flag off nothing changes at all.
