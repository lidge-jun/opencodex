# 440 — S13 L5/5: separate classification from state reads

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: `pure-move`. Bounded delegated **docs-only C3** task; parent owns orchestration, loop and goal state.
- Goal: separate classification from state reads, preserving the original public import path and behavior.
- Non-goals: behavior fixes, exported renames, signature changes, new validation, changed credentials/admission policy, changed config paths, new framework, caller migration, merges or releases. Preserve function bodies verbatim, including >50-line functions; function redesign is not this pure-move train.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below; every layer must pass independently at its actual tip. Full suite on `ssh lidge` only, never locally.
- Stop: exact-tip acceptance evidence recorded; do not merge. This drafting task stops after document checks and runs no tests, code entrypoints, or Git mutations.
- Escalation: parent must resolve the 002 size-budget contradiction before execution. This layer moves **315 original lines** including attached comments/whitespace: plain added+deleted churn is at least **630 lines** before glue. If 500 means moved-once lines, this layer fits; ordinary additions plus deletions do not. Request an explicit pure-move churn exception or a parent-approved topology expansion; do not silently waive the gate or edit 002. Stale source, a leaf >400, any new cycle, or any behavioral difference also stops implementation.

Basis: task docs HEAD `4cc219549`; code `origin/dev=1362b1a3841b4de20177e5d65865a513dd7936c4`. Read 000, 001, S13 rows/Per-layer gate of 002, and the relevant records in `devlog/_plan/260905_modular_debt_ledger/016_lane_cli_storage_usage_update_lab_scripts.md`. Source was read with `git show origin/dev:<path>`; `git diff origin/dev -- src/clients/config-export.ts src/cli/opencode.ts src/cli/minimax.ts src/integrations/state.ts` was empty. Older tips in 000/001 are historical, not this plan's code basis.

Structural decision (cxc-dev §1/§5, architecture ARCH-MAP-01/ARCH-DECISION-01): 495 lines mix distinct concerns. Reject deleting/configuring the feature (does not preserve behavior), and generic helpers/index barrels (do not establish ownership). Reuse every existing algorithm and lower-level dependency; only relocate declarations. Inspected conventions: `src/config/paths.ts`, `src/config/process-state.ts`, `src/cli/launcher-context.ts`, `src/cli/account-extended.ts`, `src/integrations/ownership-policy.ts`. Use named siblings in the existing directory. The original remains an existing compatibility boundary, not an internal import shortcut.

Structural map: 7 direct source/test/fixture consumer files. Production dependents: `src/integrations/writer.ts`, `src/server/management/integration-routes.ts`. Current direction is dependents → original → existing imported owners; intended direction is dependents → original → concern leaves → existing owners. Leaf imports are fully enumerated below; no leaf → original edge. Blast radius: client/CLI integration feature, with public consumers unchanged. `structure/09_client-integrations.md:11` identifies builders and classification as single authorities; no parallel implementation is introduced.

## Symbol inventory

Exact syntax spans at `origin/dev:src/integrations/state.ts` (leading comments excluded). Reproduce: `sg run --lang ts --kind 'function_declaration,interface_declaration,type_alias_declaration,lexical_declaration,variable_declaration,class_declaration' --json=compact src/integrations/state.ts`, filtering declarations enclosed by another declaration. Consumers = distinct direct importer/re-exporter files per symbol, resolved by literal module path then counted with `rg -l -w '<symbol>' <resolved importer files>`. Dynamic dispatch destructuring counts too. Private declarations have 0 external consumers, not 0 local calls. Imported bindings are covered by the leaf imports; export-only declarations are noted below. L2 repeats the complete basis inventory and marks L1-owned rows already moved.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `IntegrationState` | type | 30–30 | yes | 1 | `src/integrations/state-classification.ts` (L5) |
| `StateReason` | type | 31–39 | yes | 0 | `src/integrations/state-classification.ts` (L5) |
| `IntegrationStatus` | interface | 41–53 | yes | 0 | `src/integrations/state-classification.ts` (L5) |
| `readPath` | function | 55–63 | yes | 0 | `src/integrations/state-classification.ts` (L5) |
| `hasOurFragments` | function | 66–68 | yes | 0 | `src/integrations/state-classification.ts` (L5) |
| `blockedContainerPath` | function | 81–111 | yes | 0 | `src/integrations/state-classification.ts` (L5) |
| `recordedContribution` | function | 120–143 | no | 0 | `src/integrations/state-classification.ts` (L5) |
| `recordedBlockIsOwned` | function | 153–205 | no | 0 | `src/integrations/state-classification.ts` (L5) |
| `classifyIntegration` | function | 220–343 | yes | 2 | `src/integrations/state-classification.ts` (L5) |
| `IntegrationStateInput` | interface | 345–355 | yes | 0 | `src/integrations/state.ts` (residual) |
| `exportContextOf` | function | 357–376 | yes | 2 | `src/integrations/state.ts` (residual) |
| `retriedThisProcess` | let | 378–378 | no | 0 | `src/integrations/state.ts` (residual) |
| `retryPendingPrunesOnce` | function | 385–395 | yes | 0 | `src/integrations/state.ts` (residual) |
| `retentionOf` | function | 402–413 | no | 0 | `src/integrations/state.ts` (residual) |
| `readIntegrationState` | function | 416–495 | yes | 6 | `src/integrations/state.ts` (residual) |

No other export-only top-level declaration exists.

## Leaf partition

Keep launch/read orchestration in the original; no source-scanned spawn site or process singleton moves. This is a pure relocation, not a new adapter abstraction.

Line-budget convention: each declaration carries immediately preceding comments/whitespace, from previous declaration end+1 (first declaration starts after the import/export header). Counts include those blocks, the exact one-line imports shown, one header line and one separator. These are conservative projected implementation counts, not measurements of files already written. Do not discard comments to meet limits. Adding an export keyword does not add a line. All new files are ≤400.

### `src/integrations/state-classification.ts` — expected 325 lines

Symbols: `IntegrationState`, `StateReason`, `IntegrationStatus`, `readPath`, `hasOurFragments`, `blockedContainerPath`, `recordedContribution`, `recordedBlockIsOwned`, `classifyIntegration`.

Own imports:

```ts
import type { IntegrationClientId } from "./registry";
import type { ManagedContribution } from "../clients/config-export";
import type { OwnershipRecord } from "./ownership";
import { fingerprint, canonicalContribution, semanticContribution } from "./ownership";
import { validRefreshablePaths, protectedContributionFingerprint, semanticProtectedContributionFingerprint, refreshablePathsOf } from "./ownership-policy";
import { PARSE_FAILED } from "./config-io";
import { INTEGRATION_CLIENTS } from "./registry";
import { EXPORT_CLIENTS } from "../clients/config-export";
```

Leaf exports: `IntegrationState`, `StateReason`, `IntegrationStatus`, `readPath`, `hasOurFragments`, `blockedContainerPath`, `classifyIntegration`. Other listed declarations remain private. Only previously public symbols are forwarded from the original path; newly exposed internal symbols serve production registry/sibling calls, not tests.

Residual `src/integrations/state.ts`: expected **186 lines**. No follow-up split is required for this original.

Retained declarations after this layer: `IntegrationStateInput`, `exportContextOf`, `retriedThisProcess`, `retryPendingPrunesOnce`, `retentionOf`, `readIntegrationState`.

Arithmetic: 495 original − 315 cumulative moved original lines + 6 facade glue = 186. Glue comprises new imports, compatibility exports and separators. Retained original header imports can be pruned if unused, only decreasing the estimate.

## Re-export block

Exact forwards in the original path follow. Other public declarations remain exported in place. No wildcard, alias, wrapper, signature change or duplicate definition.

```ts
export { readPath, hasOurFragments, blockedContainerPath, classifyIntegration } from "./state-classification";
export type { IntegrationState, StateReason, IntegrationStatus } from "./state-classification";
```

Explicit residual local imports (re-export binds nothing locally):

```ts
import type { IntegrationStatus } from "./state-classification";
import { classifyIntegration } from "./state-classification";
```

Retain original external imports still used by the residual; prune only proven-unused bindings. New leaves import one another directly.

## Module-level state and cycles

`retriedThisProcess` (`src/integrations/state.ts:378`) stays only in state.ts, adjacent to `retryPendingPrunesOnce` (`:385–395`) and `readIntegrationState` (`:416–495`). Never copy it into the classifier or reset on import. Default-store reads retry once per process; explicit-store behavior is unchanged. No top-level Map/Set/WeakMap/lock. The recordedPaths Set at `:261` is per classification call. The classifier owns no maintenance scheduling or mutable singleton.

Lane 016's AST import BFS found no return path through the original. The partition avoids new return imports, including type-only ones. state-classification.ts depends on registry/ownership/config-io, none of whose import graphs returned through state.ts in the lane evidence. IntegrationState/StateReason/IntegrationStatus move with classification, avoiding a type-only back-import. Registry remains independent of state; writer → state → classifier retains one classification authority.

Coupling classification: existing config-schema coupling stays with format owners; sequential/functional coupling is explicit through parameters. No new common mutable state or temporal startup constraint. Existing auth/ownership checks are moved verbatim. Before execution rerun lane 016 method G against the actual layer base (relative static imports, re-exports, type-only edges and literal dynamic imports); any new return path is escalation, not permission for a lazy-import workaround.

## Tests

Discovery: `rg -l 'src/integrations/state' tests --glob '*.ts'`, followed by import/source-read inspection. Every direct test/fixture importer is listed below, with disposition **unchanged** (old public path):

- `tests/clients/integrations-state.test.ts` — unchanged.
- `tests/clients/integrations-writer.test.ts` — unchanged.
- `tests/gui/integrations-invariants.test.ts` — unchanged.
- `tests/providers/aside-client.test.ts` — unchanged.
- `tests/server/management-integration-routes.test.ts` — unchanged.

No source-text reader of src/integrations/state.ts was found. 001's basename heuristic is not four confirmed text oracles: `tests/clients/integrations-state.test.ts:139` reads a temporary client config; `tests/gui/integrations-invariants.test.ts:142` reads a temporary journal and :145 records; `tests/providers/aside-client.test.ts:271` reads a generated account catalog. Keep these unchanged; do not retarget them to source. No retarget-to-leaf or add-leaf-to-scan-list action.

C-phase red proofs: temporarily bypass blockedContainerPath in the moved classifier and observe `tests/clients/integrations-state.test.ts:346` fail; restore. Temporarily bypass recordedBlockIsOwned and observe :148 fail; restore. Existing writer tests must still show these classifications prevent mutation; fingerprint-only replacements are insufficient.

These are future implementation checks, not tests run by this docs author. No new test file is required. Facade/leaf identity assertions may be added in an existing focused test; if a new test file is required, parent must explicitly expand scope to include both test-layout registry files (`scripts/test-layout/layout.json`, `tests/fixtures/test-layout-expected.json`). Never commit red-proof mutations.

## Verification

Future implementation gate only, in the dedicated layer worktree at its actual tip. Domains: clients, gui, providers, server. Explicit source-reader and subprocess coverage is not replaced by test:changed.

```sh
bun run typecheck
bun test tests/clients/integrations-state.test.ts tests/clients/integrations-writer.test.ts tests/gui/integrations-invariants.test.ts tests/providers/aside-client.test.ts tests/server/management-integration-routes.test.ts
bun run privacy:scan
wc -l src/integrations/state-classification.ts src/integrations/state.ts
# Compare resolved old-path consumer identities/counts with the list in this plan
rg -n 'integrations/state' src gui/src scripts tests
# Full suite on lidge only; parent serializes access to this shared remote checkout
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-integrations-state && git checkout -q FETCH_HEAD && bun install --frozen-lockfile >/dev/null && bun run test'
```

The remote command intentionally keeps bun run test last, preserving its exit code instead of masking failure behind tail. Parent records remote HEAD and full output. Every command exits 0; focused/full tests report 0 failures. Delivery requires a green exact-head GitHub CI rollup, not an empty required-check list.

Per 002, `bun test tests/lab/core-lab-boundary.test.ts` is conditional on source edits under `src/server|src/router|src/lib`: **not applicable** to this approved layer touch set. Do not edit its PROTECTED roots. If implementation expands into those directories, parent must approve scope and run that guard explicitly. Preserve the 7 original direct consumer files; new facade-to-leaf imports are not caller churn. The grep is a discovery list, not by itself a proof of consumer identity: resolve relative and dynamic paths as in the inventory method. Repeat lane 016 method G on the final imports to prove zero new cycles; typecheck alone is not a cycle detector.

Drafting verification is document-only: required heading order, complete symbol ranges/ownership, projected line arithmetic, export coverage, referenced test paths, unique leaf paths and assigned-file scope. No test, typecheck, privacy scan or remote command above was executed in this drafting task.

## Accept criteria

1. Parent resolves the 500-line budget definition/exception or revises topology before implementation; no claim that literal added+deleted churn passes.
2. Every inventory declaration has exactly one implementation owner. Preserve all original export names/signatures and value/type importability; do not extract L1 declarations a second time.
3. Every new leaf is ≤400 lines. Residual target is 186, ≤400. Measure actual files and explain drift before proceeding.
4. Preserve function bodies, branch order, literals, serialized bytes/key order, class/object identity and state initialization. Only moves, explicit imports and named forwards change source structure.
5. Old-path consumers and assertions remain intact. Record the exact red/restored-green evidence named under Tests; no guard deletion, skipping, weakened assertions or empty-facade source scans.
6. Singleton state/allowlists each have one owner; no leaf imports the original even for types; resolved static/re-export/type/dynamic-literal graph has no new cycles.
7. Typecheck, focused checks, privacy, remote full suite and exact-head CI pass at this layer tip independently of later layers. No full local suite and no merge.
8. Diff stays within the original/new leaves and genuinely required existing focused tests. New tests, SoT edits, new topology or unrelated code require parent scope approval.

## PR

Title: `refactor(integrations): separate classification from state reads (split S13 L5/5)`

Branch: `codex/split-integrations-state`. Base: `codex/split-clients-config-export-b`. Closes: none.

Use all sections of `.github/PULL_REQUEST_TEMPLATE.md` (Summary, Verification, Checklist), including the size-gate disposition and DEV-STACK-03 map below. This draft creates no PR; placeholder PR numbers are intentional.

| # | PR | Layer | Branch | Base | Review focus |
|---|---|---|---|---|---|
| 1 | #TBD-S13-L1 | 400 | `codex/split-clients-config-export-a` | `dev` | extract low-fanout client formats and dependency foundations |
| 2 | #TBD-S13-L2 | 410 | `codex/split-clients-config-export-b` | `codex/split-clients-config-export-a` | finish client path and format partitions |
| 3 | #TBD-S13-L3 | 420 | `codex/split-cli-opencode` | `codex/split-clients-config-export-b` | separate OpenCode config and catalog from launch |
| 4 | #TBD-S13-L4 | 430 | `codex/split-cli-minimax` | `codex/split-cli-opencode` | isolate MMX protocol and termination owners |
| 5 | #TBD-S13-L5 | 440 — this layer | `codex/split-integrations-state` | `codex/split-clients-config-export-b` | separate classification from state reads |

Depends on #TBD-S13-L2. Review this layer's diff only. Cascade this layer only from its real parent `codex/split-clients-config-export-b`, then re-verify its tip/base ref while preserving checkout ownership. Bottom-up merging remains a separate user-authorized action and is out of scope.
