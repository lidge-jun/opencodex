# 100.17 — Thinking and Usage Parity Implementation Plan

## Easy Summary

Phase 100.3 makes translated providers look more like native Codex Responses output. The proxy will
keep existing reasoning summary events, add a separate raw reasoning text path for providers that
actually emit raw reasoning content, and report cached/reasoning token details when providers expose
them. This should improve Codex CLI/App thinking display and token accounting without pretending
unknown providers support metadata they do not expose.

## Current State

Relevant source files:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/types.ts
/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/openai-chat.ts
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/anthropic.ts
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/google.ts
```

Current gaps:

1. `AdapterEvent` only has `thinking_delta`, and the bridge always emits it as
   `response.reasoning_summary_text.delta`.
2. OpenAI-compatible `delta.reasoning_content` is raw reasoning-like content but currently gets
   downgraded to a summary.
3. `OcxUsage` only has `inputTokens` and `outputTokens`, so Responses usage lacks:
   - `input_tokens_details.cached_tokens`
   - `output_tokens_details.reasoning_tokens`
4. Non-streaming JSON responses ignore reasoning deltas entirely.

## Policy

Use two reasoning event classes:

```ts
| { type: "thinking_delta"; thinking: string }
| { type: "reasoning_raw_delta"; text: string }
```

Provider mapping:

1. Anthropic `thinking_delta` stays `thinking_delta` for now because its signed thinking blocks also
   serve provider-specific continuity and are already represented as summary in opencodex history.
2. OpenAI-compatible `reasoning_content` becomes `reasoning_raw_delta` because that field is a raw
   reasoning stream on compatible chat APIs.
3. Google remains text/tool only until a provider-specific raw-thinking field is observed.

Usage details policy:

1. Preserve existing totals.
2. Add optional details only when upstream reports them.
3. Do not fabricate cache or reasoning-token values.

## Diff-Level Plan

### MODIFY

```text
/Users/jun/Developer/new/700_projects/opencodex/src/types.ts
```

Change `AdapterEvent`:

```diff
 export type AdapterEvent =
   | { type: "text_delta"; text: string }
   | { type: "thinking_delta"; thinking: string }
+  | { type: "reasoning_raw_delta"; text: string }
   | { type: "tool_call_start"; id: string; name: string }
```

Extend `OcxUsage`:

```diff
 export interface OcxUsage {
   inputTokens: number;
   outputTokens: number;
+  cachedInputTokens?: number;
+  reasoningOutputTokens?: number;
 }
```

### MODIFY

```text
/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts
```

Add a helper:

```ts
function responsesUsage(usage: OcxUsage | undefined): Record<string, unknown> {
  if (!usage) return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  const out: Record<string, unknown> = {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
  };
  if (usage.cachedInputTokens !== undefined) {
    out.input_tokens_details = { cached_tokens: usage.cachedInputTokens };
  }
  if (usage.reasoningOutputTokens !== undefined) {
    out.output_tokens_details = { reasoning_tokens: usage.reasoningOutputTokens };
  }
  return out;
}
```

Replace duplicated stream/non-stream usage literals with `responsesUsage(event.usage)`.

Add raw reasoning state alongside the existing summary state:

```ts
let currentRawReasoning: { itemId: string; outputIndex: number; text: string } | null = null;
```

Add a `closeCurrentRawReasoning()` that finalizes:

```ts
{
  type: "reasoning",
  id: currentRawReasoning.itemId,
  summary: [],
  content: [{ type: "reasoning_text", text: currentRawReasoning.text }],
}
```

Handle `reasoning_raw_delta` by emitting:

```text
response.output_item.added
response.reasoning_text.delta
```

The raw delta payload must include the fields Codex RS requires:

```ts
emit("response.reasoning_text.delta", {
  item_id: currentRawReasoning.itemId,
  output_index: currentRawReasoning.outputIndex,
  content_index: 0,
  delta: event.text,
});
```

Do not emit summary events for raw reasoning.

Raw and summary reasoning state must be mutually exclusive:

1. `reasoning_raw_delta` closes `currentReasoning` and `currentToolCall`.
2. `thinking_delta` closes `currentRawReasoning` and `currentToolCall`.
3. `text_delta`, `tool_call_start`, `done`, and `error` close both reasoning states.
4. `closeCurrentRawReasoning()` increments `outputIndex` exactly once, matching
   `closeCurrentReasoning()`.

Update `buildResponseJSON()` so non-streaming raw reasoning produces a completed reasoning item
before the assistant message.

Non-streaming ordering:

```text
reasoning_raw_delta events -> one reasoning output item with content[]
thinking_delta events      -> one reasoning output item with summary[]
text_delta events          -> one assistant message item
done                       -> usage
```

### MODIFY

```text
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/openai-chat.ts
```

Change streaming mapping:

```diff
- yield { type: "thinking_delta", thinking: delta.reasoning_content };
+ yield { type: "reasoning_raw_delta", text: delta.reasoning_content };
```

Change non-streaming mapping:

```ts
if (typeof msg.reasoning_content === "string" && msg.reasoning_content.length > 0) {
  events.push({ type: "reasoning_raw_delta", text: msg.reasoning_content });
}
```

Map usage details:

```ts
const promptDetails = usage.prompt_tokens_details as Record<string, number> | undefined;
const completionDetails = usage.completion_tokens_details as Record<string, number> | undefined;
usage: {
  inputTokens: usage.prompt_tokens ?? 0,
  outputTokens: usage.completion_tokens ?? 0,
  ...(promptDetails?.cached_tokens !== undefined ? { cachedInputTokens: promptDetails.cached_tokens } : {}),
  ...(completionDetails?.reasoning_tokens !== undefined ? { reasoningOutputTokens: completionDetails.reasoning_tokens } : {}),
}
```

### MODIFY

```text
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/anthropic.ts
```

Keep `thinking_delta` as summary. Extend usage mapping:

```ts
const cacheRead = usage.cache_read_input_tokens ?? 0;
const cacheCreation = usage.cache_creation_input_tokens ?? 0;
const cachedInputTokens = cacheRead + cacheCreation;
```

Include `cachedInputTokens` only when either upstream field is present:

```ts
const hasCache =
  usage.cache_read_input_tokens !== undefined ||
  usage.cache_creation_input_tokens !== undefined;
```

### MODIFY

```text
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/google.ts
```

Extend usage mapping when Gemini returns known metadata:

```ts
cachedInputTokens: usageMeta.cachedContentTokenCount
reasoningOutputTokens: usageMeta.thoughtsTokenCount
```

Keep both optional.

### NEW

```text
/Users/jun/Developer/new/700_projects/opencodex/tests/bridge.test.ts
```

Add focused bridge tests:

1. streaming `reasoning_raw_delta` emits `response.reasoning_text.delta` and final reasoning content;
2. streaming `thinking_delta` still emits summary events;
3. usage details serialize into `input_tokens_details.cached_tokens` and
   `output_tokens_details.reasoning_tokens`;
4. non-streaming JSON includes raw reasoning item and usage details.
5. raw reasoning closes before later text output, preserving output ordering and indexes.

### NEW

```text
/Users/jun/Developer/new/700_projects/opencodex/tests/adapter-usage.test.ts
```

Add adapter-level unit tests for:

1. OpenAI-compatible usage details and `reasoning_content` mapping;
2. Anthropic cache-token mapping;
3. Google cached/thoughts-token mapping.

## Verification

Run:

```bash
bun test tests
bun x tsc --noEmit
git diff --check
```

Expected result:

```text
all pass
```

## Acceptance Criteria

1. Existing summary thinking behavior does not regress.
2. OpenAI-compatible raw `reasoning_content` reaches Codex as raw `reasoning_text`.
3. Non-streaming translated responses preserve raw reasoning content.
4. Usage details are present when upstream providers expose them and absent when unknown.
5. No provider gets fabricated cache/reasoning token counts.
