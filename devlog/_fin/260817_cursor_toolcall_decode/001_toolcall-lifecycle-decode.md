# 001 — Tool-call lifecycle decode

Source: `src/adapters/cursor/protobuf-events.ts`. Verified by direct read plus
an independent `gpt-5.6-sol` audit, then corrected after an adversarial audit.

## The lifecycle

Cursor delivers a client tool call across several interaction updates, and the
adapter deliberately does **not** mirror them one-to-one downstream:

| Cursor update | Adapter action | Emitted downstream |
|---------------|----------------|--------------------|
| `toolCallStarted` (`:1249`) | `recordToolCall` opens the call | **nothing** (deferred) |
| `partialToolCall` (`:1254`) | `recordToolCall` if new, then `bufferToolArgs` on `argsTextDelta` | nothing |
| `toolCallDelta` (`:1265`) | **nothing** — returns `[]` | nothing |
| `toolCallCompleted` (`:1269`) | `resolveCompletedArgs` + `commitToolCall` | `tool_call_start` -> `tool_call_delta` -> `tool_call_end` |

**Correction (adversarial audit).** An earlier draft put argument buffering on
`toolCallDelta`. That branch returns `[]` by design: Cursor's typed deltas cover
native exec internals (shell/task/edit), while client Responses tools return as
`McpToolCall` plus partial args text. Buffering happens on `partialToolCall`,
which the original table omitted entirely.

The deferral is intentional and correct: Cursor can open several calls in
parallel or interleave their arg streams, while the Codex bridge tracks a single
current call. Emitting each completed call as one atomic unit serializes them
safely. The cost is that an **incomplete** call has emitted nothing at all, which
is what makes F1 (see `003`) invisible rather than merely wrong.

## Argument resolution

`resolveCompletedArgs` (`:354`) picks in order:

1. the structured protobuf map when it has bytes (canonical, schema-normalized);
2. otherwise buffered streamed text, normalized when it is complete JSON;
3. otherwise the buffered text **verbatim**.

Case 3 is deliberate: passing malformed text through lets the bridge reject it
(`bridge.ts:1070`) instead of silently converting truncated args into `{}` and
executing a tool with the wrong arguments. `argsTextDelta` is cumulative, so the
buffer keeps the longest value seen rather than concatenating.

## Error surfaces

`recordToolCall` returns an error for an un-advertised tool name (`:1103`) and
for exceeding `maxClientToolCalls` (`:1107`). `commitToolCall` returns an error
only for invalid freeform args (`:1160`) and invalid shell-bridge args (`:1163`).
A failed structured-edit conversion deliberately returns **text**, not an error
(`:1175`), keeping the turn alive.

Every `error` `CursorServerMessage` is turn-fatal downstream: it maps to
`AdapterEvent.error` (`message-mapper.ts:28`) and then `response.failed`
(`bridge.ts:1219`).

## Verdict

The lifecycle itself is sound. Two prior hypotheses were disproved here (see
`000`), and no change to this file is proposed for its own sake — `010` does not
modify it at all in the revised plan.

