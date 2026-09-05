# 340 — S11 L3/5: src/codex/cli-install-provenance.ts

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: **pure-move**. Planning class: C3, bounded docs-only delegation; auth/provenance implementation retains C4 security care where noted below.
- Non-goals: No updater policy changes, real process probing, mutation, new Windows inspection, altered file-read flags/bounds, changed report fields, changed digest domains or changes to the dependency-injection API.
- Goal: Split dependency contracts, path ownership observations and bounded manifest reads from the public install-classification coordinator.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated in Verification below (the 000 reference to 003 is stale; 002 is authoritative).
- Stop: this delegated turn stops after writing and statically checking this plan; no source edits, tests, git mutations, orchestration, loop or goal commands. The later executor stops on any changed behavior, missing binding, cycle, oversized leaf, failing guard or basis drift. Layer execution ends only at an open PR with recorded green exact-head CI; never merge.
- Escalation: send any extra file/layer requirement or boundary change to the parent. Execution also requires the parent to resolve the 500-line diff-size contradiction below.

Basis: docs HEAD `4cc219549`; source `origin/dev = 1362b1a3841b4de20177e5d65865a513dd7936c4`. All source line references below are to that source snapshot. `git diff --numstat origin/dev -- src/codex/cli-install-provenance.ts` is empty. Lane audit: `devlog/_plan/260905_modular_debt_ledger/013_lane_providers_codex_oauth_routing.md:335`. No implementation proof is claimed here.

## Symbol inventory

Every top-level declaration is listed, including private declarations and import bindings. Inclusive start–end spans were extracted with `sg run --lang ts --kind <function_declaration|interface_declaration|type_alias_declaration|lexical_declaration> --json=compact src/codex/cli-install-provenance.ts` and checked against `git show origin/dev:src/codex/cli-install-provenance.ts` with numbered lines. Nested declarations are intentionally not top-level rows.

Consumers = unique **direct importing/re-exporting files**, not identifier occurrences or callers inside this module. Start from `rg -l -F 'cli-install-provenance' src gui/src scripts tests`, inspect import/re-export clauses, resolve each relative specifier to this exact file, then intersect each named binding with `rg -l -w '<symbol>' src gui/src scripts tests`. Private declarations have zero external consumers; same-spelling symbols elsewhere are not consumers. Type-only imports count. Imported bindings themselves are local, not exports. Baseline: 3 direct files; test-only leaf imports for new identity assertions do not replace any original import.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `createHash` | import binding(s) | 1–1 | no | 0 (local imports) | cli-install-provenance-files.ts |
| `closeSync, fsConstants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync` | import binding(s) | 2–12 | no | 0 (local imports) | files/paths/types leaves; residual statSync |
| `posix, win32` | import binding(s) | 13–13 | no | 0 (local imports) | paths leaf; residual win32 |
| `getConfigDir` | import binding(s) | 14–14 | no | 0 (local imports) | residual |
| `parseStrictSemver` | import binding(s) | 15–15 | no | 0 (local imports) | files leaf |
| `CODEX_CLI_VERSION_MANAGER_ROOT_ENV_SLOTS` | import binding(s) | 16–16 | no | 0 (local imports) | paths leaf |
| `isSpawnableCodexCandidate` | import binding(s) | 17–17 | no | 0 (local imports) | paths leaf |
| `codexRuntimeStatePath, parsePersistedCodexRuntime` | import binding(s) | 18–21 | no | 0 (local imports) | residual |
| `inspectCodexShimBackingForCommand, isLocalAbsoluteInspectionPath, isVersionManagerOwnedCodexPath, CodexShimBackingForCommand` | import binding(s) | 22–27 | no | 0 (local imports) | residual/paths/types (exact imports below) |
| `CODEX_PACKAGE` | const | 29–29 | no | 0 | `src/codex/cli-install-provenance-files.ts` |
| `MAX_MANIFEST_BYTES` | const | 30–30 | no | 0 | `src/codex/cli-install-provenance-files.ts` |
| `MAX_RUNTIME_STATE_BYTES` | const | 31–31 | no | 0 | `src/codex/cli-install-provenance.ts (residual)` |
| `MAX_MANIFEST_ANCESTORS` | const | 32–32 | no | 0 | `src/codex/cli-install-provenance-files.ts` |
| `CodexCliInstallKind` | type alias | 34–39 | yes | 0 | `src/codex/cli-install-provenance-types.ts` |
| `CodexCliInstallReason` | type alias | 41–54 | yes | 0 | `src/codex/cli-install-provenance-types.ts` |
| `CodexCliCandidateSource` | type alias | 56–56 | yes | 0 | `src/codex/cli-install-provenance-types.ts` |
| `CodexCliInstallEvidence` | type alias | 57–64 | yes | 0 | `src/codex/cli-install-provenance-types.ts` |
| `ReadOnlyCodexRuntimeCandidate` | interface | 66–70 | yes | 0 | `src/codex/cli-install-provenance-types.ts` |
| `CodexCliInstallReport` | interface | 72–91 | yes | 2 | `src/codex/cli-install-provenance-types.ts` |
| `CodexCliInstallProvenanceDeps` | interface | 93–108 | yes | 3 | `src/codex/cli-install-provenance-types.ts` |
| `PackageManifestEvidence` | interface | 110–116 | no | 0 | `src/codex/cli-install-provenance-files.ts` |
| `sha256` | function | 118–124 | no | 0 | `src/codex/cli-install-provenance-files.ts` |
| `validatedVersion` | function | 126–129 | no | 0 | `src/codex/cli-install-provenance-files.ts` |
| `publicExecutableLocation` | function | 131–136 | no | 0 | `src/codex/cli-install-provenance-paths.ts` |
| `freezeReport` | function | 138–142 | no | 0 | `src/codex/cli-install-provenance.ts (residual)` |
| `unknownReport` | function | 144–166 | no | 0 | `src/codex/cli-install-provenance.ts (residual)` |
| `unknownWindowsReport` | function | 168–177 | no | 0 | `src/codex/cli-install-provenance.ts (residual)` |
| `readPersistedCandidate` | function | 179–205 | no | 0 | `src/codex/cli-install-provenance.ts (residual)` |
| `observeCodexRuntimeCandidateReadOnly` | function | 211–224 | yes | 0 | `src/codex/cli-install-provenance.ts (residual)` |
| `pathTools` | function | 226–228 | no | 0 | `src/codex/cli-install-provenance-paths.ts` |
| `isWindowsPlatform` | function | 230–232 | no | 0 | `src/codex/cli-install-provenance-paths.ts` |
| `isSafeLocalInspectionPath` | function | 234–240 | no | 0 | `src/codex/cli-install-provenance-paths.ts` |
| `caseInsensitiveEnv` | function | 242–245 | no | 0 | `src/codex/cli-install-provenance-paths.ts` |
| `resolveCandidateCommandPath` | function | 247–288 | no | 0 | `src/codex/cli-install-provenance-paths.ts` |
| `canonicalize` | function | 290–298 | no | 0 | `src/codex/cli-install-provenance-paths.ts` |
| `normalizePath` | function | 300–306 | no | 0 | `src/codex/cli-install-provenance-paths.ts` |
| `samePath` | function | 308–310 | no | 0 | `src/codex/cli-install-provenance-paths.ts` |
| `isAppBundledCodexPath` | function | 312–321 | yes | 1 | `src/codex/cli-install-provenance-paths.ts` |
| `isCodexCliUpdateVersionManagerPath` | function | 324–348 | yes | 1 | `src/codex/cli-install-provenance-paths.ts` |
| `configuredVersionManagerRoots` | function | 350–369 | no | 0 | `src/codex/cli-install-provenance-paths.ts` |
| `isWithinConfiguredVersionManagerRoot` | function | 371–377 | no | 0 | `src/codex/cli-install-provenance-paths.ts` |
| `readBoundedFile` | function | 379–459 | no | 0 | `src/codex/cli-install-provenance-files.ts` |
| `manifestCandidates` | function | 461–484 | no | 0 | `src/codex/cli-install-provenance-files.ts` |
| `manifestBinPath` | function | 486–495 | no | 0 | `src/codex/cli-install-provenance-files.ts` |
| `findCodexPackageManifest` | function | 497–527 | no | 0 | `src/codex/cli-install-provenance-files.ts` |
| `launcherIsLinkedToManifest` | function | 529–543 | no | 0 | `src/codex/cli-install-provenance-files.ts` |
| `isProvenGlobalNpmLayout` | function | 545–571 | no | 0 | `src/codex/cli-install-provenance-files.ts` |
| `shimReport` | function | 573–581 | no | 0 | `src/codex/cli-install-provenance.ts (residual)` |
| `inspectCodexCliInstall` | function | 584–795 | yes | 2 | `src/codex/cli-install-provenance.ts (residual)` |

## Leaf partition

Structural decision: The 795-line file combines bounded IO, path policy and report classification. Reject extracting readBoundedFile alone: it would not bring the residual below 400, and a files leaf importing facade-owned path helpers would create a cycle. Choose three same-directory concern siblings, following src/codex/history-manifest.ts and src/codex/history-provider.ts. Move the existing dependency/report contracts first, path helpers second, then the file evidence cluster; the outer coordinator remains original. Blast radius: Codex CLI update feature. This is C4-care during later implementation because it moves filesystem/provenance checks; explicit security review under MAINTAINERS.md:60 is still required.

Pre-change/intended map: Current: src/cli/codex-cli-update.ts:1 and two test files → cli-install-provenance.ts → config, strict-semver, update launch policy, exec-invocation, runtime and shim. Intended local order: facade → files → paths → types; facade also imports paths/types directly. types uses only type imports from node:fs and ./shim. files owns the manifest digest/read boundary; paths owns path canonicalization and version-manager classification; runtime observation and report assembly stay in facade. None of these leaves imports cli-install-provenance.ts.

Sizing escalation: 454 existing physical lines move, so the source additions-plus-deletions lower bound is 908 before import rewiring and guards. That cannot satisfy a literal 500-line changed-source cap in 002 while preserving this five-layer S11 map. The parent must explicitly accept a pure-move size exception or revise 002 with extra parts/stacks before implementation. This document is a complete proposed partition, not a claim that the cap is met. No #b layer is silently invented; the planned single-layer residual is already below 400.

### `src/codex/cli-install-provenance-types.ts` — 79 expected lines

Move source bands `src/codex/cli-install-provenance.ts:34`–108 (75 physical lines including existing inter-declaration comments/blanks). Symbols: `CodexCliInstallKind`, `CodexCliInstallReason`, `CodexCliCandidateSource`, `CodexCliInstallEvidence`, `ReadOnlyCodexRuntimeCandidate`, `CodexCliInstallReport`, `CodexCliInstallProvenanceDeps`.

Keep existing exported declarations exported. All other private declarations stay private.

Own imports (complete):

```ts
import type { lstatSync, statSync } from "node:fs";
import type { CodexShimBackingForCommand } from "./shim";
```

### `src/codex/cli-install-provenance-paths.ts` — 168 expected lines

Move source bands `src/codex/cli-install-provenance.ts:131`–137, `src/codex/cli-install-provenance.ts:226`–378 (160 physical lines including existing inter-declaration comments/blanks). Symbols: `publicExecutableLocation`, `pathTools`, `isWindowsPlatform`, `isSafeLocalInspectionPath`, `caseInsensitiveEnv`, `resolveCandidateCommandPath`, `canonicalize`, `normalizePath`, `samePath`, `isAppBundledCodexPath`, `isCodexCliUpdateVersionManagerPath`, `configuredVersionManagerRoots`, `isWithinConfiguredVersionManagerRoot`.

Keep existing exported declarations exported. Add the `export` modifier (without changing a body/signature) only to these formerly private declarations needed by another production module: `publicExecutableLocation`, `pathTools`, `isWindowsPlatform`, `isSafeLocalInspectionPath`, `resolveCandidateCommandPath`, `canonicalize`, `normalizePath`, `samePath`, `configuredVersionManagerRoots`, `isWithinConfiguredVersionManagerRoot`. Every other private declaration stays private; none of the new internal exports is added to the facade.

Own imports (complete):

```ts
import { existsSync, lstatSync, statSync, realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import { CODEX_CLI_VERSION_MANAGER_ROOT_ENV_SLOTS } from "../update/codex-cli-update-launch-policy.mjs";
import { isSpawnableCodexCandidate } from "./exec-invocation";
import { isLocalAbsoluteInspectionPath, isVersionManagerOwnedCodexPath } from "./shim";
import type { CodexCliInstallProvenanceDeps } from "./cli-install-provenance-types";
```

### `src/codex/cli-install-provenance-files.ts` — 226 expected lines

Move source bands `src/codex/cli-install-provenance.ts:29`–30, `src/codex/cli-install-provenance.ts:32`–33, `src/codex/cli-install-provenance.ts:110`–130, `src/codex/cli-install-provenance.ts:379`–572 (219 physical lines including existing inter-declaration comments/blanks). Symbols: `CODEX_PACKAGE`, `MAX_MANIFEST_BYTES`, `MAX_MANIFEST_ANCESTORS`, `PackageManifestEvidence`, `sha256`, `validatedVersion`, `readBoundedFile`, `manifestCandidates`, `manifestBinPath`, `findCodexPackageManifest`, `launcherIsLinkedToManifest`, `isProvenGlobalNpmLayout`.

Keep existing exported declarations exported. Add the `export` modifier (without changing a body/signature) only to these formerly private declarations needed by another production module: `validatedVersion`, `readBoundedFile`, `findCodexPackageManifest`, `launcherIsLinkedToManifest`, `isProvenGlobalNpmLayout`. Every other private declaration stays private; none of the new internal exports is added to the facade.

Own imports (complete):

```ts
import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { parseStrictSemver } from "../lib/strict-semver";
import type { CodexCliInstallProvenanceDeps } from "./cli-install-provenance-types";
import { pathTools, isSafeLocalInspectionPath, canonicalize, normalizePath, samePath } from "./cli-install-provenance-paths";
```

### Residual `src/codex/cli-install-provenance.ts` — 324 expected lines

Keep these declarations: `MAX_RUNTIME_STATE_BYTES`, `freezeReport`, `unknownReport`, `unknownWindowsReport`, `readPersistedCandidate`, `observeCodexRuntimeCandidateReadOnly`, `shimReport`, `inspectCodexCliInstall`.

Accounting: 795 original − 454 moved − 28 replaced import/header lines + 8 explicit import lines + 2 named re-export lines + 1 separator = **324**. Each leaf estimate is its source-band count + own import lines + two header/separator lines. These are physical-line estimates using the compact exact import blocks below, not a claim of measured implementation output. Preserve comments, allow readable multiline imports, and remeasure after formatting; no file may exceed 400. No residual >400 and no #b required by file length. No #a/#b/#c parts are added in this five-layer map. Original function bodies over 50 lines remain unchanged as an explicit pure-move exception; splitting their logic is out of scope.

## Re-export block

Insert at the existing feature boundary, using named re-exports only. This is preservation of an established path, not a new internal index barrel. Re-exports create no local bindings.

```ts
export type { CodexCliInstallKind, CodexCliInstallReason, CodexCliCandidateSource, CodexCliInstallEvidence, ReadOnlyCodexRuntimeCandidate, CodexCliInstallReport, CodexCliInstallProvenanceDeps } from "./cli-install-provenance-types";
export { isAppBundledCodexPath, isCodexCliUpdateVersionManagerPath } from "./cli-install-provenance-paths";
```

Retain these current exports as declarations in the original file (not copies): `observeCodexRuntimeCandidateReadOnly`, `inspectCodexCliInstall`. Together with the block above this preserves the complete old type/value export set; leaf-private API is not added to the facade.

Explicit residual imports (replace the old import block):

```ts
import { statSync } from "node:fs";
import { win32 } from "node:path";
import { getConfigDir } from "../config";
import { codexRuntimeStatePath, parsePersistedCodexRuntime } from "./runtime";
import { inspectCodexShimBackingForCommand, isLocalAbsoluteInspectionPath, type CodexShimBackingForCommand } from "./shim";
import type { CodexCliInstallReport, CodexCliInstallReason, CodexCliInstallEvidence, CodexCliInstallProvenanceDeps, ReadOnlyCodexRuntimeCandidate } from "./cli-install-provenance-types";
import { publicExecutableLocation, pathTools, isWindowsPlatform, isSafeLocalInspectionPath, resolveCandidateCommandPath, canonicalize, isAppBundledCodexPath, isCodexCliUpdateVersionManagerPath, configuredVersionManagerRoots, isWithinConfiguredVersionManagerRoot } from "./cli-install-provenance-paths";
import { validatedVersion, readBoundedFile, findCodexPackageManifest, launcherIsLinkedToManifest, isProvenGlobalNpmLayout } from "./cli-install-provenance-files";
```

## Module-level state and cycles

Lane 013 and the top-level inventory identify no mutable module state: no top-level let, Map, Set, WeakMap, lock or flight. CODEX_PACKAGE (29), MAX_MANIFEST_BYTES (30), MAX_MANIFEST_ANCESTORS (32) move to files; MAX_RUNTIME_STATE_BYTES (31) stays with readPersistedCandidate. Sets at 368 and 483 are fresh per invocation and stay in paths/files respectively. File descriptor fd at 402 belongs to each readBoundedFile invocation, including its finally close, and moves as one whole function. Do not split or duplicate that ownership. Preserve dependency lookup inside calls; never hoist deps.env/deps.platform/deps.stat or process.env captures into module state. files → facade for isSafeLocalInspectionPath or types would form a new cycle; the explicit paths/types leaves remove that edge, including type-only imports.

Lane 013 reported no static return-path cycle for this source. This plan's new local graph is acyclic by the dependency direction above; this is not a substitute for the executor's fresh whole-relative-graph return-path scan. Include type-only imports/re-exports, not merely runtime imports. New edges are Functional/Sequential coupling, not shared mutable Common state; preserve existing invocation ordering rather than adding locks or global owners. No leaf imports `./cli-install-provenance` or any facade that routes back into itself. No lazy import workaround.

## Tests

Direct importer list, reproduced by `rg -l -F 'src/codex/cli-install-provenance' tests` (all **unchanged**, including import path and existing assertions):

- `tests/cli/cli-codex-cli-update.test.ts` — unchanged.
- `tests/codex-integration/codex-cli-install-provenance.test.ts` — unchanged.

Text-oracle inventory: **none found** for this exact source path. Inspected basename/path matches and segmented `repoPath` forms for `readFileSync`, `Bun.file` and source-reader helpers, consistent with lane 013. There is therefore no source-read line to retarget and no explicit scan-list entry to add. A basename occurrence in `tests/fixtures/test-layout-expected.json` is test registration, not a source read. Generic recursive import-graph coverage is unchanged and discovers imports naturally. If implementation finds a computed/path-list source oracle not captured here, stop and extend the inventory with its exact read line before moving code; do not weaken it.

Keep both direct-import test files unchanged in their behavioral cases. Preserve tests/codex-integration/codex-cli-install-provenance.test.ts:62 (Windows no-filesystem calls), :111 (no persisted-state read on Windows), :125 (lexical report-only classifications), and :146 (version-manager layout discrimination), plus all existing injected and native filesystem fixtures. Add named-export identity assertions for isAppBundledCodexPath and isCodexCliUpdateVersionManagerPath to that existing test using ../../src/codex/cli-install-provenance-paths. Drive the identity guard red with a temporary facade wrapper for isAppBundledCodexPath, restore, then green. Typecheck covers the moved public contracts; audit the exact seven exported type names against the old boundary. Do not add exports for sha256 or private filesystem types solely for tests.

These red-once mutations are future disposable-worktree verification steps, never persistent changes. They were not performed during drafting. Extend existing test files only; no new test file or test-layout entry is planned. `tests/lab/core-lab-boundary.test.ts` PROTECTED roots are never edited.

## Verification

Future implementation commands only; **none run in this docs-only task**. Execute against this layer's own tip, domains **codex-integration, cli**, not the eventual stack top.

```sh
bun run typecheck
bun test tests/codex-integration/codex-cli-install-provenance.test.ts tests/cli/cli-codex-cli-update.test.ts
bun run privacy:scan
wc -l src/codex/cli-install-provenance-types.ts src/codex/cli-install-provenance-paths.ts src/codex/cli-install-provenance-files.ts src/codex/cli-install-provenance.ts
rg -l -F 'codex/cli-install-provenance' src gui/src scripts tests
# Resolve relative import/re-export paths and compare the original consumer file set.
# Full suite: lidge only, no local full-suite invocation; keep the full exit status/log.
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-codex-cli-install-provenance && git checkout -q FETCH_HEAD && bun install --frozen-lockfile && bun run test'
```

For the 002 importer gate, the expected **existing** direct consumer set is 3: `src/cli/codex-cli-update.ts`, `tests/cli/cli-codex-cli-update.test.ts`, `tests/codex-integration/codex-cli-install-provenance.test.ts`. The rg line above is a candidate list, not the count: same-directory imports and aliases require the path resolution described in Symbol inventory. Compare file sets, not statement counts; added leaf imports in identity tests are intentional. No original consumer migrates away from this boundary. Typecheck must still resolve every old export.

Cycle verification: repeat lane 013 SG-GRAPH using `sg run --lang ts --kind import_statement --json=compact src` and `sg run --lang ts --kind export_statement --json=compact src`; resolve relative .ts/.tsx/index targets, include type edges, and search for a return path to the original or any new leaf. Require no new return path; record the scoped graph result. Do not install a new dependency tool for this layer.

The 002 conditional Lab gate is not triggered by these planned source paths (none is src/server, src/router.ts or src/lib). If the implementation touches one of those paths, that is an expansion requiring parent approval and `bun test tests/lab/core-lab-boundary.test.ts`; keep PROTECTED unchanged. All new leaves must stay free of a transitive Lab dependency regardless.

Record red then green for the guard named in Tests, typecheck exit 0, focused tests 0 failures, privacy scan exit 0, actual per-file line counts, full-suite exit 0 on lidge, the exact tested SHA and CI rollup. The remote worktree is parent-coordinated; confirm ownership before checkout and require its tested SHA to equal the PR head. Do not mask test exit status with an unguarded tail pipeline. Revalidate after any cascade.

## Accept criteria

1. Source still matches the stated basis or the plan is refreshed for every changed symbol before extraction. Parent size disposition is recorded before implementation; absent that decision the layer is not executable.
2. Every inventory declaration has exactly one owner; all function bodies/signatures and constant/type definitions are moved verbatim, apart from the necessary export modifiers and import paths. No public export is renamed, deleted, wrapped or newly invented.
3. Every current export remains importable from `src/codex/cli-install-provenance.ts`; moved values pass identity guards where applicable, and residual references are satisfied by real imports, not a re-export-only assumption.
4. Actual 3 new leaves and the residual are each ≤400 physical lines. Record counts rather than relying on these estimates. No hidden #b or unplanned source file is required.
5. Reports retain identical freezing, classification reasons, selectionAttested/managed values and injected dependency behavior; no additional filesystem access or process execution is introduced.
6. State/constant ownership matches this plan; fresh relative-import graph reports no new cycle, including type-only edges, and no new Lab reachability.
7. Existing tests/imports/source guards are retained without weakening; the specified guard is demonstrated red once and restored green. All instantiated 002 gates and exact-head CI are green with recorded evidence.
8. PR uses the template, correct base and complete five-layer map. No merge, release, deployment, dependency installation on the user's running service, or unrelated code change is included.

## PR

Title: `refactor(codex): separate install evidence from classification (split S11 L3/5)`

Branch: `codex/split-codex-cli-install-provenance`. Base: `dev`. Closes: **none**.

Use `.github/PULL_REQUEST_TEMPLATE.md` with Summary, Verification and Checklist. Put the measured move size and any parent-approved exception in Summary, evidence tied to this PR head in Verification, and include the stack map below. Review this layer's diff only. PR numbers are intentionally unassigned planning placeholders, not existing PR claims.

| # | PR | Layer | Branch | Base | Review focus |
|---|---|---|---|---|---|
| 1 | #TBD-S11-L1 |  L1 | `codex/split-combos-types` | `dev` | isolate combo identifiers from validation |
| 2 | #TBD-S11-L2 |  L2 | `codex/split-codex-subagent-defaults` | `dev` | isolate format-preserving subagent TOML lexing |
| 3 | #TBD-S11-L3 | **L3 — this layer** | `codex/split-codex-cli-install-provenance` | `dev` | separate install evidence from classification |
| 4 | #TBD-S11-L4 |  L4 | `codex/split-routing-trace` | `dev` | separate trace contracts and evidence codecs |
| 5 | #TBD-S11-L5 |  L5 | `codex/split-oauth-github-copilot` | `dev` | isolate GitHub device grant transport |

Base: dev — no dependency on the layers below; no cascade obligation.

DEV-STACK-04: merges remain separately authorized; this task performs none.
