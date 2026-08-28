# wp4 — Lane C: #2807, the 429 OAuth rotation identity rebind

Dependency position: after wp8. The operator requires this work to land as a matter of
principle, so it gets its own work-phase rather than sharing a lane.

## Current state

- PR #2807, head 1c61a7e8cd3871b374b3dd55d3cd335ae3a9e862, CONFLICTING/DIRTY, 80 behind.
- Exact-head CI was fully green (9 real gates pass / 0 fail) BEFORE the base moved.
- Files: src/server/responses/core.ts (rebind of OAuth snapshot/replay/Cursor identity
  during account rotation), tests/generic-oauth-failover.test.ts.
- Ingwannu review state on that head: CHANGES_REQUESTED, with one substantive blocker.

## Working-detail boundary

The unresolved security finding, reproduction, and remediation notes stay in gitignored
scratch space until a public fix ships. This tracked lane records only PR state, ordering,
and merge governance. Implementation begins from current dev rather than the stale branch.

## Security review obligation

src/server/responses/core.ts is an authentication/credential surface, and the PR author is
the repository owner, so MAINTAINERS.md forbids self-approval. Merge requires non-author
security review; --admin does not waive it. If that review cannot be obtained, this
work-phase closes BLOCKED naming the requirement rather than merging.

## Accept criteria

1. The current-dev replacement reaches a terminal disposition.
2. Focused verification and exact-head CI are green on the replacement PR.
3. Non-author security review is recorded, or the phase reports BLOCKED with the exact reason.
