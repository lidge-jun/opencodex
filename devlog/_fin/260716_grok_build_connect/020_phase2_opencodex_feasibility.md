# 020 — Feasibility: Grok Build consuming OpenCodex models

## Goal
Decide possible / partial / impossible for installed Grok Build users to select OpenCodex catalog models.

## Decision matrix
| path | description | expected |
|------|-------------|----------|
| A | Per-model `[model.*]` → OpenCodex `/v1` with `api_backend=responses` | primary candidate |
| B | `GROK_MODELS_BASE_URL=http://127.0.0.1:10100/v1` catalog takeover | candidate for full catalog |
| C | Default `chat_completions` against OpenCodex | fail (no route) |
| D | `api_backend=messages` against OpenCodex `/v1/messages` | partial (Claude-shaped inbound) |

## Evidence sources
- Grok: user-guide 11-custom-models.md
- OpenCodex: src/server/index.ts routes; auth-cors loopback; live /v1/models
