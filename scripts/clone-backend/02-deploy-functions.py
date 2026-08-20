#!/usr/bin/env python3
"""
Deploy every edge function in the repo to the CLONE project.

Uses the Management API's multipart deploy endpoint directly. The supabase
CLI resolves the same dependency graph but its uploader fails behind this
session's egress proxy (FunctionsApiTransportError); curl/urllib against the
same endpoint returns 201, so the graph is resolved here instead.

Never targets the prime: TARGET is asserted against it before anything runs.
"""
import json, os, re, subprocess, sys, time
from pathlib import Path

REPO   = Path(__file__).resolve().parents[2]
FNDIR  = REPO / 'supabase' / 'functions'
TOKEN  = os.environ['SUPABASE_ACCESS_TOKEN']
PRIME  = 'dduzbchuswwbefdunfct'
TARGET = 'plisdzywzleljorrphxv'
assert TARGET != PRIME, 'REFUSING: target is the prime'

# --- verify_jwt, per function, from config.toml. An omitted block means true.
cfg = (REPO / 'supabase' / 'config.toml').read_text()
VERIFY = {}
for m in re.finditer(r'^\[functions\.([^\]]+)\]\s*\n((?:(?!^\[).*\n)*)', cfg, re.M):
    body = m.group(2)
    vj = re.search(r'^\s*verify_jwt\s*=\s*(true|false)', body, re.M)
    VERIFY[m.group(1)] = (vj.group(1) == 'true') if vj else True

IMPORT_RE = re.compile(
    r'''(?:from\s+|import\s*\(\s*|import\s+|export\s+\*\s+from\s+|export\s+\{[^}]*\}\s+from\s+)['"]([^'"]+)['"]''')

def deps(entry: Path, seen=None):
    """Transitively collect local (relative) imports."""
    seen = seen if seen is not None else set()
    if entry in seen or not entry.exists():
        return seen
    seen.add(entry)
    try:
        src = entry.read_text(encoding='utf-8', errors='replace')
    except Exception:
        return seen
    for spec in IMPORT_RE.findall(src):
        if not spec.startswith('.'):
            continue
        p = (entry.parent / spec).resolve()
        if p.suffix == '':
            for ext in ('.ts', '.tsx', '.js', '.mjs'):
                if p.with_suffix(ext).exists():
                    p = p.with_suffix(ext); break
        if p.exists() and p.is_file():
            deps(p, seen)
    return seen

def rel(p: Path) -> str:
    return str(p.relative_to(REPO))

def deploy(slug: str):
    entry = FNDIR / slug / 'index.ts'
    if not entry.exists():
        return 'skip', 'no index.ts'
    files = sorted(deps(entry), key=lambda p: (p != entry, str(p)))
    dj = FNDIR / slug / 'deno.json'
    meta = {'name': slug, 'entrypoint_path': rel(entry), 'verify_jwt': VERIFY.get(slug, True)}
    if dj.exists():
        files.append(dj)
        meta['import_map_path'] = rel(dj)

    cmd = ['curl', '-sS', '--max-time', '300', '-o', '/tmp/dep_body.txt',
           '-w', '%{http_code}', '-X', 'POST',
           f'https://api.supabase.com/v1/projects/{TARGET}/functions/deploy?slug={slug}',
           '-H', f'Authorization: Bearer {TOKEN}',
           '-F', f'metadata={json.dumps(meta)};type=application/json']
    for f in files:
        cmd += ['-F', f'file=@{f};filename={rel(f)}']
    r = subprocess.run(cmd, capture_output=True, text=True)
    code = (r.stdout or '').strip()[-3:]
    if code in ('200', '201'):
        return 'ok', len(files)
    body = ''
    try: body = open('/tmp/dep_body.txt').read()[:200]
    except Exception: pass
    return 'fail', f'HTTP {code} {body}'

if __name__ == '__main__':
    only = set(sys.argv[1:]) or None
    slugs = sorted(d.name for d in FNDIR.iterdir()
                   if d.is_dir() and not d.name.startswith('_') and (d / 'index.ts').exists())
    if only: slugs = [s for s in slugs if s in only]
    print(f'{len(slugs)} functions to deploy -> {TARGET}\n', flush=True)
    ok, failed, skipped = [], [], []
    for i, s in enumerate(slugs, 1):
        for attempt in range(3):
            st, info = deploy(s)
            if st == 'ok' or st == 'skip': break
            time.sleep(2 * (attempt + 1))
        if st == 'ok': ok.append(s); print(f'\r[{i}/{len(slugs)}] ok={len(ok)} fail={len(failed)}  {s[:40]:<42}', end='', flush=True)
        elif st == 'skip': skipped.append(s)
        else:
            failed.append((s, info)); print(f'\n  FAIL {s}: {info}', flush=True)
    print(f'\n\ndeployed {len(ok)}  failed {len(failed)}  skipped {len(skipped)}')
    json.dump({'ok': ok, 'failed': failed, 'skipped': skipped},
              open(str(Path.cwd() / 'fn-result.json'),'w'), indent=1)
    if failed:
        print('failures:'); [print(f'  {s}: {e}') for s, e in failed[:25]]
