# S12 L2 — Codex Log Guard owned-trigger leaf

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: `pure-move`. C3 boundary planning; this delegated task writes documentation only and does not own orchestration/goal state.
- Goal: reduce `src/codex/log-guard/protection.ts` from 489 to an expected 379 lines by moving trigger SQL and observation together, preserving status, mutation, and compensation behavior.
- Non-goals: no filter/policy changes, lock movement, transaction edits, type/signature renames, caller migration, dependency additions, or cleanup of currently unused declarations. Existing long functions remain intact under the pure-move constraint.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below; implementation verification is future work, not performed during drafting.
- Stop: independently passing layer, open PR, exact-head CI/full-suite evidence and all accept criteria. Never merge. The drafting task stops after document verification.
- Escalation: upstream/export drift, a new cycle, any behavior change, >400-line output or >500 added+deleted source lines, or a required file outside this plan. Parent decides any revised partition or scope.

Basis: docs HEAD `4cc219549`; source `origin/dev = 1362b1a38`. Line references are to this source, byte-compared with the working-tree file. Input audit: `../260905_modular_debt_ledger/013_lane_providers_codex_oauth_routing.md`, this file's section, anchored at `protection.ts:296` and `:399`.

## Symbol inventory

Ranges: ast-grep top-level function/interface/type/lexical declarations, cross-checked with `rg`. Import-only bindings are dependencies listed below. Counts: distinct external files found by `rg -l -w '<symbol>' src gui/src scripts tests`, excluding the owner and unrelated same-name bindings. Non-exported declarations have no external consumers; namesakes such as `ColumnRow`, `processRefusal`, or `CURRENT_LOG_COLUMNS` do not count. For the forwarded `CodexLogGuardMode`, count only consumers importing through this file (not directly through `policy.ts`). `R` = residual original; `T` = `src/codex/log-guard/protection-triggers.ts`.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| CodexLogGuardMode | type re-export | 20–20 | yes | 1 | policy.ts, forwarded by R |
| IMMUTABLE_READONLY_FLAGS | const | 22–22 | no | 0 | R |
| COMPAT_TRIGGER | const | 23–23 | no | 0 | T |
| QUIET_TRIGGER | const | 24–24 | no | 0 | T |
| OWNED_TRIGGER_NAMES | const array | 25–25 | no | 0 | T |
| CURRENT_LOG_COLUMNS | const array | 27–40 | no | 0 | R |
| targetOrDescendant | function | 73–76 | no | 0 | T |
| anyTargetOrDescendant | function | 78–80 | no | 0 | T |
| COMPAT_TRIGGER_SQL | const | 82–101 | no | 0 | T |
| QUIET_TRIGGER_SQL | const | 103–108 | no | 0 | T |
| SQL_BY_MODE | const object | 110–113 | no | 0 | T |
| CodexLogGuardObservedMode | type | 115–115 | yes | 0 | T |
| CodexLogGuardProtectionState | type | 116–116 | yes | 0 | R |
| CodexLogGuardProtectionSummary | interface | 118–122 | yes | 0 | R |
| CodexLogGuardStatus | type | 124–126 | yes | 4 | R |
| CodexLogGuardMutationError | type | 128–136 | yes | 0 | R |
| CodexLogGuardMutationResult | type | 138–140 | yes | 1 | R |
| CodexLogGuardProtectionDeps | interface | 142–152 | yes | 2 | R |
| TriggerRow | interface | 154–157 | no | 0 | T |
| ColumnRow | interface | 158–158 | no | 0 | R |
| OwnedTriggerSnapshot | interface | 159–159 | no | 0 | R |
| LockedMutationResult | type | 161–163 | no | 0 | R |
| normalizeSql | function | 165–167 | no | 0 | T |
| expectedSql | function | 169–171 | no | 0 | T |
| ownedModeForRow | function | 173–177 | no | 0 | T |
| queryReservedTriggers | function | 179–184 | no | 0 | T |
| observeTriggers | function | 186–193 | no | 0 | T |
| exactCurrentSchema | function | 195–201 | no | 0 | R |
| openReadOnly | function | 208–211 | no | 0 | R |
| openReadWrite | function | 213–217 | no | 0 | R |
| databasePathIsSafe | function | 219–227 | no | 0 | R |
| protectionSummary | function | 229–245 | no | 0 | R |
| inspectionDeps | function | 247–249 | no | 0 | R |
| getCodexLogGuardProtectionStatus | function | 251–274 | yes | 5 | R |
| successfulMutationStatus | function | 276–288 | no | 0 | R |
| processRefusal | function | 290–294 | no | 0 | R |
| mutateOwnedTrigger | function | 296–350 | no | 0 | R |
| restoreOwnedTriggers | function | 352–397 | no | 0 | R |
| performMutation | function | 399–468 | no | 0 | R |
| protectCodexLogs | function | 470–475 | yes | 3 | R |
| unprotectCodexLogs | function | 477–481 | yes | 3 | R |
| repairCodexLogGuardProtection | function | 483–489 | yes | 2 | R |

## Leaf partition

Structural map: doctor `src/cli/codex-log-guard-doctor.ts:5`, management `context.ts:3` and `storage-log-guard-routes.ts:13`, plus six test files → `protection.ts` → paths, inspection, lock, path-safety, SQLite error classifier, policy, processes. Intended edge: same callers → residual `protection.ts` → `protection-triggers.ts`; the leaf depends only on SQLite and policy **types**, not on the inspector or mutation owner. The residual continues importing the L1-compatible `./inspect` path. Blast radius: local feature.

Decision: extract one cohesive canonical trigger definition/recognition owner. No-op/configure cannot solve size; deletion changes behavior; reuse the existing SQL/predicates rather than inventing another trigger API. Reject moving lock-scoped mutation/rollback because that increases transaction-state coupling. Reject exporting only SQL while leaving normalization elsewhere because ownership checks and compensation must use the same definitions. The leaf's several internal exports are needed by existing production call sites, not solely for testing.

Use the existing same-directory, purpose-qualified convention: `path-safety.ts`, `sqlite-errors.ts`, and `src/server/responses/agent-task-recovery-cache.ts`. `rg --files` found no existing `protection-triggers.ts` owner.

- New `src/codex/log-guard/protection-triggers.ts`, expected **115 lines**, all `T` symbols above. Move blocks **23–26, 42–115, 154–157, 165–194** (4 + 74 + 4 + 30 = **112 lines**), retaining policy comments and SQL byte contents. Add two imports and one blank line:

  ```ts
  import type { Database } from "bun:sqlite";
  import type { CodexLogGuardMode } from "./policy";
  ```

  Export `SQL_BY_MODE`, `normalizeSql`, `ownedModeForRow`, `queryReservedTriggers`, `observeTriggers`, and the already-exported `CodexLogGuardObservedMode`. `TriggerRow` remains leaf-private; callers infer query results, while `OwnedTriggerSnapshot` remains the structurally compatible residual type. Other `T` symbols stay private.

- Residual `src/codex/log-guard/protection.ts`, expected **379 lines** = 489 − 112 + 2 new binding/re-export lines. All `R` symbols remain. Keep its existing filesystem/URL/SQLite, paths, inspect, lock, path-safety, sqlite-errors, policy, and processes imports. No `#b` layer is needed.

Total 494 = 489 original + 5 import/re-export/blank lines. Expected source diff 112 removed + 117 added = **229**, below 500. Multiline formatting is allowed only while actual line/diff limits stay satisfied.

## Re-export block

The original path retains this existing policy forwarding (no duplicate line) and gains only the observed-mode forwarding plus a local import:

```ts
export type { CodexLogGuardMode } from "./policy";
export type { CodexLogGuardObservedMode } from "./protection-triggers";
import { SQL_BY_MODE, normalizeSql, ownedModeForRow, queryReservedTriggers, observeTriggers, type CodexLogGuardObservedMode } from "./protection-triggers";
```

The first statement is equivalent to original line 20's `export { type CodexLogGuardMode } from "./policy"`; retaining that spelling also preserves the count. The existing local `CodexLogGuardMode` type import in lines 10–14 remains mandatory. The new import binds observed-mode references, status observation at `:263`, mutation at `:318`–336, and compensation at `:369`–385; the type re-export alone cannot do that.

Keep local exported declarations for `CodexLogGuardProtectionState`, `CodexLogGuardProtectionSummary`, `CodexLogGuardStatus`, `CodexLogGuardMutationError`, `CodexLogGuardMutationResult`, `CodexLogGuardProtectionDeps`, `getCodexLogGuardProtectionStatus`, `protectCodexLogs`, `unprotectCodexLogs`, and `repairCodexLogGuardProtection`. Preserve the original twelve-name export set (eight types including forwarded mode, four functions); do not forward new internal helper exports through the original path.

## Module-level state and cycles

- No top-level `let`, Map, Set, WeakMap, lock, or in-flight mutable state is created in this file. `OWNED_TRIGGER_NAMES` at `:25` and `SQL_BY_MODE` at `:110` move as single-owner lookup constants to the leaf. `COMPAT_TRIGGER`, `QUIET_TRIGGER`, both SQL strings, and their construction helpers move together in original initialization order.
- `CURRENT_LOG_COLUMNS` (`:27`) stays residual even though unused; deleting or merging its namesake in maintenance is not this pure move. Read-only flags at `:22` also stay residual.
- `unique` Set at `:191` moves with `observeTriggers` but remains call-local. The compensation Map at `:383`, DB handles and `transactionOpen` at `:300`/`:301` and `:356`/`:357`, and `locked`/`effectiveMode` at `:424`/`:429` stay per invocation in the residual.
- The lock remains owned by existing `lock.ts` and invoked by `performMutation`; hold it through trigger commit, desired-state write, and compensation. Preserve repair's mode resolution inside that same lock (`:431`–448).
- Keeping `CodexLogGuardObservedMode` in the residual while the leaf imported it would create a type-only `protection ↔ triggers` cycle. Move its definition to the leaf and re-export it. Leaf types depend on `policy.ts`, which does not import protection; no leaf → residual edge is allowed. Inspection remains downward through the stable L1 path; no maintenance edge is added.
- SQL/observation coupling is functional with one canonical definition owner. Transaction/config-write temporal coupling deliberately stays colocated; no common mutable state is introduced. No error handling or filesystem validation changes accompany the move.

## Tests

`rg -l 'log-guard/protection' tests` returns these six files, each **unchanged**:

- `tests/codex-integration/codex-log-guard-protection.test.ts:12`.
- `tests/codex-integration/codex-log-guard-coderabbit.test.ts:13`.
- `tests/codex-integration/codex-log-guard-status-zero-write.test.ts:7`.
- `tests/codex-integration/codex-log-guard-doctor-coderabbit.test.ts:4`.
- `tests/codex-integration/codex-log-guard-doctor-protection.test.ts:4`.
- `tests/server/api-codex-log-guard-protection.test.ts:7`.

Direct source-text oracle readers: **none found** after basename/full/segmented path searches and read-site filtering. `readFileSync` in `codex-log-guard-status-zero-write.test.ts:86` reads a fixture WAL, not protection source; keep it unchanged. There are no `retarget-to-leaf` or explicit `add-leaf-to-scan-list` actions. Graph scans follow imports automatically; do not edit protected Lab roots. No new test files or layout entries are planned.

Keep the protection tests for compat filters (`:110`), descendants (`:134`), Repair/Disable ordering (`:164`), quiet mode (`:194`), collisions (`:236`), drift (`:251`), selective removal (`:288`), rollback (`:301`), disable after schema change (`:311`), locked schema recheck (`:331`). Preserve multi-trigger compensation in `codex-log-guard-coderabbit.test.ts:185`, multi-trigger unprotect at `:164`, and both zero-write status tests (`codex-log-guard-status-zero-write.test.ts:53`, `:74`).

C-phase guard to drive red once: temporarily make the moved `targetOrDescendant` match only the exact target; the unchanged descendant-filter test at `codex-log-guard-protection.test.ts:134` must fail. Restore the temporary change and run the full focused set green. No such mutation or test run belongs to this drafting task.

## Verification

Future implementation, not executed here; dedicated layer worktree and exact tip:

```sh
bun run typecheck
bun test tests/codex-integration/codex-log-guard-*.test.ts tests/server/api-codex-log-guard*.test.ts
bun run privacy:scan
wc -l src/codex/log-guard/protection-triggers.ts src/codex/log-guard/protection.ts
rg -l 'log-guard/protection"' src gui/src scripts tests
git diff --check
git diff --numstat codex/split-codex-log-guard-inspect...HEAD -- src/codex/log-guard
```

Domains: `codex-integration` and `server`, limited to Log Guard paths. Original-path importer baseline: **9 files** = 3 source + 6 tests. Match the exact original basename so `protection-triggers` does not inflate the count. Verify all twelve old exports, not merely the value exports. Inspect import/re-export edges to confirm no leaf → protection path, including type edges. No server/router/lib implementation file is touched, so 002's conditional core/Lab test is not triggered; scope expansion requires escalation and that guard, with protected roots unchanged.

Remote full-suite command, parent-owned execution after publishing:

```sh
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-codex-log-guard-protection && git checkout -q FETCH_HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15'
```

Capture checked-out SHA and actual test exit status, preserving pipeline status; `tail` success is not a test result. Require a green complete exact-head CI rollup and remote full suite on that SHA. Never run full tests locally or defer this layer's checks to L3.

## Accept criteria

1. Only `protection.ts` and `protection-triggers.ts` change in the source diff; all 41 local declarations plus the existing policy type forwarding are accounted for.
2. New leaf/residual each ≤400 lines (expected 115/379), total source additions+deletions ≤500; no residual `#b` work remains.
3. All twelve original exports resolve from the old path; all nine original importer files remain unchanged. Leaf helpers are not newly re-exported through that path.
4. Trigger SQL, normalization, ownership detection, SQL construction order and selective deletion/compensation are unchanged. There is no duplicate SQL_BY_MODE owner or new cycle.
5. Fresh descendant-guard red/restored-green evidence and all per-layer typecheck, focused, privacy, remote-full-suite and exact-head CI gates pass.
6. PR base is the L1 branch, latest lower-layer commit is contained, all template sections/stack map are present, and the independently valid PR remains open/unmerged.

## PR

Title: `refactor(codex): isolate owned log guard trigger definitions (split S12 L2/3)`

Branch: `codex/split-codex-log-guard-protection`. Base: `codex/split-codex-log-guard-inspect`. Closes: none.

Fill `.github/PULL_REQUEST_TEMPLATE.md` **Summary**, **Verification**, and **Checklist**. Summary names the pure trigger extraction and preserved lock/rollback contract. Verification records actual SHA-bound outcomes, not this planned command list. Keep the security-sensitive checklist review explicit for unchanged SQL/mutation boundaries; no UI changes.

| # | PR | Layer | Base | Review focus |
|---|---|---|---|---|
| 3 | #<S12-L3> | codex/split-codex-log-guard-maintenance | codex/split-codex-log-guard-inspect | Compaction measurements |
| 2 | #<S12-L2> | codex/split-codex-log-guard-protection — this PR | codex/split-codex-log-guard-inspect | Owned trigger SQL/observation |
| 1 | #<S12-L1> | codex/split-codex-log-guard-inspect | dev | Exact schema recognition |

Depends on #<S12-L1>. Review this layer's diff only. Cascade/reverify this layer when its real parent `codex/split-codex-log-guard-inspect` changes (DEV-STACK-02). Maintenance is an independent sibling, not a child of protection (STACK-INDEPENDENCE-01). Merge parents before children only after separate authorization; this train never merges.
