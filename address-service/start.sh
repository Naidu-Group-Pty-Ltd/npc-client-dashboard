#!/bin/bash
# Photon on 127.0.0.1:2322, Caddy on :8080 in front of it and of the G-NAF
# files. If either process stops, the machine exits and Fly restarts it: a
# half-running service would pass its health check while refusing every
# geocode, which is the failure nobody sees.
set -euo pipefail

# An empty token would put both services at `//photon/` and `//gnaf/`, open to
# anyone who guessed the shape. Refuse to start rather than serve that.
if [ "${#ADDRESS_SERVICE_TOKEN}" -lt 32 ]; then
  echo "ADDRESS_SERVICE_TOKEN is unset or shorter than 32 characters; refusing to start" >&2
  exit 1
fi

PHOTON_DATA_DIR="${PHOTON_DATA_DIR:-/srv/photon}"
GNAF_DIR="${GNAF_DIR:-/srv/gnaf}"
[ -f "$GNAF_DIR/v1/manifest.json" ] || { echo "no G-NAF register at $GNAF_DIR" >&2; exit 1; }

# shellcheck disable=SC2086 # JAVA_OPTS is a list of flags.
java ${JAVA_OPTS:-} -jar "${PHOTON_JAR:-/srv/photon/photon.jar}" serve \
  -data-dir "$PHOTON_DATA_DIR" \
  -listen-ip 127.0.0.1 -listen-port 2322 \
  -max-results 20 -query-timeout 5 -default-language en &

# Caddy keeps an instance id and its storage locks under the user's data
# directory, and this user's home (/srv) is not writable. Without a writable
# one, every start logs an ERROR that reads like the fault when somebody is
# looking for the real one.
XDG_DATA_HOME="${XDG_DATA_HOME:-/tmp/caddy-data}" \
  caddy run --config "${CADDYFILE:-/etc/caddy/Caddyfile}" --adapter caddyfile &

wait -n
echo "a process stopped; exiting so the machine restarts" >&2
exit 1
