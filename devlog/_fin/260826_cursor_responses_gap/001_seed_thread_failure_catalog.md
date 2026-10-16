# 001 — Seed-thread failure catalog (thread 01a03beb-a886-74f2-83be-5bf998f9fa4a)

Seed: Codex app thread "Test apply_patch 적용", cwd
`/Users/jun/Downloads/hellobot-detail-studio`, single turn, 179.4s,
~15 tool rounds for a task that natively takes ~3. Model route:
`cursor/grok-4.6` through the local proxy. Full turn read on 2026-08-26.

Verdict legend: ADAPTER = opencodex cursor adapter mechanism; MODEL =
grok-4.6/cursor-training behavior; CLIENT = Codex app/client-side;
UNKNOWN = evidence gap stated.

## S1 — Per-round context re-orientation ("Continuing from previous conversation")

Evidence: every reasoning block in the seed thread restarts with
"Continuing from the previous conversation / 이전 대화에서 이어서"; the
model re-checked `pwd`/workspace state at least 4 separate times and
re-announced near-identical commentary each round.

Mechanism (ADAPTER, primary):

- src/adapters/cursor/protobuf-request.ts:225-260 — history replay for
  external wire models flattens prior turns into root text blobs:
  user/developer messages as text parts, assistant text via
  `assistantRootText(message, !externalModel)` — i.e. for external models
  (grok) hidden reasoning is intentionally NOT replayed — and tool results
  as `[Tool Result]\n...` assistant-visible text only when
  `cursorNeedsExternalToolContinuation` says so. Tool CALLS are never
  replayed. The model therefore sees a text transcript, not its own
  structured turn state, and treats each round as a resumed/foreign
  conversation.
- src/adapters/cursor/checkpoint-store.ts:11-27 — checkpoint continuity
  exists (TTL 15min, 64 entries, 16MB) but `trailing_tool_result` is an
  invalidation reason: src/adapters/cursor/request-builder.ts:430-443
  (lineageMismatch) returns `trailing_tool_result` when the last message
  is a toolResult and the checkpoint covers the whole message list —
  exactly the state after every tool round-trip. When invalidated,
  request-builder.ts:459-461 falls back to `continuationMode:
  "full-replay"` — the flattened-text path above. Whether every
  tool round actually falls back is the P11 probe question.
- src/server/responses/core.ts:529-537 — conversation identity scoping;
  core.ts:2436-2438 forces `_cursorIsolateConversation` for compaction
  requests. Not the per-round mechanism, but governs when a conversation
  id rotates (S1 amplifier when the client omits thread identity).

Model contribution (MODEL, secondary): grok-4.6 verbalizes the re-oriented
state ("Continuing...") instead of silently continuing; C1/C2 control
probes decide how much is model vs adapter.

## S2 — durationMs: 0 on every commandExecution

Evidence: all commandExecution items in the seed thread report
`durationMs: 0` even for commands that clearly took time.

Verdict: CLIENT-leaning UNKNOWN. `durationMs` appears in adapter code only
in native-exec-desktop.ts / native-exec-tools.ts error paths; the seed
thread's value is recorded by the Codex app from turn events. Gap: we did
not capture the SSE event stream the app received, so whether opencodex
emits started/completed timestamps correctly on the cursor route is
unverified. Probe P2 (SSE inspection) + P10 (native subagent) carry this.
Related surface: src/adapters/cursor/native-exec-shell.ts:136
(`executionTime`) for cursor-native exec, not the Codex client path.

## S3 — "Garbled / lost tool outputs"

Evidence: model self-reports "previous tool results were garbled", "the
exec tool only returned a working directory check"; repeated identical
probes suggest earlier results never reached the model.

Mechanism (ADAPTER, primary suspects):

- protobuf-request.ts:248-258 — tool results replayed as flattened
  `[Tool Result]` text with normalization
  (src/adapters/cursor/tool-result-normalize.ts, #1920 empty-result
  error reclassification). Any truncation/normalization loss here is
  invisible to the client but visible to the model.
- The checkpoint-vs-full-replay fork (S1) means the model's view of tool
  history differs by round; a round served from checkpoint and the next
  from flattened replay do not present tool output identically.
- P12 (large/multi-line/ANSI payload stress) is the discriminator.

## S4 — apply_patch envelope failure on first attempt

Evidence: seed thread reasoning: "The previous patch failed because its
first line lacked the required `*** Begin Patch` header."

Mechanism (ADAPTER by design, known limitation):

- src/adapters/cursor/tool-definitions.ts:269-312 — Cursor-trained models
  cannot reliably emit Codex freeform patch grammar (#1017), so the
  adapter advertises `edit_file`/`multi_edit` and converts them
  (protobuf-events.ts:896 `translateStructuredEditCall`); freeform
  apply_patch passes through a grammar-only repair
  (protobuf-events.ts:702 `sanitizeCodexApplyPatch`) that strips fences,
  converts git-style diffs, rewrites hunk headers.
- The seed failure shows the repair did not catch a decorated
  `*** Begin Patch ***` variant on first emission — or the model emitted
  the patch as plain tool-argument text on a path that bypasses
  sanitize. Which envelope variant leaked is UNKNOWN (the raw failing
  payload was not captured in thread items); P6 probes decorated
  envelopes deliberately.

## S5 — Shell quoting failure loops (python3 -c nesting)

Verdict: MODEL primarily (grok-4.6 quoting habits), amplified by S3 (lost
feedback prevented learning from the first failure). Adapter surface:
tool-definitions.ts:654-676 already injects guidance about host-shell-safe
commands; the seed thread shows the model ignoring or never seeing it
mid-conversation (S1 replay drops? — the system prompt is re-sent per
request-builder.ts:447, so this leans MODEL).

## S6 — Task cost blowup (179s / ~15 rounds for a 3-round task)

Composite of S1+S3: every lost or re-oriented round doubles the work. Not
a separate mechanism; recorded for severity weighting in 020.

## UNKNOWN register

| Item | Gap | Carried by |
|---|---|---|
| S2 timing emission | SSE event timestamps not captured | P2, P10 |
| S4 raw failing payload | thread items store outcome, not raw args | P6 |
| S1 checkpoint hit-rate | no live counter read | P11 |
