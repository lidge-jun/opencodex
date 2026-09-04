# 070 — wp6: credit ledger and closeout

Final phase. Reconcile every closure made in wp3–wp5 against the attribution
policy, extend `CREDITS.md` where a contribution was carried without a trailer,
and record the campaign result.

## Checks

1. Each closed contributor item has a comment naming its author. Verified by
   re-reading the comments through `gh`, not from memory of having posted them.
2. Each carried contribution is either covered by a `Co-authored-by` trailer on
   its landing commit or listed in `CREDITS.md`.
3. `missing_coauthor_credit` in `.github/scripts/pr-carry-attribution.cjs`
   remains the forward guard; this phase must not grow the historical list
   without recording why.

## Closeout

Final counts for branches, remote refs, open PRs, and open issues, each measured
live rather than derived from the plan. The unit then moves to `devlog/_fin/`.
