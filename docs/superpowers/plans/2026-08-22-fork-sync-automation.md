# Fork Sync Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fork-owned, plugin-based release-tag sync that fast-forwards only
the two vendor refs, records every non-no-op event, and asks a Cursor
Automation to prepare—not land—the `origin/main` rebuild.

**Architecture:** Small Bun TypeScript modules under `scripts/fork/sync/` own
pure policy and injected command/HTTP boundaries. The workflow checks out its
default branch, invokes the CLI, and supplies only the required GitHub and
Cursor credentials. Detection and pinning produce a `SyncEvent`; registries
then route that event to the GitHub issue notifier and Cursor webhook
coordinator.

**Tech Stack:** Bun-native TypeScript, `bun:test`, GitHub Actions YAML, GitHub
REST via `fetch`, HMAC-SHA256 via `node:crypto`.

## Global Constraints

- Scripts live under `scripts/fork/sync/`; tests under `tests/fork/`.
- Not imported by `src/router.ts`, `src/server/lifecycle.ts`, or `src/server/responses/core.ts`.
- Never auto-merge `origin/main`.
- Never force-push `main`.
- Never whole-tree `-X ours` or `-X theirs`.
- Pin only `vendor/main` and `vendor/dev`.
- Action polls `v*` tags and grants `contents: write` + `issues: write`; no `pull-requests: write`.
- Checkout the default branch and pin `actions/checkout` to `11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2`.
- Never log webhook secrets.
- `already-current` is silent; `pin-diverged` creates an issue but does not call a coordinator; webhook only on `pin-updated`.
- Enable plugins through `FORK_SYNC_NOTIFIERS` and `FORK_SYNC_COORDINATORS`.
- Follow existing `bun:test` style and use focused tests.

---

### Task 1: Write the design artifacts

**Files:**
- Create: `docs/superpowers/specs/2026-08-22-fork-sync-automation-design.md`
- Create: `docs/superpowers/plans/2026-08-22-fork-sync-automation.md`

**Interfaces:** Record the exact interfaces used by Tasks 2–6:
`SyncEvent`, `CommandResult`, `CommandRunner`, `DetectOptions`,
`detectLatestVTag`, `AllowedVendorRef`, `isAllowedVendorRef`,
`PinOptions`, `pinVendorRefs`, notifier/coordinator interfaces and registries,
GitHub issue client, and webhook options.

- [ ] Write the approved design, constraints, security boundary, workflow
  contract, and focused test cases.
- [ ] Write this task-by-task plan with exact paths, signatures, commands, and
  expected behavior. Do not add production code.
- [ ] Self-review the design and plan for type consistency and placeholders.
- [ ] Commit:
  `git add docs/superpowers/specs/2026-08-22-fork-sync-automation-design.md docs/superpowers/plans/2026-08-22-fork-sync-automation.md`
  then commit with `docs: specify fork sync automation`.

### Task 2: Add SyncEvent and detection

**Files:**
- Create: `scripts/fork/sync/types.ts`
- Create: `scripts/fork/sync/detect.ts`
- Test: `tests/fork/sync-detect.test.ts`

**Interfaces:**
- Consumes: only `CommandRunner` from `types.ts`.
- Produces:
  `detectLatestVTag({ upstreamRepo, runner, now? }): Promise<SyncEvent>`.

- [ ] Write tests using a queued fake `CommandRunner` for highest semver-like
  `v*` selection, `upstream/main` ancestry, `already-current`, a fast-forward
  candidate, vendor divergence, and command failure.
- [ ] Run `bun test tests/fork/sync-detect.test.ts`; expected initial failures
  are missing module/export failures.
- [ ] Implement the exact event types and detection command parsing. The
  detection failure event must contain a short error and never credentials.
- [ ] Run the focused test again; expected result is all detection tests passing.
- [ ] Commit with `feat: add fork sync detection`.

### Task 3: Add the ff-only pin policy

**Files:**
- Create: `scripts/fork/sync/pin.ts`
- Test: `tests/fork/sync-pin.test.ts`

**Interfaces:**
- Consumes: `SyncEvent`, `CommandRunner`, `ALLOWED_VENDOR_REFS`,
  `isAllowedVendorRef`.
- Produces:
  `pinVendorRefs(event, { runner, upstreamDevRef? }): Promise<SyncEvent>`.

- [ ] Write tests that assert only `vendor/main` and `vendor/dev` are accepted,
  the exact `switch`/`merge --ff-only` sequence, no dev merge for an
  `already-current` event, and `pin-diverged` for any merge failure.
- [ ] Run `bun test tests/fork/sync-pin.test.ts`; expected initial failure is
  missing `pin.ts`.
- [ ] Implement the allowlist guard and ff-only commands. Never invoke force
  operations or arbitrary user-supplied refs.
- [ ] Run the focused test; expected result is all pin tests passing.
- [ ] Commit with `feat: add fork sync pin policy`.

### Task 4: Add notifier registry and GitHub issue upsert

**Files:**
- Create: `scripts/fork/sync/registry.ts`
- Create: `scripts/fork/sync/notifiers/github-issue.ts`
- Test: `tests/fork/sync-notify.test.ts`

**Interfaces:**
- Consumes: `SyncEvent`, `ForkSyncNotifier`, and `GitHubIssuesClient`.
- Produces:
  `registerNotifier`, `enabledNotifiers`, and
  `createGitHubIssueNotifier({ client, upstreamRepo })`.

- [ ] Write tests for creating a `fork-sync` issue, updating the existing
  same-tag issue, preserving labels, suppressing `already-current`, and
  rejecting unknown env plugin IDs.
- [ ] Run `bun test tests/fork/sync-notify.test.ts`; expected initial failures
  are missing registry/notifier exports.
- [ ] Implement comma-separated env selection with trimmed IDs and the
  GitHub issue upsert. Issue bodies contain public event data only.
- [ ] Run the focused test; expected result is all notifier tests passing.
- [ ] Commit with `feat: add fork sync issue notifier`.

### Task 5: Add coordinator registry and Cursor webhook

**Files:**
- Modify: `scripts/fork/sync/registry.ts`
- Create: `scripts/fork/sync/coordinators/cursor-webhook.ts`
- Test: `tests/fork/sync-webhook.test.ts`

**Interfaces:**
- Consumes: `SyncEvent`, `ForkSyncCoordinator`, and selected coordinator IDs.
- Produces:
  `registerCoordinator`, `enabledCoordinators`, and
  `createCursorWebhookCoordinator({ url?, secret?, fetchImpl? })`.

- [ ] Write tests for a `pin-updated` POST, exact JSON body, HMAC signature,
  no-op for all other event kinds, no-op when URL/secret is absent, and
  throwing on non-2xx.
- [ ] Run `bun test tests/fork/sync-webhook.test.ts`; expected initial failures
  are missing coordinator exports.
- [ ] Implement HMAC signing with `sha256=` and no secret-bearing logs.
- [ ] Run the focused test; expected result is all webhook tests passing.
- [ ] Commit with `feat: add fork sync webhook coordinator`.

### Task 6: Add the CLI and environment plugin wiring

**Files:**
- Create: `scripts/fork/sync/cli.ts`
- Modify: `scripts/fork/sync/registry.ts`
- Test: `tests/fork/sync-cli.test.ts`

**Interfaces:**
- Consumes: detection, pinning, notifier, and coordinator modules.
- Produces executable `detect`, `pin`, and `emit` commands:
  `bun scripts/fork/sync/cli.ts detect|pin|emit`.

- [ ] Write tests by invoking the CLI in a child process with isolated env and
  JSON stdin. Cover command dispatch, event stdout, plugin env IDs, and
  absence of webhook secret values in output.
- [ ] Run `bun test tests/fork/sync-cli.test.ts`; expected initial failure is
  missing CLI behavior.
- [ ] Implement stdin parsing for `emit`, JSON output for `detect`/`pin`, and
  built-in `github-issue`/`cursor-webhook` registration from environment.
- [ ] Run the focused test; expected result is all CLI tests passing.
- [ ] Commit with `feat: add fork sync cli`.

### Task 7: Add the GitHub workflow and contract tests

**Files:**
- Create: `.github/workflows/fork-upstream-sync.yml`
- Create: `tests/fork/sync-workflow.test.ts`

**Interfaces:** The workflow calls the Task 6 CLI and exposes only
`FORK_SYNC_CURSOR_WEBHOOK_URL` and `FORK_SYNC_CURSOR_WEBHOOK_SECRET` to `emit`.

- [ ] Write static contract tests for immutable checkout SHA, default-branch
  checkout, required permissions, concurrency, secrets, and forbidden
  pull-request write/force-push/merge strings.
- [ ] Run `bun test tests/fork/sync-workflow.test.ts`; expected initial failure
  is missing workflow.
- [ ] Implement a schedule plus `workflow_dispatch`, trusted default-branch
  checkout, upstream fetch, temporary event handoff, and CLI calls. Keep the
  workflow thin and credentials out of logs.
- [ ] Run the focused contract test and `bun run prepush`; expected focused
  tests pass. The local command cannot prove GitHub's remote workflow result.
- [ ] Commit with `ci: automate fork upstream sync`.

### Task 8: Update operator docs, skill, and automation prompt

**Files:**
- Modify: `docs/fork/OWNED.md`
- Modify: `docs/fork/README.md`
- Modify: `.cursor/skills/opencodex-fork-sync/SKILL.md`
- Create: `.cursor/skills/opencodex-fork-sync/automation-prompt.md`
- Create: `docs/fork/AUTOMATION-HANDOFF.md`

**Interfaces:** Documentation must state that Action stages are detect/pin,
Cursor stages are rebuild/draft PR, and humans merge `origin/main`.

- [ ] Add all new paths as `fork-owned`.
- [ ] Document poll cadence, vendor branch rules, issue/webhook behavior,
  secrets, and no-op/divergence behavior.
- [ ] Write the committed automation prompt for stages 3–7: fetch, disposable
  `run/main`, Mergiraf/conflict reports, draft PR, decision table, stop.
- [ ] Write handoff notes naming `FORK_SYNC_CURSOR_WEBHOOK_URL` and
  `FORK_SYNC_CURSOR_WEBHOOK_SECRET` and stating that the parent opens the
  Cursor Automations editor.
- [ ] Run `bun run privacy:scan` and focused documentation/workflow tests.
- [ ] Commit with `docs: document fork sync automation`.

### Task 9: Handoff and final verification

**Files:** no additional production files.

- [ ] Leave `automation-handoff` pending; do not open the Cursor Automations
  editor from this implementation session.
- [ ] Run `bun run typecheck`, `bun run test`, and `bun run privacy:scan` before
  claiming final completion because this is a non-trivial workflow change.
- [ ] Inspect `git diff --check`, the complete workflow diff, and branch status.
- [ ] Record each completed task and commit range in
  `.superpowers/sdd/progress.md`.
