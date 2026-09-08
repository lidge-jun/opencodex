# Delivery and verification ledger

Certified final head `5d5d35756b9b672aecf10a64be0db1f7afc144ae` has tree `5fba579b0d10183e921657dbcf4edbd166c20ec7`. All five owned PRs merged bottom-up, and actual product dev `9ad218a9bdd34ee33004c35706d78396bf02eef2` has exactly the same tree.

| Owned PR | Certified head | Actual dev merge | PR CI run / attempt |
| --- | --- | --- | --- |
| #3986 | `d1f61e933b0cde3df3862baed65546a5cf81066f` | `7b2223776450804a6b8a4509a115dd42ee1b9c40` | 34178540141 / 1 |
| #3991 | `00eb47886690e7b24b0eed69b6d870c33ceade62` | `7730f666ee1acabe2cd7729ec56f4c53149d926c` | 34180674115 / 1 |
| #3992 | `3ceef0121712b290c3d4443e9fc3f0a04cecead6` | `74292a21e6d504960ef753b403341498fd5bfe30` | 34181398746 / 1 |
| #3993 | `727683f44e9f1daa9b6b1e2dbf93167e4ce30cc1` | `74f62f9c2914ead2fba474aa97734e322251bd46` | 34185870948 / 1 |
| #4002 | `5d5d35756b9b672aecf10a64be0db1f7afc144ae` | `9ad218a9bdd34ee33004c35706d78396bf02eef2` | 34198172044 / 1 |

Final full `ci.yml` workflow_dispatch lane=all: [34198186409](https://github.com/lidge-jun/opencodex/actions/runs/34198186409), attempt2. All 26 named jobs and mandatory execution steps were verified successful. PR #4002 CI [34198172044](https://github.com/lidge-jun/opencodex/actions/runs/34198172044) passed at the exact final head. A successful attempt2 summary includes successful jobs retained from attempt1; it does not mean those jobs executed again.

## Failures and bounded repairs

- Go's initial synthetic userinfo fixture failed privacy scanning; fixture construction was corrected before candidate CI34178540141 passed.
- The preset's home-guard subprocess stalled on macOS. Its bounded execution/reap/capture repair retained all10 original fixtures and38 assertions; CI34185870948 passed. The native cause remains unproven.
- Recovery CI34188041321 exposed shared test-budget state between synthetic homes. Isolation was corrected without dropping assertions; CI34188893148 passed.
- Full34190287787 at f1b436324 failed Windows restart-help with an unobserved synchronous child exit at10s. The bounded asynchronous CLI harness retained8 original tests/18 assertions and added10 lifecycle controls. Independent source review and later Windows execution passed.
- At f80f39d20, PR34193213502 attempt1 hit a macOS job cancellation at an unchanged injection-lock test boundary. Same-head full macOS1 passed the same tests; one investigated job-only rerun passed. Full34193218874 attempt1 separately timed out in an unchanged Copilot cancellation test; the same-head macOS shard passed that case. One control-only rerun passed, with21,805 main-suite passes and0 failures. Scheduler, ordering and native causes were not established.
- After four parents landed, GitHub refused the last merge while local merge calculation was clean. Two common ancestors were observed. The final ancestry merge incorporated actual dev74f62f9c; independent review proved that only the070 record changed from the already certified f80 product. Fresh exact-head CI was obtained; no old run was relabeled as execution on the new head.
- Full34198186409 attempt1 failed Windows3 cleanup: EPERM removing a fixed test directory in afterEach caused subsequent setup/cleanup failures. Identical product files had passed the preceding Windows3 run. Independent inspection supported one failed-job-only diagnostic rerun. Job101977029312 passed3,304 tests with0 failures; the affected TTL case passed172.72ms. The handle/permission owner remains unknown. No test threshold or product code changed for this retry.

Passing jobs were retained during these job retries, not rerun. Failed/cancelled attempts remain historical evidence. No root-cause or flake-eradication claim follows from a successful retry.

## Attribution, UI and documentation

The carried Go intent retains `Co-authored-by: jpierrevd <265811239+jpierrevd@users.noreply.github.com>`. V2, alias and adapted #3995 coverage/docs retain `Co-authored-by: luvs01 <27862058+luvs01@users.noreply.github.com>`. Merge commits preserve their history. The lossy mixed-ciphertext filtering proposal from #3838 was declined; fail-closed behavior remains.

Dashboard tree `b0bc09ba867906375e52cf0180caa4ea4ea95bea` equals the inspected artifact tree. Hosted artifact10039810403 from34183701289 was observed against a synthetic API: enable, exact custom Save, draft-only Restore, Clear, malformed/missing recommendation, error/retry, server switching,320/390px and desktop layouts, and keyboard focus. Two independent reviewers accepted it. Immutable screenshots are in [#3993](https://github.com/lidge-jun/opencodex/pull/3993), evidence commit924327cdd71a14a0aea1936e4c5e1f6b6b660438. Owned fixture/browser ports were closed.

Docs tree `7041e912691a5150893fbf4f782734c94e49d056` equals the remotely built integrated tree. Bun1.4.0 / Node24.20.0 frozen install and build on isolated macmini-cf scratch produced425 pages; rendered CLI/API anchor and English/Korean recovery text were checked. Archive SHA-256 a51cdbd83f409472defcb7758873734edba167f116a17869ec345366e0e9063d. An early incomplete-transfer attempt was excluded from passing evidence. No docs deployment occurred.

Local product tests/install/typecheck/build: **NOT RUN**. This archive changes only this unit's Markdown records; its own metadata/CI/privacy verification is separate from product execution.
