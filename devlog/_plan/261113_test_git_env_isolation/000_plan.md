# 000 — test_git_env_isolation: Plan

## Objective

Stop the test harness from writing into the developer's shared repository through inherited
GIT_* environment, prove it with a regression test that fails first, and land it on dev.

Evidence base:

- mac-studio's shared .git/config gained user.name=t / user.email=a(at)b.com, the exact values
  scratchRepo() in tests/test-layout-tooling.test.ts:379-381 writes. That helper calls
  Bun.spawnSync(["git", ...], { cwd: root }) with no env, so an inherited GIT_DIR wins over cwd and
  git config writes the outer config.
- The same host gained core.worktree=/private/tmp/ocx-7376-validation.../tree. Reproduced on git 2.53:
  git init run in any directory with GIT_DIR=<shared>/.git and GIT_WORK_TREE=<dir>/tree reinitialises
  the shared repository and writes core.worktree=<dir>/tree; with GIT_DIR alone init writes nothing,
  but the following git config user.* lands in the shared config. One helper explains both incidents:
  a --git-dir/--work-tree wrapper (or a hook, rebase --exec, bisect run) exported the variables and the
  fixture git init re-pointed the shared repository at the wrapper's tree. With both set, the same
  helper's git add -A / git commit also stage and commit into the outer repository.
- tests/ci-workflows/setup-hooks.test.ts:83-96 sets process.env.GIT_DIR inside a synchronous
  try/finally. Nothing else can run in that window (the body is synchronous, Bun runs one file's tests
  serially, parallel files run in other processes) and finally restores it, so it does not leak today.
  It is still removed: it is the one place a future await or test.concurrent turns into a leak.

Root cause class: any test-side git spawn that inherits process.env unfiltered. Inventory from
rg -l '"git"' tests scripts, each hit read:

| Site | Mutates a repo | Env today | Action |
|---|---|---|---|
| tests/test-layout-tooling.test.ts scratchRepo + inline spawns | init/config/add/commit/checkout | inherited | use helper |
| scripts/test-layout/move.ts defaultGit (in-process on the scratch root) | status/mv | inherited | scrub |
| scripts/test-layout/verify.ts git grep | read | inherited | scrub |
| tests/ci-workflows/structure-ssot.test.ts gitScaffold/stage/add | init/add | inherited | use helper |
| tests/ci-workflows/ci-test-lane.test.ts | init/add/commit | ...process.env | use helper |
| tests/ci-workflows/ci-review-lanes.test.ts | init/add/commit | ...process.env | use helper |
| tests/ci-workflows/release-version-sources.test.ts | init/add/commit/checkout | ...process.env | use helper |
| tests/ci-workflows/build-release-changelog.test.ts | init/commit-tree | inherited (-C does not beat GIT_DIR) | use helper |
| tests/ci-workflows/test-runner.test.ts runGit | init/add/commit/branch/checkout | inherited | scrubbed env |
| tests/ci-workflows/setup-hooks.test.ts gitEnv | init/worktree/config --file | strips GIT_* | keep; take a base env instead of mutating process.env |
| tests/ci-workflows/ci-gui-typecheck-gate.test.ts gitEnv | init/config/commit | strips GIT_* | use helper (same behaviour, one owner) |
| release-preflight, release-pipeline-contract | init/commit | explicit PATH-only env | already safe |
| repo-hygiene, repo-import-resolution, platform-dialog-guard, messages-*-differential | read the checkout | inherited | repositoryGitEnv() (preload scrub cannot reach default-env Bun.spawn) |

No test or script writes core.worktree directly; the only path to it is git init with inherited
GIT_DIR+GIT_WORK_TREE, closed by the same scrub.

## Loop-spec

- Loop archetype: verifier-defined (regression test red then green, then gates).
- Write scope: scripts/git-repository-env.ts (new), scripts/test.ts, scripts/test-layout/{move,verify}.ts,
  tests/preload.ts, tests/helpers/{git-fixture,git-fixture-child,git-config-guard}.ts (new), the test
  files in the table, tests/ci-workflows/test-git-isolation.test.ts (new), scripts/test-layout/layout.json,
  tests/fixtures/test-layout-expected.json, this plan unit. Out of scope: src/, workflows, other hosts.
- Budget: none stated; host limits apply. Authority: push, PR, squash merge to dev granted by the user.

## Work-phase map

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| wp1 | 000 + 010 | plan, terra audit | none |
| wp2 | 010 | red test commit, then helper/migrations/scrub/guard | wp1 |
| wp3 | 010 Verification | gates, PR, CI, fresh terra final review, merge, origin report | wp2 |

## Accept criteria

Mirrors goalplan c-1..c-7.
