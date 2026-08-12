# 050 — Execution record: closes and review requests

User authorization on record: close what can be closed, re-request review on
what needs it. Executed 2026-08-05T14:43Z against `origin/dev = aaa71967a`.

Everything else in the queue stayed untouched. This document records what was
actually written to GitHub, which is a much shorter list than the queue, and
says why.

## Closed: one issue

| item | reason | evidence cited in the close comment |
|---|---|---|
| #1045 | completed | `git merge-base --is-ancestor 4177345021 origin/dev` → `0`; `bun test tests/system-restart.test.ts` → 24 pass, 0 fail |

`4177345021` injects a fixed `now` at `tests/system-restart.test.ts:330,343`,
which makes the exact `toBe(MEMORY_DRAIN_RESTART_MS)` at `:363` deterministic
without weakening it to a range. The reporter's diagnosis was right; the fix
landed before the report was triaged.

## Not closed, and why

This is the part worth recording. Sixteen bug-class issues stayed open, and none
of them stayed open by omission.

| item | why it stays open |
|---|---|
| #1043, #1046, #1057, #1059, #1061 | real open defects with no fix on `dev` |
| #1024 | half fixed (`f557f9173`, ancestor) — the `opencode-zen` half is still live |
| #1017 | downgraded to UNVERIFIED at the audit gate; the anchors prove the boundary exists, not that it corrupts a payload |
| #904, #796, #418, #994 | the code fix landed or the path is identified, but each waits on a reporter capture or a vendor credential |
| #92, #241, #417 | upstream; no change in this repository closes them |
| #540, #919 | feature/consumed-elsewhere, not defects |

The four in the middle group are the tempting ones. `eeef7a32a` (#904) and
`d3abf4345` (#796) are both ancestors of `dev` and both carry regression tests,
so "the fix shipped" is true — but neither reporter's original case was ever
reproduced here, and closing on a shipped fix that was never shown to address
the reported symptom is how an issue gets closed twice.

## Review requested: three pull requests

| PR | reviewers | what was asked |
|---:|---|---|
| #936 | @Ingwannu, @Wibias (newly assigned — the PR had **none**) | the credential/runtime trust-boundary security review `MAINTAINERS.md` mandates |
| #557 | @Ingwannu, @Wibias (already requested) | second-maintainer boundary judgment, re-raised |
| #1018 | @lidge-jun, @Ingwannu (already requested) | ordinary review — the one PR that is green, mergeable, and inside the freshness gate |

#936 having no reviewer at all is the finding here. Four devlog rounds recorded
it as "needs security review" and every one of them was right; what none of them
did was assign anyone, so the PR sat in a state that reads like a technical
blocker but was an administrative one.

Both #936 and #557 are authored by @lidge-jun, so self-approval is unavailable
under `MAINTAINERS.md` regardless of how the code looks.

Each comment separates the mechanical work from the decision being requested:
#936 needs a rebase and #557 needs a rebase plus two red legs fixed, both owned
by the author, and neither blocks the review being asked for. That separation is
deliberate — asking for a review of a branch that is 869 commits behind invites
"rebase first," and rebasing 869 commits before learning the approach is wrong
is the expensive order.

## Not executed

Queue entries 3, 4, 5, 6 (the autonomous code fixes) and entry 10 (the
rebase-or-close message to 21 out-of-gate PR authors) were not run. They are code
changes and bulk contributor communication respectively, and neither was in the
authorization given.

## Surface after execution

```
40 open issues  (39 frozen − 1 closed + 2 post-freeze arrivals #1062, #1063)
25 open PRs     (unchanged)
```
