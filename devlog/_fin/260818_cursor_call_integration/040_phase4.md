# 040 — WP5: merge the stack onto dev + ancestry proof

> **EXECUTION AUTHORITY: `cursor-call-integration.zsh merge`.**
> The commands below are the reasoning, not the runbook. Seven audit rounds proved a
> markdown file cannot enforce that a variable is bound before it is read (`019`), so
> the script owns what runs and this doc owns why. If they disagree the script is
> right and this doc is stale — fix the doc.

Revised by `r1` F2 (governance honesty), `r3` F1 (base pinning), and `r4` F1 (the
pin has to EVOLVE through the stack).

## Authority, stated precisely

The user granted admin merge authority for this branch ("admin 권한으로") and waived
CI checking. That is the repository owner exercising owner authority.

What it is NOT: compliance with `MAINTAINERS.md:48-49`, which requires maintainer
approval **and** successful required CI checks before merge. `AGENTS.md:251-253`
makes `MAINTAINERS.md` authoritative.

So each merge is an **owner-authorized exception**:

- lidge is Linux; CI covers Linux + Windows + macOS.
- This diff touches no Windows-sensitive surface — no shims, installer, PowerShell,
  platform dispatch, or Windows path handling (verified in `r3` and `r4`).
- `050`'s note may say "gates green on Linux; CI waived by the owner". It may **not**
  say "policy-compliant" or "all required checks passed".

If the user wants full compliance instead, let required CI run on each PR head
before merging. One-line change to this plan.

## `EXPECTED_DEV` evolves — it is not one frozen SHA (r4 F1)

`VERIFIED_BASE` (the SHA WP3 verified against) is correct as the value to check
before PR1. After PR1 merges, `dev` legitimately moves to PR1's merge result, so
comparing PR2 against the original value would fail by construction.

The invariant is: **before merging layer N, the live `dev` head must equal the SHA
that layer N's base was verified against.** Maintain one variable:

    EXPECTED_DEV="$VERIFIED_BASE"        # from 020, the rebase target

`EXPECTED_DEV` advances to the MERGE COMMIT of the layer just landed, not to a fresh
read of `dev` — same reason as `MERGED_DEV` below (audit `r13`). The single
executable merge ladder is in **Procedure** below; this section only states the
invariant (audit `r14`: three scattered half-procedures disagreed with each other).

Read the live head with `git ls-remote origin refs/heads/dev` every time, never
`origin/dev` — the tracking ref goes stale within minutes
(`scripts/release.ts:327-335` uses `ls-remote` for exactly this reason). Observed
drift during planning alone: `87f7f970b` → `e1bdbc1e5` → `1645bb924`.

**If a check fails**, someone else pushed to `dev`. Stop: rebase the remaining
layers onto the new head, re-run the affected gates from `020`, and update
`EXPECTED_DEV`. Merging a stale base lets GitHub construct a merge result nobody
tested and put it on `dev` — and the ancestry check below runs afterwards, too late
to prevent it.

## Procedure

Merge in dependency order. The full ladder is at the end of this section; the two
subsections below explain why each of its three assertions exists.

### Also assert the PR HEAD, not just the base (audit `r10`)

The base check proves `dev` has not moved. It says nothing about what the PR itself
now points at. A force-push to a PR head — by anyone, including a well-meaning
rebase — would merge commits that never went through `020`'s gates, and the
post-merge ancestry check below would still pass, because the verified tip remains an
ancestor of a superset.

So before EACH merge, compare the PR's live head against the SHA `030` step 5
recorded:

    test "$(gh pr view <n> --json headRefOid --jq .headRefOid)" = "$PR1_HEAD"
    gh pr merge <n> --merge --admin

`test`, not a printed value: a comparison the operator has to eyeball is not a gate
(audit `r13`). Repeat with `$PR2_HEAD` and `$PR3_HEAD` for the other two layers.

### And assert the PR's live BASE (audit `r14`)

The two checks above cover "has `dev` moved" and "has the PR head moved". Neither
covers "is this PR still pointing at `dev`". A retarget — to `main`, or to a parent
branch that has since merged — passes both, and `gh pr merge` would then merge into
whatever base the PR now names. `030` prints the bases for inspection, which is not a
gate.

So the pre-merge check for EVERY layer is all three at once. This is the ONE merge
ladder for the whole phase — `PR1`/`PR2`/`PR3` are the numbers `030` step 4 returns
when the PRs are opened, and `PR1_HEAD`/`PR2_HEAD`/`PR3_HEAD` are the SHAs `030`
step 5 captured:

    merge_layer () {          # $1 = PR number, $2 = its expected head SHA
      local pr="$1" expected_head="$2"
      test "$(gh pr view "$pr" --json baseRefName --jq .baseRefName)" = "dev"
      test "$(gh pr view "$pr" --json headRefOid --jq .headRefOid)" = "$expected_head"
      test "$(git ls-remote origin refs/heads/dev | cut -f1)" = "$EXPECTED_DEV"
      gh pr merge "$pr" --merge --admin
      EXPECTED_DEV=$(gh pr view "$pr" --json mergeCommit --jq .mergeCommit.oid)
      test -n "$EXPECTED_DEV"
    }

    merge_layer "$PR1" "$PR1_HEAD"
    gh pr edit "$PR2" --base dev            # parent landed; retarget the child
    merge_layer "$PR2" "$PR2_HEAD"
    gh pr edit "$PR3" --base dev
    merge_layer "$PR3" "$PR3_HEAD"

`EXPECTED_DEV` advances inside the function, from the merge commit of the layer just
landed — so the next layer's base assertion compares against what THIS campaign
produced, not against a fresh read that would absorb someone else's push.

`dev` is the only acceptable base for all three layers at merge time: PR1 targets it
from the start, and PR2/PR3 are retargeted to it as their parents land
(`AGENTS.md:218-225`). A base of `main` would be a policy violation, and a base still
naming a merged parent branch would produce an empty or wrong diff.

PR3's expected head is `VERIFIED_TIP` — the exact SHA `020` ran the full suite
against. If any head differs, stop: either re-verify that tree through `020` or
reset the branch to the recorded SHA. Never merge a head no gate has seen.

Do NOT squash. The commit-by-commit history is the audit trail for five campaign
phases plus four integration audit rounds, and the devlog references specific SHAs.

## Ancestry proof (the actual criterion)

A merge API response is not proof:

```
git fetch origin dev
git merge-base --is-ancestor <final-stack-tip-SHA> origin/dev   # exit 0
git log --oneline -10 origin/dev
```

## Verification (C)

For each layer: the pre-merge `ls-remote` SHA equal to the then-current
`EXPECTED_DEV`, recorded. Then exit 0 from `--is-ancestor` for the final tip, plus
the `origin/dev` log showing all three merges.

## Hand `MERGED_DEV` to WP6

After PR3 merges, take the result from the MERGE ITSELF rather than re-reading a
mutable ref — a fresh `ls-remote` would silently pick up a concurrent push and
attribute someone else's commit to this campaign (audit `r13`):

    MERGED_DEV=$(gh pr view <pr3> --json mergeCommit --jq .mergeCommit.oid)
    test -n "$MERGED_DEV"
    git fetch origin dev
    test "$(git ls-remote origin refs/heads/dev | cut -f1)" = "$MERGED_DEV"   # nobody pushed after us
    git merge-base --is-ancestor "$VERIFIED_TIP" "$MERGED_DEV"                # exit 0

If the third assertion fails, someone pushed after PR3 landed. That is not
necessarily wrong, but `050` must then gate `MERGED_DEV` explicitly and say in the
readiness note that `dev` has moved past it.

`050` gates exactly that SHA. Same reason as every other named artifact here: a
phase that re-reads a mutable ref is not verifying what the previous phase produced
(audits `r7`, `r8`, `r10`).
