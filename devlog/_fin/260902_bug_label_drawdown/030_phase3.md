# 030 — Batch C: changes-requested, maintainer-owned

Three PRs authored by @lidge-jun or @luvs01 carrying `CHANGES_REQUESTED`. Maintainer-owned
means we can push to the branch directly.

- **#3112** fix(codex): serialize native-main refresh on the CODEX_HOME claim — closes bug
  issue #2999. Two items for one merge.
- **#3109** fix(compact): route combo compact requests through the failover path.
- **#3003** fix(codex): throttle repeated failed pool quota primes (draft).

## Method

Read the review threads first and classify each finding: still valid, already fixed, or
rebuttable. Apply the valid ones on the branch, reply to the rest with a reason, then
re-request review or merge on maintainer authority where the finding was addressed.

Do **not** admin-merge over an unaddressed review comment — that is the line Batch C of the
previous campaign refused to cross for #2986, and it holds here.

## Verification (C)

Focused tests for the touched subsystem, then landing SHA ancestry. #2999 closed manually
once #3112 lands.

