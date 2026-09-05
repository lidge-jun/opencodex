# 560 — S16 L4/5: src/lab/projection/verification.ts

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: pure-move. Work class: C3 architecture planning, docs-only delegated scope. Parent owns orchestration, loop and goal state; this document executes none of them.
- Goal: split `src/lab/projection/verification.ts` (412 lines) into the named leaves while preserving all current exports, signatures, object identities and behavior.
- Non-goals: no behavior fixes, public identifier renames, schema changes, new dependencies, import-consumer churn, function-body rewrites, core-root edits, merge, release or deployment. No code/test/git-state mutation in this drafting task.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below. Current planning basis is docs HEAD `4cc219549`, code `origin/dev = 1362b1a38`; `git diff origin/dev -- src/lab/projection/verification.ts` is empty. All source line anchors below refer to that code basis, not future leaf line numbers.
- Stop: drafting ends after this plan's declaration/export/state/test inventory is checked. Implementation ends only when its independent per-layer gates and exact-head CI evidence are recorded; no merge is authorized by this document.
- Escalation: stop implementation and return to the parent if source drift invalidates the partition, an export/identity changes, an oracle cannot move without weakening, a new cycle appears, any residual/leaf exceeds 400, or the fixed layer scope needs expansion. Do not create an unplanned #b or edit 002 from this task.

L5 still imports evaluateAllApplicableRequiredPassV1, newestObservationByScenario and ScenarioRequirements from verification.ts; this layer must pass independently before L5. No #b is needed. Long evaluator bodies are retained unchanged because this train only moves declarations.

## Symbol inventory

Origin/dev declaration spans were enumerated with `sg run --lang ts --kind 'function_declaration,lexical_declaration,interface_declaration,type_alias_declaration,export_statement' --json=compact src/lab/projection/verification.ts`, keeping column-zero declarations; exported declarations are counted once. Imports are not redeclarations of their source owners: original import block is src/lab/projection/verification.ts:1–5, and the exact post-split imports appear below.

Consumer counts mean **direct importing/re-exporting modules**, not occurrences or transitive barrel consumers. Resolved relative import clauses were checked with `rg -q -w <symbol>`; namespace imports and wildcard re-exports count once for every exported symbol. Non-exported declarations have zero external consumers. `rg --files src gui/src scripts tests` supplied the search universe. Module fan-in is 7; the mechanically requested basename-only gate returns 7.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `VerificationEvaluation` | interface | 7–13 | yes | 1 | `verification.ts (residual)` |
| `LoadScenarioManifest` | type | 15–15 | yes | 1 | `verification.ts (residual)` |
| `ScenarioRequirements` | interface | 17–26 | yes | 3 | `verification.ts (residual)` |
| `LoadScenarioRequirements` | type | 28–28 | yes | 1 | `verification.ts (residual)` |
| `isScenarioApplicable` | function | 31–42 | yes | 2 | `verification.ts (residual)` |
| `scenarioApplicableToRequirements` | function | 45–57 | no | 0 | `verification.ts (residual)` |
| `routeSubjectApplicableToRequirements` | function | 60–76 | yes | 1 | `verification.ts (residual)` |
| `taskSubjectApplicableToRequirements` | function | 79–96 | yes | 2 | `verification.ts (residual)` |
| `isNonNegativeInteger` | function | 99–101 | no | 0 | `verification-manifest.ts` |
| `parseFreshness` | function | 104–110 | no | 0 | `verification-manifest.ts` |
| `parseStringArray` | function | 113–116 | no | 0 | `verification.ts (residual)` |
| `scenarioContractFromManifest` | function | 118–153 | no | 0 | `verification.ts (residual)` |
| `effectiveMaxAgeMs` | function | 155–162 | no | 0 | `verification.ts (residual)` |
| `newestObservationByScenario` | function | 164–176 | yes | 2 | `verification.ts (residual)` |
| `evaluateAllApplicableRequiredPassV1` | function | 183–346 | yes | 4 | `verification.ts (residual)` |
| `requireNonEmptyString` | function | 348–350 | no | 0 | `verification-manifest.ts` |
| `parseSuiteManifestFromArtifact` | function | 352–412 | yes | 2 | `verification-manifest.ts` |

Direct production consumers / public boundaries, all preserved:

- `src/lab/automation/planner.ts:12`.
- `src/lab/index.ts:18`.
- `src/lab/projection/rebuild.ts:9`.
- `src/lab/projection/verdicts.ts:18`.

## Leaf partition

Structural decision: Extract the suite-artifact parser plus its freshness primitives; keep applicability, scenario-contract parsing and all-required-pass evaluation in verification.ts. Existing conformance/suite-manifest.ts owns SuiteManifestV1, and digest.ts owns isSha256Hex: reuse both. Reject moving only parseSuiteManifestFromArtifact while importing parseFreshness from verification; that creates a direct cycle. Reject additional applicability/types leaves because the parser extraction alone clears the 400-line gate. Scope is one Lab projection boundary, with no API/schema changes.

Sibling convention evidence: `src/lab/projection/schema.ts`, `rebuild.ts`, `verification.ts` and `verdicts.ts` are sibling modules; the verification-manifest name distinguishes artifact parsing from conformance/suite-manifest.ts expansion.

The existing lane-016 inventory replaces an extra map command. Search evidence: `rg --files src/lab/projection`, exact symbol searches and the direct-consumer inventory above; existing owners are reused, not copied. Doing nothing leaves the approved file-size debt; deletion/configuration would change behavior. Blast radius: local Lab feature plus unchanged entry-path consumers.

Expected counts below are an in-memory plan calculation: original complete declaration bodies and attached comments, the imports shown here, named re-exports, and one blank line between declarations. They are not a claim of executed source changes. Formatting may change the exact number; implementation must run wc and still stay ≤400. Private declarations listed in each leaf's “leaf exports” gain only the internal import seam; they are **not** added to the original public export surface.

### `src/lab/projection/verification-manifest.ts` — expected 84 lines

Symbols: `isNonNegativeInteger`, `parseFreshness`, `requireNonEmptyString`, `parseSuiteManifestFromArtifact`.

Leaf exports: `parseFreshness`, `parseSuiteManifestFromArtifact`. Everything else in this leaf stays private.

Own imports (exact):

```ts
import { EVIDENCE_LAYERS } from "../constants";
import type { SuiteManifestV1 } from "../conformance/suite-manifest";
import type { VerificationRole } from "../conformance/types";
import { isSha256Hex } from "../digest";
```

### Residual `src/lab/projection/verification.ts` — expected 334 lines

Retains: `VerificationEvaluation`, `LoadScenarioManifest`, `ScenarioRequirements`, `LoadScenarioRequirements`, `isScenarioApplicable`, `scenarioApplicableToRequirements`, `routeSubjectApplicableToRequirements`, `taskSubjectApplicableToRequirements`, `parseStringArray`, `scenarioContractFromManifest`, `effectiveMaxAgeMs`, `newestObservationByScenario`, `evaluateAllApplicableRequiredPassV1`.

No #a/#b/#c subdivision: the whole file's assigned work is this layer, and no residual exceeds 400. There is no unnamed later remainder. Upstream imports retained by the residual, in addition to the local imports in the next section:

```ts
import type { ObservationEvent, ProtocolSubjectV1, RouteSubjectV1, TaskSubjectV1 } from "../events/types";
import type { ExecutionMode } from "../constants";
import type { SuiteManifestV1 } from "../conformance/suite-manifest";
```

## Re-export block

Add exactly these compatibility re-exports to `src/lab/projection/verification.ts`:

```ts
export { parseSuiteManifestFromArtifact } from "./verification-manifest";
```

Retained exports in the original file: `VerificationEvaluation`, `LoadScenarioManifest`, `ScenarioRequirements`, `LoadScenarioRequirements`, `isScenarioApplicable`, `routeSubjectApplicableToRequirements`, `taskSubjectApplicableToRequirements`, `newestObservationByScenario`, `evaluateAllApplicableRequiredPassV1`. No wildcard or renamed re-export is introduced. This is preservation of an existing boundary, not a new internal convenience barrel.

Explicit local imports required by residual call sites (re-exporting binds nothing):

```ts
import { parseFreshness } from "./verification-manifest";
```

## Module-level state and cycles

No module-level let/Map/Set/WeakMap/lock exists. byScenario (:167), scenarioMaxAgeById (:246), the Set at :290, and roles/seenScenarioIds (:376–377) are invocation-local. Keep their allocation timing intact. verification → verification-manifest → constants/conformance types/digest is acyclic; the parser imports no verification type. ScenarioRequirements, LoadScenarioManifest, LoadScenarioRequirements and VerificationEvaluation remain in verification.ts, so verdicts/rebuild keep the original types. parseFreshness has one owner in the new leaf; scenarioContractFromManifest uses the explicit import. Coupling is functional/sequential.

Lane 016 reported no return path through this file. The proposed edges above preserve that direction; this is a design argument, not a completed implementation cycle scan. During implementation, repeat lane 016 method G (resolved static imports/exports, type-only edges and literal dynamic imports) for each new leaf and the residual, and require no new cycle. Do not “fix” a cycle with lazy imports or duplicate a type/constant. No protected core root, activation timing or optional-Lab registration seam is changed.

## Tests

Direct test import inventory, from `rg -l 'src/lab/projection/verification"' tests` with relative specifiers resolved and hits inspected:

| test file / import anchor | action |
|---|---|
| `tests/lab/lab-fabric-task.test.ts:58` | unchanged — keep original import path |
| `tests/lab/lab-post-merge-projection.test.ts:11` | unchanged — keep original import path |
| `tests/lab/lab-evidence-ledger.test.ts:37` | unchanged — keep original import path |

Text-oracle inventory: **zero tests read this specific file as source**. Checked `rg -n '(executor\\.ts|persistence\\.ts|community\\.ts|verification\\.ts|verdicts\\.ts)' tests`, qualified source paths and candidate reader bodies. Therefore retarget-to-leaf = none; add-leaf-to-scan-list = none. Behavioral imports stay unchanged; source-reading tests are not weakened into export-existence checks.

The generic boundary guard reads graph nodes at `tests/lab/core-lab-boundary.test.ts:69` and its composition root at :355; its PROTECTED list (:20–28) and reader paths are unchanged. It discovers relative graph edges without a new leaf scan list. Never retarget or edit the protected production roots to accommodate this split.

No source-text guard is retargeted. Add parser rejection/acceptance cases in existing tests/lab/lab-post-merge-projection.test.ts through the retained verification.ts path: valid suite accepted; duplicate scenario ID, invalid digest/role and invalid freshness rejected. Drive the duplicate-ID case red once by temporarily removing seenScenarioIds.has from verification-manifest.ts, then restore. Keep the stricter suite/scenario freshness contract at tests/lab/lab-post-merge-projection.test.ts:108 unchanged.

## Verification

This is the `002_layer_map.md` Per-layer gate instantiated for S16 L4. These are **future implementation commands**, not tests run by this docs-only delegate. Run at this layer's own tip, not the top of the stack. Focused domains: tests/lab.

```sh
bun run typecheck
bun test tests/lab/lab-fabric-task.test.ts tests/lab/lab-post-merge-projection.test.ts tests/lab/lab-evidence-ledger.test.ts
bun test tests/lab
bun run privacy:scan
# No src/server, src/router or src/lib edit: 002's extra core-boundary command is not triggered.
wc -l src/lab/projection/verification-manifest.ts src/lab/projection/verification.ts
rg -n 'from "[^"]*/verification"' src gui/src scripts tests | wc -l
# Full suite only on the designated remote, never in this local worktree:
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-lab-projection-verification && git checkout -q FETCH_HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15'
```

Focused commands overlapping the full lab domain need not be repeated on unchanged code: capture the focused red/green during the move, then domain coverage once at the final tip. Typecheck/privacy must exit 0; tests must report zero failures. The basename-only rg baseline is 7; the resolved exact-module fan-in must remain 7. Leaf names deliberately do not end in /verification, so they do not inflate that gate. Recount against the actual parent if upstream changes.

The inherited remote pipeline's tail status alone is not proof of a passing Bun process: capture its complete test result and actual test exit status (enable pipefail or retain the status separately) and record the checked-out SHA. Do not treat fetch/checkout as authorization granted to this docs delegate. Parent/executor verifies remote checkout ownership before use. Record a green **complete exact-head CI rollup**, not an empty required-check list. New or modified source-oracle guards, if discovered, must be driven red and restored before claiming green. No test runner is installed for this plan.

Use `git diff --check`, `git diff --numstat <base>...HEAD` and move-aware diff inspection to prove only declaration moves/import rewiring. Compare all original exports (including erased types) to the explicit inventory. Re-run the lane-G import graph check, including type edges; a clean typecheck alone does not prove acyclicity.

## Accept criteria

1. Every declaration in the inventory has exactly one owner after the split; no duplicated mutable state or constants, and no omitted declaration.
2. All 10 original exported names remain importable from `src/lab/projection/verification` with the same signatures/identity; the named re-export and local-import blocks above are present exactly where needed.
3. The 1 new leaves have expected counts 84; residual expected 334. Actual `wc -l` is ≤400 for every one. No hidden #b or sixth stack layer is assumed.
4. Existing function bodies, comparison ordering, errors, cleanup/finally behavior, and allocation timing are unchanged apart from export visibility needed by the private leaf seam. No new upward or facade-back import; static/type/dynamic graph has no newly introduced cycle.
5. All direct tests keep original imports; all identified text-oracle dispositions are implemented without weakening. The named deliberate red mutation fails for the intended reason and is fully removed before the final green run.
6. The instantiated local focused/domain, typecheck and privacy gates plus the remote-only full suite pass on the recorded layer SHA, and its complete exact-head CI is green. No local full suite.
7. The PR contains only this layer's pure move and necessary existing-test additions, retains the parent branch base, and includes the full five-layer stack map. Any raw changeset above 500 lines is returned for explicit parent review; do not expand the authorized topology silently.

## PR

Title: `refactor(lab-projection): isolate suite artifact parsing (split S16 L4/5)`

Branch: `codex/split-lab-projection-verification`. Base: `dev`. Closes: none.

Use every section of `.github/PULL_REQUEST_TEMPLATE.md` (Summary, Verification, Checklist); include the pure-move thesis, planned/actual counts, gate evidence and this DEV-STACK-03 map. The placeholders below are intentional pre-creation PR numbers, not existing PRs.

| # | PR | Layer | Branch | Base | Review focus |
|---|---|---|---|---|---|
| 1 | #TBD-S16-L1 | 530 | `codex/split-lab-conformance-executor` | `dev` | separate scenario transport and vector families |
| 2 | #TBD-S16-L2 | 540 | `codex/split-lab-automation-persistence` | `dev` | isolate the state-file lock owner |
| 3 | #TBD-S16-L3 | 550 | `codex/split-lab-public-community` | `dev` | extract bounded community input validation |
| 4 | #TBD-S16-L4 | 560 — this PR | `codex/split-lab-projection-verification` | `dev` | isolate suite artifact parsing |
| 5 | #TBD-S16-L5 | 570 | `codex/split-lab-projection-verdicts` | `codex/split-lab-projection-verification` | separate projection keys and claim reduction |

Base: dev — no dependency on lower layers; this layer is the parent of 570 (branch based on it), so any change here cascades into that layer with `git rebase --update-refs` + `--force-with-lease` before review (DEV-STACK-02). Every layer passes independently. Merge remains separately user-authorized; never merge or enable auto-merge as part of this plan.
