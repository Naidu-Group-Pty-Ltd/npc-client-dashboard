#!/usr/bin/env node
/**
 * Undefined identifiers in the app bundle — fatal, never baselined.
 *
 * This is the browser-side twin of the TS2304/TS2552 rule
 * `check-edge-functions.mjs` already enforces over Edge Functions, and it
 * exists for the same reason, learned the same way.
 *
 * ## Why the build does not already catch this
 *
 * `npm run build` is Vite. Vite STRIPS types; it does not check them. A name
 * that does not exist is therefore not a build failure — it is a
 * successfully-bundled `ReferenceError` waiting for the line to run. The
 * repository has no `tsc` gate over `src/` at all: `tsconfig.json` declares
 * `"files": []` and delegates to project references, so `tsc --noEmit -p
 * tsconfig.json` (the obvious spelling) compiles NOTHING and exits 0 while
 * `tsconfig.app.json` holds the real error.
 *
 * ## Why this class and no other
 *
 * `src/` carries pre-existing type errors — 17 of them the day this gate was
 * written — and none is worth blocking a release over: a wrong `LegacyRef`
 * variance renders exactly the same pixels. An undefined identifier is a
 * different kind of thing. It is not a mistyped contract, it is a line that
 * cannot execute, and the component containing it throws on render.
 *
 * ## Why it is here
 *
 * It happened. `PortalAgreementConsent` declared `beforeAccept` in its props
 * TYPE and rendered `{beforeAccept}` in its JSX, and the prop was never added
 * to the destructured parameter list. TypeScript was right about the props;
 * the identifier simply did not exist. Lint passed, the build passed, and
 * every guard over that surface reads source rather than mounting it — so the
 * first thing that noticed was a partner outside every portal, opening an
 * emailed compliance agreement and being shown "Something went wrong" by the
 * top-level error boundary, with no account, no support channel and no way to
 * tell a broken page from a bad link.
 *
 * ## The ratchet
 *
 * `src-missing-names.txt` freezes occurrences that already existed, keyed by
 * FILE and IDENTIFIER rather than by line — a line number moves with every
 * edit above it, so a positional key would either churn or silently start
 * covering a different defect. It is EMPTY at the time of writing, which is
 * the whole point: there is no debt to grandfather, so nothing new may land.
 *
 *   node scripts/security/check-src-missing-names.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KNOWN_MISSING_PATH = join(root, 'scripts', 'security', 'src-missing-names.txt');

/**
 * There is no such thing as a deliberately-undefined identifier on a live
 * code path, which is why this list is two entries long and will stay that
 * way. TS2552 is the same fault with a spelling suggestion attached.
 */
const FATAL = new Map([
  ['TS2304', 'name does not exist — ReferenceError the moment that line renders'],
  ['TS2552', 'name does not exist — ReferenceError the moment that line renders'],
]);

const KNOWN_MISSING = new Set(readFileSync(KNOWN_MISSING_PATH, 'utf8')
  .split('\n').map((line) => line.replace(/#.*$/, '').trim()).filter(Boolean));

/*
 * `tsc` exits non-zero whenever it reports anything, and `src/` has
 * pre-existing errors this gate deliberately ignores — so a non-zero exit is
 * expected and the OUTPUT is what is read. A tsc that produced no output at
 * all while failing is a different problem (a bad project file, a missing
 * dependency) and is reported as one rather than passing silently.
 */
let out = '';
try {
  out = execFileSync('npx', ['tsc', '--noEmit', '-p', 'tsconfig.app.json'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });
} catch (error) {
  out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  if (!/error TS\d+/.test(out)) {
    console.error('Could not type-check tsconfig.app.json — this gate did not run:\n');
    console.error(out.trim() || String(error));
    process.exit(1);
  }
}

/** `src/path/File.tsx(155,10): error TS2304: Cannot find name 'x'.` */
const LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/;
const fatal = [];
for (const line of out.split('\n')) {
  const match = LINE.exec(line.trim());
  if (!match) continue;
  const [, rawFile, row, col, code, message] = match;
  if (!FATAL.has(code)) continue;
  const file = relative(root, resolve(root, rawFile)).replace(/\\/g, '/');
  const name = message.match(/Cannot find name '([^']+)'/)?.[1] ?? null;
  if (name && KNOWN_MISSING.has(`${file}::${name}`)) continue;
  fatal.push({ code, where: `${file}:${row}:${col}`, message });
}

if (fatal.length > 0) {
  console.error(
    `\n${fatal.length} undefined identifier(s) in src/. These are never type debt and are never\n`
    + 'baselined: the name does not exist, so the line throws a ReferenceError the moment it\n'
    + 'renders — and a component that throws on render takes its whole page with it.\n',
  );
  for (const item of fatal) {
    console.error(`  ${item.where}\n    ${item.code}: ${item.message}\n    ${FATAL.get(item.code)}`);
  }
  console.error(
    '\nFix the name. If it is a real global this project\'s types do not know about, declare it\n'
    + `in global.d.ts — adding it to ${relative(root, KNOWN_MISSING_PATH)} is for occurrences that\n`
    + 'predate this gate, and there were none.\n',
  );
  process.exit(1);
}

console.log('No undefined identifiers in src/.');
