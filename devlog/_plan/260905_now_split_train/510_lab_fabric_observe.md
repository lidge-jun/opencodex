# 510 — S15 L4/5: src/lab/fabric/observe.ts

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: `pure-move`; C3 architecture planning, docs-only bounded delegation. cxc-dev §1/§5 and cxc-dev-architecture apply. Parent alone owns orchestration, loop and goal state.
- Goal: isolate producer outcome validation, with every original public export and behavior preserved.
- Non-goals: no behavior fixes, new validation, renamed symbols, signature changes, new dependencies, public API expansion, core activation changes, releases or merges. This document plans implementation; this drafting task changes no source and runs no tests.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below; full tests only on `ssh lidge`, never locally.
- Stop: independent layer-tip verification and green exact-head CI evidence recorded, with the layer PR open; do not merge. Stop before implementation if a stated escalation is unresolved.
- Escalation: source drift, unexpected oracle coupling, new cycle, public export loss, changed state lifetime, any scope expansion, or the size-budget conflict below goes to the parent. Do not add a sixth stack layer or edit 002 here.
- Basis: docs HEAD `4cc219549`; verified source `origin/dev = 1362b1a3841b4de20177e5d65865a513dd7936c4`. All source anchors in this document refer to that revision. `git show origin/dev:src/lab/fabric/observe.ts` matches the working file byte-for-byte.
- Prior audited seam: `devlog/_plan/260905_modular_debt_ledger/016_lane_cli_storage_usage_update_lab_scripts.md:558`. Read together with 000, 001, 002; actual consumer/oracle evidence below supersedes the approximate basename-based counts in 001.

Structural decision before implementation: Current: fabric/index.ts:79 is the production public re-export; the direct test performs dynamic import at lab-fabric-persistence-boundary.test.ts:5. observe currently depends on artifacts, events, ledger, paths, manifest, constants and types (1–34). Chosen: move only closed outcome parsing and its data tables. Rejected: moving persistence along with validation would expose the authority-free helper or couple validation back to storage. Existing public types and persistence functions stay in the residual boundary. Blast radius is the Lab fabric feature; no new public API.

## Symbol inventory

Measured by `sg run --lang ts --kind 'function_declaration,interface_declaration,type_alias_declaration,lexical_declaration' --json=compact src/lab/fabric/observe.ts`, matched to column-zero declarations in the pinned source. Nested declarations are excluded. Ranges include declaration syntax through its closing line, not preceding comments.

Consumers are distinct direct import/re-export files across `src gui/src scripts tests`, found with `rg -l` path/symbol searches and verified against the actual import binding. A wildcard re-export counts once for every public symbol; a dynamic namespace import counts for runtime exports, not erased types. Private declarations have zero external consumers, even if unrelated same-named declarations occur elsewhere. Transitive barrel clients are covered by the Lab domain gate, not double-counted. Total direct module consumers: **2**.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| PersistFabricOptions | interface | 39–45 | yes | 1 | src/lab/fabric/observe.ts |
| PersistedFabricObservation | interface | 48–51 | yes | 1 | src/lab/fabric/observe.ts |
| OUTCOME_KEYS | const | 53–73 | no | 0 | src/lab/fabric/outcome-validation.ts |
| VERIFIER_KEYS | const | 75–75 | no | 0 | src/lab/fabric/outcome-validation.ts |
| PATH_SUMMARY_KEYS | const | 76–76 | no | 0 | src/lab/fabric/outcome-validation.ts |
| PATH_SUMMARY_KINDS | const | 77–77 | no | 0 | src/lab/fabric/outcome-validation.ts |
| USAGE_KEYS | const | 78–78 | no | 0 | src/lab/fabric/outcome-validation.ts |
| LIMIT_KEYS | const | 79–79 | no | 0 | src/lab/fabric/outcome-validation.ts |
| FAILURE_KEYS | const | 80–80 | no | 0 | src/lab/fabric/outcome-validation.ts |
| FAILURE_ATTRIBUTIONS | const | 81–81 | no | 0 | src/lab/fabric/outcome-validation.ts |
| assertPlainObject | function | 84–89 | no | 0 | src/lab/fabric/outcome-validation.ts |
| assertStringField | function | 92–98 | no | 0 | src/lab/fabric/outcome-validation.ts |
| assertIntegerField | function | 101–107 | no | 0 | src/lab/fabric/outcome-validation.ts |
| assertNonNegativeIntegerField | function | 110–116 | no | 0 | src/lab/fabric/outcome-validation.ts |
| wrapValidationError | function | 119–124 | no | 0 | src/lab/fabric/outcome-validation.ts |
| validateFabricVerifier | function | 127–171 | no | 0 | src/lab/fabric/outcome-validation.ts |
| validateFabricUsage | function | 174–183 | no | 0 | src/lab/fabric/outcome-validation.ts |
| validateFabricLimits | function | 186–195 | no | 0 | src/lab/fabric/outcome-validation.ts |
| validateFailureRecord | function | 198–216 | no | 0 | src/lab/fabric/outcome-validation.ts |
| routeSubjectsMatch | function | 219–221 | no | 0 | src/lab/fabric/outcome-validation.ts |
| sanitizedVerifierSummary | function | 224–247 | no | 0 | src/lab/fabric/observe.ts |
| assertFabricOutcomeV1 | function | 250–347 | yes | 2 | src/lab/fabric/outcome-validation.ts |
| observationFromFabricOutcome | function | 350–455 | yes | 2 | src/lab/fabric/observe.ts |
| persistFabricOutcome | function | 458–474 | no | 0 | src/lab/fabric/observe.ts |
| persistFabricRunResult | function | 477–489 | yes | 2 | src/lab/fabric/observe.ts |

Direct edge evidence (including public re-exports):

- `src/lab/fabric/index.ts:75` — assertFabricOutcomeV1, observationFromFabricOutcome, persistFabricRunResult.
- `src/lab/fabric/index.ts:80` — PersistFabricOptions, PersistedFabricObservation.
- `tests/lab/lab-fabric-persistence-boundary.test.ts:5` — *dynamic*.

Import declarations are not new owners: their exact leaf/residual binding allocations are given below. No default export exists.

## Leaf partition

Reuse the existing same-directory sibling convention: `events/limits.ts`, `events/errors.ts`, `ledger/artifact-refs.ts`, `artifacts/secure-fs.ts`, `fabric/producer-protocol.ts`. The five source directories and proposed names were inspected with `rg --files`; none of the new paths exists at the pinned source. No new index/barrel, generic utils module, package or directory is needed. The original paths are compatibility boundaries explicitly retained by the split-train contract, not new internal convenience barrels.

Move complete source slices with their inline/leading comments as listed; only add the listed imports, named re-exports and leaf-local export modifiers needed by other leaves/the residual. Never re-export formerly private implementation helpers from the original public path.

### src/lab/fabric/outcome-validation.ts

- Original slices: `src/lab/fabric/observe.ts:53–221`, `src/lab/fabric/observe.ts:249–347`.
- Symbols: `OUTCOME_KEYS`, `VERIFIER_KEYS`, `PATH_SUMMARY_KEYS`, `PATH_SUMMARY_KINDS`, `USAGE_KEYS`, `LIMIT_KEYS`, `FAILURE_KEYS`, `FAILURE_ATTRIBUTIONS`, `assertPlainObject`, `assertStringField`, `assertIntegerField`, `assertNonNegativeIntegerField`, `wrapValidationError`, `validateFabricVerifier`, `validateFabricUsage`, `validateFabricLimits`, `validateFailureRecord`, `routeSubjectsMatch`, `assertFabricOutcomeV1`.
- Expected lines: **279** = 268 moved lines + 10 import/header-separator lines + 1 inter-slice separators; ≤400.
- Additional leaf-only exports for existing cross-partition calls: none; preserve existing exported declaration modifiers.
- Own imports:

```ts
import { OUTCOMES } from "../constants";
import { FAILURE_CLASSIFICATIONS } from "../conformance/types";
import { isSha256Hex, jcsStringify, subjectIdForSubject } from "../digest";
import type { RouteSubjectV1, TaskSubjectV1 } from "../events/types";
import { LabValidationError } from "../events/errors";
import { validateSubject } from "../events/validate";
import { FABRIC_LIMITS, FABRIC_VERIFIER_ID } from "./constants";
import type { FabricLimitsV1, FabricTaskOutcomeV1 } from "./types";
import { FabricTaskError } from "./types";
```

Residual `src/lab/fabric/observe.ts`: **201 expected lines**. Retained declarations: `PersistFabricOptions`, `PersistedFabricObservation`, `sanitizedVerifierSummary`, `observationFromFabricOutcome`, `persistFabricOutcome`, `persistFabricRunResult`.

Line accounting: 489 logical source lines − 268 moved lines − 34 original import/header lines + 14 explicit import/re-export lines = 201. Keep formatting compact as shown; extra formatting lines must still fit the 400-line gate. No residual exceeds 400; no #b layer is required for file size.

Changeset accounting: 268 original lines move; raw additions+deletions for the move alone are 536, before import glue. **Parent decision required:** this exceeds the ≤500 changed-source-line/default PR limit if measured as raw Git additions+deletions. The fixed five-layer S15 map does not allocate a #b for this file. Do not claim this layer satisfies that limit. Parent must explicitly accept a pure-move size exception (with moved-line review evidence) or revise the train topology before code execution. This document does not authorize either change.

## Re-export block

Exact named re-exports to add/retain at the original path:

```ts
export { assertFabricOutcomeV1 } from "./outcome-validation";
```

PersistFabricOptions, PersistedFabricObservation, observationFromFabricOutcome and persistFabricRunResult remain exported declarations. No public type is moved.

Explicit local imports for the residual (replace the original import block); re-export statements bind nothing locally:

```ts
import { createArtifactStore, type ArtifactStore } from "../artifacts/store";
import { sanitizeDiagnostic, truncateUtf8 } from "../artifacts/sanitize";
import { LAB_EVENT_SCHEMA_VERSION, LAB_PRODUCER, LAB_PRODUCER_VERSION, OBSERVATION_LIMIT_NAMES } from "../constants";
import { fixtureDigest } from "../digest";
import type { ObservationEvent, RouteSubjectV1, TaskSubjectV1 } from "../events/types";
import { assignEventId } from "../events/validate";
import { withLedgerMutation } from "../ledger/store";
import { ensureLabDirs } from "../paths";
import { FABRIC_EVIDENCE_LAYER, FABRIC_SCENARIO_ID, FABRIC_SCENARIO_VERSION, FABRIC_SUITE_ID, FABRIC_SUITE_VERSION } from "./constants";
import { expandFabricScenario, expandFabricSuiteManifest, fabricScenarioManifestDigest, fabricSuiteManifestDigest, loadFabricCaseAuthority } from "./manifest";
import type { FabricTaskOutcomeV1, FabricTaskRunResult } from "./types";
import { FabricTaskError } from "./types";
import { assertFabricOutcomeV1 } from "./outcome-validation";
```



## Module-level state and cycles

Move all six top-level Sets together to outcome-validation.ts: OUTCOME_KEYS (53–73), VERIFIER_KEYS (75), PATH_SUMMARY_KEYS (76), PATH_SUMMARY_KINDS (77), FAILURE_KEYS (80), FAILURE_ATTRIBUTIONS (81). USAGE_KEYS (78) and derived LIMIT_KEYS (79) follow their validators; evaluate LIMIT_KEYS once exactly as before. There is no module let, Map, WeakMap or live lock.
New direction: observe → outcome-validation → events/validate/constants/digest/types. The leaf never imports observe, the fabric index, artifact storage or ledger storage. PersistFabricOptions/PersistedFabricObservation remain in observe, and the leaf does not need either type, avoiding even a type-only cycle. sanitizedVerifierSummary (224–247), observationFromFabricOutcome (350–455), private persistFabricOutcome (458–474), and persistFabricRunResult (477–489) stay together. The authority-free persistence helper MUST remain module-private; this layer must not expose it through any leaf or public barrel. Store ownership and finally-close ordering remain unchanged.

Existing lane evidence found no cycle through this file. Recheck the concrete resolved graph at implementation tip, including type-only edges; typecheck alone does not prove acyclicity. This plan introduces only the directed edges above. Do not change protected core roots, turn startServer async, or add activation imports into them.

## Tests

Direct import/dynamic-import test `rg -l` list, all **unchanged** at their original import path:

- `tests/lab/lab-fabric-persistence-boundary.test.ts` — unchanged (import at 5).

Discovery commands (run across all tests, not just tests/lab):

```sh
rg -l 'src/lab/fabric/observe' tests --glob '*.ts'
rg -n 'src/lab/fabric/observe|observe\.ts' tests --glob '*.ts'
rg -n 'readFileSync|Bun\.file|readFile\(|source\(' tests --glob '*.ts'
```

Dedicated source-text readers of this file: **none found**. No retarget-to-leaf or add-leaf-to-scan-list is required for a dedicated source oracle.
The generic `tests/lab/core-lab-boundary.test.ts` reads traversed source at **69**, protected roots at **278/336**, and the server composition source at **355**. It reports the first edge into Lab before traversing that target, so these Lab leaves are not dedicated source-text inputs on a successful run. Disposition: **unchanged**, no scan-list addition, never edit `PROTECTED` (20–28). Include its existing negative-fixture cases in the implementation gate.

Additional transitive-barrel/behavioral coverage: `tests/lab/lab-fabric-outcome-validation.test.ts` — unchanged; `tests/lab/lab-fabric-task.test.ts` — unchanged; `tests/lab/lab-ledger-mutation-lock.test.ts` — unchanged. Run `tests/lab` for all indirect callers.

Guards to drive red once during implementation (temporary mutations must be restored before committing):

Drive `tests/lab/lab-fabric-persistence-boundary.test.ts:4` red once by a temporary export of persistFabricOutcome, restore it, then confirm the public boundary has no such export. Drive nested-field rejection in `tests/lab/lab-fabric-outcome-validation.test.ts:78` red once by a temporary moved-validator bypass; restore. Retain canonical acceptance (73), timestamps (99), identity contradictions (107), and trusted-versus-harness persistence tests at `tests/lab/lab-fabric-task.test.ts:483,500`.

No tests or red mutations were run while drafting this plan; these are executor obligations.

## Verification

Instantiate `002_layer_map.md` Per-layer gate in the dedicated layer worktree, not this docs worktree:

```sh
bun run typecheck
bun test tests/lab/lab-fabric-persistence-boundary.test.ts tests/lab/lab-fabric-outcome-validation.test.ts tests/lab/lab-fabric-task.test.ts tests/lab/lab-ledger-mutation-lock.test.ts
bun test tests/lab
bun run privacy:scan
bun test tests/lab/core-lab-boundary.test.ts
wc -l src/lab/fabric/outcome-validation.ts src/lab/fabric/observe.ts
rg -n 'lab/fabric/observe|from "./observe"' src gui/src scripts tests
git diff --check
git diff --numstat codex/split-lab-artifacts-sanitize...HEAD
# Full repository suite: remote only, exact branch tip; pipefail preserves failures.
ssh lidge 'bash -o pipefail -c "cd ~/ocx-ci/opencodex && git fetch origin codex/split-lab-fabric-observe && git checkout -q FETCH_HEAD && git rev-parse HEAD && bun install --frozen-lockfile && bun run test 2>&1 | tail -15"'
```

Required outcome: all local gates exit 0; focused/domain tests have zero failures; every leaf and residual ≤400. The boundary test is included explicitly even though no protected source is edited. Confirm the remote printed SHA equals the layer tip and save the full exit status plus test totals; the tail alone is not proof. Full suite remains remote-only.

Compare resolved direct consumer bindings against the 2-file baseline above (raw basename grep is only a candidate search and can include unrelated modules). Leaf names matching the search are not new original-path consumers. Existing public callers must not need migration.  Use the already available parser/import-graph mechanism, or a read-only resolver, to report no cycles containing this residual or any new leaf, including type edges; do not install a new analyzer just for this split. Verify moved declaration bodies are identical to origin/dev after stripping only the newly required export modifiers, and inspect `git diff --color-moved` for accidental behavior edits.

For PR readiness, record exact-head CI (Linux, macOS, Windows) and review status separately from local checks. No tests, typecheck, privacy scan or remote suite have been executed in this docs-only delegation.

## Accept criteria

1. Exactly this layer's original source plus the listed 1 new leaves and necessary existing-test adjustments are changed at implementation time; no other S15 file is implemented in this PR.
2. The complete inventory above has exactly one implementation/type owner per declaration; all original public names resolve from `src/lab/fabric/observe.ts`, with no newly public private helper.
3. Every moved body, constant initializer, comment-backed order and signature matches the pinned source; only import/export plumbing changes.
4. Leaf line counts are 279 for `src/lab/fabric/outcome-validation.ts` (or verified formatted equivalents ≤400); residual is approximately 201, always ≤400. No deferred >400 residual.
5. State owners and operation lifetimes match the state section; resolved import graph has no cycle involving the partition.
6. Direct test imports and all source-oracle dispositions are applied exactly as listed; named guards have recorded red→restored-green evidence, without weakening assertions or editing protected roots.
7. Every instantiated local gate and exact-tip remote suite succeeds; source/consumer inventory and privacy scan are recorded. No repository-wide local suite.
8. The parent has explicitly resolved the raw-diff size exception/topology escalation before source implementation.
9. PR base is `codex/split-lab-artifacts-sanitize`, stack map contains all five layers, and exact-head CI is green. No merge is performed.

## PR

Title: `refactor(lab-fabric): isolate producer outcome validation (split S15 L4/5)`

Branch: `codex/split-lab-fabric-observe`. Base: `codex/split-lab-artifacts-sanitize`. Closes: **none**.

Use every section of `.github/PULL_REQUEST_TEMPLATE.md` (Summary, Verification, Checklist). Include this full DEV-STACK-03 map; placeholder PR numbers are intentional until the parent creates the PRs. Review only this layer's diff against its base; L4 is the current layer.

| Layer | PR | Branch | Base | Review focus |
|---|---|---|---|---|
| L1/5 | #TBD-S15-L1 | codex/split-lab-events-validate | dev | separate field subject and claim validators |
| L2/5 | #TBD-S15-L2 | codex/split-lab-ledger-store | codex/split-lab-events-validate | isolate ledger lock ownership |
| L3/5 | #TBD-S15-L3 | codex/split-lab-artifacts-sanitize | dev | separate lexical redaction and UTF-8 truncation |
| L4/5 | #TBD-S15-L4 | codex/split-lab-fabric-observe | codex/split-lab-artifacts-sanitize | isolate producer outcome validation |
| L5/5 | #TBD-S15-L5 | codex/split-lab-fabric-scratch | dev | separate scratch access from fixture lifetime |

Depends on #TBD-S15-L3. A change to the real parent `codex/split-lab-artifacts-sanitize` requires parent-managed cascade of this layer and fresh exact-head verification. Bottom-up integration applies only to this dependency chain; no merge authorization is conveyed by the plan. The current delegated task performs no Git mutation or PR action.
