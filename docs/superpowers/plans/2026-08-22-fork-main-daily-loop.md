---
name: Fork main daily loop
overview: "Make the reviewed run/main rebuild mergeable into the fork main, then document the merge-from-main daily sync loop."
todos:
  - id: plan-and-docs
    content: Write the daily-loop plan and update fork docs, skill, automation prompt, and ownership notes
    status: in_progress
  - id: target-overlay
    content: Allow main as a base on this fork while preserving dev-only upstream behavior, with a focused test
    status: pending
  - id: catch-up
    content: Record origin/main as a parent of run/main with a no-tree-change ours merge and verify ancestry
    status: pending
  - id: push-and-pr
    content: Push run/main, verify PR #6 is mergeable, and update its draft body for human merge
    status: pending
isProject: false
---

# Fork main daily loop Implementation Plan

> **For agentic workers:** Use checkbox (`- [ ]`) syntax to track each phase. Agents prepare the branch and draft PR; a human clicks Merge.

**Goal:** Make the reviewed `run/main` rebuild mergeable into the public fork’s `main`, then use a merge-from-`main` daily sync loop instead of disconnected vendor rebuilds.

**Architecture:** Keep the reviewed rebuild tree unchanged while recording old `main` as a parent with `git merge --no-ff -s ours`. Daily sync branches start at `origin/main` and merge `vendor/main`; the fork-owned overlay and selected features are replayed only when they are not already contained.

**Tech Stack:** Git branches and worktrees, GitHub Actions YAML, Markdown documentation, Bun-native TypeScript checks, and GitHub CLI.

## Global Constraints

- Never force-push `origin/main`; never auto-merge `main`; never merge PR #6.
- Never use `git config`, skip failing tests, or use whole-tree `git merge -X ours` / `git merge -X theirs`.
- Work only in `.worktrees/run-main-rebuild`; do not touch the parent worktree on `feat/replit-gateway-integration`.
- Workers are Composer 2.5 or GPT 5.6 Luna.
- Scripts under `scripts/fork/**` are not imported by `src/router.ts`, `src/server/lifecycle.ts`, or `src/server/responses/core.ts`.

## Phase A — one-time catch-up (this PR)

- [ ] On `run/main`, run `git merge --no-ff -s ours origin/main` so old `main` is a parent and the tree stays the reviewed rebuild (`v2.31.0` + overlay + selected feats).
- [ ] Verify `git diff --exit-code` between the pre-merge `run/main` tree and `HEAD`, and `git merge-base --is-ancestor origin/main HEAD`.
- [ ] Push `run/main`. Confirm `gh pr view 6 --repo yansigit/opencodex --json mergeable,mergeStateStatus` is mergeable, not dirty.
- [ ] Human only: click **Create a merge commit** on https://github.com/yansigit/opencodex/pull/6 — not squash, not rebase.

## Phase B — daily loop (after #6 is on main)

- [ ] GitHub Action (already): detect stable `v*`, fast-forward `vendor/main` + `vendor/dev`, and notify. Never merge `main`.
- [ ] Agent: run `git switch -c sync/upstream-YYYYMMDD origin/main`, then `git merge --no-ff origin/vendor/main`. Replay overlay/features only if not already contained (`merge-base --is-ancestor` / patch-id). Resolve via `docs/fork/OWNED.md`. Push. Open or update a draft PR into `main` until `mergeable=true`; merge `origin/main` into the sync branch if `main` moved; do not recursively merge old unique history back in after catch-up.
- [ ] Human: click Merge (merge commit).
- [ ] Never rebuild disconnected `run/main` from vendor unless histories diverge again (emergency recipe).
- [ ] Never squash or rebase these PRs.

## Phase C — remove daily blockers

- [ ] Fork `.github/workflows/enforce-pr-target.yml`: use `ALLOWED_BASES = ["dev"]` on `lidge-jun`, and `["dev","main"]` on this fork (`context.repo.owner !== "lidge-jun"`). `pull_request_target` reads the default branch, so this PR stays red until merged; after merge, later PRs pass. Keep this as overlay intent (theirs + reapply on vendor merges).
- [ ] Do not make `enforce-target` a required check on the fork if branch protection is visible; document that red-on-#6 is expected.
- [ ] Repo merge settings: allow merge commits; prefer disabling squash/rebase on this fork (daily driver PRs only land as merge commits). Use `gh api` PATCH if permitted; if not, document for the human.
- [ ] Encode shared-hotspot default for `src/adapters/google-http.ts`: cooldown then host-failover (already applied on the rebuild). Do the same for `responses/core.ts`: Antigravity 429 carousel then opaque-blob recovery.
- [ ] Skip overlay/feature SHAs already absorbed by `main` or `vendor/main`.
- [ ] Rerun the macos-launchd check before merge if it is the only service failure; it is not a rebuild regression.
- [ ] Later (not this PR unless trivial): extract remaining fork behavior to `src/fork/` so vendor merges shrink.
