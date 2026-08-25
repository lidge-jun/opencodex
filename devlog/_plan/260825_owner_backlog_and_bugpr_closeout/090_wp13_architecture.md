# 090 — wp13: the four architecture issues

Each was checked against `devlog/_fin/` and against `src/`. None is stale-but-done.

### #1478 — config rebase provenance
`src/config.ts:2590` stores snapshot baselines only, and `:2901` still infers intent
from key presence, so deletion and unseen-key cannot be distinguished. Both regressions
are separately pinned (`tests/config-user-edits.test.ts:652` and `:221`).
`devlog/_plan/260823_owner_backlog_closeout/110` explicitly retains this as unresolved.
L / HIGH: persisted-config schema migration plus provenance at every top-level deletion
writer (12 call sites).

### #1049 — pre-substrate Codex home adoption
`src/codex/inject-coordination.ts:87` still classifies routed/indeterminate
pre-substrate homes as `legacy-uncoordinated`, and `src/codex/inject.ts:932` bypasses
transition publication on that path. `git grep adoption-pending` returns nothing.
The deferral is recorded at `devlog/_fin/260816_wave34_closeout/101`.
L / HIGH: incorrect crash-safe publication can strand every pre-substrate home.

### #1048 — WP13 composed acceptance
PR #1106 (`43a1fdc45`) delivered the workstation suite and #2452 (`6b0f61f64`) is an
ancestor of dev, but `git ls-tree origin/dev scripts/disposable-host` is empty and
`devlog/_fin/260806_wp13_toggles_resume/030` explicitly excludes P09/P10/P18/P34-P36.
L / HIGH: service-manager acceptance is destructive and platform-specific — it cannot
run on an ordinary workstation.

### #820 — bounded 32-session tool recall
Partial bounds landed via #829 (`09a0a1826`): per-call/turn/transport limits
(`src/lib/translator-budget.ts:1`) and a 256-turn global gate
(`src/server/lifecycle.ts:32`). But lifecycle still keys leases by `AbortController`
(`:160`) rather than logical session lanes, and no 32/64-session harness exists.
The scheduler architecture is explicitly deferred at
`devlog/_fin/260801_zero_leak_state_stores/035:677`.
L / HIGH: spans protocol, memory admission, retries, and account affinity.

## Honest assessment

This phase is four L/HIGH units. It is the single largest risk to the DONE criterion,
and it is where a BUDGET_EXHAUSTED or NEEDS_HUMAN outcome is most plausible. It is
sequenced last so that everything cheaper lands first.

