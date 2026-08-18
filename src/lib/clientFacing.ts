/**
 * Client-facing deployment mode.
 *
 * One build of this dashboard serves two audiences: the internal operations
 * console (everything on), and client-facing deployments where the
 * developer/operator tooling — integration credential management, the workflow
 * playground, engine diagnostics, test-data controls — must not appear at all.
 *
 * The mode is decided per BUILD by `VITE_CLIENT_FACING` and nothing else.
 * Unlike `editorV2Flag` / `templateLibrary` there is deliberately no URL-param
 * or localStorage override: those exist so an operator can flip a feature for
 * one visit, and the whole point of a client-facing deployment is that a
 * visitor cannot flip the operator tooling back on from the address bar.
 * Default OFF — a build that never heard of the flag behaves exactly as today.
 *
 * This flag controls VISIBILITY, never data access. Module permissions,
 * workspace entitlements and the edge functions' own auth checks enforce
 * access independently of it; hiding a surface here changes no server
 * behaviour. In particular, hiding the Integrations page does not touch the
 * Make.com → Airtable "Property Intake Master" pipeline — that runs entirely
 * server-side and never depended on this UI being visible.
 *
 * Both the navigation filter (src/hooks/useNavigation.ts) and the route gate
 * (src/components/auth/ClientFacingGate.tsx) read the ONE list below, so what
 * is unlinked and what is unroutable cannot drift apart.
 */

/** Pure resolver so the truth table is unit-testable. Only an explicit opt-in enables the mode. */
export function resolveClientFacingFlag(envValue: string | boolean | undefined): boolean {
  return envValue === true || envValue === '1' || envValue === 'true';
}

export function isClientFacingDeployment(): boolean {
  try {
    return resolveClientFacingFlag((import.meta as { env?: Record<string, string | boolean | undefined> })?.env?.VITE_CLIENT_FACING);
  } catch {
    // An environment we cannot read is treated as the internal console: the
    // mode is a presentation choice, and access control does not rest on it.
    return false;
  }
}

/**
 * Path prefixes of developer/operator tooling. A path is hidden when it equals
 * an entry or sits underneath one (so `/integrations` also covers
 * `/integrations/ghl-migration`). Entries must start with `/` and carry no
 * trailing slash — a test enforces both.
 *
 * Deliberately NOT here (business features a client workspace runs itself):
 * templates and the template builder, branding/white-label, settings, user
 * management, the portal admin pages and automation.
 */
export const CLIENT_FACING_HIDDEN_PATHS: readonly string[] = [
  // Integration credential management (Supabase secrets, API keys) and the
  // automation canvas. Hiding these is UI-only: the intake pipeline they
  // describe keeps running untouched.
  '/integrations',
  '/workflow-playground',

  // Infrastructure & engine operations.
  '/cloudflare',
  '/model-hub',
  '/api-usage',
  '/monitoring',
  '/error-logs',
  '/quality-assurance',

  // Intake pipeline diagnostics (which mailboxes feed listings).
  '/sources',

  // Superadmin/engineering diagnostics under /admin.
  '/admin/token-audit',
  '/admin/report-engine-inspector',
  '/admin/pdf-import-engine',
  '/admin/pdf-import-diagnostics',
  '/admin/pdf-import-monitoring',
  '/admin/pdf-import-retention',
  '/admin/pdf-import-client-reports',
  '/admin/template-import-quality',
  '/admin/pdf-golden-regression',
  '/admin/market-qa-quality',
  '/admin/agent-quality',
  '/admin/bc-segment-engine',
  '/admin/reclassify-property',
  '/admin/aml-v3-cutover',
  '/admin/aml-integration-health',

  // ── WIP cherry-pick candidates ────────────────────────────────────────────
  // Each entry below landed as its OWN commit while the client-facing surface
  // is being perfected, so any one can be kept or dropped independently
  // (`git revert <sha>` removes the entry together with its test). Once the
  // picks settle, the survivors fold into the list above.

  // CSV upload into cache tables and directories — ops data loading.
  '/data-import',

  // Depreciation comparables reference-data curation.
  '/admin/depreciation-comps',

  // Figma template manager, raw compiled_schema JSON included.
  '/admin/figma-templates',

  // Audit trail with raw metadata JSON viewers and export. A workspace may
  // want its own audit visibility — this one is the likeliest to be dropped.
  '/admin/activity-logs',

  // Aurixa agent internals: memory store, plans, skills, insights. The chat
  // widget itself stays — these are the pages behind it.
  '/agent',
  '/agent-insights',

  // Market Q&A subscription/digest operations. Deliberately the two exact
  // pages and never a bare '/qa' — the public share links (/qa/shared/:token,
  // /qa/market/:slug) live outside the dashboard layout and must keep working.
  '/qa/subscriptions',
  '/qa/digests',

  // Cross-portal drift/orphan/staleness diagnostics. The rest of the finance
  // portal admin stays — this is the one engineering page among them.
  '/admin/finance-portal/health',
];

/** Whether a pathname belongs to the developer tooling listed above. */
export function isDeveloperToolPath(pathname: string): boolean {
  const normalised = pathname.replace(/\/+$/, '') || '/';
  return CLIENT_FACING_HIDDEN_PATHS.some(
    (prefix) => normalised === prefix || normalised.startsWith(`${prefix}/`),
  );
}

/**
 * The one question both nav and routing ask: given the current deployment
 * mode, may this path be surfaced? Split from `isDeveloperToolPath` so tests
 * can exercise the list without stubbing the environment.
 */
export function isPathVisibleInDeployment(pathname: string, clientFacing: boolean): boolean {
  return !(clientFacing && isDeveloperToolPath(pathname));
}
