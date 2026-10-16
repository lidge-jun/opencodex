# 030 — Fix A: call_id single-line codec + response.in_progress (branch codex/cursor-gap-1)

Research: sol lane Curie (REPORT_DONE, 2026-08-26). Key facts:
- The newline join is UPSTREAM (Cursor sends composite ids inside protobuf
  call_id); local code forwards unchanged. protobuf-events.ts:1192/:1253,
  message-mapper.ts:20, bridge.ts:1079/:658.
- Round-trip consumers: parser.ts:569/:604/:692/:706/:288,
  protobuf-request.ts:678/:735/:576/:530, request-builder.ts:226/:434.
- response.in_progress never emitted: bridge.ts:1395 emits only
  response.created (status in_progress). responses-json-events.ts:12 same.
- response.heartbeat: typed event from bridge.ts:425/:1434, all bridged
  providers (not cursor-specific); grok client surface switches to SSE
  comments (core.ts:4692/:5648). No change needed for heartbeat.

## Diff plan

1. ADD src/adapters/cursor/call-id.ts — reversible codec: encode ids
   containing CR/LF to `ocx_cursor_v1_<uriencoded>`; decode both that
   form and legacy raw newline ids to the original composite.
2. EDIT src/adapters/cursor/message-mapper.ts:20 — encode
   tool_call_start/end ids at the Cursor->AdapterEvent boundary.
3. EDIT src/adapters/cursor/request-builder.ts — decode toolCall.id /
   toolResult.toolCallId before building messages + rawMessages so the
   wire sees the original composite id.
4. EDIT src/bridge.ts:1395 — emit response.in_progress right after
   response.created (same empty snapshot).

## Accept criteria

- No CR/LF in any Responses-visible call_id (unit + bridge test).
- Legacy newline call_ids still pair on replay (backward compat test).
- Stream begins created -> in_progress; exactly one in_progress.
- Tests: cursor-message-mapper, cursor-blob (pairing), bridge-lifecycle,
  responses-stream-tool-events. Focused bun test + typecheck green.
