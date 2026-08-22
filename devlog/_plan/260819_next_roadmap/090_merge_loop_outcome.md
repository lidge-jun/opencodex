# 090 — Merge-loop outcome

HOTL loop, session `01a01949`, ten work-phases. **14 merged, 8 held.**

## Merged

| Work-phase | PRs |
|---|---|
| wp2 | #2085, #2086 |
| wp3 | #2035, #2031, #1878 |
| wp4 | #2103 |
| wp5 | #1876 (closes #1852) |
| wp6 | #2112, #1934, #2080 |
| wp7-9 | #2019, #2023, #2036 — the split stack, bottom-up |
| wp10 | #2119 — this loop's own two fixes |

## Held, with posted blockers

#2102, #2105, #2053, #2100, #2077, #2056, #2062, #2063 — all verified still
OPEN at closeout. Nothing was swept in by a batch merge.

## What the batching rule actually bought

The user's instruction was to merge in small batches rather than sweeping
stage 1 at once. Three defects were caught that a sweep would have shipped
behind green CI:

**#2105** — `reconcileShellHook(false)` unconditionally removes the hook, but
`false` also means "`claude` is not on **this process's** `PATH`". A
service-started proxy does not inherit the interactive login shell's `PATH`, so
a user with Claude Code installed would have had their working `.zshrc` hook
deleted. The change made the safe direction conditional and left the destructive
one unconditional.

**#1876** — the async catalog fix returned a pre-write `fresh` to a request that
was already waiting when an invalidating write landed. `fresh` is the one state
authorizing positive model guidance, so it would advertise a catalog the
app-server no longer had. **A slow answer was the bug; a wrong answer is worse
than the bug.** Fixed on our branch, and the existing regression had been
asserting the defective `fresh` — the test was pinning the bug.

**#2080** — a paid priority tier enabled from an assertion rather than evidence.
Being wrong charges the user.

## Three things this loop taught that outlive it

**1. A verdict is bound to a head.** Every work-phase re-reviewed because heads
had moved, and it mattered twice: #2102's author had changed the exact code the
earlier verdict covered, and #2086's moved head added a `noVisionModels`
precedence fix that was not in the reviewed diff.

**2. Stale base is a claim about the base, not the change — four times over.**
#2031 (60 behind), #1876 (67), #2019/#2023/#2036 (29). Each had red CI that went
green on rebase with no source change. The converse stayed honest: a rebase
removes the base as an explanation, it does not prove the change is good.

**3. "No test is possible" was a claim, not a fact.** This document asserted
across three campaigns that a barrel extraction's oracle is `tsc` plus its
importers, and that a barrel test "restates the compiler". A review lane
disproved it: forking `MODEL_ADAPTER_OVERRIDE_ALLOWED` into a second `Set`
inside the barrel leaves `tsc --noEmit` at exit 0, and no test imported the
leaves directly, so barrel and leaf were never compared. That test now exists
(`tests/types-barrel-identity.test.ts`) and drives red against exactly that
fork.

The pattern across all three: **the conclusions held and the reasons did not.**
Same finding as the previous campaign's closeout, arrived at independently.

## A process failure worth recording

wp6 held three PRs with three blockers. Two got follow-up fixes before merging;
#2112's did not, and it landed with `codexToolMode` still absent from
`providerConfigSchema`. Because that schema ends in `.passthrough()`, nothing
failed — a misspelled value was accepted and silently resolved to the default.

Caught at closeout and fixed (`d697e2553`), but the honest reading is that the
hold did not hold. **A hold is worth exactly what the re-check before merge is
worth**, and a passthrough schema leaves no trace at the merge boundary.

## Still open

- The 8 held PRs need author responses.
- The preview/soak gate from `070` has not run. The split is on `dev`; it has
  not been exercised as a published build.
- `dev` CI on the final head was still in flight at closeout; no failing leg was
  observed on any run in this loop.
