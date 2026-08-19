# Backend isolation — audit, 19 Aug 2026

**The requirement.** Each repository acts on its own Supabase project and no
other. `npc-property-dashbord` → `dduzbchuswwbefdunfct` (the prime).
`npc-client-dashboard` → `plisdzywzleljorrphxv` (this one). The two are
identical in structure; this one holds no live data.

This records a full scan of both repositories and both live databases against
that requirement: what held, what did not, and what is left.

## Verdict

| Direction | Status |
| --- | --- |
| Prime repo/backend → this backend | **clean, nothing to fix** |
| This repo's CI → prime's backend | **was reachable — fixed here** |
| This repo's app → prime's backend | **still points at the prime, by necessity** |
| Data isolation (no live data here) | **holds: exactly 2 rows, both the superadmin** |

## 1. The prime never reaches this project — verified, no change needed

Scanned the prime's source, its CI, and its live database:

- **Source:** one occurrence of this project's ref in the whole repo, and it is
  a string in `src/integrations/supabase/__tests__/env.test.ts`. No live code.
- **Live database:** 0 function bodies, 0 column defaults, 0 views, 0 check
  constraints and 0 cron jobs name this project. **0 foreign servers** exist, so
  there is no `postgres_fdw`/`dblink` path between the two at all.
- **Outbound calls:** of the prime's 47 cron jobs, 44 are pure SQL and the 3 that
  make HTTP calls target `dduzbchuswwbefdunfct.supabase.co` — itself. Across
  **3,691 retained `net._http_response` rows, 0** were requests to this project.
- **Mission Control** (`fgpvagejkaeqedcwvbte`) has **0** references to this
  project. It names the prime only as the billing tenant string
  `prime:dduzbchuswwbefdunfct` — an identifier, not a connection.
  `aurixa-systems` (`moeyytuduycrvvncdtme`) references neither.

## 2. This repo's CI could have written into the prime — fixed

This repository is a mirror, so it inherited the prime's CI **with the prime's
project ref as the default target**. Three places:

| Where | Trigger | What it would have done |
| --- | --- | --- |
| `deploy-supabase-functions.yml` (×2) | **push to `main`** | deployed this repo's edge functions into the prime's production |
| `apply-migration.yml` | manual | applied this repo's migrations to the prime's database |
| `supabase/config.toml` `project_id` | read by `rotate-internal-edge-secret` and `aml-sanctions-refresh` (**daily cron**) | rotated the prime's `INTERNAL_EDGE_SECRET`; written sanctions lists into the prime |

**Nothing was ever deployed.** The run of 19 Aug 2026 10:18 UTC, triggered by
the merge of PR #8 into `main`, shows `TOKEN:` empty → `ready=false` → *"Edge
functions changed but no SUPABASE_ACCESS_TOKEN is configured — nothing was
deployed"*, exit 1. This repository holds no `SUPABASE_ACCESS_TOKEN`.

That is the point. **The protection was an absent credential, not a correct
target.** Adding that secret — the obvious step when wiring this repo to its own
backend — would by itself have pointed all of it at the prime's production.

Fixed:

- `supabase/config.toml` now declares `plisdzywzleljorrphxv`.
- The `vars.SUPABASE_PROJECT_REF || '<prime>'` defaults are gone. Both
  project-targeting workflows now **fail closed**: an unset variable stops the
  job with a named error. There is no safe default for "which project" — an
  unset variable is a question, not a licence to guess.
- `src/lib/__tests__/backendIsolation.spec.ts` asserts all of it, and was
  checked by reintroducing each regression in turn.

**Before enabling any deploy here, set the repository variable
`SUPABASE_PROJECT_REF` to `plisdzywzleljorrphxv`.** Adding
`SUPABASE_ACCESS_TOKEN` without it now fails loudly instead of acting on the
prime.

## 3. The app still reads and writes the PRIME — open, and deliberate

`src/integrations/supabase/env.ts` falls back to the prime when
`VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` are unset, and
`.env.example` ships them unset. **A build of this repo deployed today operates
on the prime's production data.**

This is not an oversight; it is the only way the app functions at all right now,
because this project is an empty shell with no policies, functions or edge
functions. The switch-over is the two variables and nothing else — see
`BACKEND_PROVISIONING.md`. It cannot be flipped until the schema is finished.

## 4. The trap waiting on the schema transfer

Finishing the schema is where isolation is most likely to be lost, silently.

**Do not replay the repo's migrations here.** 28 migration files call
`net.http_post` against the prime's URL **hardcoded**, and 22 of those embed the
prime's anon JWT inline as a bearer token, across 15 distinct edge-function
endpoints (`migration-dispatcher` ×12, `send-web-push` ×6, …). Replaying them
would install cron jobs on this database that call the prime's functions on a
schedule, forever. Today this cannot have happened:
`supabase_migrations.schema_migrations` here has **0 rows** — no migration has
ever run on this project.

**`pg_dump --schema-only` is much safer, but not clean.** The prime's *live*
functions have been hardened since those migrations: all 5 that call
`net.http_post` resolve their URL from `vault.decrypted_secrets`, and **none**
embeds a JWT. But four still carry the prime's URL as a **fallback for when the
vault is empty** — which is exactly the state a fresh shell is in:

| Function | How the prime leaks in |
| --- | --- |
| `bootstrap_cron_vault` | seeds the vault with `'https://dduzbchuswwbefdunfct.supabase.co'` literally |
| `dispatch_web_push_on_notification` | `v_url text := 'https://<prime>/functions/v1/send-web-push'` |
| `dispatch_web_push_for_portal_notification` | same |
| `invoke_pdf_parse_recover_stuck_jobs` | `COALESCE(NULLIF(v_url,''), 'https://<prime>')` |

So after any schema transfer, **before scheduling anything**:

1. Rewrite `bootstrap_cron_vault` to name this project, or skip it and insert
   `supabase_url` into this project's vault by hand.
2. Re-point the three fallbacks at this project.
3. Re-run the probes in §5 — `cron.job` and `net._http_response` must show
   nothing addressed to the prime.

## 5. The probes, so this can be re-checked

```sql
-- On EITHER project: does anything name the other one?
select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname in ('public','aml') and p.prosrc ilike '%<other-ref>%';

select jobname, command from cron.job where command ilike '%<other-ref>%';
select count(*) from pg_foreign_server;                       -- must be 0
select count(*) from net._http_response r
  join net.http_request_queue q on q.id=r.id
  where q.url ilike '%<other-ref>%';                          -- must be 0
```

Emptiness of this project (expect 528 / 2 / `custom_users=1, user_roles=1`):

```sql
with counts as (
  select t.table_schema, t.table_name,
         (xpath('/row/c/text()', query_to_xml(
            format('select count(*) as c from %I.%I', t.table_schema, t.table_name),
            false, true, '')))[1]::text::bigint as exact_rows
  from information_schema.tables t
  where t.table_schema in ('public','aml') and t.table_type='BASE TABLE')
select count(*) as tables, sum(exact_rows) as total_rows,
       string_agg(table_name||'='||exact_rows, ', ') filter (where exact_rows>0) as non_empty
from counts;
```

## 6. State of this project as scanned

| | |
| --- | --- |
| Tables (`public`+`aml`) | 528 |
| **Exact total rows** | **2** — `custom_users=1`, `user_roles=1` |
| `auth.users` / `storage.buckets` / `storage.objects` | 0 / 0 / 0 |
| Migration ledger rows | 0 |
| Cron jobs / cron history | 0 / 0 |
| `net` outbound requests ever made | **0** |
| Foreign servers / user mappings | 0 / 0 |
| Edge functions | 0 |
| Vault secrets | 0 |
| App functions in `public`/`aml` | 0 (the 118 present are all `vector`'s) |
| App RLS policies | 0 — **deny-all**, RLS on all 528 tables |
| Indexes / constraints / views | 2 / 2 / 0 — **incomplete, see `BACKEND_PROVISIONING.md`** |

The 6 triggers and 2 policies visible outside `public`/`aml` are Supabase's own
(storage, realtime, `cron.job`), not application objects.

**No API keys are configured here yet** — 0 vault secrets and 0 edge-function
secrets, which is consistent since there are no functions to use them. Loading
them is part of finishing the backend, not a violation of the empty-shell rule.
