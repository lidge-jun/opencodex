# wp2 — audit round 1 synthesis (REVIEW-SYNTHESIS-01)

Unit: `260827_kiro_subagent_delegation_unblock` · work-phase `wp2` · A phase

Reviewer verdict: **FAIL** — 1 High, 2 Medium. All three accepted; none rebutted.

## Root cause of my planning error

I wrote "a tier change is ordering only" as a safety argument. The reviewer read
the same sentence as a defect report, and was right: ordering-only means the
change cannot deliver the protection the work-phase exists to provide.

The counterexample is constructible from code, not hypothetical.
`src/responses/parser.ts:661-666` accumulates `tool_search_output` specs with an
unbounded push, all marked tier 0. At 48 loaded tools the fill loop exhausts
`MAX_KIRO_TOOL_COUNT` before reaching tier 1 and `exec` is dropped — the precise
failure wp2 claims to prevent.

What makes it worse than an ordinary omission: those 48 loaded tools are
reachable only as nested `tools.<name>(...)` helpers inside `exec`. Dropping
`exec` to keep all 48 yields a catalog in which every admitted tool is
uncallable. That inverts the budget's purpose — it optimizes the count while
zeroing the capability.

## Reservation vs eviction

I rejected Cursor's `evictNonExecutionPath` for a real reason: it exempts only
execution-path tools, so it can evict a `loadedFromToolSearch` tool and recreate
#2475. That reasoning survives. What did not survive is concluding that
therefore nothing should be done.

Reservation is the third option I missed. Eviction removes an already-admitted
tool; reservation lowers the room the fill loop sees. Only the former can undo
#2475, because only the former takes something back.

## The test collision (blocker 2) is the more interesting finding

wp2's accept criterion contradicted a test wp1 landed hours earlier:
`tests/kiro-adapter.test.ts:1301` asserts that 48 fillers plus a freeform `exec`
emits no `exec` and names no `ALL_TOOLS`.

Both are correct about different worlds. wp1 encoded a CONSEQUENCE of the
then-current behavior — if the model cannot call `exec`, do not advertise it —
while wp2 removes the premise that `exec` gets dropped at all. The underlying
rule (never name an omitted tool) is untouched and still needs coverage.

Resolution: re-point the fixture instead of deleting the test. The freeform case
becomes wp2's survival proof; wp1's rule keeps its own test on a **structured**
`exec`, which remains tier 3 and remains droppable. Neither invariant loses its
home, and the diff records that the change was deliberate.

This is the concrete cost of one-work-phase-one-cycle discipline being worth it:
wp1's test is what made wp2's plan falsifiable within one audit round.

## Blocker 3: a test that proves nothing

My criterion 2 fixture (loaded + exec + gateway, three tools) never exceeds a
budget, and `kiro-tools.ts:207-211` only sorts when `exceedsBudget` is true. It
would have passed identically before and after the implementation.

Amended to an over-budget fixture declared adversarially (gateway -> exec ->
loaded), so the assertion can only pass if the comparator actually ran.

## Corrections the reviewer made to my rationale

I claimed a `tool_search` gateway without `exec` "can search but never act."
Overstated: `tests/responses-tool-conformance.test.ts:212-216` shows a searched
tool becomes callable on a later turn. The honest ranking argument is latency and
directness — `exec` reaches every nested helper this turn, the gateway needs a
discovery round-trip first — not impossibility.

Confirmed clean by the same review: no import cycle (`tool-catalog-nudge.ts`
imports only `../types`), the omission notice makes no ordering claim, and the
alias registry is populated in declaration order at `kiro-tools.ts:187-205`
before any sorting, so reordering cannot disturb `nameMap`.
