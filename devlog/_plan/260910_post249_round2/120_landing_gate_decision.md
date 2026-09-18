# 120 — Landing the Lane B GUI stack past the screenshot gate

## Why this document exists

Round 2 ended with Lane B dammed: #4156, #4158, #4165 and #4166 are
code-complete and green on every product CI job, and the only hard failure is
`enforce-target` reporting `missing_ui_screenshot` because each title or
description mentions `gui`. `110_delivery_record.md` escalated that to the
maintainer. The maintainer's answer on 2026-09-10 was to land them.

## What the gate actually is

Read from the workflow rather than assumed:

- `.github/workflows/enforce-pr-target.yml` fails with `missing_ui_screenshot`
  when `hasGuiCue(title, body)` is true and `hasScreenshotEvidence(body)` is
  false. An inline markdown image, a reference image with a definition, or an
  `<img src>` counts; a plain link does not.
- The failure is **not** a required status check. `dev` is protected by ruleset
  20763889 (`Protect dev`): deletion, non-fast-forward, and a pull_request rule
  requiring one approval and code-owner review, with `RepositoryRole` admin and
  maintain bypassing in `pull_request` mode. There is no required-status-check
  rule, so the gate does not block the merge API.
- What it does instead is hold the PR in draft. For an author with push
  permission the contract is failure-only: draft while a quality gate fails,
  ready again once it clears. A draft PR cannot be merged, so the failure has
  to clear before the merge, not merely be ignored.
- Two waivers clear it: the `gui-screenshot-waived` label applied by a login
  listed in `MAINTAINERS.md`, or a maintainer comment whose text negates the
  GUI cue within a short window.

## The decision, stated plainly

The label is described in the repository as a *maintainer waiver for
false-positive GUI screenshot requirements*. **These four are not false
positives.** #4156 and #4158 change `gui/src/pages/Models.tsx`, #4165 changes
`Models.tsx`, and #4166 changes `gui/src/pages/Logs.tsx`. Every one of them
alters what an operator sees.

So the waiver is used here for what it is: an owner-directed waiver of the
screenshot requirement on a real GUI change, not a claim that the gate
misfired. The maintainer comment path is deliberately **not** used, because the
phrase that satisfies it would have to assert the change does not touch the
GUI, and that assertion would be false.

Producing a genuine screenshot is not merely inconvenient: the visual states
these PRs add are a decode-rate column on a live request row, a Free-only
catalog filter over discovered pricing, and an inactive badge driven by real
quota exhaustion. None of them render from a static build; each needs a running
proxy in a specific upstream state. That cost, not the local-build constraint
alone, is why the gate is being waived rather than satisfied.

## Landing order

#4158 is based on `lane-b/1-3666`, the head of #4156, so the stack lands
parent-first and the child is retargeted to `dev` once the parent is gone:

1. #4156 `feat(catalog): classify discovered model pricing and filter free models`
2. retarget #4158 to `dev`, then merge it
3. #4165 `feat(catalog): mark quota-exhausted models and combos inactive`
4. #4166 `feat(logs): show an estimated decode rate alongside end-to-end throughput`

#4165 and #4166 are independent of the stack and of each other.

## Outstanding review findings

Bot findings were posted against first commits and later commits exist, so each
one is re-read against the current head before it is dismissed. The two Codex
P1 items on #4165 are audited by an independent reviewer before the merge, and
anything that turns out to be a real defect is fixed in a branch commit rather
than waived along with the screenshot.

## Out of scope

No promotion to `preview` or `main`, no release dispatch, no version bump, no
ruleset change, no force push, and no other author's pull request. Local suite,
typecheck, build, lint and `privacy:scan` remain NOT RUN; remote CI at the exact
head SHA is the gate.
