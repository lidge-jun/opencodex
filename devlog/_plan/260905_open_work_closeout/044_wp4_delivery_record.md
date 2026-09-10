# 044 — wp4 delivery record

Closed 2026-09-05. Outcome **DONE** (3/3 landable items landed; #2956 DEFER per 003/006).

| Layer | Source | PR | Head | Landing SHA | Ancestry |
|-------|--------|----|------|-------------|----------|
| L1 | #3447 | #3587 | 4a721e459 | dcdad53b8 | exit 0 |
| L2 | #2783 | #3592 | 80873166e | 2188fcac8 | exit 0 |
| L3 | #2973 | #3588 | 7c7e77968 | 593978db0 | exit 0 |

Evidence: three claude-opus-5 lanes with RED/GREEN per fix (041 + PR bodies); plan audit 042
(5 blockers folded); post-rebase real-network regression in the multi-provider quota test found
and fixed (4a721e459). Per the maintainer's mid-phase instruction, L1-L3 were admin-merged after
local typecheck + focused tests instead of waiting for per-PR exact-head CI; the final dev-tip CI
run is the batch's acceptance evidence and is tracked in 060/wp6. A B-phase implementation review
lane for the stack was dispatched and then retired unfinished when the merge policy changed; its
scope (B4 dynamic-import cadence sync vs the synchronous startServer window; L3 activation gating
for one-provider users) is carried as the first wp6 audit item against the landed tip.
