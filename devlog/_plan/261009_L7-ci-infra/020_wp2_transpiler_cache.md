# 020 — wp2: #6783 transpiler-cache isolation

PR title: `fix(test): keep the default Bun transpiler cache inside the test sandbox`
Branch `codex/l7-transpiler-cache`, worktree `.tmp/lanes/L7-ci-infra-2`, based on dev after
wp1 lands (or stacked on wp1 while it is open). Credit:
`Co-authored-by` 김상훈 (commit identity from the source PR).

## File change map (all from #6783 head `4b9952e72b`)

| Path | Kind | Change |
| --- | --- | --- |
| scripts/test.ts | MODIFY | :51-56 default cache under the exclusive `opencodex-test-*` root, created `mode 0o700`; :94-108 export and inherit it, clean only the owned root; :375-378 add ci-gui-typecheck-gate to `SERIAL_FULL_SUITE_FILES` |
| tests/ci-workflows/test-runner.test.ts | MODIFY | :391-536 cache isolation regressions (ownership/mode, independent caches, nested lifetime, explicit/empty/"0" overrides, untouched legacy dir and symlink, real Bun children) |
| structure/ops/cross-platform-ci.md | MODIFY | :75-84 cache ownership prose |
| tests/cli/cli-ready-subprocess.test.ts, tests/codex-integration/catalog-remote-pull.test.ts, tests/codex-integration/codex-shim-path-readiness.test.ts | MODIFY | warm-up hooks using the existing helper |
| tests/ci-workflows/ci-gui-typecheck-gate.test.ts, tests/ci-workflows/release-version-sources.test.ts, tests/ci-workflows/cold-spawn-warmup.test.ts | MODIFY | `INTERNAL_DEADLINE_MS` bounds and no-warm-up dispositions |
| tests/claude-integration/claude-desktop-first-party.test.ts | MODIFY | `expectStatus` diagnostic wrapper (merges with wp1's drain hunk) |

Excluded (already in wp1): the retry-aware cleanup hunks, `management-auth-fixture.ts`, the
history close.

## Build recipe

```sh
B2=$(git merge-base origin/dev refs/l7/pr6783)
git diff $B2 refs/l7/pr6783 -- scripts/test.ts tests/ci-workflows/test-runner.test.ts structure/ops/cross-platform-ci.md \
  tests/cli/cli-ready-subprocess.test.ts tests/codex-integration/catalog-remote-pull.test.ts \
  tests/codex-integration/codex-shim-path-readiness.test.ts tests/ci-workflows/ci-gui-typecheck-gate.test.ts \
  tests/ci-workflows/release-version-sources.test.ts tests/ci-workflows/cold-spawn-warmup.test.ts \
  tests/claude-integration/claude-desktop-first-party.test.ts | git apply --3way
```

## Acceptance

- Focused: `bun test --isolate tests/ci-workflows/test-runner.test.ts -t 'transpiler cache'`,
  `tests/ci-workflows/cold-spawn-warmup.test.ts`, typecheck, structure, privacy.
- Activation: the isolation test fails with the old `join(hostTemp, "ocx-test-bun-transpiler-cache")` default.
- Review focus: explicit overrides remain unchecked by design and may point at the legacy
  shared path; record this in the PR. Windows ACL of the cache directory is not newly verified.
- Hosted: exact-head CI green, including Linux, macOS and Windows test shards.
