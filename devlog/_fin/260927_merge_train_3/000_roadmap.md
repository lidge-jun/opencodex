# Merge train round 3 — roadmap

Inventory at `dev` `99d0a9400e` (2026-09-27, after round 2 in `devlog/_fin/260927_merge_train_2/`). Round 2's
outcome carries forward: its owner-decision list (#5831, #5964, #5956, #5995, #5800, #5912, #5879) and its blocked list
(#5977 unauthenticated status proof, #5893 Bun NO_PROXY patterns, #5927 security, #5925 needs a split, #5953 overbroad
override, #5539, #5497, #5947, #5782, #4222 and the stale feature drafts) stay out of this lane unless their authors
changed the premise.

Goal: land the open bug fixes and non-GUI enhancements that opened after round 2's inventory, close what they resolve,
and bring open issues and PRs to at most 40 each (61 issues and 80 PRs at the start). One lane, serialized batches,
each rebased on the newest `dev`.

Every carried PR is one squashed commit with the author or a `Co-authored-by` trailer. Each item's GitHub page is read
through Aside's signed-in browser (captures in `.tmp/aside/`, gitignored) before it is carried or closed. Kimi
subagents review each PR and audit each batch diff; auth, credential and link-relay changes get a dedicated security
review whose specifics stay in scratch.

## Batches

| Batch | PRs | Issues |
|---|---|---|
| B1 | #6041, #6019, #6015, #6011, #6006, #6026, #6034 (security review) | #6033, #6017, #6014, #4191 (only if the fix, not just a pin, lands), #6005, #5960, #6032 |
| B2 | luvs01 non-GUI bug fixes: #6048, #6047, #6046, #6038, #6036, #6035, #6057; #6022 (mdwsk88) | per PR |
| B3 | #6020 or #6056 (same quota-activation code; pick one), #6027, rebased #6050 #6049 #6037, #6042 (security review), #6030, #6003 | #6018, #5569 |
| B4 | bugs found through Aside that have no PR yet, implemented in this lane | per issue |

## Out of scope

GUI changes: #6043, #6007, #5983, #5905, #5950, #6025, #6010, and the GUI feature drafts. #6044 is a conflicting draft
that also edits a GUI test.
