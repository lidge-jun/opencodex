# 005 — Delivery evidence refresh

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Historical investigation or process record; not current execution authority. Old verification debt and diagnoses are not current failure claims or permission for new diagnostics.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Later WP400 verification checkpoint

The supported `cxc loop steer` operation applied batch `wp400-verification-reconciliation-20260905`: retain history, annotate the premature c-3 mark, and add mandatory open criterion c-5 requiring fresh evidence for every final layer head. There is no reopen verb; no session/goalplan state was hand-edited and no acceptance requirement was weakened. Shared macOS RCA is recorded in006; its cause remains unknown.

Additional read-only log retrieval showed #3590 failing at the same `tests/update/update-stop-first.test.ts:240` expectation as #3594: waitForProxy returned false after92178.26ms; job101237519332/run33940504774 reports9244pass/3skip/1fail. Two matching observations do not establish a flake or its cause. Neither failing test job was rerun.

For #3570 only, verified run33936218644/job101224631090 was cancelled and belongs to the unchanged current PR headfdddbd3e1516997111b201a7c191fc08a6f8d4dd. `gh run rerun 33936218644 --job 101224631090` exited0. This requeues the cancelled enforce-target check, not a failed test; replacement outcome remains pending.

PR #3611 is open/draft at24466356836dd567120d3d3f4e8d09574f2182d3. Remote typecheck,442focusedtests, privacy, independent implementation/security review and mutation red/green passed. Full suite failed with4baseline route-registry/rollover failures; no passing receipt or D close. See400 for evidence and the separate #3610 prerequisite disposition.

The #3594 macOS failure log is now available: `tests/update/update-stop-first.test.ts:240` expected `waitForProxy(port)` true but received false after92800.62ms. Job101239095583 in run33941274745 reported9244pass/3skip/1fail. That is the observed failure, not an established cause or permission for a blind retry. No source change or rerun was made for it.

## 2026-09-05 audit checkpoint during WP400

Read-only refresh: `gh pr view <number> --json state,isDraft,headRefOid,baseRefName,statusCheckRollup`. All 13 listed PRs reported OPEN and non-draft. This snapshot distinguishes publication from verified completion; no merge, rerun, PR mutation, or local suite was performed by this refresh.

| PR | Exact head | Base | Reported check state |
|---|---|---|---|
| #3557 | `97df51515c22ccd610665989aa940f15bc3bca24` | dev | Reported checks passed/skipped/neutral; cancelled duplicates have successful replacements |
| #3559 | `5b253af7f3392c4af3c2177d6b66a06a8d674044` | dev | Reported checks passed/skipped/neutral; cancelled duplicates have successful replacements |
| #3566 | `58dba9e0b2209bd9f76c4d5fb4943df0d6ab710b` | dev | Reported checks passed/skipped/neutral; cancelled duplicates have successful replacements |
| #3567 | `c1d436738c5fb012b666cc15e87e777a66e7648d` | dev | Reported checks passed/skipped/neutral; cancelled duplicates have successful replacements |
| #3570 | `fdddbd3e1516997111b201a7c191fc08a6f8d4dd` | codex/split-cursor-desktop-executor-contract | enforce-target: CANCELLED |
| #3574 | `8a404cb889abda5ab6d9cd384833e5d3c34dd873` | dev | Reported checks passed/skipped/neutral; cancelled duplicates have successful replacements |
| #3577 | `51f5a82d7c6ff3cc3a2df1a08716fa5eff1e67b1` | dev | Reported checks passed/skipped/neutral; cancelled duplicates have successful replacements |
| #3580 | `3793fb0326b8aea541918905461a8a4a0e5fcd79` | dev | Reported checks passed/skipped/neutral; cancelled duplicates have successful replacements |
| #3583 | `c0fab2d74b977092884ea817c274ef2f3f4021a7` | dev | Reported checks passed/skipped/neutral; cancelled duplicates have successful replacements |
| #3585 | `1cab08d405fc59bc5b386aa21a073f4301246ac2` | dev | Reported checks passed/skipped/neutral; cancelled duplicates have successful replacements |
| #3590 | `82e069c9fe59b9660bee7964cd58c0141687267b` | dev | macos 1/2: IN_PROGRESS; macos 2/2: IN_PROGRESS; keyring macos: IN_PROGRESS |
| #3594 | `0c914bf265ce38c57498c21ccf81f0202b9c133c` | dev | macos 1/2: FAILURE; ci: QUEUED |
| #3599 | `5c1a398da78975312c183c1c2b6e0ff8241ac02c` | dev | resolve-pr: QUEUED; enforce-target: QUEUED; test 1/4: IN_PROGRESS; test 2/4: IN_PROGRESS; test 3/4: IN_PROGRESS; test 4/4: IN_PROGRESS; storage policy: IN_PROGRESS; macos 1/2: QUEUED; macos 2/2: QUEUED; keyring ubuntu: QUEUED; keyring macos: QUEUED; npm-global ubuntu-latest: QUEUED; npm-global macos-latest: QUEUED |

Cancelled jobs are not automatically ignored: a replacement must have the same check name and SUCCESS on the queried head. In particular, #3570 has no successful enforce-target replacement in this snapshot. #3594's failed macos 1/2 job is https://github.com/lidge-jun/opencodex/actions/runs/33941274745/job/101239095583; `gh run view 33941274745 --job 101239095583 --log-failed` exited 1 because the workflow was still running and logs were unavailable. The failure cause is not yet established; do not label it a flake or a regression without the log.

The goalplan's c-3 currently says met even though it describes per-layer verification and many layers remain unbuilt. That mark is not evidence of whole-train completion. The final audit must reconcile every layer and repair criterion state using a supported workflow; this note does not overwrite the FSM or manufacture receipts. Earlier published layers with incomplete remote receipts or failed checks remain open verification work even where their workphase status says done.
