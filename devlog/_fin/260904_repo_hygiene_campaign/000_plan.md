# 260904 — Repository hygiene campaign

Unit for the branch/PR/issue drawdown requested on 2026-09-04: delete landed and
abandoned refs locally and on `origin`, close superseded and partially-landed
pull requests and issues, consolidate surviving scope into new issues, and credit
every contributor whose work is carried.

## Inventory at entry (2026-09-04, origin/dev = b5777aa2d)

| Surface | Count |
|---|---|
| Local branches | 230 |
| Remote branches on `origin` | 56 |
| Open pull requests | 53 |
| Open issues | 45 |
| Worktrees | 67 |

## Classification of local branches

Every branch was scored on four independent axes rather than by name:

1. `git merge-base --is-ancestor <br> origin/dev` — plain ancestry.
2. `git cherry origin/dev <br>` — patch-equivalence, which catches rebases.
3. Content landing — the files the branch touches
   (`git diff --name-only origin/dev...<br>`) are compared two-dot against
   `origin/dev` restricted to exactly those paths. Zero remaining difference
   means the branch's content is already on `dev` even though a squash merge
   destroyed its commit identity.
4. Exact reference matching against live GitHub state: open-PR head refs,
   worktree-backing refs, and the PR number a scratch branch was cut for.

Resulting buckets:

| Bucket | Count | Disposition |
|---|---|---|
| PROTECTED (`dev`, `main`, `preview`) | 3 | never touched |
| OPEN_PR_HEAD | 7 | never touched |
| WORKTREE-backed | 44 | never touched |
| SAFE_DELETE (ancestor or zero unique commits) | 13 | delete |
| Scratch branches for MERGED/CLOSED PRs | 85 | delete |
| Content already landed on `dev` | 6 | delete |
| UNIQUE_WORK still unlanded | 39 | keep |

## Prior-run failure this unit must not repeat

A cleanup run on 2026-09-02 guessed PR numbers from branch names, treated the
guesses as merge evidence, and deleted the head refs of open pull requests: only
4 of 33 open PR heads survived it. Two rules follow. Open-PR head refs are read
from `gh` and matched by exact string immediately before each deletion batch,
never inferred. And a branch is deleted only when at least one of the four tests
above passes on the branch itself.

## A shell hazard that produced a false positive

The content-landing test was first written in shell. The login shell here is
zsh, which does not word-split an unquoted variable, so a 57-path file list
collapsed into a single nonexistent pathspec and `git diff` returned empty —
reporting `feat/macos-app`, a branch with 57 genuinely unlanded files including
an entire `app/` tree absent from `dev`, as fully landed. Acting on that would
have destroyed the macOS app work.

The test was rebuilt in Python passing a real argument list, and validated
against controls in both directions before any deletion: an open PR head must
score UNLANDED, and a branch whose content is known to be on `dev` must score
LANDED. The rewritten test moved `feat/macos-app` to UNLANDED and reduced the
"landed" set from a bogus 41 to a verified 6.

Rule for this unit: any bulk classifier gets a negative control before its
output authorizes a destructive action.

## Work phases

| Phase | Doc | Scope |
|---|---|---|
| wp0 | this file + 010 | roadmap and inventory |
| wp1 | 020 | local branch deletion |
| wp2 | 030 | `origin` remote branch deletion |
| wp3 | 040 | maintainer-authored PR drawdown |
| wp4 | 050 | contributor PR drawdown with credit |
| wp5 | 060 | issue drawdown and consolidation |
| wp6 | 070 | credit ledger and closeout |

## Out of scope

Merging any pull request, pushing to `dev`/`main`/`preview`, releases,
force-push, history rewriting, worktree removal, and behavior changes under
`src/`. The local test suite is forbidden for this unit by explicit instruction.
