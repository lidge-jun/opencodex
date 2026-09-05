# 420 — S13 L3/5: separate OpenCode config and catalog from launch

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: `pure-move`. Bounded delegated **docs-only C3** task; parent owns orchestration, loop and goal state.
- Goal: separate OpenCode config and catalog from launch, preserving the original public import path and behavior.
- Non-goals: behavior fixes, exported renames, signature changes, new validation, changed credentials/admission policy, changed config paths, new framework, caller migration, merges or releases. Preserve function bodies verbatim, including >50-line functions; function redesign is not this pure-move train.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below; every layer must pass independently at its actual tip. Full suite on `ssh lidge` only, never locally.
- Stop: exact-tip acceptance evidence recorded; do not merge. This drafting task stops after document checks and runs no tests, code entrypoints, or Git mutations.
- Escalation: parent must resolve the 002 size-budget contradiction before execution. This layer moves **441 original lines** including attached comments/whitespace: plain added+deleted churn is at least **882 lines** before glue. If 500 means moved-once lines, this layer fits; ordinary additions plus deletions do not. Request an explicit pure-move churn exception or a parent-approved topology expansion; do not silently waive the gate or edit 002. Stale source, a leaf >400, any new cycle, or any behavioral difference also stops implementation.

Basis: task docs HEAD `4cc219549`; code `origin/dev=1362b1a3841b4de20177e5d65865a513dd7936c4`. Read 000, 001, S13 rows/Per-layer gate of 002, and the relevant records in `devlog/_plan/260905_modular_debt_ledger/016_lane_cli_storage_usage_update_lab_scripts.md`. Source was read with `git show origin/dev:<path>`; `git diff origin/dev -- src/clients/config-export.ts src/cli/opencode.ts src/cli/minimax.ts src/integrations/state.ts` was empty. Older tips in 000/001 are historical, not this plan's code basis.

Structural decision (cxc-dev §1/§5, architecture ARCH-MAP-01/ARCH-DECISION-01): 682 lines mix distinct concerns. Reject deleting/configuring the feature (does not preserve behavior), and generic helpers/index barrels (do not establish ownership). Reuse every existing algorithm and lower-level dependency; only relocate declarations. Inspected conventions: `src/config/paths.ts`, `src/config/process-state.ts`, `src/cli/launcher-context.ts`, `src/cli/account-extended.ts`, `src/integrations/ownership-policy.ts`. Use named siblings in the existing directory. The original remains an existing compatibility boundary, not an internal import shortcut.

Structural map: 5 direct source/test/fixture consumer files. Production dependents: `src/cli/export-command.ts`, `src/cli/minimax.ts`, `src/cli/dispatch.ts`. Current direction is dependents → original → existing imported owners; intended direction is dependents → original → concern leaves → existing owners. Leaf imports are fully enumerated below; no leaf → original edge. Blast radius: client/CLI integration feature, with public consumers unchanged. `structure/09_client-integrations.md:11` identifies builders and classification as single authorities; no parallel implementation is introduced.

## Symbol inventory

Exact syntax spans at `origin/dev:src/cli/opencode.ts` (leading comments excluded). Reproduce: `sg run --lang ts --kind 'function_declaration,interface_declaration,type_alias_declaration,lexical_declaration,variable_declaration,class_declaration' --json=compact src/cli/opencode.ts`, filtering declarations enclosed by another declaration. Consumers = distinct direct importer/re-exporter files per symbol, resolved by literal module path then counted with `rg -l -w '<symbol>' <resolved importer files>`. Dynamic dispatch destructuring counts too. Private declarations have 0 external consumers, not 0 local calls. Imported bindings are covered by the leaf imports; export-only declarations are noted below. L2 repeats the complete basis inventory and marks L1-owned rows already moved.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `OpencodeRoutedModel` | interface | 78–87 | yes | 0 | `src/cli/opencode-catalog.ts` (L3) |
| `OpencodeProxyModelRow` | interface | 90–103 | yes | 1 | `src/cli/opencode-catalog.ts` (L3) |
| `PROJECT_CONFIG_FILENAMES` | const | 105–105 | no | 0 | `src/cli/opencode-config.ts` (L3) |
| `OPENCODE_CONFIG_CONTENT_ENV` | const | 111–111 | yes | 1 | `src/cli/opencode.ts` (residual) |
| `isRecord` | function | 113–115 | no | 0 | `src/cli/opencode-config.ts` (L3) |
| `stripJsonComments` | function | 121–158 | no | 0 | `src/cli/opencode-config.ts` (L3) |
| `stripTrailingCommas` | function | 161–185 | no | 0 | `src/cli/opencode-config.ts` (L3) |
| `parseJsonc` | function | 192–198 | yes | 1 | `src/cli/opencode-config.ts` (L3) |
| `opencodeModelKey` | function | 201–203 | yes | 1 | `src/cli/opencode-catalog.ts` (L3) |
| `opencodeLaunchNativeSlugs` | function | 209–212 | yes | 1 | `src/cli/opencode-catalog.ts` (L3) |
| `opencodeLaunchCatalog` | function | 215–240 | no | 0 | `src/cli/opencode-catalog.ts` (L3) |
| `buildOpencodeProviderBlock` | function | 243–257 | yes | 1 | `src/cli/opencode-catalog.ts` (L3) |
| `buildOpencodeV2ProviderBlock` | function | 263–277 | yes | 1 | `src/cli/opencode-catalog.ts` (L3) |
| `buildOpencodeProviderBlocksFromCatalog` | function | 284–291 | yes | 1 | `src/cli/opencode-catalog.ts` (L3) |
| `opencodeBlocks` | function | 293–300 | no | 0 | `src/cli/opencode-catalog.ts` (L3) |
| `OPENCODE_PROXY_MODELS_TIMEOUT_MS` | const | 303–303 | yes | 0 | `src/cli/opencode-catalog.ts` (L3) |
| `fetchOpencodeProxyModels` | function | 306–366 | yes | 1 | `src/cli/opencode-catalog.ts` (L3) |
| `opencodeCatalogFromProxyRows` | function | 372–401 | yes | 2 | `src/cli/opencode-catalog.ts` (L3) |
| `OpencodeRuntimeConfigError` | type | 403–403 | yes | 0 | `src/cli/opencode-config.ts` (L3) |
| `isOpencodeRuntimeConfigError` | function | 406–410 | yes | 1 | `src/cli/opencode-config.ts` (L3) |
| `mergeOpencodeRuntimeConfig` | function | 417–457 | yes | 1 | `src/cli/opencode-config.ts` (L3) |
| `buildOpencodeConfig` | function | 460–476 | yes | 1 | `src/cli/opencode.ts` (residual) |
| `serializeOpencodeRuntimeConfig` | function | 479–481 | yes | 1 | `src/cli/opencode-config.ts` (L3) |
| `findGitRoot` | function | 483–491 | no | 0 | `src/cli/opencode-config.ts` (L3) |
| `configFileDefinesProvider` | function | 498–509 | no | 0 | `src/cli/opencode-config.ts` (L3) |
| `opencodeProviderOverridePath` | function | 515–536 | yes | 1 | `src/cli/opencode-config.ts` (L3) |
| `projectConfigOverridesProvider` | function | 539–541 | yes | 1 | `src/cli/opencode-config.ts` (L3) |
| `serviceTokenLookupEnv` | function | 543–546 | no | 0 | `src/cli/opencode.ts` (residual) |
| `opencodeProxyStartEnv` | function | 553–558 | yes | 2 | `src/cli/opencode.ts` (residual) |
| `buildOpencodeEnv` | function | 566–578 | yes | 1 | `src/cli/opencode.ts` (residual) |
| `opencodeApiKey` | function | 584–590 | yes | 1 | `src/cli/opencode.ts` (residual) |
| `ensureProxyForOpencode` | function | 592–614 | no | 0 | `src/cli/opencode.ts` (residual) |
| `OPENCODE_INSTALL_HINT` | const | 616–616 | no | 0 | `src/cli/opencode.ts` (residual) |
| `opencodeNotFoundHint` | function | 623–629 | yes | 1 | `src/cli/opencode.ts` (residual) |
| `cmdOpencode` | function | 631–682 | yes | 1 | `src/cli/opencode.ts` (residual) |

Export-only statements: `src/cli/opencode.ts:56–66` (9 values) and `:67–75` (7 types) remain forwarded from `../clients/config-export` exactly as shown below.

## Leaf partition

Keep launch/read orchestration in the original; no source-scanned spawn site or process singleton moves. This is a pure relocation, not a new adapter abstraction.

Line-budget convention: each declaration carries immediately preceding comments/whitespace, from previous declaration end+1 (first declaration starts after the import/export header). Counts include those blocks, the exact one-line imports shown, one header line and one separator. These are conservative projected implementation counts, not measurements of files already written. Do not discard comments to meet limits. Adding an export keyword does not add a line. All new files are ≤400.

### `src/cli/opencode-config.ts` — expected 217 lines

Symbols: `PROJECT_CONFIG_FILENAMES`, `isRecord`, `stripJsonComments`, `stripTrailingCommas`, `parseJsonc`, `OpencodeRuntimeConfigError`, `isOpencodeRuntimeConfigError`, `mergeOpencodeRuntimeConfig`, `serializeOpencodeRuntimeConfig`, `findGitRoot`, `configFileDefinesProvider`, `opencodeProviderOverridePath`, `projectConfigOverridesProvider`.

Own imports:

```ts
import type { OpencodeGeneratedConfig, OpencodeProviderBlocks, OpencodeLaunchEnv } from "../clients/config-export";
import { OPENCODE_CONFIG_SCHEMA, OPENCODE_PROVIDER_ID, opencodeGlobalConfigPath } from "../clients/config-export";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
```

Leaf exports: `parseJsonc`, `OpencodeRuntimeConfigError`, `isOpencodeRuntimeConfigError`, `mergeOpencodeRuntimeConfig`, `serializeOpencodeRuntimeConfig`, `opencodeProviderOverridePath`, `projectConfigOverridesProvider`. Other listed declarations remain private. Only previously public symbols are forwarded from the original path; newly exposed internal symbols serve production registry/sibling calls, not tests.

### `src/cli/opencode-catalog.ts` — expected 240 lines

Symbols: `OpencodeRoutedModel`, `OpencodeProxyModelRow`, `opencodeModelKey`, `opencodeLaunchNativeSlugs`, `opencodeLaunchCatalog`, `buildOpencodeProviderBlock`, `buildOpencodeV2ProviderBlock`, `buildOpencodeProviderBlocksFromCatalog`, `opencodeBlocks`, `OPENCODE_PROXY_MODELS_TIMEOUT_MS`, `fetchOpencodeProxyModels`, `opencodeCatalogFromProxyRows`.

Own imports:

```ts
import type { OcxConfig } from "../types";
import { providerCodexAccountMode } from "../providers/registry";
import { visibleNativeSlugs } from "../codex/catalog";
import type { OpencodeCatalogModel, OpencodeProviderBlock, OpencodeV2ProviderBlock, OpencodeProviderBlocks } from "../clients/config-export";
import { OPENCODE_PROVIDER_BLOCK_DEFAULT_CONFIG, buildOpencodeProviderBlockFromCatalog, opencodeProviderBlocks, opencodeProxyBaseUrl } from "../clients/config-export";
import type { LiveProxy } from "../server/proxy-liveness";
import { probeHostname } from "../server/proxy-liveness";
```

Leaf exports: `OpencodeRoutedModel`, `OpencodeProxyModelRow`, `opencodeModelKey`, `opencodeLaunchNativeSlugs`, `buildOpencodeProviderBlock`, `buildOpencodeV2ProviderBlock`, `buildOpencodeProviderBlocksFromCatalog`, `OPENCODE_PROXY_MODELS_TIMEOUT_MS`, `fetchOpencodeProxyModels`, `opencodeCatalogFromProxyRows`. Other listed declarations remain private. Only previously public symbols are forwarded from the original path; newly exposed internal symbols serve production registry/sibling calls, not tests.

Residual `src/cli/opencode.ts`: expected **251 lines**. No follow-up split is required for this original.

Retained declarations after this layer: `OPENCODE_CONFIG_CONTENT_ENV`, `buildOpencodeConfig`, `serviceTokenLookupEnv`, `opencodeProxyStartEnv`, `buildOpencodeEnv`, `opencodeApiKey`, `ensureProxyForOpencode`, `OPENCODE_INSTALL_HINT`, `opencodeNotFoundHint`, `cmdOpencode`.

Arithmetic: 682 original − 441 cumulative moved original lines + 10 facade glue = 251. Glue comprises new imports, compatibility exports and separators. Retained original header imports can be pruned if unused, only decreasing the estimate.

## Re-export block

Exact forwards in the original path follow. Other public declarations remain exported in place. No wildcard, alias, wrapper, signature change or duplicate definition.

```ts
export {
  OPENCODE_API_KEY_ENV,
  OPENCODE_API_KEY_ENV_REF,
  OPENCODE_PROVIDER_BLOCK_DEFAULT_CONFIG,
  OPENCODE_PROVIDER_ID,
  SCHEMA_REQUIRED_OUTPUT_BUDGET,
  buildOpencodeProviderBlockFromCatalog,
  opencodeGlobalConfigPath,
  opencodeProxyBaseUrl,
  opencodeV2ProviderBlock,
} from "../clients/config-export";
export type {
  OpencodeCatalogModel,
  OpencodeGeneratedConfig,
  OpencodeLaunchEnv,
  OpencodeModelEntry,
  OpencodeProviderBlock,
  OpencodeProviderBlocks,
  OpencodeV2ProviderBlock,
} from "../clients/config-export";
export { parseJsonc, isOpencodeRuntimeConfigError, mergeOpencodeRuntimeConfig, serializeOpencodeRuntimeConfig, opencodeProviderOverridePath, projectConfigOverridesProvider } from "./opencode-config";
export type { OpencodeRuntimeConfigError } from "./opencode-config";
export { opencodeModelKey, opencodeLaunchNativeSlugs, buildOpencodeProviderBlock, buildOpencodeV2ProviderBlock, buildOpencodeProviderBlocksFromCatalog, OPENCODE_PROXY_MODELS_TIMEOUT_MS, fetchOpencodeProxyModels, opencodeCatalogFromProxyRows } from "./opencode-catalog";
export type { OpencodeRoutedModel, OpencodeProxyModelRow } from "./opencode-catalog";
```

Explicit residual local imports (re-export binds nothing locally):

```ts
import type { OpencodeRoutedModel, OpencodeProxyModelRow } from "./opencode-catalog";
import { mergeOpencodeRuntimeConfig, isOpencodeRuntimeConfigError, serializeOpencodeRuntimeConfig, opencodeProviderOverridePath } from "./opencode-config";
import { buildOpencodeProviderBlock, buildOpencodeV2ProviderBlock, fetchOpencodeProxyModels, opencodeCatalogFromProxyRows, buildOpencodeProviderBlocksFromCatalog } from "./opencode-catalog";
import type { OpencodeRuntimeConfigError } from "./opencode-config";
```

Retain original external imports still used by the residual; prune only proven-unused bindings. New leaves import one another directly.

## Module-level state and cycles

No top-level let, Map, Set, WeakMap, lock or timer. `PROJECT_CONFIG_FILENAMES` (`src/cli/opencode.ts:105`) moves only to opencode-config.ts. The fetch timeout (`:317`) and seen Set (`:377`) remain call-local. `ensureProxyForOpencode` (`:592–614`), its provenance-stamped spawn (`:597–602`), and `cmdOpencode` (`:631–682`) stay in the original. No eager launch or catalog fetch on leaf import.

Lane 016's AST import BFS found no return path through the original. The partition avoids new return imports, including type-only ones. Both leaves import the stable client-export boundary; neither imports cli/opencode.ts. opencode-catalog.ts does not import opencode-config.ts. The residual composes the two in buildOpencodeConfig, so catalog/config never need an upward dependency. Types needed by each moved body are colocated or imported from the existing clients boundary.

Coupling classification: existing config-schema coupling stays with format owners; sequential/functional coupling is explicit through parameters. No new common mutable state or temporal startup constraint. Existing auth/ownership checks are moved verbatim. Before execution rerun lane 016 method G against the actual layer base (relative static imports, re-exports, type-only edges and literal dynamic imports); any new return path is escalation, not permission for a lazy-import workaround.

## Tests

Discovery: `rg -l 'src/cli/opencode' tests --glob '*.ts'`, followed by import/source-read inspection. Every direct test/fixture importer is listed below, with disposition **unchanged** (old public path):

- `tests/config/client-config-export.test.ts` — unchanged.
- `tests/providers/opencode-cli.test.ts` — unchanged.

Text oracle: `tests/ci-workflows/bun-runtime.test.ts:241` lists src/cli/opencode.ts; **:246** calls `readFileSync(repoPath(relative), "utf8")`; :247–257 count process.execPath spawns and provenance stamps. **Unchanged**: the detached spawn remains in the residual. No retarget-to-leaf or add-leaf-to-scan-list needed, since neither leaf spawns. C-phase red proof: temporarily remove the residual's withProcessRuntimeProvenance stamp, run that named guard, observe failure, restore and pass. Never replace its list entry with a zero-spawn leaf or weaken the nonzero-spawn assertion. Keep all JSONC, provider-generation, inherited-content, duplicate-row, effort and timeout assertions in opencode-cli.test.ts.

These are future implementation checks, not tests run by this docs author. No new test file is required. Facade/leaf identity assertions may be added in an existing focused test; if a new test file is required, parent must explicitly expand scope to include both test-layout registry files (`scripts/test-layout/layout.json`, `tests/fixtures/test-layout-expected.json`). Never commit red-proof mutations.

## Verification

Future implementation gate only, in the dedicated layer worktree at its actual tip. Domains: config, providers, ci-workflows, cli. Explicit source-reader and subprocess coverage is not replaced by test:changed.

```sh
bun run typecheck
bun test tests/config/client-config-export.test.ts tests/providers/opencode-cli.test.ts tests/ci-workflows/bun-runtime.test.ts tests/cli/cli-export-command.test.ts tests/providers/minimax-clients.test.ts
bun run privacy:scan
wc -l src/cli/opencode-config.ts src/cli/opencode-catalog.ts src/cli/opencode.ts
# Compare resolved old-path consumer identities/counts with the list in this plan
rg -n 'cli/opencode' src gui/src scripts tests
# Full suite on lidge only; parent serializes access to this shared remote checkout
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-cli-opencode && git checkout -q FETCH_HEAD && bun install --frozen-lockfile >/dev/null && bun run test'
```

The remote command intentionally keeps bun run test last, preserving its exit code instead of masking failure behind tail. Parent records remote HEAD and full output. Every command exits 0; focused/full tests report 0 failures. Delivery requires a green exact-head GitHub CI rollup, not an empty required-check list.

Per 002, `bun test tests/lab/core-lab-boundary.test.ts` is conditional on source edits under `src/server|src/router|src/lib`: **not applicable** to this approved layer touch set. Do not edit its PROTECTED roots. If implementation expands into those directories, parent must approve scope and run that guard explicitly. Preserve the 5 original direct consumer files; new facade-to-leaf imports are not caller churn. The grep is a discovery list, not by itself a proof of consumer identity: resolve relative and dynamic paths as in the inventory method. Repeat lane 016 method G on the final imports to prove zero new cycles; typecheck alone is not a cycle detector.

Drafting verification is document-only: required heading order, complete symbol ranges/ownership, projected line arithmetic, export coverage, referenced test paths, unique leaf paths and assigned-file scope. No test, typecheck, privacy scan or remote command above was executed in this drafting task.

## Accept criteria

1. Parent resolves the 500-line budget definition/exception or revises topology before implementation; no claim that literal added+deleted churn passes.
2. Every inventory declaration has exactly one implementation owner. Preserve all original export names/signatures and value/type importability; do not extract L1 declarations a second time.
3. Every new leaf is ≤400 lines. Residual target is 251, ≤400. Measure actual files and explain drift before proceeding.
4. Preserve function bodies, branch order, literals, serialized bytes/key order, class/object identity and state initialization. Only moves, explicit imports and named forwards change source structure.
5. Old-path consumers and assertions remain intact. Record the exact red/restored-green evidence named under Tests; no guard deletion, skipping, weakened assertions or empty-facade source scans.
6. Singleton state/allowlists each have one owner; no leaf imports the original even for types; resolved static/re-export/type/dynamic-literal graph has no new cycles.
7. Typecheck, focused checks, privacy, remote full suite and exact-head CI pass at this layer tip independently of later layers. No full local suite and no merge.
8. Diff stays within the original/new leaves and genuinely required existing focused tests. New tests, SoT edits, new topology or unrelated code require parent scope approval.

## PR

Title: `refactor(cli): separate OpenCode config and catalog from launch (split S13 L3/5)`

Branch: `codex/split-cli-opencode`. Base: `codex/split-clients-config-export-b`. Closes: none.

Use all sections of `.github/PULL_REQUEST_TEMPLATE.md` (Summary, Verification, Checklist), including the size-gate disposition and DEV-STACK-03 map below. This draft creates no PR; placeholder PR numbers are intentional.

| # | PR | Layer | Branch | Base | Review focus |
|---|---|---|---|---|---|
| 1 | #TBD-S13-L1 | 400 | `codex/split-clients-config-export-a` | `dev` | extract low-fanout client formats and dependency foundations |
| 2 | #TBD-S13-L2 | 410 | `codex/split-clients-config-export-b` | `codex/split-clients-config-export-a` | finish client path and format partitions |
| 3 | #TBD-S13-L3 | 420 — this layer | `codex/split-cli-opencode` | `codex/split-clients-config-export-b` | separate OpenCode config and catalog from launch |
| 4 | #TBD-S13-L4 | 430 | `codex/split-cli-minimax` | `codex/split-cli-opencode` | isolate MMX protocol and termination owners |
| 5 | #TBD-S13-L5 | 440 | `codex/split-integrations-state` | `codex/split-clients-config-export-b` | separate classification from state reads |

Depends on #TBD-S13-L2. Review this layer's diff only. Cascade this layer only from its real parent `codex/split-clients-config-export-b`, then re-verify its tip/base ref while preserving checkout ownership. Bottom-up merging remains a separate user-authorized action and is out of scope.
