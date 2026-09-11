# wp4 — merges, and the readiness check the lane merges need

wp4 owns serialized merges on final-head green CI with fetched ancestry proof. Three merges have
already run under exactly that gate, all of them the round's own pull requests:

| PR | Head merged | Landing proof |
|---|---|---|
| #4217 | `538668bb0` | `git merge-base --is-ancestor` against fetched `origin/dev` |
| #4220 | `6a3774c15` | same |
| #4221 | `9f550ae56` | same |

No lane pull request exists yet, so the lane half of this phase has nothing to merge. That is an
external dependency: a thread has to be opened against each worktree, which an agent cannot do.

## What this phase does before deferring the lane merges

Every defect the three round audits found had the same shape: a lane was told to fix something whose
code does not live entirely inside the paths that lane owns. #4212 needed a management route L3 did
not have. #4207 was client code in the wrong lane. #4190's leak sat in a directory no lane owned.
Each was found by reading one issue against the tree.

A lane that discovers this itself burns a cycle and stops, and the merge this phase waits for never
arrives. So before deferring, check all seven at once: one read-only `xai/grok-4.6` subagent per lane,
fresh context, asked a single question — can this lane's stack be implemented entirely inside its
owned paths, and if not, which exact path is missing? The questions are independent, so the seven run
concurrently. Their verdicts are this phase's audit.

## Acceptance

- The three completed merges are recorded with their exact heads and landing proofs.
- Seven verdicts, one per lane, each naming either that the stack fits the owned paths or the exact
  unowned `path:line` it needs.
- Every finding is folded into that lane's packet, or recorded with a rebuttal the way the #4184
  finding was rebutted with the issue text that disproved it.
- Amended packets are pushed and their remote heads read back with `git ls-remote`.
- The lane merges are recorded as deferred with the reason, not as done.

## Out of scope

No implementation. No lane pull request. No merge of a lane branch, because none exists. A subagent
that proposes a fix has exceeded its packet; only the path gap is used.

## Local checks

`NOT RUN`. Every subagent is read-only.

