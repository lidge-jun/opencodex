---
name: verify-opencodex
description: Drive the opencodex local proxy (HTTP API, CLI status, dashboard) the way a user would and capture proof. Use when proving a proxy, Responses, compact, models, or CLI-status change on a live instance.
---

# Verify opencodex

opencodex is a local LLM proxy. Humans hit the dashboard at `/` and the CLI (`ocx`). Clients hit `POST /v1/responses`, `POST /v1/responses/compact`, and `GET /v1/models`. This skill drives a **disposable** instance. Never attach to a proxy you did not start.

Secondary surfaces (do not use as the first proof): GUI Vite `bun run dev:gui`, `ocx service`, Codex/Claude/Grok shims.

## Launch

Repo root. Requires `bun` on PATH.

```bash
.claude/skills/verify-opencodex/scripts/verify.sh launch
```

Ready when `GET http://127.0.0.1:$PORT/healthz` returns JSON with `service: "opencodex"` and `port` equal to `$PORT`. The listen log line is `opencodex proxy running on http://localhost:<port>`.

State file: `.claude/skills/verify-opencodex/.run-state` (HOME, PORT, MOCK_PORT, PROXY_PID, MOCK_PID, ARTIFACT_DIR). Source it before doctor/drive/cleanup.

Isolation this script always sets:

- `OPENCODEX_HOME` and `CODEX_HOME` under `/tmp/opencodex-verify-<id>/` (never `~/.opencodex` or `~/.codex`)
- `--port` on 19101–19120, never 10100
- `hostname: "127.0.0.1"` so data-plane admission is loopback (no API key)

A second verification run can coexist with the user's `ocx` on 10100. Two verification runs at once need different ids (`OPENCODEX_VERIFY_ID`).

Teardown: `scripts/verify.sh cleanup` (kills only the PIDs in `.run-state`).

## Doctor

```bash
.claude/skills/verify-opencodex/scripts/verify.sh doctor
```

Pass only if all of these hold:

- `.run-state` exists and `PROXY_PID` is alive
- `/healthz` `service` is `opencodex`, `pid` equals `PROXY_PID`, `port` equals `PORT`
- `/readyz` is JSON with `service: "opencodex"` (status may be `ready`, `pending`, or `failed`; a fixture catalog often lands `failed` — still drive `/healthz` and `/v1/*`)
- `PORT` is not 10100

Refuse and stop if `/healthz` pid/port does not match the run you started.

## Drive

Harness is curl against the launched proxy plus `ocx` with the same `OPENCODEX_HOME`. No browser. Stable handles are URL paths and JSON fields.

```bash
source .claude/skills/verify-opencodex/.run-state
curl -sS "http://127.0.0.1:${PORT}/healthz"
curl -sS "http://127.0.0.1:${PORT}/readyz"
curl -sS "http://127.0.0.1:${PORT}/"
curl -sS "http://127.0.0.1:${PORT}/v1/models"
curl -sS -X POST "http://127.0.0.1:${PORT}/v1/responses" \
  -H 'content-type: application/json' \
  -d '{"model":"fixture/fixture-model","input":[{"type":"message","role":"user","content":"ping"}],"stream":false}'
curl -sS -X POST "http://127.0.0.1:${PORT}/v1/responses/compact" \
  -H 'content-type: application/json' \
  -d '{"model":"fixture/fixture-model","input":[{"type":"message","role":"user","content":"ping"}]}'
OPENCODEX_HOME="$OPENCODEX_HOME" CODEX_HOME="$CODEX_HOME" bun run src/cli/index.ts status --json
```

Feature recipes: `features/`. Drive from the map, not from an internal test helper.

`role:system` folding for ChatGPT destinations is not reachable on this fixture (the gate is `chatgpt.com/backend-api/codex` or `api.openai.com/v1`). Prove that with `bun test tests/openai-responses-system-fold.test.ts tests/responses-compaction-routing.test.ts`.

## Evidence

Directory: `.claude/skills/verify-opencodex/artifacts/<run-id>/`. Named in `.run-state` as `ARTIFACT_DIR`. Cleanup must not delete it.

Proof standards:

- Hit the real HTTP paths a client uses. Do not call `startServer()` from a test file as the proof.
- Save the request (method, path, body) and the response body plus status.
- For mutations, read back a second way (`/healthz` pid vs `ps`, compact `output` vs the POST).
- The mock upstream is a verification double for the LLM vendor. The proxy and CLI under test are real.

## Cleanup

```bash
.claude/skills/verify-opencodex/scripts/verify.sh cleanup
```

Kills `PROXY_PID` and `MOCK_PID` from `.run-state` only. Removes `/tmp/opencodex-verify-<id>/`. Leaves `ARTIFACT_DIR`.

## Helpers

| command | meaning |
|---|---|
| `scripts/verify.sh launch` | mock upstream + isolated `ocx start` |
| `scripts/verify.sh doctor` | pid/port/identity check |
| `scripts/verify.sh drive-health` | healthz, readyz, dashboard GET `/` |
| `scripts/verify.sh drive-responses` | POST `/v1/responses` |
| `scripts/verify.sh drive-compact` | POST `/v1/responses/compact` |
| `scripts/verify.sh drive-models` | GET `/v1/models` |
| `scripts/verify.sh drive-status` | `ocx status --json` |
| `scripts/verify.sh cleanup` | tear down this run |
