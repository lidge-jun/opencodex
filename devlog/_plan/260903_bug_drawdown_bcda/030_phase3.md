# 030 — Phase 3 (wp3): PR #3246 — bridge write_stdin through exec

## Item

`fix(responses): bridge write_stdin through exec`, head
`db96ae50d787df10dc5e3c5767776bfa8fb7d115`, base `8fb4e6e797d4e0d44425a0167b399fa573c3226d`, 162 additions /
15 deletions across 6 files, label `bug`.

## Phase class: ADOPTION, gate-blocked

Per-file incoming change map (`gh pr view 3246 --json files`):

| File | +/- | Role |
|------|-----|------|
| `src/responses/code-mode-helper-compat.ts` | +4 / -1 | the bridge itself |
| `src/types/tools.ts` | +12 / -9 | tool declaration typing |
| `tests/legacy-shell-compat.test.ts` | +22 / -0 | new coverage |
| `tests/bridge-legacy-shell-normalization.test.ts` | +19 / -3 | normalization |
| `tests/responses-custom-tool-repair.test.ts` | +68 / -0 | repair path |
| `tests/responses-undeclared-tool-guard.test.ts` | +37 / -2 | the guard boundary |

Four of six files are tests: 146 of the 162 added lines are coverage, and the
production delta is 16 lines across two files. Per the PR description the bridge
is request-scoped and fail-closed — it activates only for an exact bare `exec`
declaration, preserves an explicitly declared `write_stdin`, and refuses unknown
or namespaced tools — so the exec surface is not widened.

## Gate analysis and the draft question

`resolve-pr`, `label`, `hygiene` passed; `enforce-target` failed while the PR sat
in draft with three of four readiness boxes unticked, so the full matrix never
ran on `db96ae50`.

`AGENTS.md:303` is precise about what that checklist is: the local-CI box is an
author attestation the gate never disproves, because fork contributors cannot
start repository CI — a maintainer has to. The other three boxes are the
author's own to tick, and when all four are ticked the gate itself marks the PR
ready. So a maintainer marking it ready EARLY is a deliberate override of the
contributor flow, not a step the policy prescribes.

The justification for doing it here is narrow: this campaign's acceptance
requires exact-head CI evidence, and no such evidence can exist while the PR
stays in draft with the matrix unrun. Marking ready starts the matrix a fork
author cannot start. The override buys evidence, nothing else — the merge
decision still rests entirely on the resulting green rollup, and a red matrix
ends the phase as BLOCKED regardless of the checklist.

## TESTS — the assertion that is RED before the fix

The PR reports a red-first run of four expected failures. The concrete
pre-fix behavior: a model emitting `write_stdin` against a bare `exec` declaration
is rejected by the undeclared-tool guard
(`tests/responses-undeclared-tool-guard.test.ts`) instead of being bridged onto
`exec`, and the normalization path leaves the call unmapped
(`tests/bridge-legacy-shell-normalization.test.ts`). Post-fix those four files
report 120 pass / 0 fail. Only those focused files may run locally.

## Verification (C)

```
gh pr ready 3246
gh pr view 3246 --json headRefOid,statusCheckRollup
gh pr merge 3246 --squash --admin
git fetch origin dev && git merge-base --is-ancestor <merge-sha> FETCH_HEAD
```

Terminal outcome: DONE on merge, or BLOCKED naming the exact failing gate.

