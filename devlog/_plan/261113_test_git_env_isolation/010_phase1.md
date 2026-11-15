# 010 — Phase 1 (test_git_env_isolation), consolidated after audit rounds 1-2

## Facts the design rests on

- git 2.53: with GIT_DIR=<outer>/.git and GIT_WORK_TREE=<tmp>/tree inherited, git init in any cwd
  reinitialises <outer> and writes core.worktree=<tmp>/tree; with GIT_DIR alone, init writes nothing but a
  following git config user.* writes <outer>/.git/config; add/commit then stage and commit into <outer>.
- Bun 1.4.4 (confirmed by the auditor): Bun.spawn / Bun.spawnSync WITHOUT an env option use the env the
  process started with and ignore later process.env edits; node:child_process and an explicit
  { env: process.env } see the edits. So deleting variables in the preload protects node:child_process and
  spread envs only. Every git call in tests therefore passes an explicit env.
- Wrapped runs (bun run test) start bun test from createIsolatedTestEnvironment's env, so scrubbing there makes
  the whole process clean, default-env Bun.spawn included.

## MODIFY / NEW / DELETE map

### NEW scripts/git-repository-env.ts
GIT_REPOSITORY_ENV = git rev-parse --local-env-vars (2.53) + GIT_INTERNAL_SUPER_PREFIX:
GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_CONFIG, GIT_CONFIG_PARAMETERS, GIT_CONFIG_COUNT, GIT_OBJECT_DIRECTORY,
GIT_DIR, GIT_WORK_TREE, GIT_IMPLICIT_WORK_TREE, GIT_GRAFT_FILE, GIT_INDEX_FILE, GIT_NO_REPLACE_OBJECTS,
GIT_REPLACE_REF_BASE, GIT_PREFIX, GIT_SHALLOW_FILE, GIT_COMMON_DIR, GIT_INTERNAL_SUPER_PREFIX.
Comment: "the variables git itself clears before running in another repository; the ones that matter here
re-point the repository, work tree, index, object store or config source".
- isGitRepositoryEnvName(name): upper-cased name in the list, or /^GIT_CONFIG_(KEY|VALUE)_\d+$/.
- gitRepositoryEnvNames(env): matching keys present in env.
- withoutGitRepositoryEnv(env): new object without matching keys and without undefined values.

### MODIFY scripts/test.ts
- createIsolatedTestEnvironment: delete gitRepositoryEnvNames(inherited) next to LIVE_INSTALL_CREDENTIAL_ENV.
- inspectChangedRun: const gitEnv = withoutGitRepositoryEnv(env); pass gitEnv to gitRefExists/gitOutput.

### MODIFY scripts/test-layout/move.ts, scripts/test-layout/verify.ts
defaultGit and the git grep spawn pass env: withoutGitRepositoryEnv(process.env).

### MODIFY tests/preload.ts
1. After the sandbox loop: const inheritedGit = gitRepositoryEnvNames(process.env); delete each; if any were
   present, console.warn once naming the variables (names only) and saying default-env Bun.spawn children
   still inherit them, so use bun run test or unset them. No refusal (pre-commit hooks set GIT_INDEX_FILE).
2. Arm the guard (below) for process.env.OCX_GIT_CONFIG_GUARD_CHECKOUT || repoRoot(); afterEach throws the
   guard's report.

### NEW tests/helpers/git-config-guard.ts
- GUARDED_GIT_CONFIG_KEYS: core.worktree, core.bare, core.hookspath, user.name, user.email.
- resolveCommonGitConfigPath(checkout): <checkout>/.git directory -> <checkout>/.git/config; .git file
  "gitdir: X" (X relative to checkout allowed) -> X/commondir if present (relative to X) else X -> config;
  no .git -> null.
- createGitConfigGuard(checkout): null when no path or the config cannot be read at arm time (nothing to
  protect); otherwise baseline = { bytes, keys } where keys come from
  git config --file <path> --null --list (env: withoutGitRepositoryEnv + GIT_CONFIG_NOSYSTEM=1 +
  GIT_CONFIG_GLOBAL=<null device>), filtered to guarded keys, each key a full value list.
- check(): readFileSync(path) each call (the file is a few hundred bytes; bytes, not stat metadata, so a
  same-size same-mtime rewrite is still seen).
  - read fails (missing, permission) -> report "the checkout's common .git/config is missing or unreadable".
  - bytes equal baseline -> null.
  - bytes differ -> parse with git; git exits nonzero -> report "could not be parsed"; guarded keys differ ->
    report the changed key names; else null (an unrelated edit such as branch tracking).
  - after any report or byte change, re-baseline to the current state (a missing file stays the baseline
    until it reappears), so one corruption fails one test per worker.
  Reports carry key names only; no values, no paths.
- Accepted limits (doc + error text): a change undone between two checks is invisible; another worktree's
  legitimate change to a guarded key fails one test per worker; the guard watches the common config only
  (not config.worktree).

### NEW tests/helpers/git-fixture.ts
- fixtureGitEnv(extra = {}, base = process.env): withoutGitRepositoryEnv(base) + GIT_CONFIG_NOSYSTEM=1,
  GIT_CONFIG_GLOBAL=<"NUL" on win32, "/dev/null" otherwise>, GIT_AUTHOR_NAME/EMAIL and GIT_COMMITTER_NAME/EMAIL
  (email from fragments for privacy-scan), then extra.
- repositoryGitEnv(base = process.env): withoutGitRepositoryEnv(base); keeps GIT_CONFIG_GLOBAL so reads of the
  checkout keep the developer's safe.directory (scripts/test.ts explains why).
- fixtureGit(cwd, env = fixtureGitEnv()): (...args) => stdout; throws "git <args>: <stderr>".
- initFixtureRepo(root, env?): git init -q, returns the runner.

### NEW tests/helpers/git-fixture-child.ts
Plain bun script: bun <this> <root>. Calls initFixtureRepo(root) (so at commit A it runs the ORIGINAL
sequence: init, config user.email, config user.name), writes a file, add -A, commit. Each step in try/catch so
a failure is printed and the next step still runs; exits 0. It inherits whatever env the parent passes.

### MODIFY call sites (every test-side git spawn; rg -n '"git"' tests scripts re-run at C and recorded)
Mutating fixtures -> fixtureGitEnv / initFixtureRepo:
tests/test-layout-tooling.test.ts (scratchRepo, drop both git config lines, inline checkout/status spawns use
the runner), structure-ssot.test.ts (gitScaffold, stage, add), ci-test-lane.test.ts, ci-review-lanes.test.ts,
release-version-sources.test.ts (fixtureGitEnv({ HOME: root }) for git; the stamp bash keeps its own env),
build-release-changelog.test.ts, ci-gui-typecheck-gate.test.ts (replaces its local GIT_* filter).
Checkout and mixed reads -> repositoryGitEnv():
test-runner.test.ts runGit, repo-hygiene.test.ts (3 calls), repo-import-resolution.test.ts,
gui/platform-dialog-guard.test.ts, tests/helpers/messages-{sse,stream,overflow}-differential.ts.
Already explicit, unchanged: release-preflight, release-pipeline-contract (PATH-only envs).
setup-hooks.test.ts: gitEnv(root, base = process.env) and setup(root, base = process.env); the isolation case
passes base = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_DIR: <external>/.git } and no longer
assigns process.env. Leak analysis (000) recorded; the mutation is gone either way.

### Red-first ordering
Commit A: tests/helpers/git-fixture.ts with initFixtureRepo/fixtureGit carrying the ORIGINAL behaviour
(Bun.spawnSync with no env, git config user.email/user.name after init), scratchRepo switched to it, the child,
and test-git-isolation cases 1-2 and 6 (inspectChangedRun) -> red on those assertions. Commit B: everything
else. The red and green outputs are recorded in 020.

## TESTS: NEW tests/ci-workflows/test-git-isolation.test.ts
(layout.json explicit -> "ci-workflows"; tests/fixtures/test-layout-expected.json entry)
Outer repos and seed commits are built with an explicit fixtureGitEnv(); all paths mkdtemp; removeTreeWithRetry.
1. GIT_DIR=<outer>/.git inherited by git-fixture-child: outer config has no user.name/user.email, outer
   config bytes, HEAD and index bytes unchanged; fixture has its own .git and one commit.
2. GIT_DIR + GIT_WORK_TREE=<tmp>/tree (created): outer has no core.worktree; bytes and HEAD unchanged.
3. Scrub list: superset of git rev-parse --local-env-vars from the installed git; GIT_CONFIG_KEY_0 /
   GIT_CONFIG_VALUE_0 and lower-case git_dir match; GIT_CONFIG_GLOBAL kept by repositoryGitEnv and replaced
   by fixtureGitEnv; GIT_AUTHOR_* present in fixtureGitEnv.
4. Preload: nested bun test (cwd repo root so bunfig preload loads, OCX_TEST_NO_QUEUE=1) of a temp probe file,
   launched with GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE set: the probe asserts process.env has none of them and a
   node:child_process execFileSync child's env has none; the run's stderr carries the warning with the names.
5. Guard unit: resolve for a .git directory and for a linked worktree (.git file + commondir); unchanged ->
   null; user.name added -> report naming user.name, then null on the next check (re-baseline); a branch
   section edit -> null; same-size same-mtime rewrite of a guarded value (utimesSync back) -> reported;
   config deleted -> missing report; garbage bytes -> parse report; values never appear in a report.
6. inspectChangedRun with env GIT_DIR=<other repo>/.git returns the fixture's merge base and changed file.
7. Guard wiring: the nested probe run with OCX_GIT_CONFIG_GUARD_CHECKOUT=<fixture>; its first case passes,
   its second writes user.name into the fixture config through an explicit-env git config and fails with the
   guard message; exit code 1, 1 pass / 1 fail.

## Verification (C)
- bun test tests/ci-workflows/test-git-isolation.test.ts: commit A red on 1, 2, 6; commit B all green.
- bun test <every modified test file>: 0 fail.
- Guard cost: one large file (tests/ci-workflows/test-runner.test.ts) timed with the guard and with
  OCX_GIT_CONFIG_GUARD_CHECKOUT pointing at a dir without .git (guard off); recorded.
- bun run typecheck, bun run structure:check, bun run privacy:scan, bun run test:changed: exit 0.
- bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts and the file-size ratchet test: 0 fail.
- Full bun run test if the host allows, else NOT RUN with reason; ci:full label on the PR.
- structure/ops/test-sandbox-cleanup.md gains "Git environment isolation"; the final terra review includes
  the scripts/ security pass (scripts/AGENTS.md:8).
