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

Two checks run before human review, and both are deterministic — the failure
message tells you exactly what to change:

- **Hygiene.** Behavior changes need a test; new lint or type suppressions,
  focused or skipped tests, empty catch blocks, edited generated output, and a
  lockfile changed without its manifest each need an explicit approval label.
  A comment-only change to a source file is not a behavior change and owes no
  test.
- **Cross-platform CI.** The suite runs sharded on Linux and in full on macOS for
  every pull request. Windows runs at the shipping boundary — on promotion to
  `main` or `preview` — so a slow or flaky Windows runner cannot decide when your
  pull request turns green.

CodeRabbit reviews every PR and its findings are advisory. Address what it gets
right; say why when it is wrong. It does not block a merge.

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
