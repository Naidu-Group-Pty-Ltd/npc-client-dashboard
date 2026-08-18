import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { execSync } from "node:child_process";
import { mcpPlugin } from "@lovable.dev/mcp-js/stacks/supabase/vite";
import { inlineXlsxPlugin } from "./vite-inline-xlsx";
import { stagingTargetPlugin } from "./vite-staging-target";

// npc-client-dashboard IS the client-facing deployment — the mode is this
// repository's identity, not a per-deploy setting, so it is pinned here
// rather than left to an env file nobody commits (.env is gitignored by
// SECR-001). An explicitly exported VITE_CLIENT_FACING still wins, so an
// operator can build an internal-console bundle from this repo when needed.
// See src/lib/clientFacing.ts and docs/CLIENT_FACING_MODE.md.
process.env.VITE_CLIENT_FACING ??= "true";

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

