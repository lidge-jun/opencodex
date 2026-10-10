# 002 — audit round 1: what the reviewer caught, and what it over-read

Reviewer: `gpt-5.6-sol`/high, read-only lane, `VERDICT: FAIL` with 5 blockers.
Three are real and change the plan. Two are rebutted with evidence. This document records
both dispositions because a rebuttal I do not write down is a rebuttal the next round
re-litigates.

## Accepted — blocker 5: the conflict attribution was wrong, and so were the distances

The reviewer is right and I checked it myself.

```
$ git show 0ef04e640 --stat | tail -4
 src/cli/dispatch.ts        | 11 ++++++--
 src/cli/index.ts           |  9 +++++-
 tests/cli-dispatch.test.ts | 69 ++++++++++++++++++++++++++++++++++++++++++++++
```

`0ef04e640` never touches `src/service.ts`. I named it because its subject line
("stop start shadowing a live configured-port proxy") reads like service territory. That is
reasoning from a commit message instead of from a diff, which is exactly the error the
audit exists to catch.

The real dev-side overlap is `330470e74` (#3118, `fix(stop): typed stop outcome`) — 50 files,
and `src/service.ts` is among them. Measured overlap for the four rebase candidates:

| PR | branch | files changed on BOTH sides since merge-base |
| --- | --- | --- |
| #3104 | `codex/3009-windows-cold-start` | `src/service.ts` |
| #3109 | `codex/3063-combo-compact-failover` | `src/adapters/openai-responses.ts`, `tests/server-auth.test.ts` |
| #3112 | `codex/2999-native-main-refresh-claim` | **none** |
| #3042 | `fix/test-dead-pid-probe` | `tests/responses-state.test.ts` |

`030` is amended: expect `src/service.ts` against `330470e74`, not `0ef04e640`.

The behind-counts in `010`/`020`/`040`/`050` were measured before `132b557ad`, `33d32b6a3`,
`3e0f99a19` and `6f415baef` landed during this session. They are stale by exactly the number
of commits that landed while I was writing. Real distances from `132b557ad`: #3114 = 26,
#3122 = 5, #3042 = 59, #3109 = 27, #3112 = 26. Recorded here rather than chased through five
documents, since the number moves again on every merge this train performs.

## Accepted — blocker 4: #3104 drops a behaviour #3039 authored

Verified in both trees.

```
$ git show pr3039:src/service.ts | sed -n '742,753p'
  const startedAt = elapsed();
  ...
    + `${Math.max(1, Math.round((elapsed() - startedAt) / 1000))}s.\n`

$ git show pr3104:src/service.ts | sed -n '742,750p'
  const healthBudgetMs = deps.timeoutMs ?? serviceInstallHealthMs();
  ...
    + `${Math.trunc(healthBudgetMs / 1000)}s.\n`
```

#3039's comment states the intent plainly: "The elapsed time, not the constant: a caller
that passes its own timeoutMs used to be told it had waited 20s whatever it waited."
#3104 prints the budget. Since #3104 also adds a post-deadline grace knock
(`src/service.ts:719`), the printed number can now understate the real wait — the exact
failure mode #3039 set out to fix, reintroduced by the PR that claims to supersede it.

This does not block **merging** #3104: the budget message is honest about the budget, and
the security-relevant half (SID-exact scheduler ownership) is unaffected. It blocks
**closing #3039 as fully superseded**. Amended in `030`: #3039 stays open with a comment
recording precisely which contribution was not carried, so the elapsed-time diagnostic is a
tracked follow-up rather than a silent drop.

## Accepted — blocker 3: a maintainer push resets a contributor PR's readiness

`.github/workflows/enforce-pr-target.yml:740-746`:

```
// The readiness gate applies to contributors (no push permission).
const checklistRequired = !authorIsMaintainer;
```

and `:781-786` — "A completed checklist is an attestation about a specific head" — with the
push resetting the boxes and re-drafting.

Both fork candidates are contributors:

```
$ gh api repos/lidge-jun/opencodex/collaborators/Flowershangfromthebranches/permission --jq .permission
read
$ gh api repos/lidge-jun/opencodex/collaborators/lifrary/permission --jq .permission
read
```

So a maintainer force-push to #3122 or #3042 re-drafts the PR and resets a checklist only
the author can tick. "Rebase, wait for green, merge" is not available for either.

**This is the blocker that reshapes the train**, and it is not a paperwork objection: the
gate exists so an author attests that the code they are shipping is the code that was
tested. Amendment: fork PRs are landed by **cherry-picking onto a maintainer branch** with
authorship preserved (`git cherry-pick -x`, original `Author:` intact), opened as a
maintainer PR that credits and closes the original — the pattern this repository already
uses (#3104 carries #3039/#3067; #3109 carries #3063; #3111 carries #2989). The contributor
keeps authorship in `git log`; the readiness gate is satisfied by a maintainer author rather
than circumvented.

## Rebutted — blocker 2: the security-notes rule does not reach this material

The reviewer reads `AGENTS.md:105-127` as forbidding any devlog note that touches an
unfixed defect. That is broader than the rule, which is scoped to **security** work:
"unreleased findings, severity assessments, draft advisories, exploit or bypass reasoning,
reproduction steps for an unfixed defect, and pre-disclosure patch plans."

The test the file gives is explicit: "is there already a public diff that reveals this
weakness?"

- **#3122** is characterised as "an unshipped destination-policy/SSRF fix". It is not an
  SSRF fix. The PR permits the `198.18.0.0/15` fake-IP range on the provider PATCH path
  that creation and re-enable already permit — it **relaxes** a validator to match its own
  sibling call sites, and the asymmetry is visible in the open PR diff. There is no
  weakness disclosed that the public PR does not already show.
- **#3112's** three failure modes are quoted from `Ingwannu`'s **public review** on the open
  PR. Restating a public review comment in a devlog discloses nothing.
- **#3114's `070_outcome.md`** discusses #3000's musl `dlopen` and late-cancel grant
  discard. #3000 is `CLOSED` (2026-08-31T19:13:28Z) and was never merged — the code never
  shipped, so there is no deployed weakness to disclose. The note explains why a PR was
  rejected, which is the closure rationale, not an advisory.

There is one thing the reviewer is right about even though the blocker is wrong: **read the
#3114 unit before merging it** rather than approving it because it is docs-only. `010`
already required that. The read stays; the blocker is not accepted.

## Rebutted — blocker 1: no staged diff

The reviewer required a staged index to anchor its audit. That is a habit from reviewing a
patch, not a rule of this repository, and this phase is a P-phase plan audit — the artifact
is the six documents, which the reviewer read and cited by line. Nothing is staged because
nothing is committed yet; `git add` before an audit would not have changed a single blob it
examined. Recorded and dismissed.

## Round verdict

`GO-WITH-FIXES` after amendment: blockers 3, 4, 5 folded into `020`/`030`/`040`; blockers
1 and 2 rebutted with evidence above. The train's shape changes in one material way — fork
PRs are carried, not force-pushed — and one closure is withdrawn.
