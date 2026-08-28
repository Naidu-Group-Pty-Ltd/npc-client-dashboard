/**
 * Compile-time define for client-facing mode, declared in a file of its own.
 *
 * `__CLIENT_FACING__` is injected by `define` in vite.config.ts and gates five
 * routes in App.tsx. Its declaration used to live in `src/vite-env.d.ts` — a
 * file the prime also has, which the cascade therefore overwrites. Taking the
 * prime's version deletes the declaration and App.tsx stops type-checking with
 * five `TS2304: Cannot find name '__CLIENT_FACING__'`. That bit during the
 * 26 Aug sync (docs/CLIENT_FACING_MODE.md records it), was repaired in place,
 * and the very next cascade deleted the repair again.
 *
 * This file exists only in this repository. A cascade writes the prime's paths
 * and never deletes a clone-only file, so the declaration survives every sync
 * with no exclusion entry to maintain — the failure mode is removed rather
 * than guarded.
 */
declare const __CLIENT_FACING__: boolean;
