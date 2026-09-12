import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { execSync } from "node:child_process";
import { mcpPlugin } from "@lovable.dev/mcp-js/stacks/supabase/vite";
import { inlineXlsxPlugin } from "./vite-inline-xlsx";
import { stagingTargetPlugin } from "./vite-staging-target";
import {
  parseDeploymentAllowances,
  resolveClientFacingFlag,
} from "./src/lib/clientFacing";

// npc-client-dashboard IS the client-facing deployment — the mode is this
// repository's identity, not a per-deploy setting, so it is pinned here
// rather than left to an env file nobody commits (.env is gitignored by
// SECR-001). An explicitly exported VITE_CLIENT_FACING still wins, so an
// operator can build an internal-console bundle from this repo when needed.
// See src/lib/clientFacing.ts and docs/CLIENT_FACING_MODE.md.
process.env.VITE_CLIENT_FACING ??= "true";

// TEMPORARY, and pinned here for the same reason the line above is: the
// Integrations page is operator tooling and the mode hides it, but this
// deployment is the one the GoHighLevel cutover is being tested on, and that
// test is typing a credential into that page. Naming it here keeps the
// exception reviewable and revertible in one line, rather than as a setting in
// a hosting console nobody can diff. Remove the line when the test is done.
//
// The cost is deliberate and worth stating: allowing the path also re-admits
// the page's CHUNK, which carries the 143-entry integration registry and its
// Supabase secret NAMES (never values). Every other hidden page stays hidden
// and its chunk stays unbuilt.
process.env.VITE_CLIENT_FACING_ALLOW ??= "/integrations";

// Identifies the deployed build. `version.json` carries the same value, so a
// tab can tell whether it is running the current bundle or a cached older one
// (see src/lib/buildVersion.ts). Commit sha when available, timestamp otherwise.
function resolveBuildId(): string {
  const fromEnv =
    process.env.VITE_BUILD_ID ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.GITHUB_SHA ||
    process.env.COMMIT_REF;
  if (fromEnv) return fromEnv.slice(0, 12);
  try {
    return execSync("git rev-parse --short=12 HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return `t${Date.now().toString(36)}`;
  }
}

const BUILD_ID = resolveBuildId();

// Read once, here, so the two halves of the mode cannot be computed from
// different expressions. `CLIENT_FACING` is what the running code reads; the
// `EXCLUDED` helper is what decides whether a page's chunk is emitted, and both
// come from this one parsed allowance list. They disagreed once — see
// src/lib/clientFacing.ts — and the visible result was a route that resolved to
// nothing and drew a blank page.
const CLIENT_FACING = resolveClientFacingFlag(process.env.VITE_CLIENT_FACING);
const CLIENT_FACING_ALLOWANCES = parseDeploymentAllowances(
  process.env.VITE_CLIENT_FACING_ALLOW,
);
const EXCLUDED = (hiddenPath: string) =>
  CLIENT_FACING && !CLIENT_FACING_ALLOWANCES.includes(hiddenPath);

/** Writes the build id next to the bundle so the running app can compare. */
function buildVersionManifest(): Plugin {
  return {
    name: "npc-build-version-manifest",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: JSON.stringify({ buildId: BUILD_ID }),
      });
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
  },
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),

    // Literals, because Rollup folds a literal and cannot see through a
    // function call. `isClientFacingDeployment()` reads the first of these —
    // it is the ONE authority, and reading the environment at runtime instead
    // is the defect src/lib/clientFacing.ts records.
    __CLIENT_FACING__: JSON.stringify(CLIENT_FACING),
    __CLIENT_FACING_ALLOW__: JSON.stringify(CLIENT_FACING_ALLOWANCES),

    // One literal per page whose CHUNK is the leak, because folding the
    // ternary in App.tsx is what drops the `import()` behind it — a single
    // flag could not express "hide four of these and keep one". Each name is
    // paired with its entry in CLIENT_FACING_HIDDEN_PATHS, and a test asserts
    // App.tsx gates exactly these five and no others.
    __EXCLUDE_INTEGRATIONS__: JSON.stringify(EXCLUDED("/integrations")),
    __EXCLUDE_WORKFLOW_PLAYGROUND__: JSON.stringify(EXCLUDED("/workflow-playground")),
    __EXCLUDE_CLOUDFLARE__: JSON.stringify(EXCLUDED("/cloudflare")),
    __EXCLUDE_MODEL_HUB__: JSON.stringify(EXCLUDED("/model-hub")),
    __EXCLUDE_API_USAGE__: JSON.stringify(EXCLUDED("/api-usage")),
  },
  plugins: [
    // Inert unless run with `--mode staging` AND the local staging variables
    // are set; see vite-staging-target.ts. Gating on the mode is what stops a
    // default build being retargeted by a `.env.local` on disk. Runs before
    // everything else so the retarget applies to source, not to output.
    stagingTargetPlugin(mode, loadEnv(mode, process.cwd(), ["STAGING_"])),
    inlineXlsxPlugin(),
    react(),
    mcpPlugin(),
    buildVersionManifest(),
  ],
  assetsInclude: ["**/*.xlsx", "**/*.docx"],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    commonjsOptions: {
      include: [/node_modules/, /src\/lib\/security\/vendor\/qrcode/],
    },
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-ui': ['@radix-ui/react-dialog', '@radix-ui/react-popover', '@radix-ui/react-select', '@radix-ui/react-tabs', '@radix-ui/react-tooltip', '@radix-ui/react-dropdown-menu'],
          'vendor-charts': ['recharts'],
          'vendor-pdf': ['pdf-lib', 'jspdf'],
          'vendor-utils': ['date-fns', 'lucide-react', 'zod', 'react-hook-form'],
          'vendor-supabase': ['@supabase/supabase-js'],
        },
      },
    },
  },
}));

