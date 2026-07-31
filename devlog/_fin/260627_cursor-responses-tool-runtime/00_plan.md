# Cursor Responses Tool Runtime Stabilization Plan

## Context
- Goal branch: `cursor-provider-stack`.
- Current blocker: direct `/v1/responses` forced tool calls work, but real `codex exec --model cursor/composer-2.5` can stall/reconnect before Codex executes local tools.
- Codex tool-runtime reference confirms the expected contract: opencodex must emit valid Responses `function_call` / `custom_tool_call` / `tool_search_call` output items, then Codex core dispatches the local handlers and sends outputs back as next-turn input.

## Requirements
1. Preserve all incoming Responses `tools[]`, `tool_choice`, `allowed_tools`, and `parallel_tool_calls` behavior.
2. Do not execute Responses client tools locally as Cursor native MCP; only ACK synthetic Cursor native exec when it is acting as Cursor's continuation channel.
3. Stream function-call frames in the exact shape Codex expects, including `response.function_call_arguments.done.name`.
4. Once Cursor emits a client-owned tool call, suppress later assistant text and terminate on Cursor `turnEnded` so Codex enters its tool runtime promptly.
5. Inject opencodex into Codex using `127.0.0.1` to avoid localhost IPv6 connection noise against an IPv4-only listener.
6. Keep native Cursor exec/MCP executor behavior intact.

## Planned Changes

### MODIFY `src/adapters/cursor/live-transport.ts`
- Add a `terminalClientToolCall` flag.
- Set it after any synthetic Responses client tool events are emitted.
- After the flag is set, ignore further Cursor text/tool updates, emit `done` only on `interactionUpdate.turnEnded`, and close the Cursor session.
- Keep error behavior unchanged: client tool event errors still close immediately with `done` so the bridge can finalize a failed response.

### MODIFY `src/bridge.ts`
- Include `name` on `response.function_call_arguments.done` events.
- Allow terminal outcome reporting after internal stream close by removing `closed` from the `reportTerminal` guard; keep `clientCancelled` protection.

### MODIFY `src/codex-inject.ts`
- Change injected provider base URL and profile comment from `localhost` to `127.0.0.1`.
- Rationale: opencodex binds IPv4 loopback by default; Codex's HTTP client tries `::1` for `localhost` first, producing avoidable reconnect noise.

### MODIFY `tests/codex-inject.test.ts`
- Assert injected base URL/profile uses `127.0.0.1`.

### NO CHANGE `src/server.ts`
- Do not keep the debug-only `OPENCODEX_DEBUG_RESPONSES` logging patch from stash; it is useful locally but not production code.

## Verification
- Focused unit/contract tests:
  - `bun test tests/responses-stream-tool-events.test.ts tests/bridge.test.ts tests/cursor-tool-arg-decoding.test.ts tests/cursor-native-exec.test.ts tests/codex-inject.test.ts`
- Static gate:
  - `bun x tsc --noEmit`
- Live non-destructive checks:
  - restart opencodex with latest branch
  - direct streamed `/v1/responses` with `cursor/composer-2.5`, forced `ping`, assert `function_call_arguments.done` includes `name`, `response.completed` exists, `response.incomplete` absent
  - real `codex exec --model cursor/composer-2.5` with harmless `date` shell prompt; success means Codex executes at least one local shell tool and returns the date output

## Risk Notes
- If real Codex exec still stalls after these contract fixes, next investigation should capture the exact Codex request tool surface and compare Cursor behavior with a reduced tool list, without dropping support for tools globally.
- Do not run destructive Cursor native file/write/delete live tests.
