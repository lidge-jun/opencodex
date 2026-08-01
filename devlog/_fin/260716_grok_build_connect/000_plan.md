# 000 — Grok Build에서 OpenCodex 모델 사용 가능 여부

## Loop-spec
- Loop archetype: spec-satisfaction research / documentation
- Trigger: xai-org/grok-build open-sourced; user asks whether **Grok Build can use OpenCodex-routed models** (already-installed Grok Build users)
- Goal: source-backed possible/partial/impossible verdict + upgraded `~/Developer/codex` analysis docs
- Non-goals: production OpenCodex inbound chat-completions implementation unless reopened; push
- Verifier: every claim cites real file path or live probe; residual list explicit
- Memory: this unit + `/Users/jun/Developer/codex/180_grok-build/analysis/*`

## Corrected question
**Grok Build TUI/CLI 사용자가 OpenCodex가 이미 라우팅 중인 모델들(gpt-5.6-*, anthropic/*, cursor/*, …)을 고를 수 있는가?**

NOT: OpenCodex가 Grok 계정 토큰을 쓰느냐 (그건 이미 구현된 반대 방향 Path).

## Early inventory
### Grok Build custom models (official user-guide 11)
- `[model.<name>]` with `base_url`, `model`, `api_key`/`env_key`, `api_backend`
- backends: `chat_completions` (default `/v1/chat/completions`), `responses` (`/v1/responses`), `messages` (`/v1/messages`)
- catalog override: `GROK_MODELS_BASE_URL` / `[endpoints].models_base_url` + Bearer key
- local OpenAI-compatible servers are first-class examples (Ollama, localhost:8080)

### OpenCodex data plane (live :10100)
- `GET /v1/models` → OpenAI list shape including natives + `provider/id` routed models
- `POST /v1/responses` primary inference
- `POST /v1/messages` Claude inbound
- **No inbound** `POST /v1/chat/completions` route (chat/completions exists only as *outbound* adapter)
- Loopback bind: data-plane API auth not required (`isApiAuthRequired` only non-loopback)

### Live probe 2026-07-16
- `GET http://127.0.0.1:10100/healthz` → opencodex 2.7.20
- `GET http://127.0.0.1:10100/v1/models` → includes `gpt-5.6-sol`, `anthropic/claude-opus-4-8`, `cursor/grok-4.5`, `xai/grok-4.5`, …

## Work-phases
| id | title | decade |
|----|-------|--------|
| wp0 | roadmap + corrected research inventory | 000 |
| wp1 | codex analysis upgrade (custom-model + ocx inbound) | 010 |
| wp2 | feasibility verdict Grok→OpenCodex models | 020/030 |

## Working hypothesis
**PARTIAL → practically POSSIBLE via config** using Grok `api_backend = "responses"` pointed at `http://127.0.0.1:10100/v1` with OpenCodex model ids. Default Grok `chat_completions` backend is a mismatch unless OpenCodex adds that inbound route.
