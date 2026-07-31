# WP1 — parseStream multi-call assembly (openai-chat)

## Scope
- MODIFY src/adapters/openai-chat.ts (parseStream only; buildRequest untouched this phase).
- NEW tests/openai-chat-parallel-stream.test.ts.
- OUT: request body, catalog, registry, history serialization.

## Design
Bridge contract requires non-overlapping start/delta/end sequences AND treats
text_delta/reasoning deltas as barriers that close an open tool-call item
(bridge.ts:394,452; deltas without an open call are dropped, bridge.ts:489).
Therefore: BUFFER ALL tool calls until flush. No call is emitted while the
stream is in flight; text/reasoning deltas pass through untouched; at flush,
each assembled call is emitted as an atomic start -> one args delta -> end
sequence in arrival order. (Audit round 1 blocker #1 killed the live-first-call
variant.)

State (replaces `currentToolCallId`/`currentToolCallName` strings):
```ts
interface PendingToolCall {
  key: string;            // "i:<index>" | "id:<id>" | "seq:<n>"
  id: string;             // provider id, may arrive late; synthesized at flush if absent
  name: string;           // may arrive late (vLLM/opencode ordering hazard)
  args: string;           // accumulated arguments
}
let toolCalls: PendingToolCall[] = [];   // arrival order
let toolCallSeq = 0;                     // synthesized id counter
```

Per delta entry `tc` in `delta.tool_calls`:
1. Resolve key: `typeof tc.index === "number" ? "i:"+tc.index : tc.id ? "id:"+tc.id
   : (last toolCalls entry?.key ?? "seq:"+toolCallSeq)`. Lookup in toolCalls; create if absent.
2. Merge fields: `if (tc.id) call.id ||= tc.id; if (tc.function?.name) call.name ||= tc.function.name;`
   (first value wins; providers resend full name/id on later chunks).
3. Arguments: `if (tc.function?.arguments) call.args += tc.function.arguments;` (buffer only).

Flush (`flushToolCalls()`), a generator called at every terminal site, replacing every
current `currentToolCallId` end-site 1:1 (parity with today's flush-then-terminal order):
- `[DONE]` payload handler (before `done`),
- inline `chunk.error` envelope (before `error` — partial args flush matches current
  partial-stream behavior),
- any non-empty `finish_reason` observed (covers "tool_calls" AND providers that say "stop"),
- reader-EOF residual path (before the sawFinish check / final `done`).
Per call in arrival order: `call.id ||= "call_" + (++toolCallSeq)`; emit
`tool_call_start {id, name: call.name}` (name may be "" — parity with current behavior,
see T7), one `tool_call_delta` with the full args (skip if empty), `tool_call_end`.
Clear toolCalls. Idempotent (no-op when empty). Double-flush is impossible: every caller
either terminates the generator or is followed only by `done`.

## Accept criteria / activation scenarios (C-ACTIVATION-GROUNDING-01)
- T1 interleaved: entries alternate index 0/1 with id+name on first chunk each, args
  fragments alternating -> two calls, each args JSON-parseable, zero cross-contamination.
- T2 standard sequential: id only on first chunk, continuation via index -> both calls correct.
- T3 whole-chunk (xAI): ONE chunk carrying two complete tool_calls entries -> two calls.
- T4 single-call regression: same call id/name and byte-identical assembled args as today;
  events arrive as one atomic sequence at flush (assert start/delta/end adjacency and
  correct ordering relative to the `done` event).
- T5 legacy no-index/no-id continuation -> appends to last call (current behavior parity).
- T6 name-late hazard: first chunk has index+id+args, name arrives on a later chunk ->
  single call emitted with the late-arriving name.
- T7 no-name-ever: id+args but name never arrives -> call flushed once with name ""
  (documented parity; proves emission, not silent drop).
- T8 text interleaved with tool-call deltas: text_delta events pass through mid-assembly
  and the call still flushes complete (bridge-barrier safety).
- Existing suite (openai-chat-eof, responses-stream-tool-events, adapter-usage) untouched green.
