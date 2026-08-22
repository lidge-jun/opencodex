# Workflow comment-spam hardening implementation plan

> **For agentic workers:** execute this plan test-first. Do not broaden workflow permissions or execute pull-request head code with a write-capable token.

**Goal:** Reduce GitHub Actions noise and runner consumption caused by `issue_comment` while preserving issue-comment translation and the PR readiness gate's ability to invalidate a ready PR when CodeRabbit reports new findings.

**Architecture:** Keep `issue_comment` only where GitHub offers no narrower native trigger: real-time issue-comment translation. Revalidate CodeRabbit readiness from its `CodeRabbit` commit status using the default-branch-only `status` event, then resolve the status SHA to exactly one open PR before the privileged gate writes anything. Make `gui-screenshot-waived` the immediate maintainer-controlled waiver trigger while preserving legacy maintainer-comment recognition on later PR events for compatibility.

**Tech stack:** GitHub Actions YAML, `actions/github-script`, Bun tests, existing PR-gate scripts.

## Global constraints

- PR targets `dev`.
- Workflow changes become live only after promotion to default branch `main`.
- Never checkout or execute PR-head code in a workflow with write permissions.
- Preserve real-time non-English issue-comment translation.
- Preserve CodeRabbit/Codex review-thread verification as the source of truth; review/comment bodies are trigger signals only, never trusted gate evidence.
- Do not claim that a job-level `if` removes an `issue_comment` workflow-run entry: it only prevents runner allocation for filtered comments.

## Task 1: Stop PR and bot comments from allocating issue-quality runners

**Files:**
- Modify: `.github/workflows/enforce-issue-quality.yml`
- Modify: `tests/ci-workflows.test.ts`

- [ ] Add regression assertions requiring the `translate-comment` job to run only for `issue_comment` events on real issues and non-bot authors.
- [ ] Run the focused workflow test and confirm it fails against the current workflow.
- [ ] Add the minimal job-level guard: exclude `github.event.issue.pull_request != null` and bot-authored comments before checkout/setup/AI steps.
- [ ] Re-run the focused workflow test and confirm it passes.

## Task 2: Replace CodeRabbit status-comment gate triggers with a trusted commit-status signal

**Files:**
- Modify: `.github/workflows/enforce-pr-target.yml`
- Replace: `tests/zz-pr-coderabbit-readiness-revalidation.test.ts`

- [ ] Require no `issue_comment`, `pull_request_review`, or PR-controlled signal workflow for CodeRabbit revalidation.
- [ ] Consume CodeRabbit's successful `CodeRabbit` commit status through the default-branch-only `status` event.
- [ ] Resolve the status SHA with `listPullRequestsAssociatedWithCommit` and continue only when exactly one open PR has that SHA as its current head.
- [ ] Treat status-triggered runs as signal-only head evidence and re-read live review threads/bodies before any write.
- [ ] Keep the write-capable checkout pinned to the trusted default branch for status events.

## Task 3: Move GUI screenshot waiver from maintainer comments to a label

**Files:**
- Modify: `.github/workflows/enforce-pr-target.yml`
- Modify: `tests/ci-workflows.test.ts`
- Modify: `docs-site/src/content/docs/contributing/pr-quality.md`

- [ ] Add regression assertions for `labeled` / `unlabeled` PR-target events and `gui-screenshot-waived` semantics.
- [ ] Confirm the new assertions fail against current behavior.
- [ ] Use `gui-screenshot-waived` as the only immediate GUI-waiver trigger, while preserving legacy maintainer-comment recognition on later PR events for compatibility.
- [ ] Document that the label is maintainer-controlled and that adding/removing it immediately re-evaluates the gate.
- [ ] Re-run focused workflow tests.

## Task 4: Verification and PR

- [ ] Run `bun test tests/zz-pr-coderabbit-readiness-revalidation.test.ts tests/ci-workflows.test.ts`.
- [ ] Run `node --test .github/scripts/*.test.cjs` because the gate still consumes those helpers.
- [ ] Run `bun run typecheck`.
- [ ] Run `git diff --check`.
- [ ] Verify the final diff contains no temporary implementation workflow or helper.
- [ ] Open a draft PR against `dev` with deployment note: event-driven workflow changes take effect only after promotion to `main`.

## Expected effect

- CodeRabbit PR status-comment edits no longer invoke `enforce-pr-target`.
- Ordinary maintainer PR comments no longer invoke `enforce-pr-target` merely to carry a GUI waiver.
- PR and bot comments still create an `Enforce issue quality` workflow-run record because GitHub cannot filter `issue_comment` by PR-vs-issue at trigger time, but the translation job is skipped before runner allocation.
- Real issue comments from humans continue to translate in real time.
- New CodeRabbit reviews can still invalidate a previously completed findings claim through CodeRabbit's commit status and a default-branch, write-capable gate without executing untrusted PR code or trusting an ambiguous SHA-to-PR association.
