#!/usr/bin/env python3
"""
Schema transfer: PRIME -> CLONE, structure only, via the Supabase Management API.

Nothing here selects from a data table on the prime; every source query reads
pg_catalog. Every stage reconciles its own count against the prime afterwards,
because the previous attempt verified only that what it SENT applied.
"""
import json, os, sys, time, urllib.request, urllib.error

TOKEN = os.environ['SUPABASE_ACCESS_TOKEN']
PRIME = 'dduzbchuswwbefdunfct'
CLONE = 'plisdzywzleljorrphxv'
API = 'https://api.supabase.com/v1/projects/%s/database/query'
OUT = os.path.dirname(__file__)

def q(ref, sql, tries=4):
    body = json.dumps({'query': sql}).encode()
    # A default python-urllib User-Agent is refused by Cloudflare in front of
    # the Management API (403, error code 1010). curl's is accepted.
    req = urllib.request.Request(API % ref, data=body, method='POST', headers={
        'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json',
        'User-Agent': 'curl/8.5.0', 'Accept': '*/*'})
    last = None
    for i in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            detail = e.read().decode()[:400]
            last = f'HTTP {e.code}: {detail}'
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(2 ** i); continue
            raise RuntimeError(last)
        except Exception as e:
            last = str(e); time.sleep(2 ** i)
    raise RuntimeError(f'giving up: {last}')

def prime_read(sql):
    """Read-only against the prime. Guard: refuse anything that is not a SELECT/WITH."""
    s = sql.strip().lower()
    assert s.startswith('select') or s.startswith('with'), 'PRIME IS READ-ONLY'
    return q(PRIME, sql)

def bootstrap():
    q(CLONE, """
    create schema if not exists clone_backend;
    create table if not exists clone_backend.failures(
      id bigserial primary key, stage text, stmt text, err text, at timestamptz default now());
    create or replace function clone_backend.apply(p_stage text, stmts jsonb)
    returns table(applied int, failed int) language plpgsql as $fn$
    declare s text; a int := 0; f int := 0;
    begin
      for s in select value from jsonb_array_elements_text(stmts) loop
        begin
          execute s; a := a + 1;
        exception when others then
          if sqlerrm ilike '%already exists%' or sqlerrm ilike '%duplicate%' then
            a := a + 1;
          else
            f := f + 1;
            insert into clone_backend.failures(stage, stmt, err) values (p_stage, left(s, 400), left(sqlerrm, 300));
          end if;
        end;
      end loop;
      return query select a, f;
    end $fn$;
    """)

def stage(name, ddl_sql, count_sql, batch=60):
    print(f'\n=== {name} ===', flush=True)
    rows = prime_read(ddl_sql)
    stmts = [r['ddl'] for r in rows if r.get('ddl')]
    with open(f'{OUT}/{name}.json', 'w') as fh:
        json.dump(stmts, fh)
    print(f'  fetched {len(stmts)} statements from prime ({sum(len(s) for s in stmts):,} bytes)', flush=True)

    applied = failed = 0
    for i in range(0, len(stmts), batch):
        chunk = stmts[i:i + batch]
        payload = json.dumps(chunk).replace("'", "''")
        res = q(CLONE, f"select * from clone_backend.apply('{name}', '{payload}'::jsonb)")
        applied += res[0]['applied']; failed += res[0]['failed']
        print(f'\r  applied {applied}/{len(stmts)}  failed {failed}', end='', flush=True)
    print(flush=True)

    p = prime_read(count_sql)[0]['n']
    c = q(CLONE, count_sql)[0]['n']
    ok = int(c) >= int(p)
    print(f'  RECONCILE prime={p} clone={c}  {"OK" if ok else "*** SHORT ***"}', flush=True)
    return {'stage': name, 'sent': len(stmts), 'applied': applied, 'failed': failed,
            'prime': int(p), 'clone': int(c), 'reconciled': ok}

SCOPE = "n.nspname in ('public','aml')"

STAGES = [
 ('01-types',
  f"""select 'create type ' || quote_ident(n.nspname) || '.' || quote_ident(t.typname) ||
      ' as enum (' || (select string_agg(quote_literal(e.enumlabel), ',' order by e.enumsortorder)
                       from pg_enum e where e.enumtypid=t.oid) || ')' as ddl
      from pg_type t join pg_namespace n on n.oid=t.typnamespace
      where t.typtype='e' and {SCOPE}""",
  f"""select count(*) n from pg_type t join pg_namespace n on n.oid=t.typnamespace
      where t.typtype='e' and {SCOPE}"""),

 ('02-sequences',
  f"""select 'create sequence if not exists ' || quote_ident(n.nspname) || '.' || quote_ident(c.relname) as ddl
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='S' and {SCOPE}""",
  f"""select count(*) n from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where c.relkind='S' and {SCOPE}"""),

 ('03-tables',
  f"""select 'create table if not exists ' || quote_ident(n.nspname) || '.' || quote_ident(c.relname) || ' (' ||
      coalesce((select string_agg(
          quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod) ||
          case when a.attidentity = 'a' then ' generated always as identity'
               when a.attidentity = 'd' then ' generated by default as identity'
               when a.attgenerated = 's' then ' generated always as (' || pg_get_expr(ad.adbin, ad.adrelid) || ') stored'
               else coalesce(' default ' || pg_get_expr(ad.adbin, ad.adrelid), '') end ||
          case when a.attnotnull and a.attgenerated = '' then ' not null' else '' end,
        ', ' order by a.attnum)
        from pg_attribute a
        left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum
        where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped), '') || ')' as ddl
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and {SCOPE}""",
  f"""select count(*) n from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where c.relkind='r' and {SCOPE}"""),

 ('04-functions',
  f"""select pg_get_functiondef(p.oid) as ddl
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      left join pg_depend d on d.objid=p.oid and d.deptype='e'
      where {SCOPE} and d.objid is null and p.prokind in ('f','p')""",
  f"""select count(*) n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      left join pg_depend d on d.objid=p.oid and d.deptype='e'
      where {SCOPE} and d.objid is null and p.prokind in ('f','p')"""),

 ('05-constraints',
  f"""select 'alter table ' || quote_ident(n.nspname) || '.' || quote_ident(rel.relname) ||
      ' add constraint ' || quote_ident(con.conname) || ' ' || pg_get_constraintdef(con.oid) as ddl
      from pg_constraint con join pg_class rel on rel.oid=con.conrelid
      join pg_namespace n on n.oid=rel.relnamespace where {SCOPE}
      order by case con.contype when 'p' then 1 when 'u' then 2 when 'c' then 3 else 4 end""",
  f"""select count(*) n from pg_constraint con join pg_class rel on rel.oid=con.conrelid
      join pg_namespace n on n.oid=rel.relnamespace where {SCOPE}"""),

 ('06-indexes',
  """select i.indexdef as ddl from pg_indexes i
     where i.schemaname in ('public','aml')
       and not exists (select 1 from pg_constraint c join pg_class ic on ic.oid=c.conindid
                       where ic.relname=i.indexname)""",
  """select count(*) n from pg_indexes where schemaname in ('public','aml')"""),

 ('07-views',
  """select 'create or replace view ' || quote_ident(schemaname) || '.' || quote_ident(viewname) ||
     ' as ' || definition as ddl from pg_views where schemaname in ('public','aml')""",
  """select count(*) n from pg_views where schemaname in ('public','aml')"""),

 ('08-triggers',
  f"""select pg_get_triggerdef(t.oid) as ddl
      from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
      where not t.tgisinternal and {SCOPE}""",
  f"""select count(*) n from pg_trigger t join pg_class c on c.oid=t.tgrelid
      join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and {SCOPE}"""),

 ('09-rls-enable',
  f"""select 'alter table ' || quote_ident(n.nspname) || '.' || quote_ident(c.relname) ||
      ' enable row level security' as ddl
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where c.relkind='r' and {SCOPE} and c.relrowsecurity""",
  f"""select count(*) n from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where c.relkind='r' and {SCOPE} and c.relrowsecurity"""),

 ('10-policies',
  """select 'create policy ' || quote_ident(policyname) || ' on ' ||
     quote_ident(schemaname) || '.' || quote_ident(tablename) ||
     ' as ' || permissive || ' for ' || cmd || ' to ' || array_to_string(roles, ', ') ||
     coalesce(' using (' || qual || ')', '') ||
     coalesce(' with check (' || with_check || ')', '') as ddl
     from pg_policies where schemaname in ('public','aml')""",
  """select count(*) n from pg_policies where schemaname in ('public','aml')"""),
]

if __name__ == '__main__':
    only = sys.argv[1:] or None
    bootstrap()
    results = []
    for name, ddl, cnt in STAGES:
        if only and name not in only:
            continue
        b = 15 if name == '04-functions' else 60
        results.append(stage(name, ddl, cnt, batch=b))
    print('\n\n================ SUMMARY ================')
    for r in results:
        flag = 'OK  ' if r['reconciled'] else 'SHORT'
        print(f"  {flag} {r['stage']:<16} prime={r['prime']:<6} clone={r['clone']:<6} "
              f"sent={r['sent']:<6} failed={r['failed']}")
    json.dump(results, open(f'{OUT}/summary.json', 'w'), indent=2)
