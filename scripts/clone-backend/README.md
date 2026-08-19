# Cloning the prime's backend onto this project

Two scripts, two channels, because the two halves of a Supabase project are
reachable by different means from a machine that has no Postgres port open.

| | What it moves | Channel | Credential |
| --- | --- | --- | --- |
| `01-transfer-schema.sql` | types, tables, functions, constraints, indexes, views, triggers, RLS, policies | `dblink`, clone's Postgres → prime's pooler | the prime's DB password, or a read-only role on it |
| `02-functions-and-secrets.sh` | 423 edge functions + vendor API keys | Management API + `supabase` CLI over HTTPS | a Supabase PAT (`sbp_…`) |

Neither moves a row. `01` reads only `pg_catalog` and executes DDL; `02`
deploys function source from this repo and copies secret values.

## Why not just have the agent do it

It tried, and it produced the half-built state this replaces. The DDL is
1.58 MB and the function sources are 19 MB. Carrying that through an agent's
context means chunking it, and the chunking silently dropped the tail:
**113 of the prime's 641 tables never arrived**, in one clean alphabetical
run from `partner_agreements` to `workflows`.

The run reported success because it verified that every statement it *sent*
applied without error. It never asked whether what it sent was everything.
That is the specific mistake these scripts are built to make impossible:
every stage in `01` counts the objects on the prime, counts them here
afterwards, and records `reconciled = false` when they differ.

## Order

```sh
# 1. Schema. Run from psql or the Supabase SQL editor, ON THIS PROJECT.
\i 01-transfer-schema.sql
select clone_backend.transfer_all(
  'host=aws-1-ap-southeast-1.pooler.supabase.com port=5432 dbname=postgres '
  'user=postgres.dduzbchuswwbefdunfct password=<PRIME_PW> sslmode=require');

select * from clone_backend.transfer_log order by id;   -- every stage must reconcile
select * from clone_backend.verify_shell();             -- still 2 rows, still no prime coupling

# 2. Edge functions and secrets.
export SUPABASE_ACCESS_TOKEN=sbp_...
./02-functions-and-secrets.sh
```

The prime is in **ap-southeast-1**; this project is in **ap-southeast-2**. The
pooler hostname is region-specific and `aws-1-ap-southeast-1` is the one that
answers — `aws-0-…` returns `ENOTFOUND tenant/user`, which reads like a
credential problem and is not one.

## Safer than handing over the superuser password

`01` only ever reads `pg_catalog`. Create a role scoped to that, use it, drop
it — then the credential in play can do nothing else, and nothing needs
revoking later:

```sql
-- ON THE PRIME, once.
create role clone_reader login password '<throwaway>';
grant connect on database postgres to clone_reader;
grant usage on schema public, aml, pg_catalog to clone_reader;
grant select on all tables in schema pg_catalog to clone_reader;
-- afterwards:  drop role clone_reader;
```

`pg_get_functiondef` and friends need no table privileges, so this is enough
for the whole transfer and grants no access to a single row of client data.

## Afterwards — three things, or isolation is lost

1. **`drop extension dblink;`** on this project. It exists only for the
   transfer, and leaving it is a standing route to the prime.
2. **Re-point the four functions that carry the prime's URL as a fallback**
   (`bootstrap_cron_vault`, `dispatch_web_push_on_notification`,
   `dispatch_web_push_for_portal_notification`,
   `invoke_pdf_parse_recover_stuck_jobs`). They read `vault.decrypted_secrets`
   first and fall back to a hardcoded prime URL when the vault is empty —
   which is exactly this project's state. Seed `supabase_url` here before
   scheduling anything. See `docs/BACKEND_ISOLATION.md`.
3. **Revoke the PAT**, and drop `clone_reader` on the prime.

Do not schedule any cron job until 2 is done: `verify_shell()` reports both
the remaining prime references and the cron count for exactly that reason.
