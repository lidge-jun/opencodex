# Break 1 — synthetic tool ack

## Symptom

Cursor asks for a Responses client tool via native `execServerMessage.mcpArgs`. The
adapter maps it into Responses `function_call` events, then immediately sends Cursor a
synthetic empty `McpSuccess`.

Refs:
- `src/adapters/cursor/live-transport.ts:292-309`
- `src/adapters/cursor/native-exec.ts:102-105`

## Problem

`McpSuccess(content: [])` is not "pending". It means the tool completed successfully with
empty output. Cursor can end the turn on that empty result before Codex has run the real
client tool.

This is the opposite of the required stateless continuation shape: Run #1 should expose
the function call to Responses and stop locally without sending Cursor any fake native
tool result.

## Planned change

- Remove `syntheticResponsesToolAck`.
- After successful `mcpArgs` -> Responses `function_call` emission, end/close the local
  Cursor run as a suspension boundary.
- Keep the existing error terminal behavior for invalid client-tool events.
- Do not add any `mcpResult` placeholder to Cursor for the stateless path.
