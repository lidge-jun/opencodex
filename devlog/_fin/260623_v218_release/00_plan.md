# 2026-06-23 v2.1.8 Release Plan

## Objective

Release the PR #16/#22 integration from `dev` to `main` as `@bitkyc08/opencodex@2.1.8`.

The release must:

- Re-verify `dev` after the PR #16/#22 integration.
- Fast-forward or merge `dev` into `main`.
- Use the repository release helper, not ad-hoc publish commands.
- Publish `@bitkyc08/opencodex@2.1.8` with npm trusted publishing via GitHub Actions.
- Verify npm, Git tag, GitHub Release, CI, and branch synchronization.
- Resync `dev` to the release commit after the release helper creates `release: v2.1.8`.

## Current State

- Repository: `/Users/jun/Developer/new/700_projects/opencodex`
- Current branch at planning time: `dev`
- `origin/dev`: `3a8852cb77037d2f70e5f0c2e3ebe3721140495f`
- Local `dev` includes this release-plan evidence commit after `origin/dev` and should be included in
  the release branch unless a later audit finds a release-blocking reason to exclude docs-only
  evidence.
- `main` / `origin/main`: `241e3277a7c0d7e76729a7ac6794a0851d52f9ea`
- `package.json` version: `2.1.7`
- Next release version: `2.1.8`
- Preflight metadata:
  - `npm view @bitkyc08/opencodex@2.1.8 version`: not found.
  - `git ls-remote origin refs/tags/v2.1.8`: no tag output.
  - `gh release view v2.1.8`: release not found.
- Open PR list: empty after PR #16 and #22 closeout.

## Planned PABCD Work

### P: Plan

Create this devlog plan and record the release target/version.

### A: Audit

Dispatch a read-only plan auditor to verify:

- `2.1.8` is the correct next patch after `2.1.7`.
- `scripts/release.ts` is still the correct release path.
- Release preflight should include local full tests, docs build, GUI build, CI, and metadata availability.
- No release-blocking open PRs remain.

### B: Build / Release Execution

1. Re-verify on `dev`:
   - `bun run typecheck`
   - `bun test tests`
   - `bun run build:gui`
   - `cd docs-site && bun install --frozen-lockfile && bun run build`
   - `git diff --check`
   - Capture `git rev-parse dev origin/dev main origin/main` so the release log records the exact
     source and target commits.
2. Merge `dev` to `main`:
   - Ensure clean tree.
   - Push local `dev` first if it contains release-plan or result evidence commits that are not yet
     on `origin/dev`.
   - Checkout `main`.
   - Fast-forward `main` to the actual verified local `dev` HEAD.
   - Push `origin/main`.
3. Wait for `main` Cross-platform CI on the actual pushed `main` HEAD computed after the
   fast-forward/merge. Do not hardcode `3a8852c`; that commit is only the pre-plan
   `origin/dev` baseline.
4. Release:
   - Run `bun scripts/release.ts 2.1.8 --publish` from clean `main`.
   - Let the helper bump `package.json`, commit `release: v2.1.8`, push `main`, wait for CI, dispatch release workflow, and watch the workflow.
5. Verify release metadata:
   - `npm view @bitkyc08/opencodex@2.1.8 version`
   - `git ls-remote origin refs/tags/v2.1.8`
   - `gh release view v2.1.8 --json tagName,targetCommitish,url`
6. Resync `dev`:
   - Fast-forward `dev` to the `release: v2.1.8` commit from `main`.
   - Push `origin/dev`.

### C: Check

Final checks:

- `git status --short --branch`
- `git rev-parse main origin/main dev origin/dev`
- `gh run list` for release commit CI success.
- `gh run list --workflow release.yml` for publish workflow success.
- `npm view @bitkyc08/opencodex version` returns `2.1.8`.
- `gh release view v2.1.8` exists.

### D: Done

Record the final result in `devlog/_plan/260623_v218_release/10_result.md` before release if it can be
completed without speculative evidence; otherwise keep post-release evidence in `cli-jaw goal update`
and memory so `dev` does not drift ahead of the published `main` release commit. Pause the goal only
after an independent final objective review returns DONE.

## Expected File Changes

### NEW

- `/Users/jun/Developer/new/700_projects/opencodex/devlog/_plan/260623_v218_release/00_plan.md`
- `/Users/jun/Developer/new/700_projects/opencodex/devlog/_plan/260623_v218_release/10_result.md`
  - Create before the release only if its content can be factual and non-speculative; otherwise use
    goal evidence/memory for post-release facts to keep `main` and `dev` synchronized at the release
    commit.

### MODIFY

- `/Users/jun/Developer/new/700_projects/opencodex/package.json`
  - version `2.1.7` -> `2.1.8`
  - This change should be created by `scripts/release.ts`.

## Risks

- Release workflow could fail after npm publish. Mitigation: `scripts/release.ts` checks npm, tag, and GitHub Release are unused before publishing.
- `origin/main` could move while waiting for CI. Mitigation: compute the pushed main HEAD after the
  merge, wait for CI on that exact SHA, and let the release helper abort if remote main no longer
  equals the release commit.
- Docs build is not part of CI. Mitigation: run `docs-site` build locally before main merge/release.
- GUI build is not in full local test by default. Mitigation: run `bun run build:gui` before release and rely on CI GUI build smoke after push.
- npm trusted publishing may fail due GitHub/npm configuration. Mitigation: do not use token fallback unless the trusted publishing failure proves it is necessary; report exact failure.

## Completion Criteria

- `origin/main` includes PR #16/#22 integration and `release: v2.1.8`.
- `origin/dev` is synchronized to the same release commit.
- npm latest resolves to `@bitkyc08/opencodex@2.1.8`.
- Git tag `v2.1.8` exists.
- GitHub Release `v2.1.8` exists.
- Cross-platform CI succeeded for the release commit.
- Release workflow succeeded.
- PABCD reaches D and independent final reviewer returns DONE.
