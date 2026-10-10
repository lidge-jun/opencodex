# 050 — Fix C: checkpoint continuity across tool round-trips (codex/cursor-gap-3)

Research: sol lane Banach (REPORT_DONE; focused tests 245 pass baseline).
CORRECTION to 001/020 G1 attribution: the covered-prefix + trailing
toolResult path ALREADY works (request-builder.ts:429/:464, test
cursor-request-builder.test.ts:972). The live 268->10383 jump is
missing_ref: a turn that emits a client tool call sets
emittedClientTool=true (cursor.ts:207) and commitCapturedCheckpoint
REFUSES to commit (cursor.ts:150) — so the first tool round has no
checkpoint at all, and every tool-call-heavy session replays fully.

## Diff plan (external-model-only, evidence-gated)

1. EDIT live-transport.ts checkpoint seam — return capture-ordering
   metadata (checkpoint arrived after client tool-call completion).
2. EDIT cursor.ts commitCapturedCheckpoint — allow committing a
   tool-suspended checkpoint ONLY for external wire models with that
   ordering proof; store with checkpointUsable:false + covered count.
3. Next trailing-toolResult request rides the EXISTING
   checkpointSuffixStart path (no change to lineage guards).
4. Fail closed on upstream invalid_argument (cursor.ts:250 behavior kept).
5. Reasoning (G3): keep dropped for external roots (live evidence:
   external workers invalid_argument on native thinking structures,
   protobuf-request.ts:696). reasoning_tokens=0 does NOT prove current
   reasoning dropped — grok worker may emit no thinkingDelta; current-turn
   thinking IS mapped when present (protobuf-events.ts:1251,
   message-mapper.ts:18, bridge.ts:947). G3 reclassified: adapter replay
   drop is by design + upstream constraint; no code change this program.

## Accept criteria

- New test: external model, tool-suspended checkpoint with ordering proof
  commits; next covered+[toolResult] request uses checkpoint mode
  (continuationMode=checkpoint, not full-replay).
- Native models unchanged (commit still refused).
- Pre-tool-captured checkpoints still refused (ordering guard test).
- Tests: cursor-live-transport, cursor-adapter, cursor-request-builder,
  cursor-blob, responses-state. Focused green + typecheck.
