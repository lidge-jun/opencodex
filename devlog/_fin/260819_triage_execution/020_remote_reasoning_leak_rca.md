# 020 — #2064 RCA: Remote raw-thinking leak (FIXED-ON-DEV)

Reported on 2.24.2: Codex Remote paints raw Grok thinking live
(response.reasoning_text.delta), then swaps to the progress line leaving
italic fragments; stored items are summary:[] + content reasoning_text.

RCA (sol lane + main verification, 2026-08-19):

- v2.24.2 bridge emitted the raw channel: git show v2.24.2:src/bridge.ts has
  response.reasoning_text.delta; fix commit 56752d7c5 (#2007, landed via
  PR #2016 merge 891c8284b) is NOT an ancestor of v2.24.2, IS on dev.
- Current dev has no escape path for openai-chat routed models: the bridge
  emits summary-channel deltas and summary-shaped items only
  (src/bridge.ts:987,1016,591-606); the native-Responses rewrite covers WS
  upstream, eager relay, HTTP SSE tee, and JSON reframing legs
  (src/server/responses/core.ts:2835-3066,
  src/server/responses-reasoning-summary-rewrite.ts:51-110).
- Suites: tests/responses-reasoning-summary-rewrite.test.ts +
  tests/bridge.test.ts = 73 pass / 0 fail (fresh).

Outcome: no new code. Issue #2064 closed as fixed-on-dev with a note asking
for on-device Remote verification on the next release build. Model-side
intermittent reasoning exposure (user caution) stays out of scope — our relay
provably converts the channel on every leg.

