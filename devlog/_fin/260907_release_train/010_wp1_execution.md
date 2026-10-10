# 010 — wp1 execution log (main lane M + dispatch)

## Dispatch (2026-09-07 ~09:20Z)
Threads created (gpt-6-astra, high): A 01a07b28-06e1-77e3-a323-1e400fd777ca, B 01a07b28-06f3-7cd0-ba8a-c646d4dc5c11,
C 01a07b28-0793-7ff1-abb6-adbbb31d1c72, D 01a07b28-072f-7b93-b840-0f0f16b0ec33, E 01a07b28-06f3-7cd0-ba8a-c62b1f7d1d94.
Ownership amendments accepted during wp1: B owns how-it-works.mdx (en+4) for #3856; i18n is append-only multi-writer;
E owns reference/configuration/providers.md locales for #19; D owns the single modelCosts zero sentence in those files for #3667.

## Main lane M chain (PRs #3865 → #3870)
| Layer | PR | Branch | Head | Source | Notes |
|---|---|---|---|---|---|
| 1 | #3865 | codex/rt-m1-3532 | f1604c6b2 | #3532 Ingwannu | cherry-pick -x, [skip ci] |
| 2 | #3866 | codex/rt-m2-3840 | 98564bdbf | #3840 chilung-cgu | 5 commits squashed (merge commit in source), [skip ci] |
| 3 | #3867 | codex/rt-m3-3837 | 6061dcce0 | #3837 luvs01 | + test isolation fix for discussion_r3945935220 |
| 4 | #3868 | codex/rt-m4-3843 | 00b74c720 | #3843 luvs01 | + same-delta fix for discussion_r3946034145 |
| 5 | #3869 | codex/rt-m5-3845 | 924b65799 | #3845 luvs01 | security review PASS pasted in PR body |
| 6 | #3870 | codex/rt-m6-2033 | 6eadb1658 | #2033 louis-tepe (reimplemented) | top; amended after first top CI |

Independent chain review (astra explorer): PASS, no blockers; security review of #3845 PASS.

Top CI history:
- run 34105730157 @911047281: test 2/4 FAIL — `tests/vision/vision-anthropic.test.ts:342` exact-equality on webSearch body lacked the new `enabled` key (two assertions). Fixed in 6eadb1658 (amend of layer 6). Run cancelled.
- run 34106345180 @6eadb1658 (workflow_dispatch lane=all): queued behind a 60+ run backlog (all lanes dispatching simultaneously). Duplicate pull_request run 34106351272 cancelled.

## Lane status (from wait_threads snapshots)
- A: chain #3879 → #3880 → #3881 published, three-layer source/security audits PASS, top fa9c1ee68 CI queued.
- B: chain #3871 (#3856) → #3872 (#3849); top CI: Linux test 3/4 failure under analysis by lane B.
- C: chain c1…c5 (#3839, #3841, #3863, #3860, #3252) with GUI re-audit PASS; top 8f8ac0d82 CI requested.
- D: #3877 (#3719 ordering) + name-guard layer + price overlay in progress; audits PASS on first two.
- E: #3864 (#18 release.yml) CI in progress with security audit; #19/#20 handoff patches prepared against ece556a6e.


## Landing (wp1 D, 2026-09-07 ~10:40Z)
| Layer | PR | Merge SHA | Original closed |
|---|---|---|---|
| 1 | #3865 | 7f2fb922c | #3532 |
| 2 | #3866 | dcec71715 | #3840 |
| 3 | #3867 | 0ef7d2906 | #3837 |
| 4 | #3868 | 99451df82 | #3843 |
| 5 | #3869 | 0719457d1 | #3845 |
| 6 | #3870 | d00615d56 | #2033 |

Chain-top CI: run 34106345180 @6eadb1658 (lane=all) success, aggregate `ci` success. Prospective merge tree `git merge-tree --write-tree origin/dev codex/rt-m6-2033` = 7621cac89 = tested tree; post-merge `origin/dev^{tree}` = 7621cac89. Every layer head and d00615d56 are ancestors of fetched dev. Stale CodeRabbit trailer findings on #3869/#3870 replied (heads carry trailers). Lanes notified of the new dev head; A told that M#3838 follows A#3858.


## wp2 amendments (user instruction, 2026-09-07 ~10:50Z)
- CI runner saturation: all queued Cross-platform runs cancelled; one chain at a time. Order: B → A → M7 (#3882) → C → E #3864 → D → E rest.
- Per-chain gate excludes Windows shards and macos control; they run once on the final release-train head (wp3).
- Lane B landed: #3871 (62fe747af) → #3872 (ddee5e8b4); tree 58536270a == tested; run 34111578200 (Linux 1/2/4, macOS 1/2, gates, policy, api, keyring, npm, docker green; test 3/4 = prompt-text-probe timing flake, untouched by B; Windows/control cancelled by policy). Closed #3856, #3849, issue #3855; #3781 slice comment.
- Lane A landed: #3879 (b0bcb4b10) → #3880 (dac7e28c4) → #3881 (76436a3ee); tree d4f095822 == tested; run 34113638182 (all non-Windows/control jobs green). Closed #3862/#3858/#3769, issues #3861/#3857.
- M7 #3882 (citation whole-string/streaming parity, found by lane A composition audit) merged 6389787dc; M8 #3888 (providers.md hunk from A) merged 522ce5f8c; run 34114667385 green on non-Windows/control jobs.
- Slot order now: C → E #3864 → D → E docs/#3774/#3336.
- Lane C landed: #3873 (f46a7f49c) → #3874 (3f07e09bc) → #3875 (686cb127c) → #3876 (2eec04fe1) → #3878 (d0fca4a9b); tree e0b0e5886 == tested; run 34116228181 aggregate ci success (attempt 2 after a macos 1/2 20-min hang in codex-inject-write-lock; cause unproven, no code change). Closed #3839/#3841/#3860/#3252, issue #1533. #3863 reopened: contributor widened it mid-train (retitled, +2 commits) — only the original health-cache commit landed via #3875.
- Lane E #3864 (release.yml registry-smoke recovery, security review PASS) merged f4a4b468f; run 34119094967 green on non-Windows/control jobs.
- Slot order now: D → E docs (#3883/#3884) → #3887 → #3892 → final Windows/control run on the train head.
- Lane D landed: #3877 (4fe4ad8df) → #3902 (d05250de5) → #3903 (cb1113f6d) → #3904 (29405d314) → #3905 (da707ccb6); tree ded24302f == tested; run 34120761219 (non-Windows/control jobs green; two CI-found repairs: react-compiler EffectSetState in ModelPriceDialog, GUI test alert selectors). Closed issues #3817/#3667, PR #2956 (slice); #3719/#3379 slice comments, kept open.
- Remaining: E docs (#3883/#3884, run 34121907231) → #3887 (#3774 DnD) → #3892 (#3336) → final Windows/control run on train head.
- Lane E docs landed: #3883 (1649247c1) → #3884 (74089fdc3); tree c415b6abd == prospective merge tree (differs from tested 986ae11d only by D's landed files; shared locale reference files auto-merged in disjoint sections). run 34121907231. #3782 commented (docs caveat, stays open).
- Lane E #3887 (#3774 DnD slice) merged 1e188b787; tree 139cade3f == tested; run 34124333662 (two CI-found repairs: EffectSetState lint in ModelPickerOrderEditor, stale-GET fixtures). #3774 slice comment, stays open.
- Remaining: #3892 (#3336) → final Windows/control run on train head → wp3 readiness doc.
- Lane E #3892 (#3336 carry + pricing-PUT race fix) merged f802f7112; tree 402b8e750 == tested; run 34126879673. Closed #3336.
- All chains landed. Final train head dev f802f7112; full lane=all (Windows 6 + macos control) dispatched: run 34127950924.
