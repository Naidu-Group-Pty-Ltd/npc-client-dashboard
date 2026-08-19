# Dedicated backend provisioning — run log (WIP)

The client-facing dashboard should run on its **own** Supabase backend rather
than sharing the prime's (`dduzbchuswwbefdunfct`). This records an execution
of Aurixa Mission Control's clone-backend pipeline against a fresh project,
and — as requested — **every error the channel surfaced**. It is WIP: the
project exists but is **not yet a usable backend** (see blockers).

## What was created

| | |
| --- | --- |
| Supabase project ref | `plisdzywzleljorrphxv` |
| Project name | `aurixa-clone-npc-client-dashboard` |
| URL | `https://plisdzywzleljorrphxv.supabase.co` |
| Org | `nchuigmqbfcdhdgplrxq` (Xenochrome 3) |
| Region | `ap-southeast-2` (Sydney) |
| Status | `ACTIVE_HEALTHY`, **public schema empty (0 tables)** |

The anon/publishable keys were retrieved but are **not** committed here or
wired into the app: pointing the client at an empty backend is worse than
sharing the prime, so the live env stays on the prime until a schema clone
actually succeeds.

## Channel used

Mission Control's real pipeline
(`src/server/backend-provisioning.server.ts::provisionCloneBackend`) could
**not** be invoked directly from this session — see blocker #1. Its steps were
executed instead through the session's authorized **Supabase Management API**
connection, which is the same API the pipeline calls
(`https://api.supabase.com/v1`, `POST /database/query`). Steps followed in
order: org-capacity preflight → create project → wait healthy → retrieve keys
→ enforce required extensions → replay prime migrations.

## Errors encountered (all of them)

1. **Mission Control cannot run in this session (environmental).** The
   pipeline needs its own operator secrets — `SB_MGMT_API_TOKEN`, `SB_ORG_ID`
   (`backend-provisioning.server.ts`) — plus a GitHub App to read the prime
   repo (`fetchPrimeBackendSnapshot` pulls migration blobs over the GitHub
   API). None are present here. Substituted the session's Management API +
   the local repo checkout.

2. **`REQUIRED_EXTENSIONS` names a non-existent extension.** The list is
   `["pgcrypto","pg_net","pg_cron","pg_graphql","vault"]`, but Postgres has no
   extension named `vault` — Supabase ships it as **`supabase_vault`**.
   `create extension if not exists vault` errors with
   `extension "vault" is not available`. `enforceRequiredExtensions` is
   non-fatal per extension, so the pipeline would log it and continue with
   vault **not installed** — anything vault-backed (e.g. cron auth secrets)
   then fails downstream. Installed `supabase_vault` explicitly here; the
   other four installed cleanly.

3. **The clone halts on migration #1 — the repo is not a self-contained
   schema.** This is the load-bearing blocker. `applyPrimeMigrations` sorts
   the repo's `supabase/migrations/*.sql` by filename and applies each in
   order, halting on the first failure (`break; // schema state beyond this
   point is undefined`), after which `provisionCloneBackend` throws. The
   earliest file, `20250124120000_fix_client_data_rls_policies.sql`, begins:

   ```sql
   DROP POLICY IF EXISTS "Allow all access to client_activities" ON client_activities;
   ```

   `IF EXISTS` guards the *policy*, not the *table*, so on an empty database
   this is:

   ```
   ERROR: 42P01: relation "client_activities" does not exist
   ```

   Reproduced exactly against `plisdzywzleljorrphxv`. The migration history
   assumes base tables that **no migration in the repo creates**.

4. **Repo ↔ prime ledger drift confirms the cause.** The live prime
   (`dduzbchuswwbefdunfct`) has **546 public tables** but its migration ledger
   holds **853** entries, earliest version `20250827053832`. The repo ships
   **949** migration files, earliest `20250124120000` — i.e. the repo carries
   ~96 files the prime never tracked, and its oldest files *predate* the
   prime's ledger entirely. The base schema (`client_activities` et al.) was
   materialized out-of-band (Lovable dashboard / an untracked bootstrap), so
   it cannot be rebuilt by replaying the repo. **A migration replay cannot
   clone this prime; a live schema dump (`pg_dump --schema-only`) is the
   correct source.**

5. **Migration corpus exceeds single-call transport anyway.** 949 files /
   **158 MB**, of which four template-library seeds are **37–41 MB each**. The
   Management API query endpoint (and the MCP `apply_migration` tool) apply one
   migration per call as one statement; these four exceed the per-request
   payload ceiling, so even with #3 fixed they can't be shipped whole. They
   are data seeds, best loaded by `COPY`/`pg_restore`, not `apply_migration`.

6. **Mission Control's own backend is out of token scope (registration
   blocked).** MC records clones in `clones` / `clone_backends` on project
   `fgpvagejkaeqedcwvbte` (its `.env`). That project is **not** in this
   session's Supabase org (`nchuigmqbfcdhdgplrxq` holds only Aurixa Systems,
   Lazarus and the NPC prime), and `get_project` on it returns
   `You do not have permission to perform this action`. So this run could not
   be registered as a `clone_backends` row; it lives only in this doc.

7. **Local tooling gaps (minor).** Direct Postgres (`psql` 5432 to
   `db.*.supabase.co` and the pooler) is not reachable from this sandbox
   (connections time out), so DB work went via the Management API only; and
   two attempts to script bulk-SQL transport were declined by the environment's
   command classifier. Neither changes the outcome — #3/#4 are the real wall.

## What a working clone needs next (not done here)

- Dump the **live prime** schema (`pg_dump --schema-only` from
  `dduzbchuswwbefdunfct`) and apply that as the base, instead of replaying
  repo migrations from zero; then layer any repo migrations newer than the
  dump.
- Load the four large template-library seeds via `COPY`/`pg_restore`.
- Fix `REQUIRED_EXTENSIONS` in the prime repo (`vault` → `supabase_vault`).
- Replicate storage buckets, `[auth]` config, `pg_cron` schedule, realtime
  publication and secret shells (later pipeline steps, not reached).
- Wire `VITE_SUPABASE_*` to the new project and register a `clone_backends`
  row once the schema is real.
