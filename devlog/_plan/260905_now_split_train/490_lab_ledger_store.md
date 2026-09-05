# 490 — S15 L2/5: src/lab/ledger/store.ts

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: `pure-move`; C3 architecture planning, docs-only bounded delegation. cxc-dev §1/§5 and cxc-dev-architecture apply. Parent alone owns orchestration, loop and goal state.
- Goal: isolate ledger lock ownership, with every original public export and behavior preserved.
- Non-goals: no behavior fixes, new validation, renamed symbols, signature changes, new dependencies, public API expansion, core activation changes, releases or merges. This document plans implementation; this drafting task changes no source and runs no tests.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below; full tests only on `ssh lidge`, never locally.
- Stop: independent layer-tip verification and green exact-head CI evidence recorded, with the layer PR open; do not merge. Stop before implementation if a stated escalation is unresolved.
- Escalation: source drift, unexpected oracle coupling, new cycle, public export loss, changed state lifetime, any scope expansion, or the size-budget conflict below goes to the parent. Do not add a sixth stack layer or edit 002 here.
- Basis: docs HEAD `4cc219549`; verified source `origin/dev = 1362b1a3841b4de20177e5d65865a513dd7936c4`. All source anchors in this document refer to that revision. `git show origin/dev:src/lab/ledger/store.ts` matches the working file byte-for-byte.
- Prior audited seam: `devlog/_plan/260905_modular_debt_ledger/016_lane_cli_storage_usage_update_lab_scripts.md:403`. Read together with 000, 001, 002; actual consumer/oracle evidence below supersedes the approximate basename-based counts in 001.

Structural decision before implementation: Current: projection/rebuild.ts:15, observe/from-conformance.ts and fabric/observe.ts:15 consume store; store imports events/validate, digest, paths and filesystem built-ins (1–20). Chosen: move the complete private lock subsystem (34–220) to a kebab/single-concern sibling, retaining append, replay and both public interfaces. Rejected: extracting lock acquisition alone leaves release/recovery split across owners; moving replay too is unnecessary for the size target. Functional callback coupling retains the existing lock lifetime.

## Symbol inventory

Measured by `sg run --lang ts --kind 'function_declaration,interface_declaration,type_alias_declaration,lexical_declaration' --json=compact src/lab/ledger/store.ts`, matched to column-zero declarations in the pinned source. Nested declarations are excluded. Ranges include declaration syntax through its closing line, not preceding comments.

Consumers are distinct direct import/re-export files across `src gui/src scripts tests`, found with `rg -l` path/symbol searches and verified against the actual import binding. A wildcard re-export counts once for every public symbol; a dynamic namespace import counts for runtime exports, not erased types. Private declarations have zero external consumers, even if unrelated same-named declarations occur elsewhere. Transitive barrel clients are covered by the Lab domain gate, not double-counted. Total direct module consumers: **10**.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| LedgerStore | interface | 22–26 | yes | 1 | src/lab/ledger/store.ts |
| LedgerMutationContext | interface | 28–32 | yes | 1 | src/lab/ledger/store.ts |
| LEDGER_LOCK_STALE_MS | const | 34–34 | no | 0 | src/lab/ledger/lock.ts |
| LEDGER_LOCK_WAIT_MS | const | 35–35 | no | 0 | src/lab/ledger/lock.ts |
| LedgerLockMeta | interface | 37–41 | no | 0 | src/lab/ledger/lock.ts |
| sleepSyncMs | function | 44–46 | no | 0 | src/lab/ledger/lock.ts |
| readLedgerLockMeta | function | 49–64 | no | 0 | src/lab/ledger/lock.ts |
| isLockHolderAlive | function | 67–77 | no | 0 | src/lab/ledger/lock.ts |
| isLedgerLockStale | function | 80–90 | no | 0 | src/lab/ledger/lock.ts |
| writeLedgerLockMeta | function | 93–107 | no | 0 | src/lab/ledger/lock.ts |
| discardUninitialisedLedgerLock | function | 110–121 | no | 0 | src/lab/ledger/lock.ts |
| releaseLedgerLock | function | 124–136 | no | 0 | src/lab/ledger/lock.ts |
| recoverStaleLedgerLock | function | 146–177 | no | 0 | src/lab/ledger/lock.ts |
| tryAcquireLedgerLock | function | 180–207 | no | 0 | src/lab/ledger/lock.ts |
| withLedgerLock | function | 210–220 | no | 0 | src/lab/ledger/lock.ts |
| appendValidatedLabEvent | function | 223–241 | no | 0 | src/lab/ledger/store.ts |
| isThenable | function | 243–247 | no | 0 | src/lab/ledger/store.ts |
| withLedgerMutation | function | 255–298 | yes | 5 | src/lab/ledger/store.ts |
| appendLabEvent | function | 301–305 | yes | 1 | src/lab/ledger/store.ts |
| appendLabEventIfAbsent | function | 311–313 | yes | 2 | src/lab/ledger/store.ts |
| processLine | function | 315–367 | no | 0 | src/lab/ledger/store.ts |
| processBufferedLines | function | 369–421 | no | 0 | src/lab/ledger/store.ts |
| replayLabLedger | function | 427–515 | yes | 5 | src/lab/ledger/store.ts |
| openLedgerStore | function | 517–528 | yes | 1 | src/lab/ledger/store.ts |
| defaultLedgerPath | function | 530–532 | yes | 1 | src/lab/ledger/store.ts |

Direct edge evidence (including public re-exports):

- `src/lab/index.ts:9` — *.
- `src/lab/observe/from-conformance.ts:20` — withLedgerMutation.
- `src/lab/observe/from-live.ts:8` — withLedgerMutation.
- `src/lab/ledger/purge.ts:22` — withLedgerMutation.
- `src/lab/projection/rebuild.ts:15` — replayLabLedger.
- `src/lab/fabric/observe.ts:15` — withLedgerMutation.
- `src/lab/public/operator.ts:1` — replayLabLedger.
- `tests/lab/lab-evidence-ledger.test.ts:34` — appendLabEventIfAbsent.
- `tests/lab/lab-public-review-fixes.test.ts:12` — replayLabLedger.
- `tests/lab/lab-live-probe.test.ts:13` — replayLabLedger.

Import declarations are not new owners: their exact leaf/residual binding allocations are given below. No default export exists.

## Leaf partition

Reuse the existing same-directory sibling convention: `events/limits.ts`, `events/errors.ts`, `ledger/artifact-refs.ts`, `artifacts/secure-fs.ts`, `fabric/producer-protocol.ts`. The five source directories and proposed names were inspected with `rg --files`; none of the new paths exists at the pinned source. No new index/barrel, generic utils module, package or directory is needed. The original paths are compatibility boundaries explicitly retained by the split-train contract, not new internal convenience barrels.

Move complete source slices with their inline/leading comments as listed; only add the listed imports, named re-exports and leaf-local export modifiers needed by other leaves/the residual. Never re-export formerly private implementation helpers from the original public path.

### src/lab/ledger/lock.ts

- Original slices: `src/lab/ledger/store.ts:34–220`.
- Symbols: `LEDGER_LOCK_STALE_MS`, `LEDGER_LOCK_WAIT_MS`, `LedgerLockMeta`, `sleepSyncMs`, `readLedgerLockMeta`, `isLockHolderAlive`, `isLedgerLockStale`, `writeLedgerLockMeta`, `discardUninitialisedLedgerLock`, `releaseLedgerLock`, `recoverStaleLedgerLock`, `tryAcquireLedgerLock`, `withLedgerLock`.
- Expected lines: **192** = 187 moved lines + 5 import/header-separator lines + 0 inter-slice separators; ≤400.
- Additional leaf-only exports for existing cross-partition calls: `withLedgerLock`.
- Own imports:

```ts
import { closeSync, constants as fsConstants, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { LabValidationError } from "../events/validate";
```

Residual `src/lab/ledger/store.ts`: **333 expected lines**. Retained declarations: `LedgerStore`, `LedgerMutationContext`, `appendValidatedLabEvent`, `isThenable`, `withLedgerMutation`, `appendLabEvent`, `appendLabEventIfAbsent`, `processLine`, `processBufferedLines`, `replayLabLedger`, `openLedgerStore`, `defaultLedgerPath`.

Line accounting: 532 logical source lines − 187 moved lines − 20 original import/header lines + 8 explicit import/re-export lines = 333. The inventory's 531 is `wc -l`: the original lacks a trailing newline and has 532 logical lines. Keep formatting compact as shown; extra formatting lines must still fit the 400-line gate. No residual exceeds 400; no #b layer is required for file size.

Changeset accounting: 187 original lines move; raw additions+deletions for the move alone are 374, before import glue. This move is below 500 raw changed lines before glue; check final per-layer numstat, including tests, before PR readiness. Escalate if it exceeds 500.

## Re-export block

No public declaration is moved, so the exact re-export addition is the empty block. Do not add `export { withLedgerLock } from "./lock"`: that would widen the public surface.

LedgerStore, LedgerMutationContext, withLedgerMutation, appendLabEvent, appendLabEventIfAbsent, replayLabLedger, openLedgerStore and defaultLedgerPath remain exported declarations.

Explicit local imports for the residual (replace the original import block); re-export statements bind nothing locally:

```ts
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { jcsStringify } from "../digest";
import { MAX_SERIALIZED_EVENT_BYTES } from "../constants";
import type { LabEvent, LedgerCorruption, ReplayResult } from "../events/types";
import { LabValidationError, validateLabEvent } from "../events/validate";
import { ensureLabDirs, labLedgerPath } from "../paths";
import { withLedgerLock } from "./lock";
```



## Module-level state and cycles

There is no module-level let, Map, Set, WeakMap, wait buffer or live lock handle. `LEDGER_LOCK_STALE_MS` (34) and `LEDGER_LOCK_WAIT_MS` (35) move to lock.ts as private constants; `LedgerLockMeta` (37–41) is owned there. Disk lock and recovery mutex acquisition/release (146–220) move together. File descriptors, random ownership tokens and deadlines remain per-call. The transaction's `active` closure (260–296) remains in store.ts; replay's seenIds Set (449) remains per replay.
Current coupling is temporal lock → callback → finally release, expressed by the existing synchronous callback. New direction is store → lock → event validation boundary; lock never imports store, calls replay, or owns a second mutation gate. Splitting replay is unnecessary to meet 400 lines and would raise churn; it remains with the append/mutation façade. Do not substitute independent lock instances or alter timeout, stale-owner, recovery-mutex, token-match or cleanup behavior.

Existing lane evidence found no cycle through this file. Recheck the concrete resolved graph at implementation tip, including type-only edges; typecheck alone does not prove acyclicity. This plan introduces only the directed edges above. Do not change protected core roots, turn startServer async, or add activation imports into them.

## Tests

Direct import/dynamic-import test `rg -l` list, all **unchanged** at their original import path:

- `tests/lab/lab-live-probe.test.ts` — unchanged (import at 13).
- `tests/lab/lab-public-review-fixes.test.ts` — unchanged (import at 12).
- `tests/lab/lab-evidence-ledger.test.ts` — unchanged (import at 34).

Discovery commands (run across all tests, not just tests/lab):

```sh
rg -l 'src/lab/ledger/store' tests --glob '*.ts'
rg -n 'src/lab/ledger/store|store\.ts' tests --glob '*.ts'
rg -n 'readFileSync|Bun\.file|readFile\(|source\(' tests --glob '*.ts'
```

Dedicated source-text readers of this file: **none found**. No retarget-to-leaf or add-leaf-to-scan-list is required for a dedicated source oracle. The three direct test files above import runtime exports. The `store.ts` basename hits in other domains read different stores; 001's “3 text oracles” is not three reads of this ledger source. Do not retarget those unrelated tests.
The generic `tests/lab/core-lab-boundary.test.ts` reads traversed source at **69**, protected roots at **278/336**, and the server composition source at **355**. It reports the first edge into Lab before traversing that target, so these Lab leaves are not dedicated source-text inputs on a successful run. Disposition: **unchanged**, no scan-list addition, never edit `PROTECTED` (20–28). Include its existing negative-fixture cases in the implementation gate.

Additional transitive-barrel/behavioral coverage: `tests/lab/lab-ledger-mutation-lock.test.ts` — unchanged; `tests/lab/lab-private-file-durability.test.ts` — unchanged. Run `tests/lab` for all indirect callers.

Guards to drive red once during implementation (temporary mutations must be restored before committing):

Drive the existing lock-wait case red once with a temporary bypass of the moved lock boundary (`tests/lab/lab-ledger-mutation-lock.test.ts:134`), then restore. Keep dead-owner recovery (152), async callback rejection/context invalidation (185), artifact publication under the same lock (208), and purge serialization (238). Run the unchanged bounded-line and UTF-8 replay cases at `tests/lab/lab-evidence-ledger.test.ts:978,991` even though replay stays in place.

No tests or red mutations were run while drafting this plan; these are executor obligations.

## Verification

Instantiate `002_layer_map.md` Per-layer gate in the dedicated layer worktree, not this docs worktree:

```sh
bun run typecheck
bun test tests/lab/lab-ledger-mutation-lock.test.ts tests/lab/lab-evidence-ledger.test.ts tests/lab/lab-live-probe.test.ts tests/lab/lab-public-review-fixes.test.ts tests/lab/lab-private-file-durability.test.ts
bun test tests/lab
bun run privacy:scan
bun test tests/lab/core-lab-boundary.test.ts
wc -l src/lab/ledger/lock.ts src/lab/ledger/store.ts
rg -n 'lab/ledger/store|from "./store"' src gui/src scripts tests
git diff --check
git diff --numstat codex/split-lab-events-validate...HEAD
# Full repository suite: remote only, exact branch tip; pipefail preserves failures.
ssh lidge 'bash -o pipefail -c "cd ~/ocx-ci/opencodex && git fetch origin codex/split-lab-ledger-store && git checkout -q FETCH_HEAD && git rev-parse HEAD && bun install --frozen-lockfile && bun run test 2>&1 | tail -15"'
```

Required outcome: all local gates exit 0; focused/domain tests have zero failures; every leaf and residual ≤400. The boundary test is included explicitly even though no protected source is edited. Confirm the remote printed SHA equals the layer tip and save the full exit status plus test totals; the tail alone is not proof. Full suite remains remote-only.

Compare resolved direct consumer bindings against the 10-file baseline above (raw basename grep is only a candidate search and can include unrelated modules). Leaf names matching the search are not new original-path consumers. Existing public callers must not need migration.  Use the already available parser/import-graph mechanism, or a read-only resolver, to report no cycles containing this residual or any new leaf, including type edges; do not install a new analyzer just for this split. Verify moved declaration bodies are identical to origin/dev after stripping only the newly required export modifiers, and inspect `git diff --color-moved` for accidental behavior edits.

For PR readiness, record exact-head CI (Linux, macOS, Windows) and review status separately from local checks. No tests, typecheck, privacy scan or remote suite have been executed in this docs-only delegation.

## Accept criteria

1. Exactly this layer's original source plus the listed 1 new leaves and necessary existing-test adjustments are changed at implementation time; no other S15 file is implemented in this PR.
2. The complete inventory above has exactly one implementation/type owner per declaration; all original public names resolve from `src/lab/ledger/store.ts`, with no newly public private helper.
3. Every moved body, constant initializer, comment-backed order and signature matches the pinned source; only import/export plumbing changes.
4. Leaf line counts are 192 for `src/lab/ledger/lock.ts` (or verified formatted equivalents ≤400); residual is approximately 333, always ≤400. No deferred >400 residual.
5. State owners and operation lifetimes match the state section; resolved import graph has no cycle involving the partition.
6. Direct test imports and all source-oracle dispositions are applied exactly as listed; named guards have recorded red→restored-green evidence, without weakening assertions or editing protected roots.
7. Every instantiated local gate and exact-tip remote suite succeeds; source/consumer inventory and privacy scan are recorded. No repository-wide local suite.
8. Final raw changed-source-line count stays ≤500 or the parent explicitly resolves the size escalation.
9. PR base is `codex/split-lab-events-validate`, stack map contains all five layers, and exact-head CI is green. No merge is performed.

## PR

Title: `refactor(lab-ledger): isolate ledger lock ownership (split S15 L2/5)`

Branch: `codex/split-lab-ledger-store`. Base: `codex/split-lab-events-validate`. Closes: **none**.

Use every section of `.github/PULL_REQUEST_TEMPLATE.md` (Summary, Verification, Checklist). Include this full DEV-STACK-03 map; placeholder PR numbers are intentional until the parent creates the PRs. Review only this layer's diff against its base; L2 is the current layer.

| Layer | PR | Branch | Base | Review focus |
|---|---|---|---|---|
| L1/5 | #TBD-S15-L1 | codex/split-lab-events-validate | dev | separate field subject and claim validators |
| L2/5 | #TBD-S15-L2 | codex/split-lab-ledger-store | codex/split-lab-events-validate | isolate ledger lock ownership |
| L3/5 | #TBD-S15-L3 | codex/split-lab-artifacts-sanitize | dev | separate lexical redaction and UTF-8 truncation |
| L4/5 | #TBD-S15-L4 | codex/split-lab-fabric-observe | codex/split-lab-artifacts-sanitize | isolate producer outcome validation |
| L5/5 | #TBD-S15-L5 | codex/split-lab-fabric-scratch | dev | separate scratch access from fixture lifetime |

Depends on #TBD-S15-L1. A change to the real parent `codex/split-lab-events-validate` requires parent-managed cascade of this layer and fresh exact-head verification. Bottom-up integration applies only to this dependency chain; no merge authorization is conveyed by the plan. The current delegated task performs no Git mutation or PR action.
