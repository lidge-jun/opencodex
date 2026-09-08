# Lane C outcome

All three scoped corrections landed into dev through independent bug PRs. The capture correction needed a separate follow-up after its author advanced the source PR during CI. No already-landed commit was rewritten. This record is documentation only and is not another product fix.

| Source | Delivery PR | Landed SHA | Current-head CI | Scope |
|---|---|---|---|---|
| #3953 initial | [3955](https://github.com/lidge-jun/opencodex/pull/3955) | `9c54000c937276ba8d93ce63a922b3fe6797cbde` | [34166758020](https://github.com/lidge-jun/opencodex/actions/runs/34166758020) (3 success / 10 skipped) | Current-tree Accounts capture cleanup |
| #3953 follow-up | [3959](https://github.com/lidge-jun/opencodex/pull/3959) | `01c23aedcdfcb913151a2ac8f7acebda58d91eee` | [34167651789](https://github.com/lidge-jun/opencodex/actions/runs/34167651789) (3 success / 10 skipped) | Consistent capture retention and isolation guidance |
| #3899 / #3895 | [3960](https://github.com/lidge-jun/opencodex/pull/3960) | `9c8f66b9df4cdf133a16c95a95ee07ff5171a46d` | [34168481093](https://github.com/lidge-jun/opencodex/actions/runs/34168481093) (16 success / 3 skipped) | Release-note marker in both actual and standalone builders |
| #3950 timezone only | [3967](https://github.com/lidge-jun/opencodex/pull/3967) | `c46c22f3e4d00ff31a0e6bb10f74505577806776` | [34170093095](https://github.com/lidge-jun/opencodex/actions/runs/34170093095) (19 success / 2 skipped) | Santiago subprocess isolation and oracle integrity |

## Proof and attribution

Each landing was serialized through the shared merge lock and checked against the then-current destination: actual merge parent, computed combined tree, dev ancestry and surviving Co-authored-by trailer. luvs01 is credited in both capture carries and the timezone carry; Joonsuh Park is credited in the release-note correction. The original source PRs were closed as carried, not described as directly merged.

#3953 was closed only after its refreshed ca21efd2 follow-up was included. #3899 and issue #3895 closed after the active release builder was corrected and verified. #3950 was closed only after B's independent JWT delivery #3962 (eb4188a9f2e127f5ee2980b62d6e5bb213c43c70) and C's timezone delivery #3967 were both confirmed on dev. Product commits remain independently revertible.

The release-note original patch missed scripts/build-release-changelog.ts, the actual release workflow entry. Review led to a shared normalizer and five public-builder cases covering generated and associated PR sources and negative marker preservation. Those cases and the original renderer cases were observed passing in the final Linux CI logs; the final macOS lanes also passed. The structure guide now accurately distinguishes the active and standalone renderers.

Timezone final candidate ce71d917143ddcbd5675b6ba92d8b1053971cd25 was separately exercised by evidence workflow7d5f1097ec587a0ced441f475eb02d750e06b9ac in [run34170111719](https://github.com/lidge-jun/opencodex/actions/runs/34170111719). The workflow checked out that immutable candidate separately. Linux, Windows and macOS each completed ten scenarios: five positive/restored runs and five deliberately failing controls. Controls require the intended test failure and specific diagnostics, not any nonzero exit. All platforms verified the final candidate file hash recorded below. Child timeout termination and restored candidate bytes/HEAD were verified. The evidence branch is not in any delivery PR and is never merged.

## Limits and remaining work

- All local product tests, test:changed, typechecks, builds and dependency installs were NOT RUN. Mutating Git operations disabled hooks per command, and pushes used --no-verify. Git/diff/source and operational evidence checks are distinct from product tests.
- Skipped jobs are not counted as passing tests. Normal PR workflows skip the full Windows runtime suite and macOS whole-pool control; the supplementary timezone run explicitly supplies Windows/macOS focused dashboard evidence, not a full runtime-suite result.
- Timezone normal CI34170093095 attempt1 timed out after20minutes in the unchanged root macOS client-connect test. The next helper contains an unbounded synchronous child wait, but the actual stopping mechanism is unproven. Attempt2 succeeded on the same candidate without a source change. The cancelled attempt remains unsuccessful evidence and the unrelated CI reliability defect is not claimed fixed.
- Privacy cleanup affects the current tree only. Historical blobs/links were not purged, and no claim of historical erasure is made. The working proxy was not restarted or reconfigured by this task.
- Concurrent dev changes were preserved through actual-tree comparison. That structural proof does not imply every merged integration tree was separately executed by the candidate CI.
- A and B were still active at reconciliation. B's JWT slice is verified; no assertion is made that their remaining changes or the overall2.48 release are complete. main/preview promotion, version changes and npm publication were outside C's authority and were not performed.

## Final supplemental evidence

- win32: Bun1.4.0, candidate file SHA-256 `6cbb58c96643f500cf2541ef3b7707aed072c1f981b16b49f97949536fe30f50`, ten scenarios, restored=True.
- linux: Bun1.4.0, candidate file SHA-256 `6cbb58c96643f500cf2541ef3b7707aed072c1f981b16b49f97949536fe30f50`, ten scenarios, restored=True.
- darwin: Bun1.4.0, candidate file SHA-256 `6cbb58c96643f500cf2541ef3b7707aed072c1f981b16b49f97949536fe30f50`, ten scenarios, restored=True.
