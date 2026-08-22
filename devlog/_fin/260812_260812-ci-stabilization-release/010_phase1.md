# 010 — freeze, gate, promote, publish, converge

## MODIFY / NEW / DELETE map

- NEW `devlog/_fin/260812_260812-ci-stabilization-release/{000_plan.md,010_phase1.md}`
  - Before: no durable record for this train.
  - After: exact release scope, gate evidence, recovery path, and outcome ledger.
- MODIFY remote `preview`
  - Before: `f0306192e`, package `2.12.0-preview.20260810`.
  - After: merge selected RC as an independent sibling, then a release-helper
    commit setting `package.json` to `2.13.0-preview.20260812`.
- MODIFY remote `main`
  - Before: `6d881db20`, package `2.12.0`.
  - After: merge the same selected RC independently, then a release-helper
    commit setting `package.json` to `2.13.0`.
- MODIFY remote `dev`
  - Before: selected RC still carries the integration-line metadata inherited
    from its history.
  - After: explicit stable-version convergence commit after both publications.
- NEW public artifacts
  - npm `@bitkyc08/opencodex@2.13.0-preview.20260812` with `preview` dist-tag.
  - npm `@bitkyc08/opencodex@2.13.0` with `latest` dist-tag.
  - Git tags and GitHub Releases at the exact preview/stable release commits.
- MODIFY `.github/workflows/ci.yml`
  - Before: the `gates` Typecheck step runs only
    `bun x tsc --noEmit -p tests/tsconfig.doctor-service-memory-contract.json`.
  - After: it runs `bun x tsc --noEmit` first, then the narrow doctor-contract
    typecheck. A failure in either command fails the job.
  - Before: GUI tests run all 138 files in one Bun realm with
    `cd gui && bun test tests`, producing order-dependent shared-state failures.
  - After: run `cd gui && bun test --isolate tests`; every file gets a fresh
    realm and the same 771 tests pass under `CI=true` on Linux.
- MODIFY `tests/ci-workflows.test.ts`
  - Before: no structural assertion prevents a focused tsconfig from replacing
    the repository-wide typecheck.
  - After: assert the gates job contains both commands in that order and does
    not collapse the root check into a `-p` invocation.
  - Assert the GUI gates command includes `--isolate`, and that no gates step
    retains the unisolated exact command.

No runtime, GUI, auth, or dependency source is planned for modification. The
workflow/test guard above is the only source change admitted by the audit. Any
other repeat-gate failure returns to P/A with a separately reviewed fix.

## Execution details

1. Implement the two admitted CI fixes and their structural regression tests.
2. Run focused/full local verification and explicit independent security review
   of the workflow diff; resolve every blocker before push.
3. Commit and push to `dev`, then re-fetch live branch tips and freeze that new
   exact `origin/dev` head as the RC.
4. Require two complete successful Cross-platform CI attempts on that SHA,
   inspecting attempt 1 and attempt 2 separately. Dispatch and require exact-SHA
   Service lifecycle success.
5. Create clean temporary worktrees from live `origin/preview` and `origin/main`.
6. Merge the RC independently into each branch, install root and GUI
   dependencies, push the merge, and wait for exact-SHA gates.
7. Run `bun scripts/release.ts <version> --publish` on preview, then stable.
8. Verify npm, git tags, GitHub Releases, workflow conclusions, and ancestry.
9. Converge `dev` to stable metadata without merging either release bump into
   its sibling; push and verify final dev CI.

## Failure recovery

- If `origin/dev` moves before RC freeze, select the new live head and restart
  both RC gates.
- If a promotion target moves, discard the temporary promotion commit and
  rebuild from the new live target; never force-push.
- If the helper pushed a version bump and then stopped, verify the remote SHA is
  unchanged and both required workflows succeeded. Rerun only the failed gate
  once, then dispatch `release.yml` with explicit `version`, `tag`,
  `dry-run=false`, and exact `expected-sha` instead of rerunning the helper.
- If publication is partial, stop and inspect npm version, dist-tag, git tag,
  GitHub Release, and release workflow before choosing a new version or repairing
  metadata.

## Verification (C)

- `gh run view <run> --attempt <1|2> --json headSha,event,status,conclusion,jobs`
  → exact SHA, attempt-specific push evidence, aggregate success.
- `gh workflow run service-lifecycle.yml --ref dev` followed by exact-SHA run
  inspection → success.
- `git merge-base --is-ancestor <rc> origin/preview` → exit 0.
- `git merge-base --is-ancestor <rc> origin/main` → exit 0.
- `bun run audit:high`, `bun x tsc --noEmit`, `bun test --isolate tests`, and
  `bun run privacy:scan` in clean release worktrees → exit 0.
- `npm view @bitkyc08/opencodex dist-tags --json` → preview/stable intended values.
- `git ls-remote origin refs/heads/{dev,preview,main} refs/tags/v2.13.0*` and
  `gh release view <tag>` → exact release SHAs and published assets.
