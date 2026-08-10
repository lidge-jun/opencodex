# 001 — Open issue triage (2026-08-05, vs origin/dev e44d234f0)

Source: sol-medium explorer lane A. 38 open issues. Classification: 14 bug
(10 unresolved, 4 needs-verification), 4 code-level improvement (1 already
resolved on dev), 20 out of scope (feature/provider/tracker/upstream).

## Confirmed unresolved bugs — stack candidates

| Issue | Defect | Code evidence |
|------:|--------|---------------|
| #1007 | `ocx account login` withholds the authorization URL under non-TTY stdout | `src/cli/account-auth.ts:84-101` — console.log then long polling, no explicit flush |
| #1001 | Hosted web-search forced-answer pass accepts a malformed tool call and completes without an assistant message | `src/web-search/loop.ts:72-75,681-705` — empty tool name judged real; forced-answer ends without visible message check |
| #993 | Kiro provider: profileArn required 400 for Builder ID accounts on gated models | `src/adapters/kiro.ts:1723-1729` — profileArn silently omitted, CLI wire used; no per-account ARN acquisition |
| #992 | Routed models inherit native template context_window when /models omits context metadata | `src/codex/catalog/sync.ts:205-228`, `src/codex/catalog/parsing.ts:290-301` |
| #959 | No management-plane support for provider `headers` | `src/server/management/provider-routes.ts:210-289` — PATCH mask lacks `headers`, unknown fields 400; CLI lacks the option (`src/cli/provider-runtime.ts:16-55`) |
| #938 | Responses passthrough UUID item IDs leave Codex stuck on Thinking | `src/server/responses-item-id-repair.ts:84-94,220-223` — repair only handles pre-registered placeholders / missing terminal IDs, never validates arbitrary UUID prefixes |
| #914 | DNS/network reachability failures incorrectly rotate Codex pool accounts | `src/server/responses/core.ts:1737`, `src/server/responses/compact.ts:419` — fetch rejections still recorded as `connect_error` against account health; candidate fix `fe693ae62` not an ancestor of origin/dev |
| #907 | Bundled jawcode prices for gpt-5.6-terra/luna are pre-price-cut rates | `src/generated/jawcode-model-metadata.ts:47` — stale Luna 1/6/0.1/1.25, Terra 2.5/15/0.25/3.125 |
| #893 | Responses-compatible gateways can return sparse lifecycle snapshots Codex clients do not commit | no `responsesSnapshotRepair`; current SSE assembly only repairs images and item IDs (`src/server/responses/core.ts:1967-1976`) |
| #875 | DeepSeek V4 Flash Responses route stalls after tool calls | `5dd965a13` only disabled WebSocket upstream streaming (`src/providers/registry.ts:1146`); reporter reproduced on default HTTP/SSE path at e44d234f0, still SSE relay (`src/server/responses/core.ts:1880-1881,1967`) |

## Needs verification before stack entry

| Issue | Why unresolved status is uncertain |
|------:|-----------------------------------|
| #994 | `reasoning_content` replay is model-allowlisted (`src/providers/registry.ts:918-958,1637-1655`); report lacks provider/model + wire capture |
| #904 | `eeef7a32a` fixed astral-surrogate boundaries but does not explain the original Hangul-only corruption; needs the failing wire capture |
| #796 | Structured empty-content fix `d3abf4345` + regression test landed (`src/adapters/openai-chat.ts:366-379`), but no live Ark credential verification |
| #418 | Current code provides catalog/roster guidance (`src/server/responses/collaboration.ts:243-304`); latest same-run trace does not reproduce the original failure |

## Already resolved on dev — close candidates

| Issue | Evidence |
|------:|----------|
| #806 | `d52b387db` (ancestor of origin/dev) split/fixed GUI+CLI+docs wording; current GUI distinguishes "Usage-based proactive switching" from cache warnings (`gui/src/i18n/en.ts:1296-1315`) |

## Out of scope (20)

Feature/provider/tracker/upstream items: #974, #823, #822, #821, #755, #695,
#657, #572, #561, #540, #241, #201, #178, #177, #95, #92, #417, #415, #414,
#386. (Improvement #820 and #809 are code-level and stay in the campaign's
improvement bucket; #820 is a larger architecture epic — deferred to its own
unit, not this stack.)
