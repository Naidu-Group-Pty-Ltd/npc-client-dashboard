/**
 * Builder / Developer Portal — presentation and white-label contract.
 *
 * The Builder Portal now shares the Solicitor Portal's design architecture: the
 * same split authentication layout, consent wall, onboarding wizard, sidebar,
 * top bar, drawer, page hero and dashboard hierarchy — and, more importantly,
 * the same white-label branding source, so a change in the Command Centre
 * Branding tab moves both portals identically.
 *
 * None of that was allowed to move anything underneath it. These assertions
 * hold both halves at once: that the chrome and the branding are shared, and
 * that the operations, payload fields, query hooks, routes, guards and server
 * files are not.
 *
 * Several assertions read the Solicitor source as well as Builder's. They are
 * read-only: their purpose is to fail if the two ever drift apart, so parity is
 * checked against the canon rather than against a copy of it frozen here.
 *
 * Static assertions over the shipped source, so they run with no database and
 * no network.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('../../', import.meta.url).pathname;
const read = (relative) => readFileSync(join(root, relative), 'utf8');
const stripJsComments = (body) =>
  body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const adminPage = read('src/pages/admin/BuilderPortalAdmin.tsx');
const adminCode = stripJsComments(adminPage);
const accessTerms = read('src/lib/builderAccessTerms.ts');
const loginPage = read('src/pages/builder/BuilderLogin.tsx');
const loginCode = stripJsComments(loginPage);
const authShell = read('src/components/builder-portal/BuilderAuthShell.tsx');
const authShellCode = stripJsComments(authShell);
const termsPage = read('src/pages/builder/BuilderTerms.tsx');
const termsCode = stripJsComments(termsPage);
const onboardingPage = read('src/pages/builder/BuilderOnboarding.tsx');
const onboardingCode = stripJsComments(onboardingPage);
const layout = read('src/components/builder-portal/BuilderPortalLayout.tsx');
const layoutCode = stripJsComments(layout);
const pageShell = read('src/components/builder-portal/BuilderPortalShell.tsx');
const dashboard = read('src/pages/builder/BuilderDashboard.tsx');
const dashboardCode = stripJsComments(dashboard);
const bell = read('src/components/builder-portal/BuilderNotificationBell.tsx');
const bellCode = stripJsComments(bell);
const userCard = read('src/components/builder-portal/ui/BuilderPortalUserCard.tsx');
const portalCss = read('src/styles/report-qa.css');
const app = read('src/App.tsx');

/** The Solicitor canon, read only — never written by this change. */
const solTerms = read('src/pages/solicitor/SolicitorTerms.tsx');
const solOnboarding = read('src/pages/solicitor/SolicitorOnboarding.tsx');
const solLayout = read('src/components/solicitor-portal/SolicitorPortalLayout.tsx');
const solShell = read('src/components/solicitor-portal/SolicitorPortalShell.tsx');

const BUILDER_UI = [
  'src/components/builder-portal/ui/BuilderPortalMetricCard.tsx',
  'src/components/builder-portal/ui/BuilderPortalStatCard.tsx',
  'src/components/builder-portal/ui/BuilderPortalUserCard.tsx',
];

/** Every unauthenticated Builder surface — they all share one shell. */
const AUTH_PAGES = [
  'src/pages/builder/BuilderLogin.tsx',
  'src/pages/builder/BuilderForgotPassword.tsx',
  'src/pages/builder/BuilderResetPassword.tsx',
  'src/pages/builder/BuilderAcceptInvite.tsx',
  'src/pages/builder/BuilderChangePassword.tsx',
  'src/pages/builder/BuilderSelectOrganisation.tsx',
];

/** The thirteen destinations, exactly as the route tree defines them.
 * '/builder/compliance' is the flag-gated partner compliance workspace
 * (AML partner domain Phase 5): its NAV entry is skipped in SidebarNav
 * until the aml_partner_compliance_workspace + builder surface flags are
 * on, so the rendered navigation is unchanged while the flags are off. */
const ROUTES = [
  '/builder', '/builder/projects', '/builder/inventory', '/builder/transactions',
  '/builder/pipeline', '/builder/construction', '/builder/documents', '/builder/messages',
  '/builder/tasks', '/builder/notifications', '/builder/activity', '/builder/compliance',
  '/builder/settings',
];

/**
 * The agreement, the acknowledgments and the accept button are the shared
 * partner-portal consent wall — the same component the Solicitor and Finance
 * portals render. Builder Terms keeps its own chrome and its own routing.
 */
const consentWallCode = readFileSync(
  join(root, 'src/components/portal/PortalAgreementConsent.tsx'), 'utf8');

/** Committed files, so "untouched" is measured against the merge base. */
const changedFiles = (() => {
  const base = execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: root })
    .toString().trim();
  return execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { cwd: root })
    .toString().split('\n').filter(Boolean);
})();

// ---------------------------------------------------------------------------
// 1–9. Authentication
// ---------------------------------------------------------------------------

test('1. Builder login uses the split-layout structure', () => {
  // The composition lives in the shell every auth page shares, so sign-in
  // cannot drift from invite acceptance or password reset.
  assert.match(loginCode, /import \{ BuilderAuthShell \} from '@\/components\/builder-portal\/BuilderAuthShell'/);
  assert.match(loginCode, /<BuilderAuthShell/);
  assert.match(authShellCode, /<div className="builder-portal-theme flex min-h-screen">/);
  assert.match(authShellCode, /lg:flex lg:w-\[480px\] xl:w-\[520px\]/);
  assert.match(authShellCode, /flex min-w-0 flex-1 items-center justify-center/);
});

test('2. Builder login uses the configured auth logo', () => {
  assert.match(authShellCode, /<BrandLockup\s*\n\s*slot="auth"/);
  assert.match(authShellCode, /<BrandLogo\s*\n\s*slot="auth"/);
  assert.match(authShellCode, /import \{ BrandLockup, BrandLogo \} from '@\/components\/branding\/BrandAssets'/);
  // No Builder logo, no static path, no cached asset.
  assert.doesNotMatch(authShellCode, /\.(png|jpe?g|svg|webp)\b/i);
  assert.doesNotMatch(authShellCode, /https?:\/\//);
});

test('3. Builder login uses the configured company name', () => {
  assert.match(authShellCode, /const \{ settings \} = useBrand\(\);/);
  assert.match(authShellCode, /const companyName = settings\.companyName \|\| 'Builder \/ Developer Portal';/);
  assert.match(authShellCode, /\{companyName\}/);
});

test('4. Builder login retains the same signIn call', () => {
  assert.match(loginCode, /const result = await signIn\(email, password, turnstileToken \|\| undefined\);/);
  assert.match(loginCode, /if \(!email \|\| !password\) \{/);
  assert.match(loginCode, /setError\('Enter your email address and password\.'\);/);
  assert.match(loginCode, /const \{ user, loading, signIn \} = useBuilderPortalAuth\(\);/);
  assert.match(loginCode, /if \(user\) return <Navigate to="\/builder" replace \/>;/);
  assert.doesNotMatch(loginCode, /invokeSecureFunction|supabase\.|\.rpc\(/);
});

test('5. Turnstile handlers remain unchanged', () => {
  assert.match(loginCode, /onVerify=\{\(token\) => setTurnstileToken\(token\)\}/);
  assert.match(loginCode, /onExpire=\{\(\) => setTurnstileToken\(null\)\}/);
  assert.match(loginCode, /onError=\{\(\) => setTurnstileToken\(null\)\}/);
  assert.match(loginCode, /setTurnstileToken\(null\);\s*\n\s*return;/);
  assert.equal((loginCode.match(/<TurnstileWidget/g) ?? []).length, 1);
});

test('6. the forgot-password route remains unchanged', () => {
  assert.match(loginCode, /to="\/builder\/forgot-password"/);
});

test('7. a successful login still navigates to /builder', () => {
  assert.match(loginCode, /navigate\('\/builder', \{ replace: true \}\);/);
  const handler = loginCode.slice(loginCode.indexOf('const handleSubmit'),
    loginCode.indexOf('\n  };', loginCode.indexOf('const handleSubmit')));
  assert.ok(handler.indexOf('if (result.error)') < handler.indexOf("navigate('/builder'"),
    'the page navigates before checking whether the sign-in succeeded');
});

test('8. password visibility still works, and is labelled', () => {
  assert.match(loginCode, /type=\{showPassword \? 'text' : 'password'\}/);
  assert.match(loginCode, /setShowPassword\(\(visible\) => !visible\)/);
  assert.match(loginCode, /aria-label=\{showPassword \? 'Hide password' : 'Show password'\}/);
  assert.match(loginCode, /autoComplete="email"/);
  assert.match(loginCode, /autoComplete="current-password"/);
});

test('9. every Builder authentication page uses the shared branded shell', () => {
  for (const file of AUTH_PAGES) {
    const code = stripJsComments(read(file));
    assert.match(code, /<BuilderAuthShell/, `${file} does not use the shared auth shell`);
    // None of them renders brand identity of its own.
    assert.doesNotMatch(code, /BrandLockup|BrandLogo/, `${file} renders branding of its own`);
  }
});

// ---------------------------------------------------------------------------
// 10–26. White-label branding
// ---------------------------------------------------------------------------

test('10. Builder consumes the shared brand provider, not a store of its own', () => {
  assert.match(layoutCode, /import \{ useWhiteLabel \} from '@\/contexts\/WhiteLabelContext'/);
  assert.match(authShellCode, /from '@\/branding\/useTokens'/);
  assert.match(termsCode, /from '@\/branding\/useBrand'/);
  assert.match(onboardingCode, /from '@\/branding\/useBrand'/);
  assert.match(app, /<BrandProvider>/);
  assert.ok(!changedFiles.some((file) => file.startsWith('src/branding/')),
    'the branding system was modified');
  assert.ok(!changedFiles.includes('src/contexts/WhiteLabelContext.tsx'));
  assert.ok(!changedFiles.includes('src/components/branding/BrandAssets.tsx'));
});

test('11. the desktop sidebar uses BrandLockup on the sidebar slot', () => {
  const sidebar = layoutCode.slice(layoutCode.indexOf('<aside className="builder-portal-sidebar'),
    layoutCode.indexOf('<header className="builder-portal-topbar'));
  assert.match(sidebar, /<BrandLockup\s*\n\s*slot="sidebar"/);
  assert.match(sidebar, /meta="Builder \/ Developer Portal"/);
  // The lockup, not a hand-built icon block.
  assert.doesNotMatch(sidebar, /HardHat/);
});

test('12. the mobile drawer uses configured branding', () => {
  const drawer = layoutCode.slice(layoutCode.indexOf('aria-label="Builder portal navigation"'));
  assert.match(drawer, /<BrandLockup\s*\n\s*slot="sidebar-icon"/);
  assert.match(drawer, /meta="Builder \/ Developer Portal"/);
});

test('13. the top bar uses the compact configured mark', () => {
  const topbar = layoutCode.slice(layoutCode.indexOf('<header className="builder-portal-topbar'),
    layoutCode.indexOf('<main id="main-content"'));
  assert.match(topbar, /<BrandLogo\s*\n\s*slot="sidebar-icon"/);
});

test('14. Terms names the configured company, not the organisation', () => {
  assert.match(termsCode, /const companyName = \(brandSettings\.companyName \|\| ''\)\.trim\(\) \|\| 'the Operator';/);
  assert.match(termsCode, /\{companyName\} · Builder \/ Developer Portal/);
  // The organisation is appended as context, never substituted for the operator.
  assert.match(termsCode, /\{organisationName \? ` · \$\{organisationName\}` : ''\}/);
});

test('15. onboarding uses the configured brand identity in its slides', () => {
  assert.match(onboardingCode, /const brandName = \(brandSettings\.companyName \|\| ''\)\.trim\(\) \|\| 'the operator';/);
  assert.match(onboardingCode, /buildIntroSlides\(brandName\)/);
  assert.match(onboardingCode, /\$\{brand\} has shared with your organisation/);
});

test('16. the active organisation stays separate from operator branding', () => {
  assert.match(layoutCode, /<BuilderPortalUserCard/);
  assert.match(layoutCode, /secondary=\{organisationName \|\| user\?\.email\}/);
  const cardCode = stripJsComments(userCard);
  assert.doesNotMatch(cardCode, /BrandLockup|BrandLogo|companyName|useBrand/,
    'the identity card reaches for operator branding');
});

test('17-19. branding is read live from settings, so a change propagates', () => {
  // Nothing is copied into state, memoised past a settings change, or cached.
  for (const [name, code] of [['auth shell', authShellCode], ['layout', layoutCode],
    ['terms', termsCode], ['onboarding', onboardingCode]]) {
    assert.doesNotMatch(code, /useState\([^)]*companyName/, `${name} caches the company name`);
    assert.doesNotMatch(code, /localStorage|sessionStorage/, `${name} persists branding`);
  }
  // Colour comes from semantic tokens, so a brand-colour change moves it.
  for (const [name, code] of [['auth shell', authShell], ['layout', layout],
    ['terms', termsPage], ['dashboard', dashboard], ['page shell', pageShell]]) {
    assert.match(code, /text-primary|bg-primary|border-primary|ring-ring/,
      `${name} does not use brand tokens`);
    assert.doesNotMatch(code, /#[0-9a-fA-F]{3,8}\b/, `${name} contains a raw hex colour`);
  }
  const themeBlock = portalCss.slice(portalCss.indexOf('.builder-portal-theme {'),
    portalCss.indexOf('.dashboard-shell {'));
  assert.match(themeBlock, /hsl\(var\(--primary\)/);
  assert.doesNotMatch(themeBlock, /#[0-9a-fA-F]{3,6}\b/);
});

test('20-22. no hard-coded operator identity anywhere in Builder', () => {
  const builderFiles = [
    ...readdirSync(join(root, 'src/pages/builder')).map((f) => `src/pages/builder/${f}`),
    ...readdirSync(join(root, 'src/components/builder-portal'))
      .filter((f) => f.endsWith('.tsx')).map((f) => `src/components/builder-portal/${f}`),
    ...BUILDER_UI,
  ];
  for (const file of builderFiles) {
    const code = read(file);
    assert.doesNotMatch(code, /Naidu/i, `${file} hard-codes an operator name`);
    assert.doesNotMatch(code, /\.(png|jpe?g|webp)\b/i, `${file} hard-codes a logo path`);
  }
  // The hard hat is never the brand mark on a surface that renders identity.
  const sidebar = layoutCode.slice(layoutCode.indexOf('<aside className="builder-portal-sidebar'),
    layoutCode.indexOf('<header className="builder-portal-topbar'));
  assert.doesNotMatch(sidebar, /HardHat/);
  const lockupBlock = authShellCode.slice(authShellCode.indexOf('<BrandLockup'),
    authShellCode.indexOf('<div className="space-y-8">'));
  assert.doesNotMatch(lockupBlock, /HardHat/);
});

test('23. the shared fallback is what renders when no logo is configured', () => {
  for (const [name, code] of [['auth shell', authShellCode], ['layout', layoutCode]]) {
    assert.match(code, /fallbackClassName=/, `${name} does not pass the shared fallback through`);
    assert.doesNotMatch(code, /onError=\{/, `${name} hand-rolls an image fallback`);
  }
  assert.match(read('src/components/branding/BrandAssets.tsx'), /FallbackIcon/);
});

test('24. no branding request was added', () => {
  for (const [name, code] of [['auth shell', authShellCode], ['layout', layoutCode],
    ['terms', termsCode], ['onboarding', onboardingCode]]) {
    assert.doesNotMatch(code, /invokeSecureFunction|supabase\.|\.rpc\(|useQuery\(/,
      `${name} makes a request of its own`);
  }
  assert.doesNotMatch(layoutCode, /setInterval/, 'the layout polls');
});

test('25. no branding schema or backend file changed', () => {
  for (const file of changedFiles) {
    assert.ok(!file.startsWith('supabase/'), `${file} is a Supabase file`);
    assert.ok(!file.includes('integrations/supabase/types'), `${file} is a generated type file`);
    assert.ok(!file.startsWith('src/branding/'), `${file} is branding infrastructure`);
  }
});

test('26. document metadata uses the configured company name', () => {
  assert.match(layoutCode, /const company = \(settings\.companyName \|\| ''\)\.trim\(\) \|\| 'Dashboard';/);
  assert.match(layoutCode, /const portalTitle = `\$\{company\} — Builder \/ Developer Portal`;/);
  assert.match(layoutCode, /document\.title = portalTitle;/);
  assert.match(layoutCode, /meta\[name="description"\]/);
  assert.match(layoutCode, /meta\[property="og:title"\]/);
  assert.match(layoutCode, /meta\[property="og:description"\]/);
  assert.match(layoutCode, /meta\[name="twitter:title"\]/);
  // And it is restored on unmount, exactly as Solicitor does.
  assert.match(layoutCode, /return \(\) => \{\s*\n\s*if \(settings\.companyName\) \{/);
  assert.match(solLayout, /return \(\) => \{\s*\n\s*if \(settings\.companyName\) \{/);
});

// ---------------------------------------------------------------------------
// 27–33. Terms
// ---------------------------------------------------------------------------

test('27. Builder Terms structurally matches Solicitor Terms', () => {
  for (const fragment of [
    'flex min-h-screen items-center justify-center p-4',
    'overflow-hidden rounded-2xl border border-border bg-card shadow-2xl duration-300 fade-in zoom-in-95',
    'border-b border-border bg-primary/5 px-6 py-6 md:px-8 md:py-8',
    'rounded-xl bg-primary/10 p-2.5',
    'h-6 w-6 text-primary',
    'space-y-6 px-6 py-5 md:px-8 md:py-6',
  ]) {
    assert.ok(solTerms.includes(fragment), `the Solicitor reference no longer has: ${fragment}`);
    assert.ok(termsCode.includes(fragment), `Builder Terms is missing: ${fragment}`);
  }

  // The agreement panel, the acknowledgments and the accept button are no
  // longer duplicated per portal to be kept in step — both pages render the one
  // consent wall, so they cannot fall out of step.
  for (const page of [solTerms, termsCode]) {
    assert.match(page, /<PortalAgreementConsent/);
  }
  for (const fragment of [
    'rounded-xl border border-border bg-muted/20 p-4',
    'w-full min-w-[200px] sm:w-auto',
  ]) {
    assert.ok(consentWallCode.includes(fragment), `the shared consent wall is missing: ${fragment}`);
  }
  assert.match(termsCode, /max-w-3xl/);
  assert.match(solTerms, /max-w-3xl/);
  // Builder's own theme class, never the Solicitor one.
  assert.match(termsCode, /className="builder-portal-theme/);
  assert.doesNotMatch(termsCode, /solicitor-portal-theme/);
});

test('28. Builder keeps its own chrome around the shared agreement', () => {
  // The document is the Portal Access, Confidentiality, Privacy and AML/CTF
  // Compliance Passport Agreement — the same one the Solicitor and Finance
  // portals present — so the heading is the shared heading. What stays Builder's
  // is the portal line and the copy that says what this portal is for.
  assert.match(termsCode, /Terms &amp; Privileged Data Consent/);
  assert.match(termsCode, /Builder \/ Developer Portal/);
  assert.match(termsCode,
    /Before accessing projects, inventory, transactions, construction records and shared\s*\n?\s*documents/);
  assert.match(termsCode, /<HardHat className="h-6 w-6 text-primary"/);
  // Builder's own chrome still carries no conveyancing wording; the agreement
  // itself is portal-neutral and lives in the database.
  assert.doesNotMatch(termsCode, /conveyanc|settlement/i);
});

test('29. the server title, version and body remain authoritative', () => {
  assert.match(termsCode, /import \{ builderLoadGovernance, type BuilderTermsVersion \} from '@\/lib\/builderPortal'/);
  assert.match(termsCode, /void builderLoadGovernance\(\)\.then/);
  assert.match(termsCode, /setTerms\(data\?\.terms \?\? null\)/);
  // The served row is handed straight to the wall, which renders its title,
  // its version and its Markdown. Nothing about the document is stated here.
  assert.match(termsCode, /terms=\{terms\}/);
  assert.match(consentWallCode, /terms\?\.title \|\| PORTAL_AGREEMENT_TITLE/);
  assert.match(consentWallCode, /Version \{terms\?\.version \|\| 'current'\}/);
  assert.match(consentWallCode, /terms\.content_markdown/);
  assert.doesNotMatch(termsCode, /version\s*[=:]\s*['"][\d.]/);
  assert.doesNotMatch(termsCode, /(?:WHEREAS|hereby agrees?|Clause \d|Section \d\.\d)/i);
});

test('30. every mandatory acknowledgment is required', () => {
  // Four acknowledgments now, rendered by the shared wall, and the button is
  // dead until all of them are ticked. The page states none of them itself.
  assert.equal((termsCode.match(/<Checkbox\b/g) ?? []).length, 0);
  assert.match(consentWallCode, /PORTAL_TERMS_ACKNOWLEDGEMENTS\.map/);
  assert.match(consentWallCode,
    /const canProceed = Boolean\(terms\) && acceptedKeys\.length === PORTAL_TERMS_ACKNOWLEDGEMENTS\.length && !busy;/);
  assert.match(consentWallCode, /disabled=\{!canProceed\}/);
  // And the server refuses an acceptance that is missing any of them, so the
  // checkboxes are not the only gate.
  const verify = readFileSync(join(root, 'supabase/functions/builder-portal-verify/index.ts'), 'utf8');
  assert.match(verify, /readAcknowledgements\(body\)/);
  assert.match(verify, /ACKNOWLEDGEMENTS_INCOMPLETE/);
});

test('31. acceptTerms is called exactly once, carrying the acknowledgments', () => {
  assert.equal((termsCode.match(/await acceptTerms\(/g) ?? []).length, 1);
  assert.match(termsCode, /const result = await acceptTerms\(acknowledgements\);/);
  assert.doesNotMatch(termsCode, /invokeSecureFunction|supabase\.|\.rpc\(|useMutation/);
});

test('32. onboarding is not bypassed', () => {
  assert.match(termsCode, /navigate\('\/builder', \{ replace: true \}\)/);
  assert.equal((termsCode.match(/navigate\(/g) ?? []).length, 1);
  const tree = app.slice(app.indexOf('<Route path="/builder/*"'));
  const guarded = tree.slice(tree.indexOf('<BuilderPortalProtectedRoute />'));
  assert.ok(guarded.includes('<Route path="terms" element={<BuilderTerms />} />'));
  assert.ok(guarded.includes('<Route path="onboarding" element={<BuilderOnboarding />} />'));
});

test('33. the Terms loading and error states stay accessible', () => {
  assert.match(consentWallCode, /aria-live="polite"/);
  assert.match(consentWallCode, /aria-busy=\{loading\}/);
  assert.match(consentWallCode, /<span className="sr-only">Loading the current terms…<\/span>/);
  assert.match(termsCode, /<Alert variant="destructive" role="alert">/);
  assert.match(termsCode, /if \(loadError\) setError\(loadError\.message\)/);
  const handler = termsCode.slice(termsCode.indexOf('const handleAccept'),
    termsCode.indexOf('\n  };', termsCode.indexOf('const handleAccept')));
  assert.ok(handler.indexOf('if (result.error)') < handler.indexOf("navigate('/builder'"));
});

// ---------------------------------------------------------------------------
// 34–39. Onboarding
// ---------------------------------------------------------------------------

test('34. onboarding uses the Solicitor wizard structure', () => {
  for (const fragment of [
    'flex min-h-screen items-center justify-center p-4',
    'overflow-hidden rounded-2xl border border-border bg-card shadow-2xl duration-300 fade-in zoom-in-95',
    'border-b border-border bg-primary/5 px-6 py-6 text-center md:px-8 md:py-8',
    'mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10',
    'flex items-center justify-center gap-2 pt-6',
    'flex items-center justify-between gap-3 border-t border-border bg-muted/30 px-6 py-4 md:px-8 md:py-5',
  ]) {
    assert.ok(solOnboarding.includes(fragment), `the Solicitor reference lost: ${fragment}`);
    assert.ok(onboardingCode.includes(fragment), `Builder onboarding is missing: ${fragment}`);
  }
  assert.match(onboardingCode, /max-w-2xl/);
  assert.match(solOnboarding, /max-w-2xl/);
  assert.match(onboardingCode, /Step \{wizardStep \+ 1\} of \{totalSteps\}/);
  assert.match(onboardingCode, /Required/);
  assert.match(onboardingCode, /className="builder-portal-theme/);
  assert.doesNotMatch(onboardingCode, /solicitor-portal-theme/);
});

test('35. the server-returned steps are still what is rendered', () => {
  assert.match(onboardingCode, /void builderLoadGovernance\(\)\.then/);
  assert.match(onboardingCode, /setSteps\(data\?\.steps \?\? \[\]\)/);
  assert.match(onboardingCode, /steps\.map\(\(step\) => \{/);
  assert.deepEqual(
    [...onboardingCode.matchAll(/^ {2}([a-z_]+): \{$/gm)].map((m) => m[1]),
    ['profile_confirmed', 'organisation_confirmed', 'contact_confirmed', 'security_reviewed']);
});

test('36. the mandatory rule is the rule it was', () => {
  assert.match(onboardingCode,
    /const outstanding = steps\.filter\(\(step\) => step\.mandatory && !step\.completed_at\);/);
  assert.match(onboardingCode,
    /const ready = steps\.length > 0 && outstanding\.every\(\(step\) => checked\[step\.step_key\]\);/);
  assert.match(onboardingCode, /disabled=\{!ready \|\| submitting\}/);
  assert.match(onboardingCode, /const done = Boolean\(step\.completed_at\);/);
  assert.match(onboardingCode, /disabled=\{done\}/);
  assert.doesNotMatch(onboardingCode, /useEffect\([^)]*setChecked/);
});

test('37. completeOnboarding is unchanged and gates the navigation', () => {
  assert.equal((onboardingCode.match(/completeOnboarding\(\)/g) ?? []).length, 1);
  assert.match(onboardingCode, /const result = await completeOnboarding\(\);/);
  const handler = onboardingCode.slice(onboardingCode.indexOf('const handleComplete'),
    onboardingCode.indexOf('\n  };', onboardingCode.indexOf('const handleComplete')));
  assert.ok(handler.indexOf('if (result.error)') < handler.indexOf("navigate('/builder'"));
  assert.doesNotMatch(onboardingCode, /invokeSecureFunction|supabase\.|\.rpc\(/);
});

test('38. the intro slides are display-only', () => {
  assert.match(onboardingCode, /Welcome to the Builder \/ Developer Portal/);
  assert.match(onboardingCode, /Organisation and project-scoped access/);
  assert.match(onboardingCode, /Secure and auditable collaboration/);
  assert.match(onboardingCode, /const \[wizardStep, setWizardStep\] = useState\(0\);/);
  const slides = onboardingCode.slice(onboardingCode.indexOf('const buildIntroSlides'),
    onboardingCode.indexOf('export default function'));
  assert.doesNotMatch(slides, /step_key|mandatory|completed_at|invoke|fetch/);
  // Advancing a slide writes nothing but the index.
  assert.doesNotMatch(onboardingCode, /setWizardStep\([^)]*\)[^;]*;\s*void /);
});

test('39. the route outcome is unchanged', () => {
  assert.match(onboardingCode, /navigate\('\/builder', \{ replace: true \}\)/);
  assert.equal((onboardingCode.match(/navigate\(/g) ?? []).length, 1);
});

// ---------------------------------------------------------------------------
// 40–51. The authenticated shell
// ---------------------------------------------------------------------------

test('40. the sidebar matches the Solicitor width and structure', () => {
  assert.match(layoutCode, /<aside className="builder-portal-sidebar hidden w-72 shrink-0 flex-col border-r md:flex">/);
  assert.match(solLayout, /w-72 flex-col border-r md:flex/);
  // Lockup, identity card, scrolling navigation, sign-out footer — in order.
  const sidebar = layoutCode.slice(layoutCode.indexOf('<aside className="builder-portal-sidebar'),
    layoutCode.indexOf('<header className="builder-portal-topbar'));
  // `userCard` is the rendered identity card; the component it is built from
  // is asserted separately in test 45.
  let last = -1;
  for (const token of ['BrandLockup', '{userCard}', 'ScrollArea', 'SidebarNav', 'signOutFooter']) {
    const at = sidebar.indexOf(token);
    assert.ok(at > last, `${token} is out of order in the sidebar`);
    last = at;
  }
});

test('41. all thirteen Builder routes remain in the navigation', () => {
  const navBlock = layoutCode.slice(layoutCode.indexOf('const NAV: BuilderNavItem[]'),
    layoutCode.indexOf('function tourAnchor'));
  assert.deepEqual([...navBlock.matchAll(/\{ to: '([^']+)'/g)].map((m) => m[1]), ROUTES);
});

test('42. no route path was added, removed or renamed', () => {
  assert.doesNotMatch(layoutCode, /<Route\b|createBrowserRouter|path=["']/);
  const targets = new Set([
    ...[...layoutCode.matchAll(/to="([^"]+)"/g)].map((m) => m[1]),
    ...[...layoutCode.matchAll(/navigate\('([^']+)'\)/g)].map((m) => m[1]),
  ].filter((value) => value.startsWith('/')));
  for (const target of targets) {
    assert.ok(ROUTES.includes(target), `${target} is not an existing Builder route`);
  }
  assert.ok(!changedFiles.includes('src/App.tsx'), 'the route tree was modified');
});

test('43. navigation is a flat Solicitor-style list', () => {
  const navFn = layoutCode.slice(layoutCode.indexOf('function SidebarNav'),
    layoutCode.indexOf('export function BuilderPortalLayout'));
  assert.match(navFn, /<nav aria-label="Builder portal" className="space-y-1 px-3">/);
  assert.match(solLayout, /<nav aria-label="Solicitor portal" className="space-y-1 px-3">/);
  // One map over NAV — no groups, no section headings.
  assert.match(navFn, /\{NAV\.map\(/);
  for (const heading of ['Overview', 'Project delivery', 'Workspace', 'Account & control']) {
    assert.ok(!navFn.includes(heading), `the sidebar still shows the "${heading}" heading`);
  }
  // Same item geometry and active treatment as the reference.
  assert.match(navFn, /rounded-xl px-4 py-3 text-sm font-medium/);
  assert.match(solLayout, /rounded-xl px-4 py-3 text-sm font-medium/);
  assert.match(navFn, /bg-primary text-primary-foreground shadow-lg shadow-primary\/20/);
  assert.match(solLayout, /bg-primary text-primary-foreground shadow-lg shadow-primary\/20/);
  assert.match(navFn, /h-\[18px\] w-\[18px\] shrink-0/);
  assert.match(navFn, /aria-current=\{active \? 'page' : undefined\}/);
});

test('44. the organisation switcher still renders, unmodified', () => {
  assert.match(layoutCode, /import \{ BuilderOrganisationSwitcher \}/);
  assert.match(layoutCode, /<BuilderOrganisationSwitcher \/>/);
  assert.doesNotMatch(layoutCode, /selectOrganisation/);
  const switcher = read('src/components/builder-portal/BuilderOrganisationSwitcher.tsx');
  assert.match(switcher, /const \{ error \} = await selectOrganisation\(organisationId\);/);
  assert.match(switcher, /if \(selectable\.length <= 1\) return null;/);
  assert.ok(!changedFiles.includes('src/components/builder-portal/BuilderOrganisationSwitcher.tsx'),
    'the switcher was modified');
});

test('45. the identity card carries user, organisation and access role', () => {
  assert.match(layoutCode, /name=\{displayName\}/);
  assert.match(layoutCode, /roleLabel=\{activeOrganisation \? accessRoleLabel\(activeOrganisation\.membership_role\) : null\}/);
  assert.match(layoutCode, /isPrimaryOrganisation=\{Boolean\(activeOrganisation\?\.is_primary\)\}/);
  assert.match(layoutCode, /switcher=\{<BuilderOrganisationSwitcher \/>\}/);
  const cardCode = stripJsComments(userCard);
  assert.doesNotMatch(cardCode, /invoke|supabase|useQuery|useBuilderPortalAuth|permission/i);
});

test('46. the mobile drawer contains every route', () => {
  // One SidebarNav definition, rendered by both surfaces, so the drawer cannot
  // fall behind the desktop list.
  assert.equal((layoutCode.match(/<SidebarNav /g) ?? []).length, 2);
  assert.match(layoutCode, /<SidebarNav pathname=\{pathname\} showCompliance=\{complianceNavEnabled\} onNavigate=\{\(\) => setMobileOpen\(false\)\} \/>/);
  assert.match(layoutCode, /role="dialog"\s*\n\s*aria-modal="true"/);
  assert.match(layoutCode, /aria-label="Builder portal navigation"/);
});

test('47. the drawer closes on Escape and on the overlay', () => {
  assert.match(layoutCode, /if \(event\.key === 'Escape'\) setMobileOpen\(false\);/);
  assert.match(layoutCode, /onClick=\{\(\) => setMobileOpen\(false\)\}/);
  assert.match(layoutCode, /aria-label="Close navigation menu"/);
  assert.match(layoutCode, /aria-expanded=\{mobileOpen\}/);
});

test('48. the drawer closes after navigation', () => {
  assert.match(layoutCode, /useEffect\(\(\) => \{ setMobileOpen\(false\); \}, \[pathname\]\);/);
  assert.match(layoutCode, /onNavigate=\{\(\) => setMobileOpen\(false\)\}/);
});

test('49. the skip link targets main-content', () => {
  assert.match(layoutCode, /href="#main-content"/);
  assert.match(layoutCode, /Skip to main content/);
  assert.match(layoutCode, /focus:not-sr-only/);
  assert.match(layoutCode, /<main id="main-content"/);
});

test('50. sign out uses the existing handler', () => {
  assert.match(layoutCode, /const \{ user, activeOrganisation, signOut \} = useBuilderPortalAuth\(\);/);
  assert.equal((layoutCode.match(/void signOut\(\)/g) ?? []).length, 2,
    'sign out should be reachable from the sidebar footer and the account menu');
  assert.doesNotMatch(layoutCode, /localStorage|sessionStorage|document\.cookie/);
});

test('51. the onboarding tour is still mounted, with its anchors intact', () => {
  assert.match(layoutCode, /import \{ BuilderOnboardingTour \}/);
  assert.match(layoutCode, /<BuilderOnboardingTour \/>/);
  assert.match(layoutCode, /data-tour=\{tourAnchor\(to\)\}/);
  assert.match(layoutCode, /function tourAnchor\(to: string\): string \{/);
  assert.match(layoutCode, /to === '\/builder' \? 'dashboard' : to\.slice\('\/builder\/'\.length\)/);
  // And the profile menu replays it through the tour's own event.
  assert.match(layoutCode, /new CustomEvent\(BUILDER_TOUR_EVENT\)/);
  assert.match(read('src/components/builder-portal/BuilderOnboardingTour.tsx'),
    /export const BUILDER_TOUR_EVENT/);
});

// ---------------------------------------------------------------------------
// 52–59. Dashboard
// ---------------------------------------------------------------------------

test('52. the dashboard uses the Solicitor-style hero', () => {
  assert.match(dashboardCode, /<BuilderPortalShell\s*\n\s*eyebrow="Welcome back"/);
  assert.match(dashboardCode, /title=\{smartCapitalize\(user\?\.name\) \|\| 'Builder'\}/);
  assert.match(dashboardCode,
    /description="Your project-delivery workspace across every organisation and project shared with your account\."/);
  // The hero itself is the shared header treatment, matching the reference.
  assert.match(pageShell, /className="builder-portal-page-header"/);
  assert.match(solShell, /className="solicitor-portal-page-header"/);
  assert.match(pageShell, /text-2xl font-bold tracking-tight text-foreground md:text-3xl/);
  assert.match(solShell, /text-2xl font-bold tracking-tight text-foreground md:text-3xl/);
  assert.match(pageShell, /text-xs font-medium uppercase tracking-widest text-primary\/70/);
  assert.match(solShell, /text-xs font-medium uppercase tracking-widest text-primary\/70/);
});

test('53. Open projects routes to /builder/projects', () => {
  assert.match(dashboardCode, /<Link to="\/builder\/projects">/);
  assert.match(dashboardCode, /Open projects <ArrowRight className="ml-2 h-4 w-4" aria-hidden \/>/);
  assert.match(dashboardCode, /<Button asChild size="sm">/);
});

test('54. all eight metrics remain, in a primary and a secondary row', () => {
  const tiles = [...dashboardCode.matchAll(/\{ label: '([^']+)', value: summary\?\.(\w+) \?\? 0, icon: \w+, to: '([^']+)' \}/g)]
    .map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(tiles, [
    ['Active projects', 'projects', '/builder/projects'],
    ['Units in inventory', 'units', '/builder/inventory'],
    ['Active builds', 'construction_cases', '/builder/construction'],
    ['Transactions', 'transactions', '/builder/transactions'],
    ['Documents', 'documents', '/builder/documents'],
    ['Open conversations', 'open_conversations', '/builder/messages'],
    ['Open tasks', 'open_tasks', '/builder/tasks'],
    ['Unread notifications', 'unread_notifications', '/builder/notifications'],
  ]);
  assert.equal(tiles.length, 8);
  for (const [, , to] of tiles) assert.ok(ROUTES.includes(to), `${to} is not a Builder route`);
  assert.match(dashboardCode, /const primaryTiles = \[/);
  assert.match(dashboardCode, /const secondaryTiles = \[/);
  assert.match(dashboardCode, /<BuilderPortalStatCard/);
});

test('55-57. the data sources are unchanged', () => {
  assert.match(dashboardCode,
    /import \{ useBuilderActivity, useBuilderWorkspaceSummary \} from '@\/lib\/builderQueries'/);
  assert.match(dashboardCode, /const summaryQuery = useBuilderWorkspaceSummary\(\);/);
  assert.match(dashboardCode, /const activityQuery = useBuilderActivity\(\);/);
  assert.match(dashboardCode, /const activity = \(activityQuery\.data \|\| \[\]\)\.slice\(0, 8\);/);
  assert.equal((dashboardCode.match(/useQuery|useMutation|queryKey/g) ?? []).length, 0);
  assert.doesNotMatch(dashboardCode, /invokeSecureFunction|supabase\.|\.rpc\(/);
  assert.ok(!changedFiles.includes('src/lib/builderQueries.ts'), 'the query hooks were modified');
});

test('58. no mock data was added', () => {
  assert.deepEqual([...dashboardCode.matchAll(/value=\{(\d+)\}/g)].map((m) => m[1]), []);
  assert.doesNotMatch(dashboardCode, /Math\.(random|round|floor)|placeholder|mock|sample|demo/i);
  // No fabricated trend, runway, percentage or money.
  assert.doesNotMatch(dashboardCode, /trend|percent|runway|forecast/i);
  assert.match(dashboardCode,
    /A zero means nothing you can see,\s*\n?\s*not necessarily nothing at all\./);
});

test('59. attention items read only existing summary values', () => {
  const block = dashboardCode.slice(dashboardCode.indexOf('const attention = ['),
    dashboardCode.indexOf('return ('));
  assert.deepEqual(
    [...block.matchAll(/\{ label: '([^']+)', value: summary\?\.(\w+) \?\? 0, to: '([^']+)' \}/g)]
      .map((m) => [m[1], m[2], m[3]]),
    [
      ['Open defects', 'open_defects', '/builder/construction'],
      ['Overdue tasks', 'overdue_tasks', '/builder/tasks'],
      ['Unread messages', 'unread_messages', '/builder/messages'],
    ]);
  // Still filtered to what is actually waiting — and now also to sections
  // this portal offers, because a row leading to a withdrawn section is a
  // door to a notice. The array above keeps every entry, so re-offering a
  // section restores its row.
  assert.match(block, /item\.value > 0 && !isWithdrawnBuilderPath\(item\.to\)/);
  assert.doesNotMatch(dashboardCode, /'(critical|high|medium|low|urgent)'/i);
});

// ---------------------------------------------------------------------------
// 60–70. General safety
// ---------------------------------------------------------------------------

test('60. no Solicitor file was changed, and none is imported by Builder', () => {
  for (const file of changedFiles) {
    assert.ok(!/solicitor/i.test(file), `${file} is Solicitor Portal code`);
  }
  for (const [name, code] of [['auth shell', authShellCode], ['layout', layoutCode],
    ['terms', termsCode], ['onboarding', onboardingCode], ['dashboard', dashboardCode],
    ['page shell', pageShell], ['bell', bellCode]]) {
    assert.doesNotMatch(code, /from '[^']*[Ss]olicitor/, `${name} imports Solicitor code`);
    assert.doesNotMatch(code, /solicitor-portal-/, `${name} borrows a Solicitor theme class`);
  }
});

test('61. no Finance or Client Portal file was changed', () => {
  for (const file of changedFiles) {
    assert.ok(!/finance-portal|financePortal|client-portal/i.test(file),
      `${file} belongs to another portal`);
  }
});

test('62. no Supabase file was changed', () => {
  for (const file of changedFiles) {
    assert.ok(!file.startsWith('supabase/'), `${file} is a Supabase file`);
  }
});

test('63-65. routes, operation strings and query keys are unchanged', () => {
  assert.ok(!changedFiles.includes('src/App.tsx'));
  assert.ok(!changedFiles.includes('src/lib/builderQueries.ts'));
  assert.ok(!changedFiles.includes('src/lib/builderPortal.ts'));
  // The bell reaches the backend only through hooks that already existed.
  assert.match(bellCode, /useBuilderCollaborationMutation, useBuilderNotifications, useBuilderUnreadCounts/);
  assert.match(bellCode, /from '@\/lib\/builderQueries'/);
  assert.doesNotMatch(bellCode, /invokeSecureFunction|supabase\.|\.rpc\(|queryKey/);
  assert.match(bellCode, /operation: 'mark_notifications_read'/);
});

test('66-68. permission, authentication and organisation logic is unchanged', () => {
  for (const file of changedFiles) {
    assert.ok(!file.includes('useBuilderPortalAuth'), 'the auth provider was modified');
    assert.ok(!file.includes('BuilderPortalProtectedRoute'), 'the protected route was modified');
    assert.ok(!file.includes('secureInvoke'), 'the secure invocation helper was modified');
    assert.ok(!file.includes('useModulePermissions'), 'the permission resolver was modified');
    assert.ok(!file.includes('BuilderOrganisationSwitcher'), 'organisation selection was modified');
  }
  assert.match(adminCode, /useModulePermissions\('builder_portal_admin'\)/);
});

test('69. the notification bell fabricates no count', () => {
  assert.match(bellCode, /const unread = countsQuery\.data\?\.unread_notifications \?\? 0;/);
  assert.match(bellCode, /\{unread \? \(/);
  assert.doesNotMatch(bellCode, /Math\.(random|max)\(/);
  // Realtime is not claimed, because Builder has no realtime bridge.
  assert.doesNotMatch(bellCode, /realtime|subscribe\(/i);
  assert.ok(!readdirSync(join(root, 'src/components/builder-portal'))
    .some((f) => /Realtime/i.test(f)), 'a realtime bridge was invented');
});

test('70. nothing on these surfaces can push the page sideways', () => {
  for (const [name, code] of [['layout', layoutCode], ['dashboard', dashboardCode],
    ['terms', termsCode], ['onboarding', onboardingCode], ['auth shell', authShellCode],
    ['page shell', pageShell]]) {
    assert.match(code, /min-w-0|truncate|break-words/, `${name} cannot shrink its content`);
    assert.doesNotMatch(code, /w-screen|overflow-x-visible/, `${name} can exceed the viewport`);
  }
  assert.doesNotMatch(layoutCode, /overflow-x-auto/);
  assert.match(layoutCode, /max-w-\[85vw\]/);
  // The content column is width-bounded by the shared theme class.
  const contentRule = portalCss.slice(portalCss.indexOf('.builder-portal-content {'));
  assert.match(contentRule.slice(0, 200), /mx-auto w-full max-w-7xl/);
});

// ---------------------------------------------------------------------------
// 71–75. Terminology and component hygiene, carried forward.
// ---------------------------------------------------------------------------

test('71. the admin surface still reads Organisation Access', () => {
  assert.match(adminCode, /<TabsTrigger value="memberships"[\s\S]{0,240}Organisation Access/);
  assert.match(adminCode, /<CardTitle className="text-base">Organisation Access Assignments<\/CardTitle>/);
  assert.match(adminCode, /label="Active organisation access"/);
  assert.match(accessTerms, /member: 'Standard User'/);
  assert.match(accessTerms, /administrator: 'Organisation Administrator'/);
});

test('72. every backend operation string is unchanged', () => {
  const operations = [...new Set([
    ...[...adminCode.matchAll(/(?:^|[^.\w])call\('([a-z_]+)'/g)].map((m) => m[1]),
    ...[...adminCode.matchAll(/mutate\('([a-z_]+)'/g)].map((m) => m[1]),
    ...[...adminCode.matchAll(/runConfirmed\('([a-z_]+)'/g)].map((m) => m[1]),
    ...[...adminCode.matchAll(/editing \? '([a-z_]+)' : '([a-z_]+)'/g)].flatMap((m) => [m[1], m[2]]),
  ])].sort();
  assert.deepEqual(operations, [
    'create_user', 'delete_membership', 'delete_organisation', 'delete_user',
    'get_membership_permissions', 'get_permission_catalogue',
    'list_memberships', 'list_organisations', 'list_users',
    'revoke_membership', 'revoke_user_sessions',
    'set_organisation_status', 'set_user_status',
    'update_membership_permissions', 'update_user',
    'upsert_membership', 'upsert_organisation',
  ]);
});

test('73. every Builder presentation component is display-only', () => {
  const dir = 'src/components/builder-portal/ui';
  const files = readdirSync(join(root, dir)).filter((name) => name.endsWith('.tsx'));
  assert.deepEqual(files.map((name) => `${dir}/${name}`).sort(), BUILDER_UI.slice().sort());
  for (const file of BUILDER_UI) {
    const code = stripJsComments(read(file));
    assert.doesNotMatch(code, /invokeSecureFunction|supabase|useQuery|useMutation|\.rpc\(/,
      `${file} reaches a backend`);
    assert.doesNotMatch(code, /useBuilderPortalAuth|useModulePermissions|canEdit|permissions\[/,
      `${file} makes a permission or authentication decision`);
    assert.doesNotMatch(code, /localStorage|sessionStorage|document\.cookie/,
      `${file} touches Web Storage`);
  }
});

test('74. no raw hex colour or palette class was introduced', () => {
  const surfaces = [
    ['login', loginPage], ['auth shell', authShell], ['terms', termsPage],
    ['onboarding', onboardingPage], ['layout', layout], ['dashboard', dashboard],
    ['page shell', pageShell], ['bell', bell],
    ...BUILDER_UI.map((file) => [file, read(file)]),
  ];
  for (const [name, code] of surfaces) {
    assert.doesNotMatch(code, /#[0-9a-fA-F]{3,8}\b/, `${name} contains a raw hex colour`);
    assert.doesNotMatch(code,
      /\b(bg|text|border)-(red|blue|green|slate|zinc|gray|grey|amber|indigo|violet|emerald)-\d{2,3}\b/,
      `${name} uses a raw Tailwind palette class`);
  }
});

test('75. the Builder theme is its own, and mirrors the Solicitor formulas', () => {
  for (const cls of [
    'builder-portal-theme', 'builder-portal-sidebar', 'builder-portal-topbar',
    'builder-portal-main', 'builder-portal-content', 'builder-portal-page-header',
    'builder-portal-soft-panel', 'builder-portal-stat-card',
  ]) {
    assert.ok(portalCss.includes(`.${cls} {`), `the ${cls} rule is missing`);
    assert.ok(portalCss.includes(`.${cls.replace('builder', 'solicitor')} {`),
      `the Solicitor counterpart of ${cls} is missing`);
  }
  assert.ok(!changedFiles.includes('src/index.css'), 'the global theme was modified');
});
