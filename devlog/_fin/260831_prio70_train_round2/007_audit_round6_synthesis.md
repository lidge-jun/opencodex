# 007 — audit round 6: wp4 cleared, and wp3 finally gets the right shape

Confirmed closed this round: **wp4**. Its two subagent cases are expressible in
`tests/subagent-model-fallback.test.ts` and collectively turn red if the injected `now`
is dropped. wp2 and wp5 stayed closed and were not reopened. All 16 below-bar component
rows sum correctly, and `070`'s counts match the index.

All three blockers were wp3, and between them they say the same thing: my predicate for
"OpenCodex wrote this row" was wrong for the fourth round running.

## Blocker 1 — the predicate refused a row `dev` restores today

An `openai/vscode/0` entry whose `first_user_message` is null routes to
`opencodex/vscode/0`, because `routeOpenai` sets `has_user_event` to `1` only when the
message is non-empty and otherwise leaves it alone
(`src/codex/history-provider.ts:1184`). My shape B required `has_user_event = 1`, so
that row matched no shape and fell through to refusal — regressing a restore that works
on `dev` and is under test at `tests/codex-history-provider.test.ts:117`.

Disjointness failed too: an entry already recorded as `opencodex/exec/1` is exact shape
A *and* satisfies the old B pattern.

## The actual root cause, after four rounds on one predicate

Round 3: the tuple test has a false positive. Round 4: the provenance flag is not
crash-safe and refuses every legacy manifest. Round 5: the table refuses the ordinary
routed post-image and is not disjoint. Round 6: it refuses the null-message post-image
and is still not disjoint.

Four different rows, four hand-written patterns, four holes. The problem was never the
specific pattern — it was that I kept writing a **parallel description** of what the
routing statements do, and a parallel description drifts from its original by
construction. Every round found a row where it already had.

So B stops being a shape to recognize and becomes a value to compute:
`expectedPostImage(entry)` applies the same rules as `routeOpenai` and `routeExec`,
including the nullable-message branch at `:1184` and the `exec → cli` transition. A row
is B when it equals that value. Disjointness from A is then automatic — if the computed
post-image equals the entry, routing is a no-op for it and A is the correct reading.

**When a check must decide "did our own code write this?", derive the answer from the
code that writes it.** That is the finding of this round, and it is worth more than the
four patches it replaces.

## Blockers 2 and 3 — two stale lines

A regression bullet still said every entry predating provenance refuses, which reads as
the blanket v1 refusal round 4 removed; it is now scoped to legacy shape C. And `000`
still claimed four audit rounds against `070`'s five. Both corrected.

That `000`/`070` drift has now recurred twice. The counts live in two documents and I
updated one of them each time — worth fixing by writing the count once at close-out
rather than maintaining it mid-flight.
