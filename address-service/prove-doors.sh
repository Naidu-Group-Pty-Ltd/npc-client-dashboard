#!/bin/bash
# Every door the address service has, knocked on — the same script against the
# image running in the CI runner and against the machine on Fly, so both are
# held to one standard. BASE is the service's origin, TOKEN its path token.
# Nothing here prints the token.
set -euo pipefail
: "${BASE:?BASE is the service origin}" "${TOKEN:?TOKEN is the service token}"

fail() { echo "::error::$*"; exit 1; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
get() { curl -sS -o "$tmp/body" -w '%{http_code}' "$1" || echo 000; }

code=$(get "$BASE/healthz")
[ "$code" = 200 ] || fail "GET /healthz answered $code"
grep -q '"Ok"' "$tmp/body" || fail "/healthz is not Photon's status: $(head -c 200 "$tmp/body")"
echo "healthz: $(cat "$tmp/body")"

# A place every Australian index holds; overridable for a test index that does not.
probe="${PHOTON_PROBE:-Sydney}"
code=$(get "$BASE/$TOKEN/photon/api/?q=$(jq -rn --arg q "$probe" '$q|@uri')&limit=3&lang=en")
[ "$code" = 200 ] || fail "Photon answered $code through the token"
n=$(jq '.features | length' "$tmp/body")
[ "$n" -gt 0 ] || fail "Photon found nothing for $probe: the index is empty or not Australia's"
echo "photon: $n feature(s) for $probe; first: $(jq -c '.features[0].properties | {name, state, countrycode}' "$tmp/body")"

code=$(get "$BASE/$TOKEN/gnaf/v1/manifest.json")
[ "$code" = 200 ] || fail "the G-NAF manifest answered $code"
[ "$(jq -r .format "$tmp/body")" = 1 ] || fail "the G-NAF manifest is not format 1"
echo "gnaf: $(jq -c '{release: .release.label, rows: .counts.rows_written, shards: .counts.shards}' "$tmp/body")"

code=$(get "$BASE/$TOKEN/gnaf/v1/localities.json.gz")
[ "$code" = 200 ] || fail "the locality index answered $code"
[ "$(head -c 2 "$tmp/body" | od -An -tx1 | tr -d ' \n')" = 1f8b ] || fail "the locality index is not gzip"

# A postal area that allocates no addresses has no file: that 404 is an
# answer about an address, and must stay distinguishable from the doors below.
code=$(get "$BASE/$TOKEN/gnaf/v1/NSW/0001.psv.gz")
[ "$code" = 404 ] || fail "a postal area with no addresses answered $code, not 404"

code=$(get "$BASE/photon/api/?q=Sydney")
[ "$code" = 403 ] || fail "Photon WITHOUT the token answered $code, not 403"

code=$(get "$BASE/$TOKEN/elsewhere")
[ "$code" = 400 ] || fail "the right token on a wrong path answered $code, not 400"

echo "every door answered as it should"
