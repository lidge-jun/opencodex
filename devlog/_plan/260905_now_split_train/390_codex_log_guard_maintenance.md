# S12 L3 — Codex Log Guard compaction measurement leaf

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: `pure-move`. C3 structural planning, documentation-only delegated execution; no parent orchestration/goal commands.
- Goal: reduce `src/codex/log-guard/maintenance.ts` from 403 to an expected 329 lines by extracting SQLite measurements/checkpoint checks while keeping the admission and compaction loop together.
- Non-goals: no budget changes, reclaim/report semantics changes, lock/transaction movement, file-identity changes, new dependencies, dead-code cleanup, or caller/signature changes. Existing long functions remain intact under the pure-move constraint.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below. All runtime checks are future implementation work, not run while drafting.
- Stop: standalone valid layer with open PR, exact-head CI/full-suite evidence and all accept criteria; never merge. This delegated task ends once this document is checked.
- Escalation: source drift, >400-line output, >500 added+deleted source lines, cycle, behavior change, export change, or necessary file outside the stated plan; parent must revise scope first.

Basis: docs HEAD `4cc219549`; source `origin/dev = 1362b1a38`. Line references are from the real source, byte-compared with the working tree. Input lane audit: `../260905_modular_debt_ledger/013_lane_providers_codex_oauth_routing.md`, maintenance section (`maintenance.ts:223` and `:367`).

## Symbol inventory

Ranges use ast-grep top-level declarations and `rg` cross-checks. Imported bindings are dependencies, listed below, not locally owned declarations. Counts are distinct external files from `rg -l -w '<symbol>' src gui/src scripts tests`, excluding the owner and unrelated same-name bindings. Private helpers such as `measure`, `runCompaction`, and `pragmaNumber` have zero external binding consumers despite lexical namesakes elsewhere. `R` = residual original file; `M` = `src/codex/log-guard/maintenance-measure.ts`.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| CURRENT_LOG_COLUMNS | const array | 12–25 | no | 0 | R |
| DEFAULT_BATCH_BYTES | const | 34–34 | no | 0 | R |
| DEFAULT_MAX_BYTES_PER_RUN | const | 35–35 | no | 0 | R |
| MAX_ITERATIONS | const | 36–36 | no | 0 | R |
| pagesForBytes | function | 39–42 | no | 0 | R |
| CompactStopReason | type | 44–44 | no | 0 | R |
| CodexLogGuardCompactionMeasure | interface | 46–53 | yes | 0 | M |
| CodexLogGuardCompactionReport | interface | 55–73 | yes | 0 | R |
| CodexLogGuardCompactionError | type | 75–83 | yes | 0 | R |
| CodexLogGuardCompactionResult | type | 85–91 | yes | 1 | R |
| CodexLogGuardMaintenanceDeps | interface | 93–105 | yes | 3 | R |
| ColumnRow | interface | 107–107 | no | 0 | R |
| CheckpointRow | interface | 108–112 | no | 0 | M |
| DatabaseFileIdentity | interface | 114–118 | no | 0 | R |
| databasePathIdentity | function | 120–130 | no | 0 | R |
| databasePathIsSafe | function | 132–134 | no | 0 | R |
| databasePathStillMatches | function | 136–145 | no | 0 | R |
| exactCurrentSchema | function | 147–152 | no | 0 | R |
| pragmaNumber | function | 154–160 | no | 0 | M |
| defaultQuickCheck | function | 162–167 | no | 0 | M |
| quickCheckIsOk | function | 169–171 | no | 0 | M |
| processRefusal | function | 173–179 | no | 0 | R |
| checkpointFull | function | 181–193 | no | 0 | M |
| measure | function | 195–221 | no | 0 | M |
| runCompaction | function | 223–365 | no | 0 | R |
| compactCodexLogs | function | 367–403 | yes | 3 | R |

## Leaf partition

Structural map: `src/server/management/context.ts:4`, `storage-log-guard-routes.ts:5`, and three test files below → `maintenance.ts` → paths, user-identity, inspect, lock, path-safety, sqlite-errors, processes, filesystem and SQLite. Intended edge: same consumers → residual `maintenance.ts` → `maintenance-measure.ts` → filesystem and SQLite type. The residual continues using the L1-compatible `./inspect` path. Blast radius: local Log Guard feature; no API change.

Decision: extract the measurement/checkpoint sub-seam of the audited compaction loop, not the whole transaction. Reject no-op/configuration because they do not reduce size; reject deleting the unused column declarations just to cross 400 because that is cleanup, not the agreed split. Reuse existing helper bodies. Reject moving `runCompaction` alone because it would require a much larger dependency/type boundary and more churn. This split moves the lowest-consumer helpers and one unconsumed public measure type first; no later part is required.

Naming uses the existing same-directory purpose-qualified convention (`path-safety.ts`, `sqlite-errors.ts`) and parallels `src/server/responses/agent-task-recovery-cache.ts`. `rg --files` found no `maintenance-measure.ts`; keep the measurement-specific `pragmaNumber` separate from inspection's namesake because their error behavior and signatures differ.

- New `src/codex/log-guard/maintenance-measure.ts`, expected **79 lines**: all `M` symbols. Move inclusive blocks **46–54, 108–113, 154–172, 181–222**, including blanks/comments: 9 + 6 + 19 + 42 = **76 moved lines**. Add these two imports and one blank line:

  ```ts
  import { statSync } from "node:fs";
  import type { Database } from "bun:sqlite";
  ```

  Export existing `CodexLogGuardCompactionMeasure` and the production-used helpers `pragmaNumber`, `defaultQuickCheck`, `quickCheckIsOk`, `checkpointFull`, `measure`. `CheckpointRow` remains private.

- Residual `src/codex/log-guard/maintenance.ts`, expected **329 lines** = 403 − 76 + 2 new import/re-export lines. All `R` symbols remain. Remove only `statSync` from its first import (retain `lstatSync`, `realpathSync`). Keep `Database`, `sqliteConstants`, paths, user-identity, inspect, lock and lock type, path-safety, sqlite-errors, processes and process type imports. No `#b` follows.

Total 408 = 403 original + 5 binding/import/blank lines. Source diff estimate including the changed filesystem import is 77 removed + 82 added = **159**, below 500. Formatting may vary only within the actual line/diff limits.

## Re-export block

Add these exact one-line statements to the original module:

```ts
export type { CodexLogGuardCompactionMeasure } from "./maintenance-measure";
import { pragmaNumber, defaultQuickCheck, quickCheckIsOk, checkpointFull, measure, type CodexLogGuardCompactionMeasure } from "./maintenance-measure";
```

The local measure type binds the residual report interface at original lines 57–58; the helper imports bind the existing calls in `runCompaction`. Re-export alone binds neither. Keep local exported declarations for `CodexLogGuardCompactionReport`, `CodexLogGuardCompactionError`, `CodexLogGuardCompactionResult`, `CodexLogGuardMaintenanceDeps`, and `compactCodexLogs`. Original export set stays five types/interfaces plus one function. Do not re-export the newly leaf-visible helpers from the old path.

## Module-level state and cycles

- No top-level mutable `let`, Map, Set, WeakMap, lock, DB handle or in-flight owner exists in maintenance. `CURRENT_LOG_COLUMNS` at `:12` is an existing read-only tuple retained even though unused; no deduplication with protection's namesake.
- `DEFAULT_BATCH_BYTES` (`:34`), `DEFAULT_MAX_BYTES_PER_RUN` (`:35`), and `MAX_ITERATIONS` (`:36`) stay in the residual with `pagesForBytes` and the loop. Byte budgets and iteration count are unchanged.
- `db`, `probeOpen`, `reportBusyPartial` (`:227`–229), counters (`:271`–274), `finish` (`:276`) and `locked` (`:383`) remain call-local in the residual, not moved into module state. Existing `lock.ts` is the sole lock owner. Keep process rechecks before and inside the lock and the identity recheck immediately after open (`:231`–240).
- Leaf owns `CodexLogGuardCompactionMeasure` and `CheckpointRow`. Importing the measure type back from `maintenance.ts` would form a type-only cycle; move it with the helpers and re-export instead. The leaf has no project dependency, so it cannot add a project cycle. No leaf → maintenance/inspect/protection edge, no dynamic import workaround.
- Measurement is functional/sequential coupling. Temporal ordering remains in `runCompaction`: schema/auto-vacuum admission, quick-check, write-lock probe, FULL checkpoint, bounded vacuum batches, final measurement/quick-check. `checkpointFull` can write checkpoint state but is called at exactly the original sites with the original handle; moving its definition must not move execution or resource ownership.

## Tests

`rg -l 'log-guard/maintenance' tests` returns these three files, all **unchanged**:

- `tests/codex-integration/codex-log-guard-maintenance-coderabbit.test.ts:16` (static import).
- `tests/codex-integration/codex-log-guard-maintenance.test.ts` (dynamic imports at `:125`, `:149`, `:162`, `:178`, `:194`, `:211`, `:221`, `:241`, `:259`, `:276`, `:294`; preserve all).
- `tests/server/api-codex-log-guard-compact.test.ts:7` (type import).

Direct source-text oracle readers: **none found** by basename/full/segmented path search plus read-site filtering. Dynamic import path pins above execute the module rather than reading its source; unchanged original-path exports satisfy them. No `retarget-to-leaf` or explicit `add-leaf-to-scan-list` action is needed. Generic import-graph scans reach the leaf automatically. No new test file/layout registration; protected Lab roots remain untouched.

Preserve runtime guards in `codex-log-guard-maintenance.test.ts`: row/trigger preservation `:124`, no-op `:148`, incremental-only `:161`, unknown schema `:177`, process/lock refusals `:193`/`:210`, pre/post quick checks `:220`/`:240`, per-run budget `:258`, real-page-size budget `:275`, logical vs physical reporting `:293`. Preserve coderabbit regressions for replacement identity `:97`, second process check `:115`, iteration budget `:131`, initial busy checkpoint `:147`, committed-batch partial success `:174`, thrown busy partial success `:221`.

C-phase red guard: temporarily make the moved `quickCheckIsOk` always return true. The unchanged pre-maintenance quick-check test at `codex-log-guard-maintenance.test.ts:220` must fail. Restore the exact temporary change and run focused checks green. Do not execute tests or mutations during this documentation task.

## Verification

Future implementation in the dedicated layer worktree, not run here:

```sh
bun run typecheck
bun test tests/codex-integration/codex-log-guard-*.test.ts tests/server/api-codex-log-guard*.test.ts
bun run privacy:scan
wc -l src/codex/log-guard/maintenance-measure.ts src/codex/log-guard/maintenance.ts
rg -l 'log-guard/maintenance"' src gui/src scripts tests
git diff --check
git diff --numstat codex/split-codex-log-guard-inspect...HEAD -- src/codex/log-guard
```

Focused domains `codex-integration` and `server`, bounded to Log Guard filenames. Baseline **5 direct importer files** = 2 source + 3 tests, counting dynamic imports once per file; retain the same set and all six original exports. Match the original basename exactly so `maintenance-measure` is not mistaken for an old-path consumer. Inspect all import/re-export edges: the leaf has only built-in imports and no project return path. With only `src/codex` source touched, 002's conditional server/router/lib core-Lab test is not triggered; an expansion triggers escalation and that test without root edits.

Remote full suite after parent publication, never locally:

```sh
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-codex-log-guard-maintenance && git checkout -q FETCH_HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15'
```

Record checked-out SHA and real `bun run test` exit status with pipeline-status preservation; success of `tail` alone is insufficient. Require remote full suite and complete exact-head CI rollup green on the PR head. This layer is independently gated even though it is the stack top; do not rerun passing checks on unchanged code.

## Accept criteria

1. Source diff is limited to `maintenance.ts` and `maintenance-measure.ts`; all 26 declarations are assigned exactly once and bodies/signatures are unchanged apart from necessary module exports/imports.
2. Leaf/residual each ≤400 lines (expected 79/329); source diff additions+deletions ≤500; no `#b` layer or over-400 residual remains.
3. All six existing exports remain importable from maintenance; all five original-path consumer files and eleven dynamic import sites remain unchanged.
4. No duplicated type, singleton or import cycle. Database/lock ownership, checkpoint execution order, identity checks, budgets, partial-success/error reports and quick-check behavior are preserved.
5. Quick-check guard has fresh red/restored-green proof; typecheck, focused tests, privacy scan, remote full suite and complete exact-head CI pass.
6. PR is based on L2, contains the current parent commit, includes template/stack map evidence, stands alone for review, and remains open/unmerged.

## PR

Title: `refactor(codex): isolate log guard compaction measurements (split S12 L3/3)`

Branch: `codex/split-codex-log-guard-maintenance`. Base: `codex/split-codex-log-guard-inspect`. Closes: none.

Fill `.github/PULL_REQUEST_TEMPLATE.md` **Summary**, **Verification**, **Checklist**. Explain the measurement extraction and unchanged compaction/admission semantics; report actual SHA-bound checks and guard evidence, not planned work as completed. Explicitly review the unchanged checkpoint/foreign-database boundary in the checklist. No UI changes.

| # | PR | Layer | Base | Review focus |
|---|---|---|---|---|
| 3 | #<S12-L3> | codex/split-codex-log-guard-maintenance — this PR | codex/split-codex-log-guard-inspect | Compaction measurements |
| 2 | #<S12-L2> | codex/split-codex-log-guard-protection | codex/split-codex-log-guard-inspect | Owned trigger SQL/observation |
| 1 | #<S12-L1> | codex/split-codex-log-guard-inspect | dev | Exact schema recognition |

Depends on #<S12-L1>. Review this layer's diff only. Cascade/reverify this layer when its real parent `codex/split-codex-log-guard-inspect` changes (DEV-STACK-02). Protection is an independent sibling, not this layer's parent (STACK-INDEPENDENCE-01). Merge parents before children only after separate authorization; this train never merges.
