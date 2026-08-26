/// <reference types="vite/client" />

/**
 * Injected by Vite (`define` in vite.config.ts). Identifies the deployed build
 * so the app can detect a tab running a cached older bundle.
 */
declare const __BUILD_ID__: string;

/**
 * Injected by Vite (`define` in vite.config.ts). True in a client-facing
 * build. Use ONLY where the goal is to keep a module out of the bundle
 * entirely — a bare `if (__CLIENT_FACING__)` is what makes the bundler drop
 * the dead branch. For ordinary conditional rendering use
 * `isClientFacingDeployment()` from `@/lib/clientFacing`, which is testable.
 */
declare const __CLIENT_FACING__: boolean;

declare module '*.xlsx?inline' {
  const src: string;
  export default src;
}
