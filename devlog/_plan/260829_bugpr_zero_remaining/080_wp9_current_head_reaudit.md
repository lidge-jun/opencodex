# wp9 — Current-head re-audit: #2638 and #2828

Dependency position: **after wp4**, because #2638 touches `src/server/responses/core.ts` and
wp4 (#2807) is serialized ahead of every core-touching member. #2828 does not touch core and
may be audited independently of that ordering; only its merge waits on its own review.

## Why this lane exists

Both PRs were originally placed in the reimplementation lane on the strength of a
`CHANGES_REQUESTED` review. The A-gate audit established that in both cases the review is
bound to a head that no longer exists:

| PR | reviewed head | current head | ahead / behind dev | draft |
|----|---------------|--------------|--------------------|-------|
| #2638 | `c8556f3703` | `375e6f8fb8` | 6 / 0 | no |
| #2828 | `1031a509a9` (maintainer), `387d9f2b10` (bot) | `019c792607` | 5 / 0 | no (was draft) |

A finding against a superseded commit is not evidence about the current diff. Reimplementing
over a contributor's already-repaired branch would discard their work for no reason, so the
audit happens first and the disposition follows the evidence.

## Procedure per PR

1. Read the CURRENT diff, not the review thread: `gh pr diff <N>`.
2. Take each blocker from the old review and check it against the current head
   line-by-line. Record for each: still present, fixed, or no longer applicable — with the
   file:line that proves it.
3. Dispatch an independent reviewer on the current diff (fresh reviewer, not the one whose
   verdict is being re-examined).
4. Disposition:
   - all old blockers fixed and no new ones -> request exact-head maintainer review and merge
     through `scripts/ci/assert-mergeable-review.sh`;
   - some still present -> either the author fixes them, or the PR moves to reimplementation
     in wp5 with the specific unfixed blockers named;
   - new blockers -> same, with the new findings recorded.

## Known state to re-verify, not to assume

- #2638's `gates` failure at triage was a stale generated ocx skill surface. The verifier is
  `bun run skill:surface:check` (read-only); `bun run skill:surface` regenerates and is not a
  gate. Whether the current head still fails it is an open question for this lane.
- #2638 touches `src/codex/auth-context.ts`, which IS on the hygiene gate's restricted list,
  and its earlier security approval was explicitly scoped to `e06ffbaa8a8e`. Non-author
  security review on the exact final head is mandatory.
- #2828 touches `src/grok/inject.ts`, whose teardown path can remove config tables; the
  reviewer's ownership concern must be re-checked against the current parser, since the
  branch claims to have addressed it.
- #2828 was earlier assessed as NOT satisfying issue #2830 (excluded-model reference
  clearing). Re-check that claim against the current head before deciding whether #2830 needs
  separate work.

## Accept criteria

1. Each PR has a recorded current-head blocker table (present / fixed / n/a with evidence).
2. Each PR reaches merge, author-fix, or documented reimplementation — never a stale-review
   verdict.
3. Security-surface merges carry non-author maintainer approval bound to the final head,
   verified by the executable gate.
