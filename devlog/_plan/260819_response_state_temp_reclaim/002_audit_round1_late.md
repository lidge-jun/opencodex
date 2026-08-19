# Audit round 1 (late) — roadmap review, VERDICT: FAIL

The first reviewer, retired as a failed dispatch after ~11 minutes of silence, returned
afterwards against the ORIGINAL roadmap at `d75a2402f`. Its verdict is **FAIL**. Several
findings were independently fixed by round 2 in the meantime; the rest are folded here.

**The headline finding is correct and I verified it myself.**

## Falsified: the original root-cause narrative

`000_plan.md` claimed a crashing proxy "never reaches the code that would reclaim."
That is wrong. A temp only exists if `atomicWriteFileAsync` ran, which requires
`writeBoundedSnapshot` ← `persistNow` ← `schedulePersist`. Every `schedulePersist` site
is downstream of a populated store: `:1214` follows `ensureLoaded()` at `:1185`;
`:956`/`:971` sit under `expandPreviousResponseInput` → `ensureLoaded`; `:897` and
`:929` are no-ops on an empty store (`:897` fires only when `removed > 0`).

Verified directly: `grep -n 'schedulePersist()' src/responses/state.ts` returns exactly
`:897, :929, :956, :971, :1214`, and `:890-898` confirms the `removed > 0` guard. So
**a process that produced a temp had already run the reclaim.**

## The corrected cause (three parts, all still fixed by this unit)

The reclaim runs **once per process, at load, before that process writes anything**:

1. **One-shot per process.** `ensureLoaded` sets `loaded = true` and never sweeps again,
   so every temp a process abandons after startup is invisible to that process forever.
2. **The 15-minute grace excludes the predecessor.** `:581` skips anything younger than
   15 minutes, so a successor starting promptly after a crash cannot reclaim the temp
   that crash just produced — and it never looks again (part 1).
3. **`maxCleanups = 512` caps one pass** below the ~816 files implied by 19.6 GB ÷ 24 MiB,
   so even a well-timed startup sweep cannot finish the backlog in one go.

A periodic sweep fixes all three: it repeats, so the grace expires into a later tick and
the per-pass cap becomes a per-tick rate. **The fix is unchanged; the justification is
corrected.** That distinction matters — the original story would have made the periodic
tick look optional.

## Blockers folded

- **B1 root cause** — restated in `000_plan.md` as the three-part cause above.
- **B5 the stack's dependency edge did not typecheck.** Phase 1 defined only
  `sweepAbandonedResponseStateTemps(): number`, but phase 2 consumed
  `removed`/`failed`/`bytesRemoved` from a `reclaimAbandonedResponseStateTemps()` that
  phase 1 never defined. Fix: phase 1 exports a result-returning core and the sweeper
  adapter narrows it to `number`.
- **B8 concurrent proxies produce false failures.** Two processes ticking over one config
  dir race; the loser's `unlink` raises ENOENT and lands in `failed`, which phase 2 would
  surface as "in use or locked". Fix: treat a missing path as removed, mirroring
  `isMissingPathError` (`config.ts:132`).
- **B2 `matched` overstates.** It increments at `:574` BEFORE the age and PID gates, so
  doctor would report live-PID temps, young temps, and directories as "abandoned". Fix
  (phase 2): count eligibility after the gates.
- **B10 `formatBytes` does not exist in `src/`** — only `gui/src/format-bytes.ts`, which
  needs a `Locale`. Phase 2 must name a CLI-side helper.
- **B9 sibling producers, recorded as residuals.** The same `.ocx.<pid>.<seq>.tmp`
  template is minted by `config.ts:214`, `config.ts:453`, `catalog-writer.ts`, and
  `prompt-journal.ts`. None are matched by `RESPONSE_STATE_TEMP_NAME` (`:34`) and none
  are reclaimed anywhere. This unit deliberately does not widen the regex — reclaiming
  another subsystem's files under a response-state name would be worse — but they are now
  named as a follow-up unit rather than silently ignored.

## Rejected

- **B6 (unbudgeted tick)** and **B4 (vacuous criterion 4)** were already fixed by round 2
  (scan deadline; catch moved to enclose `responseStateSweepDirectories()`).
- **B3** misreads the dry-run hazard in the opposite direction from my own note; round 2
  supersedes both by replacing injected-IO trickery with an explicit `dryRun` mode.
- **"The stack is too small to justify splitting."** Rejected with reason: phase 1 is a
  correctness fix that every user needs and is mergeable alone; phase 2 adds a CLI surface
  plus docs and carries its own review risk. Landing the correctness fix without waiting
  on CLI review is the point.
