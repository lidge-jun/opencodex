# Phase 070 — harness warm/observation gate fix (wp2)

Consumes the exact diff already written and `git apply --check`-verified in
`050_macmini_run_rca.md` §Proposed harness patch. This doc adds only the
execution and verification contract; the hunks in 050 are the source of truth.

## Change

`scripts/macos-rss-retention-harness.ts` only:

1. `pause(ms)` clamps to a monotonic `performance.now()` deadline and re-sleeps
   on early wake (Bun.sleep can return ~1 ms early; Run 2 failed at 59,999 ms).
2. Warm gate splits child-exit and duration errors, captures `exitCodeAtGate`
   before cleanup, and measures with `performance.now()` (wall time retained as
   a diagnostic field).
3. Observation gate gains the same monotonic duration check; the analysis
   envelope validator consumes `actualMs` instead of wall-clock subtraction.

## Explicitly NOT changed

- No gate is weakened: WARM/OBSERVE minimums stay mandatory, no tolerance is
  added after seeing a result.
- Child files, sampler, and validator thresholds (`sampler gap >1s`) untouched.

## Verification

- `bun run typecheck` green (harness is in the tsc project).
- The harness is an offline instrument, not a test/CI job — no suite impact
  expected; full-suite green is still required before the phase commit lands.
- **Post-patch remote smoke calibration (audit round 1 blocker 6):** after the
  patch lands locally, sync it to `macmini-cf` (`~/rss-measure/opencodex`) and
  run ONE smoke calibration per 050's runbook step 2 (minutes-scale, cheap).
  Gate: calibration passes and no `warm invalid` trip. The smoke summary
  self-stamps `valid:false, smoke:true` BY DESIGN — that stamp is the
  contract working, not a failure. No full measurement run in this phase; no
  measured-fix claim anywhere in this unit.

## Commit

One commit: `fix(rss-harness): clamp pauses to monotonic deadlines and split warm-gate errors`.

## Execution record (wp2 closed 2026-08-01)

- 050 diff applied verbatim: `git apply --check` then `git apply`, commit
  `a7264bc3f` (40 insertions, 11 deletions, harness file only).
- `bun run typecheck` exit 0 after apply.
- A-gate reviewer (independent, isolated-clone verification): PASS — patch
  applies cleanly, no gate weakened, child-exit-first ordering correct.
- Remote smoke calibration on `macmini-cf` (Darwin arm64, patched file synced
  by sha256 `302c1386…`, child/sampler files verified identical):
  run `2026-07-31T19-42-41-smoke-wp2`, exit 0, summary
  `{"valid":false,"calibrated":{"passed":true,"final":-884736,"peak":-884736,
  "rssSlope":0.3987},"smoke":true}` — calibration PASSED, no warm/observation
  gate trip (the previous 04-36-07 failure mode is gone), smoke self-stamp
  `valid:false` per contract. No full measurement claim.
