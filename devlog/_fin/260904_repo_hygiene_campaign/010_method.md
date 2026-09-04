# 010 — Classification method and its controls

## The four tests

A local branch is deletable when at least one holds, and no guard fires.

```
T1 ancestry      git merge-base --is-ancestor <br> origin/dev
T2 patch-equiv   git cherry origin/dev <br>            -> no '+' lines
T3 content       paths = git diff --name-only origin/dev...<br>
                 git diff --name-only origin/dev <br> -- <paths>  -> empty
T4 scratch       branch name encodes a PR number whose state is MERGED or CLOSED
                 AND the name matches the scratch prefix set
                 AND the number is a WHOLE numeric token of the branch name
                 AND the branch is provably a duplicate of that PR's head:
                     identical SHA, an ancestor of it, or content-identical to it
```

T3 is the one that matters for this repository, because `dev` takes squash
merges: after a squash the branch shares no commit with `dev`, so T1 and T2 both
report "unmerged" for work that is fully shipped. T3 asks the only question that
is actually load-bearing — is there any difference left in the files this branch
claims to change.

T4 is deliberately narrow. It fires only for throwaway prefixes
(`pr*`, `rb-`, `jrb-`, `mtp/`, `big-`, `cf-`, `ocx-`, `wip/`, `backup/`,
`candidate`, `cursor-`, `midstream`) created by earlier review and rebase runs,
and only when the referenced PR is already MERGED or CLOSED. A `codex/*` branch
is never deleted on T4 alone.

**T4 alone is not sufficient, and the first version of it was wrong.** PR state
says nothing about whether *this branch* still holds unique work, so T4 now
requires a positive duplication proof against the PR head itself: the branch is
the same commit, an ancestor of it, or content-identical to it. If the PR head
cannot be fetched or the branch matches none of those, the branch falls through
to the content test against `dev`, and if that also fails it is preserved.

The number must also be a whole numeric token of the branch name. The naive
regex extracted `2608` from the date suffix in
`cursor-call-prerebase-260818` and matched it to an unrelated merged PR — the
exact name-guessing that destroyed open-PR heads on 2026-09-02, reproduced
inside the very unit written to prevent it. That branch holds two unique Cursor
stream-EOF and cancel fixes and 31 otherwise-unreachable commits.

This was caught by an independent auditor, not by the author of the rule.

## The guards

Deletion is refused, regardless of test result, for:

- `dev`, `main`, `preview`
- any ref appearing as `headRefName` of an open pull request, read from `gh`
  immediately before the batch and matched as an exact string
- any ref backing a live worktree, from `git worktree list --porcelain`
- the currently checked-out branch

## Controls run before deletion was authorized

The content test is a destructive-action authority, so it was falsified first.

**Negative control.** `origin/codex/responses-usage-passthrough`, head of open
PR #3364, must not score LANDED. It differs from `dev` in 38 files and scored
UNLANDED. Passed.

**Positive control.** `codex/remote-hub-restack-roadmap-archive` carries 39
unique commits but every file it touches is already identical on `dev`; a
commit-based test calls it unmerged, the content test calls it LANDED. Passed.

**Failure the controls caught.** The first shell implementation reported 41
branches LANDED including `feat/macos-app`, which adds an entire `app/` tree
that does not exist on `dev`. Cause: zsh does not word-split unquoted
variables, so `git diff ... -- $paths` passed one 57-line pathspec that matched
nothing and produced empty output, which the test read as "no difference." Any
branch would have scored LANDED. Rebuilt in Python with a real argv list; the
landed set fell from 41 to 6 and `feat/macos-app` correctly moved to UNLANDED.

## Result

Candidate set 104, of which 33 failed the hardened tests and are preserved.

| Verdict | Count | Proof |
|---|---|---|
| Delete | 50 | identical SHA to its PR head |
| Delete | 2 | ancestor of its PR head |
| Delete | 13 | ancestor of `dev` or zero unique commits |
| Delete | 6 | content already on `dev` (squash-hidden) |
| **Total deletion set** | **71** | every entry carries a named proof |
| Preserved: failed the duplication proof | 32 | |
| Preserved: number not a whole token | 1 | `cursor-call-prerebase-260818` |
| Keep: unlanded unique work | 39 | |
| Keep: open-PR head, worktree-backed, protected | 54 | |

Every entry in the final set names its own proof, so no deletion rests on the
absence of evidence. Ledgers: `.tmp/hygiene/DELETE_FINAL.json` and
`.tmp/hygiene/REJECTED_FINAL.json`.

Ledger of the deletion set with per-branch reason:
`.tmp/hygiene/delete-local.json` (scratch space, not tracked).
