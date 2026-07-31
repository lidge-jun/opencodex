# Phase 46 - Responses Tool Continuation Evidence

Date: 2026-06-27

## Problem

Cursor-routed Codex sessions could surface first-turn Responses tools, but the bridge still had two production blockers:

- Cursor sometimes emitted client-owned Responses tools through `execServerMessage.mcpArgs`, where closing the stream after the first tool prevented multi-tool turns.
- Follow-up `previous_response_id + function_call_output[]` requests did not preserve prior assistant tool calls and tool results as Cursor-native conversation state, so continuation could hang or lose context.

## References Checked

- `/tmp/opencode-cursor/docs/architecture/runtime-tool-loop.md`: confirms the provider-boundary pattern where tool calls are surfaced to the client and tool results return on the next turn.
- `/private/tmp/Cursor-To-OpenAI/src/routes/v1.js` and `/private/tmp/Cursor-To-OpenAI/src/utils/utils.js`: older `StreamUnifiedChatWithTools` text-only bridge; useful for framing/header comparison but not for AgentService/Run tool continuation.
- `/Users/jun/Developer/codex/003_tool-runtime/03_co_tool.md`: Codex tool runtime treats tool calls as `ResponseItem` -> `ToolCall` -> registry execution -> `ResponseInputItem` result loop, so preserving prior tool metadata is required.

## Implementation

- `src/adapters/cursor/live-transport.ts` now ACKs synthetic Responses `mcpArgs` after surfacing them, allowing Cursor to continue emitting additional client tool calls in one turn without executing local MCP.
- `src/adapters/cursor/protobuf-events.ts` tracks completed tool call IDs to avoid duplicate emission from `interactionUpdate` plus native exec paths.
- `src/responses/state.ts` stores completed Responses output and expands later `previous_response_id` requests with prior input/output, but avoids reusing Cursor server conversation IDs after client-tool responses because synthetic ACKs intentionally diverge from true client execution state.
- `src/adapters/cursor/protobuf-request.ts` serializes prior assistant tool calls and paired tool results into Cursor `ConversationStep.toolCall` with `McpToolCall.args` and `McpToolCall.result`, while still sending trailing tool-result text as the current action for Cursor compatibility.

## Verification

- `bun x tsc --noEmit` -> pass.
- `bun test` -> `557 pass / 0 fail`, `3708 expect() calls`, `71 files`.
- `git diff --check` -> pass.
- Live non-destructive smoke with `cursor/composer-2.5`:
  - First `/v1/responses` request with 10 advertised `ping_*` tools returned HTTP 200 and exactly 10 `function_call` outputs: `ping_1` through `ping_10`.
  - Second `/v1/responses` request with `previous_response_id` and 10 `function_call_output` items returned HTTP 200 and recognized the completed ping sequence.

