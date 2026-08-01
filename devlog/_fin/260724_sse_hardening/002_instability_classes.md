# 002 — Instability Classes (research, no diffs)

Source: read-only hunt (explorer Pascal) + main-agent spot verification of
every load-bearing anchor. Classes already covered by merged work or open
PRs are marked and must not be re-implemented.

## In scope

### 1. Google SSE corruption/EOF promotes to clean completion (HIGH)

- google.ts:349-360: line scanner accepts only `data: ` (with space);
  JSON.parse failure -> debugDroppedFrame + continue; EOF residual buffer
  never inspected; google.ts:436 unconditional `done` (except Vertex
  truncation-with-tool-calls guard at :432-435).
- Verified: `catch { debugDroppedFrame(...); continue; }`, EOF falls through
  to `yield { type: "done", usage: pendingUsage }`.
- No issue/PR coverage.

### 2. Anthropic early EOF after message_start promotes to done (HIGH)

- anthropic.ts:821 `if (pendingUsage && !emittedDone) yield* emitDone();`
  fires when upstream closes cleanly after message_start but before
  message_stop. Verified.
- message_delta may carry stop_reason (:803-806) — a legitimate compatible
  provider can omit message_stop; fix must not break that (see 010).
- No issue/PR coverage.

### 3. finish_reason / stopReason loss (HIGH)

- openai-chat.ts:606 keeps only boolean sawFinish; the finish_reason string
  ("length", "content_filter") is discarded; done carries no stopReason.
- Google finishReason (MAX_TOKENS etc.) captured in lastFinishReason but
  only used for the Vertex truncation guard; not propagated on done.
- bridge.ts:653 maps only stopReason "max_tokens" to incomplete.
- PR #339 (main-target, wrong branch) partially covers openai-chat
  preservation; Google + bridge mapping uncovered.

### 4. Chat Completions converts stall/eof incomplete to clean [DONE] (HIGH)

- chat/outbound.ts:323-330: response.incomplete -> finish("stop" |
  "tool_calls") unless reason is max_output_tokens/content_filter;
  finish() emits [DONE]. A upstream_stall_timeout / adapter_eof turn ends
  indistinguishable from success. Verified.
- fail() exists (:179-) and is the correct vehicle.
- No issue/PR coverage (PR #363 does not touch terminal policy).

### 5. incomplete responses not cached despite bridge comment (MED-HIGH)

- bridge.ts:658 comment "Still cache the partial output so
  previous_response_id replay works" + onCompletedResponse call; but
  state.ts:257 `if (response.status !== undefined && response.status !==
  "completed") return;` drops incomplete. Verified both sides.
- No issue/PR coverage.

### 7. Bridge emits further terminals after terminated (MED)

- bridge.ts done/incomplete/error cases set `terminated = true; break;`
  (switch-break only) and keep consuming adapter events; a misbehaving
  adapter (error then done) yields response.failed + response.completed +
  [DONE]. Verified at :633/:699.
- No issue/PR coverage.

### 9. No downstream backpressure in bridge / chat outbound (MED)

- bridge.ts:162 eager start + :438 for-await; chat/outbound.ts:140 same;
  controller.enqueue with no desiredSize/pull gating. Slow client -> queue
  growth.
- No issue/PR coverage.

### 11. Heartbeat/stall criteria inconsistent across paths (MED-HIGH)

- sse-decoder.ts:41 drops SSE comments; adapters never see keepalives, so
  the bridge adapter-activity clock (bridge.ts:196) can hit the 300s stall
  (stall-timeout.ts:8) during comment-only keepalive reasoning.
- relaySseWithHeartbeat (relay.ts:324) has no production call site but is
  exported via the server barrel (src/server/index.ts:87) and used by
  passthrough-abort.test.ts — it is a tested public export, not dead code;
  native passthrough emits no synthetic heartbeat.
- No issue/PR coverage.

### 12. Abort race between headers and reader attach (MED)

- abort.ts:126 documents the race + provides cancelBodyOnAbort (:137), but
  the generic adapter path (responses/core.ts fetch ~:1300 -> reader
  ~:1473) does not use it; only web-search executors do.
- No issue/PR coverage.

## Out of scope (with reasons)

### 6. Partial non-empty terminal / trailing output_item.done loss
- Conditional reachability (upstream must send partial terminal snapshot or
  post-terminal frames); devlog 260724_bugfix_train/010 explicitly scoped
  OUT. Record only.

### 8. Chat tool argument double emission
- Covered by issue #361 + open PR #363. Triage track decides #363.

### 10. Windows legacy-tee memory vs eager-relay runtime crash
- MIN_FIXED_BUN_VERSION = null (bun-stream-caps.ts:4): resolution requires
  upstream Bun fix verification, not local code. Track, don't patch.

### 13. Pre-header reset retry may duplicate upstream generation
- upstream-retry.ts:173 treats string bodies as replay-safe; changing this
  is a cost/idempotency policy decision, not a stability repair. Flag to
  maintainers.

### 14. Replay-state eviction/snapshot skip fails open
- state.ts 64MiB/2MiB/1h TTL caps + expansion miss -> naked delta with only
  a log warning (core.ts:917). Fail-open vs fail-closed is a product
  decision. Flag to maintainers.

## Safety confirmations (no action needed)

- Multi-byte UTF-8 splits across chunks: safe (streaming TextDecoder in
  shared decoder, google, openai-chat).
- CRLF / multiline data / EOF-residual: shared decoder handles; tested.
