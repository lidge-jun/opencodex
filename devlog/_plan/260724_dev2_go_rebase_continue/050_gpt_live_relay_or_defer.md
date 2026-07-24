# 050_gpt_live_relay_or_defer

## Objective

Implement GPT-Live/realtime relay on Go **or** dependency-readiness deferral with residual evidence.

## Decision rule (NOT effort/budget)

Implement in this phase when **all** readiness gates hold after 010–040:

1. Rebase complete (`origin/dev` ancestor of HEAD).
2. 020 stream terminal contracts green (live relay depends on honest upstream error/terminal handling).
3. Auth/admission middleware on Go server can attach ChatGPT/API credentials without new secret types.
4. Sideband WS upgrade path can reuse or safely extend `wsbridge.go` patterns without breaking `/v1/responses/ws`.

If any gate fails → **defer with residual section** (status `deferred_dependency`), not `DONE` for voice parity.
If wall-clock bound hits before gates evaluated → work-phase outcome `BUDGET_EXHAUSTED` (does not satisfy c5 by itself).

## Option A — implement

### NEW

| Path | Role |
|---|---|
| `go/internal/server/live.go` | POST call-create + sideband handlers |
| `go/internal/server/live_test.go` | route/header/timeout tests |

### MODIFY

| Path | Before | After |
|---|---|---|
| `go/internal/server/server.go` | routes responses/chat/messages/health/ws only (~L93-100) | register live/realtime routes |
| `go/internal/server/middleware.go` | existing auth | ensure live routes use same admission |

### Behavior targets (TS `src/server/live.ts` on origin/dev)

- HTTP: `POST /v1/live`, `POST /v1/realtime/calls`
- WS: `GET /v1/live/{callId}`, `GET /v1/realtime/calls/{callId}`, `GET /v1/realtime?call_id=`
- AVAS query `intent=quicksilver&architecture=avas`
- Sideband API root default `https://api.openai.com/v1`
- Relay protocol headers; never client-override Authorization

### Activation matrix

| ID | Trigger | Observable | Test |
|---|---|---|---|
| L1 | POST /v1/live without auth | 401/403 | live_test |
| L2 | POST with body > max | 413 | live_test |
| L3 | WS upgrade missing key | 400 | live_test |
| L4 | protocol headers forwarded, auth not | captured upstream req | live_test with httptest |

## Option B — dependency deferral template

```md
## Residual: GPT-Live
Blocked by: <gate id>
TS anchors: origin/dev src/server/live.ts (header contract)
Go missing routes: server.go mux list
Unblock when: <dependency>
```

## Verification

```bash
cd go
go test ./internal/server -count=1
go test ./... -count=1 -timeout 120s
```
