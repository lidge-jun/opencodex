# 070 — WP7: Bun 1.4 memory stack retarget

Four maintainer-authored PRs forming a stack. The user's instruction is explicit:
**retarget rather than abandon**. This document records the per-PR decision and the
evidence behind it.

## Stack shape as opened

```
dev
 └── #2301  codex/bun14-followup-memory-docs   (devlog only, 612+/0-, 10 files)
      ├── #2302  codex/bun14-mem-diagnostics    (runtime, 56+/5-, 4 files)
      │    └── #2303 codex/bun14-gc-relief-eval (harness, 658+/0-, 5 files)
      └── #2304  codex/bun14-smol-ab            (harness, 147+/0-, 2 files)
```

Only #2301 targets `dev`; the other three target stack-internal branches, which is why
`dev` Cross-platform CI never ran on the runtime diff. #2302's CI shows `ci` and
`macos` FAIL.

## The two experimental verdicts are FAIL, and that is the deliverable

- **#2304 (smol workers): FAIL.** Median peak RSS 447,758,336 B off vs 447,807,488 B on
  across 3 runs/arm on Bun 1.4.0 darwin/arm64 — no reduction. Per the audited
  pre-landing gate, **no production `smol` flags were landed.** The harness plus the
  recorded verdict is the deliverable.
- **#2303 (Bun.gc relief): production hook NOT added.** Phase A is measurement only.

A FAIL verdict recorded with its evidence is a legitimate outcome, not wasted work — it
is what stops the next person re-running the same experiment. That argues for landing
the *records*, not for closing the PRs silently.

## Recorded blockers (reviewer `Ingwannu`, exact-head reviews)

### #2301 — docs parent
1. `000_research.md` dated `2026-08-22` while the review was written 2026-08-21, so a
   future date was presented as completed current evidence.
   **Status at this unit: MOOT.** Today *is* 2026-08-22, so the date is now simply
   correct. The "today" present-tense claim no longer misrepresents anything. This must
   be stated explicitly in the merge note rather than silently ignored.
2. `git diff --check origin/dev...HEAD` fails on all ten added Markdown files — extra
   blank line at EOF. **Still live**, mechanical, must be fixed.

### #2302 — runtime diagnostics
1. Targets the docs branch, so no `dev` code CI. Must be retargeted/rebased onto current
   `dev` for exact-head CI. Merging it through the docs parent would smuggle a runtime
   diff into `dev` without the code gate. **This is the core retarget instruction.**
2. `src/server/management/system-routes.ts` converts a missing/non-numeric
   `heapStats().extraMemorySize` into `0`, while watchdog and doctor types correctly
   treat it as optional. **"Unavailable" is not the same measurement as zero** — a real
   correctness defect in an observability feature.

### #2303 — GC relief harness (re-reviewed, CHANGES_REQUESTED sustained)
1. Records `rssAfterLoad`/`rssPlus5s`/`rssPlus60s` but **no pre-load baseline**. The
   controlling gate is "at least 50% of post-load RSS *growth* is gone", which needs
   `rssBeforeLoad`, `postLoadGrowth`, and `recoveryFraction`. The revised verdict divided
   recovered bytes by total post-load RSS ("<0.1% of load-height RSS"), which is not the
   controlling criterion. The data may well reach the same FAIL, but the report cannot
   *prove* the gate without the baseline.
2. Latency cells still serial.
3. Never calls `/api/system/memory`, so the stated `extraMemorySize` dependency on #2302
   is unused.

### #2304 — smol A/B harness
1. Future-dated measurement record. **Now moot** (see #2301).
2. `payloadMb` and `runs` accept zero, negative, non-numeric, and arbitrarily large
   values. `runs=0` reaches `median([])` and writes a structurally incomplete gate; a
   huge payload can exhaust the host. Needs finite-positive-integer validation.

## Disposition

| PR | Decision | Rationale |
|----|----------|-----------|
| #2301 | **REBUILD → merge** | Blocker 1 moot by date; blocker 2 is a whitespace fix. The research ledger and decade docs are the durable value. |
| #2302 | **RETARGET onto `dev` + fix** | Exactly the user's instruction. Fix the `0`-vs-unavailable defect, retarget to `dev`, obtain real exact-head CI. |
| #2303 | **REBUILD** | Add `rssBeforeLoad`/`postLoadGrowth`/`recoveryFraction` so the harness can prove the gate it cites. Keep production GC hook out. |
| #2304 | **REBUILD → merge** | Add input validation; the FAIL verdict itself is sound and stands. |

No PR in this stack is closed. The FAIL verdicts are preserved verbatim — a negative
result with evidence is the point of the unit.

## Accept criteria

1. #2302 targets `dev` and has exact-head CI, not stack-internal CI.
2. `extraMemorySize` absence is representable as absent, not `0`.
3. #2303's harness records a pre-load baseline and a baseline-relative recovery fraction.
4. #2304 rejects non-finite / non-positive `runs` and `payloadMb`.
5. No production `Bun.gc(true)` call and no production `smol: true` flag is landed.

