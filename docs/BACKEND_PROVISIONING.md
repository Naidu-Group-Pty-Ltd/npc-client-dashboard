# Dedicated backend — state of the shell

The client-facing dashboard is to run on its **own** Supabase backend rather
than sharing the prime's production project (`dduzbchuswwbefdunfct`). This
records what that backend is and how it was built. **The schema, edge
functions and vendor API keys are now cloned and reconciled against the
prime**; what remains is a decision, not a build — see "Pointing the app at
it" below.

## The headline: it matches the prime, and holds no data

Every schema object reconciles against the prime — 641 tables with a
byte-identical column signature, 2,560 constraints, 2,136 indexes, 491
functions, 472 triggers, 1,149 policies, 13 views, 1 materialized view, 32
storage buckets — and **the entire database contains 2 rows**, both belonging
to the single superadmin.

No production data was copied, and none could have been: every source query
run against the prime reads `pg_catalog`, and the transfer script asserts each
one begins with `select`/`with` before it runs. Client PII, AML records and
financial data never left the prime.

| | |
| --- | --- |
| Project ref | `plisdzywzleljorrphxv` |
| URL | `https://plisdzywzleljorrphxv.supabase.co` |
| Org / region | Xenochrome 3 · `ap-southeast-2` (Sydney) — the prime is `ap-southeast-1` |
| Postgres | 17.6 (prime: 17.4) |
| **Rows in database** | **2 (the superadmin only)** |

### The single superadmin

`custom_users` holds one row: `username=admin`,
`email=admin@npcservices.com.au`, `role=super_admin`, `is_active=true`, with a
bcrypt hash of a random throwaway string. **Nobody knows that password — set
one before use** (`update custom_users set password_hash =
crypt('<new>', gen_salt('bf',10))`). A matching `user_roles` row carries
`role='superadmin'`.

## What it contains

| Object | Clone | Prime | State |
| --- | --- | --- | --- |
| Enum types | 94 | 94 | **complete** |
| Tables | **641** | 641 | **complete** |
| Columns | md5 `a0b94bdb…` | md5 `a0b94bdb…` | **byte-identical** |
| Constraints | 2,560 | 2,560 | **complete** (name set md5-identical) |
| Indexes | 2,136 | 2,136 | **complete** |
| Functions | 491 | 491 | **complete** |
| Triggers | 472 | 472 | **complete** |
| Views | 13 | 13 | **complete** |
| Materialized views | 1 | 1 | **complete** |
| RLS policies | 1,149 | 1,149 | **complete** |
| Tables with RLS | 641 | 640 | see note |
| Sequences | 1 | 1 | **complete** |
| Storage buckets | 32 | 32 | **complete** (0 objects) |
| Edge functions | 423 | 432 | **complete** — the 9 extra are stale on the prime |
| Secrets | 81 | 83 | 72 vendor keys copied; identity regenerated |

**Rows in the entire database: 2** — `custom_users=1`, `user_roles=1`, the
single superadmin. `auth.users`, `storage.objects`, cron jobs and lifetime
`pg_net` requests are all 0, and **no function references the prime**.

Three deliberate differences, none of them drift:

- **`aml.launch_certifications` has RLS enabled here and disabled on the
  prime.** Left enabled: matching the prime would mean turning RLS off, and an
  empty table with RLS on is the safe end of that trade. One statement to
  match if exact parity is wanted.
- **9 edge functions run on the prime that are not in the repo.** Three —
  `manage-partner-agreements`, `finance-portal-agreements`,
  `agreement-centre-render` — were **deliberately deleted** (see
  `docs/agreements/TEMPLATES_ONLY.md`); the rest are `mc-diag-tmp`,
  `mc-wallet-diag`, `ghl-workflow-probe`, `builder-stock-inpaint-probe`,
  `gamma-agreement-generator`, `sync-vault-internal-secret`. The repo is the
  source of truth, so they are not cloned. **The prime is running code its own
  repository no longer contains.**
- **`INTERNAL_EDGE_SECRET` and `CSRF_TOKEN_PEPPER` are freshly generated, not
  copied**, and `SUPABASE_*` / `ALLOWED_ORIGINS` / `APP_URL` are not copied at
  all. Sharing a signing secret would make a token minted for one deployment
  valid on the other; copying `SUPABASE_URL` would point this project's own
  functions at the prime.

### How the first attempt failed

113 tables were missing — one clean alphabetical run from `partner_agreements`
to `workflows`. **The run reported "528 tables applied, zero failures" because
it verified that every statement it SENT applied without error. It never asked
whether what it sent was everything.** Reconciling 528 against 641 was one
query and it was not run.

`scripts/clone-backend/` replaces that: it moves bytes machine-to-machine over
the Management API, and every stage reconciles against the prime. Its README
records the five other traps this uncovered — `create table if not exists` not
repairing an existing table, `LANGUAGE sql` functions needing repeated passes,
matviews being invisible to table queries, bare `import 'x'` having no `from`,
and the CLI being unable to deploy from behind this proxy.

## How it was done — `scripts/clone-backend/`

Two scripts, one credential (a Supabase PAT), everything over HTTPS —
**[`scripts/clone-backend/README.md`](../scripts/clone-backend/README.md)**.
They move bytes machine-to-machine over the Management API rather than through
an agent's context, which is what truncated the first attempt. Re-running them
is safe and idempotent; that is how the schema is kept in step as the prime
changes.

## Pointing the app at it (the wiring is done)

**This used to be impossible for a reason that had nothing to do with the
schema**: 31 source files wrote `https://dduzbchuswwbefdunfct.supabase.co` and
its publishable key into their own module scope, so setting
`VITE_SUPABASE_URL` moved nothing — almost every caller ignored it and dialled
the prime directly. All 31 now import from `src/integrations/supabase/env.ts`.

The switch-over is therefore the two variables and nothing else:

```sh
VITE_SUPABASE_URL="https://plisdzywzleljorrphxv.supabase.co"
VITE_SUPABASE_PUBLISHABLE_KEY="<the anon key — .env.example carries it>"
```

Verified end to end: a build with both set carries `plisdzywzleljorrphxv` in
five chunks and reaches the prime's constants through no live path; a build
with neither is byte-for-byte the old behaviour.

Three rules that module enforces, each of which was a live defect:

- **The URL and the key are a matched pair.** The anon key is a JWT whose `ref`
  claim names its project, so a URL from one and a key from another
  authenticate to nothing. Set both or neither — a half-configured environment
  uses *both* built-in defaults rather than mixing them, and says so on the
  console. Supplying a genuinely mismatched pair is honoured and warned about
  by ref, because that is a configuration error and should read as one.
- **The fallback is never empty.** `internalMessageAttachments.ts` read
  `VITE_SUPABASE_URL ?? ''`, which made the upload PUT relative — it went to
  the app's own origin and got HTML back.
- **The project ref is derived, never named a third time.**
  `VITE_SUPABASE_PROJECT_ID` was a third spelling of the same project, free to
  disagree with the other two; unset, `TemplateSharePreview` fetched
  `https://undefined.supabase.co/functions/v1/template-share`. Nothing live
  reads it now — `SUPABASE_PROJECT_REF` comes off the resolved URL.

`.env.example` still points at the prime, with this project's pair commented
out directly beneath it. **The blocker that used to sit here is gone**: the
schema, all 423 edge functions and the vendor API keys are in place, so an app
pointed here now starts and runs. Uncommenting the pair is the switch-over.

Two things to do first, deliberately left for a person:

1. **Set the superadmin password** (above). Nobody knows the current one.
2. **Decide about `aml.launch_certifications`** — RLS is enabled here and
   disabled on the prime.

And know what changes on the day you flip it: this deployment stops reading
the prime's live clients, listings and AML records and starts on an empty
database. That is the intent, but it is not reversible by editing an env
var — anything written here afterwards lives only here.
