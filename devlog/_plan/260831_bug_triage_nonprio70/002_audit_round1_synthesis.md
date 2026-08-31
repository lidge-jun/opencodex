# 002 — audit round 1: nine findings, seven upheld, one rebutted, one reclassified

One adversarial `xai/grok-4.6` round against `000` and `001`. Verdict FAIL. Every
finding was re-checked against the tree by the main session before it was accepted or
rebutted; the reviewer's own citations were not taken on trust either.

## Upheld — these change the plan

**1. #3059 is not a clean `CLOSE_INVALID`.** The lane's mechanism analysis is right:
`refresh()` keeps stale data (`gui/src/client-resource.ts:339-341` — `shouldShowLoading`
is true only when `data === undefined` or `forceLoading`), so the `if (!status)` branch
at `gui/src/pages/integrations/FileIntegrationPage.tsx:175` is cold-load only and the
reported unmount cannot run. But a real focus residual survives that refutation, and
the code says so itself at `gui/src/pages/integrations/RestoreDialog.tsx:64-66`:

> The row's button is gone from the DOM in the collapsed case, so this is a best
> effort: focus returns only if the trigger survived the close.

The reporter's diagnosis is wrong and their experience is real. Closing as invalid
would discard the second half. **#3059 moves to wp9 as a bounded fix**: restore focus to
a stable element when the trigger did not survive, rather than dropping focus to
`<body>`. The trigger is the per-row button in
`gui/src/pages/integrations/RollbackHistory.tsx:48-56`, which is exactly the element the
collapsed case removes. The comment quoted above is at `RestoreDialog.tsx:49-50`, inside
the effect cleanup — not at `:64-66`, which is the `submit` body.

**2. PR #3030 is `chore`, not `bug`.** `gh pr view 3030 --json labels` returns
`["chore","intake: hygiene-blocked"]`. The frozen scope called it a bug PR. Corrected
count: **13 bug-labelled PRs** (excluding the train's #3020) plus #3030, which stays in
scope only as a wrong-branch janitorial closure and is labelled as such. The citation
`provider-routes.ts:957` was also imprecise — line 957 is the `jsonResponse` inside the
catch; the point is that the whole catch block (`:955-965`) has no timeout
classification and `rg "Connection test timed out" src tests` returns nothing.

**3. #1419 must not be closed.** The maintainer's own last comment keeps it open in
writing: "That is encouraging but **not** proof your crash is fixed... Claiming 1.4
resolved your specific trap would go beyond what I can show." Closing it as not-repro
would contradict a recorded maintainer position. **#1419 becomes the second
`UNSOLVABLE`**: it needs macOS `DiagnosticReports` `.ips` frames from a recurrence on
Bun 1.4.0, which no one on this tree can synthesize.

**5. PR #3066 collides with the train.** #3066 and the train's #3089 (the reopened
#3071 fix, head `codex/3071-web-search-query`) both edit
`src/adapters/openai-responses.ts`, and #3089 rewrites `backfillWebSearchQueries`
immediately above #3066's insertion point. **Ordering constraint: wp5 does not merge
until #3089 lands, then rebases onto that head.** If #3089 has not landed when wp5 comes
up, wp5 waits and a later phase runs first.

**6. PR #3003 collides with the train.** #3003 and the train's #3020 both edit
`src/codex/auth-api.ts`, and both rewrite `primeCodexPoolQuotas` /
`fetchPoolAccountQuota`. **Ordering constraint: #3020 lands first, then #3003 rebases.**

**7. Internal collision inside this round.** wp2 (#3034/#3041) and wp7 (#3053) both edit
`src/codex/catalog/provider-fetch.ts`. They are not disjoint. **wp2 lands before #3053.**

**8. The phase map contradicted the verdict table.** `000` put #3070 and #1527 in wp1 as
closures while `001` marked both `REIMPLEMENT`; #3021 had the same split. Executing wp1
from `000` would have closed two issues this scan had just proved still need code. The
`000` table is corrected and wp9 is now scheduled in it.

**9. #3068 closes only as a duplicate of #3071.** The survivor is open and owned by the
other train, so the closing comment names #3071 and #3089 and claims nothing about a
fix being present.

## Rebutted

**4. #3041's `isDateSuffix` does accept `0231`.** The reviewer read the rejection tests
(`0001`, `1300`, `1240`) and concluded February 31 is rejected too. It is not:

```
$ git show refs/tmp/pr-3041:src/codex/catalog/provider-fetch.ts | rg -A6 'function isDateSuffix'
948:function isDateSuffix(suffix: string): boolean {
949:  if (/^\d{8}$/.test(suffix)) return true;
950:  if (!/^\d{4}$/.test(suffix)) return false;
951:  const month = Number(suffix.slice(0, 2));
952:  const day = Number(suffix.slice(2));
953:  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
954:}
```

`0231` is month 2, day 31: both bounds pass, so it folds. `1240` is rejected because day
40 exceeds 31, which is what the reviewer's cited test actually proves. The eight-digit
branch is worse — bare `/^\d{8}$/` folds `20250229`. #3034's calendar matcher rejects
both. The `CHERRY_PICK` verdict stands unchanged.

## Revised residual set

| item | why it cannot be resolved this round |
| --- | --- |
| #2813 | needs `/v1/models` and `/api/models` dumps from an account actually in Luna Reserve; a picker screenshot cannot separate proxy-missing from client-filter, and one blind catalog-field PR (#2862) already failed |
| #1419 | needs macOS `.ips` crash frames from a recurrence on the Bun this tree ships; the maintainer already declined to claim 1.4.0 fixed it |

Two of the allowed three-to-four slots are spent. The rest are held for phases that hit
a real wall.

## Corrected phase order

**Superseded by `003` and `004`.** The order this round produced put #3063 in wp7 and left
#2989 and #3000 unordered against each other; rounds 2 and 3 fixed both. `000` carries
the authoritative order — this section is kept only so the amendment history reads in
sequence.
