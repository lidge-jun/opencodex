# Phase 1 verification

Full suite executed on `macmini-cf` (CPU-heavy work does not run on the workstation), in a
dedicated worktree at `/tmp/ocx-reclaim` checked out to `48b0c2a70`.

## Focused suites — green

`bun test tests/responses-state.test.ts tests/state-store-sweeper.test.ts`
→ **125 pass, 0 fail**, 349 assertions.

## Full suite — 13296 pass, 8 fail, all pre-existing

`bun run test` → `Ran 13316 tests across 850 files [478.53s]`, 13296 pass / 8 fail.

The 8 failures are two environmental classes, neither touched by this change:

1. **`update-npm-cache-preflight` (1).** `runNpmCachePreflight` returns
   `npm_config_failed` instead of `cache_accessible`. Proven pre-existing by checking the
   worktree out to the UNMODIFIED base `59964ad77` and re-running that file: **10 pass,
   1 fail** — identical. It depends on a working `npm config` on the host.
2. **GUI module loads (7).** `Cannot find package 'react'` /
   `Cannot find module 'react/jsx-dev-runtime'` from `gui/src/...`. That box has no
   `gui/node_modules`; only the root workspace was installed.

## Local checks

- `bun run typecheck` (`bun x tsc --noEmit`) — clean.
- `bun test tests/repo-hygiene.test.ts` — 11 pass.
- `bun run privacy:scan` — passed.
- `bun test tests/core-lab-boundary.test.ts` — 13 pass (registration touches a
  Lab-protected import path, so this was re-verified rather than assumed).

## Defect found by the new tests

The first draft clamped an anomalous boot time with `Math.min(rawBoot, now)`. The
future/non-finite test failed immediately: clamping to "now" makes the floor MAXIMALLY
aggressive — every file past the 15-minute grace would have its liveness probe retired.
Corrected to disable the floor outright when the value is not finite or is in the future.
An absent floor costs a missed reclaim; a wrong floor costs a live file.

## Correction to audit round 2

Round 2 predicted the "global fake-clock sweep" assertion in
`tests/state-store-sweeper.test.ts` would NOT change. It did. Its per-registration
`flatMap` interleaved `:ttl` and `:liveness` per store, which only matched observed order
while the single liveness owner sat last in the table. `sweepExpired()` and
`sweepLiveness()` are two separate passes, so the expectation is now built as two passes.
