# Verification gates

Run after the implementation pass.

## Local checks

- `bunx tsc --noEmit` clean.
- Targeted cursor/protobuf/request-builder/responses-state tests green.
- Add or update focused regression coverage for:
  - no synthetic `mcpResult` after Responses client-tool `mcpArgs`;
  - stored Cursor `conversationId` survives a `function_call` response;
  - `previous_response_id` is not used as a Cursor conversation id;
  - tool-result-only continuation sends `resumeAction`;
  - Responses `call_id` maps back to Cursor `toolCallId`.

## External audit

- gpt-5.5 subagent verification on the final diff.
- Confirm the audit agrees this pass implements stateless multi-turn continuation only.

## Out of scope

Full native same-stream Cursor tool round-trip still requires a separate stateful
live-bridge design that keeps an `ActiveBridge`/open h2 stream and injects `mcpResult`
after the later Responses tool output. That option is intentionally not part of this
track.
