# 010 — Land PR #130: pre-push hook matching the CI gate

Work-phase: `wp1-pr130-tooling`. One full PABCD cycle. Diff source: `diffs/pr130.patch`.

## What the PR does (2 commits)

1. `21c459b4` tooling: pre-push hook
   - `CONTRIBUTING.md` +12: documents `bun run setup:hooks` one-liner.
   - `package.json` scripts: adds `"prepush": "bun run typecheck && bun run test"` and
     `"setup:hooks": "bun scripts/setup-hooks.ts"` after `release:watch`.
   - `scripts/pre-push.sh` (new, 6 lines): `#!/usr/bin/env sh`, `set -e`,
     `bun run typecheck` then `bun run test`. No trailing newline.
   - `scripts/setup-hooks.ts` (new, 37 lines): copies `scripts/pre-push.sh` to
     `.git/hooks/pre-push`, chmod 755 (try/catch for Windows). Guards on `.git` existing.
     NOTE: file begins with a UTF-8 BOM (`\uFEFF`) before `/**` — strip when landing.
2. `1f55000b` test: skip symlink test on Windows without elevated rights (EPERM catch in
   `tests/claude-agents-inject.test.ts` lines ~89-100).

## Landing plan (B phase)

1. `git fetch origin pull/130/head:pr-130 && git merge --no-ff pr-130` onto `dev`
   (preserve contributor SHAs so GitHub auto-marks the PR merged when main is pushed).
2. Conflicts expected: none (dev==main). `tests/claude-agents-inject.test.ts` hunk is
   isolated from #128/#129 hunks in the same file — this PR lands first anyway.
3. Stacked fixes (our commits on top, locked from Chandrasekhar review):
   - `scripts/setup-hooks.ts`: resolve hooks dir via
     `git rev-parse --path-format=absolute --git-path hooks` (worktree/core.hooksPath
     safe); deterministic overwrite policy: if an existing pre-push differs from the
     managed hook, ALWAYS move it to `pre-push.backup-<unix-ts>` (never overwrite an
     existing backup — timestamped names are unique), then install; identical content
     -> no-op; strip BOM; trailing newline.
   - `scripts/pre-push.sh`: body becomes `exec bun run prepush` (single source of truth
     in package.json); trailing newline.
   - `package.json`: `prepush` = `bun run typecheck && bun run test && bun run privacy:scan`
     (privacy:scan is part of the CI gate and cheap).
   - `tests/claude-agents-inject.test.ts`: capability detection (probe symlink creation
     in a temp dir at describe setup) + Bun explicit conditional skip
     (`test.skipIf(!canSymlink)(...)`) so the runner reports a visible skip, not a pass.
   - `CONTRIBUTING.md` + script comments: reword "matching the CI gate" ->
     "runs the typecheck, unit-test, and privacy-scan portions of the CI gate".
   - Do NOT add a `prepare` lifecycle (bun install would silently mutate git config).

## Verification (C phase)

- `bun test --isolate ./tests/` green, `bun run typecheck` green.
- `bun run setup:hooks` installs an executable `.git/hooks/pre-push`; hook fires on a
  no-op push attempt (or run the shim directly).
- Installer matrix verification: (a) linked worktree (`git worktree add`) resolves the
  worktree-correct hooks dir; (b) `git -c core.hooksPath=<dir>` install lands in that
  dir; (c) repeated setup is a no-op; (d) pre-existing differing hook is preserved as
  `pre-push.backup-<ts>` and the managed hook installed.
- Commit(s) on dev; goalplan task/criterion evidence updated.
