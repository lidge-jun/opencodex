# 060 — wp7: #2476, snapshot write amplification (conditional)

Phase: wp7. Depends on: wp1. PR: #2476 (**Draft**, readiness 2/4), head
`1c571654c`, author `ntdat812`.

## Defect

The Responses state snapshot — up to 24 MiB — is atomically replaced on a fixed
2-second debounce whether or not anything changed. On a real Windows host this
produced 2.4–5.2 MB/s of process-wide write I/O and 20–50% of one core.

## What the PR does, and what the reviewer verified

- `src/responses/state.ts:802-820` — serialize once, compare digest **and**
  byte length, and skip `atomicWriteFileAsync` only when they match *and*
  `existsSync(path)`. The `existsSync` conjunct is what makes the
  externally-deleted-file trap safe, and there is a direct regression for it
  (`tests/responses-state-write-amplification.test.ts:100-109`).
- `src/responses/state.ts:839-859` — debounce scales linearly from 2 s at
  1 MiB, clamped to 30 s.
- 24 MiB cap, TTL → count → resident spill ordering: unchanged
  (`:782-801`, `:994-1027`).
- Graceful shutdown still cancels the timer and flushes (`:885-896`, called from
  `src/server/lifecycle.ts:438-447`).

All four of the primary acceptance conditions hold.

## Why this phase is conditional

Two reasons, and neither is about code quality:

1. **The PR is Draft with readiness 2/4**, and the maintainer's recorded
   instruction is explicit: do not merge until the checklist and the Linux suite
   have actually run the new file.
2. Known residual gaps the reviewer found: a restart forgets the last digest
   (first post-restart flush always rewrites), and external *replacement* — as
   opposed to deletion — is not detected, because the comparison is against the
   in-memory digest rather than the bytes on disk.

Neither residual makes the change worse than `dev`. Both are honest limits of a
small fix, and the right response is to record them, not to grow the patch.

**Decision rule for this phase:** include only if, before freeze, the PR leaves
Draft, its checklist is truthfully complete, and an exact-head full suite plus
the Linux job are green. Otherwise defer with that evidence recorded. An
unproven persistence change is exactly the kind of thing a hotfix must not
carry.

## Required additions if included

`tests/responses-state-write-amplification.test.ts` — MODIFY:

1. `clamps debounce to exactly 30_000 ms at the snapshot bound` — assert
   equality, not `<=`.
2. `graceful drain flushes pending response state without waiting for debounce`
   — drive `drainAndShutdown` and assert the latest response is on disk before
   `server.stop`.
3. Document the external-replacement limit in the doc comment rather than
   asserting a behavior the fix does not implement.

## Accept criteria

| # | Criterion | Proof |
|---|-----------|-------|
| 1 | Identical payload does not rewrite the file | mtime unchanged across 5 flushes |
| 2 | Externally deleted snapshot is regenerated | existing regression |
| 3 | Changed payload always writes | existing regression |
| 4 | Debounce clamps to exactly 30 s at the bound | new test |
| 5 | TTL / spill / eviction order and 24 MiB cap unchanged | `bun test tests/responses-state.test.ts` |
| 6 | Graceful shutdown preserves the last change | new test |
| 7 | PR non-draft, checklist truthful, exact-head suite green | `gh pr view` + CI |
| 8 | Merged, **or** deferred with this evidence recorded | merge SHA or defer record |

## Scope boundary

IN: the digest/length skip, adaptive debounce, and their tests.
OUT (explicitly, per the original planning note): append-only journals,
incremental databases, any change to the 24 MiB cap or eviction policy, and any
attempt to detect external file replacement.

