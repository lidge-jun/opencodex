# 480 — S15 L1/5: src/lab/events/validate.ts

> Historical record imported from `ddb7013ac0c58e513c651d54a96e07f52ac0efbe`. Deferred before implementation; archival proposal only. Continue-goal, before-B admission and worker-implementation instructions below are disabled by the cutoff.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: satisfy-spec through a `pure-move` partition; C3 module refactor with explicit security review of preserved validation/privacy/purge boundaries. cxc-dev §1/§5 and cxc-dev-architecture apply. Main alone owns orchestration, loop and goal state.
- Trigger: the user's68-file modular-debt completion goal and this781-line validator exceeding the400-line file limit.
- Goal: separate field subject and claim validators, with every original public export and behavior preserved.
- Non-goals: no behavior fixes, new validation, renamed symbols, signature changes, new dependencies, expansion of the original public surface, core activation changes, releases or live-service changes. No ledger/storage/fabric implementation is included.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below; full tests only on `ssh lidge`, never locally.
- Stop: independent layer-tip verification, fresh exact-head CI and admin landing with expected-head/tree and fetched-dev ancestry proof. Close D, then continue the remaining goal. Do not stop on an ordinary wait timeout.
- Escalation: source drift, unexpected oracle coupling, new cycle, public export loss, changed state lifetime, any scope expansion, or the size-budget conflict below goes to the parent. Do not add a sixth stack layer or edit 002 here.
- Basis: selected published dev `0aae940d63be96481b469363a248e7c92bcac659`, following the verified WP450 delivery09335d7d4. Lab source/tests and build inputs remain byte-identical to093; validate.ts and the ledger test still match the original1362b1a38 inventory. Original source ranges remain valid. The selected-input section below defines admission and the B-stage merge; no unreviewed newer source may be substituted.
- Execution: same app-managed a2c0 worktree, branch `codex/split-lab-events-validate`; preserve completed branches and all checkpoint refs. All tests/typecheck/builds run in an isolated remote checkout on lidge. No peer-task communication or CI-slot arbitration.
- Scope and resources: five planned source files, bounded existing-test changes, one Lab SOT ownership section, and carried000/003/480 documents. Existing GitHub/SSH credentials only, never printed. User authorized unlimited time/tokens and gpt-6-astra high internal delegation; main reclaims a worker packet after two distinct failed workers. No host goal/FSM ownership is delegated.
- Memory artifact: this480 document, the bound goalplan/ledger, and session-local baseline/receipt/mutation artifacts under `.codexclaw/evidence/01a06e97-b9d8-7250-8204-bb788338c288/`.
- Expected outcomes: DONE means this layer's verified admin delivery; NOOP requires evidence the boundary is already fully resolved upstream; external verification failure leaves it unverified, and an unsafe semantic/scope change requires a new plan rather than a waiver. Other goal units remain open.
- Delegation boundary: an internal worker owns only the five named source files and bounded ledger-test changes after B entry; main owns SOT/docs/Git and execution. Any new downward scope is a P amendment, not a mid-B improvisation. No peer-task communication.
- Prior audited seam: `devlog/_plan/260905_modular_debt_ledger/016_lane_cli_storage_usage_update_lab_scripts.md:206`. Read together with 000, 001, 002; actual consumer/oracle evidence below supersedes the approximate basename-based counts in 001.

Structural decision before implementation: Current: artifacts/store.ts:12, ledger/store.ts:19, fabric/observe.ts:14 and lab/index.ts:5 consume this boundary; it imports limits/errors/constants/digest/conformance types/event types (1–48). The 781-line boundary mixes observation construction, common assertions, subjects and claims. Chosen: extract four existing cohesive groups; retain observation validation and dispatch. Rejected: a single 445-line leaf violates the leaf limit; copying common assertions would create two owners. No new runtime abstraction or validation rule is introduced.

## Symbol inventory

Measured by `sg run --lang ts --kind 'function_declaration,interface_declaration,type_alias_declaration,lexical_declaration' --json=compact src/lab/events/validate.ts`, matched to column-zero declarations in the pinned source. Nested declarations are excluded. Ranges include declaration syntax through its closing line, not preceding comments.

Consumers are distinct direct import/re-export files across `src gui/src scripts tests`, found with `rg -l` path/symbol searches and verified against the actual import binding. A wildcard re-export counts once for every public symbol; a dynamic namespace import counts for runtime exports, not erased types. Private declarations have zero external consumers, even if unrelated same-named declarations occur elsewhere. Transitive barrel clients are covered by the Lab domain gate, not double-counted. Total direct module consumers: **10**.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| isPlainObject | function | 50–52 | no | 0 | src/lab/events/validate-fields.ts |
| assertString | function | 54–60 | no | 0 | src/lab/events/validate-fields.ts |
| assertIntMs | function | 62–67 | no | 0 | src/lab/events/validate-fields.ts |
| assertClosed | function | 69–74 | no | 0 | src/lab/events/validate-fields.ts |
| utf8LexLess | function | 76–85 | no | 0 | src/lab/events/validate-fields.ts |
| validateSortedUniqueHexIds | function | 88–116 | yes | 1 | src/lab/events/validate-fields.ts |
| validateArtifactRef | function | 118–136 | no | 0 | src/lab/events/validate.ts |
| validateProtocolSubject | function | 138–152 | no | 0 | src/lab/events/validate-subject.ts |
| validateRouteSubject | function | 154–191 | no | 0 | src/lab/events/validate-subject.ts |
| validateTaskSubject | function | 193–211 | no | 0 | src/lab/events/validate-subject.ts |
| validateSubject | function | 213–230 | yes | 2 | src/lab/events/validate-subject.ts |
| stripEventId | function | 232–235 | no | 0 | src/lab/events/validate.ts |
| enforceEventId | function | 237–242 | no | 0 | src/lab/events/validate.ts |
| enforceSerializedSize | function | 244–249 | no | 0 | src/lab/events/validate.ts |
| validateAssertionRecord | function | 251–273 | no | 0 | src/lab/events/validate.ts |
| validateObservationLimits | function | 275–293 | no | 0 | src/lab/events/validate.ts |
| validateObservationEnvironment | function | 295–320 | no | 0 | src/lab/events/validate.ts |
| validateExpectedFailure | function | 322–351 | no | 0 | src/lab/events/validate.ts |
| validateSourceRefs | function | 353–356 | no | 0 | src/lab/events/validate.ts |
| validateObservation | function | 358–433 | no | 0 | src/lab/events/validate.ts |
| validateClaimSnapshot | function | 435–471 | no | 0 | src/lab/events/validate-control-events.ts |
| validateInvalidation | function | 473–487 | no | 0 | src/lab/events/validate-control-events.ts |
| validatePurge | function | 489–544 | no | 0 | src/lab/events/validate-control-events.ts |
| validateLabEvent | function | 547–576 | yes | 4 | src/lab/events/validate.ts |
| FORBIDDEN_FACT_KEYS | const | 578–591 | no | 0 | src/lab/events/validate-claim-source.ts |
| ALLOWED_FACT_KEYS | const | 593–603 | no | 0 | src/lab/events/validate-claim-source.ts |
| validateFacts | function | 605–668 | no | 0 | src/lab/events/validate-claim-source.ts |
| validateResolvedEvidence | function | 670–704 | no | 0 | src/lab/events/validate-claim-source.ts |
| validateClaimSourceManifest | function | 707–752 | yes | 2 | src/lab/events/validate-claim-source.ts |
| assignEventId | function | 754–760 | yes | 5 | src/lab/events/validate.ts |
| artifactClassMediaType | function | 762–781 | yes | 2 | src/lab/events/validate.ts |
| LabValidationError | existing named re-export | 3–3 | yes | 4 | src/lab/events/errors.ts (unchanged owner) |

Direct edge evidence (including public re-exports):

- `src/lab/index.ts:5` — *.
- `src/lab/observe/from-conformance.ts:19` — assignEventId.
- `src/lab/observe/from-live.ts:7` — assignEventId.
- `src/lab/ledger/store.ts:19` — LabValidationError, validateLabEvent.
- `src/lab/ledger/invalidation.ts:9` — LabValidationError.
- `src/lab/ledger/purge.ts:16` — assignEventId, validateLabEvent.
- `src/lab/fabric/observe.ts:14` — assignEventId, validateSubject.
- `src/lab/artifacts/store.ts:12` — artifactClassMediaType, validateClaimSourceManifest.
- `src/lab/query/dto-map.ts:12` — validateLabEvent.
- `tests/lab/lab-evidence-ledger.test.ts:42` — LabValidationError.

Import declarations are not new owners: their exact leaf/residual binding allocations are given below. No default export exists.

## Leaf partition

Reuse the existing same-directory sibling convention: `events/limits.ts`, `events/errors.ts`, `ledger/artifact-refs.ts`, `artifacts/secure-fs.ts`, `fabric/producer-protocol.ts`. The five source directories and proposed names were inspected with `rg --files`; none of the new paths exists at the pinned source. No new index/barrel, generic utils module, package or directory is needed. The original paths are compatibility boundaries explicitly retained by the split-train contract, not new internal convenience barrels.

Move complete source slices with their inline/leading comments as listed; only add the listed imports, named re-exports and leaf-local export modifiers needed by other leaves/the residual. Never re-export formerly private implementation helpers from the original public path.

### src/lab/events/validate-fields.ts

- Original slices: `src/lab/events/validate.ts:50–116`.
- Symbols: `isPlainObject`, `assertString`, `assertIntMs`, `assertClosed`, `utf8LexLess`, `validateSortedUniqueHexIds`.
- Expected lines: **71** = 67 moved lines + 4 import/header-separator lines + 0 inter-slice separators; ≤400.
- Additional leaf-only exports for existing cross-partition calls: `isPlainObject`, `assertString`, `assertIntMs`, `assertClosed`.
- Own imports:

```ts
import { LabValidationError } from "./errors";
import { MAX_SANITIZED_STRING_FIELD } from "../constants";
import { isSha256Hex } from "../digest";
```

### src/lab/events/validate-subject.ts

- Original slices: `src/lab/events/validate.ts:138–230`.
- Symbols: `validateProtocolSubject`, `validateRouteSubject`, `validateTaskSubject`, `validateSubject`.
- Expected lines: **98** = 93 moved lines + 5 import/header-separator lines + 0 inter-slice separators; ≤400.
- Additional leaf-only exports for existing cross-partition calls: none; preserve existing exported declaration modifiers.
- Own imports:

```ts
import { isPlainObject, assertString } from "./validate-fields";
import { LabValidationError } from "./errors";
import type { EvidenceLayer } from "../constants";
import type { EvidenceSubjectV1, ProtocolSubjectV1, RouteSubjectV1, TaskSubjectV1 } from "./types";
```

### src/lab/events/validate-claim-source.ts

- Original slices: `src/lab/events/validate.ts:578–752`.
- Symbols: `FORBIDDEN_FACT_KEYS`, `ALLOWED_FACT_KEYS`, `validateFacts`, `validateResolvedEvidence`, `validateClaimSourceManifest`.
- Expected lines: **181** = 175 moved lines + 6 import/header-separator lines + 0 inter-slice separators; ≤400.
- Additional leaf-only exports for existing cross-partition calls: none; preserve existing exported declaration modifiers.
- Own imports:

```ts
import { isPlainObject, assertString, assertClosed } from "./validate-fields";
import { LabValidationError } from "./errors";
import { CLAIM_SOURCE_KINDS, type ClaimSourceKind } from "../constants";
import { claimSourceManifestDigest, isSha256Hex } from "../digest";
import type { ClaimCapabilityFactsV1, ClaimSourceManifestV1, ClaimSourceV1, RouteCapabilityEvidenceV1 } from "./types";
```

### src/lab/events/validate-control-events.ts

- Original slices: `src/lab/events/validate.ts:435–544`.
- Symbols: `validateClaimSnapshot`, `validateInvalidation`, `validatePurge`.
- Expected lines: **117** = 110 moved lines + 7 import/header-separator lines + 0 inter-slice separators; ≤400.
- Additional leaf-only exports for existing cross-partition calls: `validateClaimSnapshot`, `validateInvalidation`, `validatePurge`.
- Own imports:

```ts
import { assertString, assertIntMs, assertClosed, validateSortedUniqueHexIds } from "./validate-fields";
import { validateSubject } from "./validate-subject";
import { LabValidationError } from "./errors";
import { LAB_EVENT_SCHEMA_VERSION, MAX_INVALIDATION_TARGETS, CLAIM_POLARITIES, INVALIDATION_REASONS, PURGE_ACTIONS } from "../constants";
import { subjectIdForSubject, isSha256Hex } from "../digest";
import type { ClaimSnapshotEvent, RouteSubjectV1, InvalidationEvent, PurgeTombstoneEvent } from "./types";
```

Residual `src/lab/events/validate.ts`: **301 expected lines**. Retained declarations: `validateArtifactRef`, `stripEventId`, `enforceEventId`, `enforceSerializedSize`, `validateAssertionRecord`, `validateObservationLimits`, `validateObservationEnvironment`, `validateExpectedFailure`, `validateSourceRefs`, `validateObservation`, `validateLabEvent`, `assignEventId`, `artifactClassMediaType`.

Line accounting: 781 logical source lines − 445 moved lines − 48 original import/header lines + 13 explicit import/re-export lines = 301. Keep formatting compact as shown; extra formatting lines must still fit the 400-line gate. No residual exceeds 400; no #b layer is required for file size.

Changeset accounting:445 original lines move, giving890 raw move lines before import glue. This exceeds the default500 raw-line threshold; it uses the already approved003 PURE-MOVE-SIZE-01 exception for a single cohesive validator boundary. Measure and report raw churn separately; non-move wiring/test changes must remain at most150. Moved body/comment identity and all31owners require explicit review. This is not a claim that the raw diff is below500 and does not relax the leaf/residual400-line limit.

## Re-export block

Exact named re-exports to add/retain at the original path:

```ts
export { LabValidationError } from "./errors";
export { validateSortedUniqueHexIds } from "./validate-fields";
export { validateSubject } from "./validate-subject";
export { validateClaimSourceManifest } from "./validate-claim-source";
```

validateLabEvent, assignEventId and artifactClassMediaType remain exported declarations.

Explicit local imports for the residual (replace the original import block); re-export statements bind nothing locally:

```ts
import { enforceEventStructureLimits } from "./limits";
import { LabValidationError } from "./errors";
import { ARTIFACT_CLASSES, ARTIFACT_FILENAME_EXT, EVIDENCE_LAYERS, EVENT_KINDS, EXECUTION_MODES, LAB_EVENT_SCHEMA_VERSION, MAX_SERIALIZED_EVENT_BYTES, OBSERVATION_LIMIT_NAMES, OUTCOMES, type ArtifactClass, type LabEventKind } from "../constants";
import { eventIdForPayload, isSha256Hex, jcsStringify, subjectIdForSubject } from "../digest";
import { FAILURE_CLASSIFICATIONS } from "../conformance/types";
import type { ArtifactRefV1, LabEvent, ObservationEvent } from "./types";
import { isPlainObject, assertString, assertIntMs, assertClosed } from "./validate-fields";
import { validateSubject } from "./validate-subject";
import { validateClaimSnapshot, validateInvalidation, validatePurge } from "./validate-control-events";
```

The residual does not call validateClaimSourceManifest or validateSortedUniqueHexIds after control-event extraction; do not add unused local imports for them.

## Module-level state and cycles

The only top-level collections are `FORBIDDEN_FACT_KEYS` at 578–591 and `ALLOWED_FACT_KEYS` at 593–603: both move once to `validate-claim-source.ts`, remain private, and are read-only by convention. No top-level let, Map, WeakMap or lock exists. Sets inside validation functions (253, 304, 324, 714) stay per-call and are not hoisted.
Dependency direction: original → control-events → subject → fields → errors/constants/digest/types; claim-source → fields. In particular, moving control events without moving sorted-ID validation would create control-events → original → control-events; the shared field leaf removes that edge. No leaf imports `./validate` or `../index`. Preserve the existing single LabValidationError class in errors.ts rather than creating another class identity.

Existing lane evidence found no cycle through this file. Recheck the concrete resolved graph at implementation tip, including type-only edges; typecheck alone does not prove acyclicity. This plan introduces only the directed edges above. Do not change protected core roots, turn startServer async, or add activation imports into them.

## Tests

Original direct import/dynamic-import test `rg -l` list; retain its existing public import paths:

- `tests/lab/lab-evidence-ledger.test.ts` — existing class import at42 and Lab barrel bindings stay; add the narrowly scoped identity/assertion checks below.

Discovery commands (run across all tests, not just tests/lab):

```sh
rg -l 'src/lab/events/validate' tests --glob '*.ts'
rg -n 'src/lab/events/validate|validate\.ts' tests --glob '*.ts'
rg -n 'readFileSync|Bun\.file|readFile\(|source\(' tests --glob '*.ts'
```

Dedicated source-text readers of this file: **none found**. No retarget-to-leaf or add-leaf-to-scan-list is required for a dedicated source oracle.
The generic `tests/lab/core-lab-boundary.test.ts` reads traversed source at **69**, protected roots at **278/336**, and the server composition source at **355**. It reports the first edge into Lab before traversing that target, so these Lab leaves are not dedicated source-text inputs on a successful run. Disposition: **unchanged**, no scan-list addition, never edit `PROTECTED` (20–28). Include its existing negative-fixture cases in the implementation gate.

Additional transitive-barrel/behavioral coverage: `tests/lab/lab-fabric-outcome-validation.test.ts` — unchanged; `tests/lab/lab-post-merge-hardening.test.ts` — unchanged. Run `tests/lab` for all indirect callers.

### Concrete regression changes

Reuse the existing CL-02 invalidation-validation group at345. Do not add a
new fixture helper, test file, registry entry or broad test split. Searches
found its existing sorted-ID assertions and a private invalidation fixture in
another test file; importing that test would execute an unrelated suite.
The1220-line ledger test is existing test debt: this layer adds only bounded
binding/guard assertions beside its current oracle, not a test-architecture
rewrite.

Add five imports next to the existing validator import: the facade namespace
as `eventValidation`, the canonical error class from `events/errors` as
`CanonicalLabValidationError`, and the three moved public functions from
their leaves as `fieldSortedIds`, `subjectValidator`, and
`claimManifestValidator`. Add one test named
`event validator facade preserves public bindings and hides private helpers`:

```ts
expect(Object.keys(eventValidation).sort()).toEqual([
  "LabValidationError", "artifactClassMediaType", "assignEventId",
  "validateClaimSourceManifest", "validateLabEvent", "validateSortedUniqueHexIds", "validateSubject",
]);
expect(LabValidationError).toBe(CanonicalLabValidationError);
expect(eventValidation.validateSortedUniqueHexIds).toBe(fieldSortedIds);
expect(eventValidation.validateSubject).toBe(subjectValidator);
expect(eventValidation.validateClaimSourceManifest).toBe(claimManifestValidator);
expect(validateSortedUniqueHexIds).toBe(fieldSortedIds);
expect(validateClaimSourceManifest).toBe(claimManifestValidator);
```

In the existing `rejects unsorted, duplicate, empty, and oversize target lists`
test, retain the empty and valid-list assertions, make the unsorted assertion
require `UTF-8 lexicographically sorted`, and the duplicate assertion require
`contains duplicates`. Add the missing oversize assertion:
`expect(() => validateSortedUniqueHexIds([lo, hi], "t", { max: 1 })).toThrow("exceeds 1")`.
Messages distinguish the duplicate guard from the later sortedness guard,
which would otherwise also throw and hide removal of duplicate validation.

### Named negative controls

Only in the fresh remote C checkout after its normal suite finishes: remove
the moved duplicate-id guard once, require the named rejection test to fail
on the duplicate-message assertion, restore, and require green. Separately
remove the moved UTF-8 ordering guard, require the same named test to fail on
the unsorted assertion, restore, and require green. Each temporary patch is
reversed on exit; final expected HEAD and clean tree are mandatory. Existing
event-ID validation stays in the residual and is not a moved-guard control.
Keep the post-dispatch event-ID → structure-limit → serialized-size chain
unchanged; existing Lab domain tests cover it and the task-subject callers.

### Source-of-truth update

Add an Event validation ownership section to `structure/09_compatibility-lab.md`
with the original facade and the four leaf paths/responsibilities above. State
that `events/errors.ts` remains the one error-class owner and the final guard
order and per-call state stay unchanged. Do not alter the live-route approval,
sanitization, optional-core activation, or compatibility-contract policies.
Read09and11 confirmed those boundaries. No docs-site behavior change is needed.

## Verification

Run from the same a2c0 checkout at C after publishing its clean layer HEAD.
All Bun execution is remote. This adapts the verified WP450 recipe, preserving
receipt-internal local/remote SHA checks, frozen installs, repository Bun1.4.0,
build preparation, full logs, failure propagation and final clean identity.
The three named files directly/transitively exercise this boundary; the Lab
domain command covers indirect consumers and core-lab-boundary.test.ts.

```bash
#!/usr/bin/env bash
set -euo pipefail
wp480_root=$(git rev-parse --show-toplevel)
wp480_expected=$(git rev-parse HEAD)
wp480_status=$(git status --porcelain)
test -z "$wp480_status"
wp480_log="$wp480_root/.codexclaw/evidence/01a06e97-b9d8-7250-8204-bb788338c288/wp480-remote-check-$wp480_expected.log"
mkdir -p "$(dirname "$wp480_log")"
cxc receipt test --cwd "$wp480_root" --session 01a06e97-b9d8-7250-8204-bb788338c288 -- bash -c '
set -euo pipefail
test "$(git rev-parse HEAD)" = "$1"
local_status=$(git status --porcelain)
test -z "$local_status"
ssh lidge bash -s -- "$1" 2>&1 | tee "$2"
test "$(git rev-parse HEAD)" = "$1"
local_status=$(git status --porcelain)
test -z "$local_status"
' -- "$wp480_expected" "$wp480_log" <<'REMOTE'
set -euo pipefail
expected=${1:?expected SHA required}
[[ "$expected" =~ ^[0-9a-f]{40}$ ]]
run_dir=$(mktemp -d /tmp/ocx-wp480.XXXXXX)
printf 'RETAINED_RUN_DIR=%s\n' "$run_dir"
git clone --no-checkout https://github.com/lidge-jun/opencodex.git "$run_dir/repo"
cd "$run_dir/repo"
git fetch origin refs/heads/codex/split-lab-events-validate
test "$(git rev-parse FETCH_HEAD)" = "$expected"
git checkout --detach "$expected"
bun install --frozen-lockfile
export PATH="$PWD/node_modules/.bin:$PATH"
test "$(bun --version)" = 1.4.0
(cd gui && bun install --frozen-lockfile && bun run build)
tree_status=$(git status --porcelain)
test -z "$tree_status"
printf 'CHECKOUT=%s\nHEAD=%s\n' "$PWD" "$(git rev-parse HEAD)"
unset OCX_TEST_NO_QUEUE
bun run typecheck
bun test tests/lab/lab-evidence-ledger.test.ts tests/lab/lab-fabric-outcome-validation.test.ts tests/lab/lab-post-merge-hardening.test.ts
bun test tests/lab
bun run privacy:scan
if bun run test; then
  test_rc=0
else
  test_rc=$?
fi
printf 'SUITE_EXIT=%s\n' "$test_rc"
if [ "$test_rc" -ne 0 ]; then exit "$test_rc"; fi
test "$(git rev-parse HEAD)" = "$expected"
tree_status=$(git status --porcelain)
test -z "$tree_status"
printf 'VERIFIED_HEAD=%s\n' "$expected"
REMOTE
```

Local checks are static only: `git diff --check`, five source line counts,
AST body/symbol/export comparisons and resolved import-graph review. No local
tests/typecheck/build/install, shared remote checkout switch, tail-only proof,
or substitution of baseline/previous-WP success for this resulting HEAD.
Run the two named field-guard negative controls in that same fresh remote
checkout only after its normal suite ends, restore each and record green.
The source/test non-move budget and raw move churn are recorded separately;
planning/SOT prose is disclosed as documentation, not runtime wiring.

Preserve the original10consumer files and seven public exports. Recheck all
new leaves and the facade for return cycles, including type/literal dynamic
edges. The unchanged error class, module-private Sets, per-call Sets and
final dispatch guard order are explicit review targets. No protected core
source or live-runtime activation is edited.

## Accept criteria

1. Exactly this layer's original source plus the listed 4 new leaves and necessary existing-test adjustments are changed at implementation time; no other S15 file is implemented in this PR.
2. The complete inventory above has exactly one implementation/type owner per declaration; all original public names resolve from `src/lab/events/validate.ts`, with no newly public private helper.
3. Every moved body, constant initializer, comment-backed order and signature matches the pinned source; only import/export plumbing changes.
4. Leaf line counts are 71 for `src/lab/events/validate-fields.ts`, 98 for `src/lab/events/validate-subject.ts`, 181 for `src/lab/events/validate-claim-source.ts`, 117 for `src/lab/events/validate-control-events.ts` (or verified formatted equivalents ≤400); residual is approximately 301, always ≤400. No deferred >400 residual.
5. State owners and operation lifetimes match the state section; resolved import graph has no cycle involving the partition.
6. Direct test imports and all source-oracle dispositions are applied exactly as listed; named guards have recorded red→restored-green evidence, without weakening assertions or editing protected roots.
7. Every instantiated remote gate and exact-tip full suite succeeds; source/consumer inventory, privacy and clean bound receipt are recorded. No local suite.
8. Raw move churn and source/test non-move churn are reported separately under the documented003 exception; the latter stays at most150. Leaf/residual limits are not waived.
9. PR base is `dev`, stack map contains all five layers, and fresh exact-head CI and independent review pass. Admin landing uses expected-head matching; preserve open children and prove actual tree/fetched-dev ancestry.

## PR

Title: `refactor(lab-events): separate field subject and claim validators (split S15 L1/5)`

Branch: `codex/split-lab-events-validate`. Base: `dev`. Closes: **none**.

Use every section of `.github/PULL_REQUEST_TEMPLATE.md` (Summary, Verification, Checklist). Include this full DEV-STACK-03 map; placeholder PR numbers are intentional until the parent creates the PRs. Review only this layer's diff against its base; L1 is the current layer.

| Layer | PR | Branch | Base | Review focus |
|---|---|---|---|---|
| L1/5 | #TBD-S15-L1 | codex/split-lab-events-validate | dev | separate field subject and claim validators |
| L2/5 | #TBD-S15-L2 | codex/split-lab-ledger-store | codex/split-lab-events-validate | isolate ledger lock ownership |
| L3/5 | #TBD-S15-L3 | codex/split-lab-artifacts-sanitize | dev | separate lexical redaction and UTF-8 truncation |
| L4/5 | #TBD-S15-L4 | codex/split-lab-fabric-observe | codex/split-lab-artifacts-sanitize | isolate producer outcome validation |
| L5/5 | #TBD-S15-L5 | codex/split-lab-fabric-scratch | dev | separate scratch access from fixture lifetime |

Base: dev — no dependency on lower layers. If490 is opened while this PR is open, its declared parent is this branch; cascade affected child changes with explicit lease protection while preserving unrelated/checkpoint refs. If this parent has already landed,490 targets dev and must contain the verified parent output. Do not target a deleted parent branch.

Admin landing is authorized by the user's later instruction and003. No peer-task communication or shared-slot approval is required; do not expand into another task's scope.

## Current P continuity

WP450 closed through D after finaldf verification and admin merge09335d7d4;
its post-merge dev CI33964069626 is still monitored. Current branch480 is
based on that09335d7d4 in the same a2c0 worktree, with prior branches/receipts
preserved. Before B, require this base's post-merge result and a fresh base
check; amend/re-audit if relevant input changes.

Main read the complete781-line validator, applicable source instructions,
Lab/compatibility SOT, and the existing invalidation oracle. cxc map confirmed
the declaration anchors. Copernicus independently verified all31owners,
18moved/13retained declarations,69named imports, seven exports and ten legacy
consumer files. Virtual sizes are71/98/181/117/301; closures6/9/9/10/13 have
no root-return cycle or unresolved relative edge. This is static evidence,
not an A approval or runtime result. Source and ledger-test blobs match the
original1362b1a38 baseline.

The existing76-line observation validator,64-line facts validator and56-line
purge validator remain function-level debt. Their bodies are preserved in
this file-boundary move; no function-extraction success is claimed.

P verifier proof: an isolated remote09335d7d4 checkout used frozen dependencies
and repository Bun1.4.0. Build preparation passed; `bun test tests/lab`
executed449tests across53files with0fail, including the named direct/transitive
oracles and core boundary tests. Final baseline HEAD remained clean. Full
output is retained as `wp480-baseline.log` in the session evidence directory.
This validates the newly instantiated domain command, not the future split.
Typecheck/privacy/full-suite commands were already exercised on the identical
WP450-delivered tree and must run again on the changed480 HEAD at C. Both
the baseline and final recipes passed Bash syntax checking; no local test ran.

WP450 post-merge CI33964069626 also completed successfully on09335d7d4.
That previously pending base check is closed. Before B, still refresh the
base and confirm source identity; any changed input receives a P amendment.

## Selected published input after independent upstream progress

Dev advanced while this unit was being planned. Pin
0aae940d63be96481b469363a248e7c92bcac659, tree
8861ad05a9c5fa844edd3df9abf0fc1e68564bd3. Compared with09335d7d4, no Lab
source/test, Lab SOT, package/lockfile, Bun/TypeScript configuration, or
test-runner change exists. The incoming changes are separately published
transport/image work, not this layer's implementation. Do not alter them.

Run the scoped baseline on this exact input, including the core-boundary
tests that observe changed upstream roots. Audit the unchanged validation
closure and require that baseline to pass before B. This does not claim a
pending or cancelled upstream post-merge run passed: this unit independently
validates its input and its final changed HEAD still needs full remote and
hosted gates. Do not wait for or communicate with peer tasks.

At B entry, Main normal-merges this pinned commit into the existing docs-only
branch, checks the reviewed source identity, then the worker applies only
the five validator files and bounded ledger-test changes. Main owns the SOT
section and Git. This real source delta occurs during B. Any later upstream
change is inspected for relevant source/dependency drift; the final tested
integration tree must be freshly checked again before admin landing.

Selected-input proof: the exact0aae940d6 remote baseline passed449Lab tests
across53files,0fail, with clean final HEAD and repository Bun1.4.0. Log:
`wp480-baseline-0aae940d63be96481b469363a248e7c92bcac659.log`. Copernicus checked
the nine existing closure files against093; all are unchanged. The four-leaf
virtual partition therefore retains13total closure modules,69bindings and
the prior no-return-cycle/state-ownership proof. The previous093 baseline
remains historical evidence, not a substitute for this selected-input run.

No new production field, enum value or enforcement rule is introduced, so
new-field creation/serialization/consumer chains and new-enforcement bypass
fields are not applicable. Existing closed guards retain their semantics
and receive the concrete negative controls above. The namespace/identity
test observes export wiring; it is not a substitute for runtime validation.
