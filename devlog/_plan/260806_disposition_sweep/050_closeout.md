# 050 — wp5: closeout ledger + sweep PR + live end-state

## Work

1. Verify every 001-matrix row has a live GitHub disposition (comment id,
   close state, or push SHA) — `gh` snapshot per item.
2. Complete all decade-doc ledgers.
3. Commit the devlog unit + #1090 test on `codex/260806-disposition-sweep`.
4. Push the branch and open a PR against dev (template fully filled).
   **Leave it unmerged** — user constraint: 절대 dev에 머지하면 안돼.
5. Final snapshot table in this doc.

## Final ledger

| Item | Disposition | Live evidence |
|------|-------------|---------------|
| 1. PR #1036 (+#1017) | request-changes review posted; approach endorsed | OPEN / CHANGES_REQUESTED |
| 2. issue #919 | closed as intended-policy/enhancement, reopen path stated | CLOSED / NOT_PLANNED |
| 3a. issue #1090 | regression test landed on sweep branch (b63e86a8b, red-ablation proven); kept OPEN with status comment 5199554901 (absorption unproven for profile-masking shape) | OPEN |
| 3b. issue #1091 | status comment 5199487703 (design-needed, security-sensitive) | OPEN |
| 4. PR #1068 (+#994) | rebase-request + e2e-regression comment 5199487780 | OPEN |
| 5. PR #936 (own) | merged dev in (a90981e67), terra security audit PASS, fixes 4874390dd, full suite 9076/0, pushed; comment 5199634303 | OPEN draft, head 4874390dd, NOT merged |
| 6. issue #1059 | shard burn-down status comment 5199487879 | OPEN |
| 7. PR #1008 (own) | rebased onto dev, thread fixes 8e657f2a1/49cb22c3d/8d1eec899, terra 3-round PASS, 9088/0, lease-pushed; comment 5199782814 | OPEN, head 8d1eec899, NOT merged |
| 8. PR #1019 | split-request comment 5199488679 posted; author chrisae9 closed the PR himself at 02:03Z (his decision, not ours) | CLOSED by author |
| 9. PRs #1084/#1083/#1081/#1079/#1077 | closed with verified defect lists + reopen invitations; issues #1062/#1063/#1060/#1058/#1076/#1082 policy comments 5199492623-5199493056, kept open | all 5 PRs CLOSED, 6 issues OPEN |
| 10. PR #1085 / #997 | security-pass comment 5199488762 / rebase-request comment 5199488854 | both OPEN |

Snapshot taken 2026-08-06 ~02:20Z via `gh` per-item queries. Constraint held:
no merges into dev anywhere in this loop; own-PR lanes ended at pushed+open.

## Sweep PR

Branch pushed and PR opened against dev, left unmerged per user constraint:
https://github.com/lidge-jun/opencodex/pull/1097 (head `99b3b2120` + this
commit). Final audit: terra PASS (finding on phantom production commit
retracted with ancestry evidence; sweep range = 7 devlog commits + the
#1090 test commit).
