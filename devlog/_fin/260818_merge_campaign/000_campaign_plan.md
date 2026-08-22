# 260818 Merge Campaign — Windows stack + FastWire train

## Objective

Close the two ordered merge trains left open after the v2.25.0 cut and today's
triage campaign, each as its own PABCD work-phase:

1. **WP1 — Windows stack** (#1944 → #1945 → #1946 → #1947, + #1949 opener):
   stacked PRs, base-chained; merge in order, retargeting each child to `dev`
   after its parent lands. Closes nothing by itself (the stack's issues #1942 /
   #1849 need follow-up work), but lands the wrapper-killer/argv/atomic-replace
   foundation the Windows program (#1949 unit) builds on.
2. **WP2 — FastWire train** (#1893 A1 → #1956 B0 + #1965 B1 → #1904): A1 is a
   byte-identical refactor; B1's diff is a superset of draft B0, so B0 is
   review-closed into B1 (or merged first if trivially separable — decide at
   WP2 P). #1904 is independent (chat→responses tier forwarding). #1885 (xAI
   Priority) stays HOLD behind the #1875 B2 pricing gate — NOT in this campaign.

## Method

Per PR: scratch-worktree merge onto current `origin/dev` → focused suites +
`tsc --noEmit` → approve with validation evidence → merge (merge commit,
matching today's #1997/#1998 pattern) → retarget next child. Contributor-gate
re-drafts are expected on contributor PRs; maintainer decision on admin-merge
is recorded per PR. grok-4.6 subagents carry per-PR read-only validation.

## Success criteria

- [ ] #1944 #1945 #1946 #1947 #1949 merged to `dev`, stack order preserved
- [ ] #1893 merged byte-identical (no behavior delta in fastwire suites)
- [ ] #1956/#1965 landed (B0 closed-into-B1 or merged), #1886 umbrella updated
- [ ] #1904 merged
- [ ] #1885 still open with HOLD note intact
- [ ] every merge: exact-head suites green + typecheck clean before approve

## Non-goals

Release promotion (user owns main/preview), #1885/B2, cursor draft queue,
remaining ready singles (next campaign).

