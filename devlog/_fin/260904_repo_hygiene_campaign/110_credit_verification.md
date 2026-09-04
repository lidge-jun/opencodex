# 110 — Contributor credit verification

## What was checked

Four maintainer pull requests carry contributor work and therefore owe a
`Co-authored-by` trailer under `AGENTS.md`. The check is not "does a trailer
exist" but "does the trailer name the GitHub account that authored the original
pull request" — those are different questions, and the difference is the whole
finding.

| Carry PR | Carries | Author | Trailer resolves |
|---|---|---|---|
| #3371 | #3357 | @huaiqing-afk | yes |
| #3372 | #3322 | @luvs01 | yes |
| #3373 | #3335 | @x3M3x | yes |
| #3374 | #3333 | @blackjune67 | **no — corrected** |

#3374 carried `Co-authored-by: hajune <june@smartix.co.kr>`. That address is the
git identity on every commit in #3333, so it survives any review that compares
the trailer to the branch. It is not linked to a GitHub account, and GitHub
attributes co-authorship by account-linked email, so the contributor would have
received nothing for their own patch.

Corrected to `blackjune67 <46661504+blackjune67@users.noreply.github.com>`, with
a comment on the PR instructing whoever squashes it to preserve that exact
trailer. Recorded in `CREDITS.md` under "A gap the gate does not close".

## Why the gate missed it

`missing_coauthor_credit` in `.github/scripts/pr-carry-attribution.cjs` fails a
carry PR that has no trailer. It has no way to ask GitHub whether the address in
a trailer resolves to an account, so a well-formed trailer pointing at an
unlinked work email passes. A contributor committing under a company email is
the common case, not an exotic one, which makes this a systematic hole rather
than a one-off.

A useful hardening: resolve the trailer email through the commits API on the
referenced PR and require it to match the PR author's account, rejecting
addresses that resolve to no account.

## Re-verification

`.tmp/hygiene/verify_credit.py` re-reads all four carry PRs live and asserts
each trailer names the original PR's GitHub author. It is a live check against
the API rather than a re-reading of this document.

## Closure comments

Every issue and pull request closed in this campaign carries a comment that
names its author, states what shipped with a code citation, states what did not,
and points at the consolidated issue where the surviving scope lives. Comment
IDs are recorded in the goalplan criterion `c-5`. No item was closed silently.
