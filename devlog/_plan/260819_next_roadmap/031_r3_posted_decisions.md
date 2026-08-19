# 031 — R3 decisions as posted

The decision record is 030. This file records what was actually said on each
PR and where, so a later reader can check the public artifact against the
private reasoning without re-reading eight threads.

## `prompt_cache_retention` (#2092)

| PR | Action | Comment |
|---|---|---|
| #2102 | **selected** | [5340666298](https://github.com/lidge-jun/opencodex/pull/2102#issuecomment-5340666298) |
| #2091 | not selected | [5340672074](https://github.com/lidge-jun/opencodex/pull/2091#issuecomment-5340672074) |
| #2099 | not selected + retargeted | [5340672361](https://github.com/lidge-jun/opencodex/pull/2099#issuecomment-5340672361) |

Both non-selected authors were told *why*, not just that they lost. #2091's
instinct (fix it at the strip site) and #2099's instinct (keep it model-scoped)
were each named as correct — #2099's is the reason #2091 was not chosen either.

The one open request on #2102: its sanitizer is called outside the
`if (forward)` branch, so it also strips from API-key and third-party
`openai-responses` passthroughs. Defensible for real OpenAI endpoints, untested
for custom ones.

## K12 short-window quota (#2047)

| PR | Action | Comment |
|---|---|---|
| #2056 | hold | [5340681696](https://github.com/lidge-jun/opencodex/pull/2056#issuecomment-5340681696) |
| #2062 | hold + retargeted | [5340672627](https://github.com/lidge-jun/opencodex/pull/2062#issuecomment-5340672627) |

The same root cause was posted on both so two contributors are not each
debugging half of it, and the asymmetry was stated in each direction rather
than framed as one PR being better: #2062 is narrower on reachability, #2056 is
ahead on preservation, and both carry the scoring fail-open. The suggested
combination — #2056's preservation handling plus a gated scorer — is on the
thread.

## Retargets

Eight PRs moved `main` -> `dev`: #2110, #2109, #2099, #2082, #2063, #2062,
#2032, #2029. Verified after with `gh pr view`: all eight report
`baseRefName=dev`; seven are `MERGEABLE`.

`#2063` is `CONFLICTING` and overlaps the already-merged #2055, so it got a
separate note ([5340672862](https://github.com/lidge-jun/opencodex/pull/2063#issuecomment-5340672862))
asking for a rebase and a rescope rather than a silent retarget.

**No contributor head was rewritten.** Every one of those heads lives in a fork
(`drakonkat`, `yzxcj797`). Retargeting a base is maintainer work; rebasing
someone's branch is theirs.
