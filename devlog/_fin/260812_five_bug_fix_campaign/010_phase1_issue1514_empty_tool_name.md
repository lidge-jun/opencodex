# 010 — Phase 1 (#1514): never emit a tool call with an empty name

Depends on: nothing (foundation phase — it touches only the adapter's own
flush boundary and establishes the fail-closed pattern the later phases reuse).

## Scope

IN

- `src/adapters/openai-chat.ts` — `parseStream`'s `flushToolCalls`.
- `src/adapters/openai-chat.ts` — the buffered `parseResponse` tool-call
  validator (`:1157`). Added after audit blocker B8: that validator checks only
  `typeof name === "string"`, so a buffered `""` name is emitted today. The
  streamed defect is what #1514 reports, but shipping "never emit an unnamed
  tool call" while leaving the buffered twin open would invite the immediate
  follow-up report.
- `tests/` — one focused regression test file (extend the nearest existing
  openai-chat streaming test module rather than adding a new one if a suitable
  one exists).

OUT

- The nested `tool_calls` validation from #1325.
- The raw-EOF truncation rules.
- Any provider-specific branch keyed on `opencode-free` or `deepseek`.

Audit correction (B8): an earlier revision of this document claimed the
buffered path was already safe. It is not — it validates the *type* of `name`,
never its emptiness.

## Diff-level change map

### `src/adapters/openai-chat.ts`

Current:

```ts
const flushToolCalls = function* (): Generator<AdapterEvent> {
  for (const call of closeToolCalls()) {
    if (!call.id) call.id = `call_${++toolCallSeq}`;
    yield { type: "tool_call_start", id: call.id, name: call.name };
    if (call.args.length > 0) yield { type: "tool_call_delta", arguments: call.args };
    yield { type: "tool_call_end" };
  }
};
```

Target: convert the generator so that an unusable call terminates the turn
through the adapter error channel instead of being emitted.

```ts
// A streamed tool call is only usable once the upstream has named the function.
// #1325 established that a claimed-but-malformed call is terminal protocol
// corruption rather than droppable padding, and the same reasoning applies when
// the name never arrives: emitting `name: ""` hands the Codex tool-call contract
// a call it cannot dispatch, and dropping it silently can orphan the matching
// result on the next turn. The id is synthesizable because it is an opaque
// correlation handle; the name is not, because inventing one guesses at intent.
const flushToolCalls = function* (): Generator<AdapterEvent, "continue" | "terminate"> {
  for (const call of closeToolCalls()) {
    if (call.name.trim().length === 0) {
      debugProviderDiagnostic("openai-chat", "tool-call-unnamed", {
        hadId: call.id.length > 0,
        argsBytes: call.argsBytes,
      });
      yield unnamedToolCallEvent(pendingUsage);
      return "terminate";
    }
    if (!call.id) call.id = `call_${++toolCallSeq}`;
    yield { type: "tool_call_start", id: call.id, name: call.name };
    if (call.args.length > 0) yield { type: "tool_call_delta", arguments: call.args };
    yield { type: "tool_call_end" };
  }
  return "continue";
};
```

`closeToolCalls()` is called before the check, so budget reservations for every
pending call are released on the error path exactly as they are on the success
path — including the calls after the offending one, which the early `return`
skips emitting but which `closeToolCalls()` has already closed. The `finally`
block's second `closeToolCalls()` remains a no-op safety net.

A module-scope helper mirrors the existing `invalidToolCallsEvent`:

```ts
function unnamedToolCallEvent(usage: OcxUsage | undefined): Extract<AdapterEvent, { type: "error" }> {
  return {
    type: "error",
    ...(usage ? { usage } : {}),
    message: "upstream streamed a tool call without a function name — cannot dispatch",
  };
}
```

Confirmed by the reviewer against the real helper: `invalidToolCallsEvent`
carries exactly `type`, `message`, and optional `usage`, so the shape above
matches.

### Buffered validator (`parseResponse`, `:1157`)

Current:

```ts
if (typeof id !== "string" || typeof name !== "string" || typeof args !== "string") {
  return [invalidToolCallsEvent(usage)];
}
```

Target — reject a blank name through the same existing error, since a buffered
response that claims a tool call with no name is malformed in exactly the sense
that helper already describes:

```ts
if (typeof id !== "string" || typeof name !== "string" || typeof args !== "string" || name.trim().length === 0) {
  return [invalidToolCallsEvent(usage)];
}
```

Both snippets above use trimmed-length validation (audit R2-4): `!name` would
admit `"   "`, and a whitespace-only function name is no more dispatchable than
an empty one. Neither is a legitimate OpenAI tool-call shape.

### Existing test T7 encodes the old contract and must be updated

`tests/openai-chat-parallel-stream.test.ts:144` is titled *"T7: name never
arrives — call still flushed with empty name (parity, no silent drop)"* and
asserts `{ id: "anon", name: "", args: "{\"q\":1}" }`. Adding a new test while
leaving T7 in place would land a known-red suite.

T7 is updated rather than deleted, and the reasoning is recorded in the PR: the
invariant T7 protects is that **a claimed tool call never vanishes without a
trace**. The new behavior preserves that invariant and strengthens it — the call
does not vanish, it fails the turn loudly. Only the mechanism changes, from
"emit an unusable call" to "terminate with a named error". T6's late-arriving
name coverage is untouched, because a name that arrives in a later chunk is
exactly the case that must keep working.

### The three call sites

Each site currently does `yield* flushToolCalls();` and must now honor the
returned decision.

1. `[DONE]` frame — `handleDataLine`, currently:

```ts
if (payload === "[DONE]") {
  yield* flushToolCalls();
  const stopReason = stopReasonFor(finishReason);
  yield { type: "done", usage: pendingUsage, ...(stopReason ? { stopReason } : {}) };
  return "terminate";
}
```

becomes:

```ts
if (payload === "[DONE]") {
  if ((yield* flushToolCalls()) === "terminate") return "terminate";
  const stopReason = stopReasonFor(finishReason);
  yield { type: "done", usage: pendingUsage, ...(stopReason ? { stopReason } : {}) };
  return "terminate";
}
```

The `done` event must **not** be emitted after the error — a turn that already
reported an undispatchable tool call must not also report clean completion.

2. `finish_reason` on a choice:

```ts
if (typeof choice.finish_reason === "string" && choice.finish_reason) yield* flushToolCalls();
return "continue";
```

becomes:

```ts
if (typeof choice.finish_reason === "string" && choice.finish_reason) {
  if ((yield* flushToolCalls()) === "terminate") return "terminate";
}
return "continue";
```

3. Post-loop normal completion:

```ts
yield* flushToolCalls();
const stopReason = stopReasonFor(finishReason);
yield { type: "done", usage: pendingUsage, ...(stopReason ? { stopReason } : {}) };
```

becomes an early `return` on `"terminate"` before the `done` event, matching
site 1.

`handleDataLine` already returns `"continue" | "terminate"` and its callers
already `return` on `"terminate"`, so no caller-side plumbing changes.

## Interaction check with existing invariants

- **Raw EOF truncation (`!sawFinish && pendingToolCalls.length > 0`)** runs
  *before* the post-loop flush and is unchanged: a truncated stream still
  reports truncation, not the new unnamed-call error. The new error is reachable
  only when the stream *did* reach a terminal signal.
- **#1325 non-array / non-record `tool_calls`** still terminate earlier in
  `handleDataLine` and never reach the flush.
- **Orphaned results**: the failure is surfaced as a turn error, so no
  half-formed call is handed downstream to be paired later.

## Activation scenario (C-ACTIVATION-GROUNDING-01)

The new branch is triggered by driving `parseStream` with a synthetic SSE stream
whose `delta.tool_calls` entry carries `function.arguments` but never
`function.name`, terminated by `[DONE]`:

```
data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_x","function":{"arguments":"{\"a\":1}"}}]}}]}
data: [DONE]
```

Observable effect proving it ran: the event sequence contains an `error` event
whose message names the missing function name, contains **no** `tool_call_start`
event, and contains **no** `done` event.

Second activation at the `finish_reason` site: same delta followed by a chunk
with `"finish_reason":"tool_calls"` — same assertions.

Third site (post-loop) is **not** claimed as a distinct activation. Audit
blocker B9 correctly observed that raw EOF with pending calls exits through the
truncation branch first, so an unnamed call is not reachable there from a state
the system visits. That site is handled anyway because `yield* flushToolCalls()`
already runs there and ignoring its result would leave one escape path open;
this is defensive uniformity on an existing call, not a new branch with its own
trigger.

Buffered activation (B8): `parseResponse` over
`{"choices":[{"message":{"tool_calls":[{"id":"call_x","function":{"name":"","arguments":"{}"}}]}}]}`
→ the returned events are the existing invalid-tool-calls error, with no
`tool_call_start`.

## Accept criteria

1. Unnamed streamed tool call terminated by `[DONE]` → error, no
   `tool_call_start`, no `done`. (Red before the change.)
2. Unnamed streamed tool call terminated by `finish_reason` → same.
3. A **named** tool call still emits `tool_call_start` / `tool_call_delta` /
   `tool_call_end` / `done` exactly as before, including the id-synthesis path
   when `id` is absent. (Guards against over-broad rejection.)
4. A stream with pending tool calls and no terminal signal still produces the
   existing truncation error, not the new one.
5. A non-array `delta.tool_calls` still produces the #1325 error.
6. Buffered response with an empty `function.name` produces the invalid
   tool-calls error and no `tool_call_start`. (Red before the change.)
7. Buffered response with a valid name is unchanged.
8. A whitespace-only name (`"   "`) is rejected on both paths.
9. T7 is updated to the terminal-error contract and passes; T6 still passes
   unchanged.
10. `bun run typecheck` exit code 0.
11. Existing openai-chat adapter suites green on `ssh lidge`, including
    `tests/openai-chat-parallel-stream.test.ts` and `tests/openai-chat-eof.test.ts`.

## Verification commands

```bash
bun x tsc --noEmit
bun test tests/openai-chat*.test.ts tests/adapter*.test.ts
```

Exact file globs are resolved in B against the real `tests/` listing.

## Delivery

Branch `codex/1514-unnamed-tool-call`, PR against `dev`, template filled,
`Closes #1514`.
