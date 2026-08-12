# Phase 090 — synthetic failed tail inside the eager producer (wp4)

Depends on 080 (080 adds the inspector `dispose()` hook invoked from the eager
producer `finally`; audit round 1 blocker 8c). Design base:
`052_single_reader_gap.md` §Gap 3 sketch. Targets:
`src/server/relay-eager.ts` AND `src/server/relay.ts` (the shared serializer
extraction + `relaySseWithFailedTail` refactor live in relay.ts — wp4 A-gate
correction), plus tests. Schema evidence (Luna lane,
platform docs): terminal `response.failed` carries `status:"failed"` and a
populated `error {code,message}`; the existing tee-path tail in
`relaySseWithFailedTail` (`relay.ts:86` post-wp3; payload at `:102-115`)
already emits a compatible envelope —
the eager tail reuses those exact bytes for parity.

Post-wp3 anchors (A-gate refresh): eager producer catch `relay-eager.ts:156-162`;
teardown `finally` `:163-176` with the condition
`cancelled || upstream.signal.aborted` at `:168`. wp3 added optional
`onClientGone` ownership to `relaySseWithFailedTail` (cancel branch `:89`,
`:120-123`) — the serializer refactor must preserve that signature and cancel
behavior exactly.

## Change

In the producer `catch` block (`relay-eager.ts:156-162` today):

- Capture `err`. When `!hooks.sawTerminal() && !cancelled &&
  !upstream.signal.aborted`:
  1. Build the payload via ONE shared capped serializer exported from
     `relay.ts` — `buildFailedTailPayload(err)` with
     `MAX_TAIL_ERROR_MESSAGE_CHARS = 512` — and REFACTOR
     `relaySseWithFailedTail` to use the same function (R2-3: parity by
     construction; the legacy path gains the cap in the same commit, and the
     long-message truncation is tested on both paths).
  2. Enqueue `\n\nevent: response.failed\ndata: <payload>\n\ndata: [DONE]\n\n`
     via `controllerRef.enqueue` (charge `queuedBytes`), then `close()` the
     client stream instead of erroring it.
  3. Keep `syntheticKind = "failed"` so `onSynthetic("failed")` still fires
     exactly once in `finally` (accounting unchanged).
  4. Do NOT feed the tail through `hooks.inspectChunk` — the inspector records
     the reset via the synthetic path, mirroring the tee topology.
- If enqueue/close throws (client already torn down), swallow — `finally`
  teardown already aborts upstream/cancels the reader.
- **Teardown extension (R2-3):** the current `finally` aborts upstream and
  cancels the reader only when `cancelled || upstream.signal.aborted`
  (relay-eager.ts:166-169). The producer-failure path satisfies neither.
  Extend the condition so a synthetic-failed close ALSO aborts upstream and
  cancels the (exhausted/errored) reader — making test 9 satisfiable.
- Leading `\n\n` stays: raw partial event bytes may already have reached the
  client on this no-rewrite path; the delimiter closes the partial block.

## Not changed

- Cancel/drain, incomplete, and pause/wake logic untouched (teardown gains
  the producer-failure branch above; nothing else changes).
- No new wrapper stream — the tail is inline in the single producer
  (052 risk table: wrapping eager output would recreate the #32111 shape).

## Regression tests (`tests/relay-eager.test.ts` near existing eager tests)

1. Mid-stream reader failure → client receives previously relayed bytes +
   delimiter + `response.failed` frame + `[DONE]`, stream CLOSES cleanly (no
   error), `onSynthetic("failed")` fired once.
2. Failure after `sawTerminal()` true → no tail, no duplicate terminal.
3. Failure after client cancel → no tail enqueued, cancel accounting
   unchanged.
4. Upstream-abort teardown (shutdown) → no tail (existing M3 contract).
5. Error message longer than cap → tail message truncated, frame parses as
   JSON.
6. Reset before ANY bytes reached the client → tail is the only client
   payload and parses standalone (leading delimiter harmless).
7. Concurrent cancel/reset race (cancel fires while the failing read is in
   flight) → no tail, exactly one accounting outcome.
8. Exactly-one-terminal/one-`[DONE]`: for a single mid-stream reset, the
   client byte stream contains precisely one `response.failed` frame and one
   `[DONE]`, `onSynthetic("failed")` fires exactly once, and lifecycle
   (`onDone`) completes. (A single producer catches one rejected read and
   enters `finally`; "repeated producer errors" is not a realizable shape —
   A-gate correction.)
9. Teardown: upstream aborted and reader cancelled after the tail is emitted.
10. Byte parity: tail bytes are identical to `relaySseWithFailedTail`'s tail
    for the same error message — both call `buildFailedTailPayload` (byte
    -compare test for an in-cap message and for a truncated long message on
    both paths).

## Commit

`fix(relay-eager): emit the synthetic response.failed tail inline on mid-stream reset`
