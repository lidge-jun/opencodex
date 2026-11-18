# wp3 — carry #8746: one empty global git config on every platform

Author: andrew05060414 (PR #8746, head 2d23f8619a, draft, only gate checks ran because it is a draft).

## Problem

`tests/helpers/git-fixture.ts` and `tests/helpers/git-config-guard.ts` set
`GIT_CONFIG_GLOBAL=NUL` on win32. Git for Windows 2.56 rejects it (`fatal: unable to access 'NUL':
Invalid argument`), so every fixture repository and the config guard fail on Windows.

## Diff (from the PR, rebased onto the base)

- MODIFY tests/helpers/git-fixture.ts: export `EMPTY_GLOBAL_GIT_CONFIG = "/dev/null"` with the
  reason (Git for Windows maps it in compat/mingw.c on open; a missing file is fatal for
  `git config --global --list`, so it is not a fallback); `fixtureGitEnv` uses it.
- MODIFY tests/helpers/git-config-guard.ts: import the constant; drop the local `NUL` branch.
- MODIFY tests/ci-workflows/test-git-isolation.test.ts: oracle env and assertion use the constant;
  NEW case runs the installed git with `fixtureGitEnv()` (`git config --global --list`) and
  requires exit 0, empty stderr and empty stdout.
- MODIFY devlog/_plan/261113_test_git_env_isolation/010_phase1.md: the one line naming the old value.

Commit carries `Co-authored-by: andrew05060414 <wsy1731095638@gmail.com>`; the lane PR lists
"Supersedes #8746".

## Verification

- `bun test tests/ci-workflows/test-git-isolation.test.ts`.
- The new case fails before the change only on a Windows git that rejects `NUL`; on macOS both
  sides pass, so the red run is the author's recorded Windows table (37 failures to 2). NOT RUN
  here: Windows.

