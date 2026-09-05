# 430 — S13 L4/5: isolate MMX protocol and termination owners

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: `pure-move`. Bounded delegated **docs-only C3** task; parent owns orchestration, loop and goal state.
- Goal: isolate MMX protocol and termination owners, preserving the original public import path and behavior.
- Non-goals: behavior fixes, exported renames, signature changes, new validation, changed credentials/admission policy, changed config paths, new framework, caller migration, merges or releases. Preserve function bodies verbatim, including >50-line functions; function redesign is not this pure-move train.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below; every layer must pass independently at its actual tip. Full suite on `ssh lidge` only, never locally.
- Stop: exact-tip acceptance evidence recorded; do not merge. This drafting task stops after document checks and runs no tests, code entrypoints, or Git mutations.
- Escalation: parent must resolve the 002 size-budget contradiction before execution. This layer moves **278 original lines** including attached comments/whitespace: plain added+deleted churn is at least **556 lines** before glue. If 500 means moved-once lines, this layer fits; ordinary additions plus deletions do not. Request an explicit pure-move churn exception or a parent-approved topology expansion; do not silently waive the gate or edit 002. Stale source, a leaf >400, any new cycle, or any behavioral difference also stops implementation.

Basis: task docs HEAD `4cc219549`; code `origin/dev=1362b1a3841b4de20177e5d65865a513dd7936c4`. Read 000, 001, S13 rows/Per-layer gate of 002, and the relevant records in `devlog/_plan/260905_modular_debt_ledger/016_lane_cli_storage_usage_update_lab_scripts.md`. Source was read with `git show origin/dev:<path>`; `git diff origin/dev -- src/clients/config-export.ts src/cli/opencode.ts src/cli/minimax.ts src/integrations/state.ts` was empty. Older tips in 000/001 are historical, not this plan's code basis.

Structural decision (cxc-dev §1/§5, architecture ARCH-MAP-01/ARCH-DECISION-01): 497 lines mix distinct concerns. Reject deleting/configuring the feature (does not preserve behavior), and generic helpers/index barrels (do not establish ownership). Reuse every existing algorithm and lower-level dependency; only relocate declarations. Inspected conventions: `src/config/paths.ts`, `src/config/process-state.ts`, `src/cli/launcher-context.ts`, `src/cli/account-extended.ts`, `src/integrations/ownership-policy.ts`. Use named siblings in the existing directory. The original remains an existing compatibility boundary, not an internal import shortcut.

Structural map: 3 direct source/test/fixture consumer files. Production dependents: `src/cli/dispatch.ts`. Current direction is dependents → original → existing imported owners; intended direction is dependents → original → concern leaves → existing owners. Leaf imports are fully enumerated below; no leaf → original edge. Blast radius: client/CLI integration feature, with public consumers unchanged. `structure/09_client-integrations.md:11` identifies builders and classification as single authorities; no parallel implementation is introduced.

## Symbol inventory

Exact syntax spans at `origin/dev:src/cli/minimax.ts` (leading comments excluded). Reproduce: `sg run --lang ts --kind 'function_declaration,interface_declaration,type_alias_declaration,lexical_declaration,variable_declaration,class_declaration' --json=compact src/cli/minimax.ts`, filtering declarations enclosed by another declaration. Consumers = distinct direct importer/re-exporter files per symbol, resolved by literal module path then counted with `rg -l -w '<symbol>' <resolved importer files>`. Dynamic dispatch destructuring counts too. Private declarations have 0 external consumers, not 0 local calls. Imported bindings are covered by the leaf imports; export-only declarations are noted below. L2 repeats the complete basis inventory and marks L1-owned rows already moved.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `MinimaxLaunchEnv` | interface | 25–27 | yes | 0 | `src/cli/minimax-mmx.ts` (L4) |
| `MmxTextBridge` | interface | 29–33 | yes | 0 | `src/cli/minimax-mmx.ts` (L4) |
| `MmxTextBridgeOptions` | interface | 35–38 | yes | 0 | `src/cli/minimax-mmx.ts` (L4) |
| `MmxTerminationTarget` | interface | 40–45 | yes | 0 | `src/cli/minimax-termination.ts` (L4) |
| `MmxTerminationDeps` | interface | 47–50 | yes | 0 | `src/cli/minimax-termination.ts` (L4) |
| `MmxSignalHost` | interface | 52–55 | yes | 0 | `src/cli/minimax-termination.ts` (L4) |
| `MmxTerminationHandlersOptions` | interface | 57–64 | yes | 0 | `src/cli/minimax-termination.ts` (L4) |
| `MMX_TERMINATION_DUPLICATE_WINDOW_MS` | const | 66–66 | no | 0 | `src/cli/minimax-termination.ts` (L4) |
| `MMX_CHILD_OWNED_ENV_KEYS` | const | 68–76 | no | 0 | `src/cli/minimax-mmx.ts` (L4) |
| `MMX_GLOBAL_BOOLEAN_FLAGS` | const | 78–91 | no | 0 | `src/cli/minimax-mmx.ts` (L4) |
| `mmxCommandPath` | function | 94–113 | yes | 1 | `src/cli/minimax-mmx.ts` (L4) |
| `mmxUnsafeOverride` | function | 116–123 | yes | 1 | `src/cli/minimax-mmx.ts` (L4) |
| `buildMmxEnv` | function | 125–145 | yes | 1 | `src/cli/minimax-mmx.ts` (L4) |
| `startMmxTextBridge` | function | 153–227 | yes | 2 | `src/cli/minimax-mmx.ts` (L4) |
| `normalizedMcodeBaseUrl` | function | 229–243 | no | 0 | `src/cli/minimax.ts` (residual) |
| `mcodeOpenCodexBaseUrl` | function | 246–256 | yes | 1 | `src/cli/minimax.ts` (residual) |
| `usableMinimaxLiveProxy` | function | 259–262 | yes | 1 | `src/cli/minimax.ts` (residual) |
| `ensureProxy` | function | 264–285 | no | 0 | `src/cli/minimax.ts` (residual) |
| `isStandaloneInformationalInvocation` | function | 288–298 | yes | 1 | `src/cli/minimax.ts` (residual) |
| `forwardMmxTerminationSignal` | function | 301–324 | yes | 1 | `src/cli/minimax-termination.ts` (L4) |
| `installMmxTerminationHandlers` | function | 327–360 | yes | 1 | `src/cli/minimax-termination.ts` (L4) |
| `finishMmxClientCleanup` | function | 363–372 | yes | 1 | `src/cli/minimax-termination.ts` (L4) |
| `spawnClient` | function | 374–394 | no | 0 | `src/cli/minimax.ts` (residual) |
| `MCODE_INSTALL_HINT` | const | 396–396 | no | 0 | `src/cli/minimax.ts` (residual) |
| `MMX_INSTALL_HINT` | const | 397–397 | no | 0 | `src/cli/minimax.ts` (residual) |
| `cmdMcode` | function | 399–433 | yes | 1 | `src/cli/minimax.ts` (residual) |
| `cmdMmx` | function | 435–497 | yes | 1 | `src/cli/minimax.ts` (residual) |

No other export-only top-level declaration exists.

## Leaf partition

Keep launch/read orchestration in the original; no source-scanned spawn site or process singleton moves. This is a pure relocation, not a new adapter abstraction.

Line-budget convention: each declaration carries immediately preceding comments/whitespace, from previous declaration end+1 (first declaration starts after the import/export header). Counts include those blocks, the exact one-line imports shown, one header line and one separator. These are conservative projected implementation counts, not measurements of files already written. Do not discard comments to meet limits. Adding an export keyword does not add a line. All new files are ≤400.

### `src/cli/minimax-mmx.ts` — expected 182 lines

Symbols: `MinimaxLaunchEnv`, `MmxTextBridge`, `MmxTextBridgeOptions`, `MMX_CHILD_OWNED_ENV_KEYS`, `MMX_GLOBAL_BOOLEAN_FLAGS`, `mmxCommandPath`, `mmxUnsafeOverride`, `buildMmxEnv`, `startMmxTextBridge`.

Own imports:

```ts
import type { LiveProxy } from "../server/proxy-liveness";
import { probeHostname } from "../server/proxy-liveness";
import { LOOPBACK_API_KEY_PLACEHOLDER } from "../clients/config-export";
import { clearableDeadline } from "../lib/abort";
```

Leaf exports: `MinimaxLaunchEnv`, `MmxTextBridge`, `MmxTextBridgeOptions`, `mmxCommandPath`, `mmxUnsafeOverride`, `buildMmxEnv`, `startMmxTextBridge`. Other listed declarations remain private. Only previously public symbols are forwarded from the original path; newly exposed internal symbols serve production registry/sibling calls, not tests.

### `src/cli/minimax-termination.ts` — expected 105 lines

Symbols: `MmxTerminationTarget`, `MmxTerminationDeps`, `MmxSignalHost`, `MmxTerminationHandlersOptions`, `MMX_TERMINATION_DUPLICATE_WINDOW_MS`, `forwardMmxTerminationSignal`, `installMmxTerminationHandlers`, `finishMmxClientCleanup`.

Own imports:

```ts
import { execFileSync } from "node:child_process";
```

Leaf exports: `MmxTerminationTarget`, `MmxTerminationDeps`, `MmxSignalHost`, `MmxTerminationHandlersOptions`, `forwardMmxTerminationSignal`, `installMmxTerminationHandlers`, `finishMmxClientCleanup`. Other listed declarations remain private. Only previously public symbols are forwarded from the original path; newly exposed internal symbols serve production registry/sibling calls, not tests.

Residual `src/cli/minimax.ts`: expected **228 lines**. No follow-up split is required for this original.

Retained declarations after this layer: `normalizedMcodeBaseUrl`, `mcodeOpenCodexBaseUrl`, `usableMinimaxLiveProxy`, `ensureProxy`, `isStandaloneInformationalInvocation`, `spawnClient`, `MCODE_INSTALL_HINT`, `MMX_INSTALL_HINT`, `cmdMcode`, `cmdMmx`.

Arithmetic: 497 original − 278 cumulative moved original lines + 9 facade glue = 228. Glue comprises new imports, compatibility exports and separators. Retained original header imports can be pruned if unused, only decreasing the estimate.

## Re-export block

Exact forwards in the original path follow. Other public declarations remain exported in place. No wildcard, alias, wrapper, signature change or duplicate definition.

```ts
export { mmxCommandPath, mmxUnsafeOverride, buildMmxEnv, startMmxTextBridge } from "./minimax-mmx";
export type { MinimaxLaunchEnv, MmxTextBridge, MmxTextBridgeOptions } from "./minimax-mmx";
export { forwardMmxTerminationSignal, installMmxTerminationHandlers, finishMmxClientCleanup } from "./minimax-termination";
export type { MmxTerminationTarget, MmxTerminationDeps, MmxSignalHost, MmxTerminationHandlersOptions } from "./minimax-termination";
```

Explicit residual local imports (re-export binds nothing locally):

```ts
import { mmxUnsafeOverride, mmxCommandPath, startMmxTextBridge, buildMmxEnv } from "./minimax-mmx";
import type { MmxTextBridge } from "./minimax-mmx";
import { installMmxTerminationHandlers, finishMmxClientCleanup } from "./minimax-termination";
```

Retain original external imports still used by the residual; prune only proven-unused bindings. New leaves import one another directly.

## Module-level state and cycles

`MMX_CHILD_OWNED_ENV_KEYS` (`src/cli/minimax.ts:68–76`) and `MMX_GLOBAL_BOOLEAN_FLAGS` (`:78–91`) have one owner, minimax-mmx.ts; both remain module-private Sets. No top-level let/Map/WeakMap/lock exists. `MMX_TERMINATION_DUPLICATE_WINDOW_MS` (`:66`) belongs to minimax-termination.ts. Timestamps/listeners at `:332–360` remain per handler installation. bridge/child/cleanupPromise declarations in cmdMmx remain closure-local; never hoist them into a module singleton. Preserve cleanup, duplicate suppression and listener-removal order.

Lane 016's AST import BFS found no return path through the original. The partition avoids new return imports, including type-only ones. The MMX protocol and termination leaves are independent. All their types move with the consuming operations. The existing opencodeProxyStartEnv dependency remains on the original minimax launcher, not a new leaf. The original coordinates shared child lifetime without exposing the closure's mutable state.

Coupling classification: existing config-schema coupling stays with format owners; sequential/functional coupling is explicit through parameters. No new common mutable state or temporal startup constraint. Existing auth/ownership checks are moved verbatim. Before execution rerun lane 016 method G against the actual layer base (relative static imports, re-exports, type-only edges and literal dynamic imports); any new return path is escalation, not permission for a lazy-import workaround.

## Tests

Discovery: `rg -l 'src/cli/minimax' tests --glob '*.ts'`, followed by import/source-read inspection. Every direct test/fixture importer is listed below, with disposition **unchanged** (old public path):

- `tests/fixtures/minimax-bridge-direct.ts` — unchanged.
- `tests/providers/minimax-clients.test.ts` — unchanged.

No source-text reader of src/cli/minimax.ts was found. No retarget-to-leaf or add-leaf-to-scan-list action. `tests/providers/minimax-clients.test.ts:166` spawns the listed fixture; keep that path and run the parent test explicitly because test:changed may miss subprocess dependencies. C-phase red proofs: temporary bypass of mmxUnsafeOverride must fail :223; removing duplicate-signal suppression must fail :311. Restore each mutation and record green. The direct-hop fixture test at :154 also remains unchanged.

These are future implementation checks, not tests run by this docs author. No new test file is required. Facade/leaf identity assertions may be added in an existing focused test; if a new test file is required, parent must explicitly expand scope to include both test-layout registry files (`scripts/test-layout/layout.json`, `tests/fixtures/test-layout-expected.json`). Never commit red-proof mutations.

## Verification

Future implementation gate only, in the dedicated layer worktree at its actual tip. Domains: providers. Explicit source-reader and subprocess coverage is not replaced by test:changed.

```sh
bun run typecheck
bun test tests/providers/minimax-clients.test.ts
bun run privacy:scan
wc -l src/cli/minimax-mmx.ts src/cli/minimax-termination.ts src/cli/minimax.ts
# Compare resolved old-path consumer identities/counts with the list in this plan
rg -n 'cli/minimax' src gui/src scripts tests
# Full suite on lidge only; parent serializes access to this shared remote checkout
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-cli-minimax && git checkout -q FETCH_HEAD && bun install --frozen-lockfile >/dev/null && bun run test'
```

The remote command intentionally keeps bun run test last, preserving its exit code instead of masking failure behind tail. Parent records remote HEAD and full output. Every command exits 0; focused/full tests report 0 failures. Delivery requires a green exact-head GitHub CI rollup, not an empty required-check list.

Per 002, `bun test tests/lab/core-lab-boundary.test.ts` is conditional on source edits under `src/server|src/router|src/lib`: **not applicable** to this approved layer touch set. Do not edit its PROTECTED roots. If implementation expands into those directories, parent must approve scope and run that guard explicitly. Preserve the 3 original direct consumer files; new facade-to-leaf imports are not caller churn. The grep is a discovery list, not by itself a proof of consumer identity: resolve relative and dynamic paths as in the inventory method. Repeat lane 016 method G on the final imports to prove zero new cycles; typecheck alone is not a cycle detector.

Drafting verification is document-only: required heading order, complete symbol ranges/ownership, projected line arithmetic, export coverage, referenced test paths, unique leaf paths and assigned-file scope. No test, typecheck, privacy scan or remote command above was executed in this drafting task.

## Accept criteria

1. Parent resolves the 500-line budget definition/exception or revises topology before implementation; no claim that literal added+deleted churn passes.
2. Every inventory declaration has exactly one implementation owner. Preserve all original export names/signatures and value/type importability; do not extract L1 declarations a second time.
3. Every new leaf is ≤400 lines. Residual target is 228, ≤400. Measure actual files and explain drift before proceeding.
4. Preserve function bodies, branch order, literals, serialized bytes/key order, class/object identity and state initialization. Only moves, explicit imports and named forwards change source structure.
5. Old-path consumers and assertions remain intact. Record the exact red/restored-green evidence named under Tests; no guard deletion, skipping, weakened assertions or empty-facade source scans.
6. Singleton state/allowlists each have one owner; no leaf imports the original even for types; resolved static/re-export/type/dynamic-literal graph has no new cycles.
7. Typecheck, focused checks, privacy, remote full suite and exact-head CI pass at this layer tip independently of later layers. No full local suite and no merge.
8. Diff stays within the original/new leaves and genuinely required existing focused tests. New tests, SoT edits, new topology or unrelated code require parent scope approval.

## PR

Title: `refactor(cli): isolate MMX protocol and termination owners (split S13 L4/5)`

Branch: `codex/split-cli-minimax`. Base: `codex/split-cli-opencode`. Closes: none.

Use all sections of `.github/PULL_REQUEST_TEMPLATE.md` (Summary, Verification, Checklist), including the size-gate disposition and DEV-STACK-03 map below. This draft creates no PR; placeholder PR numbers are intentional.

| # | PR | Layer | Branch | Base | Review focus |
|---|---|---|---|---|---|
| 1 | #TBD-S13-L1 | 400 | `codex/split-clients-config-export-a` | `dev` | extract low-fanout client formats and dependency foundations |
| 2 | #TBD-S13-L2 | 410 | `codex/split-clients-config-export-b` | `codex/split-clients-config-export-a` | finish client path and format partitions |
| 3 | #TBD-S13-L3 | 420 | `codex/split-cli-opencode` | `codex/split-clients-config-export-b` | separate OpenCode config and catalog from launch |
| 4 | #TBD-S13-L4 | 430 — this layer | `codex/split-cli-minimax` | `codex/split-cli-opencode` | isolate MMX protocol and termination owners |
| 5 | #TBD-S13-L5 | 440 | `codex/split-integrations-state` | `codex/split-clients-config-export-b` | separate classification from state reads |

Depends on #TBD-S13-L3. Review this layer's diff only. Cascade this layer only from its real parent `codex/split-cli-opencode`, then re-verify its tip/base ref while preserving checkout ownership. Bottom-up merging remains a separate user-authorized action and is out of scope.
