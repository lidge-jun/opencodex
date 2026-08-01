# 100.50 — Streaming, Thinking, and Context Metadata

## Questions

- Is intermediate streamed response text faithful?
- Are thinking/reasoning blocks represented correctly?
- Is context-window and token accounting metadata complete enough for Codex?

## Intermediate Response Text

For streamed translated adapters, opencodex is reasonably faithful.

The routed streaming path is:

```text
adapter.parseStream(...) -> bridgeToResponsesSSE(...)
```

Relevant local paths:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/server.ts:193
/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts:54
/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts:60
/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts:142
/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts:155
/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts:217
```

The bridge emits the core Responses SSE sequence Codex expects:

- `response.created`
- `response.output_item.added`
- `response.content_part.added`
- `response.output_text.delta`
- `response.output_text.done`
- `response.content_part.done`
- `response.output_item.done`
- `response.completed`

Upstream Codex parses these events in:

```text
/tmp/opencodex-codex-src/codex-rs/codex-api/src/sse/responses.rs:302
/tmp/opencodex-codex-src/codex-rs/codex-api/src/sse/responses.rs:310
/tmp/opencodex-codex-src/codex-rs/codex-api/src/sse/responses.rs:342
/tmp/opencodex-codex-src/codex-rs/codex-api/src/sse/responses.rs:393
/tmp/opencodex-codex-src/codex-rs/codex-api/src/sse/responses.rs:411
```

OpenAI/Azure Responses passthrough has the best stream fidelity because opencodex forwards the
upstream Responses body and sanitized headers directly.

Relevant local paths:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/openai-responses.ts:31
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/azure.ts:5
/Users/jun/Developer/new/700_projects/opencodex/src/server.ts:141
```

## Thinking / Reasoning Blocks

opencodex normalized stream events include:

```text
thinking_delta
```

Relevant local path:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/types.ts:149
```

The bridge currently emits provider thinking as reasoning summaries:

- `response.output_item.added` with `type: "reasoning"`
- `response.reasoning_summary_part.added`
- `response.reasoning_summary_text.delta`
- summary done events

Relevant local paths:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts:162
/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts:165
/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts:169
/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts:175
/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts:81
```

Upstream Codex distinguishes summary reasoning from raw reasoning content:

```text
/tmp/opencodex-codex-src/codex-rs/codex-api/src/common.rs:101
/tmp/opencodex-codex-src/codex-rs/codex-api/src/common.rs:105
/tmp/opencodex-codex-src/codex-rs/codex-api/src/sse/responses.rs:326
/tmp/opencodex-codex-src/codex-rs/codex-api/src/sse/responses.rs:334
```

Gap: opencodex never emits `response.reasoning_text.delta`, so every provider thinking stream is
presented as a summary, even when the upstream provider is returning raw reasoning-like content.

Incoming previous-turn reasoning is parsed into local assistant `thinking` with a JSON signature:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/responses/schema.ts:42
/Users/jun/Developer/new/700_projects/opencodex/src/responses/parser.ts:240
```

That is useful, but it does not round-trip provider-specific opaque reasoning metadata natively.

## Non-Streaming Gap

Translated non-streaming responses are lower fidelity. `buildResponseJSON()` only accumulates text
and usage, then emits a message item if text exists.

Relevant local paths:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/server.ts:216
/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts:260
/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts:269
/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts:274
```

Known examples:

- Anthropic streaming maps thinking deltas, but non-streaming currently handles text/tool-use only.
- OpenAI-compatible streaming maps `delta.reasoning_content`, but non-streaming handles
  `message.content` and `tool_calls` only.
- Google maps text and function calls, with no equivalent thinking channel today.

Relevant local paths:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/anthropic.ts:233
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/anthropic.ts:283
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/openai-chat.ts:202
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/openai-chat.ts:237
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/google.ts:137
/Users/jun/Developer/new/700_projects/opencodex/src/adapters/google.ts:170
```

## Usage and Context Metadata

Current local usage type has only:

```text
inputTokens
outputTokens
```

Relevant local paths:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/types.ts:158
/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts:221
```

Upstream Codex can consume richer usage:

- `input_tokens`
- `input_tokens_details.cached_tokens`
- `output_tokens`
- `output_tokens_details.reasoning_tokens`
- `total_tokens`

Relevant upstream paths:

```text
/tmp/opencodex-codex-src/codex-rs/codex-api/src/sse/responses.rs:100
/tmp/opencodex-codex-src/codex-rs/codex-api/src/sse/responses.rs:119
/tmp/opencodex-codex-src/codex-rs/protocol/src/protocol.rs:1999
```

Gap: translated streams report cached/reasoning token counts as zero or absent, affecting status UI,
analytics, and context-budget behavior.

Codex model metadata also includes context-window fields:

- `context_window`
- `max_context_window`
- `auto_compact_token_limit`
- `effective_context_window_percent`
- `truncation_policy`

Relevant upstream paths:

```text
/tmp/opencodex-codex-src/codex-rs/protocol/src/openai_models.rs:346
/tmp/opencodex-codex-src/codex-rs/protocol/src/openai_models.rs:428
/tmp/opencodex-codex-src/codex-rs/core/src/session/mod.rs:3421
/tmp/opencodex-codex-src/codex-rs/core/src/session/mod.rs:3457
/tmp/opencodex-codex-src/codex-rs/core/src/session/mod.rs:3529
/tmp/opencodex-codex-src/codex-rs/protocol/src/protocol.rs:2013
```

opencodex does not currently set provider/model-specific context-window fields for routed catalog
entries. Routed models either inherit native template limits or omit them in fallback mode.

## Response Header and Error Gaps

Upstream Codex can derive events from headers before SSE processing:

- server model;
- rate limits;
- model etag;
- server reasoning included.

Relevant upstream paths:

```text
/tmp/opencodex-codex-src/codex-rs/codex-api/src/sse/responses.rs:31
/tmp/opencodex-codex-src/codex-rs/codex-api/src/common.rs:77
```

Translated opencodex streams set minimal SSE headers only:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/server.ts:206
```

Error fidelity is also incomplete. opencodex emits `response.failed` with `last_error`, while the
upstream parser evidence suggests typed classification reads `response.error`.

Relevant paths:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts:231
/tmp/opencodex-codex-src/codex-rs/codex-api/src/sse/responses.rs:347
/tmp/opencodex-codex-src/codex-rs/codex-api/src/sse/responses.rs:350
/tmp/opencodex-codex-src/codex-rs/codex-api/src/sse/responses.rs:382
```

## Phase 100 Recommendation

1. Add provider/model-specific catalog metadata for context windows and truncation behavior.
2. Extend `OcxUsage` and bridge output to include cached input tokens and reasoning output tokens.
3. Decide whether each provider's thinking stream should map to Codex reasoning summary or raw
   reasoning text.
4. Enforce parsed `reasoning.summary = "none"` when building the stream.
5. Either improve translated non-streaming parity or explicitly document it as lower fidelity.
6. Synthesize or forward Codex-relevant headers where possible.
7. Align translated `response.failed` shape with upstream parser expectations.
