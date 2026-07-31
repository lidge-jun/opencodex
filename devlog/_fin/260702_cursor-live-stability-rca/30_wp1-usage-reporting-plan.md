# WP1 plan — Cursor usage reporting: cumulative context, error-path emission

Date: 2026-07-02
Status: P draft (enters its own PABCD cycle after WP2/WP0 close).

## Evidence

- Cursor reports an ABSOLUTE conversation context size via
  `conversationCheckpointUpdate.tokenDetails.usedTokens`
  (`src/adapters/cursor/protobuf-events.ts:202-209`), consumed at finalize
  (`:291-303`, shaped by commit 1edf197): `totalTokens = checkpoint`,
  `inputTokens = max(0, checkpoint - outputDelta)`, `estimated: true`.
- Rows that LOOK incremental (181 / 269 tokens) are turns where Cursor sent no
  checkpoint — only the additive output delta is reported (input 0).
- Cursor never reports a cache signal; `cachedInputTokens` is structurally
  absent (do not fabricate).
- Error paths (watchdog incomplete, upstream 502) log `usageStatus: unreported`
  with 0 tokens even when deltas/checkpoints were already seen mid-stream
  (six 502 rows in runs 4/6/7 all had null usage despite streamed text).

## Plan (diff-level to be finalized in its own P)

1. Carry last-seen `contextTokens` in the per-request event state into ALL
   terminal paths, not just clean `turnEnded` finalize:
   - watchdog incomplete (`src/bridge.ts` reportTerminal("incomplete") path)
   - upstream error/502 handling in the cursor adapter/server usage recorder
   Emit partial usage `{inputTokens: max(0, ctx - out), outputTokens: out,
   totalTokens: ctx, estimated: true}` with a distinct `usageStatus`
   ("partial" or keep "estimated") instead of unreported/0.
2. Persist per-conversation last checkpoint in the responses state chain
   (`src/responses/state.ts`) so checkpoint-less continuation turns can report
   a cumulative estimate instead of output-only rows.
3. GUI/log semantics: keep `estimated` flag; document that cursor has no cache
   column by design.
4. Tests: extend `tests/cursor-protobuf-events.test.ts` (terminal-on-error
   usage), `tests/usage-summary.test.ts` (partial rows aggregate), plus a 502
   path test at the server usage recorder level.

## Acceptance

- A stalled/502 cursor request logs partial usage (non-zero) with duration.
- Checkpoint-less turns show cumulative input estimate, matching the
  cumulative feel of openai rows.
- Full suite + tsc green.
