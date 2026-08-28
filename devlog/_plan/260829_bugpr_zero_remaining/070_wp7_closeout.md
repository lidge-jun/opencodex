# wp7 — Closeout: issue closure and the zero-open-bug-PR proof

Dependency position: last.

## Obligations

1. For every landed fix, close its matching issue with a cross-reference comment naming the
   merged SHA and the PR. PRs here target dev, so GitHub does not auto-close: each closure is
   an explicit action.
2. For every bug PR that did not land, post the disposition reason on the PR itself before
   closing it, crediting the original author and naming the replacement PR when one exists.
3. Produce the campaign proof:
   gh pr list --repo lidge-jun/opencodex --state open --label bug --json number
   must return an empty array. This is the c-1 criterion and the campaign's terminal check.
4. Record the final disposition table in this unit, then move the unit to devlog/_fin/.

## Honest-reporting rule

A PR left open for a required non-author security review is reported BLOCKED with the
MAINTAINERS.md quote, not counted as done. If any bug PR remains open at closeout, the
campaign's terminal outcome is not DONE, and the D summary says so plainly with the exact
PR numbers and reasons.
