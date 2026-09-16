# 031 — wp3 P re-verification

Re-read 2026-09-05 at `origin/dev` = `a594a7f21`. #3444 head moved `baefb1334` → `e2c9a6672`:
the author rebased onto `4dde2db97` (tests now at `tests/server/agent-task-recovery*.test.ts`)
and added two commits — `0cc829098` "honor final Responses adapter for V2 passthrough" (the
model-level wire-override conjunct 030 §3.1 d3 describes) and `e2c9a6672` "keep encrypted
passthrough opt-in inert in combos" (+29 test lines for the `!options.comboAttempt` exclusion —
the activation scenario 030 §3.5 asked for). `git merge-tree --write-tree origin/dev
refs/tmp/pr-3444` → CLEAN. Diff: 7 files, +140/−4. Still draft, still `unsponsored_surface` on
`src/server/auth-cors.ts`, still behind by more than 10 (readiness gate), so **P2 maintainer
carry stands** (030 §3.2). Trailer: `cb8010d6 <53855466+cb8010d6@users.noreply.github.com>`.
Wp2 landings touched `core.ts` (`24cc558d5`, `a594a7f21`) in other regions — merge-tree clean
confirms no overlap. Verifiers V1-V7 unchanged except V1/V2 paths now under `tests/server/`.

