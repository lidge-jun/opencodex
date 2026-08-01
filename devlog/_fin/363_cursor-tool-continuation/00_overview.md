# 363 — Cursor client-tool continuation

Goal: make Cursor-provider Responses client-tool turns continue as structured multi-turn
history instead of ending on a fake empty native result or losing the Cursor conversation.

## Investigation conclusion

Cursor `mcpArgs` cannot be round-tripped as a native pending-tool result by a truly
stateless Responses proxy. Cursor's MCP exec protocol is synchronous on the live h2
stream: `McpResult` is terminal, `resumeAction` is not a semantic substitute for a
pending tool result, and the observed native implementations reply `mcpResult` on the
same live stream.

Sources:
- jawcode/gjc local refs in the adjacent Cursor investigations.
- Web/local repo research: `https://github.com/lidge-jun/opencodex`,
  `https://github.com/ephraimduncan/opencode-cursor`,
  `https://github.com/shyndman/danger-pi`.
- GPT Pro transcript:
  `/Users/jun/.browser-agent/sessions/01KWA5NZWGS10S03M496MRRXDN/artifacts/transcript.md`.

Kiro works statelessly because its API has a first-class next-request tool result path
(`userInputMessageContext.toolResults`). Cursor has no equivalent path. The only native
same-stream solution is a separate stateful live bridge that keeps the Cursor run open
and injects `mcpResult` later; that is explicitly out of scope for this pass.

## Fix direction

Keep the provider stateless and make continuation work as history:

1. Cursor Run #1 emits a Responses `function_call` from `mcpArgs`.
2. Run #1 terminates locally with no fake `mcpResult` written back to Cursor.
3. The next Responses request carries the `function_call_output`.
4. Cursor Run #2 reuses the real Cursor `conversationId`, sends tool-result history, and
   continues with `resumeAction` when there is no new user text.

## Corrections

### 1. Remove synthetic Responses tool ack

Current interception emits Responses tool-call events from `mcpArgs`, then writes a fake
empty `McpSuccess` back to Cursor:
- `src/adapters/cursor/live-transport.ts:292-309`
- `src/adapters/cursor/native-exec.ts:102-105`

That makes Cursor treat the client tool as successfully completed with empty output, so
the turn ends before Codex can provide the real tool result. Planned change: delete the
fake ack path and close/suspend the local stream after emitting the function call.

### 2. Preserve conversationId, separate checkpoint usability

Current response-state storage drops `conversationId` whenever the output contains a
client tool call:
- `src/responses/state.ts:64-70`

That prevents the follow-up tool-result request from using the same Cursor conversation.
Planned change: remember the Cursor `conversationId` even on `function_call` responses,
but add a separate `cursorCheckpointUsable` flag so the existing "do not reuse the bad
Cursor checkpoint" defense remains intact.

Also stop treating `previous_response_id` (`resp_*`) as a Cursor conversation fallback:
- `src/adapters/cursor/request-builder.ts:81-85`

### 3. Resume tool-result-only turns and map call ids explicitly

Tool-result-only continuations should send Cursor a `resumeAction`, not an empty
`UserMessageAction`. The relevant request path is:
- `src/adapters/cursor/protobuf-request.ts:217-239`

Tool outputs must also carry an explicit Responses `call_id` <-> Cursor `toolCallId`
mapping in provider metadata, then rebuild Cursor history through the existing
tool-call/tool-result turn path:
- `src/adapters/cursor/protobuf-request.ts:190-200`

## Verification

See `04_verification.md`.

## Outcome (commit 46df4d6)

Implemented all three breaks; gpt-5.5 subagent (Herschel) verified PASS.

- break1: removed `syntheticResponsesToolAck` (deleted helper + import + unit test). The
  mcpArgs branch in live-transport.ts now surfaces the tool_call to Codex and returns
  WITHOUT writing any mcpResult — honest suspension. The fail-closed "bridge suspension
  not implemented" McpError path in native-exec.ts stays as defense.
- break2: state.ts now always stores conversationId and sets `cursorCheckpointUsable`
  (false when a function_call is in the output — the Cursor checkpoint isn't safe to
  reuse, but the conversation id string is). request-builder.ts conversationId is
  `_cursorConversationId ?? generatedCursorConversationId()` — the `resp_*` fallback
  is gone.
- break3: protobuf-request.ts uses `ResumeAction` when the last raw message is a
  toolResult (was `UserMessageAction` re-injecting tool result text). call_id mapping is
  already consistent end-to-end (Cursor callId -> Responses call_id -> parser part.id ->
  toolCallStep toolCallId), no new metadata needed.

Tests: tsc clean; targeted suites (cursor-protobuf-events, cursor-native-exec,
cursor-live-transport, cursor-request-builder, responses-state, cursor-blob) 52/0.
Full `bun test`: 1664 pass, 71 fail / 13 errors — all pre-existing and unrelated
(logger env, cli hook install, cursor-agent CLI pool, stream-json fixtures).

## Out of scope (explicit)

Native full round-trip (Cursor receives a REAL mcpResult for the pending mcpArgs on the
SAME stream) requires a stateful live-bridge that holds the Cursor h2 stream open across
requests and injects mcpResult when the upstream Codex returns the tool output — the
opencode-cursor `ActiveBridge` pattern. That is a separate, larger architectural change
and is NOT part of this pass. This pass makes the stateless multi-turn continuation
behave correctly (structured history, preserved conversation id, honest termination) so
tool calling works in practice; the stateful option remains available if native
round-trip fidelity is later required.
