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

Every entry cites the maintainer's own words from the closing comment or the
landing commit. Nothing here is inferred from a diff.

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
