# 021 — wp2/wp3 outcome: two fixed, one reimplemented

## Dispositions

| PR | lane | state | evidence |
|---|---|---|---|
| #2747 | FIX | rebased, approved, CI running | `07b975873` -> `4a0cbb55c`, patch-id `efa23210f341` unchanged |
| #2740 | FIX | rebased, approved, CI running | `f07ee36f2` -> `be11a65f7`; author then added a GUI surface at `1f07b68b8` |
| #2693 | REIMPLEMENT | **CLOSED-SUPERSEDED** by #2794 | three blockers closed, each mutation-bound |
| #2794 | new | **NEEDS_HUMAN** (approval) | CI 23/0, full suite 15352/0; self-approval refused |

## The fork rebases held the authors' work exactly

Both used `--force-with-lease` pinned to the author's last OID, pushed to the
author's fork rather than `origin`, and were announced on the PR before anything
else. Proof that nothing was rewritten:

```
#2747  patch-id  efa23210f341 -> efa23210f341   range-diff 1: = 1:
#2740  patch-id  48b653f9a33b -> 48b653f9a33b   three-dot name list unchanged
```

A side effect I had to own: the force-push resets the four-box readiness checklist
and returns the PR to draft. That is `enforce-target` behaving correctly — an
attestation about the old commit cannot cover a new one — but it means my push
created work for the contributor. I evidenced the two boxes that became objectively
true and asked rather than ticking the author's attestation. Both authors then acted:
`luvs01` completed the checklist and pushed a GUI follow-up, `olddonkey` ticked three
of four.

Second discovery: fork PRs need a maintainer to approve the workflow run. Both sat
in `action_required` with **no CI at all** until approved via
`gh api -X POST .../actions/runs/<id>/approve`. "Only 5 checks" on a fork PR does not
mean the matrix passed — it means the matrix never started.

## #2693: the green suite was the trap

It passed its own suite 62/0 with all three defects live, which is why the
reimplementation was driven by the defect list rather than by its tests.

Each fix is bound by a test that fails without it:

| mutation | tests that fail |
|---|---|
| presence-check instead of `extractSignature` | 2 — nested, too-short |
| turn-wide flag instead of first-call | 1 — first-call sentinel |
| gate on `antigravityUsesReplayCache` | 1 — non-Gemini injection |
| slash-only regex | 2 — Vertex predicate, Vertex end-to-end |

### What the focused suite could not see

70/0 locally, and exact-head CI still failed three shards. Five tests in four other
suites asserted `thoughtSignature === undefined` and the sentinel filled it.

Treating those as stale assertions would have been the easy read. Chasing *why* they
disagreed found two real defects instead:

1. **The replay cache ingested the sentinel** as a genuine signature, so a token
   fabricated on the way out round-tripped back in and was replayed later as evidence
   a turn was signed. Observing it now leaves the cache empty.
2. **`isLikelyRealThoughtSignature` accepted it** — the predicate that exists to
   reject `fc_`/`ctc_`/`tsc_` synthetic ids, and precisely what the issue #174 tests
   protect. The sentinel is alphanumeric with underscores, so it passed every filter.

Only after both were closed were the five assertions genuinely proxies for "nothing
was borrowed". An independent reviewer reached the same conclusion on separate
reasoning and flagged the second defect as residual risk — the one already fixed.

**The transferable form of this:** when a change makes another suite fail, the
question is not "is that test stale" but "what did that test know that I did not".
Twice here, the answer was a real defect.

## Carried into wp4-wp6

#2745, #2638, #2497 remain — all credential or auth-routing surfaces, all needing a
second maintainer. #2794 and #2769 join #2770 in the self-approval queue.
