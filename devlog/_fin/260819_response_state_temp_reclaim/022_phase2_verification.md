# Phase 2 verification

Full suite on `macmini-cf` at `a2cec13db` (worktree `/tmp/ocx-reclaim`).

## Full suite — 13397 pass, 1 fail

`bun run test` → `Ran 13410 tests across 850 files [474.20s]`.

The single failure is `update-npm-cache-preflight > runs the real worker protocol against
npm's configured cache path`, already proven pre-existing in `012` by running that file at
the unmodified base `59964ad77` (10 pass / 1 fail, identical). It depends on a working
`npm config` on the host.

The 7 GUI `react` module-load errors seen in the phase-1 run are absent here — that run
had an incomplete `gui/node_modules`, confirming they were environmental as recorded.

## Focused — 171 pass, 0 fail

`bun test tests/doctor.test.ts tests/responses-state.test.ts tests/state-store-sweeper.test.ts`
→ 171 pass, 506 assertions, on both the workstation and `macmini-cf`.

`bun run typecheck` clean; `bun run privacy:scan` passed.

## What the new end-to-end tests actually pin

Audit round 3's sharpest finding was that inverting the report/reclaim ternary in
`runDoctor` would have left the entire suite green. The added
`doctor reclaim wiring (end to end)` block seeds a real stale temp in an isolated
`OPENCODEX_HOME` and asserts:

- `runDoctor([])` leaves the file ON DISK and prints "reclaimable";
- `runDoctor(["--reclaim-response-temps"])` removes it and prints "Reclaimed 1";
- `runDoctor(["--reclaim-response-temp"])` (typo) warns and removes nothing.

The first of those fails if the default is ever inverted, which is the property three
accept criteria claimed and none previously demonstrated.
