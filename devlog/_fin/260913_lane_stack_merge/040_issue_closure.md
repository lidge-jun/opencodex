# wp5 — Issue closure

Scope added by the user after the goal was armed. It supersedes the original
objective line that excluded issue closing.

## Why this needs its own phase

A merged pull request does not prove its linked issue is resolved. The earlier
triage pass on this repository checked 24 closure candidates and every one came
back KEEP: related work had shipped, but the actual ask had not been met. The
recurring patterns were a partial implementation, a diagnostics-only landing, a
different design than the issue requested, and an implementation that existed
only in an unmerged pull request.

Two failure modes matter most. `Refs #N` is not `Closes #N`, and a pull
request body that states the issue stays open outranks any topical similarity.
#4380 is the worked example: it fixed part of the restore-write interval and
said in its own description that #4311 remains open.

## Research pass

A `kimi/k3[1m]` thread reads all 36 pull requests and every issue they
reference, then classifies each issue as CLOSE, PARTIAL, or KEEP with a one-line
rationale, and produces a table mapping each closable issue to the pull request
that closes it.

That map is research input, not authority. The main session re-verifies each
CLOSE candidate against landed `dev` before acting, because the map is built
while the merges are still in flight.

## Execution

For each verified CLOSE issue, comment with the landing pull request number and
the dev merge commit, then close it. PARTIAL issues stay open with a comment
naming what landed and what remains. KEEP issues are left untouched.

GitHub only auto-closes `Closes #N` links when the pull request merges into the
default branch. These merge into `dev`, so every closure here is manual.

## Research result

The `kimi/k3[1m]` thread finished its pass and returned 11 CLOSE candidates, 5
PARTIAL and 2 KEEP.

CLOSE candidates: #2495, #3898, #4079, #4205, #4206, #4208, #4211, #4236,
#4308, #4314, #4315.

Treat that list as research input, not authority. Each candidate is re-verified
against landed `dev` before it is closed, because the map was built while the
merges were still in flight and some of the pull requests that would satisfy
these issues had not landed yet.

## Exit criteria

Every verified CLOSE issue is `CLOSED` with an evidence comment naming the
landing pull request and merge commit, every PARTIAL issue has its
remaining-work comment, and the full CLOSE/PARTIAL/KEEP map is recorded in this
unit.
