# S21 L3/4 — Test runner selection leaves

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

Archetype: **pure-move**. Goal: reduce `scripts/test.ts` from 572 to approximately 268 lines by extracting environment creation, argument interpretation, and changed-run preflight. Non-goals: no parallelism/timing/lock changes, no CLI flag changes, no serial-list migration, no test-layout writer changes, no dependency installation policy changes, no new runner framework.

Mode: bounded docs-only architectural planning (C3; eventual environment/dependency-installation tooling receives C4 review care). Apply cxc-dev §1/§5 and cxc-dev-architecture; parent owns all orchestration and goal state. Verifier = `002_layer_map.md` → **Per-layer gate**, instantiated below. Stop this drafting task after this document; eventual layer stops only after its own exact-head verification and PR evidence. Escalate any behavioral change, hidden source reader, cycle, leaf >400, extra owner, or failure at the base. No merge.

Structural decision: existing mixed runner/selection/environment module forces the split. Reject deletion/configuration because it cannot preserve the interface; reject moving the serial table because its owner-specific source writer is already an external boundary. Reuse naming convention `scripts/test-layout/{schema,plan,move}.ts` as `scripts/test/{environment,arguments,changed-selection}.ts`; no generic helpers/index. Search evidence: `rg --files scripts`, `rg -n 'SERIAL_LANE_SOURCE|readFileSync' scripts/test-layout/move.ts`, and public-path/symbol searches below.

Current map: `tests/preload.ts:15` and `tests/ci-workflows/test-runner.test.ts:14` → test facade → `scripts/test-run-lock.ts`; `scripts/test-layout/move.ts:52` reads the facade text. Intended map: those same consumers → facade → three independent leaves, while facade → existing lock owner remains. Blast radius: test tooling and preload boundary; no product runtime changes. The original script remains executable and a compatibility boundary, not a new convenience barrel.

Budget note: 312 original lines move; literal addition+deletion count is ≥624 before bindings, above 002's 500-changed-line statement. Parent must approve the mechanical-move exception or expand topology before execution; no unauthorized fifth layer is introduced here.

## Symbol inventory

Basis: docs `4cc219549`, code `origin/dev 1362b1a38`; fresh source diff for all three S21 files was empty. All ranges refer to `origin/dev:scripts/test.ts`, not a future rebased file. Lane 016's `scripts/test.ts` record is the audit input.

Method: `sg run --lang ts --kind 'function_declaration,lexical_declaration,type_alias_declaration,interface_declaration,class_declaration' --json=compact scripts/test.ts`, retaining module declarations confirmed with column-zero `rg`. Consumer count is distinct direct public importer files with the symbol in their named import block (`rg -l` then `rg -w`); private bindings have zero external import consumers. Every one of 26 named non-import declarations follows; function locals/for-loop initializers are excluded.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `IsolatedTestEnvironment` | interface | 13–17 | yes | 0 | `test/environment.ts` |
| `createIsolatedTestEnvironment` | function | 19–68 | yes | 2 | `test/environment.ts` |
| `hasCliFlag` | function | 70–74 | no | 0 | `test/arguments.ts` |
| `DEFAULT_TEST_PARALLELISM` | const | 76–76 | no | 0 | `test/arguments.ts` |
| `BUN_TEST_OPTIONS_REQUIRING_VALUES` | const | 81–151 | no | 0 | `test/arguments.ts` |
| `ChangedRunPreflight` | interface | 153–157 | yes | 0 | `test/changed-selection.ts` |
| `changedComparisonRefs` | const | 159–159 | no | 0 | `test/changed-selection.ts` |
| `selectChangedComparisonRef` | function | 162–164 | yes | 1 | `test/changed-selection.ts` |
| `decodeOutput` | function | 166–168 | no | 0 | `test/changed-selection.ts` |
| `changedComparisonRef` | function | 170–181 | no | 0 | `test/changed-selection.ts` |
| `gitRefExists` | function | 183–195 | no | 0 | `test/changed-selection.ts` |
| `gitOutput` | function | 197–213 | no | 0 | `test/changed-selection.ts` |
| `inspectChangedRun` | function | 216–254 | yes | 1 | `test/changed-selection.ts` |
| `changedSelectionFailure` | function | 257–270 | yes | 1 | `test/changed-selection.ts` |
| `isFullSuiteRun` | function | 277–290 | no | 0 | `test/arguments.ts` |
| `resolveBunTestArgs` | function | 303–323 | yes | 1 | `test/arguments.ts` |
| `SERIAL_FULL_SUITE_FILES` | const | 327–334 | yes | 1 | original |
| `SerialLaneBasename` | type | 336–338 | no | 0 | original |
| `SERIAL_LANE_TIMEOUT_MS` | const | 339–343 | no | 0 | original |
| `BunTestLane` | interface | 345–349 | yes | 0 | original |
| `withoutParallelOverride` | function | 351–353 | no | 0 | original |
| `canUseSerialLanes` | function | 355–358 | no | 0 | original |
| `resolveBunTestPlan` | function | 361–379 | yes | 1 | original |
| `waitWithTimeout` | function | 381–395 | no | 0 | original |
| `runTestLane` | function | 397–459 | no | 0 | original |
| `ensureGuiDependencies` | function | 472–500 | yes | 1 | original |

Import declarations (binding redistribution; not new public symbols):

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `randomUUID` | import | 1–1 | no | 0 | original |
| `existsSync, mkdirSync, mkdtempSync, rmSync` | import | 2–2 | no | 0 | existsSync original; others environment |
| `homedir, tmpdir` | import | 3–3 | no | 0 | environment |
| `basename, join` | import | 4–4 | no | 0 | original; join also environment |
| `acquireTestRunLock, resolveWrappedTestRunLockPath, TEST_RUN_ID_ENV, TEST_RUN_LOCK_PATH_ENV, TEST_RUN_LOCK_TOKEN_ENV` | import | 5–11 | no | 0 | original, unchanged lock module |

Top-level execution statement `if (import.meta.main)` at 502–572 remains original; its local bindings are not module-level state. No leaf adds an entrypoint.

## Leaf partition

| New leaf | Symbols | Expected lines including imports | Own imports |
|---|---|---:|---|
| `scripts/test/environment.ts` | `IsolatedTestEnvironment`, `createIsolatedTestEnvironment` | 62 | `import { mkdirSync, mkdtempSync, rmSync } from "node:fs";`; `import { homedir, tmpdir } from "node:os";`; `import { join } from "node:path";` |
| `scripts/test/arguments.ts` | `hasCliFlag`, `DEFAULT_TEST_PARALLELISM`, `BUN_TEST_OPTIONS_REQUIRING_VALUES`, `isFullSuiteRun`, `resolveBunTestArgs` | 136 | none |
| `scripts/test/changed-selection.ts` | `ChangedRunPreflight`, `changedComparisonRefs`, `selectChangedComparisonRef`, `decodeOutput`, `changedComparisonRef`, `gitRefExists`, `gitOutput`, `inspectChangedRun`, `changedSelectionFailure` | 119 | none; existing Bun/TextDecoder globals |

Physical range accounting, including comments/blanks: environment 13–69 = 57; arguments 70–152 plus 272–324 = 136; changed-selection 153–271 = 119. Total moved = **312**. Residual expectation **268** = 572 − 312 + 8 net import/re-export/spacing budget. All leaves and residual ≤400; no #b required. These are budgets for a future move, to replace with actual `wc -l` measurements.

Keep all of 325–572 in the original: serial list/type/timeout map, lane type/planning, timeout/signal supervision, GUI dependency check, and entrypoint. `decodeOutput` moves with Git-output decoding and gets an internal leaf export because the retained `ensureGuiDependencies` also calls it (:494). This avoids a changed-selection → facade back-import; no duplicate decoder is created. No runtime dependency on the lock module is added to any leaf.

## Re-export block

Add these exact compatibility re-exports; existing original exports `SERIAL_FULL_SUITE_FILES`, `BunTestLane`, `resolveBunTestPlan`, and `ensureGuiDependencies` remain their current declarations.

```ts
export type { IsolatedTestEnvironment } from "./test/environment";
export { createIsolatedTestEnvironment } from "./test/environment";
export type { ChangedRunPreflight } from "./test/changed-selection";
export { selectChangedComparisonRef, inspectChangedRun, changedSelectionFailure } from "./test/changed-selection";
export { resolveBunTestArgs } from "./test/arguments";
```

Explicit residual local imports (independent of re-exports):

```ts
import { createIsolatedTestEnvironment } from "./test/environment";
import { inspectChangedRun, changedSelectionFailure, decodeOutput } from "./test/changed-selection";
import { hasCliFlag, DEFAULT_TEST_PARALLELISM, isFullSuiteRun, resolveBunTestArgs } from "./test/arguments";
```

Original built-in imports become `randomUUID` from `node:crypto`, `existsSync` from `node:fs`, and `basename, join` from `node:path`; retain all five existing lock imports from `"./test-run-lock"`. No residual `IsolatedTestEnvironment` or `ChangedRunPreflight` type import is needed; the entry uses `ReturnType<typeof inspectChangedRun>`.
Internal cross-leaf exports (`decodeOutput`, `hasCliFlag`, `DEFAULT_TEST_PARALLELISM`, `isFullSuiteRun`) are not re-exported from the original public path.

## Module-level state and cycles

- `BUN_TEST_OPTIONS_REQUIRING_VALUES`, origin `scripts/test.ts:81–151`: one Set owner, arguments leaf; never copied into lane planning.
- `DEFAULT_TEST_PARALLELISM` (:76): arguments leaf, imported by residual warning/planning code.
- `changedComparisonRefs` (:159): one array owner in changed-selection.
- `SERIAL_FULL_SUITE_FILES` (:327–334) and `SERIAL_LANE_TIMEOUT_MS` (:339–343): remain original, with the exact assignment spelling read by the layout mover.
- No module-level let, Map, WeakMap, timer, or lock instance. `lock` (:530) and lane timers (:383) remain invocation-scoped; no lock acquired when preload imports the facade.

Intended graph is facade → independent leaves; leaves have no local module imports. Existing facade → test-run-lock stays unchanged. In particular the decoder dependency is residual → changed-selection, never reversed. Coupling is functional; signal handling and lock release remain temporally coupled within the existing runner invocation. Preserve `process.once/off`, timeout ordering, inherited lock token values, cleanup timing, and home capture before environment overwrite. No circular type import or lazy-import workaround.

## Tests

Exact importer search `rg -l 'from ".*/scripts/test"' src gui/src scripts tests` returns:

- `tests/ci-workflows/test-runner.test.ts:14` — unchanged; all eight imported bindings still resolve.
- `tests/preload.ts:15` — unchanged; support module, not an extra test suite. Its real-home isolation happens at the same point.

Exact source-oracle/path inventory:

| Test / exact read or pin | Classification | Disposition |
|---|---|---|
| `tests/test-layout-tooling.test.ts:391` — `readFileSync(join(root, "scripts", "test.ts"), "utf8")` | Fixture's runner source, seeded at :328 and changed at :356; indirectly exercises real mover's source contract | unchanged; keep `SERIAL_FULL_SUITE_FILES` in original, no retarget |
| `tests/ci-workflows/test-runner.test.ts:381` — `repoPath("scripts", "test.ts")` passed to `Bun.spawnSync` at :379 | Executable-path pin, **not** a text read | unchanged |

No existing test directly reads the real `scripts/test.ts` implementation as text. The “40 text oracles” in 001 is a broad basename heuristic (`test.ts` also matches unrelated test filenames), not forty source readers of this file. Searches used `rg -n 'scripts/test|"scripts", "test.ts"' tests` plus basename/reader intersection and inspection. No existing test requires retarget-to-leaf or add-leaf-to-scan-list.

Non-test text consumer must be preserved: `scripts/test-layout/move.ts:20` names `scripts/test.ts`; :50–52 reads/parses its serial assignment; :145 rewrites it. Moving that assignment would require expanding the layer to the writer and its fixtures. This partition avoids that expansion.

Future guards in existing `tests/ci-workflows/test-runner.test.ts`: add each of the three leaves to a new no-facade-import/ownership scan and verify old-path value exports identify the same function as direct leaves. Drive export/cycle guards red once and restore. Drive the existing argument-required-value behavior guard red by temporarily removing `"--timeout"` from the moved Set, and restore. Retain tests' subprocess test at :369 and full-suite plan assertions at :173–188. Never run the full suite locally just to demonstrate the plan.

## Verification

Future commands at L3's exact tip; none were executed by this docs-only task:

```sh
bun run typecheck
bun test tests/ci-workflows/test-runner.test.ts tests/test-layout-tooling.test.ts tests/test-layout.test.ts
bun run privacy:scan
wc -l scripts/test/environment.ts scripts/test/arguments.ts scripts/test/changed-selection.ts scripts/test.ts
rg -l 'from ".*/scripts/test"' src gui/src scripts tests
rg -n 'SERIAL_FULL_SUITE_FILES = \[' scripts/test.ts
git diff --numstat origin/dev...HEAD -- scripts
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-test && git checkout -q FETCH_HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15'
```

This is 002's per-layer gate with ci-workflows + test-layout focused paths; core-Lab conditional gate is not triggered because no protected source family changes. Preserve its roots. Require the same two public importer paths and a zero-return-edge import graph including type/re-export edges. New leaves have no local imports, so the cycle check must confirm that negative fact rather than only typechecking.

Record remote exact SHA, full log, Bun exit status and test counts; the 002 sample's tail alone is insufficient, so use pipefail or capture status before tail. Additional `scripts/AGENTS.md` prepush gate runs **on lidge**, since `package.json:55` invokes the full suite; no local full-suite command. Explicit tooling/security review and Windows/macOS/Linux CI are required for review-ready. Tests and dependency installation are not authorized in this drafting turn.

## Accept criteria

1. All 26 named declarations and five original import declarations have one explicit disposition; moved spans total 312 original lines.
2. Three leaves and the residual each measure ≤400 (residual 268 expected); exported types/functions and serial table remain available at the original path.
3. `SERIAL_FULL_SUITE_FILES` remains a literal assignment in `scripts/test.ts`; layout mover and fixture read at test-layout-tooling.test.ts:391 need no retargeting.
4. No leaf imports the facade or acquires locks, starts subprocesses, changes environment, or installs dependencies merely on import.
5. Focused checks, negative guard receipts, typecheck, privacy, remote full suite/prepush and platform CI pass for the exact L3 head. CLI flags, default parallelism, selection rejection, signal exits, timeout and lock-cleanup behavior are unchanged.
6. Parent resolves the literal changed-line budget exception before execution; PR base is the latest L2 branch with no missing parent commits. No merge or release.

## PR

Title: `refactor(scripts): isolate test environment and selection (split S21 L3/4)`
Branch: `codex/split-test`.
Base: `dev`.
Closes: none.

Fill Summary, Verification, Checklist in `.github/PULL_REQUEST_TEMPLATE.md`. Review only this layer's diff. Stack navigation (only L2 depends on L1; merges require separate authorization):

| # | PR | Layer / branch | Base | Review focus |
|---|---|---|---|---|
| 4 | #TBD-S21-L4 | `codex/split-disposable-host-codex-service-composed-acceptance` | `dev` | Fixture owner; sentinel order |
| 3 | #TBD-S21-L3 | `codex/split-test` | `dev` | Environment and selection leaves |
| 2 | #TBD-S21-L2 | `codex/split-release-notes-b` | `codex/split-release-notes-a` | Tags, attribution, PR rendering |
| 1 | #TBD-S21-L1 | `codex/split-release-notes-a` | `dev` | Carry, commit fallback, polish |

Base: dev — no dependency on the layers below; no cascade obligation. No Git mutations in this delegation.
