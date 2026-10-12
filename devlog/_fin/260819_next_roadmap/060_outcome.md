# 060 — Campaign outcome

Loop: HOTL, session `01a01949`, five work-phases. All four requested lanes
closed. The split program (R5) was not started, as scoped.

## What shipped

| Lane | Outcome |
|---|---|
| R2 merge | #2084 (`973258488`) and #2089 (`c4bf833c9`) merged to `dev`, in that order |
| R1 rebase | #2019, #2023, #2036 rebased/recut and pushed; **all three Cross-platform CI green** |
| R3 collisions | `prompt_cache_retention` decided for #2102; K12 held on both PRs with a shared root cause; eight wrong-branch PRs retargeted |
| R4 review | four verdicts posted: merge #2085, merge #2086, hold #2100, hold #2077 |

Two source defects were found and fixed before the only authorized merge, and
two plan documents were corrected by their own audit lanes. Those four events
are the substance of this campaign; the merges and rebases are the mechanics.

## The four things worth remembering

**1. A plan's conclusion can be right while its explanation is wrong.**
010 first said CI ran "dev's newer test against the PR's older source." The run
log shows the reverse — newer source, older test. The conclusion (stale-base
skew) survived and was later proven by a green CI run on the rebased head. The
mechanism did not. An explanation that survives because its conclusion happens
to be right is exactly the kind that gets copied into the next document
unchallenged.

**2. Two of the defects we shipped fixes for were invisible to green CI.**
The directory-handle leak fired only on truncated scans; the budget warning was
dead code that no test exercised because no test could produce the state. Both
PRs were green before review. Green CI proved the code did not break anything
it already tested — nothing more.

**3. A test can pass against its own ablation.** The deadline test set its fake
clock to `0` while fixtures carried real epoch mtimes, so every computed age
was negative and the files survived the 15-minute grace whether or not a
deadline check existed. Deleting the feature it guarded did not fail it. Every
repaired guard here was driven red once against a deliberate violation, and the
two new ones carry explicit ablation assertions.

**4. Batch review earns its keep by refuting its own premise.** R4's contract
("read per-model overrides the way the runtime reads them") implied migrating
every map to `modelRecordValue`. Two maps are deliberately exact-own-only, so
that migration is a regression — which is what #2077 does. Four separate
reviews would each have seen a correct-looking one-line change.

## Left open, deliberately

- **The three split PRs are green but still gated** on
  `hygiene: missing_regression_test`. That gate is correct for a pure-move PR;
  the honest resolution is `test-exception-approved`, not a test that restates
  the compiler. Needs a maintainer decision, not more code.
- **#2100 and #2077** need author changes named in their review comments.
- **#2056 / #2062** both need the same scorer gate before either can land.
- **#2063** is `CONFLICTING` and overlaps the merged #2055; it needs an author
  rebase and a rescope.
- **The boot-floor limitation** in the reclaim path is documented in code and in
  020: it can skip the liveness probe for a temp older than this boot, which is
  only reachable when a config dir is shared across hosts. Revisit if that
  becomes a supported deployment rather than an incidental one.
- **Two smaller reclaim findings** deferred with reasons in 050: aliased-directory
  double counting in the dry run, and symlink containment on the directory side.

## R5 remains unstarted

WP1/WP1b/WP2a are now rebased onto current `dev` with green CI, so the split
program's opener is no longer rotting. Nothing past it was touched: no WP2b
stateful config train, no registry, no service, no `responses/core.ts` waves.
