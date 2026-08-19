#!/usr/bin/env bash
# =====================================================================
# Deploy the edge functions, and copy the vendor secrets, PRIME -> CLONE.
# =====================================================================
# Why a script and not an agent doing it call-by-call: the function sources
# are 19 MB across 423 functions. Nothing that size can pass through an
# agent's context without being truncated — which is exactly how the schema
# transfer lost 113 tables. This moves bytes machine-to-machine.
#
# Needs ONE credential: a Supabase personal access token (sbp_...) with
# access to both projects. Create at https://supabase.com/dashboard/account/tokens
# and REVOKE IT AFTERWARDS.
#
#   export SUPABASE_ACCESS_TOKEN=sbp_...
#   ./02-functions-and-secrets.sh
#
# Everything here talks HTTPS/443 only — no Postgres port is required.
# =====================================================================
set -euo pipefail

PRIME_REF="dduzbchuswwbefdunfct"     # source. READ ONLY. Never written to.
CLONE_REF="plisdzywzleljorrphxv"     # target.
API="https://api.supabase.com/v1"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

: "${SUPABASE_ACCESS_TOKEN:?Set SUPABASE_ACCESS_TOKEN (sbp_...) first}"

# --- Hard guard. The whole point of this exercise is that the client
# --- deployment never acts on the prime. Refuse if the target drifted.
if [ "$CLONE_REF" = "$PRIME_REF" ]; then
  echo "REFUSING: target ref equals the prime's." >&2; exit 1
fi

auth=(-H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}")
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

say "0. Confirming both projects are reachable and distinct"
for ref in "$PRIME_REF" "$CLONE_REF"; do
  name=$(curl -fsS "${auth[@]}" "$API/projects/$ref" | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')
  echo "   $ref -> $name"
done

# ---------------------------------------------------------------------
say "1. Copying vendor secrets  PRIME -> CLONE"
# ---------------------------------------------------------------------
# The user's requirement was: no live data on the clone EXCEPT the API keys.
# Supabase never returns SUPABASE_* platform secrets here; they are managed
# per-project and must not be copied — a copied SUPABASE_URL would point the
# clone's own functions at the prime, which is the coupling we removed.
curl -fsS "${auth[@]}" "$API/projects/$PRIME_REF/secrets" > /tmp/prime-secrets.json
python3 - "$CLONE_REF" <<'PY' > /tmp/clone-secrets-payload.json
import json, sys
BLOCKED_PREFIXES = ("SUPABASE_",)          # platform-managed, project-specific
BLOCKED_EXACT = {
    "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_DB_URL", "SUPABASE_PUBLISHABLE_KEY",
    # Signing secrets are per-deployment identities, not vendor credentials.
    "INTERNAL_EDGE_SECRET", "INTERNAL_EDGE_SECRET_V2",
}
secrets = json.load(open("/tmp/prime-secrets.json"))
keep, skipped = [], []
for s in secrets:
    n = s.get("name", "")
    if n in BLOCKED_EXACT or any(n.startswith(p) for p in BLOCKED_PREFIXES):
        skipped.append(n)
    else:
        keep.append({"name": n, "value": s.get("value", "")})
print(json.dumps(keep))
sys.stderr.write(f"   copying {len(keep)} vendor secrets; skipping {len(skipped)} platform/identity ones: {', '.join(sorted(skipped))}\n")
PY
curl -fsS -X POST "${auth[@]}" -H 'Content-Type: application/json' \
  --data @/tmp/clone-secrets-payload.json \
  "$API/projects/$CLONE_REF/secrets" >/dev/null
echo "   done. Verifying names landed (values are never printed):"
curl -fsS "${auth[@]}" "$API/projects/$CLONE_REF/secrets" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("   ", len(d), "secrets on the clone")'
rm -f /tmp/prime-secrets.json /tmp/clone-secrets-payload.json

# ---------------------------------------------------------------------
say "2. Deploying all edge functions from THIS REPO (not from the prime)"
# ---------------------------------------------------------------------
# The repo is the source of truth for function code, and it is what CI
# deploys. verify_jwt is read per function from supabase/config.toml so the
# gateway posture matches the declaration — an omitted block means true.
cd "$REPO_ROOT"
total=0; ok=0; failed=()
for dir in supabase/functions/*/; do
  fn="$(basename "$dir")"
  [[ "$fn" == _* ]] && continue                 # _shared, not a function
  [ -f "$dir/index.ts" ] || { echo "   skip $fn (no index.ts)"; continue; }
  total=$((total+1))
  jwt_flag=""
  if awk -v f="$fn" '
      $0 ~ "^\\[functions\\." f "\\]" {inblock=1; next}
      /^\[/ {inblock=0}
      inblock && /verify_jwt/ {print; exit}
    ' supabase/config.toml | grep -q 'false'; then
    jwt_flag="--no-verify-jwt"
  fi
  if npx --yes supabase functions deploy "$fn" \
        --project-ref "$CLONE_REF" $jwt_flag >/dev/null 2>&1; then
    ok=$((ok+1)); printf '.'
  else
    failed+=("$fn"); printf 'X'
  fi
done
echo
echo "   deployed $ok / $total"
if [ ${#failed[@]} -gt 0 ]; then
  echo "   FAILED (${#failed[@]}): ${failed[*]}" >&2
fi

# ---------------------------------------------------------------------
say "3. Reconciling against the prime"
# ---------------------------------------------------------------------
count() { curl -fsS "${auth[@]}" "$API/projects/$1/functions" \
          | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))'; }
p=$(count "$PRIME_REF"); c=$(count "$CLONE_REF")
echo "   prime: $p functions   clone: $c functions"
[ "$c" -ge "$p" ] && echo "   OK" || { echo "   *** SHORT by $((p-c)) ***" >&2; exit 1; }
