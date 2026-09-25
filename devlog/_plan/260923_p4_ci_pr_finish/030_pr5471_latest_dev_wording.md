# 030 — #5471: the latest-dev box states the condition the gate enforces

## Acceptance

The latest-dev readiness item is built from `READINESS_LATEST_DEV_BEHIND_MAX` and never
restates the number. Rewording it leaves open pull requests' checklists and ticks untouched.

## Verified on dev

- The untick message already derives the number: `pr-quality-messages.cjs` interpolates
  `READINESS_LATEST_DEV_BEHIND_MAX`.
- The re-attestation migration compares only the first item
  (`firstReviewReadinessItem(body) === REVIEW_READINESS_ITEMS[0]`), so rewording item 1 does
  not trigger it.
- `extractReviewReadiness` reads box count and checked state, never item text.

## Changes

MODIFY `.github/scripts/pr-quality.cjs`: merge `dev`, keeping `dev`'s item 0
(`Required local validation passed; ...`) and the branch's `latestDevReadinessItem()` for item 1.

MODIFY `.github/scripts/pr-quality.test.cjs`: merge `dev`; in the legacy-checklist case use
`REVIEW_READINESS_ITEMS[0]` for the first line, so the case isolates the old item 1 wording
from the separate item 0 migration.

## Left for a maintainer

Whether #4443 also needs a line asking authors to check intervening `dev` changes for
overlap, or whether this pull request closes it as written.
