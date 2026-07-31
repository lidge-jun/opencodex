# GPT Pro review prompt — Cursor Responses API tool-call bridge

Please review this opencodex Cursor provider tool-call plan for gaps before implementation.

Repository:
https://github.com/lidge-jun/opencodex/tree/dev

Current pushed branch/commit at time of prompt:
`dev` at `62a41aa`

Problem:
When opencodex routes Codex through the Cursor provider, model tool calls are always zero.
In this normal ChatGPT/Codex session tool calls work, so the bug is Cursor-provider-specific.

RCA evidence from local code:

1. Incoming Responses API tools are parsed into `parsed.context.tools`.
   - `src/responses/parser.ts` lines around 351-364 build `context.tools`.
2. Cursor request builder drops those tools.
   - `src/adapters/cursor/request-builder.ts` creates `CursorRunRequest` with only
     `modelId`, `conversationId`, `system`, and `messages`.
   - `src/adapters/cursor/types.ts` has no `tools` or `toolChoice` on `CursorRunRequest`.
   - `rg "parsed.context.tools" src/adapters/cursor` has no matches.
3. Cursor protobuf event mapper drops Cursor tool-call updates.
   - `src/adapters/cursor/protobuf-events.ts` only handles `textDelta`,
     `thinkingDelta`, `tokenDelta`, and `turnEnded`.
   - Generated protobuf has `partialToolCall`, `toolCallDelta`, `toolCallStarted`,
     and `toolCallCompleted` under `InteractionUpdate`.
4. Previous work implemented real MCP native exec once Cursor sends `mcpArgs`, but this
   does not make ordinary Codex client tools visible to Cursor.

Planned patches:

Phase 42:
- Add `tools?: OcxTool[]` and `toolChoice?: ...` to `CursorRunRequest`.
- Preserve `parsed.context.tools` and `parsed.options.toolChoice` in `createCursorRequest`.
- Add `src/adapters/cursor/tool-definitions.ts` to convert `OcxTool` into Cursor
  `McpToolDefinition` using `namespacedToolName`.
- Merge those client tool definitions into `RequestContext.tools` alongside configured
  local MCP tool definitions.
- Add tests for request preservation and requestContext advertisement.

Phase 43:
- Extend Cursor protobuf event state with open tool-call tracking.
- Map `toolCallStarted`, `partialToolCall`, `toolCallDelta`, and `toolCallCompleted` into
  adapter `tool_call_start`, `tool_call_delta`, `tool_call_end`.
- Keep native exec and client function-call pathways separate.
- Add tests using generated protobuf schemas and bridge output.

Questions for you:

1. Is `RequestContext.tools: McpToolDefinition[]` the right field to advertise ordinary
   Responses API function tools to Cursor upstream, or is it semantically MCP-only?
2. If it is MCP-only, which generated Cursor protobuf field should carry generic client
   tool/function definitions?
3. How should `tool_choice` be represented, if at all, in Cursor AgentRunRequest or
   RequestContext?
4. Which generated `ToolCall` cases should be mapped back to Responses function calls,
   and which should remain native exec only?
5. Identify any correctness/security gaps in the plan before patching.

Please give a concrete patch plan with file paths and any blocking concerns.

