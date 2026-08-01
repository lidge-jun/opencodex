#!/bin/sh
set -eu

TOKEN_FILE=${OCXR_MESH_TOKEN_FILE:-/run/secrets/mesh-token}
STATE_MARKER=/var/lib/cloudflare-warp/.ocxr-mesh-enrolled

/bin/warp-svc >/var/log/warp-svc.log 2>&1 &
WARP_PID=$!

for _ in $(seq 1 60); do
  if warp-cli --accept-tos status >/dev/null 2>&1; then break; fi
  sleep 1
done

if [ ! -f "$STATE_MARKER" ]; then
  test -s "$TOKEN_FILE"
  warp-cli --accept-tos connector new "$(tr -d '\r\n' < "$TOKEN_FILE")"
  touch "$STATE_MARKER"
fi

warp-cli --accept-tos connect
wait "$WARP_PID"
