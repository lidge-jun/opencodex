# 570 — S16 L5/5: src/lab/projection/verdicts.ts

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: pure-move. Work class: C3 architecture planning, docs-only delegated scope. Parent owns orchestration, loop and goal state; this document executes none of them.
- Goal: split `src/lab/projection/verdicts.ts` (474 lines) into the named leaves while preserving all current exports, signatures, object identities and behavior.
- Non-goals: no behavior fixes, public identifier renames, schema changes, new dependencies, import-consumer churn, function-body rewrites, core-root edits, merge, release or deployment. No code/test/git-state mutation in this drafting task.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below. Current planning basis is docs HEAD `4cc219549`, code `origin/dev = 1362b1a38`; `git diff origin/dev -- src/lab/projection/verdicts.ts` is empty. All source line anchors below refer to that code basis, not future leaf line numbers.
- Stop: drafting ends after this plan's declaration/export/state/test inventory is checked. Implementation ends only when its independent per-layer gates and exact-head CI evidence are recorded; no merge is authorized by this document.
- Escalation: stop implementation and return to the parent if source drift invalidates the partition, an export/identity changes, an oracle cannot move without weakening, a new cycle appears, any residual/leaf exceeds 400, or the fixed layer scope needs expansion. Do not create an unplanned #b or edit 002 from this task.

Layer 5 uses the original verification.ts interface preserved by L4; it must not opportunistically retarget callers to L4's parser leaf. No #b or sixth layer is needed for file size.

## Symbol inventory

Origin/dev declaration spans were enumerated with `sg run --lang ts --kind 'function_declaration,lexical_declaration,interface_declaration,type_alias_declaration,export_statement' --json=compact src/lab/projection/verdicts.ts`, keeping column-zero declarations; exported declarations are counted once. Imports are not redeclarations of their source owners: original import block is src/lab/projection/verdicts.ts:1–22, and the exact post-split imports appear below.

Consumer counts mean **direct importing/re-exporting modules**, not occurrences or transitive barrel consumers. Resolved relative import clauses were checked with `rg -q -w <symbol>`; namespace imports and wildcard re-exports count once for every exported symbol. Non-exported declarations have zero external consumers. `rg --files src gui/src scripts tests` supplied the search universe. Module fan-in is 2; the mechanically requested basename-only gate returns 2.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `ProjectionKey` | interface | 24–31 | yes | 1 | `verdict-keys.ts` |
| `componentKey` | function | 33–35 | no | 0 | `verdict-keys.ts` |
| `projectionKeyString` | function | 37–46 | yes | 2 | `verdict-keys.ts` |
| `claimKeyString` | function | 48–50 | yes | 2 | `verdict-keys.ts` |
| `DerivedVerdict` | interface | 52–61 | yes | 1 | `verdicts.ts (residual)` |
| `ClaimState` | interface | 63–68 | yes | 1 | `verdict-claims.ts` |
| `ProjectVerdictsOptions` | interface | 70–78 | yes | 1 | `verdicts.ts (residual)` |
| `resolveClaimStates` | function | 84–167 | yes | 2 | `verdict-claims.ts` |
| `supportedClaimsForSubject` | function | 169–177 | no | 0 | `verdict-claims.ts` |
| `projectVerdicts` | function | 182–292 | yes | 2 | `verdicts.ts (residual)` |
| `isMatchedCapabilityAbsenceControl` | function | 294–302 | no | 0 | `verdicts.ts (residual)` |
| `evaluateRequiredPassVerdict` | function | 304–346 | no | 0 | `verdicts.ts (residual)` |
| `projectObservationGroup` | function | 348–466 | no | 0 | `verdicts.ts (residual)` |
| `excludeEventIds` | function | 468–472 | yes | 2 | `verdicts.ts (residual)` |
| `isEventExcluded` | re-export | 474–474 | yes | 1 | `verdicts.ts (residual)` |

Direct production consumers / public boundaries, all preserved:

- `src/lab/index.ts:13`.
- `src/lab/projection/rebuild.ts:18`.

## Leaf partition

Structural decision: Separate canonical JCS component keys and claim supersession reduction; retain observation verdict precedence and orchestration in verdicts.ts. verdicts → verdict-claims → verdict-keys → digest, with verdicts → verdict-keys too. Reject extracting resolveClaimStates alone with claimKeyString imported from verdicts: that would create a direct cycle. Reject moving observation projection as well because the claim/key partition alone meets the file limit. Keep the original src/lab/index.ts export boundary and all rebuild imports.

Sibling convention evidence: `src/lab/projection/schema.ts`, `rebuild.ts` and `verification.ts` are concern-named siblings; verdict-keys/verdict-claims retain projection ownership instead of moving generic key utilities into src/lib.

The existing lane-016 inventory replaces an extra map command. Search evidence: `rg --files src/lab/projection`, exact symbol searches and the direct-consumer inventory above; existing owners are reused, not copied. Doing nothing leaves the approved file-size debt; deletion/configuration would change behavior. Blast radius: local Lab feature plus unchanged entry-path consumers.

Expected counts below are an in-memory plan calculation: original complete declaration bodies and attached comments, the imports shown here, named re-exports, and one blank line between declarations. They are not a claim of executed source changes. Formatting may change the exact number; implementation must run wc and still stay ≤400. Private declarations listed in each leaf's “leaf exports” gain only the internal import seam; they are **not** added to the original public export surface.

### `src/lab/projection/verdict-keys.ts` — expected 29 lines

Symbols: `ProjectionKey`, `componentKey`, `projectionKeyString`, `claimKeyString`.

Leaf exports: `ProjectionKey`, `projectionKeyString`, `claimKeyString`. Everything else in this leaf stays private.

Own imports (exact):

```ts
import { jcsStringify } from "../digest";
```

### `src/lab/projection/verdict-claims.ts` — expected 108 lines

Symbols: `ClaimState`, `resolveClaimStates`, `supportedClaimsForSubject`.

Leaf exports: `ClaimState`, `resolveClaimStates`, `supportedClaimsForSubject`. Everything else in this leaf stays private.

Own imports (exact):

```ts
import type { ClaimSnapshotEvent, LedgerCorruption } from "../events/types";
import { claimKeyString } from "./verdict-keys";
```

### Residual `src/lab/projection/verdicts.ts` — expected 333 lines

Retains: `DerivedVerdict`, `ProjectVerdictsOptions`, `projectVerdicts`, `isMatchedCapabilityAbsenceControl`, `evaluateRequiredPassVerdict`, `projectObservationGroup`, `excludeEventIds`, `isEventExcluded`.

No #a/#b/#c subdivision: the whole file's assigned work is this layer, and no residual exceeds 400. There is no unnamed later remainder. Upstream imports retained by the residual, in addition to the local imports in the next section:

```ts
import type { CompatibilityVerdict } from "../constants";
import { LAB_PROJECTION_SPEC_VERSION } from "../constants";
import type { SuiteManifestV1 } from "../conformance/suite-manifest";
import type { LabEvent, LedgerCorruption, ObservationEvent } from "../events/types";
import { buildInvalidationIndex, isEventExcluded, usableClaims, usableObservations, type InvalidationIndex } from "../ledger/invalidation";
import { evaluateAllApplicableRequiredPassV1, newestObservationByScenario, type ScenarioRequirements } from "./verification";
```

## Re-export block

Add exactly these compatibility re-exports to `src/lab/projection/verdicts.ts`:

```ts
export { projectionKeyString, claimKeyString } from "./verdict-keys";
export type { ProjectionKey } from "./verdict-keys";
export { resolveClaimStates } from "./verdict-claims";
export type { ClaimState } from "./verdict-claims";
```

Retained exports in the original file: `DerivedVerdict`, `ProjectVerdictsOptions`, `projectVerdicts`, `excludeEventIds`, `isEventExcluded`. In particular, retain the exact existing `export { isEventExcluded };` at origin/dev:474, with its local import from `../ledger/invalidation`. No wildcard or renamed re-export is introduced. This is preservation of an existing boundary, not a new internal convenience barrel.

Explicit local imports required by residual call sites (re-exporting binds nothing):

```ts
import { projectionKeyString } from "./verdict-keys";
import type { ProjectionKey } from "./verdict-keys";
import { resolveClaimStates, supportedClaimsForSubject } from "./verdict-claims";
```

## Module-level state and cycles

No module-level let/Map/Set/WeakMap/lock exists. The Maps/Sets in resolveClaimStates (:94–115), supportedClaimsForSubject (:170), projectVerdicts (:188–208), projectObservationGroup (:366/:382) and excludeEventIds (:469) are per invocation; none becomes a shared cache. ClaimState belongs only to verdict-claims.ts, ProjectionKey only to verdict-keys.ts. Neither leaf imports verdicts.ts, verification.ts or rebuild.ts; verdicts keeps its existing verification dependency. This is functional/sequential coupling with no new common state. isEventExcluded retains its existing ../ledger/invalidation owner and re-export identity.

Lane 016 reported no return path through this file. The proposed edges above preserve that direction; this is a design argument, not a completed implementation cycle scan. During implementation, repeat lane 016 method G (resolved static imports/exports, type-only edges and literal dynamic imports) for each new leaf and the residual, and require no new cycle. Do not “fix” a cycle with lazy imports or duplicate a type/constant. No protected core root, activation timing or optional-Lab registration seam is changed.

## Tests

Direct test import inventory, from `rg -l 'src/lab/projection/verdicts"' tests` with relative specifiers resolved and hits inspected:

None (zero direct test importers). Do not interpret this as zero coverage: the barrel-mediated tests below exercise the public API.

Additional indirect/guard coverage (all unchanged unless a narrowly described case is added below):

- `tests/lab/lab-evidence-ledger.test.ts`.
- `tests/lab/lab-post-merge-projection.test.ts`.

Text-oracle inventory: **zero tests read this specific file as source**. Checked `rg -n '(executor\\.ts|persistence\\.ts|community\\.ts|verification\\.ts|verdicts\\.ts)' tests`, qualified source paths and candidate reader bodies. Therefore retarget-to-leaf = none; add-leaf-to-scan-list = none. Behavioral imports stay unchanged; source-reading tests are not weakened into export-existence checks.

The generic boundary guard reads graph nodes at `tests/lab/core-lab-boundary.test.ts:69` and its composition root at :355; its PROTECTED list (:20–28) and reader paths are unchanged. It discovers relative graph edges without a new leaf scan list. Never retarget or edit the protected production roots to accommodate this split.

No direct source-text test or retarget exists. Drive tests/lab/lab-evidence-ledger.test.ts:475's conflicting-current-claims assertion red once by temporarily suppressing the multiple-unsuperseded-claims corruption in verdict-claims.ts; restore immediately. Also retain supersession (:465), projectVerdicts empty/replay behavior (:1031/:1038) and the capability-absence precedence regression at tests/lab/lab-post-merge-projection.test.ts:155.

## Verification

This is the `002_layer_map.md` Per-layer gate instantiated for S16 L5. These are **future implementation commands**, not tests run by this docs-only delegate. Run at this layer's own tip, not the top of the stack. Focused domains: tests/lab.

```sh
bun run typecheck
bun test tests/lab/lab-evidence-ledger.test.ts tests/lab/lab-post-merge-projection.test.ts
bun test tests/lab
bun run privacy:scan
# No src/server, src/router or src/lib edit: 002's extra core-boundary command is not triggered.
wc -l src/lab/projection/verdict-keys.ts src/lab/projection/verdict-claims.ts src/lab/projection/verdicts.ts
rg -n 'from "[^"]*/verdicts"' src gui/src scripts tests | wc -l
# Full suite only on the designated remote, never in this local worktree:
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-lab-projection-verdicts && git checkout -q FETCH_HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15'
```

Focused commands overlapping the full lab domain need not be repeated on unchanged code: capture the focused red/green during the move, then domain coverage once at the final tip. Typecheck/privacy must exit 0; tests must report zero failures. The basename-only rg baseline is 2; the resolved exact-module fan-in must remain 2. Leaf names deliberately do not end in /verdicts, so they do not inflate that gate. Recount against the actual parent if upstream changes.

The inherited remote pipeline's tail status alone is not proof of a passing Bun process: capture its complete test result and actual test exit status (enable pipefail or retain the status separately) and record the checked-out SHA. Do not treat fetch/checkout as authorization granted to this docs delegate. Parent/executor verifies remote checkout ownership before use. Record a green **complete exact-head CI rollup**, not an empty required-check list. New or modified source-oracle guards, if discovered, must be driven red and restored before claiming green. No test runner is installed for this plan.

Use `git diff --check`, `git diff --numstat <base>...HEAD` and move-aware diff inspection to prove only declaration moves/import rewiring. Compare all original exports (including erased types) to the explicit inventory. Re-run the lane-G import graph check, including type edges; a clean typecheck alone does not prove acyclicity.

## Accept criteria

1. Every declaration in the inventory has exactly one owner after the split; no duplicated mutable state or constants, and no omitted declaration.
2. All 10 original exported names remain importable from `src/lab/projection/verdicts` with the same signatures/identity; the named re-export and local-import blocks above are present exactly where needed.
3. The 2 new leaves have expected counts 29, 108; residual expected 333. Actual `wc -l` is ≤400 for every one. No hidden #b or sixth stack layer is assumed.
4. Existing function bodies, comparison ordering, errors, cleanup/finally behavior, and allocation timing are unchanged apart from export visibility needed by the private leaf seam. No new upward or facade-back import; static/type/dynamic graph has no newly introduced cycle.
5. All direct tests keep original imports; all identified text-oracle dispositions are implemented without weakening. The named deliberate red mutation fails for the intended reason and is fully removed before the final green run.
6. The instantiated local focused/domain, typecheck and privacy gates plus the remote-only full suite pass on the recorded layer SHA, and its complete exact-head CI is green. No local full suite.
7. The PR contains only this layer's pure move and necessary existing-test additions, retains the parent branch base, and includes the full five-layer stack map. Any raw changeset above 500 lines is returned for explicit parent review; do not expand the authorized topology silently.

## PR

Title: `refactor(lab-projection): separate projection keys and claim reduction (split S16 L5/5)`

Branch: `codex/split-lab-projection-verdicts`. Base: `codex/split-lab-projection-verification`. Closes: none.

Use every section of `.github/PULL_REQUEST_TEMPLATE.md` (Summary, Verification, Checklist); include the pure-move thesis, planned/actual counts, gate evidence and this DEV-STACK-03 map. The placeholders below are intentional pre-creation PR numbers, not existing PRs.

| # | PR | Layer | Branch | Base | Review focus |
|---|---|---|---|---|---|
| 1 | #TBD-S16-L1 | 530 | `codex/split-lab-conformance-executor` | `dev` | separate scenario transport and vector families |
| 2 | #TBD-S16-L2 | 540 | `codex/split-lab-automation-persistence` | `dev` | isolate the state-file lock owner |
| 3 | #TBD-S16-L3 | 550 | `codex/split-lab-public-community` | `dev` | extract bounded community input validation |
| 4 | #TBD-S16-L4 | 560 | `codex/split-lab-projection-verification` | `dev` | isolate suite artifact parsing |
| 5 | #TBD-S16-L5 | 570 — this PR | `codex/split-lab-projection-verdicts` | `codex/split-lab-projection-verification` | separate projection keys and claim reduction |

Depends on #TBD-S16-L4 (`codex/split-lab-projection-verification`); review only this layer's diff against that parent. Every layer passes independently. Changes to the real parent, S16 L4 (`codex/split-lab-projection-verification`), require a parent-owned cascade to S16 L5 and fresh exact-head checks for L5 (DEV-STACK-02). No cascade dependency on S16 L1–L3. Bottom-up merge of L4 then L5 remains separately user-authorized; never merge or enable auto-merge as part of this plan.
