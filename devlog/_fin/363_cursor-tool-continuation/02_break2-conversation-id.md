# Break 2 — conversationId preservation

## Symptom

The response state intentionally omits Cursor `conversationId` when a response contains a
client `function_call`.

Refs:
- `src/responses/state.ts:64-70`
- `src/adapters/cursor/request-builder.ts:81-85`

## Problem

The guard protects against reusing a bad Cursor checkpoint, but it also drops the only
real Cursor conversation handle needed by the next tool-result request. The fallback to
`previous_response_id` is also wrong: `resp_*` is a Responses id, not a Cursor
conversation id.

Result: the continuation can start a fresh Cursor conversation or use an invalid id
instead of resuming the real one.

## Planned change

- Preserve the Cursor `conversationId` even when the response output includes a
  `function_call`.
- Split checkpoint reuse from conversation reuse with a dedicated
  `cursorCheckpointUsable` flag.
- Keep checkpoint reuse disabled for the problematic client-tool-call response.
- Remove `parsed.previousResponseId` as a Cursor `conversationId` fallback; use only the
  stored Cursor id or a newly generated Cursor id.
