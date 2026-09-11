# 011 — audit round 10: one cell, and it is genuinely undecidable

Third resumed round. One blocker, and it is the first finding in this phase whose correct
answer is "refuse" rather than "handle it".

Confirmed closed: committed-C split by expected event, pending + D resolving as committed
while preserving the `1`, the three new regressions all constructible and red against
round-8 semantics, B and D still disjoint, v1 fallback and exec bridge sound, and the
round counts correct with the false single-source claim gone.

## The blocker — pending + C with expected event `1`

Round 9's pending table said every shape C proves the routing write did not land. For an
OpenAI-origin entry whose expected route event is `1`, that is false. Two histories reach
the identical state:

1. routing never landed, and Codex-side activity moved the original row `0 → 1`. The
   `1` is the user's and must survive.
2. routing landed as `opencodex/vscode/1`, the process crashed before the marker
   resolved, and legacy recovery rewrote the row to `openai/vscode/1`
   (`src/codex/history-provider.ts:991`). The `1` is OpenCodex's and must restore to
   `0`.

Same tuple, same provenance, same expected event. The reviewer's falsification is the
part worth keeping: it did not merely find a case my table mishandled, it showed that
**no durable fact remaining in the system distinguishes the two**.

So the cell refuses. That is the right answer rather than a gap in the design — a guess
here either erases a user's activity or fabricates activity that never happened, and
refusal leaves the manifest intact for a human to resolve. The two neighbouring cells stay
decidable: expected event `0` is safe because routing would have written a `0`, and
`exec`-origin entries are safe because `routeExec` moves `source` to `cli` and legacy
recovery does not restore it, so a legacy return cannot land on the original tuple at all.

The scoping regression matters as much as the refusal: an `exec`-origin pending + C that
still restores, so a later reader cannot generalize one refusing cell into a blanket
pending + C refusal — which is the round-8 wedge coming back.

## What ten rounds on wp3 actually produced

The predicate went: tuple test (r3) → provenance flag (r4) → three-shape table (r5) →
computed post-image (r6) → call the existing helper (r7) → fourth shape (r8) → transition
semantics (r9) → one undecidable cell (r10). Each step was a smaller correction than the
last, which is the shape a converging design has.

The other five phases have drawn zero blockers since round 7. wp3 is a durable-state
integrity check with two writers and a crash window, and it turns out that is worth
roughly nine rounds more scrutiny than a bounded byte-accounting fix.

## Housekeeping

"three shapes" immediately above the four-shape table, flagged as a non-blocking caution,
is corrected.
