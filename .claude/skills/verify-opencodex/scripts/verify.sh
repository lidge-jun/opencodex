#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
SKILL="$ROOT/.claude/skills/verify-opencodex"
STATE="$SKILL/.run-state"
CMD="${1:-}"

die() { echo "verify-opencodex: $*" >&2; exit 1; }

load_state() {
  [[ -f "$STATE" ]] || die "no .run-state; run launch first"
  # shellcheck disable=SC1090
  source "$STATE"
}

write_state() {
  cat > "$STATE" <<EOF
OPENCODEX_VERIFY_ID=$OPENCODEX_VERIFY_ID
OPENCODEX_HOME=$OPENCODEX_HOME
CODEX_HOME=$CODEX_HOME
PORT=$PORT
MOCK_PORT=$MOCK_PORT
PROXY_PID=$PROXY_PID
MOCK_PID=$MOCK_PID
ARTIFACT_DIR=$ARTIFACT_DIR
TMPDIR_RUN=$TMPDIR_RUN
EOF
}

pick_port() {
  local start="$1"
  local p="$start"
  local end=$((start + 19))
  while [[ "$p" -le "$end" ]]; do
    if [[ "$p" -eq 10100 ]]; then p=$((p + 1)); continue; fi
    if ! nc -z 127.0.0.1 "$p" 2>/dev/null; then
      echo "$p"
      return 0
    fi
    p=$((p + 1))
  done
  die "no free port in $start-$((start+19))"
}

cmd_launch() {
  [[ -f "$STATE" ]] && die "already launched; cleanup first"
  OPENCODEX_VERIFY_ID="${OPENCODEX_VERIFY_ID:-$(date +%Y%m%dT%H%M%S)-$$}"
  TMPDIR_RUN="/tmp/opencodex-verify-${OPENCODEX_VERIFY_ID}"
  OPENCODEX_HOME="$TMPDIR_RUN/home"
  CODEX_HOME="$TMPDIR_RUN/codex"
  ARTIFACT_DIR="$SKILL/artifacts/${OPENCODEX_VERIFY_ID}"
  mkdir -p "$OPENCODEX_HOME" "$CODEX_HOME" "$ARTIFACT_DIR"
  PORT="$(pick_port "${OPENCODEX_VERIFY_PORT:-19101}")"
  MOCK_PORT="$(pick_port "${OPENCODEX_VERIFY_MOCK_PORT:-19121}")"
  cat > "$OPENCODEX_HOME/config.json" <<EOF
{
  "port": ${PORT},
  "hostname": "127.0.0.1",
  "clientIntegrations": { "codex": false },
  "defaultProvider": "fixture",
  "providers": {
    "fixture": {
      "adapter": "openai-responses",
      "baseUrl": "http://127.0.0.1:${MOCK_PORT}/v1",
      "authMode": "key",
      "apiKey": "sk-verify",
      "allowPrivateNetwork": true,
      "defaultModel": "fixture-model"
    }
  }
}
EOF
  bun "$SKILL/scripts/mock-upstream.mjs" > "$ARTIFACT_DIR/mock.log" 2>&1 &
  MOCK_PID=$!
  export OPENCODEX_VERIFY_MOCK_PORT="$MOCK_PORT"
  # mock reads env at start; restart with env
  kill "$MOCK_PID" 2>/dev/null || true
  wait "$MOCK_PID" 2>/dev/null || true
  OPENCODEX_VERIFY_MOCK_PORT="$MOCK_PORT" bun "$SKILL/scripts/mock-upstream.mjs" > "$ARTIFACT_DIR/mock.log" 2>&1 &
  MOCK_PID=$!
  export OPENCODEX_HOME CODEX_HOME
  bun run "$ROOT/src/cli/index.ts" start --port "$PORT" > "$ARTIFACT_DIR/proxy.log" 2>&1 &
  PROXY_PID=$!
  write_state
  local i=0
  while [[ "$i" -lt 50 ]]; do
    if curl -sf "http://127.0.0.1:${PORT}/healthz" | grep -q '"service":"opencodex"'; then
      echo "launched port=$PORT mock=$MOCK_PORT pid=$PROXY_PID artifacts=$ARTIFACT_DIR"
      return 0
    fi
    if ! kill -0 "$PROXY_PID" 2>/dev/null; then
      cat "$ARTIFACT_DIR/proxy.log" >&2 || true
      die "proxy exited before /healthz"
    fi
    i=$((i + 1))
    sleep 0.2
  done
  cat "$ARTIFACT_DIR/proxy.log" >&2 || true
  die "timeout waiting for /healthz on $PORT"
}

cmd_doctor() {
  load_state
  kill -0 "$PROXY_PID" || die "PROXY_PID $PROXY_PID is dead"
  [[ "$PORT" != "10100" ]] || die "refusing port 10100"
  local body
  body="$(curl -sf "http://127.0.0.1:${PORT}/healthz")" || die "/healthz failed"
  echo "$body"
  echo "$body" | grep -q '"service":"opencodex"' || die "healthz is not opencodex"
  echo "$body" | grep -q "\"port\":${PORT}" || die "healthz port mismatch"
  echo "$body" | grep -q "\"pid\":${PROXY_PID}" || die "healthz pid mismatch"
  curl -sf "http://127.0.0.1:${PORT}/readyz" || die "/readyz failed"
  echo
  echo "doctor ok"
}

save_http() {
  local name="$1" method="$2" url="$3" data="${4:-}"
  local hdr="$ARTIFACT_DIR/${name}.headers"
  local body="$ARTIFACT_DIR/${name}.body"
  if [[ -n "$data" ]]; then
    curl -sS -D "$hdr" -o "$body" -w "%{http_code}" -X "$method" "$url" \
      -H 'content-type: application/json' -d "$data" > "$ARTIFACT_DIR/${name}.status"
  else
    curl -sS -D "$hdr" -o "$body" -w "%{http_code}" -X "$method" "$url" > "$ARTIFACT_DIR/${name}.status"
  fi
  printf '%s %s\n' "$method" "$url" > "$ARTIFACT_DIR/${name}.request"
  if [[ -n "$data" ]]; then
    printf '%s\n' "$data" >> "$ARTIFACT_DIR/${name}.request"
  fi
}

cmd_drive_health() {
  load_state
  cmd_doctor >/dev/null
  save_http healthz GET "http://127.0.0.1:${PORT}/healthz"
  save_http readyz GET "http://127.0.0.1:${PORT}/readyz"
  save_http dashboard GET "http://127.0.0.1:${PORT}/"
  [[ "$(cat "$ARTIFACT_DIR/healthz.status")" == "200" ]] || die "healthz not 200"
  grep -q opencodex "$ARTIFACT_DIR/healthz.body" || die "healthz body"
  [[ "$(cat "$ARTIFACT_DIR/readyz.status")" == "200" ]] || die "readyz not 200"
  echo "drive-health ok -> $ARTIFACT_DIR"
}

cmd_drive_responses() {
  load_state
  save_http responses POST "http://127.0.0.1:${PORT}/v1/responses" \
    '{"model":"fixture/fixture-model","input":[{"type":"message","role":"user","content":"ping"}],"stream":false}'
  [[ "$(cat "$ARTIFACT_DIR/responses.status")" == "200" ]] || die "responses not 200: $(cat "$ARTIFACT_DIR/responses.body")"
  grep -q pong "$ARTIFACT_DIR/responses.body" || die "responses missing pong"
  echo "drive-responses ok -> $ARTIFACT_DIR"
}

cmd_drive_compact() {
  load_state
  save_http compact POST "http://127.0.0.1:${PORT}/v1/responses/compact" \
    '{"model":"fixture/fixture-model","input":[{"type":"message","role":"user","content":"ping"}]}'
  [[ "$(cat "$ARTIFACT_DIR/compact.status")" == "200" ]] || die "compact not 200: $(cat "$ARTIFACT_DIR/compact.body")"
  echo "drive-compact ok -> $ARTIFACT_DIR"
}

cmd_drive_models() {
  load_state
  save_http models GET "http://127.0.0.1:${PORT}/v1/models"
  [[ "$(cat "$ARTIFACT_DIR/models.status")" == "200" ]] || die "models not 200: $(cat "$ARTIFACT_DIR/models.body")"
  echo "drive-models ok -> $ARTIFACT_DIR"
}

cmd_drive_status() {
  load_state
  OPENCODEX_HOME="$OPENCODEX_HOME" CODEX_HOME="$CODEX_HOME" \
    bun run "$ROOT/src/cli/index.ts" status --json > "$ARTIFACT_DIR/status.json"
  grep -q '"running": true' "$ARTIFACT_DIR/status.json" || die "status not running"
  echo "drive-status ok -> $ARTIFACT_DIR"
}

cmd_cleanup() {
  [[ -f "$STATE" ]] || { echo "nothing to clean"; return 0; }
  load_state
  if [[ -n "${PROXY_PID:-}" ]]; then kill "$PROXY_PID" 2>/dev/null || true; wait "$PROXY_PID" 2>/dev/null || true; fi
  if [[ -n "${MOCK_PID:-}" ]]; then kill "$MOCK_PID" 2>/dev/null || true; wait "$MOCK_PID" 2>/dev/null || true; fi
  if [[ -n "${TMPDIR_RUN:-}" && "$TMPDIR_RUN" == /tmp/opencodex-verify-* ]]; then rm -rf "$TMPDIR_RUN"; fi
  rm -f "$STATE"
  echo "cleanup ok (artifacts kept at ${ARTIFACT_DIR:-none})"
}

case "$CMD" in
  launch) cmd_launch ;;
  doctor) cmd_doctor ;;
  drive-health) cmd_drive_health ;;
  drive-responses) cmd_drive_responses ;;
  drive-compact) cmd_drive_compact ;;
  drive-models) cmd_drive_models ;;
  drive-status) cmd_drive_status ;;
  cleanup) cmd_cleanup ;;
  *) die "usage: verify.sh launch|doctor|drive-health|drive-responses|drive-compact|drive-models|drive-status|cleanup" ;;
esac
