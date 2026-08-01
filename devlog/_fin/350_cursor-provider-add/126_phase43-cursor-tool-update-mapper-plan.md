# 350.126 — Phase 43: map Cursor tool-call updates back to Responses events

> Goal: `160d07c7-38b`
> Depends on: 350.125

## Part 1 — Easy explanation

Once Cursor starts emitting tool calls, opencodex must pass those calls back to Codex in
Responses API format. Today the protobuf mapper drops all Cursor tool-call updates. This
phase translates those protobuf messages into the adapter events that `bridge.ts` already
knows how to render as Responses tool calls.

## Part 2 — Diff-level plan

### MODIFY: `src/adapters/cursor/types.ts`

No new public transport type is required if `CursorServerMessage` continues to use generic
adapter-oriented messages. If useful for staging, add:

```ts
| { type: "tool_call_start"; id: string; name: string }
| { type: "tool_call_delta"; arguments: string }
| { type: "tool_call_end"; id?: string }
```

But the preferred design is to have `mapCursorProtobufServerMessage` return
`CursorServerMessage[]`, then `mapCursorServerMessage` maps those to `AdapterEvent[]`.

### MODIFY: `src/adapters/cursor/protobuf-events.ts`

Add cases:

- `toolCallStarted`: inspect `value.toolCall?.tool.case`, derive a Responses-compatible
  tool name, emit start. If args are present in the concrete tool message, emit initial
  JSON args delta.
- `partialToolCall`: emit start if needed, then emit `argsTextDelta`.
- `toolCallDelta`: support known delta variants, especially shell/task/edit deltas if
  they contain args text. If no arguments are represented, ignore rather than inventing.
- `toolCallCompleted`: emit final args if available, then emit end.

Maintain mapper state:

```ts
export interface CursorProtobufEventState {
  usage: OcxUsage;
  openToolCalls: Map<string, { name: string; args: string }>;
}
```

Name extraction:

- Generic Responses client tools should arrive through `McpToolCall` or another generated
  generic call shape. Inspect generated field names before coding.
- If Cursor emits native cases like `shellToolCall`, map to stable Responses tool names
  only when those names correspond to advertised tools. Do not expose unadvertised native
  exec calls as client function calls.

### MODIFY: `src/adapters/cursor/message-mapper.ts`

Map new `CursorServerMessage` tool variants to `AdapterEvent`:

```ts
case "tool_call_start": return [{ type: "tool_call_start", id: message.id, name: message.name }];
case "tool_call_delta": return [{ type: "tool_call_delta", arguments: message.arguments }];
case "tool_call_end": return [{ type: "tool_call_end" }];
```

### Tests

Add or modify:

- `tests/cursor-protobuf-events.test.ts`: generated protobuf `interactionUpdate`
  with `toolCallStarted` + `partialToolCall` + `toolCallCompleted` maps to start/delta/end.
- `tests/cursor-message-mapper.test.ts`: tool message variants map to adapter events.
- Existing `bridge` tests or a new focused test proving adapter tool events become
  Responses `function_call` JSON.

## Risks

- Generated Cursor `ToolCall` shapes differ by tool type. The implementation must inspect
  concrete fields rather than guessing.
- Duplicate completed/end events can produce invalid Responses output. Track open call IDs
  and close exactly once.
- Some Cursor native tool calls are execution-side only and should not be relayed as
  client Responses tool calls. Keep native exec and client tool call pathways separate.

