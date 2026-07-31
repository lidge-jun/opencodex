# 260711 - Cursor routing x Browser plugin: root cause

## Symptom
On a Cursor-routed model, @Browser / "open Google and operate it" fails. File
read/write now works (earlier fix: providers.cursor.unsafeAllowNativeLocalExec=true
opens all native local-exec cases). So this is a DIFFERENT mechanism.

## Mechanism map (code read)
The Browser plugin is not a set of dedicated tools; it is driven through the CLIENT
MCP tool mcp__node_repl__js (runs browser-client.mjs). For a Cursor-routed model to
use it, opencodex must let the Cursor model invoke a client Responses/MCP tool
(providerIdentifier OCX_RESPONSES_TOOL_PROVIDER) and return its result.

Two possible paths inside src/adapters/cursor:
- Streamed tool_call: Cursor emits an interaction toolCall; protobuf-events.ts surfaces
  tool_call_start/delta; Codex executes locally; result returns on the next request.
- Native mcpArgs: Cursor's server wants to run the MCP tool synchronously. For
  OCX_RESPONSES_TOOL_PROVIDER, planMcpArgsHandling (live-transport.ts:137) surfaces it
  as tool_call events, ends turn 1 done, and expects the real result on the NEXT
  /v1/responses request. native-exec.ts:168 / native-exec-tools.ts:38 are fallback
  errors ("bridge suspension not implemented") that should not normally fire.

clientToolDefs are advertised at live-transport.ts:417 (buildCursorToolDefinitions).
Open question: are client MCP tools like mcp__node_repl__js actually advertised to
Cursor, or filtered out? If never advertised, the model cannot call the browser at all.

## Repro design (WP1)
Provider debug is ON. Spawn a cursor/gpt-5.6-luna subagent and have it:
1. call the client MCP tool mcp__node_repl__js with a trivial script (nodeRepl.write),
2. attempt the Browser plugin bootstrap (open a page),
and report verbatim: tool name used, SUCCESS/FAILURE, exact result/error.
Then read /api/debug/logs frames to classify the path: streamed toolCall (works),
mcpArgs OCX_RESPONSES (turn-1-done bridge), or tool-not-advertised.

## Root-cause classes (WP1 output)
proxy-bridge-gap | tool-advertisement-gap | cursor-protocol-limitation | model-behavior.

## Scope
IN: src/adapters/cursor/**, tests/**, this devlog, ~/.opencodex config only if a
provider setting is the fix. OUT: other session's dirty files (gui/**, docs-site/**,
src/server/management-api.ts, tests/claude-management-api.test.ts, src/claude/**),
no release, no proxy restart. Keep earlier cursor nativeLocalExec policy intact.
