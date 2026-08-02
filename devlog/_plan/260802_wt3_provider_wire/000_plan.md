# wt3 — Provider wire correctness (research)

Worktree: `/Users/jun/.codex/worktrees/260802-wt3-provider-wire` (branch `codex/wt3-provider-wire`, off `dev`).
Provider-adapter/wire bugs; all must-fix regardless of PR quality.

## Scope

### Bug A — PR #746 / issue #748: Copilot Responses-only models routed to chat completions

- Root cause: the `github-copilot` preset configures a provider-wide `openai-chat` adapter, but Copilot fronts a mixed-wire catalog; several newer OpenAI models are served only by the Responses API (`model "gpt-5.6-sol" is not accessible via the /chat/completions endpoint`). `gpt-5.4` hides it behind a passing text-only smoke test; a real Codex request (function tools + reasoning effort) fails.
- Grounding: `src/providers/registry.ts`, `src/providers/github-copilot-transport.ts`.
- Severity: high — hard data-plane failure for Copilot users on current models.

### Bug B — PR #860 (+ issue #875): DeepSeek `service_tier` must be capability-gated

- Root cause: `fastMode` injects `service_tier` unconditionally on Responses routes; DeepSeek does not support the field. PR #860 adds a provider-level `supportsServiceTier` capability: canonical OpenAI Responses providers support it, DeepSeek explicitly rejects it (strip the field), unclassified custom providers keep caller-supplied values.
- Fresh corroboration: issue #875 (2026-08-02) "DeepSeek V4 Flash Responses route stalls after tool calls" — same wire family; executing session must check whether #875 is the same root cause or a second defect before closing either.
- Grounding: `src/adapters/openai-responses.ts`, `src/server/responses/core.ts`, `src/types.ts`.

### Bug C — PRs #839 / #854: Claude 4.6/4.7 1M context windows missing

- Root cause: `ANTHROPIC_MODEL_CONTEXT_WINDOWS` omits `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`, so they advertise `max_input_tokens: null`, `shouldMarkOneMillion()` rejects them, and the `[1m]` picker row is never emitted — Claude Code accounts them at its 200k default. #854 additionally fixes generated profiles writing `[1m]` on sub-1M routes (372K route marked `[1m]`).
- Grounding: `src/claude/context-windows.ts`, `src/claude/model-info.ts`, `src/providers/registry.ts`.
- Note: #839 and #854 overlap; land ONE consolidated fix, credit both PRs.

### Optional — PRs #616 / #837: hosted image tool preferences

- Some gateways reserve the image tool namespace server-side; generic normalization collides with client `image_gen` declarations. #837 already integrates #616 onto current dev preserving authorship. Include if capacity allows.

## Claim ledger

| # | Claim | Source | Status |
|---|-------|--------|--------|
| 1 | Copilot serves some models Responses-only | gpt-5.4 verified (BerriAI/litellm#23332, exact `unsupported_api_for_model` error); gpt-5.6-sol lead only (JetBrains LLM-29711: function tools + reasoning_effort rejected on `/chat/completions`); same pattern for gpt-5-codex (opencode #2758) | verified (5.4) / lead (sol) |
| 2 | DeepSeek rejects/mishandles `service_tier` | No primary evidence either way (api-docs.deepseek.com does not list the field; Anthropic-compatible API marks it "Ignored" — different endpoint) | unresolved — capability-gating is safe regardless; do not claim rejection without a live probe |
| 3 | DeepSeek Responses route stalls after tool calls (hosted api.deepseek.com) | Stall reports are NIM/vLLM compatibility paths, not hosted; verified hosted failure mode is a 400 when `reasoning_content` is omitted after a tool call (official Thinking Mode docs; claude-code-router#1378) | contradicted as stated — #875 may be a `reasoning_content` echo defect, not #860's root cause; executing session must split them |
| 4 | Claude Opus 4.6/4.7 + Sonnet 4.6 are documented at 1M context | Anthropic official: Opus 4.6 (1M beta, 2026-02-05), Opus 4.7 (1M, 2026-04-16, migration guide), Sonnet 4.6 (1M beta, 2026-02-17); model overview cross-check | verified |

## Out of scope

- New provider presets (covered by separate enhancement PRs).
- Changing the conservative relay capability policy for unknown providers beyond what #860 states.
