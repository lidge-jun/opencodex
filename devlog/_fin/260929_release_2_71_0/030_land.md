# 030 Land (wp3): one push, exact-head CI, admin merge

1. `git push -u origin codex/release-2-71-0` (the only push of integration content).
2. Upload GUI screenshots to `pr-assets` (the #6094 request-pacing panel and the #5905 Cursor
   installer notice, taken from the source PR bodies' images) and link them by commit SHA.
3. `gh pr create --base dev --head codex/release-2-71-0` with the repository template (Summary,
   Verification, Checklist), one bullet per source PR with its landing commit, `Closes #6208`, and
   `Co-authored-by` lines for every source author (see 010 table).
4. Wait for exact-head results on the PR head: Cross-platform CI (all test shards, windows 1-9,
   macOS, docker smoke, npm-global smokes), Service lifecycle when triggered, enforce-target,
   hygiene, privacy gate, structure. Missing, pending, skipped-by-failure, cancelled or older-head
   results are not a pass. Fix any failure with a new commit on the branch (new exact head).
5. `gh pr merge <n> --admin --merge --match-head-commit <head>` (owner-authorized maintainer
   integration; record the decision in the PR).
6. Close each source PR with a comment naming its landing commit on dev; for #6209 note that
   #6208 closes manually since dev is not the default branch.
7. Record dev tip SHA after merge for 040.

Rollback: if a defect from the union surfaces after the merge and before promotion, fix forward
on dev with a new PR; if it cannot be fixed quickly, revert the offending land commit on dev
(each source PR is one commit, so `git revert <land sha>` isolates it) and re-cut the candidate.
Nothing is promoted until the candidate is green.
