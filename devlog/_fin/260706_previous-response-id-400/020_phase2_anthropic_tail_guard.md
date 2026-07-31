# Phase 2 — Bug B: Anthropic trailing-assistant guard

## Changes

### MODIFY src/adapters/anthropic.ts
- In `messagesToAnthropicFormat` (or right after it in `buildRequest`, before body assembly):
  - If `messages.length === 0` → push `{ role: "user", content: "(continue)" }`
    (empty messages is invalid for the API anyway).
  - Else if last message `role === "assistant"` → push `{ role: "user", content: "(continue)" }`.
- Rationale: newer Anthropic models reject assistant-tail (prefill) conversations:
  `This model does not support assistant message prefill. The conversation must end with a
  user message.` Precedent: kiro adapter user "(continue)" nudge (src/adapters/kiro.ts:283,309-317).
- Placement choice: inside `messagesToAnthropicFormat` return path, so every caller
  (buildRequest, any future reuse) gets the invariant.
- Note: assistant tool_use tails are already followed by injected tool_result user messages
  (anthropic.ts:369-395) — guard only fires for plain-text/thinking assistant tails and empty lists.

## Tests
- tests/anthropic*.test.ts (find existing file; else new tests/anthropic-tail-guard.test.ts):
  - context ending with assistant text → wire messages end with user "(continue)".
  - context ending with user → unchanged (no extra nudge).
  - empty context messages → single user "(continue)".
  - assistant tool_use + toolResult tail → unchanged (no double nudge).

## Accept
- bun test + tsc green; no Anthropic request body can end with role assistant.
