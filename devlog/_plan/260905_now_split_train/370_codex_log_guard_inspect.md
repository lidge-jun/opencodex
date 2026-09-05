# S12 L1 — Codex Log Guard inspection schema leaf

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Existing split implementation history; aggregate delivery pending. Original PR is not individually merged.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: `pure-move`. C3 boundary planning, docs-only delegated execution; the parent owns orchestration and goal state.
- Goal: reduce `src/codex/log-guard/inspect.ts` from 524 to an expected 392 lines by extracting exact SQLite schema recognition. Preserve every existing export and all runtime behavior.
- Non-goals: no metric/cache redesign, SQL changes, signature changes, filesystem writes during inspection, new dependencies, caller migration, dead-code cleanup, or function-length cleanup. Existing >50-line functions remain intact under the pure-move constraint.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below. No implementation commands or tests run in this drafting task.
- Stop: this layer has an open PR, exact-head CI/full-suite evidence, and the numbered accept criteria satisfied. Never merge. Stop the delegated drafting task after this document is checked.
- Escalation: source drift, changed exports, a new cycle, a leaf/residual >400 lines, >500 added+deleted source lines, weakened test coverage, or behavior changes require the parent's revised plan; do not expand the write scope.

Basis: docs HEAD `4cc219549`; source `origin/dev = 1362b1a38`. All source ranges below refer to that code basis. The working-tree file was byte-compared with `git show origin/dev:src/codex/log-guard/inspect.ts`. Input audit: `../260905_modular_debt_ledger/013_lane_providers_codex_oauth_routing.md`, section for this file, especially `inspect.ts:288` and `inspect.ts:399`.

## Symbol inventory

Ranges were checked with `sg run --lang ts --kind <function_declaration|interface_declaration|type_alias_declaration|lexical_declaration> --json=compact` and top-level `rg`. Imports are dependencies, not locally owned declarations; they are covered below. Consumer counts are distinct external files from `rg -l -w '<symbol>' src gui/src scripts tests`, excluding the declaration file and unrelated same-name bindings. Private symbols have zero external consumers; e.g. other `ColumnRow`, `pragmaNumber`, and `fileSize` declarations are not consumers. `R` means the residual original file; `S` means `src/codex/log-guard/inspect-schema.ts`.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| IMMUTABLE_READONLY_FLAGS | const | 12–12 | no | 0 | R |
| KNOWN_LOG_LEVELS | const Set | 13–13 | no | 0 | R |
| MAX_SYNCHRONOUS_METRICS_DATABASE_BYTES | const | 16–16 | no | 0 | R |
| CurrentLogColumn | interface | 18–24 | no | 0 | S |
| CURRENT_LOG_SCHEMA | const array | 29–42 | no | 0 | S |
| CURRENT_LOG_TABLE_SQL | const | 44–57 | no | 0 | S |
| CURRENT_LOG_INDEX_SQL | const object | 59–66 | no | 0 | S |
| CodexLogGuardCapabilityReason | type | 68–72 | yes | 0 | R |
| CodexLogGuardSchemaState | type | 74–79 | yes | 0 | R |
| CodexLogGuardCapability | type | 81–83 | yes | 0 | R |
| CodexLogGuardMetrics | interface | 85–96 | yes | 0 | R |
| CodexLogGuardInspection | interface | 105–125 | yes | 3 | R |
| ColumnRow | interface | 127–134 | no | 0 | S |
| SchemaObjectRow | interface | 135–135 | no | 0 | S |
| CountRow | interface | 136–136 | no | 0 | R |
| LevelRow | interface | 137–137 | no | 0 | R |
| TargetCountRow | interface | 138–138 | no | 0 | R |
| EstimatedBytesRow | interface | 139–139 | no | 0 | R |
| CanonicalTargetState | type | 141–141 | no | 0 | R |
| canonicalTargetState | function | 143–149 | no | 0 | R |
| fileSize | function | 151–158 | no | 0 | R |
| InspectionCacheEntry | type | 180–183 | no | 0 | R |
| inspectionCache | let | 185–185 | no | 0 | R |
| inspectionCacheKey | function | 187–215 | no | 0 | R |
| resetCodexLogGuardInspectionCache | function | 218–220 | yes | 1 | R |
| capabilityFor | function | 222–225 | no | 0 | R |
| unavailableInspection | function | 227–244 | no | 0 | R |
| normalizeDeclaredType | function | 246–248 | no | 0 | S |
| normalizeDefault | function | 250–252 | no | 0 | S |
| normalizeSchemaSql | function | 254–256 | no | 0 | S |
| sameColumns | function | 258–269 | no | 0 | S |
| hasCurrentLogsSchema | function | 283–286 | yes | 2 | S |
| hasCurrentLogsTable | function | 288–319 | no | 0 | S |
| pragmaNumber | function | 321–324 | no | 0 | R |
| readMetrics | function | 326–375 | no | 0 | R |
| inspectCodexLogs | function | 383–397 | yes | 4 | R |
| inspectCodexLogsUncached | function | 399–524 | no | 0 | R |

## Leaf partition

Structural map: `src/cli/codex-log-guard-doctor.ts:1`, `protection.ts:6`, `maintenance.ts:6`, and the two direct test files below → `inspect.ts` → `../paths`, filesystem/URL functions and SQLite. Intended edge: the same consumers → `inspect.ts` → `inspect-schema.ts` → SQLite **type only**. Blast radius: local Log Guard feature; CLI/API contracts do not change.

Decision: the size pressure and exact-schema seam justify one extraction. Reject no-op/configuration because neither reduces structural size; reject deletion because it changes the contract; reuse the existing canonical predicate, not a second validator. Reject moving the whole inspector/cache to a new facade because that increases churn and risks splitting cache ownership. Keep metrics in the residual: moving schema alone meets the limit. This is a compatibility re-export on the existing entry, not a new convenience barrel.

Naming follows sibling `src/codex/log-guard/path-safety.ts` and `sqlite-errors.ts`, and the purpose-qualified siblings `src/config/provider-validation.ts` and `src/server/responses/agent-task-recovery-cache.ts`. `rg --files` confirmed `inspect-schema.ts` does not already exist.

- New `src/codex/log-guard/inspect-schema.ts`, expected **136 lines**: all `S` symbols above. Move inclusive blocks **18–67, 127–135, 246–320**, including their comments/blanks: 50 + 9 + 75 = **134 moved lines**. Add the following import and one blank line. Export `ColumnRow` and `hasCurrentLogsTable` only from this leaf for the residual's existing query, and retain the export on `hasCurrentLogsSchema`; all other declarations stay leaf-private.

  ```ts
  import type { Database } from "bun:sqlite";
  ```

- Residual `src/codex/log-guard/inspect.ts`, expected **392 lines**: 524 − 134 + 2 binding/re-export lines below. All `R` symbols remain. Existing imports `statSync`, `join`, `resolve`, `pathToFileURL`, `Database`, `constants`, `getCodexHome`, `resolveCodexSqliteHome`, and `CodexSqliteHomeDeps` remain necessary. No `#b` layer is needed.

Total after split: 528 lines = 524 original + 4 import/re-export/blank lines. Expected source diff: 134 removed + 138 added = **272**, below 500. Formatting may vary, but actual counts must still satisfy the hard limits.

## Re-export block

Add exactly these statements to the original file (one physical line each for the count above):

```ts
export { hasCurrentLogsSchema } from "./inspect-schema";
import { hasCurrentLogsTable, type ColumnRow } from "./inspect-schema";
```

The import binds the names still used at original lines 483 and 485; the re-export binds nothing. `hasCurrentLogsSchema` has no residual local use. Keep local exported declarations for `CodexLogGuardCapabilityReason`, `CodexLogGuardSchemaState`, `CodexLogGuardCapability`, `CodexLogGuardMetrics`, `CodexLogGuardInspection`, `resetCodexLogGuardInspectionCache`, and `inspectCodexLogs`. Do not re-export the newly leaf-visible `ColumnRow` or `hasCurrentLogsTable` from the original path. The original export set remains exactly five types/interfaces and three functions.

## Module-level state and cycles

- `KNOWN_LOG_LEVELS` (`inspect.ts:13`): one read-only-in-practice Set owner, residual `inspect.ts`; stays with `readMetrics`.
- `inspectionCache` (`inspect.ts:185`): sole mutable memo owner, residual `inspect.ts`; `InspectionCacheEntry`, `inspectionCacheKey`, reset and lookup/publication remain colocated. Preserve the DB/WAL/SHM dev/ino/size/mtimeNs/ctimeNs identity at lines 187–215 and memoized `generatedAt` at 393–395.
- Schema array/object constants (`inspect.ts:29`, `:59`) move once to `inspect-schema.ts`; neither is mutated. SQL string at `:44` moves with them. Read-only flags at `:12` and 64 MiB threshold at `:16` remain residual constants.
- `byName` Map at `:307` is call-local, not a second module singleton. No top-level lock/WeakMap or other mutable owner exists.
- The leaf imports no residual types or facade. Moving `ColumnRow` together with the predicate avoids `inspect → schema → inspect`, including a type-only cycle. Current audit found no static cycle through this file; the proposed leaf has no project dependency, so it cannot add one. Check import and re-export edges, not just runtime value imports.
- Coupling stays functional for the predicate and sequential for query rows. Memoization's temporal behavior stays within one owner; no shared mutable cache API is introduced.

## Tests

Direct importer list from `rg -l 'log-guard/inspect' tests` (2 files), both **unchanged**:

- `tests/codex-integration/codex-log-guard-inspect.test.ts:17`.
- `tests/codex-integration/codex-log-guard-doctor.test.ts:4` (type import).

Direct source-text oracle readers: **none found**. Search covered full/segmented Log Guard paths and basename `inspect.ts`, followed by read-site inspection. `001_stale_check.md`'s basename heuristic reports one, but `tests/codex-integration/native-grok-toggle.test.ts:343` actually reads `src/grok/inspect.ts`; leave it unchanged, do not retarget it to Log Guard. No `retarget-to-leaf` or explicit `add-leaf-to-scan-list` action is needed. Generic import-graph traversal naturally reaches the new leaf through the re-export/import; never change protected roots in `tests/lab/core-lab-boundary.test.ts`.

Preserve runtime guards in `codex-log-guard-inspect.test.ts`: unknown schema `:189`, views `:209`, column metadata `:233`, table DDL `:267`, canonical indexes `:301`, unrelated triggers `:319`, zero writes `:173`, privacy `:139`, size gate `:120`, cache invalidation `:434`, cache reset `:460`, inode replacement `:471`. Preserve downstream protection's locked exact-schema check (`codex-log-guard-protection.test.ts:331`) and maintenance's schema refusal (`codex-log-guard-maintenance.test.ts:177`). No new test file/layout registration is required.

During implementation C, drive the moved schema guard red once: temporarily bypass the canonical-index comparison in the leaf; `requires every canonical Codex logs index` at `:301` must fail. Restore precisely that temporary change, then run the focused set green. Do not alter fixture assertions or claim a red run in this docs-only task.

## Verification

Future implementation gate, **not executed during drafting**. Run at the layer tip in its dedicated worktree:

```sh
bun run typecheck
bun test tests/codex-integration/codex-log-guard-*.test.ts tests/server/api-codex-log-guard*.test.ts
bun run privacy:scan
wc -l src/codex/log-guard/inspect-schema.ts src/codex/log-guard/inspect.ts
rg -l 'log-guard/inspect"|from "\./inspect"' src gui/src scripts tests
git diff --check
git diff --numstat dev...HEAD -- src/codex/log-guard
```

Focused domains are `codex-integration` and `server`; the wildcard is only the named Log Guard files, not a repository-wide suite. Baseline direct original-path importer count is **5 files** (3 source, 2 tests); retain the same importer set. Count files with `rg -l`, not physical import-block lines; `inspect-schema` is a different basename. Check the exact eight original exports and the leaf's one-way static edges. The conditional 002 core/Lab test is not triggered by this `src/codex`-only source change; if the scope expands into `src/server`, `src/router`, or `src/lib`, escalate and include that test without changing its roots.

Full suite only on the designated remote host, after the parent publishes this exact branch:

```sh
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-codex-log-guard-inspect && git checkout -q FETCH_HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15'
```

Record the remote checked-out SHA and actual test exit status/full result; a successful `tail` is not proof of a passing suite. Use pipeline-status preservation when executing. All checks must pass at the same PR head; collect the complete exact-head CI rollup. Do not run a full suite locally or rerun passing unchanged checks.

## Accept criteria

1. Source diff changes only the original file and `inspect-schema.ts`; declarations/bodies and comments move as specified, with only necessary module exports/imports added.
2. Actual new leaf and residual are each ≤400 lines; expected 136/392. Added+deleted source lines ≤500; no `#b` residual remains.
3. All 37 owned top-level declarations in the inventory have exactly one owner; all eight original exports resolve from `inspect.ts`; all five original-path consumer files are unchanged.
4. Exactly one `inspectionCache` and one `KNOWN_LOG_LEVELS` remain; the leaf imports neither `inspect.ts` nor another S12 entry.
5. The canonical-index guard has fresh red/restored-green evidence; focused tests, typecheck, privacy scan, remote full suite, and exact-head CI pass without weakening assertions.
6. PR base is `dev`, stack map/template sections are complete, and PR stays open/unmerged. No downstream layer is required for correctness.

## PR

Title: `refactor(codex): isolate log guard schema recognition (split S12 L1/3)`

Branch: `codex/split-codex-log-guard-inspect`. Base: `dev`. Closes: none.

Use `.github/PULL_REQUEST_TEMPLATE.md` with all **Summary**, **Verification**, and **Checklist** sections filled. Summary: exact schema extraction with unchanged inspection/mutation contract. Verification: actual commands, SHA-bound outcomes and guard evidence; never copy planned commands as completed. Scope remains pure move; no UI changes.

| # | PR | Layer | Base | Review focus |
|---|---|---|---|---|
| 3 | #<S12-L3> | codex/split-codex-log-guard-maintenance | codex/split-codex-log-guard-inspect | Compaction measurements |
| 2 | #<S12-L2> | codex/split-codex-log-guard-protection | codex/split-codex-log-guard-inspect | Owned trigger SQL/observation |
| 1 | #<S12-L1> | codex/split-codex-log-guard-inspect — this PR | dev | Exact schema recognition |

Review this layer's diff only. This layer's only parent is `dev`; changes to `dev` require rebasing/reverifying this layer per DEV-STACK-02. Protection and maintenance are independent children of inspection under STACK-INDEPENDENCE-01, not a linear chain. Merge parents before children only after separate authorization; this train never merges.

## P stale-check (2026-09-05, wp370)

origin/dev 3c920af5f; inspect.ts unchanged since 445742966 (524 lines); anchors 18/67/127/135/246/320/483/485 confirmed by sed. Base `dev` (S12 bottom; 380/390 chain on it). Executor rules: no bun run test; OCX_TEST_NO_QUEUE=1; CI hygiene requires a test change (extend tests/codex-integration/codex-log-guard-inspect.test.ts with a seam identity + zero-back-edge guard).

## A amendment (Tesla audit, GO-WITH-FIXES blockers=1 → folded)

"Unchanged consumer files" (Tests, accept criterion) applies to existing imports and assertions and to the five original-path importers; the one authorized change is an appended test in tests/codex-integration/codex-log-guard-inspect.test.ts (hasCurrentLogsSchema identity facade vs leaf; leaf has no ./inspect import). Size gate: 003 PURE-MOVE-SIZE-01. Audit-verified: 37/37 ranges; leaf = exactly the 12 S declarations, only a bun:sqlite type import; residual uses exactly ColumnRow (:483) and hasCurrentLogsTable (:485); 8 exports preserved; 5 importers; red-drive :301 depends on the moved comparison at :310.

## Execution record (B/C/D, 2026-09-05)

- Executor worktree: `/tmp/ocx-split-370.DfVIYS/wt` (branch `codex/split-codex-log-guard-inspect`, base origin/dev 593978db0; inspect.ts identical to 3c920af5f). Executor: gpt-6-astra high (Halley, 01a06f96-ba8f-7460-a1ae-a8ae4d0abaf1).
- Commits: 247dc38d7 (move: inspect-schema.ts 137, inspect.ts 392) and 5c1a398da (test: codex-log-guard-inspect.test.ts +11 — hasCurrentLogsSchema identity; leaf has no ./inspect import). Diff: 3 files, +150/−134. 5 original-path importers unchanged; git diff --check clean.
- Local gate: typecheck 0; focused (inspect, doctor, protection, maintenance) 48 pass / 0 fail; core-lab-boundary 17/0; privacy passed.
- Red-drive: canonical-index comparison bypassed → 'requires every canonical Codex logs index' :314 fails (compatible vs unsupported), restored 1/0.

- Adversarial diff review (Banach, gpt-6-astra high, 01a06f99-b6f2-79f3-9de7-ef3941e1d3fd): VERDICT: PASS (slices exact modulo separators, residual byte-exact, 8/8 exports, cache/levels single-owned at :128/:15, 3 files, test non-tautological).
- lidge full suite at 5c1a398da: SUITE_EXIT=1 — 18195 pass / **4 fail** / 16 skip. All four failures are **upstream dev breakage from 593978db0 (#3588 auto-activate quota reset windows)**, not this layer: management-route-registry ×3 (undeclared `GET /api/quota-resets` in src/server/management/quota-reset-routes.ts) and quota-reset-notify "a real rollover reaches a webhook". Reproduced identically on the pristine parent 593978db0 on lidge (same 4 fails, 0 in log-guard). This layer touches only src/codex/log-guard; its own focused suites are 48/0 and the layer diff cannot influence the route registry or quota notifier.

- PR: https://github.com/lidge-jun/opencodex/pull/3599 (base dev, head 5c1a398da). CI rollup at record time: =1 =5 CANCELLED=1 SKIPPED=1 SUCCESS=2. Expectation: the `test` shards will show the same 4 upstream failures as dev@593978db0 until #3588's follow-up lands; re-read CI after that before stacking 380/390 on this branch.
