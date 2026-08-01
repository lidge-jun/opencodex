# 060 — WP6: full gates and close-out

No source change of its own.

## Gates

| # | Command | Expected |
|---|---------|----------|
| 1 | `bun run typecheck` | exit 0 |
| 2 | `bun run test` | zero failures, at or above baseline plus the new cases |
| 3 | `gui: bun run test` | zero failures |
| 4 | `bun run lint:gui` | eslint clean |
| 5 | `bun run privacy:scan` | passes |
| 6 | `bun run build:gui` | succeeds |

Baseline measured this session on `1540ad4a`: root 4504 pass across 342 files,
GUI 218 pass across 55 files. Both were green on the parent of this work, so any
new failure is attributable.

## Push

NOT automatic. LOOP-GIT-01 makes pushing an explicit user decision, and the user
has not pre-approved a push for this unit. Commit each work-phase locally, then
ask.

## Terminal outcome

Report per work-phase: WP0 roadmap lock, WP1–WP5 DONE/NOOP with evidence, WP6 the
gate summary.
