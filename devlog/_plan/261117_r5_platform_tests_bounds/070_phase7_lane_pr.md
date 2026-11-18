# wp7 — lane PR and report

- Final head: `bun run typecheck`, the focused files of every carry, `bun run test:changed`,
  `bun run structure:check`, `bun run privacy:scan`; full `bun run test` if the host allows,
  otherwise the AGENTS.md resource exception recorded in the PR.
- Push `triage/r5-platform-tests-bounds`, open one PR to `dev` with every template section, link
  it in GOAT, wait for the exact-head PR checks, fix real failures.
- Report to origin: outcome, base SHA, PR URL, head SHA and checks, the per-item table, NOT RUN,
  subagent models, residual risk.


## Result (2026-11-17)

- `bun run test:changed` at 451cd39cbc selected 1,577 files (the preload is a harness input): 37,876
  pass / 93 skip / 4 fail in 460 s at load 8. None is caused by this lane:
  `ultrafast-tier-honesty` "retained-sync retains operator Ultra Fast" times out at 5 s around a
  `spawnSync` bun child and fails 3/3 in a 4-way parallel run with the base `tests/preload.ts`
  restored. `status-install-method` and the two `cli-export-command` cases pass alone, under
  `--isolate` (5/5), and in the same parallel set.
- Final independent lane review: PASS.
