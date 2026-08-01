# Phase 44 — Cursor Responses Tool Continuation Plan

## Goal

Close the remaining non-live gap in the Cursor Responses tool bridge: after Cursor emits a
Responses tool call, the next request must preserve enough prior tool-call and tool-result context
for Cursor to continue coherently. Also preserve the Responses API controls that GPT Pro flagged:
`tool_choice.allowed_tools` and `parallel_tool_calls`.

## Findings

- `src/responses/parser.ts` already parses prior `function_call`, `custom_tool_call`,
  `tool_search_call`, and their outputs into `OcxAssistantMessage` toolCall parts plus
  `OcxToolResultMessage`.
- `src/adapters/cursor/request-builder.ts` currently drops assistant `toolCall` parts
  (`contentPartToText()` returns `undefined`) and serializes tool results as bare text. Cursor
  therefore loses call id/name/args/result pairing in root prompt blobs.
- `src/types.ts` only models `toolChoice` as `"auto" | "none" | "required" | { name }`.
  `allowed_tools` is reduced to `"auto"` in `mapToolChoice()`, and `parallel_tool_calls` is parsed
  by the schema but not retained in `OcxRequestOptions`.
- `src/adapters/cursor/protobuf-events.ts` can enforce "no more than one synthetic client tool call"
  when `parallel_tool_calls === false`, but the state currently lacks that option.

## Plan

### MODIFY `src/types.ts`

- Extend `OcxRequestOptions.toolChoice` with:

```ts
| { mode: "auto" | "required"; allowedTools: string[] }
```

- Add:

```ts
parallelToolCalls?: boolean;
```

### MODIFY `src/responses/parser.ts`

- Update `mapToolChoice()`:
  - `allowed_tools` becomes `{ mode, allowedTools }`.
  - preserve only named tools; for namespace entries, use the declared name as the allowed wire name.
- Persist `data.parallel_tool_calls` into `options.parallelToolCalls`.
- Add parser tests if an existing test file already covers parser request options; otherwise extend
  the nearest request-builder/tool-definition tests with parsed fixtures.

### MODIFY `src/adapters/cursor/types.ts`

- Add `parallelToolCalls?: boolean` to `CursorRunRequest`.

### MODIFY `src/adapters/cursor/request-builder.ts`

- Serialize assistant tool calls instead of dropping them:

```text
[tool_call]
id: <call id>
name: <namespace wire name or name>
arguments: <JSON>
```

- Serialize tool results with pairing metadata:

```text
[tool_result]
call_id: <toolCallId>
name: <namespace wire name or name>
is_error: <true|false>
output:
<text>
```

- Preserve `parallelToolCalls` on `CursorRunRequest`.

### MODIFY `src/adapters/cursor/tool-definitions.ts`

- Apply `allowedTools` filtering in addition to existing `none` and forced-tool filtering.
- Matching accepts both raw tool names and wire names.

### MODIFY `src/adapters/cursor/live-transport.ts`

- Pass `parallelToolCalls` into `createCursorProtobufEventState()`.

### MODIFY `src/adapters/cursor/protobuf-events.ts`

- Track `startedClientToolCalls`.
- If `parallelToolCalls === false` and a second synthetic client tool call starts, emit an error.

### Tests

- `tests/cursor-request-builder.test.ts`
  - assistant toolCall and toolResult metadata survive Cursor request construction.
  - `parallelToolCalls` survives Cursor request construction.
- `tests/cursor-tool-definitions.test.ts`
  - `allowedTools` filters by raw and wire name.
- `tests/cursor-protobuf-events.test.ts`
  - `parallelToolCalls:false` rejects the second synthetic client tool call.
- Parser-level test where practical:
  - `allowed_tools` and `parallel_tool_calls:false` are retained from a Responses body.

## Verification

- `bun x tsc --noEmit`
- Focused Cursor/parser tests.
- `bun test`
- Independent Backend verifier with read-only source + tests review.

## Non-goals

- No live Cursor/native destructive smoke.
- No implementation of run suspension/resume for synthetic client tools arriving through
  `execServerMessage.mcpArgs`; that path remains fail-closed from Phase 43.
