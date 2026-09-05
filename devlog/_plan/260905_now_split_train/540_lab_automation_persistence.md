# 540 — S16 L2/5: src/lab/automation/persistence.ts

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: pure-move. Work class: C3 architecture planning, docs-only delegated scope. Parent owns orchestration, loop and goal state; this document executes none of them.
- Goal: split `src/lab/automation/persistence.ts` (512 lines) into the named leaves while preserving all current exports, signatures, object identities and behavior.
- Non-goals: no behavior fixes, public identifier renames, schema changes, new dependencies, import-consumer churn, function-body rewrites, core-root edits, merge, release or deployment. No code/test/git-state mutation in this drafting task.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below. Current planning basis is docs HEAD `4cc219549`, code `origin/dev = 1362b1a38`; `git diff origin/dev -- src/lab/automation/persistence.ts` is empty. All source line anchors below refer to that code basis, not future leaf line numbers.
- Stop: drafting ends after this plan's declaration/export/state/test inventory is checked. Implementation ends only when its independent per-layer gates and exact-head CI evidence are recorded; no merge is authorized by this document.
- Escalation: stop implementation and return to the parent if source drift invalidates the partition, an export/identity changes, an oracle cannot move without weakening, a new cycle appears, any residual/leaf exceeds 400, or the fixed layer scope needs expansion. Do not create an unplanned #b or edit 002 from this task.

The lock algorithm, file publication and reclamation are a sensitive boundary: pure move only, with explicit maintainer security review when the implementation PR is prepared. This is not authorization to redesign locking, change timeouts, or consolidate the independent config lock.

## Symbol inventory

Origin/dev declaration spans were enumerated with `sg run --lang ts --kind 'function_declaration,lexical_declaration,interface_declaration,type_alias_declaration,export_statement' --json=compact src/lab/automation/persistence.ts`, keeping column-zero declarations; exported declarations are counted once. Imports are not redeclarations of their source owners: original import block is src/lab/automation/persistence.ts:1–28, and the exact post-split imports appear below.

Consumer counts mean **direct importing/re-exporting modules**, not occurrences or transitive barrel consumers. Resolved relative import clauses were checked with `rg -q -w <symbol>`; namespace imports and wildcard re-exports count once for every exported symbol. Non-exported declarations have zero external consumers. `rg --files src gui/src scripts tests` supplied the search universe. Module fan-in is 12; the mechanically requested basename-only gate returns 12.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `ROUTES_KEYS` | const | 30–30 | no | 0 | `persistence.ts (residual)` |
| `ROUTE_KEYS` | const | 31–31 | no | 0 | `persistence.ts (residual)` |
| `STATE_KEYS` | const | 32–39 | no | 0 | `persistence.ts (residual)` |
| `RUN_KEYS` | const | 40–63 | no | 0 | `persistence.ts (residual)` |
| `RUN_STATES` | const | 64–64 | no | 0 | `persistence.ts (residual)` |
| `TERMINAL_RUN_STATES` | const | 65–65 | no | 0 | `persistence.ts (residual)` |
| `RUN_REASONS` | const | 66–79 | no | 0 | `persistence.ts (residual)` |
| `STATE_LOCK_WAIT_MS` | const | 80–80 | no | 0 | `state-lock.ts` |
| `LOCK_SLEEP` | const | 81–81 | no | 0 | `state-lock.ts` |
| `StateLockMeta` | interface | 83–86 | no | 0 | `state-lock.ts` |
| `assertClosedKeys` | function | 88–97 | no | 0 | `persistence.ts (residual)` |
| `assertBoundedString` | function | 99–109 | no | 0 | `persistence.ts (residual)` |
| `assertNonNegativeInt` | function | 111–121 | no | 0 | `persistence.ts (residual)` |
| `atomicWriteJson` | function | 123–129 | no | 0 | `persistence.ts (residual)` |
| `basename` | function | 131–134 | no | 0 | `persistence.ts (residual)` |
| `readJsonFile` | function | 136–145 | no | 0 | `persistence.ts (residual)` |
| `sleepLockRetry` | function | 147–149 | no | 0 | `state-lock.ts` |
| `stateLockPath` | function | 151–153 | no | 0 | `state-lock.ts` |
| `readStateLockMeta` | function | 155–166 | no | 0 | `state-lock.ts` |
| `pidDefinitelyDead` | function | 168–178 | no | 0 | `state-lock.ts` |
| `releaseStateLock` | function | 180–186 | no | 0 | `state-lock.ts` |
| `reclaimDeadStateLock` | function | 188–201 | no | 0 | `state-lock.ts` |
| `cleanupPrivateLockFile` | function | 203–209 | no | 0 | `state-lock.ts` |
| `acquireStateLock` | function | 211–250 | no | 0 | `state-lock.ts` |
| `loadLabAutomationPolicy` | function | 252–258 | yes | 5 | `persistence.ts (residual)` |
| `saveLabAutomationPolicy` | function | 260–264 | yes | 6 | `persistence.ts (residual)` |
| `normalizeLabAutomationRoutesV1` | function | 266–292 | yes | 4 | `persistence.ts (residual)` |
| `defaultLabAutomationRoutesV1` | function | 294–296 | yes | 2 | `persistence.ts (residual)` |
| `loadLabAutomationRoutes` | function | 298–303 | yes | 3 | `persistence.ts (residual)` |
| `saveLabAutomationRoutes` | function | 305–308 | yes | 5 | `persistence.ts (residual)` |
| `optionalTimestamp` | function | 310–313 | no | 0 | `persistence.ts (residual)` |
| `normalizeRunRecord` | function | 315–404 | no | 0 | `persistence.ts (residual)` |
| `assertStateRunInvariants` | function | 406–416 | no | 0 | `persistence.ts (residual)` |
| `normalizeState` | function | 418–461 | no | 0 | `persistence.ts (residual)` |
| `defaultLabAutomationStateV1` | function | 463–472 | yes | 7 | `persistence.ts (residual)` |
| `loadLabAutomationStateUnlocked` | function | 474–479 | no | 0 | `persistence.ts (residual)` |
| `saveLabAutomationStateUnlocked` | function | 481–484 | no | 0 | `persistence.ts (residual)` |
| `loadLabAutomationState` | function | 486–488 | yes | 9 | `persistence.ts (residual)` |
| `saveLabAutomationState` | function | 490–497 | yes | 7 | `persistence.ts (residual)` |
| `mutateLabAutomationState` | function | 499–512 | yes | 3 | `persistence.ts (residual)` |

Direct production consumers / public boundaries, all preserved:

- `src/lab/automation/orchestrator.ts:7`.
- `src/lab/automation/config-persistence.ts:19`.
- `src/lab/automation/index.ts:5`.
- `src/cli/lab.ts:58`.
- `src/server/management/lab-automation-routes.ts:23`.

## Leaf partition

Structural decision: Keep schema validation, policy/routes/state persistence and mutation ordering together; extract the state lock as the smallest cohesive leaf that brings persistence below 400. Existing config-persistence.ts:29–35 has a different config-file lock and constants; do not merge these independent lock identities or import config-persistence (which already imports persistence at :19–23). Reject extracting every schema now: that moves more code without being needed for this layer's file limit. No delete/configure alternative removes this structural debt without behavior change.

Sibling convention evidence: `src/lab/automation/config-persistence.ts`, `run-key.ts`, `route-context.ts` and `runs-query.ts` are concern-named siblings; state-lock.ts names the specific owner rather than generic locking utilities.

The existing lane-016 inventory replaces an extra map command. Search evidence: `rg --files src/lab/automation`, exact symbol searches and the direct-consumer inventory above; existing owners are reused, not copied. Doing nothing leaves the approved file-size debt; deletion/configuration would change behavior. Blast radius: local Lab feature plus unchanged entry-path consumers.

Expected counts below are an in-memory plan calculation: original complete declaration bodies and attached comments, the imports shown here, named re-exports, and one blank line between declarations. They are not a claim of executed source changes. Formatting may change the exact number; implementation must run wc and still stay ≤400. Private declarations listed in each leaf's “leaf exports” gain only the internal import seam; they are **not** added to the original public export surface.

### `src/lab/automation/state-lock.ts` — expected 118 lines

Symbols: `STATE_LOCK_WAIT_MS`, `LOCK_SLEEP`, `StateLockMeta`, `sleepLockRetry`, `stateLockPath`, `readStateLockMeta`, `pidDefinitelyDead`, `releaseStateLock`, `reclaimDeadStateLock`, `cleanupPrivateLockFile`, `acquireStateLock`.

Leaf exports: `acquireStateLock`. Everything else in this leaf stays private.

Own imports (exact):

```ts
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { ensureLabDirs, labAutomationStatePath } from "../paths";
import { LabAutomationError } from "./types";
```

### Residual `src/lab/automation/persistence.ts` — expected 388 lines

Retains: `ROUTES_KEYS`, `ROUTE_KEYS`, `STATE_KEYS`, `RUN_KEYS`, `RUN_STATES`, `TERMINAL_RUN_STATES`, `RUN_REASONS`, `assertClosedKeys`, `assertBoundedString`, `assertNonNegativeInt`, `atomicWriteJson`, `basename`, `readJsonFile`, `loadLabAutomationPolicy`, `saveLabAutomationPolicy`, `normalizeLabAutomationRoutesV1`, `defaultLabAutomationRoutesV1`, `loadLabAutomationRoutes`, `saveLabAutomationRoutes`, `optionalTimestamp`, `normalizeRunRecord`, `assertStateRunInvariants`, `normalizeState`, `defaultLabAutomationStateV1`, `loadLabAutomationStateUnlocked`, `saveLabAutomationStateUnlocked`, `loadLabAutomationState`, `saveLabAutomationState`, `mutateLabAutomationState`.

No #a/#b/#c subdivision: the whole file's assigned work is this layer, and no residual exceeds 400. There is no unnamed later remainder. Upstream imports retained by the residual, in addition to the local imports in the next section:

```ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { renameAtomicFile } from "../../lib/windows-atomic-replace";
import { ensureLabDirs, labAutomationPolicyPath, labAutomationRoutesPath, labAutomationStatePath } from "../paths";
import { LAB_AUTOMATION_HARD_MAX } from "./constants";
import { defaultLabAutomationPolicyV1, normalizeLabAutomationPolicyV1 } from "./policy";
import type { LabAutomationPolicyV1, LabAutomationRoutesV1, LabAutomationRunRecordV1, LabAutomationStateV1 } from "./types";
import { LabAutomationError } from "./types";
```

## Re-export block

The compatibility re-export block is **empty**: this partition moves no currently exported declaration. Keep the existing exported function definitions in the original file. Do not fabricate an `export { acquireStateLock }` or expose any other formerly private leaf helper from the facade.

Retained exports in the original file: `loadLabAutomationPolicy`, `saveLabAutomationPolicy`, `normalizeLabAutomationRoutesV1`, `defaultLabAutomationRoutesV1`, `loadLabAutomationRoutes`, `saveLabAutomationRoutes`, `defaultLabAutomationStateV1`, `loadLabAutomationState`, `saveLabAutomationState`, `mutateLabAutomationState`. No wildcard or renamed re-export is introduced. This is preservation of an existing boundary, not a new internal convenience barrel.

Explicit local imports required by residual call sites (re-exporting binds nothing):

```ts
import { acquireStateLock } from "./state-lock";
```

## Module-level state and cycles

ROUTES_KEYS (:30), ROUTE_KEYS (:31), STATE_KEYS (:32–39), RUN_KEYS (:40–63), RUN_STATES (:64), TERMINAL_RUN_STATES (:65), RUN_REASONS (:66–79) remain single-owner allowlist Sets in persistence.ts; they are not caches. STATE_LOCK_WAIT_MS (:80), LOCK_SLEEP (:81) and StateLockMeta (:83–86) move only to state-lock.ts. The Int32Array/SharedArrayBuffer and all retry/acquire/reclaim/release logic have one owner. No second lock buffer is retained in the facade. state-lock → paths/types only; it cannot import persistence or config-persistence. File lock ownership is existing temporal coupling; persistence retains acquire → read → mutate → save → finally release at :499–512 and acquire → save → finally release at :490–497. Leave unlocked reads at :486–488 unchanged.

Lane 016 reported no return path through this file. The proposed edges above preserve that direction; this is a design argument, not a completed implementation cycle scan. During implementation, repeat lane 016 method G (resolved static imports/exports, type-only edges and literal dynamic imports) for each new leaf and the residual, and require no new cycle. Do not “fix” a cycle with lazy imports or duplicate a type/constant. No protected core root, activation timing or optional-Lab registration seam is changed.

## Tests

Direct test import inventory, from `rg -l 'src/lab/automation/persistence"' tests` with relative specifiers resolved and hits inspected:

| test file / import anchor | action |
|---|---|
| `tests/lab/lab-automation.test.ts:9` | unchanged — keep original import path |
| `tests/lab/lab-automation-ingwannu-regressions.test.ts:7` | unchanged — keep original import path |
| `tests/lab/lab-automation-final-coderabbit-regressions.test.ts:12` | unchanged — keep original import path |
| `tests/lab/lab-automation-persisted-cap-regression.test.ts:3` | unchanged — keep original import path |
| `tests/lab/lab-automation-coderabbit-regressions.test.ts:7` | unchanged — keep original import path |
| `tests/lab/lab-automation-management-http.test.ts:8` | unchanged — keep original import path |
| `tests/lab/lab-automation-review-regressions.test.ts:7` | unchanged — keep original import path |

Text-oracle inventory: **zero tests read this specific file as source**. Checked `rg -n '(executor\\.ts|persistence\\.ts|community\\.ts|verification\\.ts|verdicts\\.ts)' tests`, qualified source paths and candidate reader bodies. Therefore retarget-to-leaf = none; add-leaf-to-scan-list = none. Behavioral imports stay unchanged; source-reading tests are not weakened into export-existence checks.

The reader at `tests/lab/lab-automation-ingwannu-regressions.test.ts:121` checks a CL-08 plan document's trailing whitespace, not persistence.ts; leave it unchanged.

The generic boundary guard reads graph nodes at `tests/lab/core-lab-boundary.test.ts:69` and its composition root at :355; its PROTECTED list (:20–28) and reader paths are unchanged. It discovers relative graph edges without a new leaf scan list. Never retarget or edit the protected production roots to accommodate this split.

No source-text guard is retargeted. Add lock-ownership behavioral cases inside existing tests/lab/lab-automation-review-regressions.test.ts (no new test file): saving state must not reclaim a canonical lock owned by the current live PID, dead-owner lock is reclaimable, and finally release leaves no canonical lock after a failing mutation. Drive the live-owner case red once by temporarily allowing live-PID reclaim in state-lock.ts, then restore. Keep the unknown-field contract at :334 and tests/lab/lab-automation-coderabbit-regressions.test.ts:157 unchanged. New tests use the original persistence API, not private lock helpers.

## Verification

This is the `002_layer_map.md` Per-layer gate instantiated for S16 L2. These are **future implementation commands**, not tests run by this docs-only delegate. Run at this layer's own tip, not the top of the stack. Focused domains: tests/lab.

```sh
bun run typecheck
bun test tests/lab/lab-automation.test.ts tests/lab/lab-automation-ingwannu-regressions.test.ts tests/lab/lab-automation-final-coderabbit-regressions.test.ts tests/lab/lab-automation-persisted-cap-regression.test.ts tests/lab/lab-automation-coderabbit-regressions.test.ts tests/lab/lab-automation-management-http.test.ts tests/lab/lab-automation-review-regressions.test.ts
bun test tests/lab
bun run privacy:scan
# No src/server, src/router or src/lib edit: 002's extra core-boundary command is not triggered.
wc -l src/lab/automation/state-lock.ts src/lab/automation/persistence.ts
rg -n 'from "[^"]*/persistence"' src gui/src scripts tests | wc -l
# Full suite only on the designated remote, never in this local worktree:
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-lab-automation-persistence && git checkout -q FETCH_HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15'
```

Focused commands overlapping the full lab domain need not be repeated on unchanged code: capture the focused red/green during the move, then domain coverage once at the final tip. Typecheck/privacy must exit 0; tests must report zero failures. The basename-only rg baseline is 12; the resolved exact-module fan-in must remain 12. Leaf names deliberately do not end in /persistence, so they do not inflate that gate. Recount against the actual parent if upstream changes.

The inherited remote pipeline's tail status alone is not proof of a passing Bun process: capture its complete test result and actual test exit status (enable pipefail or retain the status separately) and record the checked-out SHA. Do not treat fetch/checkout as authorization granted to this docs delegate. Parent/executor verifies remote checkout ownership before use. Record a green **complete exact-head CI rollup**, not an empty required-check list. New or modified source-oracle guards, if discovered, must be driven red and restored before claiming green. No test runner is installed for this plan.

Use `git diff --check`, `git diff --numstat <base>...HEAD` and move-aware diff inspection to prove only declaration moves/import rewiring. Compare all original exports (including erased types) to the explicit inventory. Re-run the lane-G import graph check, including type edges; a clean typecheck alone does not prove acyclicity.

## Accept criteria

1. Every declaration in the inventory has exactly one owner after the split; no duplicated mutable state or constants, and no omitted declaration.
2. All 10 original exported names remain importable from `src/lab/automation/persistence` with the same signatures/identity; the named re-export and local-import blocks above are present exactly where needed.
3. The 1 new leaves have expected counts 118; residual expected 388. Actual `wc -l` is ≤400 for every one. No hidden #b or sixth stack layer is assumed.
4. Existing function bodies, comparison ordering, errors, cleanup/finally behavior, and allocation timing are unchanged apart from export visibility needed by the private leaf seam. No new upward or facade-back import; static/type/dynamic graph has no newly introduced cycle.
5. All direct tests keep original imports; all identified text-oracle dispositions are implemented without weakening. The named deliberate red mutation fails for the intended reason and is fully removed before the final green run.
6. The instantiated local focused/domain, typecheck and privacy gates plus the remote-only full suite pass on the recorded layer SHA, and its complete exact-head CI is green. No local full suite.
7. The PR contains only this layer's pure move and necessary existing-test additions, retains the parent branch base, and includes the full five-layer stack map. Any raw changeset above 500 lines is returned for explicit parent review; do not expand the authorized topology silently.

## PR

Title: `refactor(lab-automation): isolate the state-file lock owner (split S16 L2/5)`

Branch: `codex/split-lab-automation-persistence`. Base: `dev`. Closes: none.

Use every section of `.github/PULL_REQUEST_TEMPLATE.md` (Summary, Verification, Checklist); include the pure-move thesis, planned/actual counts, gate evidence and this DEV-STACK-03 map. The placeholders below are intentional pre-creation PR numbers, not existing PRs.

| # | PR | Layer | Branch | Base | Review focus |
|---|---|---|---|---|---|
| 1 | #TBD-S16-L1 | 530 | `codex/split-lab-conformance-executor` | `dev` | separate scenario transport and vector families |
| 2 | #TBD-S16-L2 | 540 — this PR | `codex/split-lab-automation-persistence` | `dev` | isolate the state-file lock owner |
| 3 | #TBD-S16-L3 | 550 | `codex/split-lab-public-community` | `dev` | extract bounded community input validation |
| 4 | #TBD-S16-L4 | 560 | `codex/split-lab-projection-verification` | `dev` | isolate suite artifact parsing |
| 5 | #TBD-S16-L5 | 570 | `codex/split-lab-projection-verdicts` | `codex/split-lab-projection-verification` | separate projection keys and claim reduction |

Base: dev — no dependency on the layers below; no cascade obligation. Every layer passes independently. Merge remains separately user-authorized; never merge or enable auto-merge as part of this plan.
