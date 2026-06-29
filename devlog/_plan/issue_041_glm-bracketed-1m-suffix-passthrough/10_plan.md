# Issue #41 — Implementation Plan (Option A + Option B doc note)

Branch: `feat/kiro-on-dev`. One PABCD cycle. No scope creep beyond the
bracketed-suffix strip + tests + doc note.

## Goal

`glm-5.2[1m]` routed through the `openai-chat` adapter currently sends
`"model":"glm-5.2[1m]"` verbatim → Z.AI 400 code 1211 "Unknown Model".
Strip a trailing bracketed `[...]` suffix from the wire `model` value on the
**openai-chat path only**. Leave the `anthropic` adapter untouched (where
`[1m]` is the documented Z.AI Anthropic-coding convention).

## Change map (diff-level)

### 1. `src/adapters/openai-chat.ts`
- Add a small module-local, exported helper:
  ```ts
  // Z.AI's "glm-5.2[1m]" 1M-context id is a Claude-Code/Anthropic-endpoint-only
  // convention; OpenAI-compatible endpoints reject the bracketed suffix.
  // Strip a single trailing "[...]" group from the wire model id.
  export function stripBracketedModelSuffix(modelId: string): string {
    return modelId.replace(/\[[^\]]*\]\s*$/, "");
  }
  ```
- In `buildRequest`, change the wire body only:
  ```ts
  const body: Record<string, unknown> = {
    model: stripBracketedModelSuffix(parsed.modelId),
    messages,
    stream: parsed.stream,
  };
  ```
- Scope: only `body.model` is normalized. `parsed.modelId` stays intact for
  routing/logging and for the existing `modelInList(...)` config-key lookups,
  so no behavior change for ids without a bracket suffix.

### 2. `src/adapters/anthropic.ts`
- No change. `model: parsed.modelId` stays verbatim (`[1m]` is valid there).
  Covered by a regression test asserting the no-op.

### 3. Tests — `tests/openai-chat-model-suffix.test.ts` (new)
- `buildRequest({ modelId: "glm-5.2[1m]" })` on openai-chat → `body.model === "glm-5.2"`.
- Bare `glm-5.2` and ids without brackets pass through unchanged.
- Unit-test `stripBracketedModelSuffix` directly: `"glm-5.2[1m]"`→`"glm-5.2"`,
  `"glm-5.2"`→`"glm-5.2"`, `"a[1m] "`→`"a"`, no interior strip (`"a[b]c"` untouched).
- anthropic adapter `buildRequest({ modelId: "glm-5.2[1m]" })` → `body.model === "glm-5.2[1m]"` (no-op).

### 4. Docs — README note (Option B)
- Add a short note: GLM-5.2 1M via `openai-chat` now accepts both `glm-5.2` and
  `glm-5.2[1m]` (suffix stripped); `[1m]` is otherwise an Anthropic-endpoint
  convention reachable via the `anthropic` adapter at the Z.AI coding base.

## Risk / scope

- Risk: low. Regex strips only a trailing `[...]`; confined to the openai-chat
  wire model. No change to routing keys, anthropic adapter, or config lookups.
- A bracketed suffix that some other OpenAI-compatible provider treats as
  meaningful would be affected — accepted: the `[...]` trailing convention is
  not a valid OpenAI chat-completions `model` value anywhere we target.

## Verification

- `bun test tests/openai-chat-model-suffix.test.ts` (new) + `tests/reasoning-effort.test.ts` (existing openai-chat coverage).
- `bunx tsc --noEmit` (or repo's tsc script) clean.
