# Cloning the prime's backend onto this project

Two scripts. Both need one credential — a Supabase personal access token with
access to both projects — and nothing else. No database password, no open
Postgres port.

```sh
export SUPABASE_ACCESS_TOKEN=sbp_...      # revoke when finished
python3 01-transfer-schema.py             # types, tables, functions, constraints,
                                          # indexes, views, triggers, RLS, policies
python3 02-deploy-functions.py            # every edge function in supabase/functions/
```

Neither moves a row. `01` reads only `pg_catalog` on the prime — it asserts
every source query starts with `select`/`with` — and executes DDL here. `02`
uploads function source from this repo.

## Why they exist

An earlier attempt carried the DDL through an agent's context in ~50 kB
batches and lost the tail: **113 of the prime's 641 tables never arrived**, in
one clean run from `partner_agreements` to `workflows`.

It reported success because it verified that every statement it *sent* applied
without error. It never asked whether what it sent was everything. Every stage
in `01` now counts the objects on the prime, counts them here afterwards, and
prints `*** SHORT ***` when they differ.

## Things that bite, all of them found the hard way

- **`create table if not exists` does not fix an existing table.** 528 tables
  already existed from the failed run, so the re-run skipped them and two kept
  a stale column set. Counts matched while columns did not — reconcile columns
  by md5, not tables by count.
- **`LANGUAGE sql` functions are validated at creation.** One that calls
  another fails if the callee is not there yet, so the function stage needs
  running until it converges. It took three passes: 12 failed, then 1, then 0.
- **Indexes and matviews are separate.** `pg_indexes` counts constraint-backed
  indexes too, and `relkind='m'` is not `'r'` — one materialized view
  (`pdf_import_cost_daily`) is invisible to every table query.
- **A bare `import './x.ts'` has no `from`.** A dependency resolver keyed on
  `from` silently omits it, and only shows up as a bundle failure at deploy.
- **The Supabase CLI cannot deploy from here.** `supabase functions deploy`
  returns `FunctionsApiTransportError` behind this session's egress proxy; the
  same multipart POST to `/v1/projects/{ref}/functions/deploy` returns 201.
- **Cloudflare in front of the Management API rejects `python-urllib`'s
  User-Agent** with a 403 (error 1010). Send curl's.

## What is deliberately NOT copied

| | Why |
| --- | --- |
| `SUPABASE_*` secrets | project-specific; copying `SUPABASE_URL` would point this project's own functions at the prime |
| `INTERNAL_EDGE_SECRET`, `CSRF_TOKEN_PEPPER` | per-deployment identity — sharing them makes a token minted for one deployment valid on the other. `01` generates fresh random values |
| `ALLOWED_ORIGINS`, `APP_URL` | deployment config naming the prime's own domain |
| 9 edge functions on the prime | not in this repo. Three (`manage-partner-agreements`, `finance-portal-agreements`, `agreement-centre-render`) were **deliberately deleted** — see `docs/agreements/TEMPLATES_ONLY.md`. The rest are `-tmp`/`-diag`/`-probe` leftovers. The repo is the source of truth |

## Afterwards

`01` seeds this project's vault with its own `supabase_url` and rewrites the
four functions that carry the prime's URL as a fallback
(`bootstrap_cron_vault`, both `dispatch_web_push_*`,
`invoke_pdf_parse_recover_stuck_jobs`). Verify with:

```sql
select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname in ('public','aml') and p.prosrc ilike '%dduzbchuswwbefdunfct%';  -- must be 0
select count(*) from cron.job;                                                    -- 0 until you schedule
```

Then revoke the PAT.
