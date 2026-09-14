# 050 — Round 2 outcome and unit close

Round 2 ran as three wave-A lanes with one config-schema owner. All three landed.

| PR | Merge commit | Lane |
|---|---|---|
| #4584 | 43f4450a53 | catalog auto-refresh and the config schema |
| #4586 | 2e6a0316b9 | web-search bridge residual and the alpha-search fallback |
| #4585 | dfa0e2f985 | codex runtime resolution and the Windows prompt probe |

A fourth change landed alongside them from a separate session: #4580
(8c7f01451e) made cache affinity the default and stopped a transient failure
streak from deleting a live binding. It was rebased onto #4581 and builds on the
same cache-safe replacement rather than beside it.

## Unit totals

22 pull requests closed — 18 merged, 4 closed as superseded with the carrying
merge named and the author credited by trailer. 13 issues closed.

Issues closed: #4570, #4505, #4508, #4542, #4469, #4311, #4312, #4532, #4503,
#3781, #3630, #2730, #4204.

Left open on purpose, with the landed scope recorded on each: #4546 and #4550
(the cache spiral and the status claim are fixed; the send budget, the drain, and
the WebSocket bypass are not), and #4458 (the probe finds the runtime; it still
does not publish the base prompt source). Three follow-ups were filed rather than
folded into a closure: #4582, #4587, and the remainder tracked on #4546.

## What round 2 confirmed

**The disjointness rule earned its cost.** Three lanes ran concurrently on
overlapping subsystems and none of them collided, because the round had exactly
one config-schema owner and the other two were told to file a follow-up instead
of touching the shared file. Both behavior-only lanes obeyed it. The audit that
produced that rule failed twice before it was right, and the third failure was
the useful one: feature-level scoping cannot express "adds a setting", because
every setting lands in the same two files regardless of what it configures.

**Reviewers caught claims, not just bugs.** The strongest finding of the round
was not a defect. One lane's description claimed to close two issues and had only
fixed one; another lane declined to close its issue and filed the remainder
instead. Both were checked by reading the issue and the diff against each other,
which is the part a green check never does.

**A test can look exactly like a product bug.** The runtime lane went red on a
case that wrote a Windows PATH into a Linux shard, where the separator split the
wrong way and the installed binary won the comparison. Reading the failure rather
than trusting its shape is what kept a correct fix from being reverted.

## Unit close

Both rounds are delivered, the closure sweep is done, and the criteria recorded
at the start of this unit are met with fresh evidence: every merge commit was
confirmed to be an ancestor of `origin/dev`, and every claimed closure was
confirmed through the API rather than assumed from a merge.
