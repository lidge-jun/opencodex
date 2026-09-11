# 010 — wp2: backlog-abort fix (stack base A, PR vs dev)

Branch: codex/runturn-backlog-coalesce (from origin/dev). One PR.

## Diff-level changes

### 1. MODIFY src/adapters/run-turn-queue.ts — push-time coalescing

In createAdapterEventQueue push(): when no reader is waiting and the queue
tail exists:
- tail.type === "text_delta" && event.type === "text_delta" && identical
  phase field (both undefined, or === — an omitted phase is a continuation
  downstream (bridge.ts:922-925) but merge only on strict equality to stay
  provably safe) -> REPLACE tail with a new object
  { type:"text_delta", text: tail.text + event.text, phase: tail.phase }.
  Never mutate pushed objects: push() has no ownership/copy contract
  (run-turn-queue.ts:7-11) and adapters may retain/re-emit event objects —
  interface-level alias safety, so replacement only (A-gate blocker 6).
- Coalescing threshold (A-gate round-2 blocker 1): merge only while
  tail.text.length + event.text.length <= 64 * 1024 (UTF-16 code units —
  a coalescing threshold, NOT a byte-memory cap; a single oversized
  incoming event stays a single item, and byte-based caps remain out of
  scope). Past the threshold, append as a new item. Same combined-length
  rule for thinking merges.
- tail.type === "thinking_delta" && event.type === "thinking_delta" ->
  merge thinking strings likewise (same replacement + byte-bound rules).
- event.type === "heartbeat" && tail.type === "heartbeat" -> drop event
  (one pending heartbeat is enough).
- All other types append as today. Never merge across a non-delta boundary;
  tool_call_delta is NOT coalesced (argument chunk order is load-bearing for
  JSON reassembly but adjacent-merge would be safe — still excluded from
  this PR to keep the diff minimal and provably safe).
- Backlog check unchanged (queued.length >= maxBacklog), but with coalescing
  the count now approximates buffered ITEMS not tokens.

### 2. MODIFY src/adapters/run-turn-queue.ts — honest overflow message

Error message becomes "consumer stalled: adapter event backlog exceeded —
turn aborted" and the pushed error gains status/retryable hints untouched
(plain message error as today). Update the two tests asserting the string.

### 3. Tests — MODIFY tests/run-turn-queue.test.ts

- NEW: 5000 ADJACENT text_delta chunks (same phase) with no reader ->
  backlog stays 1 merged item, no overflow, collect() returns exact
  concatenation (activation for the text-merge branch).
- NEW: 5000 adjacent thinking_delta chunks -> 1 merged item, exact
  concatenation (activation for the thinking-merge branch, A-gate blocker 3).
- NEW: byte-bound activation — chunks totalling >64KB split into 2+ items,
  concatenation preserved across items.
- NEW: heartbeat collapse — 50 heartbeats no reader -> 1 queued heartbeat.
- NEW: interleaved text/tool/text does not merge across the tool event.
- NEW: phase transitions do not merge: "final"->"commentary", and
  explicit-phase -> omitted-phase (undefined) stays separate (blocker 4).
- NEW: empty-string deltas merge without corrupting concatenation.
- KEEP: overflow still fires for 1024+ DISTINCT non-coalescible events
  (tool_call_start floods) and the message assertion updated.

### 4. MODIFY tests/abort-race.test.ts — the overflow flood at :56 uses
1025 text_delta events which coalescing would now merge; switch the flood
to non-coalescible events (tool_call_start with distinct ids) so the
abort-race contract still activates overflow (A-gate blocker 1), and sync
the message string (only three live refs exist: run-turn-queue.ts:76 + the
two test assertions; no runtime parser — blocker 7 verified).

## Accept criteria + activation

1. bun test tests/run-turn-queue.test.ts exit 0 (activation: coalesce tests
   drive push path with no reader — the exact incident shape).
2. bun test tests/abort-race.test.ts exit 0.
3. Live: macmini-cf proxy on this branch survives a deliberately stalled
   consumer (curl -N piped to sleep-heavy reader) for >60s of grok-4.6
   token streaming without turn abort; verified in wp3 probe round.

## Out of scope

Bun disconnect-latency itself (runtime-level), byte-based caps, bridge HWM.
