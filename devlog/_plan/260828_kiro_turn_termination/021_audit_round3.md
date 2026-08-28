# wp2 audit round 3 — the outer drain must not learn about completions

Reviewer: independent explorer lane, read-only, HEAD `a43e4cda`.
Verdict: **FAIL** on the plan as written in `020_wp2_duplicate_answer.md`.
This document records the finding and the corrected design.

## What the reviewer accepted

- Consuming the retained collection on a valid completion IS sufficient to remove
  the user-visible duplicate. Required-mode text is held only in `deferred`
  (`src/adapters/kiro.ts:1174-1179`, `:1207`), fallback text only in
  `fallbackEvents` (`:1202-1205`), and a valid completion never live-flushes that
  run because a completion alongside a real tool call is already a protocol error
  (`:1260-1261`). With the commentary `text_delta` gone, `src/bridge.ts` never
  splits the message.
- There is **no third emitter**. `:1523` builds a new event from
  `completionAnswer`; it does not read `deferred`. The early-loop yields at
  `:1398` and `:1418` only flush `deferred` when a real tool starts (`:1175`).
- Dropping `text_delta` while keeping non-text retained events loses nothing
  load-bearing on this path. Tool events never sit in the collection — they splice
  live and forbid a valid completion.
- `releaseEvent` is idempotent via its `eventBytes` map guard (`:808-810`), so a
  double release cannot double-credit the budget.

## The blocker

`020`'s option 1 says to consume the collection at BOTH readers — the inner flush
and the outer drain in `parseKiroAttempt` (`:996-1001`). The reviewer showed the
second half is wrong:

> `996-1001` is also the leftover flush for early `terminal` returns that never
> hit `1468` (`1405-1413`). Dropping `text_delta` there without a completion flag
> hides the only commentary.

That outer drain is the release path for stream, protocol, and provider failures —
the row `020`'s own table requires to stay intact. A turn that fails after emitting
progress prose would lose that prose entirely, which is a worse defect than the
duplicate: the user would see an error with no indication of what the model had
been doing.

## Corrected design

The inner site is the only consumer, and it leaves the collection **empty**:

1. `src/adapters/kiro.ts:1468`, `mode === "required"`: when
   `completionAnswer !== undefined`, splice the collection and consume it — drop
   each `text_delta` after releasing its retention, yield every non-text event and
   release it. When there is no completion answer, flush exactly as today.
2. `:1474`, `mode === "text_fallback"`: this branch is **already** gated on
   `completionAnswer !== undefined`, so the same consume applies there and nowhere
   else in that mode.
3. `:996-1001`, the outer drain: **unchanged**. Because step 1 splices, there is
   nothing left for it to emit on the completion path, and it keeps its full
   flush behaviour for every early-terminal path.

The correction is that suppression is expressed by emptying the collection at the
one site that knows a completion arrived — not by teaching a second,
failure-serving reader to discard text.

Untouched, per `020`'s release table: the `sawRealTool` flush (`:1483`), the
plain-text promotion (`:1490-1498`), and the empty/reasoning-only fallback
(`:1505`).

## Budget note

The reviewer's condition for a leak is "splice, skip `releaseEvent`, and skip
`releaseAll`". The consume path releases every event it drops, and
`releaseRetained`/`releaseAll` still runs for the `trackReplacement` remainder
(`:801-803`), which is not tracked in `eventBytes`. A test asserts the budget
returns to baseline.

