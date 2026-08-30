# 030 — Phase 4: final gate (independent post-merge audit)

Depends on: the merged change `8df7051201df09113b17da3f71ace992f001d66c` on `origin/dev` (PR #2900).
Scope: audit only. No source change is planned; a finding becomes a follow-up work-phase.

## Why this phase exists

The goalplan's quality gate (`cxc loop validate`, schemaVersion 2) requires a recorded
`final_gate` review round before completion can be certified. It is also the honest place to
re-examine the work now that it has landed, because this unit already produced two wrong turns
that only external checks caught:

1. The first implementation shape (standalone `[Tool Call]` entry) was rejected by the remote
   suite's 363-B guard — my own audit had missed it (`002`).
2. The first three live verification runs were routed to the operator's UNPATCHED proxy and
   proved nothing; only checking the probe's own diagnostic log exposed it.

Both were caught by evidence, not by reasoning, which is the argument for one more adversarial
pass rather than declaring done.

## Audit questions

| # | Question | How it is answered |
|---|----------|--------------------|
| A1 | Is the landed code on `dev` the code that was verified? | Compare the merge commit's file content against the verified branch head |
| A2 | Does any existing test expectation end up weakened? | `git diff` of the merge against its parent, restricted to `tests/` |
| A3 | Do the post-merge gates pass on the integrated tree? | `bun x tsc --noEmit` and `bun run test` on `ssh lidge` at the merge commit |
| A4 | Is every claim in the recorded evidence supported? | Re-read the goalplan's `capturedEvidence` against the artifacts it cites |
| A5 | Was the operator's environment left as found? | Live check of the launchd proxy and of the unpushed commit `5f4981853` |

## Accept criteria

`c8`: a recorded `final_gate` verdict, plus post-merge gate output at the merge commit, with
no regression, no weakened expectation, and no unsupported claim. A failure here appends a
follow-up work-phase rather than being written off.

