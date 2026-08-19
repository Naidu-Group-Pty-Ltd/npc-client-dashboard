# Dedicated backend — state of the shell

The client-facing dashboard is to run on its **own** Supabase backend rather
than sharing the prime's production project (`dduzbchuswwbefdunfct`). This
records what that backend currently is, how it was built, and exactly what is
left. It is WIP.

## The headline: there is no live data on it

**Verified by scanning every table**: 528 tables scanned, and the total number
of rows in the entire database is **2** — one `custom_users` row and its one
`user_roles` row, which together are the single superadmin. `auth.users` is 0,
`storage.objects` is 0, `storage.buckets` is 0.

No production data was ever copied, and none can have been: every statement
executed against this project was **DDL** (structure). No `INSERT`, `COPY` or
`SELECT INTO` ever moved a row out of the prime. Client PII, AML records and
financial data never left the prime's project.

| | |
| --- | --- |
| Project ref | `plisdzywzleljorrphxv` |
| URL | `https://plisdzywzleljorrphxv.supabase.co` |
| Org / region | Xenochrome 3 · `ap-southeast-2` (Sydney) |
| Status | `ACTIVE_HEALTHY` |
| **Rows in database** | **2 (the superadmin only)** |

### The single superadmin

`custom_users` (the dashboard's own auth table) holds one row:
`username=admin`, `email=admin@npcservices.com.au`, `role=super_admin`,
`is_active=true`, with a bcrypt `password_hash` generated from a random
throwaway string. **Nobody knows that password — set one before use** (update
`password_hash` with `crypt('<new>', gen_salt('bf',10))`). A matching
`user_roles` row carries `role='superadmin'`.

## What the shell contains

| Object | On the clone | On the prime | State |
| --- | --- | --- | --- |
| Schemas (`public`, `aml`) | 2 | 2 | done |
| Enum types | 94 | 94 | **complete** |
| Extensions | 9 | 8 (+`pg_graphql`) | **complete** |
| Tables | **528** | 641 | 82% |
| RLS enabled | **528 / 528** | — | **complete (deny-all)** |
| RLS policies | 0 | 1,149 | not started |
| Functions (app) | 0 | 604 | not started |
| Indexes | 2 | 2,135 | not started |
| Constraints | 2 | 2,560 | not started |
| Triggers | 0 | 472 | not started |
| Views / matviews | 0 | 14 | not started |
| Storage buckets | 0 | 32 | not started |
| Edge functions | 0 | 424 | not started |

**RLS is enabled on every table with no policies**, which is deny-all. That is
the correct posture for an empty shell: nothing can read or write through the
anon/authenticated roles, and only the service role (which bypasses RLS) can
reach it. Do not load data before the policies land.

## How it was built, and why it stopped where it did

The migration replay in Mission Control's clone pipeline **cannot** build this
schema — the repo's own migration history assumes base tables that no migration
in the repo creates, so it fails on file #1 (`relation "client_activities" does
not exist`), and the repo has drifted from the prime's ledger (949 repo files
vs 853 tracked; 546 live tables materialised out of band).

So the schema was rebuilt by **introspecting the live prime read-only** and
replaying generated DDL through the Supabase Management API. That works — 94/94
enums and 528 tables applied with zero failures — but the DDL has to pass
through the agent's context in ~50 KB batches, and at that size batches
reliably lose their largest statements (three separate repair passes were
needed). It is the wrong tool for the remaining volume.

## Finishing it properly (2 minutes, needs the DB password)

The rest wants `pg_dump`, which produces a byte-exact schema including the
things catalog introspection cannot reproduce (comments, grants/ownership,
storage parameters, collations, sequence ownership, partition attachments).
From a machine with network access to both projects and the **prime's database
password** (Supabase dashboard → Settings → Database):

```sh
# 1. Dump the prime's schema only — no data, ever.
pg_dump "postgresql://postgres:<PRIME_PW>@db.dduzbchuswwbefdunfct.supabase.co:5432/postgres" \
  --schema-only --no-owner --no-privileges \
  --schema=public --schema=aml \
  -f prime-schema.sql

# 2. Apply it to the empty clone (drop what is there first for a clean run).
psql "postgresql://postgres:<CLONE_PW>@db.plisdzywzleljorrphxv.supabase.co:5432/postgres" \
  -c 'drop schema public cascade; create schema public; drop schema if exists aml cascade;' \
  -f prime-schema.sql
```

`--schema-only` is what keeps this a shell: it emits structure and never a row.
Re-seed the superadmin afterwards, and re-run the row-count check below.

### The check that proves it is still a shell

```sql
do $$
declare r record; c bigint;
begin
  for r in select schemaname, tablename from pg_tables
           where schemaname in ('public','aml') loop
    execute format('select count(*) from %I.%I', r.schemaname, r.tablename) into c;
    if c > 0 then raise notice '% .% = %', r.schemaname, r.tablename, c; end if;
  end loop;
end $$;
```

Expect exactly two notices: `custom_users = 1` and `user_roles = 1`.

## Still blocking the switch-over

**31 source files hardcode `https://dduzbchuswwbefdunfct.supabase.co`**
(`useAuth`, the portal hooks and libs, `integrations/supabase/client.ts`, …).
Until those read from `VITE_SUPABASE_URL`, pointing this repo at its own
backend cannot work no matter how complete the schema is. That is the next
change to make, and it belongs upstream.

`.env.example` therefore still points at the prime, with this project's
coordinates commented out.
