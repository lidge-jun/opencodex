#!/usr/bin/env bash
# The Autobahn fuzzingserver client run of tests/clients/link-ws-autobahn.test.ts, as recorded for the link WebSocket
# release gate (design T4 3.3). Usage: tests/fixtures/link-ws-autobahn/run.sh <run-dir>   (Linux; needs Docker and Bun)
# It starts the pinned image with this directory's fuzzingserver.json, publishes it on 127.0.0.1:9001 only, waits until
# the server answers, runs the test against it, stops and removes the container, and leaves in <run-dir>: provenance.txt
# (commit, clean tree, Bun, image, expectations sha256, command, exit), test-output.txt, and reports.tar.gz with its sha256.
set -euo pipefail
RUN="${1:?usage: run.sh <run-dir>}"
if [ -e "$RUN" ] && [ -n "$(ls -A "$RUN")" ]; then echo "run.sh: $RUN is not empty; use a new run directory" >&2; exit 2; fi
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
IMAGE="crossbario/autobahn-testsuite@sha256:519915fb568b04c9383f70a1c405ae3ff44ab9e35835b085239c258b6fac3074"
DOCKER="${DOCKER:-docker}"
mkdir -p "$RUN/config" "$RUN/reports"
RUN="$(cd "$RUN" && pwd)"
cp "$HERE/fuzzingserver.json" "$RUN/config/fuzzingserver.json"
$DOCKER run -d --rm --name ocx-autobahn -v "$RUN/config:/config" -v "$RUN/reports:/reports" -p 127.0.0.1:9001:9001 "$IMAGE" \
  wstest -m fuzzingserver -s /config/fuzzingserver.json > /dev/null
trap '$DOCKER stop ocx-autobahn > /dev/null 2>&1 || true' EXIT
# Docker's port proxy listens before the server inside is ready: wait until the server itself answers HTTP.
code=000
for _ in $(seq 1 100); do code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9001/ || true); [ "$code" != "000" ] && break; sleep 0.2; done
if [ "$code" = "000" ]; then echo "run.sh: the fuzzingserver did not answer on 127.0.0.1:9001 within 20 s" >&2; exit 3; fi
cd "$REPO"
{
  echo "head=$(git rev-parse HEAD) clean_tree=$([ -z "$(git status --porcelain)" ] && echo yes || echo no) bun=$(bun --version)"
  echo "image=$IMAGE"
  echo "expectations_sha256=$(sha256sum tests/fixtures/link-ws-autobahn-expectations.json | cut -c1-64)"
  echo "spec_sha256=$(sha256sum tests/fixtures/link-ws-autobahn/fuzzingserver.json | cut -c1-64)"
  echo "command=OCX_LINK_WS_AUTOBAHN_URL=http://127.0.0.1:9001 OCX_LINK_WS_AUTOBAHN_REPORTS=<run>/reports bun test tests/clients/link-ws-autobahn.test.ts"
} > "$RUN/provenance.txt"
set +e
S=$(date +%s)
OCX_LINK_WS_AUTOBAHN_URL=http://127.0.0.1:9001 OCX_LINK_WS_AUTOBAHN_REPORTS="$RUN/reports" bun test tests/clients/link-ws-autobahn.test.ts > "$RUN/test-output.txt" 2>&1
E=$?
set -e
echo "exit=$E wall=$(( $(date +%s)-S ))s" >> "$RUN/provenance.txt"
$DOCKER stop ocx-autobahn > /dev/null 2>&1 || true
trap - EXIT
tar -C "$RUN" -czf "$RUN/reports.tar.gz" reports
(cd "$RUN" && sha256sum reports.tar.gz > reports.tar.gz.sha256)
exit $E
