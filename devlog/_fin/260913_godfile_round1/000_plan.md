# God-file round 1 — storage/cleanup, service, kiro

Unit opened 2026-09-13. Base: `dev` @ `f7d9dbad03` (post #4484).

## Why these three, and why not the big ones

A full inventory of every `src/` file over 1000 lines was ranked by size, churn,
and **live open-PR contention**, measured against the 65 pull requests open at
the time. Contention is what decides the order, not size:

| File | Lines | Commits | Open PRs touching it |
|---|---|---|---|
| `src/server/responses/core.ts` | 8548 | 146 | 19 |
| `src/config.ts` | 4563 | 64 | 19 |
| `src/server/index.ts` | 3369 | 63 | 8 |
| `src/providers/registry.ts` | 3689 | 56 | 6 |
| `src/service.ts` | 5558 | 20 | **0** |
| `src/storage/cleanup.ts` | 3141 | 4 | **0** |
| `src/adapters/kiro.ts` | 2319 | 8 | **0** |

`core.ts` and `config.ts` carry the most value and are deferred anyway: splitting
either one today rebases 19 open branches, several of which are carries of other
authors' work. `devlog/_plan/260818_megafile_split_program/000_risk_assessment.md`
reached the same conclusion when the overlap was 8 PRs; it is now 19.

The three files in this round have zero open-PR contention, so the split
rebases nobody. They were ordered within the round by risk:

1. `src/storage/cleanup.ts` — one module-level `let`, no test reads it as text,
   4 commits of churn. The safest possible opener.
2. `src/service.ts` — largest of the three and the one with real hazards: three
   module-level test-hook seams plus `ownedWindowsSchedulerStages`, and eight
   test files that name the path as text, including a 4074-line namespace-import
   suite. Platform seams (launchd / systemd / Windows Scheduler / diagnostics /
   arg parsing) are already visible in the export names.
3. `src/adapters/kiro.ts` — no module-level mutable state, no text oracle, six
   exported names. Mechanical.

`src/responses/state.ts` (23 `let`, 23 test hooks) was ranked and deliberately
deferred: its state density makes the singleton-forking risk exceed the payoff
at 2432 lines.

## Contract for every commit in this round

Pure move, zero behavior change. The original path stays as a facade
re-exporting every name it exports today, so no consumer and no test is edited.
Every module-level mutable binding, cache, and test hook lands in exactly one
module — a forked singleton is a silent correctness bug that no type check
catches, and it is the failure mode this round is most exposed to.

## Gates

`src/storage/` and `src/adapters/` are already claimed in
`structure/manifest.json`, so `src/storage/cleanup/` and `src/adapters/kiro/`
need no structure change. `src/service/` is a new top-level src area:
`scripts/structure-ssot.ts` fails unless a doc claims it **and** names a path
inside it, so `runtime.md` gains both the `documents` entry and the prose
reference. `grace.undocumentedSourceAreas` was not used — grace rows render into
`structure/INDEX.md` and would break generated-index parity.

No new test file is added, so `scripts/test-layout/layout.json` and
`tests/fixtures/test-layout-expected.json` are untouched. The existing suites are
the oracle for a pure move; that is the point of keeping the facade.

## Delivery

Stacked PRs: cleanup → service → kiro, each targeting its parent's head branch.
Per operator instruction the local product suite, typecheck, and build were
**NOT RUN**; the two parent commits carry `[skip ci]` and hosted CI runs on the
stack tip only, whose tree contains all three splits. Merge is bottom-up with
the child rebased onto `dev` after each parent lands, and the final `dev` tree
is diffed against the CI-tested tip to prove they are identical.
