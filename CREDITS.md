# Credits

When a maintainer lands another author's pull request by reimplementing,
carrying, or rebasing it, the resulting commit is authored by the maintainer.
The contributor's name survives only through a `Co-authored-by` trailer — that
trailer is what GitHub reads for the contributor graph, the repository's
contributor list, and the author's own profile activity.

Some of those landings carry the trailer. Others state the debt in the commit
body and omit it:

```
  53c09a247  "Clean reimplementation of #3193"   Co-authored-by: alan7629 ...
  5734a1caf  "Reimplements #2797 by @rrmlima."   (no contributor trailer)
```

Both sentences are equally sincere. Only the first is data.

The commits below are inside published release tags and behind branch rulesets
that block force-pushes, so the trailers cannot be added retroactively without
invalidating every tag and clone —
[`MAINTAINERS.md`](./MAINTAINERS.md) states the same principle in the other
direction: authorship credit in git history is not rewritten. This file is the
forward repair.

Every entry cites the maintainer's own words from the closing comment, pull-request
description, or landing commit. Nothing here is inferred from a diff.

This file is **not** a contributor list. Most contributions merged normally,
with authorship intact, and need no entry. Absence from this page means the
ordinary path worked.

## Carried work

Code, design, or tests from these pull requests shipped.

| Pull request | Author | Landed as | What landed |
| --- | --- | --- | --- |
| [#1801](https://github.com/lidge-jun/opencodex/pull/1801) | [@jonathanli12](https://github.com/jonathanli12) | `cb48c2e11` | "carries all three of its unique tests" — the Cursor code-mode contract |
| [#2123](https://github.com/lidge-jun/opencodex/pull/2123) | [@chilung-cgu](https://github.com/chilung-cgu) | `ef7b3c9cf` | "Your account loop and the reuse of `getTokenForAccountQuotaProbe` are what shipped" |
| [#2655](https://github.com/lidge-jun/opencodex/pull/2655) | [@TooSpace](https://github.com/TooSpace) | `607042b02` | "re-implemented on current `dev` from your design" |
| [#2693](https://github.com/lidge-jun/opencodex/pull/2693) | [@yxr1995-maker](https://github.com/yxr1995-maker) | `d829215af`, `bdc1e97bb` | "carries your fix forward with the three review blockers closed" |
| [#2734](https://github.com/lidge-jun/opencodex/pull/2734) | [@TooSpace](https://github.com/TooSpace) | `88c427522` | "That carry keeps the adaptive effort-mode design" |
| [#2744](https://github.com/lidge-jun/opencodex/pull/2744) | [@yxr1995-maker](https://github.com/yxr1995-maker) | `8877df0ee` | "Your diagnosis held up"; the landed fix reimplements it narrowly |
| [#2796](https://github.com/lidge-jun/opencodex/pull/2796) | [@rrmlima](https://github.com/rrmlima) | `bb3321ca8` | "Reimplements #2796 by @rrmlima" |
| [#2797](https://github.com/lidge-jun/opencodex/pull/2797) | [@rrmlima](https://github.com/rrmlima) | `5734a1caf` | "Reimplements #2797 by @rrmlima" |
| [#2812](https://github.com/lidge-jun/opencodex/pull/2812) | [@gaoran1209](https://github.com/gaoran1209) | `c986d1d20` | "Reimplements #2812 by @gaoran1209 with the maintainer's blocker addressed" |
| [#2867](https://github.com/lidge-jun/opencodex/pull/2867) | [@Ingwannu](https://github.com/Ingwannu) | `8d1dc1f5d` | "That landed change includes this PR's strict LoadState parsing" |
| [#2870](https://github.com/lidge-jun/opencodex/pull/2870) | [@luvs01](https://github.com/luvs01) | `de91dfde4` | "the coalescing design here is right, and it is carried forward" |
| [#2884](https://github.com/lidge-jun/opencodex/pull/2884) | [@chilung-cgu](https://github.com/chilung-cgu) | `eb52973c5` | "Completes contributor PR #2884"; the exact-name approach carried as-is |
| [#3000](https://github.com/lidge-jun/opencodex/pull/3000) | [@MarcTCruz](https://github.com/MarcTCruz) | `fecb77a91` | "Your central insight" — the refresh lock and the file it protects live under different homes |
| [#3039](https://github.com/lidge-jun/opencodex/pull/3039) | [@ntdatt812](https://github.com/ntdatt812) | `b14b741dc` | "keeps your production logic exactly as written — the Windows budget, the `waited` guard, and the grace probe" |
| [#3041](https://github.com/lidge-jun/opencodex/pull/3041) | [@ntdatt812](https://github.com/ntdatt812) | `b46164e78` | "carries your three merge-loop tests … they came from this PR" |
| [#3067](https://github.com/lidge-jun/opencodex/pull/3067) | [@ntdatt812](https://github.com/ntdatt812) | `b14b741dc` | "keeps your diagnosis and your relocation", with the remedy narrowed |
| [#3078](https://github.com/lidge-jun/opencodex/pull/3078) | [@Veritas-7](https://github.com/Veritas-7) | `0ef04e640` | "reimplements both of your production hunks on `dev`" |
| [#3142](https://github.com/lidge-jun/opencodex/pull/3142) | [@olddonkey](https://github.com/olddonkey) | `52d941640` | "That carry keeps the measurement/refusal work and ships the guard default-off" |
| [#3300](https://github.com/lidge-jun/opencodex/pull/3300) | [@S0RYUASUKA](https://github.com/S0RYUASUKA) | `15b43e51c` | the same two test files made hermetic |
| [#3284](https://github.com/lidge-jun/opencodex/pull/3284) | [@mdwsk88](https://github.com/mdwsk88) | `3d3c4fe26` | "Core implementation is already on `dev` via #3286 (`3d3c4fe26`), including the suffix wire ladder, picker collapse, Google adapter coverage" |

### 2026-09-07 follow-up: missing or malformed trailers

These additional landings are present in the audited 3,000-commit window.
The linked landing descriptions or commit messages identify what was taken.

| Pull request | Author | Landed as | What landed |
| --- | --- | --- | --- |
| [#1748](https://github.com/lidge-jun/opencodex/pull/1748) | [@Blushyes](https://github.com/Blushyes) | [`e3bbf5321`](https://github.com/lidge-jun/opencodex/commit/e3bbf5321c6c0483e9662466e044545bb0e086ba) | [Scoped reimplementation of the outbound Fake-IP discovery fix; the source PR author is @Blushyes, correcting the name in the landing message.](https://github.com/lidge-jun/opencodex/commit/e3bbf5321c6c0483e9662466e044545bb0e086ba) |
| [#1842](https://github.com/lidge-jun/opencodex/pull/1842) | [@luvs01](https://github.com/luvs01) | [`e1e431332`](https://github.com/lidge-jun/opencodex/commit/e1e43133281cba5f952dfa3226a4d55d505365b5) | [Public OAuth error projection and preservation of typed authentication failures.](https://github.com/lidge-jun/opencodex/pull/2043) |
| [#1889](https://github.com/lidge-jun/opencodex/pull/1889) | [@dbc-hbin](https://github.com/dbc-hbin) | [`ea16f8613`](https://github.com/lidge-jun/opencodex/commit/ea16f86130291042486ba3c10640e73b63772d27) | [The remaining x-goog-api-client removal and the contributor's header assertions.](https://github.com/lidge-jun/opencodex/pull/2018) |
| [#1896](https://github.com/lidge-jun/opencodex/pull/1896) | [@luvyoun0224-beep](https://github.com/luvyoun0224-beep) | [`5f2b93979`](https://github.com/lidge-jun/opencodex/commit/5f2b93979e4eae78e1a8c66d1f4a324c4f394084) | [The functions-namespace parser flattening; the hardcoded-name guidance was not taken.](https://github.com/lidge-jun/opencodex/pull/2020) |
| [#1899](https://github.com/lidge-jun/opencodex/pull/1899) | [@ntdatt812](https://github.com/ntdatt812) | [`fb5ceee35`](https://github.com/lidge-jun/opencodex/commit/fb5ceee35f18925a118615b3eb69dc0093f27730) | [The catalog-writer temp-path binding, extended with ordered write/harden/publish assertions.](https://github.com/lidge-jun/opencodex/pull/1923) |
| [#1920](https://github.com/lidge-jun/opencodex/pull/1920) | [@Yuxin-Qiao](https://github.com/Yuxin-Qiao) | [`34b167367`](https://github.com/lidge-jun/opencodex/commit/34b167367c09a3a2445261b845ed10a3c0664693) | [Scoped native and replay Computer Use tool-result normalization.](https://github.com/lidge-jun/opencodex/pull/2038) |
| [#1932](https://github.com/lidge-jun/opencodex/pull/1932) | [@harryzhou2000](https://github.com/harryzhou2000) | [`f2b507f83`](https://github.com/lidge-jun/opencodex/commit/f2b507f831e8065d4fac2fd9fe44bf8106b3fa0e) | [The transient bare-401 concept and test scaffolding; the literal trailer "PR #1932" identifies no account.](https://github.com/lidge-jun/opencodex/pull/2021) |
| [#2027](https://github.com/lidge-jun/opencodex/pull/2027) | [@yzxcj797](https://github.com/yzxcj797) | [`5445ce3e6`](https://github.com/lidge-jun/opencodex/commit/5445ce3e626849855521e5ff54571a1c3babc7e2), [`293494cfa`](https://github.com/lidge-jun/opencodex/commit/293494cfa0c89542320a14bb3af6e4a3f31935a2) | ["Absorbed from #2027" — OpenCode Go identity follows its destination.](https://github.com/lidge-jun/opencodex/commit/5445ce3e626849855521e5ff54571a1c3babc7e2) |
| [#2040](https://github.com/lidge-jun/opencodex/pull/2040) | [@Ingwannu](https://github.com/Ingwannu) | [`16345ab8b`](https://github.com/lidge-jun/opencodex/commit/16345ab8b0a9e5d6fdc8a237786339b674fc374c) | ["implementation and tests, with two corrections".](https://github.com/lidge-jun/opencodex/commit/16345ab8b0a9e5d6fdc8a237786339b674fc374c) |
| [#2053](https://github.com/lidge-jun/opencodex/pull/2053) | [@Ingwannu](https://github.com/Ingwannu) | [`f4ad13922`](https://github.com/lidge-jun/opencodex/commit/f4ad1392271370e1c7c08b0b11ddea346d065138) | ["Carries @Ingwannu's #2053 unchanged."](https://github.com/lidge-jun/opencodex/commit/f4ad1392271370e1c7c08b0b11ddea346d065138) |
| [#2056](https://github.com/lidge-jun/opencodex/pull/2056) | [@Ingwannu](https://github.com/Ingwannu) | [`9b0c5a02d`](https://github.com/lidge-jun/opencodex/commit/9b0c5a02d95220161fc18c72aba5756fdcbf68e3) | [The shortPercent known-quota and scoring changes.](https://github.com/lidge-jun/opencodex/commit/9b0c5a02d95220161fc18c72aba5756fdcbf68e3) |
| [#2075](https://github.com/lidge-jun/opencodex/pull/2075) | [@olddonkey](https://github.com/olddonkey) | [`647b98eb8`](https://github.com/lidge-jun/opencodex/commit/647b98eb8ae4d4ca3c16e1d515dc17a97e5993e4) | [The native Chat fast-capability gate, reconciled with the exact-ID contract.](https://github.com/lidge-jun/opencodex/commit/647b98eb8ae4d4ca3c16e1d515dc17a97e5993e4) |
| [#2077](https://github.com/lidge-jun/opencodex/pull/2077) | [@ntdatt812](https://github.com/ntdatt812) | [`f9c224b70`](https://github.com/lidge-jun/opencodex/commit/f9c224b70abcb4237d166d93fd10677791719b51) | ["Both patches are @ntdatt812's work from #2100 and #2077, applied unchanged."](https://github.com/lidge-jun/opencodex/commit/f9c224b70abcb4237d166d93fd10677791719b51) |
| [#2082](https://github.com/lidge-jun/opencodex/pull/2082) | [@yzxcj797](https://github.com/yzxcj797) | [`06cdbc109`](https://github.com/lidge-jun/opencodex/commit/06cdbc109a631203618a2d1bcf2f395f121af8fa), [`057e8575c`](https://github.com/lidge-jun/opencodex/commit/057e8575c3138f4e90d31e23feccbad60511a2fe) | [AgentRouter opening-turn framing, with exact hostname and separate-block corrections.](https://github.com/lidge-jun/opencodex/commit/06cdbc109a631203618a2d1bcf2f395f121af8fa) |
| [#2099](https://github.com/lidge-jun/opencodex/pull/2099) | [@yzxcj797](https://github.com/yzxcj797) | [`81492fd10`](https://github.com/lidge-jun/opencodex/commit/81492fd10f428d7d638550de4ba2ebcdf13d7715) | [The repro-shaped prompt-cache-retention test fixture; the runtime contract came from #2102.](https://github.com/lidge-jun/opencodex/pull/2138) |
| [#2100](https://github.com/lidge-jun/opencodex/pull/2100) | [@ntdatt812](https://github.com/ntdatt812) | [`f9c224b70`](https://github.com/lidge-jun/opencodex/commit/f9c224b70abcb4237d166d93fd10677791719b51) | ["Both patches are @ntdatt812's work from #2100 and #2077, applied unchanged."](https://github.com/lidge-jun/opencodex/commit/f9c224b70abcb4237d166d93fd10677791719b51) |
| [#2101](https://github.com/lidge-jun/opencodex/pull/2101) | [@Ingwannu](https://github.com/Ingwannu) | [`0bce9516d`](https://github.com/lidge-jun/opencodex/commit/0bce9516d8d987d5b209d1c92cce24d278941b55) | [The entitlement module and full test suite, with maintainer corrections.](https://github.com/lidge-jun/opencodex/pull/2146) |
| [#2102](https://github.com/lidge-jun/opencodex/pull/2102) | [@lilinxiong](https://github.com/lilinxiong) | [`5904178c3`](https://github.com/lidge-jun/opencodex/commit/5904178c349c555704b5f461ef38a47a47324074) | [The prompt-cache-retention implementation, narrowed to the exact native model family.](https://github.com/lidge-jun/opencodex/pull/2138) |
| [#2104](https://github.com/lidge-jun/opencodex/pull/2104) | [@olddonkey](https://github.com/olddonkey) | [`7cd270dc2`](https://github.com/lidge-jun/opencodex/commit/7cd270dc2cd4f5a4cb07b2f23b4eb0dfe869b0da) | ["Carries @olddonkey's #2104 unchanged."](https://github.com/lidge-jun/opencodex/commit/7cd270dc2cd4f5a4cb07b2f23b4eb0dfe869b0da) |
| [#2105](https://github.com/lidge-jun/opencodex/pull/2105) | [@lilinxiong](https://github.com/lilinxiong) | [`a0635eaa2`](https://github.com/lidge-jun/opencodex/commit/a0635eaa2ec16344e25f77f41916637f9cddc4c3) | ["Carries @lilinxiong's #2105 implementation and tests."](https://github.com/lidge-jun/opencodex/commit/a0635eaa2ec16344e25f77f41916637f9cddc4c3) |
| [#2109](https://github.com/lidge-jun/opencodex/pull/2109) | [@drakonkat](https://github.com/drakonkat) | [`d2493a147`](https://github.com/lidge-jun/opencodex/commit/d2493a147d5286f54be34735a13f5d13f8f19597) | [The shared base-URL override implementation from #2109 and #2110.](https://github.com/lidge-jun/opencodex/pull/2148) |
| [#2110](https://github.com/lidge-jun/opencodex/pull/2110) | [@drakonkat](https://github.com/drakonkat) | [`d2493a147`](https://github.com/lidge-jun/opencodex/commit/d2493a147d5286f54be34735a13f5d13f8f19597) | [The shared base-URL override implementation from #2109 and #2110.](https://github.com/lidge-jun/opencodex/pull/2148) |
| [#2122](https://github.com/lidge-jun/opencodex/pull/2122) | [@chilung-cgu](https://github.com/chilung-cgu) | [`6a6efa928`](https://github.com/lidge-jun/opencodex/commit/6a6efa928a165726c0fd17d893d11c21176dc812) | [Configuration union, schema and migration design for retainModels; #2860 supplied the retention predicate.](https://github.com/lidge-jun/opencodex/pull/3206) |
| [#2127](https://github.com/lidge-jun/opencodex/pull/2127) | [@agentHits](https://github.com/agentHits) | [`1adcfde0c`](https://github.com/lidge-jun/opencodex/commit/1adcfde0cfff10589eefdaa33aae077ffe404bcc) | ["Carries @agentHits's #2127 unchanged."](https://github.com/lidge-jun/opencodex/commit/1adcfde0cfff10589eefdaa33aae077ffe404bcc) |
| [#2131](https://github.com/lidge-jun/opencodex/pull/2131) | [@bet4it](https://github.com/bet4it) | [`8ff77e11e`](https://github.com/lidge-jun/opencodex/commit/8ff77e11ebe7bc6472164d29c89c779986b9469a) | ["Carries @bet4it's #2131 implementation and tests."](https://github.com/lidge-jun/opencodex/commit/8ff77e11ebe7bc6472164d29c89c779986b9469a) |
| [#2155](https://github.com/lidge-jun/opencodex/pull/2155) | [@waw4303](https://github.com/waw4303) | [`64ba54edb`](https://github.com/lidge-jun/opencodex/commit/64ba54edbe5ac90b1127f51d5890e33da183c3f0), [`772d375fe`](https://github.com/lidge-jun/opencodex/commit/772d375fed252f838c41b9315cf88046f64d192a) | [Resolved tool-call padding handling, with per-field provenance and diagnostic corrections.](https://github.com/lidge-jun/opencodex/commit/64ba54edbe5ac90b1127f51d5890e33da183c3f0) |
| [#2227](https://github.com/lidge-jun/opencodex/pull/2227) | [@olddonkey](https://github.com/olddonkey) | [`63d387cae`](https://github.com/lidge-jun/opencodex/commit/63d387cae369e3e72d4d0a7702db9d98e607d785) | [The Grok OAuth registry flip, structure documentation and test conversions.](https://github.com/lidge-jun/opencodex/pull/2255) |
| [#2432](https://github.com/lidge-jun/opencodex/pull/2432) | [@mdwsk88](https://github.com/mdwsk88) | [`850afb2e9`](https://github.com/lidge-jun/opencodex/commit/850afb2e9f84979c87e914b248de482f44b34cd6) | [The omit-sentinel documentation and provider wire comments.](https://github.com/lidge-jun/opencodex/pull/3603) |
| [#2639](https://github.com/lidge-jun/opencodex/pull/2639) | [@bet4it](https://github.com/bet4it) | [`fefeb0501`](https://github.com/lidge-jun/opencodex/commit/fefeb05016d21dc9a3b8afe1b52427e4e1d8a0ed) | [The Responses item status backfill; queued/in_progress mapping was corrected separately.](https://github.com/lidge-jun/opencodex/pull/2721) |
| [#2647](https://github.com/lidge-jun/opencodex/pull/2647) | [@darwintree](https://github.com/darwintree) | [`e1e6ec04f`](https://github.com/lidge-jun/opencodex/commit/e1e6ec04f43a287b4cfb5149893d2c6c0a520588) | [Command Code profile metadata, reconciled with the intervening catalog update.](https://github.com/lidge-jun/opencodex/pull/2721) |
| [#2663](https://github.com/lidge-jun/opencodex/pull/2663) | [@Eleven-is-cool](https://github.com/Eleven-is-cool) | [`cb9bb9b76`](https://github.com/lidge-jun/opencodex/commit/cb9bb9b7634640f18568207322d386a059f6c9ac) | [Bare code-mode helper calls through exec: "the implementation is yours, unchanged".](https://github.com/lidge-jun/opencodex/pull/2724) |
| [#2938](https://github.com/lidge-jun/opencodex/pull/2938) | [@luvs01](https://github.com/luvs01) | [`8427efe6e`](https://github.com/lidge-jun/opencodex/commit/8427efe6e80a5ce9488eab7b80b2b1663ab20579) | [The failed-wrapper diagnosis and linear-scan design, with six behavioral divergences corrected.](https://github.com/lidge-jun/opencodex/pull/2945) |
| [#3069](https://github.com/lidge-jun/opencodex/pull/3069) | [@justin-mc-lai](https://github.com/justin-mc-lai) | [`a0d386b49`](https://github.com/lidge-jun/opencodex/commit/a0d386b49074ec81df5646fcc20a5e4979c67878) | [The two query/queries parity commits, followed by malformed-history boundary fixes.](https://github.com/lidge-jun/opencodex/pull/3089) |
| [#3329](https://github.com/lidge-jun/opencodex/pull/3329) | [@Veritas-7](https://github.com/Veritas-7) | [`3ac310782`](https://github.com/lidge-jun/opencodex/commit/3ac31078244ea04c9abce0e50275ffaccf25455a) | [Combo cooldown/wait design with corrected reset metadata, clocks and Retry-After handling.](https://github.com/lidge-jun/opencodex/pull/3606) |
| [#3407](https://github.com/lidge-jun/opencodex/pull/3407) | [@turin-dev](https://github.com/turin-dev) | [`3b3fe21d4`](https://github.com/lidge-jun/opencodex/commit/3b3fe21d45e57761e9769020da4b37de5cd95726) | [The desired-state Codex switch, observed-state badge and effective-home path.](https://github.com/lidge-jun/opencodex/pull/3617) |
| [#3421](https://github.com/lidge-jun/opencodex/pull/3421) | [@Skyline-23](https://github.com/Skyline-23) | [`89c0a64fe`](https://github.com/lidge-jun/opencodex/commit/89c0a64fe2c59af1814230b0c85d61cd08672bd5) | [The Compose/container foundation, with loopback binding and generated compatibility identity.](https://github.com/lidge-jun/opencodex/pull/3604) |
| [#3469](https://github.com/lidge-jun/opencodex/pull/3469) | [@agentHits](https://github.com/agentHits) | [`c44e187ee`](https://github.com/lidge-jun/opencodex/commit/c44e187ee901275f977f5a2be32c782f4e1f1794) | [Google location-error classification, carried through #3547 and corrected for error precedence.](https://github.com/lidge-jun/opencodex/pull/3608) |
| [#3487](https://github.com/lidge-jun/opencodex/pull/3487) | [@Ingwannu](https://github.com/Ingwannu) | [`f8ba644f3`](https://github.com/lidge-jun/opencodex/commit/f8ba644f3ad650b14af9cc420d4d42782939bfef) | [The bounded Kiro fallback-execution assertion at the migrated test path.](https://github.com/lidge-jun/opencodex/pull/3602) |
| [#3489](https://github.com/lidge-jun/opencodex/pull/3489) | [@Flowershangfromthebranches](https://github.com/Flowershangfromthebranches) | [`55395a9dc`](https://github.com/lidge-jun/opencodex/commit/55395a9dc8a252a01f606b7b65859579e4f2e53d) | [Canonical-final-URL discovery injection alongside independently proxy-bound IPv6 handling.](https://github.com/lidge-jun/opencodex/pull/3618) |
| [#3528](https://github.com/lidge-jun/opencodex/pull/3528) | [@benedictusrey](https://github.com/benedictusrey) | [`bef04efbc`](https://github.com/lidge-jun/opencodex/commit/bef04efbcf506ac26ebd3eeba8ac397a5d8a8d0d) | [The effort CLI command, exact selectors and distinct live/offline failures.](https://github.com/lidge-jun/opencodex/pull/3612) |
| [#3531](https://github.com/lidge-jun/opencodex/pull/3531) | [@benedictusrey](https://github.com/benedictusrey) | [`45045623b`](https://github.com/lidge-jun/opencodex/commit/45045623bfc9c1ec7f8c55e47493da343b98a968) | [The agy alias, with captured discovery authority retained.](https://github.com/lidge-jun/opencodex/pull/3601) |

### 2026-09-07 follow-up: unlinked trailers

These commits contain a contributor name, but GitHub's commit-author mapping
does not resolve that trailer to the source PR author. No personal addresses
are reproduced here. The forward correction uses account-linked noreply identities.

| Pull request | Author | Landed as | What landed |
| --- | --- | --- | --- |
| [#2817](https://github.com/lidge-jun/opencodex/pull/2817) | [@gulup](https://github.com/gulup) | [`6fe46312c`](https://github.com/lidge-jun/opencodex/commit/6fe46312cd509bbef0e79025181e7ab6fc285681) | [The opt-in upstream Responses WebSocket transport and six carried commits.](https://github.com/lidge-jun/opencodex/pull/3216) |
| [#3148](https://github.com/lidge-jun/opencodex/pull/3148) | [@Veritas-7](https://github.com/Veritas-7) | [`865a36ef0`](https://github.com/lidge-jun/opencodex/commit/865a36ef04eb6395e617f94ed87aaa474a903444) | [The two subscription-launch admission-key fixes, plus connected-launch reconciliation.](https://github.com/lidge-jun/opencodex/pull/3182) |
| [#3293](https://github.com/lidge-jun/opencodex/pull/3293) | [@Veritas-7](https://github.com/Veritas-7) | [`3a9c4d297`](https://github.com/lidge-jun/opencodex/commit/3a9c4d297451bc40abb24cf13d5f50648450fc2e) | [The missing claude-fable-5-1 model metadata and accompanying usage-cost test.](https://github.com/lidge-jun/opencodex/pull/3478) |

The correction commit records these contributors and the earlier **Carried work**
authors as co-authors. This is forward attribution: the old commit objects,
their original dates and release tags are unchanged.

## Report and diagnosis

These fixes exist because of the report. The branch's own approach was not the
vehicle, and each author was told why at the time — recording them as carried
code would misstate what happened in the other direction.

| Pull request | Author | Fix landed as | Maintainer's words |
| --- | --- | --- | --- |
| [#2925](https://github.com/lidge-jun/opencodex/pull/2925) | [@ncepuee](https://github.com/ncepuee) | `1d9b389c1` | "Credit to @ncepuee, whose #2925 identified this and argued the split" |
| [#3006](https://github.com/lidge-jun/opencodex/pull/3006) | [@Ingwannu](https://github.com/Ingwannu) | `870a2adb6` | "your PR correctly identified the broken invariant and verified the target was unused" |
| [#3038](https://github.com/lidge-jun/opencodex/pull/3038) | [@L-Y-J](https://github.com/L-Y-J) | `e9d198a3c` | "the defect is real and #3107 exists because you found it" |
| [#3040](https://github.com/lidge-jun/opencodex/pull/3040) | [@ntdatt812](https://github.com/ntdatt812) | `330470e74` | "The defect you found is real" |
| [#3117](https://github.com/lidge-jun/opencodex/pull/3117) | [@olddonkey](https://github.com/olddonkey) | `b46164e78` | "Thank you for the focused report and tests" |
| [#3143](https://github.com/lidge-jun/opencodex/pull/3143) | [@Ingwannu](https://github.com/Ingwannu) | `408652698` | "The diagnosis here was yours and it was right" |
| [#3223](https://github.com/lidge-jun/opencodex/pull/3223) | [@alex-jordan547](https://github.com/alex-jordan547) | `d23eab43a` | "The report itself was what made the fix quick; the wire capture pointed straight at the cause" |

## Closed as landed, carry not stated

Two more were closed with a landing commit and nothing further. The landing is
recorded; what was taken is not, and inventing an answer would be the same
inaccuracy this file exists to correct.

- [#3020](https://github.com/lidge-jun/opencodex/pull/3020) by
  [@luvs01](https://github.com/luvs01) — closed "Landed via #3119 at `a73a4c998`".
- [#2675](https://github.com/lidge-jun/opencodex/pull/2675) by
  [@Ingwannu](https://github.com/Ingwannu) — closed "Landed via #2677 at `8412fe156`".

Two further source PRs were closed with a landing reference but without an
explicit statement of what was carried. Their authors are acknowledged here;
they are not counted as carried code solely from that closure:

- [#2360](https://github.com/lidge-jun/opencodex/pull/2360) by
  [@chilung-cgu](https://github.com/chilung-cgu) —
  [closed as landed via #2371](https://github.com/lidge-jun/opencodex/pull/2360#issuecomment-5379638729)
  at `ae05672e3`.
- [#3621](https://github.com/lidge-jun/opencodex/pull/3621) by
  [@yansigit](https://github.com/yansigit) —
  [closed as landed via #3622](https://github.com/lidge-jun/opencodex/pull/3621#issuecomment-5549370301)
  at `1505cb196`.

## How this stays accurate

This page is a repair, not a process. The process is
`missing_coauthor_credit` in
[`.github/scripts/pr-hygiene.cjs`](./.github/scripts/pr-hygiene.cjs): a pull
request whose own text says it reimplements, supersedes, carries, or rebases
another author's pull request fails the hygiene gate until a
`Co-authored-by` trailer names that author. New entries here should be
unnecessary.

If you find a landing that belongs on this page, open an issue. Being missed is
the defect this file documents, not a claim you have to argue for.

### A gap the gate does not close

The gate checks that a trailer is **present**. It cannot check that the trailer
resolves to the account it names.

A 2026-09-04 backlog review found carry PR
[#3374](https://github.com/lidge-jun/opencodex/pull/3374), carrying
[#3333](https://github.com/lidge-jun/opencodex/pull/3333) by
[@blackjune67](https://github.com/blackjune67), with:

```
Co-authored-by: hajune <contributor@work-domain.example.test>
```

(The address is masked here — `privacy:scan` blocks real contributor emails in the
tree. What matters is its shape: a personal work address, not a GitHub-linked one.)

That is the git identity on the contributor's own commits, so it looks correct
in every review. But GitHub attributes co-authors by **account-linked** email,
and that address is linked to no account — so the trailer would have credited
nobody, and the contributor would have been invisible on their own patch. The
gate passed it, because a trailer was there.

It was corrected before the merge to the contributor's account-linked
`users.noreply.github.com` address, which is why there is no table row for it above.

The lesson generalizes: when carrying work, take the trailer address from the
author's GitHub account (the numeric-id `users.noreply.github.com` form is always
safe), not from the commit metadata on their branch. A contributor who commits
under a work email is the normal case, not an edge case.

### Verify the landing, not just the proposal

The 2026-09-07 audit read exactly 3,000 commits reachable from
`7d8523eed75a67f7a4a15b533744fcd0e6059aa8`, ending at
`53130de4e540fbfcf2629079effb851af54e989e`, and followed source-PR descriptions,
closure comments and GitHub commit-author mappings. Normally merged work,
credited cherry-picks, independent fixes and report-only acknowledgements were
kept distinct from the carried-work tables.

A PR description or an intermediate branch commit can contain the right trailer
and still lose it when a custom squash message replaces that text. Before
calling a carry credited, inspect the **actual landing commit**: its final
`Co-authored-by` trailer must remain present and resolve to the source author's
GitHub account. The existing presence gate alone does not establish either fact.
