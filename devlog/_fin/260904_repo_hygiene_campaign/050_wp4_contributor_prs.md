# 050 — wp4: contributor PR drawdown with credit

43 of the 53 open pull requests come from outside contributors. Closing someone's
pull request is the moment their work either gets recorded or disappears, so this
phase is bound by the attribution policy in `AGENTS.md` and the existing
`CREDITS.md` ledger.

## Rules

1. No contributor PR is closed without a comment that names the author, states
   what happened to their work, and links the evidence.
2. If the work landed on `dev` by another route — reimplementation, carry, or
   rebase — that is a carry, and it requires a `Co-authored-by` trailer on the
   landing commit. For work already landed without one, the repair path is
   `CREDITS.md`, because `dev`, `main`, and `preview` are force-push protected
   and the affected commits are inside published tags. History is not rewritten.
3. PARTIAL contributions are closed only alongside a follow-up issue that names
   the contributor and states which part of their proposal survives.
4. A PR that is merely stale, unrebased, or awaiting review is LIVE. Age is not
   evidence of supersession.

## Draft-state contributors

Many contributor PRs sit in draft behind the four-box readiness gate, and several
carry `intake: hygiene-blocked`. Draft state means the gate has not passed, not
that the work is unwanted — these are classified on content like any other.

## Exit criteria

Every contributor PR has a verdict with evidence; every closure has a credited
comment URL captured; every carried contribution appears in `CREDITS.md` or
already carries its trailer.
