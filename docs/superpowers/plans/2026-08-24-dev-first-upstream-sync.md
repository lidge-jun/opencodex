# Dev-First Upstream Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route upstream release-tag syncs through `dev` while keeping the workflow's trusted automation scripts sourced from `main`.

**Architecture:** The workflow keeps a trusted checkout of the default branch and creates a detached worktree from `origin/dev` for all sync mutations. The generated sync PR targets `dev`; stable promotion and release remain exclusively on `main`.

**Tech Stack:** GitHub Actions, Bun TypeScript, Git worktrees, Bun tests.

**Spec:** The approved audit design in the conversation: upstream release tag → sync PR to `dev` → nightly; `dev` → promotion PR → `main` → stable release.

## Global Constraints

- Never run sync scripts loaded from the mutable integration worktree when write-capable workflow credentials are present.
- Never let the sync workflow push or open a PR targeting `main`.
- Preserve the existing release-tag sync semantics; upstream-tip syncing is a separate future change.
- Do not overwrite the fork's package name or published version policy with upstream metadata blindly.
- Use focused tests before implementation and run the repository-required release/workflow checks before completion.

---

### Task 1: Lock the dev-target contract with tests

**Files:**
- Modify: `tests/fork/sync-pull-request.test.ts`
- Modify: `tests/fork/sync-workflow.test.ts`
- Modify: `tests/fork/sync-prepare.test.ts`
- Create: `tests/fork/sync-package-json.test.ts`

**Interfaces:**
- `createDraftPullRequestClient()` must create and query PRs with base `dev`.
- `prepareSync()` must derive collision-safe branch names containing upstream identity.
- The workflow contract must require a trusted checkout plus an `origin/dev` worktree and forbid main-targeted sync operations.

- [x] **Step 1: Write failing assertions** for `base=dev`, `base: "dev"`, dev ancestry, worktree setup, and collision-safe branch naming.
- [x] **Step 2: Run the focused sync tests and confirm they fail for the current main-targeted implementation.**

```bash
bun test tests/fork/sync-pull-request.test.ts tests/fork/sync-workflow.test.ts tests/fork/sync-prepare.test.ts
```

- [x] **Step 3: Add package recipe cases proving fork version metadata is not silently replaced by upstream version metadata.**
- [x] **Step 4: Run the new package recipe test and confirm it fails against the current recipe.**

### Task 2: Implement trusted-main/dev-worktree preparation

**Files:**
- Modify: `.github/workflows/fork-upstream-sync.yml`
- Modify: `scripts/fork/sync/cli.ts`
- Modify: `scripts/fork/sync/prepare.ts`

**Interfaces:**
- The workflow supplies `FORK_SYNC_WORKTREE` pointing at a detached worktree based on `origin/dev`.
- The CLI runs trusted modules from the main checkout while Git and file writes operate in the supplied worktree.
- `prepareSync()` produces `sync/upstream-<tag-slug>-<sha>` branches from the integration worktree.

- [x] **Step 1: Add the minimal worktree-aware CLI behavior and workflow setup.**
- [x] **Step 2: Run the focused workflow and prepare tests.**
- [x] **Step 3: Keep vendor refs pushed from the trusted repository and assert the trusted checkout remains on its original ref.**

### Task 3: Route PR validation and messaging to dev

**Files:**
- Modify: `scripts/fork/sync/pull-request.ts`
- Modify: `.github/workflows/fork-pr-mergeable.yml`
- Modify: `scripts/fork/sync/notifiers/github-issue.ts`
- Modify: `scripts/fork/sync/coordinators/cli.ts`
- Modify: `scripts/fork/sync/types.ts`
- Modify: related sync tests under `tests/fork/`

**Interfaces:**
- Sync PR creation and lookup use `dev`.
- Mergeability checks validate ancestry against `origin/dev`.
- Human-facing sync actions say “merge upstream into dev”.
- Existing event kinds remain wire-compatible unless a rename is required by tests; if retained, `main-behind` must no longer be presented as a user-facing main-target instruction.

- [x] **Step 1: Update failing PR, workflow, notifier, and coordinator expectations.**
- [x] **Step 2: Implement the smallest dev-targeted changes.**
- [x] **Step 3: Run all `tests/fork/sync-*.test.ts` tests.**

### Task 4: Preserve fork version policy during sync

**Files:**
- Modify: `scripts/fork/sync/recipes/package-json.ts`
- Modify: `tests/fork/sync-ownership.test.ts`
- Create or modify: focused package-version helper tests near release tooling

**Interfaces:**
- Upstream package metadata remains the source for ordinary package fields.
- Fork identity remains authoritative for package name and release version.
- Upstream sync preserves the fork's current version; stable version selection remains the explicit release authority in `scripts/release.ts`.

- [x] **Step 1: Add a failing regression test for preserving the fork release version.**
- [x] **Step 2: Implement the minimal recipe change.**
- [x] **Step 3: Run the focused package recipe tests; stable release allocation remains covered by the existing release tests.**

### Task 5: Verify the complete change

**Files:**
- No new production files.

- [x] **Step 1: Run all focused fork-sync tests.**
- [x] **Step 2: Run `bun run typecheck`.**
- [ ] **Step 3: Run `bun run prepush` because this changes release and repository automation (blocked by unrelated full-suite loopback-port contention in the environment).**
- [x] **Step 4: Inspect the final workflow diff for permissions, branch targets, secret scope, and exact-SHA behavior.**
