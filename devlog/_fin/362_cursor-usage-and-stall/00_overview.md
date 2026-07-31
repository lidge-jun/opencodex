# 362 — Cursor usage double-count + parallel tool-call stall

Two recurring Cursor-provider bugs (both first seen in the Kiro work), fixed with the
PABCD flow + gpt-5.5 subagent audit/verification. Reference: Kiro context-usage SOT fix
(commit 7374c3a, devlog 142.10).

## Bug 1 — context usage double-counting (commit 59a0ba7)

Symptom: usage 10000 then 10300 surfaced in Codex as 20300.

Root cause (gpt-5.5 confirmed): `protobuf-events.ts` folded TWO different concepts into
one field. `conversationCheckpointUpdate.tokenDetails.usedTokens` (ABSOLUTE cumulative
context) was written into `state.usage.outputTokens` via max(), while `tokenDelta`
(additive per-turn output) was `+=` into the same field. Cursor always reports
inputTokens=0, so `total_tokens = outputTokens` = a mixed absolute value. Codex derives
both `last_token_usage` and the additive `total_token_usage` from the same usage object,
so the absolute value got accumulated across turns -> 20300.

Fix: new `state.contextTokens` (monotonic max from checkpoints), surfaced as
`done.usage.totalTokens`. `tokenDelta` stays additive in `outputTokens`. `bridge.ts`
already prefers `totalTokens ?? input + output`. Mirrors Kiro's `kiro.ts` totalTokens.
Regression test added in cursor-protobuf-events.

## Bug 2 — parallel tool-call upstream_stall_timeout (commit f315338)

Symptom: "tool use 10개" -> Codex aborts with `upstream_stall_timeout` / "Incomplete
response returned, reason: upstream_stall_timeout". (The empty MCP listing the user saw
is expected: Codex's harness only has node_repl, no resources; opencodex's Cursor adapter
only reads provider.mcpServers.)

Root cause (gpt-5.5 confirmed): commit 9ff7e23 deferred `tool_call_start` to completion
for parallel-safe atomic emission. So while Cursor streams `partialToolCall` args for
several parallel calls, `mapCursorProtobufServerMessage` returns [] and opencodex emits
NOTHING outward. The bridge's stall watchdog (`bridge.ts`, default 90s, keyed on
downstream adapter events) then fires `upstream_stall_timeout` though the upstream is
alive.

Fix: emit a liveness `heartbeat` AdapterEvent for progress frames that map to no outward
event (toolCallStarted, partialToolCall, toolCallDelta, tokenDelta, checkpoint). The
bridge already resets stallTicks on any adapter event and ignores the heartbeat type, so
the watchdog stays armed without emitting a protocol event and without reopening the
parallel cross-wiring 9ff7e23 fixed. New `{type:"heartbeat"}` on CursorServerMessage +
message-mapper mapping + `isCursorProgressFrame` gate in live-transport. Tests added in
cursor-message-mapper and bridge.

## Verification
- `bunx tsc --noEmit` clean.
- Targeted cursor + bridge suites: 0 fail.
- Full `bun test`: 1665 pass (was 1662), 71 fail / 13 errors — all PRE-EXISTING and
  unrelated (logger env, cli hook install, cursor-agent CLI pool, stream-json fixtures),
  confirmed on baseline. 3 new tests added.

## Notes / not in scope
- The remaining Kiro-documented caveat persists: Codex still treats the same absolute
  total_tokens as additive total_token_usage without a Codex-side protocol split. Our fix
  makes last_token_usage.total_tokens correct (active context) which is the visible bug.
- MCP servers for the Cursor adapter come only from provider.mcpServers; importing Codex's
  own MCP config into the Cursor adapter is a separate feature, not a bug, left out.

## Follow-up — post-terminal heartbeat guard (commit 5763449)

gpt-5.5 verification (Bohr) flagged that a swallowed progress frame arriving after a
terminal done/truncation could still push a heartbeat. Added `state.terminated` (set in
finalizeTurn) and gated the live-transport heartbeat on `!state.terminated`. Regression
asserts `state.terminated === true` after done. Full suite still 1665 pass.
