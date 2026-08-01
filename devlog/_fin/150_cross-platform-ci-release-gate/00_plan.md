# 150.00 — Plan: Cross-Platform CI and Release Gate

## Goal

Add the smallest useful CI surface for opencodex:

- run typecheck and the existing Bun test suite on Linux and Windows;
- keep the Release workflow manual and publish-focused;
- require a successful Cross-platform CI run for the exact commit being released;
- keep `scripts/release.ts` compatible by waiting for that CI run after pushing a version bump;
- document the workflow change and verify it before push.

This phase is C4 because it changes release governance and npm publishing gates. The implementation
must stay intentionally small: no coverage, no docs build, no GUI build in normal CI, no macOS matrix,
and no remote Ubuntu/RDP smoke in CI.

## Sources Checked

- `structure/06_docs-and-release.md`
  - npm release is managed by `scripts/release.ts` and `.github/workflows/release.yml`.
  - docs deploy is separate from npm release publishing.
- `.github/workflows/release.yml`
  - manual `workflow_dispatch`;
  - version/package check;
  - npm Trusted Publishing through OIDC;
  - post-publish npm smoke;
  - GitHub release creation.
- `.github/workflows/deploy-docs.yml`
  - docs-only GitHub Pages workflow, intentionally separate.
- `scripts/release.ts`
  - clean main + typecheck;
  - bump package.json;
  - commit/push;
  - immediately dispatch Release and watch.
- `devlog/70_windows-linux-support/00_overview.md`
  - Windows/Linux support is an explicit project concern.
- `devlog/80_windows-codex-path-hardening/00_overview.md`
  - Codex path handling and service behavior need cross-platform protection.
- `devlog/mvp/65_npm-publish-ci/00_plan.md`
  - release flow is jawcode-style, manual dispatch plus OIDC Trusted Publishing.

## PABCD Cycle Map

### P — Plan

New:

- `.github/workflows/ci.yml`
- `devlog/150_cross-platform-ci-release-gate/00_plan.md`

Modify:

- `.github/workflows/release.yml`
- `scripts/release.ts`
- `structure/06_docs-and-release.md`
- commit note: `devlog/` is ignored by `.gitignore`, so this plan file must be staged with
  `git add -f devlog/150_cross-platform-ci-release-gate/00_plan.md` unless the ignore policy is
  deliberately changed. This phase will not change `.gitignore`.

Non-goals:

- no release workflow test rerun;
- no macOS CI initially;
- no GUI/docs build in normal CI;
- no coverage or E2E gates;
- no npm publish dry-run in normal CI.

### A — Plan Audit

Use a read-only auditor to check:

- the planned files exist where expected, except the new CI/devlog files;
- `scripts/release.ts` can safely call GitHub CLI and parse run status;
- release workflow can use `GH_TOKEN` and read Actions metadata;
- the Release workflow will not publish without successful CI for `GITHUB_SHA`;
- the helper script will not race by dispatching Release before CI has completed.

### B — Build

#### New `.github/workflows/ci.yml`

Create a single cross-platform CI workflow:

- name: `Cross-platform CI`;
- triggers:
  - `pull_request` to `main`;
  - `push` to `main`;
  - `workflow_dispatch`;
- path filters for code/test/package/workflow files only;
- permissions: `contents: read`;
- concurrency: cancel superseded runs per ref;
- matrix:
  - `ubuntu-latest`;
  - `windows-latest`;
- timeout: 8 minutes;
- steps:
  - checkout;
  - setup Bun latest;
  - `bun install --frozen-lockfile`;
  - `bun x tsc --noEmit`;
  - `bun test tests`;
  - `bun build scripts/release.ts --target=bun --outdir=.tmp/ci-release-script-check`;
  - `bun run src/cli.ts help` CLI entrypoint smoke.

#### Modify `.github/workflows/release.yml`

Add a pre-publish job/step that:

- runs before npm publish;
- rejects non-`main` refs;
- grants `actions: read` because the explicit workflow token permissions otherwise cannot read
  workflow run metadata;
- sets `GH_TOKEN: ${{ github.token }}` on the gate step because the later GitHub release step's
  environment is step-local and is not inherited;
- uses `gh run list --workflow ci.yml --commit "$GITHUB_SHA" --status success`;
- requires at least one successful `Cross-platform CI` run for exactly `GITHUB_SHA`;
- prints the matching CI run URL for auditability;
- does not run tests itself.

Keep the existing:

- manual inputs;
- version/package match check;
- npm Trusted Publishing;
- npm registry smoke;
- GitHub release creation.

#### Modify `scripts/release.ts`

Keep the existing local `bun x tsc --noEmit` preflight. After pushing the release commit:

- resolve `HEAD`;
- poll GitHub Actions for `ci.yml` runs on that SHA;
- wait until success before dispatching Release;
- fail if any matching CI run completes with a non-success conclusion;
- before dispatch, verify `origin/main` still points to the same release SHA;
- dispatch with `gh workflow run release.yml --ref main ...` only after that SHA check;
- fail after a bounded timeout instead of dispatching an unsafe Release.

This keeps the existing helper usable while preserving the invariant that Release only publishes a
CI-passed commit.

#### Modify `structure/06_docs-and-release.md`

Record the maintained rule:

- Cross-platform CI is the ordinary quality gate;
- Release is manual and publish-only;
- Release requires a successful Cross-platform CI run for the release commit;
- docs deploy remains separate.

### C — Check

Local checks:

- `bun x tsc --noEmit`
- `bun test tests`
- `bun build scripts/release.ts --target=bun --outdir=.tmp/ci-release-script-check`
- `bun run src/cli.ts help`
- YAML presence/structure review:
  - `.github/workflows/ci.yml`
  - `.github/workflows/release.yml`
- release helper syntax/bundling compatibility through the Bun build smoke above. Root
  `bun x tsc --noEmit` intentionally checks `src/` only and does not typecheck `scripts/`.

Remote checks after push:

- push `main`;
- confirm GitHub `Cross-platform CI` run starts for the pushed commit;
- watch it to success;
- verify `Release` is still manually dispatchable and now has the CI gate.

If the Cross-platform CI run is still running when local work completes, register it as a
server-owned `cli-jaw bgtask` instead of leaving an in-flight process attached to the turn.

### D — Done

Record:

- files changed;
- local verification output;
- GitHub Actions run URL/result;
- final git status;
- any residual limitation.

Expected residual limitation:

- macOS is intentionally not in CI yet. Add it only if a future macOS-only break escapes local
  development or the project starts shipping native macOS-specific behavior.
