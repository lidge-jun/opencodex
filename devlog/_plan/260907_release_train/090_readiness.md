# 090 — Release-train readiness (dev after v2.46.0)

Train head: `origin/dev@f802f7112` (2.47.0). Base: `ece556a6e`. Delta: 28 PR merges, 207 files, +11,450 / −491.
Source plan: `010_recommendations.md` (27 ranked items). Execution log: `010_wp1_execution.md`.

Policy (user instruction, this train): no local suites/typecheck/build/install (NOT RUN); `--no-verify` pushes; manual dependent chains (`stack: null`);
one chain's top head on Cross-platform CI at a time; per-chain gate = Linux 4 + macOS 2 + gates/storage/api/keyring ×3/npm ×3/docker;
Windows 6 shards + macos control once on the final train head; admin merges recorded in each PR body with exact-head evidence;
originals closed with landing SHA and `Co-authored-by` trailers on every carried/reimplemented commit.

## Landed (ranked item → merge)

| # | Item | Landed via | Merge SHA | Chain-top CI | Original disposition |
|---|---|---|---|---|---|
| 1 | #3862 reasoning-envelope admission (Ingwannu) | #3879 | b0bcb4b10 | 34113638182 | PR closed; #3861 closed |
| 2 | #3858 Pi/OpenCode Go affinity (makesomethingshit) | #3880 (+ docs #3888 522ce5f8c) | dac7e28c4 | 34113638182 / 34114667385 | PR closed; #3857 closed |
| 3 | #3840 Copilot Responses-only routing (chilung-cgu) | #3866 | dcec71715 | 34106345180 | PR closed |
| 4 | #3863 Windows health probe (x3M3x) — original commit only | #3875 | 686cb127c | 34116228181 | PR reopened: contributor widened scope mid-train (+2 commits) |
| 5 | #3837 Kiro debug gate (luvs01) + test isolation | #3867 | 0ef7d2906 | 34106345180 | PR closed |
| 6 | #3843 citation span bound (luvs01) + same-delta fix; parity follow-up | #3868, #3882 | 99451df82, 6389787dc | 34106345180 / 34114667385 | PR closed |
| 7 | #3845 keychain restore ownership (luvs01), security review PASS | #3869 | 0719457d1 | 34106345180 | PR closed |
| 8 | #3839 + #3841 Anthropic sidecar bounds (luvs01) | #3873, #3874 | f46a7f49c, 3f07e09bc | 34116228181 | PRs closed |
| 9 | #3860 Desktop sign-in opt-in, default OFF (RobinBially) | #3876 | 2eec04fe1 | 34116228181 | PR closed |
| 10 | #3849 Mihomo IPv6 fake-IP TUN (hualiny) | #3872 | ddee5e8b4 | 34111578200 | PR closed; #3781 slice comment, open |
| 11 | #3856 quota window activation (terrytan95) | #3871 | 62fe747af | 34111578200 | PR closed; #3855 closed |
| 12 | #3838 OpenCode Go input items (jpierrevd) | — | — | — | **DEFER**: planned as M layer after A#3858; not started (see Remaining) |
| 13 | #2033 web-search enabled state (louis-tepe) reimplemented | #3870 | d00615d56 | 34106345180 | PR closed |
| 14 | #3532 CI audit docs (Ingwannu) | #3865 | 7f2fb922c | 34106345180 | PR closed |
| 15 | #3817 price overlay identity (rrmlima) | #3903 | cb1113f6d | 34120761219 | issue closed |
| 16 | #3719 thinking order parity (slice) | #3877 | 4fe4ad8df | 34120761219 | issue slice comment, open |
| 17 | display-name receipt guard | #3902 | d05250de5 | 34120761219 | — |
| 18 | release.yml smoke recovery, security review PASS | #3864 | f4a4b468f | 34119094967 | — |
| 19 | Raycast/CLI/locale docs bundle | #3883 | 1649247c1 | 34121907231 | — |
| 20 | code-mode record + Desktop /model caveat + translations | #3884 | 74089fdc3 | 34121907231 | #3782 commented, open |
| 21 | #3667 manual price editor (nordz0r) | #3904 | 29405d314 | 34120761219 | issue closed |
| 22 | #1533 V2 compatibility guidance (Zbyy0311) | #3878 | d0fca4a9b | 34116228181 | issue closed |
| 23 | #3252 sub-agent fallback GUI (x3M3x) | #3878 | d0fca4a9b | 34116228181 | PR closed |
| 24 | #3774 picker drag-and-drop (leonclab, slice) | #3887 | 1e188b787 | 34124333662 | issue slice comment, open |
| 25 | #3379 usage ranges slice (from #2956, Manson2438) | #3905 | da707ccb6 | 34120761219 | #2956 closed; #3379 slice comment, open |
| 26 | #3769 residual compact fallback (ideabib) | #3881 | 76436a3ee | 34113638182 | PR closed |
| 27 | #3336 pinned reasoning effort (Liang-Psych) + pricing-PUT race fix | #3892 | f802f7112 | 34126879673 | PR closed |

26 of 27 items landed (item 12 deferred). Every merge SHA above is an ancestor of `origin/dev@f802f7112`; every chain's post-merge dev tree
equalled its CI-tested tree (or, for the E docs chain, the prospective `git merge-tree` result after D landed).

## Final train-head CI (Windows + macos control)

Run 34127950924 @f802f7112 (workflow_dispatch, lane=all): Linux 4/4, macOS 1/2 + 2/2, Windows 6/6, gates, storage policy, api usage,
keyring ×3, npm-global ×3, docker smoke = success. `macos control` attempt 1 failed on one test
(`tests/responses/responses-state.test.ts:1552` "shutdown fallback prices the job-owned superseded generation before publishing":
ETIMEDOUT from an 80 ms wall-clock fallback reserve that the test does not freeze; 21,404 pass / 1 fail). Independent diagnosis: FLAKE —
the train did not touch `src/responses/state.ts`, the test, spill/ACL helpers or translator-budget; the same job passed on ece556a6e and on the
C chain head. The failed job alone was rerun (attempt 2) but was cancelled by ref concurrency when an unrelated docs PR (#3910, 8bc9e4ee2, SPONSORS.md + README) pushed to dev at 14:06Z. A fresh lane=all dispatch on dev@8bc9e4ee2 (f802f7112 + that docs-only commit) — run 34131381795 — passed every job: Linux 4/4, macOS 1/2 + 2/2, **macos control**, **Windows 6/6**, gates, storage policy, api usage, keyring ×3, npm-global ×3, docker smoke, aggregate ci = success. That run is the final train-head evidence.

## Remaining / deferred

- Item 12 #3838 (OpenCode Go input-item normalization, jpierrevd): not carried — DEFER to the next train; needs the parent-namespace child identity and
  nameless built-in fixes from the review, on top of #3880.
- #3863 (x3M3x): reopened; the contributor widened it (combo capabilities, archive retention, health-refresh rejection guard). Only the original
  startup-health-cache commit landed (#3875). Contributor to rebase onto dev for the rest.
- #3848 (#3846, shaun0927): DEFER by plan (sponsorship + 61-file scope); untouched.
- Slices kept open: #3719 (live replay/cache acceptance), #3379 (selector rename), #3774 (native/featured rows), #3781 (authenticated TUN acceptance), #3782 (client-owned).
- Known pre-existing flake to fix separately: `responses-state.test.ts` shutdown-fallback test should freeze `Date.now()` like its neighbour at :1494.

## Release readiness

dev@8bc9e4ee2 (train head f802f7112 + docs #3910) is release-candidate ready: full matrix green on run 34131381795. Version line is already 2.47.0 (opened in #3850).
Promotion to preview/main and npm publish are outside this train's scope.

