# 005 - Hardening pass on the mcp_tools fix

HOTL cxc-loop, sol reviewer (Heisenberg). Goal: make commit 80b510f5
production-safe.

## sol A-gate audit: GO-WITH-FIXES (1 blocker folded)

BLOCKER (folded): mcp_tools was built from raw `request.tools`, while
RequestContext.tools (live-transport.ts:416-417) and the event-state
`clientToolNames` (live-transport.ts:430-434) are built from the
`cursorToolsForActivePrompt(...)`-filtered set. For a generic tool-count-demo
prompt that narrows the client tools to bare `exec_command`, mcp_tools would
still advertise the non-exec tools; a model call to one of those would be
rejected as an unknown Responses tool (protobuf-events.ts:158-163).

FIX: `encodeCursorRunRequest` now builds mcp_tools from the same
`cursorToolsForActivePrompt(request.tools, activePromptText(request),
request.toolChoice)` visible set, so both channels + the event-state names stay
consistent.

Non-blocking findings (confirmed, no change needed):
- No double execution: a returned client tool call is surfaced once and
  deduped by call id (`completedToolCalls`, protobuf-events.ts:131/159/245);
  OCX_RESPONSES mcpArgs is intercepted by the Responses bridge, not run locally.
- Wire shape correct: `create(McpToolsSchema, { mcpTools: defs })` matches
  `McpTools.mcp_tools = repeated McpToolDefinition`.
- `toolChoice:"none"` and empty tools both yield `[]` -> mcpTools stays unset.
- Perf: negligible (small sync filter/map + encode).

## Regression tests added (tests/cursor-blob.test.ts, "Cursor AgentRunRequest.mcp_tools channel")

1. normal prompt -> mcp_tools = ["mcp__node_repl__js"].
2. generic tool-count prompt ("use any 3 tools") with exec_command + a non-exec
   tool -> mcp_tools = ["exec_command"] (filter consistency; the blocker's test).
3. empty tools -> mcpTools unset.
4. toolChoice "none" -> mcpTools unset.

## Verification

- `bunx tsc --noEmit` exit 0.
- `bun test tests/cursor-blob.test.ts` 13 pass; full `bun test tests/cursor-*.test.ts`
  265 pass / 0 fail (was 261; +4 new).
- Live proxy (10100) untouched; no live Cursor probe spent this phase.

## Outcome: DONE

Fix hardened: channel-consistency defect fixed, edge cases locked by tests, sol
reviewed. Committed on the branch.
