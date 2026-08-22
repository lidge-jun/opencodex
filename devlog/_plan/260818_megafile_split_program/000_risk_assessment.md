# Mega-file split program — risk assessment (tests-may-change basis)

Date: 2026-08-18. Basis commit: dev @ 314f3edbf.

## Premise

Unlike the earlier facade-only analysis, this assessment assumes large-scale
refactoring is authorized, **including rewriting tests**. That flips several
"blocked" verdicts to "possible", and introduces one new first-class risk:
**oracle weakening** — a test rewritten in the same PR as the code it guards
can become vacuous without anyone noticing. Every rewritten guard test must be
driven red once against a deliberate violation before the PR merges (the same
discipline repo-hygiene and core-lab-boundary already follow).

Evidence base: three read-only investigation reports (core.ts; config.ts +
types.ts; service.ts + registry.ts) produced 2026-08-18 by subagent audit,
plus a live check of open-PR overlap.

## New cost discovered: open-PR overlap

8 of 20 open PRs touch the five target files:

| PR | Touches |
|---|---|
| #1965 FastWire B1 | config.ts, registry.ts, responses/core.ts, types.ts |
| #1956 FastWire B0 | config.ts, registry.ts, responses/core.ts, types.ts |
| #1946 win-030 | config.ts |
| #1945 win-020 | service.ts |
| #1944 win-010 | service.ts |
| #1941 grok responses | responses/core.ts |
| #1940 cursor checkpoint | types.ts |
| #1934 tool alias | types.ts |

A big-bang split rebases all of these onto moved code. FastWire B0/B1 and the
Windows stack (#1944-1947) are the two live programs most exposed. Sequencing
constraint: either land those first, or split first and absorb their rebase
cost — do not interleave.

## Risk scoring

Scale: probability of breakage x blast radius, per work package, assuming
tests may be rewritten. "Oracle risk" = risk that a rewritten test no longer
guards the original invariant.

### WP1 — types.ts split (6 leaves + barrel)

- Mechanical risk: **low**. Almost all type-only; 7 value helpers move to
  types/tools.ts / types/wire.ts.
- Test surface: no source-invariant tests pin types.ts. ~400 test files import
  it via the barrel, which survives.
- Oracle risk: none.
- Conflict cost: #1940, #1934, #1956, #1965 touch types.ts — trivial rebases
  (import lines only).
- **Overall: LOW. Safe opener.**

### WP2 — config.ts split (12 leaves + barrel)

- Mechanical risk: **medium-high**. Eight module-level singletons (SQLite
  mutation lock, three WeakMaps keyed on config object identity, PID process
  cache, atomic-write seq, config-dir memo, warning memos) must each end up in
  exactly one ESM module. Duplicating any of them is a silent correctness bug
  (forked lock = lost cross-process exclusion; forked WeakMap = Claude
  baseline forgotten).
- Known landmine: config <-> routing/profile init cycle through
  hasOwnProvider. Extracting provider-name.ts first removes it; extracting
  schema first can turn it into a TDZ crash.
- Test surface: 122 test files import config; 84 import saveConfig. With
  tests rewritable, the high-risk clusters (schema/load/mutation/live-rebase)
  can move in one train and tests can retarget to leaves.
- Oracle risk: medium — salvage/degrade-don't-wipe tests are behavioral, not
  textual; retargeting is safe if assertions stay intact.
- **Overall: MEDIUM-HIGH. Two trains: low-risk leaves (provider-name, paths,
  atomic-write, env-flags, pid) then the stateful train
  (schema+load+mutation+live-rebase together, never apart).**

### WP3 — providers/registry.ts split (types/lookup/models/entries)

- Mechanical risk: **low-medium**. Zero mutable state, zero hooks. Risks are
  data-shaped: registry array order is user-visible (featured list, CLI
  order); providerMatchesRegistryTransport is an auth boundary and must not
  drift during the move.
- Test surface: parity test (1111 lines) imports via barrel; survives as-is.
- Oracle risk: low — keep the parity test untouched; it is the oracle for the
  move itself.
- Conflict cost: FastWire B0/B1 add registry fields — land or freeze first.
- **Overall: LOW-MEDIUM.**

### WP4 — service.ts split (ids/state/ports/health/launchd/systemd/windows/*)

- Mechanical risk: **medium-high**. Three module-level test hooks and the
  ownedWindowsSchedulerStages Set must each stay single-instance; tests reset
  hooks in afterEach and will silently poke a dead binding if the hook module
  forks. service.test.ts (2104 lines) does a namespace import — with tests
  rewritable it can be split per-platform alongside the code, which is the
  better end state anyway.
- Windows elevate/UAC + dual-backend lifecycle remain the genuinely hard part
  regardless of test freedom: the risk is runtime (UAC rollback, nonce
  ownership), not test coupling. CI cannot exercise real UAC — verification
  is partially manual on a Windows host.
- Bonus fix folded in: unify killWindowsServiceWrapperProcesses (path-match
  version in service.ts vs the weaker filename-match fork in update/job.ts).
- Oracle risk: medium — a per-platform split of 2104 lines of oracle needs a
  deliberate red-drive per moved cluster.
- Conflict cost: #1944/#1945 touch service.ts — small; land them first.
- **Overall: MEDIUM-HIGH; windows/elevate + lifecycle sub-package HIGH
  (runtime-verification-bound, not test-bound).**

### WP5 — responses/core.ts full split (the package the premise changes most)

Previous verdict: Wave C impossible (7 source-invariant tests read core.ts as
text). With tests rewritable, Wave C becomes possible but is the most
expensive package in the program:

- Wave A (errors, service-tier-gate, combo-failure, codex-forward-auth,
  continuation-policy, types): **LOW**, unchanged.
- Wave B (codex-pool-retry, combo with injected runner, normalize-route):
  **MEDIUM**, unchanged. Keep dynamic imports dynamic.
- Wave C (passthrough SSE, recovery loop + terminal-guard continuation,
  pre-stream pipeline): **HIGH**, newly unlocked. Requirements:
  1. Introduce a ResponsesTurnState context object first, in place, with a
     regression test that the 429 budget (rateLimitRetries) and imageTierBias
     stay shared across the main loop and terminal-guard continuation. This
     step converts closure coupling into explicit structure and is the
     prerequisite for everything after it.
  2. Rewrite the 7 source-invariant tests to scan the new module set
     (src/server/responses/*.ts) or targeted new files. Each rewritten
     invariant MUST be driven red (e.g. temporarily add a forbidden
     routing/compatibility import) before merge.
  3. Update tests/core-lab-boundary.test.ts PROTECTED roots so the walk
     starts at the new entry and still covers every extracted module
     statically imported from it. The invariant ("a one-provider user loads
     no Lab code") is about the runtime graph, not the file name — the test
     update is legitimate, but it is the single most safety-critical edit in
     the whole program.
  4. sidecarOutcomeRecorder is a denylist token in auth-cors — renames
     forbidden.
  5. The host-admission lease handoff and inspectionSawUndeclaredTool must
     travel inside the state object, never duplicated (#1700 regression
     class).
- Oracle risk: **HIGH** — this package rewrites the guards and the guarded
  code together. Mitigation: the red-drive rule, plus Wave C runs as its own
  PR train with zero behavior change allowed (pure move + state object only;
  any behavior fix ships in a separate PR before or after).
- Conflict cost: #1941 (28 files), #1956/#1965 all touch core.ts.
- **Overall: Wave A LOW / Wave B MEDIUM / Wave C HIGH. Expected residual
  core.ts after the full program: ~800-1200 lines of pure orchestration.**

## Program-level risks

| Risk | Level | Mitigation |
|---|---|---|
| Oracle weakening (tests rewritten with code) | HIGH | red-drive every rewritten guard; pure-move PRs carry zero behavior change |
| Open-PR rebase storm (8 PRs overlap) | HIGH | land FastWire B0/B1 + win-010/020/030 + #1941 first, or freeze them; never interleave |
| Singleton forking (config locks, WeakMaps, service hooks, stage Set) | MEDIUM | one-module-per-singleton rule; review greps for duplicate declarations |
| Lab-boundary regression via new static imports | MEDIUM | boundary test updated in step, never skipped; run on every commit of the train |
| ESM init cycles (config/profile TDZ, core/combo) | MEDIUM | provider-name leaf first; injected runner for combo |
| Windows runtime (UAC/elevate) unverifiable in CI | MEDIUM | keep elevate/lifecycle last; manual Windows-host verification gate |
| Long train vs release cadence (main/preview promote from dev) | LOW-MED | every PR leaves dev releasable; no cross-PR broken states |

## Recommended order

1. WP1 types (LOW) — also unblocks leaf imports for core/router later.
2. WP2a config low-risk leaves (LOW-MED); WP2b stateful train (MED-HIGH).
3. WP3 registry (LOW-MED) — after FastWire lands.
4. WP4 service, windows-first, elevate last (MED-HIGH).
5. WP5 core Wave A -> B -> state-object -> Wave C (LOW -> HIGH).

Rule of one: one work package per PR train; service and registry never in the
same change; Wave C never mixed with behavior fixes.

