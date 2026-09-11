# 010 — #4191: classify the WebSocket failure instead of restating it

Unit: `devlog/_plan/260911_l6_streaming_tools`. Lane L6, work-phase 1.
Issue: [#4191](https://github.com/lidge-jun/opencodex/issues/4191).

## What the report actually contains

A long Codex thread failed for hours through the proxy and recovered instantly when the
proxy was bypassed — same account, model, machine, repository and thread. Two messages
appeared, alternating:

    codex websocket closed before a Responses terminal event (close 1006 Connection ended)
    codex websocket response prelude timed out

Neither sentence distinguishes the cases it is true of. The reporter compensated by running
an A/B toggle by hand, which is why the only usable evidence in a very careful report is
"it works when OpenCodex is off". That is the defect this work-phase addresses.

## Where the prelude budget goes

Read `codex-ws-exchange.ts` at the frozen base: `preludeTimer` is armed once in `onOpen`
immediately after `ws.send()` succeeds, and the only thing that clears it is
`commitResponse()`. `commitResponse()` runs from `onMessage` only on the **non-control**
branch — a frame the metadata channel did not claim. `codex.rate_limits` and
`codex.response.metadata` are claimed by `CodexWsMetadata.consume()` and set
`controlFrame = true`, so they never reach it.

So the 90 s budget is measured from send to the first *Responses* event, and upstream
liveness does not extend it. A socket that answers in 40 ms with a quota frame, then keeps
sending quota updates while the backend works through a very large replayed thread, still
dies at exactly 90 s — and reports the same sentence as a socket that was never answered at
all. That is the mechanism the report's second error most likely describes, and before this
change nothing in the message could tell the two apart.

The size story is next to it. `codexWsCreateFrameExceedsLimit` preflights the create frame
at 16 MiB − 64 KiB and routes an oversized turn to HTTP SSE, so the very largest threads are
already safe. The band immediately below the limit is not: it still dials the socket, and a
long full-replay thread sits in that band. Whether this reporter's thread was there is not
knowable from the report, which is precisely why the create-frame byte count belongs in the
message.

## What was implemented

A content-free stage record, `CodexWsFailureStage` in `codex-ws-wire.ts`, carrying the
create-frame byte count, whether the send completed, the number of upstream frames, how many
of those the metadata channel claimed, how many Responses events were relayed downstream,
and two durations — send to first frame, and send to failure. `classifyCodexWsFailure`
reduces that to one of four causes: `before-send`, `no-upstream-frame`,
`no-response-event`, `after-response-started`. `codexWsFailureDetail` renders it as a
suffix appended after the existing message, including after the close-code tail, so
`(close 1006 Connection ended)` remains one contiguous substring for every existing reader.

`codex-ws-exchange.ts` keeps the counters and stamps `sentAt` after a successful send. The
frame is measured lazily, only when a failure message is being built, so the happy path never
pays for sizing a multi-megabyte string. The three paths that end an already-open exchange
without a terminal event now carry the detail: the prelude timeout, the close-before-terminal
message, and the transport error. The size- and queue-limit failures already name their own
precise cause and were left alone.

The reporter asked for five diagnostics. Four are now in the message the client receives:
serialized frame size, whether the send completed, elapsed time to the first upstream event
and to the failure, and whether any downstream Responses bytes were emitted. The fifth —
preserving the upstream close code — was already there and is unchanged.

## Deliberately not implemented

The issue and its two maintainer comments leave three things open. All three come back as a
report, per the lane packet.

**Automatic HTTP/SSE fallback after an open socket dies.** `failStream` treats a completed
send as possibly executing upstream, and settles as a body failure rather than a resendable
rejection. The maintainer comment on the issue is explicit that `responseCommitted === false`
and zero downstream bytes are *not* proof the upstream did not accept or execute the frame,
so a resend gated on either can duplicate a turn. The classification added here must not be
read as a fallback-eligibility signal; the type comment says so at the definition, because
`no-upstream-frame` is exactly the value a future reader would be tempted to misuse.

**A configurable or longer prelude budget.** #3976 asked for this and 90 s is already three
times the original 30 s. Raising a fixed constant without a reproduction is guesswork, and
the finding above suggests the real question is different: whether upstream liveness on the
control channel should extend the budget at all, or whether a thread that produces only quota
frames for 90 s should be refused earlier and more clearly. Both are policy, and no issue has
fixed that policy.

**A size preflight below the current ceiling.** The band under 16 MiB − 64 KiB is a real gap,
but narrowing WS eligibility by predicted frame size or expected time-to-first-token changes
which turns take which transport for every user, not only failing ones. It needs its own
issue with measurements, and the byte count now in the failure message is what would supply
them.

## Verification

Focused regression test at `tests/responses/ws-failure-stage.test.ts`, registered in
`scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`. It covers
the classifier's four stages, the renderer's exact output, the contiguity of the close-code
tail that existing assertions depend on, and four end-to-end cases through the fake socket:
an unanswered close, a quota-only close, a close after relayed events, and the prelude
timeout under fake timers.

Local suite, typecheck and build: NOT RUN, by operator instruction for this dispatch round.
Hosted CI on the pushed head is the evidence.

