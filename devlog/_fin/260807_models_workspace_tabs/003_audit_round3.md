# Audit round 3 — VERDICT: NEAR-PASS

"The plan is ready for B." Three rounds, two FAILs, thirteen blockers, all accepted and
none rebutted.

## Disposition

All five round-2 blockers resolved. The two that mattered — the ones where I had written
a rule where a mechanism was required — are now judged implementable as written:

- **`retainedData`** performs no render-time ref access and no render-time state update.
  `setRetainedData` goes immediately after the coherent payload is assembled and before
  it is returned. Expected to satisfy React Compiler and `react-hooks/refs`.
- **`loadAbortRef`** touches the ref only in callbacks and effects, never render. Owner-
  checked clearing belongs in `finally`; the existing generation check already stops a
  superseded aborted request from publishing an error.

Every phase boundary derives green. No assertion is forced to fail and no union, import,
or prop mismatch is created by the ordering.

## The duplicate-mount question, answered

I flagged wp02a's dual routes as a risk: during that phase both `#combos` and
`#models/combos` render Combos. The answer is that they never coexist — App renders one
page at a time, so `page === "combos"` and `page === "models"` are mutually exclusive
branches. No duplicate dialogs, DOM ids, or subscribers.

Better still, the churn is already handled: `client-resource.ts:277` delays
zero-subscriber eviction by a macrotask precisely to survive an unmount/remount gap. The
shared cache key helps here instead of colliding. The additive phase is safe for a reason
that predates this work.

## Residual risks accepted

Four, all bounded and observable inside a normal build → test → browser loop:

1. **`fetchSelectedModels` takes `fetchImpl`, not a signal** (`model-visibility.ts:27`).
   The fourth catalog request crosses a helper boundary to become cancellable. Caught by
   typecheck and the hidden-request test.
2. **Routing needs unmount cleanup too**, not only inactive-tab cleanup — leaving Models
   entirely should not strand a request. A mounted unmount test covers it.
3. **Shadow/V2 cancellation shape** — one shared controller or per-effect controllers is
   a local choice. Request-count tests expose a wrong one.
4. **Full-height CSS and native modal behaviour are browser truths.** Short landscape
   height, independent rail scrolling, and top-layer dialogs cannot be settled by more
   planning. They are in the render-grounding checklist.

## Closing the roadmap cycle

The value here was not the documents; it was that three of the thirteen blockers would
have produced commits that could not compile, one would have shipped a knowingly broken
layout, one would have silently destroyed the drafts the design existed to protect, and
one invalidated the definition of "green" itself. None was visible from reading my own
plan.

Two lessons worth carrying forward rather than filing:

**Verify the verification.** The claim "`bun run test` covers both suites" sat inside the
document that defines what done means. I asserted it after learning the second directory
existed — an assumption upgraded to fact without a single command run. One `sed` of
`scripts/test.ts` would have caught it.

**A rule is not a mechanism.** "Gate the network, never the tree" is correct and
unimplementable. Both times I stated an invariant and moved on, the reviewer had to
supply the design. Diff-level means the diff, not the principle behind it.

wp00 closes. wp01 begins.
