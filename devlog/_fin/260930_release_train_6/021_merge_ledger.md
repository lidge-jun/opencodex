# RT6 merge ledger

Maintainer integration into dev by @lidge-jun (admin). Squash unless noted. CI evidence is the exact PR head's `ci` aggregate from Cross-platform CI with its test shards executed.

| PR | Head | CI | Review | Method | dev commit |
| --- | --- | --- | --- | --- | --- |
| #6230 | 613cc84c64 | 36544556487 ci SUCCESS (approved fork run) | L1b review: no findings; 41 focused pass | squash | f966c9faad |
| #6236 | 6a208d5680 | 36568457319 ci SUCCESS (approved fork run) | L1b review: no findings; 44 focused pass | squash | d3d076c5f4 |
| #6248 | 6d23d5eeb0 | ci SUCCESS on exact head | carry of #6225, L1b verified, co-author trailer kept | squash | cbf5faaf33 |
| #6235 | 071fc1d4a5 | 36567964235 ci SUCCESS (approved fork run), 35 success/8 skipped | L3b review: 38/38 focused, clean dry-run with #6204 | squash | ea7bd16abe |
| #6249 | 229beb6a71 | ci SUCCESS, 23 success; enforce-target run 36610198407 was CANCELLED at merge time (gate deviation) and rerun post-merge | L1b evidence-gated fix, pinned Qwen template contract, 48 focused pass | squash | 6da09f661c |
| #6161 | 14b6769958 | 36606990874 ci SUCCESS incl. macos widget+bundle packaged keyring load probe, desktop shell AppImage/deb; rollup 38 success/4 skipped | SR2 APPROVE-SECURITY (loader, staging, ci.yml/release.yml); L4 symlink-layout fix | squash | 3092b55578 |
| #6247 | 22728b9e3f | ci SUCCESS on exact head (22 success/8 skipped) | carry of #6232; structure doc kept at 600/600 after union with #6248 | squash | 48470c3e29 |
| #6255 | 2f7737756b | exact-head CI green after rerun of batch-timeout shard (32 success/7 skipped) | SR-6255 APPROVE-SECURITY; combined-run failures shown pre-existing on dev; oracle updated to follow the recorder | squash | 99878c3569 |
| #6258 | 3488c24389 | ci SUCCESS on exact head (32 success/6 skipped) | carry of #6238; 4 security review rounds, final APPROVE-SECURITY | squash | be218ba688 |
| #6204 | b8d06623be | ci SUCCESS on exact head after dev merge (24 success/7 skipped) | 5 security rounds; final APPROVE-SECURITY (pause fence, report attribution) | merge commit (keeps #6207 ancestry) | f2771cfe5c |
| #6207 | 50b3237514 | ci SUCCESS on exact head after retarget and dev merge (32 success/7 skipped) | delta APPROVE-SECURITY round 1; merge resolution re-reviewed APPROVE-SECURITY; GUI tests 26 pass + build | squash | eafa6bcf08 |
| #6200 | 6d7db760cd | ci SUCCESS on exact head (24 success/7 skipped); dev merged in via update-branch | 5 security rounds, final APPROVE-SECURITY (#6200 scope); luvs01 P2 fixed+answered; CodeRabbit threads answered | squash | dad107c4ef |
| #6203 | 5398f07ad0 | ci SUCCESS on exact head; enforce-target cancelled run re-run to success (36627578897) before merge | 3 security rounds + union and merge-resolution re-reviews, final APPROVE-SECURITY; luvs01 P2 threads fixed+answered | squash | b78bfb8f00 |
| #6261 | 007aabab3f | ci SUCCESS on exact head; fix commit full-matrix dispatch 36633279616 success (attempt 2) | wp9 audit: explains both Windows failures, production path behavior unchanged; regression test red/green | squash | 540af24384 |

Contributor PRs closed after their credited carry landed: #6225 (→ #6248), #6232 (→ #6247), #6234 (→ #6255), #6238 (→ #6258). #6242 was fixed by the new PR #6249.

Issues closed: #6093 and #5679 (already fixed by #6224), #6237 (#6258), #6139 (#6161; load-only packaged evidence stated), #6242 (#6249; no live AMD run), #6162 (#6200), #6197 (#6203), #6013 (#6204 + #6207).

Gate deviations, recorded rather than hidden:
- Merges started during wp1 as items became ready instead of waiting for a separate wp2 cycle.
- #6249 merged while one `enforce-target` run on its head was CANCELLED; the run was re-run to success after the merge. Later merges re-ran a cancelled `enforce-target` before merging (#6203).
- Two hard-order reversals against 000_plan.md: #6235 landed before #6204, and the #6234 carry (#6255) landed before #6203. Reason: both were independently ready while the Anthropic stack was still in security review. Integration evidence: #6235 and #6204 dry-merged cleanly with #6235's tests 38/38 (L3 lane); #6204 was then merged with dev containing #6235 and #6255, re-ran exact-head CI green (b8d06623be), and the one resolved conflict (the paused-account exception moved into `recordAnthropicAccount429`, extracted by #6255) received a targeted security review on dev: APPROVE-SECURITY, 91 focused tests passing (the exception also reaches the retry-exhaustion recorder, which still attributes the 429 to the sent account; paused accounts stay unselectable). #6203 was merged last on a head that already contained #6255 (5398f07ad0, CI green).
- #6200 and #6203 were merged over a standing CHANGES_REQUESTED review from @luvs01 (a contributor reviewer, not a maintainer) after every finding was fixed and answered on its thread.
