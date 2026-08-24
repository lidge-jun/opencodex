# Fork Sync Action Daily-Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**SDD:** GPT 5.6 Luna implementers and reviewers execute these tasks
sequentially. Every production change follows RED → GREEN → REFACTOR, and
each logical unit receives its own conventional commit.

**Goal:** Keep the fork's trusted scripts available while the Action pins
upstream refs, mechanically prepares daily merge PRs, and escalates only
shared-hotspot or disconnected-history cases.

**Architecture:** The pin module updates local vendor refs with an explicit
fetch refspec and never changes `HEAD`. Ownership and package-recipe modules
provide pure conflict policy. The prepare command performs an injected,
observable Git sequence; the injected-fetch PR client owns draft PR
create/update; the workflow gates those commands and emits constrained
handoffs.

**Tech Stack:** Bun-native TypeScript, `bun:test`, GitHub REST `fetch`,
GitHub Actions YAML, and JSON package metadata.

## Global Constraints

- Work on `feat/fork-sync-action-merge` created from current `main`.
- Do not edit the approved plan at `/Users/user/.cursor/plans/fork_action_merge_49995033.plan.md`.
- Pin with `git fetch . <target>:refs/heads/<ref>`; never `git switch` or checkout to pin.
- Preserve `name: "@yansigit/opencodex"` and take `version` plus all other package fields from upstream.
- Daily prepare handles only `pin-updated` / `main-behind` with `recommendedLane: "daily-merge"`.
- Abort conflicted merges containing a `shared-hotspot`; never push a conflicted branch.
- Draft PRs target `main`; the client has no merge operation.
- Never use `gh pr merge`, `--force`, `git merge -X`, or `git push origin main`.
- Tests use injected `CommandRunner`, `ProcessRunner`, and `fetch`; no test mutates a real repository.
- Run only focused `bun test tests/fork/...` checks during implementation; do not run the full monorepo suite.

---

### Task 0: Land the design artifacts first

**Files:**
- Create: `docs/superpowers/specs/2026-08-24-fork-sync-action-merge-design.md`
- Create: `docs/superpowers/plans/2026-08-24-fork-sync-action-merge.md`

**Interfaces:** The spec locks `PathClass`, `PrepareResult`, and
`pinVendorRef(ref, target, runner)`, and records the existing `SyncEvent`,
`CommandRunner`, and injected-fetch boundaries.

- [x] **Step 1: Write the addendum spec** with the daily-merge state machine,
  ownership classes, package recipe, workflow permissions, PR safety, and
  verification requirements.
- [x] **Step 2: Write this plan** with exact paths, TDD checkboxes, commands,
  expected failures, and conventional commit boundaries.
- [ ] **Step 3: Self-review both documents** against the approved interfaces;
  confirm the 2026-08-22 spec remains unchanged and search this plan for
  `TBD`, `TODO`, or undefined function names.
- [ ] **Step 4: Commit the artifacts**

Run:
```bash
git add docs/superpowers/specs/2026-08-24-fork-sync-action-merge-design.md \
  docs/superpowers/plans/2026-08-24-fork-sync-action-merge.md
git commit -m "docs: specify fork sync action merge"
```
Expected: one commit containing only the new addendum and plan.

### Task 1: Pin vendor refs without moving HEAD

**Files:**
- Modify: `scripts/fork/sync/pin.ts`
- Modify: `tests/fork/sync-pin.test.ts`
- Modify: `tests/fork/sync-cli.test.ts`

**Interfaces:**
- Consumes: `CommandRunner`, `SyncEvent`, `ALLOWED_VENDOR_REFS`.
- Produces: `pinVendorRef(ref: string, target: string, runner: CommandRunner): Promise<void>` and the existing `pinVendorRefs`.

- [ ] **Step 1: Replace pin tests first.** Assert the exact calls
  `["fetch", ".", target, "refs/heads/vendor/main"]` and
  `["fetch", ".", target, "refs/heads/vendor/dev"]`, assert no `switch`,
  assert a non-fast-forward fetch becomes `pin-diverged`, and assert the CLI
  captures `HEAD` before pinning and never changes it.
- [ ] **Step 2: Run the focused red tests**

Run: `bun test tests/fork/sync-pin.test.ts tests/fork/sync-cli.test.ts`
Expected: FAIL because the old implementation emits `switch` and `merge`.
- [ ] **Step 3: Implement the minimal pin boundary.** Keep the allowlist,
  call `runner(["fetch", ".", target, "refs/heads/" + ref])`, throw on a
  non-zero result, and retain existing event error sanitization.
- [ ] **Step 4: Run the focused green tests** with the same command.
  Expected: PASS with no checkout command in the captured sequence.
- [ ] **Step 5: Commit**

Run: `git add scripts/fork/sync/pin.ts tests/fork/sync-pin.test.ts tests/fork/sync-cli.test.ts && git commit -m "fix: pin fork refs without checkout"`

### Task 2: Add ownership classification and package recipe

**Files:**
- Create: `scripts/fork/sync/ownership.ts`
- Create: `scripts/fork/sync/recipes/package-json.ts`
- Modify: `docs/fork/OWNED.md`
- Create or modify: `tests/fork/sync-ownership.test.ts`

**Interfaces:**
- Produces: `classifyPath(path: string): PathClass`,
  `isSharedHotspot(path: string): boolean`, and
  `mergePackageJson(ours: string, theirs: string): string`.
- The recipe parses both JSON strings, takes `theirs.version` and all
  non-name fields, restores `name: "@yansigit/opencodex"`, and returns
  two-space formatted valid JSON ending in a newline.

- [ ] **Step 1: Write failing table tests** for every `OWNED.md` prefix, each
  hotspot file, `package.json`, and an unknown path. Add a v2.32.0 fixture
  asserting the output preserves `@yansigit/opencodex`, takes `2.32.0`, and
  takes upstream scripts/dependencies/metadata.
- [ ] **Step 2: Run the red ownership suite**

Run: `bun test tests/fork/sync-ownership.test.ts`
Expected: FAIL because the classifier and recipe modules do not exist.
- [ ] **Step 3: Implement the ordered classifier and recipe.** Keep the
  hotspot check before broad fork prefixes, use `upstream-owned` as the
  unknown default, and make malformed JSON throw without writing output.
- [ ] **Step 4: Extend `docs/fork/OWNED.md`** with the `package.json` recipe
  row and the exact identity/version policy.
- [ ] **Step 5: Run the green suite**

Run: `bun test tests/fork/sync-ownership.test.ts`
Expected: PASS.
- [ ] **Step 6: Commit**

Run: `git add scripts/fork/sync/ownership.ts scripts/fork/sync/recipes/package-json.ts docs/fork/OWNED.md tests/fork/sync-ownership.test.ts && git commit -m "feat: add fork ownership recipes"`

### Task 3: Add the injected daily prepare command

**Files:**
- Create: `scripts/fork/sync/prepare.ts`
- Modify: `scripts/fork/sync/cli.ts`
- Create: `tests/fork/sync-prepare.test.ts`
- Modify: `tests/fork/sync-cli.test.ts`

**Interfaces:**
- Consumes: `SyncEvent`, `CommandRunner`, and `classifyPath`.
- Produces:
  `prepareSync(event: SyncEvent, options: { runner: CommandRunner; now?: () => Date }): Promise<PrepareResult>`.

- [ ] **Step 1: Write failing prepare tests** for no-conflict daily merge,
  fork-owned ours resolution, upstream-owned theirs resolution,
  `package.json` recipe resolution, shared-hotspot abort, history-diverged
  skip, and exact UTC branch naming from `detectedAt`. The fake runner must
  record arguments and return queued `CommandResult` values.
- [ ] **Step 2: Run the red prepare tests**

Run: `bun test tests/fork/sync-prepare.test.ts tests/fork/sync-cli.test.ts`
Expected: FAIL because `prepareSync` and CLI dispatch do not exist.
- [ ] **Step 3: Implement the minimal command sequence.** For a daily event
  run `switch -c sync/upstream-YYYYMMDD`, `merge --no-ff vendor/main`,
  `diff --name-only --diff-filter=U`, per-path checkout/add or recipe/add,
  and `commit` only when the injected Git sequence requires it. On a hotspot,
  run `merge --abort` and return `hotspot-handoff`; never call push.
- [ ] **Step 4: Add `prepare` CLI stdin parsing** and JSON output, and preserve
  existing `detect`, `pin`, and `emit` behavior.
- [ ] **Step 5: Run the green focused suites**

Run: `bun test tests/fork/sync-prepare.test.ts tests/fork/sync-cli.test.ts`
Expected: PASS.
- [ ] **Step 6: Commit**

Run: `git add scripts/fork/sync/prepare.ts scripts/fork/sync/cli.ts tests/fork/sync-prepare.test.ts tests/fork/sync-cli.test.ts && git commit -m "feat: prepare daily fork sync merges"`

### Task 4: Add the draft pull-request client

**Files:**
- Create: `scripts/fork/sync/pull-request.ts`
- Modify: `scripts/fork/sync/types.ts`
- Create: `tests/fork/sync-pull-request.test.ts`

**Interfaces:**
- Produces:
  `createDraftPullRequestClient(options: { repository: string; token: string; fetchImpl: FetchImplementation }): DraftPullRequestClient`.
- `DraftPullRequestClient.upsert(input: { event: SyncEvent; result: PrepareResult }): Promise<number>`.
- REST calls use `POST /repos/{repository}/pulls` for create and
  `PATCH /repos/{repository}/pulls/{number}` for update; no merge method or
  merge endpoint is exposed.

- [ ] **Step 1: Write failing HTTP tests** for create, same-tag/head update,
  `draft: true`, `base: "main"`, resolution-table body, and absence of
  secret/token logging. Assert request paths and methods never contain
  `/merge`.
- [ ] **Step 2: Run the red PR suite**

Run: `bun test tests/fork/sync-pull-request.test.ts`
Expected: FAIL because the client module and type are missing.
- [ ] **Step 3: Implement injected REST calls** with sanitized thrown errors,
  public body construction from tag SHA and resolution records, and lookup of
  an open matching sync PR before deciding create/update.
- [ ] **Step 4: Run the green PR suite**

Run: `bun test tests/fork/sync-pull-request.test.ts`
Expected: PASS.
- [ ] **Step 5: Commit**

Run: `git add scripts/fork/sync/pull-request.ts scripts/fork/sync/types.ts tests/fork/sync-pull-request.test.ts && git commit -m "feat: create fork sync draft pull requests"`

### Task 5: Wire workflow handoff, skill, prompt, and contract tests

**Files:**
- Modify: `.github/workflows/fork-upstream-sync.yml`
- Modify: `scripts/fork/sync/cli.ts`
- Modify: `.cursor/skills/opencodex-fork-sync/SKILL.md`
- Modify: `.cursor/skills/opencodex-fork-sync/automation-prompt.md`
- Modify: `tests/fork/sync-workflow.test.ts`
- Modify: `tests/fork/sync-webhook.test.ts` if event gating needs coverage

**Interfaces:** The workflow calls `pin`, then `prepare` for daily lanes, then
the draft PR client for `merged` results, and calls `emit` with a public event
plus `prepareStatus`. Cursor webhook selection is limited to
`hotspot-handoff` and `history-diverged`.

- [ ] **Step 1: Write failing workflow and handoff tests** requiring
  `pull-requests: write`, a default-branch HEAD assertion, prepare invocation,
  sync-branch-only push, draft PR invocation, and cursor gating. Keep
  forbidden regexes for `gh pr merge`, `--force`, `git merge -X`, and
  `git push origin main`.
- [ ] **Step 2: Run the red contract tests**

Run: `bun test tests/fork/sync-workflow.test.ts tests/fork/sync-cli.test.ts`
Expected: FAIL because permissions and prepare/PR handoff are absent.
- [ ] **Step 3: Implement the workflow contract** with `contents: write`,
  `issues: write`, and `pull-requests: write`; keep secrets scoped to emit;
  push only `sync/upstream-*`; and use conditions for hotspot/history webhook
  escalation.
- [ ] **Step 4: Update the skill and prompt** to state that the Action owns
  mechanical daily merge and Cursor starts only for hotspot/emergency
  handoff. Explicitly preserve the human merge-commit stop.
- [ ] **Step 5: Run the green contract suites**

Run: `bun test tests/fork/sync-workflow.test.ts tests/fork/sync-cli.test.ts`
Expected: PASS.
- [ ] **Step 6: Commit**

Run: `git add .github/workflows/fork-upstream-sync.yml scripts/fork/sync/cli.ts .cursor/skills/opencodex-fork-sync/SKILL.md .cursor/skills/opencodex-fork-sync/automation-prompt.md tests/fork/sync-workflow.test.ts tests/fork/sync-cli.test.ts && git commit -m "ci: automate fork sync daily merge handoff"`

### Task 6: Verify the branch and record the handoff

**Files:**
- Create or modify: `.superpowers/sdd/progress.md`

- [ ] **Step 1: Run all focused fork tests**

Run: `bun test tests/fork/sync-pin.test.ts tests/fork/sync-cli.test.ts tests/fork/sync-ownership.test.ts tests/fork/sync-prepare.test.ts tests/fork/sync-pull-request.test.ts tests/fork/sync-workflow.test.ts`
Expected: PASS.
- [ ] **Step 2: Run repository-required static checks**

Run: `bun run typecheck`
Expected: PASS.

Run: `bun run privacy:scan`
Expected: PASS with no credentials, tokens, request bodies, or account IDs
reported.
- [ ] **Step 3: Inspect safety and status**

Run: `git diff --check && git status --short --branch`
Expected: no whitespace errors, feature branch checked out, and only intended
changes present.
- [ ] **Step 4: Record completed task IDs and commit subjects** in
  `.superpowers/sdd/progress.md`; do not push unless a normal non-force push is
  available, and do not open or merge a PR from this implementation session.
