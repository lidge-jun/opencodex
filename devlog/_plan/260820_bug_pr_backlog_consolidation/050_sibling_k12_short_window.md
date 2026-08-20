# 050 — Sibling C: K12 short-window quota (issue #2047)

Work-phase: wp6. Branch: `codex/absorb-k12-short-window`. Base: **dev**.
Absorbs: **PR #2056 by @Ingwannu**. Supersedes: **#2062 by @yzxcj797**. Closes #2047.

## Chosen base

#2056 is a strict superset of #2062: `snapshotHasShort`, partial-snapshot preservation,
`updateAccountQuota` carry, and the parse -> cache -> DTO path #2047 actually requires. #2062
drops short on a later weekly/monthly partial snapshot and carries a stray version bump.

## Blocker to fix before this can land (raised by the maintainer on both PRs)

A short-only snapshot with `shortPercent: 0` scores `0` instead of `CODEX_UNKNOWN_USAGE_SCORE`,
so `pickLowestUsageAmong` prefers an account whose long windows are unverified. Fix:
include `shortPercent` in `computeCodexUsageScore` only when the plan's governing long window
is finite; otherwise return `CODEX_UNKNOWN_USAGE_SCORE`. Add the short-only regression.

This blocker is why #2056 is absorbed-and-corrected rather than simply approved.

## Also close

**#2063 by @yzxcj797** — superseded by ALREADY-MERGED #2055 (`2648ffa87`), which classifies
`detail.code` with a stricter own-property lookup. Close with attribution; fold nothing.

