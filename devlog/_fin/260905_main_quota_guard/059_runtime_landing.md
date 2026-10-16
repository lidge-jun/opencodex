# Runtime landing and first post-squash cascade

PR3552 was admin-squashed into dev at `9fe986d84a598aa08eeef7731b9a50fa0ff6ab07` on 2026-09-05T05:24:21Z. Its final source head was `d48b32203c1170958037cf09c4b73dcda74d96be`. A fresh fetch followed by `git merge-base --is-ancestor` proved integration ancestry.

Cross-platform CI33945054125 attempt2 succeeded before merge: four Linux shards, both macOS shards, gates, API/storage, all selected keyring/package jobs, and aggregate ci. Windows six-shard suites and macOS control were intentionally unselected by this workflow event, not executed successes. The owner-approved failed-job rerun retained already passing results after an earlier cancellation. All applicable PR checks were green, all five inline threads resolved, and the reviewed integration delta had zero source-review blockers. The owner's explicit admin authorization was used; no review was dismissed.

PR3560 was retargeted to dev and all four UI commits rebased onto the runtime squash. Its new head is `fe9ed3b1b5c122cc0258fa85b077d6776aea0ab2`. All four range-diff entries are unchanged. The nine Reserve commits were then rebased onto that UI head, producing `7ff3a1976a569b48ad00dbda7be51eb6e83db08b` before this documentation commit; all nine range-diff entries are unchanged. Explicit leases and `--no-verify` protect each rewritten remote head. Fresh exact-head CI is required for both upper layers; earlier green runs do not certify the rewritten heads.

No local test suites, deployment, live account modification, installed-app patch, or reset-credit action occurred. The original stack and its documentation closeout remain wp3 work; the additionally requested mixed-plan pool rotation starts at the following P, not inside this delivery build.
