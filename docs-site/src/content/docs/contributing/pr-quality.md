---
title: Pull request quality contract
description: Review readiness, contributor responsibility, trust lanes, and closure policy for OpenCodex pull requests.
---

## You do not need permission to fix something

An unplanned pull request for a bug you actually hit is welcome. Several of this
project's better fixes arrived exactly that way — a routed model stalling after
tool calls, a provider sending the wrong model parameters, images being flattened
out of tool results. None of those started from a planning discussion, and a
gate that required one would have lost all of them.

Opening an issue first genuinely helps for larger or design-shaped work, where
agreeing on the approach saves you from building the wrong thing. That is advice,
not an admission requirement.

## What a ready pull request claims

Marking a PR ready for review is a claim that the change is complete, understood,
and tested. Opening it does not transfer responsibility for the branch to the
maintainers.

Authors are expected to understand every changed line, name the exact commands
and results behind any validation claim, add focused regression coverage for
behavior changes, and stay available to resolve CI and review feedback.
Maintainers identify problems; they are not expected to repair contributor
branches, write the missing tests, or translate automated findings into patches
on your behalf.

"Tested" or "CI passes" without named commands and results is not evidence.

## Automated gates

Three deterministic checks run before human review, and each failure message
tells you exactly what to change:

- **PR quality (`enforce-target`).** Pull requests must target `dev` and carry
  a real description: a **Summary** of what changed and why, plus a **Test
  plan** (or equivalent substance). When the diff changes files under `gui/`, or
  when GitHub returns an incomplete changed-file list for a large diff, the
  description must include a screenshot of the UI change; the check keeps
  the PR a draft and comments until the screenshot is present. Incomplete file
  lists are treated conservatively as a GUI change. A maintainer can waive the
  screenshot requirement for a `gui/` change, for a false-positive GUI-path
  classification, or for an incomplete-file-list false positive, by adding the
  `gui-screenshot-waived` label; adding or removing that label immediately
  re-evaluates the gate. Legacy maintainer comments such as "no gui changes"
  are still recognised on the next PR event for compatibility, but comments
  themselves no longer trigger the privileged PR gate. A contributor cannot
  self-waive the screenshot requirement.
  Contributor PRs (authors without repository push permission) open in draft
  and stay there until a four-box review-readiness checklist in the
  description is complete: local CI green, the branch on the latest `dev`
  commit, all correct Codex and CodeRabbit findings fixed, and the
  ready-for-review confirmation. Once every box is ticked the check marks the
  PR ready for review and notifies the maintainers listed in `MAINTAINERS.md`
  (excluding the author). The gate's status and "what to do" live in a single
  consolidated bot comment that is rewritten on every run, so there is exactly
  one place to look. Completion is bound to the exact commit the PR head
  pointed at: if new commits are pushed afterward, the gate moves the PR back
  to draft, resets the checklist and the maintainer notification, and asks you
  to test and tick the boxes again against the latest code. A retarget to
  `dev` clears the wrong-branch message automatically and is remembered by the
  gate; the draft stays until the checklist is complete.
  Before a completion is accepted, the gate verifies the checklist claims it
  can check itself: the branch must be on the latest `dev` commit or at most
  10 commits behind it, and every Codex and CodeRabbit review thread authored
  by a review bot on the current head must be resolved (unresolved threads
  from other authors do not block). The local-CI box is an author attestation
  only — fork contributors cannot start repository CI; a maintainer has to —
  so the gate never disproves it; a new push still resets every box. CodeRabbit
  findings that fall outside the diff range and are reported only in a review
  body on the current head add to the unresolved count while a bot review
  thread is open; resolving every bot thread clears the box. A disproved claim
  unticks the matching box and keeps the PR a draft. When the checklist is
  complete and every gate is green, the gate adds a `review-ready` label as a
  visible status marker at the ready moment.
  CodeRabbit status-comment edits do not trigger the PR gate. CodeRabbit's
  successful `CodeRabbit` commit status wakes the trusted default-branch gate
  through the `status` event. The gate maps that status SHA to exactly one open
  PR whose current head still matches, then re-reads live review threads and
  review bodies before changing checklist, label, comment, or draft state. An
  ambiguous or stale SHA association is ignored, and no PR-head code is
  executed with the gate's write-capable token.

- **Hygiene.** Behavior changes need a test; new lint or type suppressions,
  focused or skipped tests, empty catch blocks, edited generated output, and a
  lockfile changed without its manifest each need an explicit approval label.
  A comment-only change to a source file is not a behavior change and owes no
  test.
- **Cross-platform CI.** The suite runs sharded on Linux and in full on macOS for
  every pull request. Windows runs at the shipping boundary — on promotion to
  `main` or `preview` — so a slow or flaky Windows runner cannot decide when your
  pull request turns green.
  This runs for **every** pull request, whatever its base branch — including a
  stacked child whose base is another open PR's head. The `paths:` filter, not
  the base branch, decides whether the jobs run at all: a PR touching only docs
  or `devlog/` queues nothing.

- **Type label.** The `label` check derives `bug` / `enhancement` /
  `documentation` / `chore` from your PR title. A title without a recognisable
  prefix (`stack 3/5: …`) falls back to the PR's commits, which usually stay
  conventional; `chore`-family commits (`test:`, `ci:`, `refactor:`) do not
  outvote a `fix:` or `feat:`. A PR that genuinely mixes types is left
  unlabeled rather than guessed, and a label a human sets is never overwritten.

CodeRabbit reviews every PR and its findings are advisory. Address what it gets
right; say why when it is wrong. It does not block a merge.

### When a workflow change takes effect

`enforce-target` and `label` use trusted default-branch automation. The PR gate
runs on `pull_request_target` and on CodeRabbit `status` events, both loaded
from the repository default branch; the write-capable behavior therefore
changes only after the gate revision is promoted to `main`. The cross-platform
CI workflow runs on `pull_request` and takes effect as soon as it is on the
branch being targeted.

## Sponsored surfaces

Authentication, credential handling, GitHub Actions workflows, release
automation, and dependency installation need a maintainer to sponsor the change
(`maintainer-sponsored`) before it merges. A bad merge on those surfaces is
expensive and hard to unwind, which is why they are the only surfaces gated this
way. Everything else is open.

## When a pull request is closed

A PR that stalls with unresolved review feedback may be closed, with the reason
stated plainly. Closure is not a verdict on the contributor: reopen it once the
stated reason is resolved, or replace it with a clean one. Ask if the reason is
not clear.
