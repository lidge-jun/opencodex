# Next-release integration results

12 accepted pull requests have been integrated into `dev`. The current release, 2.77.0, completed before integration began. The update-restart proposal remains a deliberately deferred draft.

## Release 2.77.0 completed before integration

Release workflow [37170949169](https://github.com/lidge-jun/opencodex/actions/runs/37170949169) completed at main `06841165f884a9176d701310638b2112aca7a514`. The stable tag, verification receipt, 24 expected files plus updater manifest, npm exact version and `latest` agreed. The downloaded npm package matched its SHA-512 integrity. This was verified at 2026-10-04T02:50:53.711326+00:00. No new release or installed-runtime update was performed by this integration task.

## Accepted changes landed with per-PR evidence

| PR | Change | Merge commit | Successful candidate CI |
| --- | --- | --- | --- |
| [#6554](https://github.com/lidge-jun/opencodex/pull/6554) | Caller session identity | [`f85925d87d`](https://github.com/lidge-jun/opencodex/commit/f85925d87defaec3b328da38946fb27a7c313094) | [37173659981 / attempt 1](https://github.com/lidge-jun/opencodex/actions/runs/37173659981) |
| [#6557](https://github.com/lidge-jun/opencodex/pull/6557) | Devin conversation caching | [`be297a52cd`](https://github.com/lidge-jun/opencodex/commit/be297a52cd50766c54b571b82aeab45759fa6b65) | [37174376575 / attempt 1](https://github.com/lidge-jun/opencodex/actions/runs/37174376575) |
| [#6551](https://github.com/lidge-jun/opencodex/pull/6551) | Bounded Desktop headers | [`df3dd3f111`](https://github.com/lidge-jun/opencodex/commit/df3dd3f1119dc5a9888f9269afdf675c79b69036) | [37175007465 / attempt 1](https://github.com/lidge-jun/opencodex/actions/runs/37175007465) |
| [#6565](https://github.com/lidge-jun/opencodex/pull/6565) | Parent-qualified Devin identity | [`7edad584b4`](https://github.com/lidge-jun/opencodex/commit/7edad584b471fb3d1045acb77fe04ad0060fe494) | [37177632035 / attempt 1](https://github.com/lidge-jun/opencodex/actions/runs/37177632035) |
| [#6555](https://github.com/lidge-jun/opencodex/pull/6555) | Translated reset retry | [`16d5daecd8`](https://github.com/lidge-jun/opencodex/commit/16d5daecd8cd3b84d72e1c9de42477c3d226f3cd) | [37178553374 / attempt 1](https://github.com/lidge-jun/opencodex/actions/runs/37178553374) |
| [#6552](https://github.com/lidge-jun/opencodex/pull/6552) | Native tool names and required beta | [`0455845834`](https://github.com/lidge-jun/opencodex/commit/0455845834aba6cffc169aa11c56772b1cb8194f) | [37179575281 / attempt 1](https://github.com/lidge-jun/opencodex/actions/runs/37179575281) |
| [#6559](https://github.com/lidge-jun/opencodex/pull/6559) | Native Claude account-pool dispatch | [`26dd8cf657`](https://github.com/lidge-jun/opencodex/commit/26dd8cf6579d28027b41acf2b67b2be9228590db) | [37180620212 / attempt 1](https://github.com/lidge-jun/opencodex/actions/runs/37180620212) |
| [#6562](https://github.com/lidge-jun/opencodex/pull/6562) | Native pool preference and persistence | [`33125e62d2`](https://github.com/lidge-jun/opencodex/commit/33125e62d267345d8aaa2e32b993d5bbe8050ff3) | [37181267649 / attempt 1](https://github.com/lidge-jun/opencodex/actions/runs/37181267649) |
| [#6553](https://github.com/lidge-jun/opencodex/pull/6553) | Config-backed catalog removal | [`9289396e54`](https://github.com/lidge-jun/opencodex/commit/9289396e5400db1d42012ef01b2444e4e29b8e13) | [37182275158 / attempt 1](https://github.com/lidge-jun/opencodex/actions/runs/37182275158) |
| [#6558](https://github.com/lidge-jun/opencodex/pull/6558) | Catalog ownership and write intent | [`f74a3db926`](https://github.com/lidge-jun/opencodex/commit/f74a3db92650bfd40fc6496b92a634f2265c7f93) | [37184897609 / attempt 1](https://github.com/lidge-jun/opencodex/actions/runs/37184897609) |
| [#6560](https://github.com/lidge-jun/opencodex/pull/6560) | Bounded private catalog audit | [`8aff79ed29`](https://github.com/lidge-jun/opencodex/commit/8aff79ed2942be778e6cdba8237f902122cb37e1) | [37185939122 / attempt 1](https://github.com/lidge-jun/opencodex/actions/runs/37185939122) |
| [#6563](https://github.com/lidge-jun/opencodex/pull/6563) | Owner-only catalog recovery | [`33185c2ccf`](https://github.com/lidge-jun/opencodex/commit/33185c2ccf7085f94357d9e56512803949b22cc5) | [37188595240 / attempt 1](https://github.com/lidge-jun/opencodex/actions/runs/37188595240) |

Each integration used a current head/base packet, actual tested merge parents, successful applicable CI, independent code/security or interdiff review, current maintainer authority and an explicit integration decision. Actual merge parents and source trees were compared with the tested candidate. Original contributor credit was retained. Skipped platform jobs were not counted as executed tests.

A post-merge parent-identity finding on #6557 paused later integration. #6565 fixed it with failing-before/passing-after coverage; the original review was resolved after verified dev landing. Other valid review findings were repaired before their affected PRs landed.

## Covered originals closed; partial acceptance remains open

Nine original PRs were closed as superseded only after full accepted coverage was checked and replacement links were posted. See [source dispositions](021_disposition_results.md). This did not claim the replacements were already shipped. No unrelated partial backlog item was blanket-closed.

- [Issue #6520](https://github.com/lidge-jun/opencodex/issues/6520): kept open for remaining acceptance.
- [Issue #6511](https://github.com/lidge-jun/opencodex/issues/6511): kept open for remaining acceptance.
- [Issue #6510](https://github.com/lidge-jun/opencodex/issues/6510): closed after accepted dev landing.
- [Issue #6531](https://github.com/lidge-jun/opencodex/issues/6531): closed after accepted dev landing.
- [Issue #6532](https://github.com/lidge-jun/opencodex/issues/6532): kept open for remaining acceptance.
- [Issue #6546](https://github.com/lidge-jun/opencodex/issues/6546): closed after accepted dev landing.
- [Issue #6529](https://github.com/lidge-jun/opencodex/issues/6529): closed for the deterministic missing/fallback-config overwrite reproduction after accepted dev landing.

## Explicit limitations

- #6556 remains a draft; #6548 remains open. The isolated child-start probe passed, but the complete unmocked restart handoff was not established.
- Continuous Windows catalog auditing is deferred. At most a successfully hardened new-file event is recorded; existing files are skipped, including after restart. Hardening failure can leave an empty file. Native NTFS privacy/casing proof is not claimed.
- Catalog recovery detects lost provider namespaces; loss of individual rows while their namespace remains is outside its coverage. The original live catalog writer was not identified. Closing #6529 addresses the deterministic missing/fallback-config overwrite reproduction, not every proposed audit/recovery extension.
- Live Claude multi-account/resumed-cache acceptance, actual Desktop symptom correlation and broader identity-free caller cache behavior remain outside the completed offline validation. Their issues remain open.
- No branch protection was changed. GitHub automatically removed merged parent refs and retargeted children; commit ancestry and open child state were verified.

## Final integration receipt

The last accepted PR, #6563, landed at `33185c2ccf7085f94357d9e56512803949b22cc5`. Cross-platform CI [37188595240](https://github.com/lidge-jun/opencodex/actions/runs/37188595240) and Service lifecycle [37188595216](https://github.com/lidge-jun/opencodex/actions/runs/37188595216), both attempt 1, tested the final head `89f5ef841dcece00c82da0b30af2bc55b5fb9965` against base `8aff79ed2942be778e6cdba8237f902122cb37e1`. Linux systemd, macOS launchd and Windows scheduled-task jobs all ran successfully. The actual CI checkout and resulting merge trees match. [Issue #6529 was closed](https://github.com/lidge-jun/opencodex/issues/6529#issuecomment-5978176292) for the reported overwrite defect, with the limits above stated explicitly.

## Accepted integration is complete; follow-ups remain explicit

All accepted PR integrations and source dispositions are complete. The next release, installed-runtime rollout, deferred restart handoff and the live/native limitations above remain separate follow-up work.

Final remote verification: `python3 .tmp/next-release/check-integration.py` exited 0. It verified all 12 actual CI checkout/base/head/tree relationships, applicable successful jobs, dev ancestry, landed contributor trailers and resolved review threads. Its disposition check confirmed nine superseded sources, four closed issues, three open acceptance issues and two open partial backlog issues with matching comment identities. This is a remote-evidence audit, not a new product test run. No workflow was scheduled for the final dev merge commit; successful candidate CI must not be described as a post-merge dev workflow.

Fresh-reader check: independent reader 01a10611-5d02-7463-a685-a2c52c245352 correctly distinguished the 12 accepted PRs, nine source closures and deferred restart proposal. It requested a direct completion statement and a narrower #6529 status row; both were clarified here.

Independent final audit 01a105e4-c03a-7cc1-b2a7-44d4683efbac returned PASS after running the read-only remote checker (exit 0) and spotchecking the release boundary, source dispositions, contributor credit and narrow #6529 closure. No blocking issues remained.
