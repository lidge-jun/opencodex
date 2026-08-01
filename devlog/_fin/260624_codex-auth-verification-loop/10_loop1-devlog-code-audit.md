# 10 - Loop 1 Devlog-to-Code Audit

Status: verified.

Date: 2026-06-24

Scope: audit `devlog/270_codex-multi-account-auth/00` through `150` against current source, tests, and source evidence.

## External Evidence

| Claim | Source | Status |
| --- | --- | --- |
| OAuth public clients need replay-resistant refresh-token handling and rotation awareness. | https://www.rfc-editor.org/info/rfc9700 | sufficient |
| Codex/ChatGPT auth failures from refreshed or revoked tokens are a real failure class. | https://github.com/openai/codex/issues/25443 and https://github.com/openai/codex/issues/15502 | supporting |
| ChatGPT Business seats and usage limits are managed separately from local WHAM telemetry. | https://help.openai.com/en/articles/8792536-managing-billing-and-seats-in-chatgpt-business and https://help.openai.com/en/articles/12003714-chatgpt-business-models-limits | sufficient |

## Audit Matrix

| Area | Devlog refs | Code refs | Status | Evidence |
| --- | --- | --- | --- | --- |
| Account storage | 00, 10 | `src/codex-account-store.ts`, `src/types.ts` | verified | Credential CRUD, refresh, and per-account credential types remain isolated from GUI account summaries. |
| Passthrough override | 20 | `src/adapters/openai-responses.ts`, `src/ws-bridge.ts`, `src/server.ts` | verified | Pool tokens are injected through `_codexAccountOverride`; WS forward headers preserve Codex-safe headers only. |
| Management API | 30, 140, 150 | `src/codex-auth-api.ts`, `src/codex-auth-collision.ts`, `src/codex-quota.ts` | verified | Runtime config mutation, collision checking, quota storage, and reauth flags are covered by `tests/codex-auth-api.test.ts` and `tests/codex-auth-collision.test.ts`. |
| Dashboard GUI | 40, 150 | `gui/src/pages/CodexAuth.tsx`, `gui/src/components/AddCodexAccountModal.tsx`, `gui/src/styles.css`, `gui/src/App.tsx` | verified | Account pool, refresh button, copy-link login, cancel login, fixed quota rows, and locale-safe `data-page` navigation are implemented. |
| Tests/hardening | 50, 90, 100, 140, 150 | `tests/*codex*`, `tests/session-affinity.test.ts`, `tests/codex-routing.test.ts` | verified | Full `bun test tests` passed with 245 tests. |
| OAuth implementation | 60, 95, 110, 130, 140 | `src/oauth/chatgpt.ts`, `src/oauth/index.ts`, `src/oauth/store.ts`, `src/codex-auth-collision.ts` | verified | OAuth constants, login flow, collision handling, token refresh, and cancel/recovery paths have regression coverage. |
| Quota/autoswitch | 70, 140, 150 | `src/codex-quota.ts`, `src/codex-routing.ts`, `src/server.ts`, `gui/src/pages/CodexAuth.tsx` | verified | `usageScore=max(5h, weekly, 30d when present)`, optional 30d parsing/display, and non-200 failover threshold are implemented and tested. |
| E2E verification | 80, 120, 150 | local proxy and browser probes | verified | Loop 3 restarted the proxy, verified redacted API state, and confirmed desktop/narrow Codex Auth quota geometry. |

## Contradictions Resolved

- Earlier devlog phases described weekly-only auto-switch. Current code and plan supersede that with `usageScore=max(5h, weekly, 30d when present)`.
- Previous browser probe depended on English `Codex Auth` text. Current plan/code use `data-page="codex-auth"` to avoid locale dependence.
- Previous `/api/codex-auth/accounts?refresh=1` raw probe risked email exposure. Current evidence uses redacted account counts and quota field booleans only.
- `src/server.ts` was oversized for more routing logic. Current implementation extracted routing state and failover decisions to `src/codex-routing.ts`.
