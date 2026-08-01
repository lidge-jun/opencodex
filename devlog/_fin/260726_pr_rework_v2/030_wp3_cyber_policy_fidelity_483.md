# 030 — WP3: land PR #483 (preserve OpenAI `cyber_policy` errors end-to-end)

Author: Wibias. Head: `fix/cyber-policy-error-fidelity`. Size: +669/-63, 10 files.

## Problem

Native Codex shows a dedicated notice only when `error.code === "cyber_policy"`.
OpenCodex's error remapping dropped that code — rewriting it to
`invalid_request_error` or a 502 `upstream_server_error` — so from the user's side
the agent simply stopped with no reason given. The author cites a 2026-07-24
Cursor transcript where the turn ended with a mangled "Unable to reach the model
provider OpenAI flagged this request for potential high-risk cybersecurity
activity…" string.

Upstream reference: https://developers.openai.com/api/docs/guides/safety-checks/cybersecurity

## MODIFY map

| File | Change |
|------|--------|
| `src/lib/errors.ts` | carry structured `type` + `code` through classify/remap instead of flattening |
| `src/adapters/openai-chat.ts` | detect cyber refusals from explicit upstream `error.code` or known message wording |
| `src/bridge.ts` | preserve the code across the bridged SSE path |
| `src/chat/outbound.ts` | same for the chat-completions translation |
| `src/combos/failover.ts` | treat a cyber refusal as NON-retryable — retrying a policy refusal wastes a paid call and cannot succeed |
| `src/server/chat-completions.ts`, `src/server/responses/core.ts` | emit the preserved code with HTTP 400 |

The failover change is the one with real behavioural weight: a policy refusal is
terminal, so counting it as a transient failure would burn every combo target.

## Review note carried into A

The PR detects cyber refusals partly by message heuristics, including Cursor
session wording. Heuristics on upstream prose are inherently brittle. The
mitigation to verify at audit: the explicit `error.code` path must be primary,
with the heuristic as fallback only, and no path may invent a bypass — the author
states this explicitly ("do not invent bypasses") and it needs confirming against
the diff rather than taken on trust.

## TESTS

- `tests/cyber-policy-error-fidelity.test.ts` (NEW) — passthrough, combo, bridged
  SSE, chat completions, and failover-stop coverage.
- `tests/chat-completions-endpoint.test.ts`, `tests/openai-chat-hardening.test.ts`
  — updated for the richer normalized error object.

## Integration method

Apply `gh pr diff 483` on `dev` with the author's `Co-authored-by` trailer. This
is the largest category-A change (7 source files), so it lands last, after the two
smaller phases are already green.

## Verification (C)

| Command | Expected |
|---------|----------|
| `bun test tests/cyber-policy-error-fidelity.test.ts tests/error-fidelity.test.ts tests/errors-adapter-failure.test.ts tests/adapter-error-inline.test.ts` | pass |
| `bun test tests/chat-completions-endpoint.test.ts tests/openai-chat-hardening.test.ts` | pass |
| `bun run typecheck` | exit 0 |
