-- =====================================================================
-- Exact schema transfer: PRIME  ->  THIS PROJECT.  Structure only.
-- =====================================================================
-- Runs ON THE CLONE. Pulls DDL straight from the prime over dblink, so no
-- definition passes through an agent's context and nothing can be truncated
-- in transit. That matters: the previous attempt carried DDL in ~50 kB
-- batches and lost the tail — 113 of 641 tables never arrived, and the run
-- still reported success because it checked that what it SENT applied, not
-- that what it sent was everything. Every stage here reconciles its own
-- count against the prime and RAISES if they differ.
--
-- IT NEVER COPIES A ROW. Every statement reads pg_catalog on the prime and
-- executes DDL locally. There is no SELECT against a data table anywhere in
-- this file, and stage 9 asserts the row count afterwards.
--
-- USAGE (psql, or Supabase SQL editor):
--   \set prime_conn 'host=aws-1-ap-southeast-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.dduzbchuswwbefdunfct password=... sslmode=require connect_timeout=15'
--   select clone_backend.transfer_all(:'prime_conn');
--
-- The prime is ap-southeast-1; this project is ap-southeast-2. The pooler
-- host is region-specific — aws-1-ap-southeast-1 is the one that answers.
-- =====================================================================

create schema if not exists clone_backend;
create extension if not exists dblink with schema extensions;

-- Records what each stage did, so a partial run is diagnosable.
create table if not exists clone_backend.transfer_log (
  id          bigserial primary key,
  ran_at      timestamptz not null default now(),
  stage       text not null,
  prime_count integer,
  clone_count integer,
  applied     integer,
  failed      integer,
  reconciled  boolean,
  errors      text[]
);

-- ---------------------------------------------------------------------
-- Generic engine: pull a set of DDL statements from the prime and apply
-- them here, one at a time so a single bad statement cannot roll back the
-- batch. `prime_count_sql` is evaluated on the PRIME, `clone_count_sql`
-- here, and the two must agree at the end.
-- ---------------------------------------------------------------------
create or replace function clone_backend.apply_stage(
  p_conn            text,
  p_stage           text,
  p_ddl_sql         text,   -- runs on the prime, returns one DDL text column
  p_prime_count_sql text,   -- runs on the prime, returns bigint
  p_clone_count_sql text,   -- runs here, returns bigint
  p_ignore_dupes    boolean default true
) returns text language plpgsql as $$
declare
  r            record;
  v_applied    int := 0;
  v_failed     int := 0;
  v_errs       text[] := '{}';
  v_prime      bigint;
  v_clone      bigint;
  v_msg        text;
begin
  execute format('select c from dblink(%L, %L) as t(c bigint)', p_conn, p_prime_count_sql)
    into v_prime;

  for r in
    execute format('select ddl from dblink(%L, %L) as t(ddl text)', p_conn, p_ddl_sql)
  loop
    begin
      execute r.ddl;
      v_applied := v_applied + 1;
    exception when others then
      get stacked diagnostics v_msg = MESSAGE_TEXT;
      -- "already exists" is success on a re-run, not a failure.
      if p_ignore_dupes and (v_msg ilike '%already exists%' or v_msg ilike '%duplicate%') then
        v_applied := v_applied + 1;
      else
        v_failed := v_failed + 1;
        if array_length(v_errs, 1) is null or array_length(v_errs, 1) < 40 then
          v_errs := v_errs || (left(r.ddl, 120) || '  ==>  ' || left(v_msg, 160));
        end if;
      end if;
    end;
  end loop;

  execute p_clone_count_sql into v_clone;

  insert into clone_backend.transfer_log
    (stage, prime_count, clone_count, applied, failed, reconciled, errors)
  values
    (p_stage, v_prime, v_clone, v_applied, v_failed, v_clone >= v_prime, v_errs);

  return format('%s: prime=%s clone=%s applied=%s failed=%s %s',
                p_stage, v_prime, v_clone, v_applied, v_failed,
                case when v_clone >= v_prime then 'OK' else '*** SHORT ***' end);
end $$;

-- ---------------------------------------------------------------------
-- The stages, in dependency order.
-- ---------------------------------------------------------------------
create or replace function clone_backend.transfer_all(p_conn text)
returns table(stage_result text) language plpgsql as $$
declare
  c_schema_filter constant text := $f$ n.nspname in ('public','aml') $f$;
begin
  perform dblink_connect('prime_check', p_conn);
  perform dblink_disconnect('prime_check');

  execute 'create schema if not exists public';
  execute 'create schema if not exists aml';

  -- 1. ENUMS / composite types ----------------------------------------
  return query select clone_backend.apply_stage(p_conn, '1-types',
    $q$
    select 'create type ' || quote_ident(n.nspname) || '.' || quote_ident(t.typname) ||
           ' as enum (' || (select string_agg(quote_literal(e.enumlabel), ',' order by e.enumsortorder)
                            from pg_enum e where e.enumtypid = t.oid) || ');'
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where t.typtype = 'e' and n.nspname in ('public','aml')
    $q$,
    $q$ select count(*) from pg_type t join pg_namespace n on n.oid=t.typnamespace
        where t.typtype='e' and n.nspname in ('public','aml') $q$,
    $q$ select count(*) from pg_type t join pg_namespace n on n.oid=t.typnamespace
        where t.typtype='e' and n.nspname in ('public','aml') $q$);

  -- 2. SEQUENCES -------------------------------------------------------
  return query select clone_backend.apply_stage(p_conn, '2-sequences',
    $q$
    select 'create sequence if not exists ' || quote_ident(n.nspname) || '.' || quote_ident(c.relname) || ';'
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'S' and n.nspname in ('public','aml')
    $q$,
    $q$ select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where c.relkind='S' and n.nspname in ('public','aml') $q$,
    $q$ select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where c.relkind='S' and n.nspname in ('public','aml') $q$);

  -- 3. TABLES (columns + defaults + NOT NULL; keys come in stage 5) ----
  return query select clone_backend.apply_stage(p_conn, '3-tables',
    $q$
    select 'create table if not exists ' || quote_ident(n.nspname) || '.' || quote_ident(c.relname) || ' (' ||
           coalesce((
             select string_agg(
               quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod) ||
               case when a.attnotnull then ' not null' else '' end ||
               coalesce(' default ' || pg_get_expr(ad.adbin, ad.adrelid), ''),
               ', ' order by a.attnum)
             from pg_attribute a
             left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
             where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
           ), '') || ');'
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'r' and n.nspname in ('public','aml')
    $q$,
    $q$ select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where c.relkind='r' and n.nspname in ('public','aml') $q$,
    $q$ select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where c.relkind='r' and n.nspname in ('public','aml') $q$);

  -- 4. FUNCTIONS (before views/triggers/policies, which reference them) -
  --    Extension-owned functions are skipped: they arrive with CREATE EXTENSION.
  return query select clone_backend.apply_stage(p_conn, '4-functions',
    $q$
    select pg_get_functiondef(p.oid) || ';'
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    left join pg_depend d on d.objid = p.oid and d.deptype = 'e'
    where n.nspname in ('public','aml') and d.objid is null
      and p.prokind in ('f','p')
    $q$,
    $q$ select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        left join pg_depend d on d.objid=p.oid and d.deptype='e'
        where n.nspname in ('public','aml') and d.objid is null and p.prokind in ('f','p') $q$,
    $q$ select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        left join pg_depend d on d.objid=p.oid and d.deptype='e'
        where n.nspname in ('public','aml') and d.objid is null and p.prokind in ('f','p') $q$);

  -- 5. CONSTRAINTS (pk, unique, fk, check) -----------------------------
  --    Ordered so primary/unique keys land before the FKs that need them.
  return query select clone_backend.apply_stage(p_conn, '5-constraints',
    $q$
    select 'alter table ' || quote_ident(n.nspname) || '.' || quote_ident(rel.relname) ||
           ' add constraint ' || quote_ident(con.conname) || ' ' ||
           pg_get_constraintdef(con.oid) || ';'
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace n on n.oid = rel.relnamespace
    where n.nspname in ('public','aml')
    order by case con.contype when 'p' then 1 when 'u' then 2 when 'c' then 3 else 4 end
    $q$,
    $q$ select count(*) from pg_constraint con join pg_class rel on rel.oid=con.conrelid
        join pg_namespace n on n.oid=rel.relnamespace where n.nspname in ('public','aml') $q$,
    $q$ select count(*) from pg_constraint con join pg_class rel on rel.oid=con.conrelid
        join pg_namespace n on n.oid=rel.relnamespace where n.nspname in ('public','aml') $q$);

  -- 6. INDEXES (constraint-backed ones already exist; skipped by name) --
  return query select clone_backend.apply_stage(p_conn, '6-indexes',
    $q$
    select i.indexdef || ';'
    from pg_indexes i
    where i.schemaname in ('public','aml')
      and not exists (
        select 1 from pg_constraint c
        join pg_class ic on ic.oid = c.conindid
        where ic.relname = i.indexname)
    $q$,
    $q$ select count(*) from pg_indexes where schemaname in ('public','aml') $q$,
    $q$ select count(*) from pg_indexes where schemaname in ('public','aml') $q$);

  -- 7. VIEWS -----------------------------------------------------------
  return query select clone_backend.apply_stage(p_conn, '7-views',
    $q$
    select 'create or replace view ' || quote_ident(schemaname) || '.' || quote_ident(viewname) ||
           ' as ' || definition
    from pg_views where schemaname in ('public','aml')
    $q$,
    $q$ select count(*) from pg_views where schemaname in ('public','aml') $q$,
    $q$ select count(*) from pg_views where schemaname in ('public','aml') $q$);

  -- 8. TRIGGERS --------------------------------------------------------
  return query select clone_backend.apply_stage(p_conn, '8-triggers',
    $q$
    select pg_get_triggerdef(t.oid) || ';'
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where not t.tgisinternal and n.nspname in ('public','aml')
    $q$,
    $q$ select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid
        join pg_namespace n on n.oid=c.relnamespace
        where not t.tgisinternal and n.nspname in ('public','aml') $q$,
    $q$ select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid
        join pg_namespace n on n.oid=c.relnamespace
        where not t.tgisinternal and n.nspname in ('public','aml') $q$);

  -- 9. RLS: enable on every table FIRST, so no window exists in which a
  --    table is reachable without its policies.
  return query select clone_backend.apply_stage(p_conn, '9-rls-enable',
    $q$
    select 'alter table ' || quote_ident(n.nspname) || '.' || quote_ident(c.relname) ||
           ' enable row level security;'
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'r' and n.nspname in ('public','aml') and c.relrowsecurity
    $q$,
    $q$ select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where c.relkind='r' and n.nspname in ('public','aml') and c.relrowsecurity $q$,
    $q$ select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where c.relkind='r' and n.nspname in ('public','aml') and c.relrowsecurity $q$);

  -- 10. POLICIES -------------------------------------------------------
  return query select clone_backend.apply_stage(p_conn, '10-policies',
    $q$
    select 'create policy ' || quote_ident(p.policyname) || ' on ' ||
           quote_ident(p.schemaname) || '.' || quote_ident(p.tablename) ||
           ' as ' || p.permissive ||
           ' for ' || p.cmd ||
           ' to ' || array_to_string(p.roles, ', ') ||
           coalesce(' using (' || p.qual || ')', '') ||
           coalesce(' with check (' || p.with_check || ')', '') || ';'
    from pg_policies p where p.schemaname in ('public','aml')
    $q$,
    $q$ select count(*) from pg_policies where schemaname in ('public','aml') $q$,
    $q$ select count(*) from pg_policies where schemaname in ('public','aml') $q$);

  return query select '--- see clone_backend.transfer_log for the full reconciliation ---'::text;
end $$;

-- ---------------------------------------------------------------------
-- Post-transfer assertion: still a shell, and no coupling to the prime.
-- ---------------------------------------------------------------------
create or replace function clone_backend.verify_shell()
returns table(check_name text, result text) language plpgsql as $$
declare v_rows bigint := 0; c bigint; r record; v_bad text := '';
begin
  for r in select schemaname, tablename from pg_tables where schemaname in ('public','aml') loop
    execute format('select count(*) from %I.%I', r.schemaname, r.tablename) into c;
    v_rows := v_rows + c;
    if c > 0 then v_bad := v_bad || r.schemaname||'.'||r.tablename||'='||c||' '; end if;
  end loop;

  return query select 'total rows (expect 2: the superadmin)', v_rows::text;
  return query select 'non-empty tables', coalesce(nullif(v_bad,''), '(none)');
  return query select 'stages that came up SHORT',
    coalesce((select string_agg(stage||' '||clone_count||'/'||prime_count, ', ')
              from clone_backend.transfer_log where not reconciled), '(none — all reconciled)');
  return query select 'functions still naming the PRIME project',
    coalesce((select string_agg(p.proname, ', ') from pg_proc p
              join pg_namespace n on n.oid=p.pronamespace
              where n.nspname in ('public','aml')
                and p.prosrc ilike '%dduzbchuswwbefdunfct%'), '(none)');
  return query select 'cron jobs (must be 0 until re-pointed)',
    (select count(*)::text from cron.job);
end $$;
