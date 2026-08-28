# wp4 — Lane C: #2807, the 429 OAuth rotation identity rebind

Dependency position: after wp8. The operator requires this work to land as a matter of
principle, so it gets its own work-phase rather than sharing a lane.

## Current state

- PR #2807, head 1c61a7e8cd3871b374b3dd55d3cd335ae3a9e862, CONFLICTING/DIRTY, 80 behind.
- Exact-head CI was fully green (9 real gates pass / 0 fail) BEFORE the base moved.
- Files: src/server/responses/core.ts (rebind of OAuth snapshot/replay/Cursor identity
  during account rotation), tests/generic-oauth-failover.test.ts.
- Ingwannu review state on that head: CHANGES_REQUESTED, with one substantive blocker.

## The live blocker, restated precisely

On the generic OAuth 429 rotation path the code clones account A's provider.baseUrl into
the retry. When the newly selected account B has no apiBaseUrl of its own, transport
resolution can pair B's bearer with A's accepted origin. That is a credential-boundary
defect: a token is sent to an origin bound to a different account.

Second finding: the existing test asserts the resolver's intended expression rather than
driving the reachable path, so it would not catch a regression. What is required is an
executable A->429->B regression that observes the actual outbound pairing.

## Change map (to be executed on current dev, not the stale branch)

```
MODIFY src/server/responses/core.ts
  - on OAuth rotation, resolve the retry origin from the SELECTED account, never by
    cloning the previous account's baseUrl
  - when the selected account has no explicit apiBaseUrl, fall back to the provider
    default origin rather than the previous account's origin
MODIFY tests/generic-oauth-failover.test.ts
  - add an executable A -> 429 -> B case that captures the outbound request and asserts
    (bearer, origin) both belong to B
```

Exact line-level shape is derived at wp4's P from the then-current core.ts, because the
file has moved 80 commits since the branch was cut. The stale branch diff is the starting
reference, not the patch.

## Activation scenario (C-ACTIVATION-GROUNDING-01)

The rotation branch only runs on a 429 from account A. The test must inject that 429, let
the rotation select B, and observe the resulting fetch. All-tests-green without a test that
drives the 429 does not satisfy this phase.

## Security review obligation

src/server/responses/core.ts is an authentication/credential surface, and the PR author is
the repository owner, so MAINTAINERS.md forbids self-approval. Merge requires non-author
security review; --admin does not waive it. If that review cannot be obtained, this
work-phase closes BLOCKED naming the requirement rather than merging.

## Accept criteria

1. The bearer/origin pairing defect is fixed on current dev.
2. An executable A->429->B test fails before the fix and passes after; both runs recorded.
3. Exact-head CI green on the new PR.
4. Non-author security review recorded, or the phase reports BLOCKED with the exact reason.
