# 110 — Inbound stream-health watchdog (T04, senpi #1062 second half)

## Why now

OpenCodex issue #2210 reports Cursor/Grok turns dying with
`upstream_stall_timeout` after a silent stream — the 300s bridge default
(`src/stall-timeout.ts:8`) is the only guard after the first frame. senpi
PR #1062 pairs the turnEnded close (already landed as #2321) with an
inbound-frame watchdog we did NOT take: 30s of total inbound silence, or 90s
of heartbeat/checkpoint-only traffic, fails the turn instead of waiting for
the bridge.

## Current state (verified 525568652)

- `live-transport.ts:93` `CURSOR_FIRST_FRAME_TIMEOUT_MS = 30_000` — armed
  once, cleared permanently by the FIRST raw chunk (`onData` calls
  `clearFirstFrameTimer()` unconditionally, live-transport.ts:1133).
- The 5s HEARTBEAT_MS at :92 is OUTBOUND client traffic, not a detector.
- No transport-level watchdog exists after the first chunk; sol audit lane
  confirmed GAP (c) with file/line refs.

## Design (ADAPT, not copy)

senpi resets `lastInboundFrameAt` on every decoded frame and
`lastMeaningfulFrameAt` only when the frame is not liveness-only
(heartbeat / conversationCheckpointUpdate), then arms one timer at
`min(lastInbound+30s, lastMeaningful+90s)` (cursor-agent.ts:589-673 in the
.tmp/chase clone). OpenCodex differences to respect:

- Our decode path is `handleFrame` inside live-transport.ts, protobuf event
  mapping in protobuf-events.ts; liveness classification must happen where
  the AgentServerMessage case is visible, not on raw chunks — raw-chunk
  resets would let TLS keepalive noise defeat the watchdog.
- Client-tool suspend (live-transport.ts:203-206) intentionally ends without
  turnEnded: the watchdog must disarm when the transport is settling or a
  client-tool suspend is in progress, mirroring the #2321 grace-timer guards
  (expectedClose).
- Long native-exec turns emit synthetic progress; those count as inbound
  frames already (they arrive as real server frames), so no special case —
  090's warning about "not fighting synthetic progress heartbeats" is
  satisfied by the meaningful/liveness split.
- Timeout action: fail the turn through the SAME error path a transport
  error takes today (failAndClear with a typed message naming the stall
  class), so bridge mapping and tests stay uniform.

## Diff shape

- `src/adapters/cursor/live-transport.ts`: two constants
  (`CURSOR_STREAM_SILENCE_FAIL_MS = 30_000`,
  `CURSOR_STREAM_HEARTBEAT_ONLY_FAIL_MS = 90_000`), fields
  `lastInboundFrameAt` / `lastMeaningfulFrameAt` / `streamHealthTimer`,
  arm/reset/disarm helpers; reset hooks in the decoded-frame path; disarm in
  finalize/cleanup paths alongside firstFrameTimer/turnEndedCloseTimer.
- Optional input knobs on CursorTransportFactoryInput mirroring
  `firstFrameTimeoutMs` for tests.
- Tests: `tests/cursor-stream-health.test.ts` — (1) silent stream after
  first frame fails at ~30s (fake timers); (2) heartbeat-only stream
  survives 30s but fails at 90s; (3) meaningful frames keep resetting both;
  (4) client-tool suspend path never trips the watchdog; (5) turnEnded
  disarms it.

## Risks

- False positives on genuinely slow models: thresholds are senpi-live-tested
  but our traffic mix differs; keep knobs overridable and document defaults.
- Interaction with #2307 clean-terminal settle: watchdog must check the
  settler state before firing (same guard the grace timer uses).
