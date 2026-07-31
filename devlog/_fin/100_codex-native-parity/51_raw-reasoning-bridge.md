# 100.51 — Raw Reasoning Bridge

## Question

Can Codex RS accept raw reasoning text, or only reasoning summaries?

## Answer

Codex RS can accept raw reasoning text through:

```text
response.reasoning_text.delta
```

This is separate from the summary path:

```text
response.reasoning_summary_text.delta
```

## Required Raw Event Shape

For raw reasoning, the SSE event needs:

```json
{
  "type": "response.reasoning_text.delta",
  "delta": "raw detail",
  "content_index": 0
}
```

Codex parses this into `ResponseEvent::ReasoningContentDelta`, then into raw reasoning app/server
events.

Relevant upstream paths:

```text
/tmp/opencodex-codex-src/codex-rs/codex-api/src/sse/responses.rs:334
/tmp/opencodex-codex-src/codex-rs/codex-api/src/sse/responses.rs:335
/tmp/opencodex-codex-src/codex-rs/codex-api/src/sse/responses.rs:336
/tmp/opencodex-codex-src/codex-rs/core/src/session/turn.rs:2310
/tmp/opencodex-codex-src/codex-rs/core/src/session/turn.rs:2325
/tmp/opencodex-codex-src/codex-rs/app-server-protocol/src/protocol/event_mapping.rs:384
/tmp/opencodex-codex-src/codex-rs/app-server-protocol/src/protocol/event_mapping.rs:389
/tmp/opencodex-codex-src/codex-rs/app-server-protocol/src/protocol/event_mapping.rs:390
```

Upstream fixture helper:

```text
/tmp/opencodex-codex-src/codex-rs/core/tests/common/responses.rs:766
/tmp/opencodex-codex-src/codex-rs/core/tests/common/responses.rs:768
/tmp/opencodex-codex-src/codex-rs/core/tests/common/responses.rs:769
/tmp/opencodex-codex-src/codex-rs/core/tests/common/responses.rs:770
```

## Required Sequence

Raw reasoning must arrive while a reasoning output item is active:

1. `response.created`
2. `response.output_item.added` with `type: "reasoning"`
3. `response.reasoning_text.delta`
4. `response.output_item.done` with final reasoning item containing raw content
5. `response.completed`

Relevant upstream test source:

```text
/tmp/opencodex-codex-src/codex-rs/core/tests/suite/items.rs:1150
/tmp/opencodex-codex-src/codex-rs/core/tests/suite/items.rs:1152
/tmp/opencodex-codex-src/codex-rs/core/tests/suite/items.rs:1153
/tmp/opencodex-codex-src/codex-rs/core/tests/suite/items.rs:1154
/tmp/opencodex-codex-src/codex-rs/core/tests/suite/items.rs:1155
```

Final raw reasoning item shape:

```json
{
  "type": "reasoning",
  "id": "reasoning-raw",
  "summary": [],
  "content": [
    { "type": "reasoning_text", "text": "raw detail" }
  ]
}
```

The model supports both `summary` and raw `content`:

```text
/tmp/opencodex-codex-src/codex-rs/protocol/src/models.rs:947
/tmp/opencodex-codex-src/codex-rs/protocol/src/models.rs:951
/tmp/opencodex-codex-src/codex-rs/protocol/src/models.rs:954
/tmp/opencodex-codex-src/codex-rs/protocol/src/models.rs:1604
/tmp/opencodex-codex-src/codex-rs/protocol/src/models.rs:1605
```

## Current opencodex State

opencodex currently maps every provider `thinking_delta` into the summary path:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts:167
/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts:169
/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts:176
/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts:83
/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts:86
/Users/jun/Developer/new/700_projects/opencodex/src/bridge.ts:90
```

Current adapter event type:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/types.ts:151
```

```ts
| { type: "thinking_delta"; thinking: string }
```

Incoming historical reasoning is already parsed from either summary or raw content:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/responses/schema.ts:21
/Users/jun/Developer/new/700_projects/opencodex/src/responses/schema.ts:22
/Users/jun/Developer/new/700_projects/opencodex/src/responses/schema.ts:42
/Users/jun/Developer/new/700_projects/opencodex/src/responses/schema.ts:45
/Users/jun/Developer/new/700_projects/opencodex/src/responses/schema.ts:46
/Users/jun/Developer/new/700_projects/opencodex/src/responses/parser.ts:242
/Users/jun/Developer/new/700_projects/opencodex/src/responses/parser.ts:243
```

So the missing piece is outbound bridge mode, not inbound schema awareness.

## Test Status

A targeted upstream runtime test was attempted by the research agent:

```bash
cargo test -p codex-core --test all reasoning_raw_content_delta_respects_flag -- --nocapture
```

It selected the intended test but aborted with a stack overflow before assertion result:

```text
thread 'tokio-rt-worker' has overflowed its stack
fatal runtime error: stack overflow, aborting
```

Therefore this document treats raw reasoning support as source-backed and fixture-backed, not as a
fresh passing runtime verification.

## Phase 100 Recommendation

Do not just rename `response.reasoning_summary_text.delta` to `response.reasoning_text.delta`.

Add an explicit second bridge mode:

```ts
| { type: "reasoning_raw_delta"; text: string }
```

or add source classification to `thinking_delta`.

Then emit:

- summary providers through `response.reasoning_summary_text.delta`;
- raw providers through `response.reasoning_text.delta`;
- final reasoning items with `content: [{ type: "reasoning_text", text }]` for raw mode.

Provider mapping should come from adapter knowledge or jawcode metadata such as
`compat.reasoningContentField` / `thinkingFormat`, not from a global assumption.
