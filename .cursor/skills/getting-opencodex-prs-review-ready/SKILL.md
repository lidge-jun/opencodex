---
name: getting-opencodex-prs-review-ready
description: Use when opening, updating, rebasing, restacking, or marking an opencodex (ocx) pull request ready for review; when deciding origin vs upstream, yansigit/opencodex vs lidge-jun/opencodex, or whether a feature PR belongs on the fork; when enforce-target / pr-quality is draft, unticks checkboxes, or reports review_findings, latest_dev, unsponsored_surface, or missing_regression_test; when CodeRabbit, Codex, outside-diff cr-comment markers, stacked PRs, or lidge-jun/opencodex `dev` are involved; when tempted to push, skip-comment, `@coderabbitai review`, retarget a stack onto `dev`, retick until READY, dispatch a subagent to review or tick, or keep iterating a PR that already has a large review count.
---

# Getting opencodex PRs review-ready

## Fork vs upstream (do this first)

**This working copy is the fork. Features land on the fork. Upstream is pull-only.**

I only wanted to add the feature to my fork, not upstream. The forked one is the one I will be using. Upstream is only for updating changes from there.

| Remote | Repo | Role |
|---|---|---|
| `origin` | `yansigit/opencodex` | Daily driver. Push here. Open PRs here. Merge here. |
| `upstream` | `lidge-jun/opencodex` | Fetch/rebase source only. Never open a feature PR against it unless the user explicitly asks to contribute upstream. |

Default `gh pr create` target is **`yansigit/opencodex`**, base = the fork's daily-driver branch (usually `origin/main`). Do **not** pass `--repo lidge-jun/opencodex`. Fetch `upstream/dev` only to update the fork; that fetch is not permission to file an upstream PR.

Leftover git branch `overlay` is retired; it is not a merge target. Feature and maintenance PRs target `dev` first; releases and promotions reflect from `dev` to `main`.

The rest of this skill is the **upstream** review-readiness gate. Use it only after the user has explicitly asked to contribute a change to `lidge-jun/opencodex`. Fork-only work skips `maintainer-sponsored`, screenshot-for-upstream-gate, and the four-box Ready ritual.

**Iron law:** One slice. Rebase onto **integration** `dev` (child: onto **parent**, parent onto `dev`). Last push. Do not `@coderabbitai`. Clear findings **on that head**. Tick the four boxes **once**. Ready is a **merge appointment**, not a waiting room.

Iterating (push → `@coderabbitai review` → skip/reply → retick) is one failure. The other is rebase → exact-head APPROVED → wait for a second human → `dev` blows 10 commits → freshness CHANGES_REQUESTED → rebase voids the SHA. Quiet merged PRs (#2208, #2042, #2059, #2066, #1805, #1879, #1871, #2312) were 1–2 commits, few files, a real body, a test, 0–1 CodeRabbit rounds, and **merged 15–25 min after the last approval**. #1742 (this stack) merged **0.5 min** after Ingwannu approved. Several ticked box 3 with **zero** CodeRabbit review objects.

## Red flags — STOP

- "Iterate until READY" / "until we get lucky"
- Tick, then push
- Skip-reason comments as gate credit
- Skip-reason reply, then resolve (same Reviews; #2208 just resolved)
- `@coderabbitai review` / `full review` after a rebase, or "to get a same-head review"
- Retargeting stacked children to `dev` so each has its own `behind_by`
- Replying to every CodeRabbit thread (GitHub counts each as a Review)
- Rebasing because `dev` moved while `behind_by` vs **PR base** is still ≤10
- Rebasing an exact-head **APPROVED** SHA with nobody ready to merge it the same sitting
- Restacking children while the parent is still open (Ingwannu: park #2070/#2071 until #2068 is on `dev`)
- Treating Ingwannu APPROVED as merge-authorized when the review still requires `@lidge-jun` exact-head security
- Dispatching a subagent to `@coderabbitai`, tick boxes, or force-push a published PR
- Ticking box 3 while a CodeRabbit review on this SHA is requested but not posted
- "One more review will clean up the comment count"
- Treating maintainer CHANGES_REQUESTED as optional because CodeRabbit is quiet
- Treating fork `origin/dev` as current `dev`
- Claiming full-suite / cross-platform CI on a fork
- `src/oauth/` (or other `pr-sponsored-surface.cjs` paths) without `maintainer-sponsored`
- `src/` or `gui/src/` behavior change with no test (#2051 closed hygiene-blocked)
- `gui` in title/body without a screenshot

Do not tick. Fix the gate input. One final push only if the head must change.

## Before first push

1. Fetch **`lidge-jun/opencodex` `dev`** (`upstream/dev` here). Fork `origin/dev` lags. Gate `behind_by` vs **PR base** (not always `dev`), max **10**. `dev` can move tens of commits in a day; a large PR cannot stay open.
2. Stay off oauth/workflows/release/`package.json`/`bun.lock`/auth files unless a maintainer will apply `maintainer-sponsored` (else stay draft, like #2069).
3. Behavior change → focused test (or `test-exception-approved`).
4. `bun run typecheck` + focused tests. Box 1 attests **what you ran**, not repo CI. Honest platform limits are fine (#2042).
5. Real Summary + Verification (not template placeholders). GUI → `![...](url)` in the body.

Open against `dev`. Stacked child: **base = parent's head branch**, not `dev`. A `dev`-based PR whose commits include another open PR is not one slice — retarget to the parent, or close the child until the parent merges. Restack parent, then children, **one push per PR**. Tick none until every published head is final. One operator per PR — do not parallelize review/tick/push. **Do not tick yet.**

## After the last push (once)

Stay draft. CodeRabbit `auto_review.drafts` is **false**; it auto-reviews when the gate marks Ready. Do **not** comment `@coderabbitai` to start a review. Pings add an auto-reply plus N GitHub Reviews (each inline finding is often its own review object).

Then:

```bash
PR=<n>; REPO=lidge-jun/opencodex
SHA=$(gh pr view "$PR" --repo "$REPO" --json headRefOid -q .headRefOid)
BASE=$(gh pr view "$PR" --repo "$REPO" --json baseRefName -q .baseRefName)
gh api "repos/$REPO/compare/${BASE}...$SHA" --jq '{behind_by,ahead_by}'
gh api "repos/$REPO/pulls/$PR/reviews" \
  --jq "[.[] | select(.user.login==\"coderabbitai[bot]\" and .commit_id==\"$SHA\") | .body]" \
  | rg 'outside diff range|cr-comment:v1:' || echo "OK: no outside-diff markers on head"
```

Unresolved GraphQL threads from `coderabbitai[bot]` and `chatgpt-codex-connector[bot]` (`isResolved` must be `true`).

- No CodeRabbit review on this SHA and no unresolved bot threads → box 3 is clear. Tick.
- A review was requested or is in flight on this SHA → wait for it. Do not tick "ahead."
- Correct finding → fix, **one** push, wait again. Do not ping. After the fix lands, reply on that thread with the commit SHA (the only reply that belongs there).
- Wrong / out of scope / not worth a push → resolve the **inline GraphQL thread with no author comment**. Not an issue comment, not a skip-reason reply. `@coderabbitai` only if box 3 is already disproved for a leftover marker on this exact SHA and the head must not change.
- Maintainer CHANGES_REQUESTED → fix or discuss with that reviewer. Bot silence is not approval.

After Ready, CodeRabbit may still post. That is expected. Do not retick, ping, or push unless a finding is actually correct and worth one commit.

**Thread handling (proven on merged PRs):**

- Resolve with **no reply** when you are not changing the head. #2208, #2214, and #2196 merged that way: CodeRabbit comments, `isResolved: true`, author list is only `coderabbitai`.
- Reply **only after a real fix**, and name the SHA (`Fixed in <sha>…`). #1871, #2232, and #2202. CodeRabbit then confirms; that reply is documentation of a commit, not a skip.
- Skip-reason comments are extra GitHub Reviews. The gate cannot see them. Mass-reply is the failure, even if you also resolve.

```bash
# Resolve out-of-scope threads. Do not post a comment first.
gh api graphql -f query='
query($n:Int!) {
  repository(owner:"lidge-jun", name:"opencodex") {
    pullRequest(number:$n) {
      reviewThreads(first:50) { nodes { id isResolved comments(first:1) { nodes { author { login } } } } }
    }
  }
}' -F n="$PR"
# then for each unresolved coderabbitai / chatgpt-codex-connector thread:
gh api graphql -f query='mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}) { thread { isResolved } } }' -f id="$THREAD_ID"
```

Tick exactly: local testing green; latest `dev` (vs **base**); Codex/CodeRabbit findings resolved; ready for review. Any later push resets **all four**. After Ready, stop touching the branch. If the conversation is already huge, stop; more bot traffic will not make it look ready. Leave it for humans, or close and open a 1-commit slice.

## After Ready (humans)

Stop. Do not restack children. Do not rebase “to stay fresh.”

Ingwannu reviews **exact head**. A freshness CHANGES_REQUESTED is not a code defect — the quota/failover contracts on #2068 stayed patch-equivalent (`range-diff` 6/6) through two rebases. The 10-commit rule still applies: after **>10** `behind_by` vs base, that SHA cannot authorize integration.

`behind_by` is every commit reachable from `dev` that is not in the PR. A single **merge-commit** PR can inflate it: #2072 landing on `dev` jumped #2068 from 0 to 16 because it carried `Merge remote-tracking branch 'upstream/dev'` history, then #2312 added two more. That is not 16 independent integrations. Ingwannu still uses the GitHub number.

**Security-sensitive parent (#2068):** OAuth bearer across failover. Ingwannu APPROVED twice (`54c4f6a6e`, then `9dceb40f5`) and both times said merge still needs `@lidge-jun` exact-head security. Fork authors cannot merge. The 71-minute gap from 19:50Z APPROVED to 21:01Z freshness CR is the loop. Rebase only when Ingwannu asks **and** a merger can squash-merge that new SHA in the same sitting (#1742, #2312, #1871, #2208). Otherwise the next SHA goes stale the same way.

Children (#2070, #2071) wait until the parent is **on `dev`**, then restack the isolated slice onto that `dev`. Recut oauth (#2069) last; stay draft until `maintainer-sponsored`.

## Gate (what actually counts)

| Check | Reality |
|---|---|
| Box 2 | `behind_by` vs **PR base** >10 or compare unknown → fail |
| Box 3 | Unresolved bot threads **or** `cr-comment:v1:` on latest CR review for **live head**. No CR review ⇒ no markers |
| Box 1 | Never disproved; still resets on push |
| Hygiene | Missing test, empty catch, `.only` |
| Sponsored | `src/oauth/`, workflows, release scripts, auth files, lockfile |
| Body / GUI | Thin/placeholder body; `gui/` needs screenshot |

Skip comments, `@coderabbitai` pings, and author thread-replies are not in this table.

## Rationalizations

| Excuse | Reality |
|---|---|
| "Iterate until READY" | One attestation on one SHA |
| "Comment skip, then tick" | Gate cannot see skip comments |
| "Comment skip, then resolve, so maintainers know why" | Resolve with no reply (#2208, #2214, #2196). Replies are GitHub Reviews. Only reply after a real fix, and name the SHA (#1871, #2232, #2202) |
| "Need `@coderabbitai review` for box 3" | Box 3 fails on unresolved threads or `cr-comment:v1:` on this head. No CR review is fine. Ready auto-reviews |
| "Outside-diff isn't GitHub-resolvable" | Resolve the thread, wait for Ready auto-review without the marker, or fix |
| "Retarget the stack to `dev`" | `behind_by` is vs PR base. Child base = parent head. On `dev`, CodeRabbit reviews parent+child (#2071 = 25 files / 2781 lines) |
| "Reply so the finding is documented" | Replies are GitHub Reviews. Resolve or ignore. Don't mass-reply |
| "`dev` moved, rebase to stay fresh" | Only if `behind_by` vs **base** >10 **and** the reviewer asked. Otherwise you reset the attestation for nothing |
| "behind_by 16 means 16 real patches" | Merge-commit PRs inflate GitHub's count (#2072). Still rebase when Ingwannu asks; do not invent a code fix |
| "Ingwannu approved, restack the children" | Approved ≠ merged. Children stay parked until the parent is on `dev` |
| "Approved means we can merge" | Security-sensitive still needs `@lidge-jun` exact-head. Rebase without a merger ready repeats the freshness CR |
| "Rebase the approved SHA so it stays under 10" | New SHA voids exact-head CI and both humans. Rebase only as a merge appointment |
| "Full suite failed, can't tick box 1" | Attest focused commands; don't lie about fork CI |
| "Rebase after ticking" | Push resets every box; rebase **before** the tick |
| "origin/dev is current" | Fetch `upstream` / `lidge-jun` `dev` |
| "The stack is special" | Child base = parent head; don't tick a mixed `dev` diff; oauth stays draft |
| "A subagent can ping CR while we rebase" | One operator. Parallel review/tick/push duplicates Reviews |
| "Tick now, CR will catch up" | In-flight review on this SHA can post `cr-comment:v1:` and reset you |
| "One more review will clear the noise" | Stop. After Ready, humans only. Or close and open a 1-commit slice |
| "CR is clean, ignore the maintainer" | Human CHANGES_REQUESTED is the merge path. Fix or ask |
