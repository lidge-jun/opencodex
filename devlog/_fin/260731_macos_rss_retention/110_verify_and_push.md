# Phase 110 — final verification, docs sync, push (wp6)

Terminal gate for the implementation phases 070–100.

## Gates (all must be green, exit codes recorded in this doc at close)

1. `bun run typecheck`
2. `bun run test` — full suite, run as managed background execution with
   polling (CPU-heavy; local contention caveat: if the suite is disturbed by
   parallel work, re-run rather than reporting an interrupted run).
3. `bun run privacy:scan`
4. `git log` — every LANDED phase commit present (wp5's commit only if its
   abort-stress gate passed — R2-6), only this unit's files staged (selective
   staging; `devlog/_plan/260731_client_config_export/` and other concurrent
   dirty files excluded).
5. Phase-local gates completed: 070's post-patch remote smoke calibration
   (no warm-invalid trip) and 100's darwin abort-stress probe (or the
   documented BLOCKED outcome excluding wp5 from the push).

## Docs sync

- docs-site: `streamMode` reference gains the darwin opt-in sentence ONLY if
  wp5 landed (R2-6; a BLOCKED wp5 ships no gate change and no docs sentence).
  En source; locales must not contradict — add the same minimal note or leave
  locales untouched if the page defers to en.
- This unit's docs updated with final evidence (counters payload sample,
  test names, commit hashes).

## Closeout evidence (2026-08-01)

Landed commits (this unit):

| Commit | Phase | Content |
|---|---|---|
| `976ff3a21` | wp1 | investigation docs 050-053 + audited roadmap 060-110 |
| `a9c5f16f0` | wp2 | harness monotonic pause clamp + warm-gate error split |
| `41af6168e` | wp3 | inspector bounds/taint/dispose/parse-once + both-consumer drain + counters |
| `316497fca` | wp4 | eager inline response.failed tail via shared capped serializer |
| `a209188fb` | wp5 | selectEagerPath darwin opt-in + abort-stress probe scripts + policy surfaces |

Gates at close (run at wp5 D, HEAD a209188fb):

- `bun run typecheck` — exit 0.
- `bun run test` — 6421 pass, 3 skip, 0 fail, 31839 expect() calls, 460 files.
  (Run predates the wp5 review repairs; wp6 re-runs the full suite as the
  authoritative gate.)
- `bun run privacy:scan` — passed. (Same caveat; wp6 re-runs.)
- wp2 remote smoke calibration — passed (070 §Execution record).
- wp5 abort-stress probe — FINAL authoritative record is
  **PASS-WITH-CAVEAT / backpressure-unreachable** (seed 260801, 134
  ack-verified aborts, 67 honest backpressure-unreachable trials, child exit
  0 — see 100 §Abort-stress gate execution record; the earlier PASS/clean
  201/201 figure here was from the pre-repair probe and is superseded).

New regression surfaces: `tests/sse-inspector-bounds.test.ts` (19),
bounded-drain/dispose coverage in `tests/consume-for-inspection-cancel.test.ts`,
eager tail tests 090-1..12 in `tests/relay-eager.test.ts` +
`tests/sse-failed-tail.test.ts` parity, `selectEagerPath` matrix in
`tests/bun-stream-caps.test.ts`, darwin marker integration in
`tests/subagent-fallback-handle-responses.test.ts`, effective `eagerRelay` and
`inspectionCounters` assertions in `tests/memory-watchdog.test.ts`.

Post-deploy observability: `GET /api/system/memory` (and `ocx observe memory
--json`) now expose `inspectionCounters` — frame-buffer high-water bytes,
completed-items max count, frame-cap overflows, item-cap evictions,
post-cancel drain stops — for real-traffic retention attribution. The live
proxy predates these patches; counters appear after its next restart/upgrade.

Allocator residual (053): documented NOOP until a stable Bun ships the
allocator train. macmini FULL measurement run remains an optional follow-up;
no measured-fix claim is made in this unit.

## Push (explicitly authorized by the user in this session)

1. `git fetch origin && git merge --ff-only origin/dev` (re-sync; if diverged,
   rebase our commits, re-run gates).
2. `git push origin dev`.
3. Verify `git rev-parse dev origin/dev` match; record hashes here.

### Push record (2026-08-01)

- origin/dev had advanced 18 commits mid-unit (PR #747/#750/#751 merges);
  resolved with a merge commit `30fb76856`, full suite re-verified green on
  the merged tree (6464 pass, 0 fail), privacy scan green.
- `git push origin dev` → `8c8832137..1eae6478d dev -> dev` (pre-push hook
  ran the full verification chain and passed).
- All seven unit commits verified as ancestors of origin/dev post-push:
  `976ff3a21`, `a9c5f16f0`, `41af6168e`, `316497fca`, `a209188fb`,
  `d59d0c19c`, `1eae6478d`.
- A concurrent session pushed `5f9434ab2` immediately after; local dev
  fast-forwarded to match. Final parity: local dev == origin/dev ==
  `5f9434ab2`.

## Live follow-up (post-push, documented not executed)

- The running proxy (pid 63737 at investigation time) predates the patch;
  after the user restarts/upgrades, `ocx observe memory --json` exposes
  `inspectionCounters` — frame-buffer high-water, item-cap evictions, drain
  stops — for real-traffic attribution without a macmini harness run.
- macmini harness re-run (070's runbook) remains available for controlled
  numbers; the FULL measurement run is not a gate for this unit (the smoke
  calibration in wp2 is). No measured-fix claim is made anywhere in this unit.
