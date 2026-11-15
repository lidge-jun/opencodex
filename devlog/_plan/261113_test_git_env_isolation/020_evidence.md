# 020 — Evidence (test_git_env_isolation)

## Red first (commit 7f63c7385, helper still inheriting the environment)

`bun test tests/ci-workflows/test-git-isolation.test.ts` -> 0 pass, 3 fail, exit 1:

- GIT_DIR alone: the outer config received `[user] email = a(at)b.com, name = t`, the exact incident values.
- GIT_DIR + GIT_WORK_TREE=<tmp>/tree: the outer config received `core.worktree = <tmp>/tree`, the shape of the
  observed `/private/tmp/ocx-7376-validation.../tree`.
- Script helpers: `gitLsFiles` and `trackedPaths` listed the outer `outer.txt` instead of the fixture's files,
  and `inspectChangedRun` refused the fixture's commit as "does not resolve to a commit".

## Green (commit 151c94e89)

Same file -> 11 pass, 0 fail (60 expect() calls). Mutation checks: disabling the preload delete turns
"removes inherited repository variables..." red; making the preload guard not throw turns "fails the case
after which the guarded checkout's config changed" red.

## Bun default-env fact

Bun 1.4.4: Bun.spawn/Bun.spawnSync without `env` keep the start environment; a probe inside `bun test`
(preload loaded) saw the original GIT_DIR and the real HOME after both were changed in process.env, while
node:child_process and `{ env: process.env }` saw the change. Confirmed independently by the round-2 auditor.

## Inventory

Every test-side git spawn now passes `fixtureGitEnv()` (fixture repositories) or `repositoryGitEnv()`
(checkout reads); scripts that take a root (`inspectChangedRun`, test-layout move/verify, structure-ssot,
file-size-ratchet) scrub their env. Scripts left on the inherited environment read the checkout they run in
and are only started by tests as child processes, which already receive a clean env: privacy-scan,
doctor/lint/typecheck-gui-if-changed, generate-compatibility-version, setup-hooks. Scrubbing privacy-scan
would change what a pre-commit hook (GIT_INDEX_FILE) scans, so it stays as it is.

The messages-{sse,stream,overflow}-differential recorders stay byte-identical: they are children that only run
read-only `git show`/`ls-tree`/`diff` against pinned commits, and messages-sse-baseline-contract pins the SSE
recorder's SHA-256 as provenance for its golden (CI shard 3/5 caught the first revision, which had added an env).
A child receives the env its parent test passes, which a wrapped run has already scrubbed.

## setup-hooks process.env mutation

The old case assigned process.env.GIT_DIR and GIT_CONFIG_GLOBAL inside a synchronous try/finally. Nothing else
ran in that window (synchronous body, one file's tests run serially, parallel files are other processes) and
finally restored both, so it did not leak. It now passes a hostile base env to `gitEnv`/`fixture`/`setup`
and asserts process.env.GIT_DIR stays undefined.

## Guard cost

`.tmp/guard-bench.ts` on this checkout: arming 8.7 ms (one `git config --list`), check 7.8 µs per case
(byte compare). Per file with --isolate: about 9 ms.

## Host note

This host's `git` on PATH is a shim that finds the real binary through $HOME, which the test sandbox replaces;
local runs put the real git directory first on PATH. CI is unaffected.

## test:changed

`bun run test:changed` twice: 492 pass, 16 skip, 1 fail. The one failure is
"prepublishOnly runs the reference compiler..." in ci-gui-typecheck-gate.test.ts hitting its 15 s internal
deadline (a cold `tsc` of the fixture under parallel load; 8.5-11.5 s when it passes). It does not touch git.
Same host, same wrapper (`bun scripts/test.ts <file>`): the dev-base copy of that file FAILED the case and the
changed file passed it (10.9 s); under `--parallel=4` both passed (9.8 s / 8.5 s). Host-load timing, present on
dev, not caused by this change.
