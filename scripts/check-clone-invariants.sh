#!/usr/bin/env bash
# Every property that makes this the CLIENT repo rather than a plain mirror.
# Run before and after any merge from upstream.
cd "$(dirname "${BASH_SOURCE[0]}")/.."
pass=0; fail=0
chk() { # name, test-expression-as-string
  if eval "$2" >/dev/null 2>&1; then printf '  ok    %s\n' "$1"; pass=$((pass+1))
  else printf '  FAIL  %s\n' "$1"; fail=$((fail+1)); fi
}
echo "── identity / build mode ──"
chk "vite.config pins VITE_CLIENT_FACING=true"      "grep -q 'process.env.VITE_CLIENT_FACING ??= \"true\"' vite.config.ts"
chk "vite.config defines __CLIENT_FACING__"          "grep -q '__CLIENT_FACING__' vite.config.ts"
chk "App.tsx excludes routes from the build"         "grep -q 'RouteExcludedFromBuild' src/App.tsx"
chk "App.tsx gates 5 routes on __EXCLUDE_*__"        "test \$(grep -c '^const .* = __EXCLUDE_[A-Z_]*__$' src/App.tsx) -eq 5"
chk "the runtime flag reads the build constant"     "grep -q 'typeof __CLIENT_FACING__' src/lib/clientFacing.ts"
# Comment lines are stripped first: the module DESCRIBES the import.meta read it
# no longer performs, and that prose is the record of why the rule exists.
chk "the runtime flag never reads import.meta"      "! grep -vE '^\\s*(\\*|//|/\\*)' src/lib/clientFacing.ts | grep -q 'import\\.meta'"
chk "the excluded-route placeholder is not null"    "! grep -q 'RouteExcludedFromBuild = () => null' src/App.tsx"

echo "── the one hidden-path list ──"
chk "clientFacing.ts exists"                         "test -f src/lib/clientFacing.ts"
chk "  /integrations hidden"                         "grep -q \"'/integrations'\" src/lib/clientFacing.ts"
chk "  WIP candidates section present"               "grep -q 'WIP cherry-pick candidates' src/lib/clientFacing.ts"
chk "  /automation candidate"                        "grep -q \"'/automation'\" src/lib/clientFacing.ts"
chk "  /billing candidate"                           "grep -q \"'/billing'\" src/lib/clientFacing.ts"
chk "  /admin/users candidate"                       "grep -q \"'/admin/users'\" src/lib/clientFacing.ts"
chk "ClientFacingGate route gate exists"             "test -f src/components/auth/ClientFacingGate.tsx"
chk "DashboardLayout uses ClientFacingOutlet"        "grep -q 'ClientFacingOutlet' src/components/layout/DashboardLayout.tsx"
chk "useNavigation filters by deployment"            "grep -q 'isPathVisibleInDeployment' src/hooks/useNavigation.ts"

echo "── backend isolation ──"
chk "config.toml names THIS project"                 "grep -q '^project_id = \"plisdzywzleljorrphxv\"' supabase/config.toml"
chk "config.toml does NOT name the prime"            "! grep -q '^project_id = \"dduzbchuswwbefdunfct\"' supabase/config.toml"
chk "no workflow defaults to the prime ref"          "! grep -rq \"|| 'dduzbchuswwbefdunfct'\" .github/workflows/"
chk "deploy workflow fails closed"                   "grep -q 'PROJECT_REF:-' .github/workflows/deploy-supabase-functions.yml"
chk "apply-migration fails closed"                   "grep -q 'PROJECT_REF:-' .github/workflows/apply-migration.yml"
chk "supabase/.temp not tracked"                     "test -z \"\$(git ls-files supabase/.temp)\""
chk "isolation spec present"                         "test -f src/lib/__tests__/backendIsolation.spec.ts"
chk "clone-backend scripts present"                  "test -f scripts/clone-backend/01-transfer-schema.py"
chk "BACKEND_ISOLATION doc present"                  "test -f docs/BACKEND_ISOLATION.md"

echo "── leaked constants stripped ──"
chk "test numbers come from env"                     "grep -q 'VITE_TEST_CALL_NUMBERS' src/components/call-logs/CleanupTestCalls.tsx"
chk "no staff mobile in source"                      "! grep -rq '61433005110\\|61489084599' src/"
chk "supabase project resolved in ONE module"        "test -f src/integrations/supabase/env.ts"
chk "no hardcoded prime URL in shipped src"          "! git grep -l 'dduzbchuswwbefdunfct' -- 'src/**' ':!*__tests__*' ':!*.test.ts' ':!*.spec.ts' ':!src/integrations/supabase/env.ts' | grep -q ."

echo "── env template ──"
chk ".env.example carries this project's pair"       "grep -q 'plisdzywzleljorrphxv' .env.example"
chk ".env.example documents the matched pair"        "grep -q 'MATCHED PAIR' .env.example"

echo
echo "  PASS=$pass  FAIL=$fail"
exit $(( fail > 0 ))
