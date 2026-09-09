# 001 — consumer-backlog turn abort RCA (research)

Incident: 2026-08-28 ~01:55 KST, Codex app turn (branch-cleanup thread) routed
through local proxy (xai/grok-4.6) died after repeated "Reconnecting /5" with
"stream disconnected before completion: consumer backlog exceeded — turn
aborted". Long turn (~12 min "Worked for 12m 21s"), many gh/git tool rounds.

## Verified mechanism (sol-high audit, file:line checked)

Producer/consumer chain: runTurnAdapter.runTurn(..., queue.push) ->
queue.stream() -> preflight (core.ts:4696-4709) -> empty-completion
guard/observer (core.ts:4711-4727) -> bridgeToResponsesSSE (bridge.ts:857-876;
HWM=1 documented at bridge.ts:1404-1410, demand-driven stepping happens in
pull() at bridge.ts:1465-1467) -> trackStreamLifetime (lifecycle.ts:439-449)
-> request-log wrapper (relay.ts:620-638) -> CORS Response -> Bun HTTP.
(Anchors re-verified by A-gate round 1; bridge stepping anchor corrected.)

- guardTerminalEventStream is NOT on the runTurn path (only generic
  fetch/parse path, core.ts:5648-5676).
- Cancellation: req.signal -> options.abortSignal (server/index.ts:1412-1418)
  -> linkAbortSignal(runTurnAbort, ...) (core.ts:4535-4539); body cancel chain
  relay.ts:633 -> lifecycle.ts:450 -> bridge.ts:1468-1477 -> onCancel aborts
  runTurnAbort + closes queue (core.ts:4728-4733). Correct once Bun OBSERVES
  the disconnect.
- Failure window: Bun reports a dead/reconnecting TCP consumer late (observed
  1-10s+, structure/04_transports-and-sidecars.md:620-624; app reconnect
  storms can extend this). During that window the pull-driven bridge stops
  consuming (that is by design), the producer keeps pushing token-granular
  text/thinking deltas + heartbeats, and the queue hits maxBacklog=1024
  (run-turn-queue.ts:67-80) -> onBacklogExceeded -> runTurnAbort.abort() ->
  synthetic terminal error that misattributes a CLIENT-side stall as a
  provider/turn failure.

## Root cause statement

The 1024-event cap conflates two states it cannot distinguish: (a) a slow but
attached consumer (cap = legitimate safety valve) and (b) a detached/
reconnecting consumer whose disconnect Bun has not yet delivered (cap = false
abort with a fabricated adapter error). Event-count granularity (per-token
deltas + heartbeats both count) makes (b) reachable within seconds on a
healthy turn.

## Fix directions (audited; chosen mix in 010)

1. PRIMARY: coalesce adjacent text_delta/thinking_delta and collapse pending
   heartbeats at queue push time — bound the backlog by useful buffered work,
   preserving phase boundaries, tool events, signatures, terminal ordering.
2. SECONDARY: on backlog trip, classify honestly — the consumer never read
   the synthetic error anyway when detached; keep abort as safety valve but
   the message/log should say consumer stalled, and detected body-cancel
   must keep aborting promptly (existing chain, regression-guarded).
3. Rejected as primary: raising the cap alone (masks the race, more memory).

## Existing coverage

tests/run-turn-queue.test.ts:62-169 (overflow, ordering, preflight,
cancellation); tests/abort-race.test.ts:45-192 (overflow aborts signal in
buffered mode; explicit abort before late reader; terminal-continuation body
cancel). MISSING: streaming body left unread then cancelled; >1024 tiny
deltas with slow-but-attached consumer; coalescing semantics.
