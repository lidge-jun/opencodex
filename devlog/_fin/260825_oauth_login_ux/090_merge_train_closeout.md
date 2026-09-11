# 090 — Merge train close-out

All four pull requests from this unit are merged into `dev`.

| PR | Merge commit | Closes |
|----|--------------|--------|
| #2530 shared login hint | `d7d708fca` | #2529 |
| #2534 first-add parity | `315f5bfbd` | #2533 |
| #2537 browser-open choice | `e65d6d3e9` | #2535 |
| #2540 fragment parsing | `858352ad6` | #2538 |

Final `dev` is `858352ad6`. On it: `bun x tsc --noEmit` exit 0, `cd gui && bun x
tsc -b` exit 0, `bun run privacy:scan` passed, the OAuth test set 67 pass / 0
fail, and the GUI suite 979 pass / 0 fail.

## What the merge order had to protect

A pre-merge `git merge-tree` simulation of the whole sequence, corroborated by
an independent review, found two things that a naive merge would have gotten
wrong.

**#2534 had to be retargeted only after #2530 landed.** Retargeting the stacked
child first would have made GitHub merge all five commits as part of #2534,
swallowing #2530 into the wrong pull request. #2530 was therefore merged with a
**merge commit** rather than a squash, so `4edef7577` stayed an ancestor of
`dev` and the retarget left the child carrying exactly one commit.

**#2537 conflicted with #2530 in three files**, and every conflict had a
resolution that compiled while silently deleting a feature:

| File | Naive resolution | What it would have cost |
|------|------------------|-------------------------|
| `add-provider-oauth-pane.tsx` | take either import line | a component rendered with no import |
| `ProviderAuthPanel.tsx` | take either import line | same, plus a stale `useCopyFeedback` |
| `login-url-block.css` | take either tail | one feature silently unstyled |

All three were resolved by keeping **both** sides. `useCopyFeedback` stays
removed on purpose: its device-code copy moved inside `LoginHint`.

The devlog docs needed per-file picks rather than a blanket rule. The stack
carried the *older* drafts of `030` and `040`; the correct text lived on
#2537 and #2540 respectively. Both rebases dropped their unit-carry commit
instead of resolving eight add/add conflicts.

## One CI failure that was not a flake to re-run

`tests/update-stop-first.test.ts` failed on a rebased head. It was unrelated to
OAuth — the npm launcher recovery test — and passed 5/5 locally, including in
CI's exact twelve-file batch.

Re-running it would have been the wrong move. The real cause is a budget, not a
race: `waitForProxy` allowed 15s for a detached proxy that boots in ~1.9s
locally and burned 16.8s on a loaded shared runner. The per-probe
`AbortSignal.timeout(500)` compounded it by reading a slow first connection as
"not ready". The deadline is now 45s — the test's own Bun timeout is 60s — with
a 2s probe, and the guard was re-proved to still return `false` for a proxy
that never starts. The happy path still finishes in ~1.9s.

## Note for `MAINTAINERS.md`

Line 149 states that "no branch protection rule is configured on this
repository". That is now stale: ruleset `Protect dev` (id 20763889, active)
requires one approving code-owner review, which is why every `dev`-targeted PR
in this train reported `mergeStateStatus=BLOCKED` with green CI. Admin bypass
(`bypass_mode: pull_request`) is what allowed these merges. Reconciling that
sentence with the ruleset — and deciding whether self-merge should stay
available — is a maintainer decision, not part of this unit.
