# 040 — wp5: closure re-probe + disposition

1. macmini-cf: deploy full stack (dev + wp2 + wp4 branches merged locally in
   probe worktree), restart, /healthz version check.
2. Re-run N1-N5 + 090's S1-S5 scenario shapes; every class must PASS or
   carry a non-adapter-class disposition with NDJSON evidence.
3. Record closure artifacts in this doc: per-defect table (defect ->
   pre-fix artifact -> fix SHA -> post-fix artifact -> disposition).
4. Finalize stack: retarget children if parents merged; ensure every PR
   description names probe artifacts; devlog unit updated; goalplan criteria
   c1-c5 capturedEvidence filled.
5. D closes goal only when cxc loop validate passes (E8).

## Closure results (2026-08-28 09:58-10:23 KST, stack 286a1e5a5 + a652f0dfe)

Probe proxy 2.35.0 on 10199 (isolated homes, OCX_DEBUG=1), evidence in
macmini-cf ~/ocx-probe-260828/evidence/N5/.

| Run | Result | Evidence |
|---|---|---|
| c1 5-step | PASS | avg=84, 24 cmdexec, 0 reconnects |
| c2 5-step | PASS | avg=84, 32 cmdexec, 0 reconnects |
| c3 5-step | TASK PASS / TURN STALL | all 5 steps done (avg=84 read at item_28/32) across repeated upstream H2 resets (NGHTTP2_INTERNAL_ERROR, honest no-retry after committed output, reconnect recovery worked); after final step the turn sat in a getBlobArgs/setBlobArgs frame loop and never emitted turn.completed; killed after ~20min. Capture: run-c3.stall-capture.txt. Matches inventory #8/080 stall class — upstream/blob-sync, bounded, now with frame-level capture |
| c4/c5 | NOT RUN | batch serialized behind c3 stall; killed with it. Coverage for their shapes exists in wp3 round 1 (N1 x6, N3) |
| midstream diagnostics | 0 fired | no echo occurred in this round (expected: F1 was 1-in-6 in round 1); detector verified by 17 unit/adapter tests instead |

## Teardown + restoration proof

- Probe proxy killed; 10199 closed; 10100 healthy (2.34.0 pid 43321).
- Worktree removed (git worktree list = 1); primary repo dev @ 802f04adc,
  porcelain clean — identical to pre-state.
- Cursor credential NOT rotated (expiry 1792555734000 unchanged pre/post).
  Primary auth.json/config.toml hashes moved only via the primary launchd
  proxy's own token refresh + codex config injection during the window;
  probe-side copies were isolated and are retained in evidence.

## Per-defect disposition (final)

| Defect | Disposition | Evidence chain |
|---|---|---|
| Backlog false-abort | FIXED (PR #2774) | RCA 001 -> repro tests -> 4cd1b99f0 -> N4 live: 509KB/4560 deltas behind 60s stall, 0 aborts |
| Mid-stream envelope echo (F1) | OBSERVED->INSTRUMENTED (PR #2795) | run-03 wire capture -> CursorMidstreamEchoObserver + 8 tests; retry semantics deliberately deferred |
| mar call-id corruption (F2) | INSTRUMENTED (PR #2795) | first wire capture in run-03; callIdCorrupt flag now fires on live echoes |
| Empty tool-result (inv #1) | NOT REPRODUCED (10 runs) | bridge marker intact in every N1/N3 run; remains WATCH bounded to deep checkpoint sessions |
| Turn stall (inv #8) | CAPTURED, upstream-class | c3 frame loop capture; adapter surfaced honest errors; fix surface is upstream blob sync — no speculative adapter patch |
| Double-batch echo / image loop / premature final (inv #5/6/9) | MODEL/APP-class | unchanged from 100/021 dispositions |
