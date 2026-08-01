# Break 3 — tool-result continuation shape

## Symptom

Tool-result-only continuation must resume the Cursor conversation without inventing a new
empty user message. The current action chooser derives the action from the last message
text.

Refs:
- `src/adapters/cursor/protobuf-request.ts:217-239`
- `src/adapters/cursor/protobuf-request.ts:190-200`

## Problem

For a continuation containing only `function_call_output`, the provider needs to express
"continue after this tool result" to Cursor. A blank `UserMessageAction` would be a fake
user turn; `resumeAction` is the correct action once the tool result has been placed in
conversation history.

The tool result also needs a stable identity bridge. Responses uses `call_id`; Cursor
history uses `toolCallId`. Relying on generated ids or positional matching makes the
second request fragile.

## Planned change

- Detect tool-result-only turns and send `resumeAction`.
- Store an explicit Responses `call_id` <-> Cursor `toolCallId` mapping in
  `providerMetadata`.
- On continuation, use that mapping to rebuild the Cursor tool-call/tool-result step
  instead of falling back to assistant text.
- Preserve normal `userMessageAction` behavior when the follow-up request includes real
  user/developer/tool text that should start a new user action.
