# 520 — S15 L5/5: src/lab/fabric/scratch.ts

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: `pure-move`; C3 architecture planning, docs-only bounded delegation. cxc-dev §1/§5 and cxc-dev-architecture apply. Parent alone owns orchestration, loop and goal state.
- Goal: separate scratch access from fixture lifetime, with every original public export and behavior preserved.
- Non-goals: no behavior fixes, new validation, renamed symbols, signature changes, new dependencies, public API expansion, core activation changes, releases or merges. This document plans implementation; this drafting task changes no source and runs no tests.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below; full tests only on `ssh lidge`, never locally.
- Stop: independent layer-tip verification and green exact-head CI evidence recorded, with the layer PR open; do not merge. Stop before implementation if a stated escalation is unresolved.
- Escalation: source drift, unexpected oracle coupling, new cycle, public export loss, changed state lifetime, any scope expansion, or the size-budget conflict below goes to the parent. Do not add a sixth stack layer or edit 002 here.
- Basis: docs HEAD `4cc219549`; verified source `origin/dev = 1362b1a3841b4de20177e5d65865a513dd7936c4`. All source anchors in this document refer to that revision. `git show origin/dev:src/lab/fabric/scratch.ts` matches the working file byte-for-byte.
- Prior audited seam: `devlog/_plan/260905_modular_debt_ledger/016_lane_cli_storage_usage_update_lab_scripts.md:739`. Read together with 000, 001, 002; actual consumer/oracle evidence below supersedes the approximate basename-based counts in 001.

Structural decision before implementation: Current: patch.ts:2, verifier.ts, executor.ts and fabric/index.ts:50 consume scratch; dependencies are node fs/path/crypto, paths, fabric constants and FabricTaskError (1–19). Chosen: extract the complete trusted path/descriptor-access subsystem and fixture lifetime into two siblings, retain walk/read/write APIs and user-repo exclusion. Rejected: fixture-only extraction back-imports private access helpers and creates a cycle; replacing the scratch capability design is outside a pure-move layer. The exported interface remains available at the same path with no signature change.

## Symbol inventory

Measured by `sg run --lang ts --kind 'function_declaration,interface_declaration,type_alias_declaration,lexical_declaration' --json=compact src/lab/fabric/scratch.ts`, matched to column-zero declarations in the pinned source. Nested declarations are excluded. Ranges include declaration syntax through its closing line, not preceding comments.

Consumers are distinct direct import/re-export files across `src gui/src scripts tests`, found with `rg -l` path/symbol searches and verified against the actual import binding. A wildcard re-export counts once for every public symbol; a dynamic namespace import counts for runtime exports, not erased types. Private declarations have zero external consumers, even if unrelated same-named declarations occur elsewhere. Transitive barrel clients are covered by the Lab domain gate, not double-counted. Total direct module consumers: **5**.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| O_DIRECTORY | const | 23–23 | no | 0 | src/lab/fabric/scratch-access.ts |
| O_NOFOLLOW | const | 24–24 | no | 0 | src/lab/fabric/scratch-access.ts |
| FILE_MODE | const | 25–25 | no | 0 | src/lab/fabric/scratch-access.ts |
| TrustedScratchDir | interface | 27–31 | no | 0 | src/lab/fabric/scratch-access.ts |
| assertRegularFile | function | 34–38 | no | 0 | src/lab/fabric/scratch-access.ts |
| assertRealDirectory | function | 41–45 | no | 0 | src/lab/fabric/scratch-access.ts |
| identityOf | function | 48–50 | no | 0 | src/lab/fabric/scratch-access.ts |
| platformSupportsNoFollow | function | 53–55 | no | 0 | src/lab/fabric/scratch-access.ts |
| openFlags | function | 58–61 | no | 0 | src/lab/fabric/scratch-access.ts |
| assertScratchName | function | 64–68 | no | 0 | src/lab/fabric/scratch-access.ts |
| revalidateScratchDir | function | 71–77 | no | 0 | src/lab/fabric/scratch-access.ts |
| childScratchPath | function | 80–84 | no | 0 | src/lab/fabric/scratch-access.ts |
| openAtScratch | function | 87–103 | no | 0 | src/lab/fabric/scratch-access.ts |
| openTrustedScratchRoot | function | 106–117 | no | 0 | src/lab/fabric/scratch-access.ts |
| closeTrustedScratchRoot | function | 120–126 | no | 0 | src/lab/fabric/scratch-access.ts |
| openScratchRelativePath | function | 129–165 | no | 0 | src/lab/fabric/scratch-access.ts |
| readAllFromFd | function | 168–180 | no | 0 | src/lab/fabric/scratch-access.ts |
| assertSafeRelativePosixPath | function | 183–201 | yes | 2 | src/lab/fabric/scratch-access.ts |
| assertUnderScratchRoot | function | 204–208 | no | 0 | src/lab/fabric/scratch-access.ts |
| resolveInsideScratch | function | 214–240 | yes | 1 | src/lab/fabric/scratch-access.ts |
| ensureScratchRelativeDir | function | 243–267 | no | 0 | src/lab/fabric/scratch-access.ts |
| ScratchTree | interface | 270–273 | yes | 2 | src/lab/fabric/scratch-fixture.ts |
| createSyntheticScratch | function | 276–323 | yes | 2 | src/lab/fabric/scratch-fixture.ts |
| WalkedFile | interface | 326–330 | yes | 1 | src/lab/fabric/scratch.ts |
| walkScratchFiles | function | 333–376 | yes | 1 | src/lab/fabric/scratch.ts |
| readScratchFileUtf8 | function | 379–397 | yes | 2 | src/lab/fabric/scratch.ts |
| writeScratchFileUtf8 | function | 400–430 | yes | 2 | src/lab/fabric/scratch.ts |
| assertNotUnderUserRepo | function | 433–439 | yes | 2 | src/lab/fabric/scratch.ts |

Direct edge evidence (including public re-exports):

- `src/lab/fabric/patch.ts:2` — assertSafeRelativePosixPath, writeScratchFileUtf8.
- `src/lab/fabric/index.ts:45` — assertSafeRelativePosixPath, resolveInsideScratch, createSyntheticScratch, assertNotUnderUserRepo.
- `src/lab/fabric/index.ts:51` — ScratchTree, WalkedFile.
- `src/lab/fabric/verifier.ts:9` — readScratchFileUtf8, walkScratchFiles.
- `src/lab/fabric/executor.ts:19` — assertNotUnderUserRepo, createSyntheticScratch, ScratchTree.
- `tests/lab/lab-fabric-task.test.ts:49` — writeScratchFileUtf8, readScratchFileUtf8.

Import declarations are not new owners: their exact leaf/residual binding allocations are given below. No default export exists.

## Leaf partition

Reuse the existing same-directory sibling convention: `events/limits.ts`, `events/errors.ts`, `ledger/artifact-refs.ts`, `artifacts/secure-fs.ts`, `fabric/producer-protocol.ts`. The five source directories and proposed names were inspected with `rg --files`; none of the new paths exists at the pinned source. No new index/barrel, generic utils module, package or directory is needed. The original paths are compatibility boundaries explicitly retained by the split-train contract, not new internal convenience barrels.

Move complete source slices with their inline/leading comments as listed; only add the listed imports, named re-exports and leaf-local export modifiers needed by other leaves/the residual. Never re-export formerly private implementation helpers from the original public path.

### src/lab/fabric/scratch-access.ts

- Original slices: `src/lab/fabric/scratch.ts:23–267`.
- Symbols: `O_DIRECTORY`, `O_NOFOLLOW`, `FILE_MODE`, `TrustedScratchDir`, `assertRegularFile`, `assertRealDirectory`, `identityOf`, `platformSupportsNoFollow`, `openFlags`, `assertScratchName`, `revalidateScratchDir`, `childScratchPath`, `openAtScratch`, `openTrustedScratchRoot`, `closeTrustedScratchRoot`, `openScratchRelativePath`, `readAllFromFd`, `assertSafeRelativePosixPath`, `assertUnderScratchRoot`, `resolveInsideScratch`, `ensureScratchRelativeDir`.
- Expected lines: **249** = 245 moved lines + 4 import/header-separator lines + 0 inter-slice separators; ≤400.
- Additional leaf-only exports for existing cross-partition calls: `FILE_MODE`, `TrustedScratchDir`, `assertRegularFile`, `assertRealDirectory`, `openFlags`, `openTrustedScratchRoot`, `closeTrustedScratchRoot`, `openScratchRelativePath`, `readAllFromFd`, `ensureScratchRelativeDir`.
- Own imports:

```ts
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, type Stats } from "node:fs";
import { join, posix, resolve, sep } from "node:path";
import { FabricTaskError } from "./types";
```

### src/lab/fabric/scratch-fixture.ts

- Original slices: `src/lab/fabric/scratch.ts:269–323`.
- Symbols: `ScratchTree`, `createSyntheticScratch`.
- Expected lines: **63** = 55 moved lines + 8 import/header-separator lines + 0 inter-slice separators; ≤400.
- Additional leaf-only exports for existing cross-partition calls: none; preserve existing exported declaration modifiers.
- Own imports:

```ts
import { closeSync, constants as fsConstants, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { ensureLabDirs, ensureRestrictedDir, labRoot, labScratchDir } from "../paths";
import { FABRIC_LIMITS, SYNTHETIC_BEFORE_UTF8, SYNTHETIC_VALUE_PATH } from "./constants";
import { FabricTaskError } from "./types";
import { FILE_MODE, type TrustedScratchDir, openFlags, openTrustedScratchRoot, closeTrustedScratchRoot, openScratchRelativePath } from "./scratch-access";
```

Residual `src/lab/fabric/scratch.ts`: **128 expected lines**. Retained declarations: `WalkedFile`, `walkScratchFiles`, `readScratchFileUtf8`, `writeScratchFileUtf8`, `assertNotUnderUserRepo`.

Line accounting: 439 logical source lines − 300 moved lines − 19 original import/header lines + 8 explicit import/re-export lines = 128. Keep formatting compact as shown; extra formatting lines must still fit the 400-line gate. No residual exceeds 400; no #b layer is required for file size.

Changeset accounting: 300 original lines move; raw additions+deletions for the move alone are 600, before import glue. **Parent decision required:** this exceeds the ≤500 changed-source-line/default PR limit if measured as raw Git additions+deletions. The fixed five-layer S15 map does not allocate a #b for this file. Do not claim this layer satisfies that limit. Parent must explicitly accept a pure-move size exception (with moved-line review evidence) or revise the train topology before code execution. This document does not authorize either change.

## Re-export block

Exact named re-exports to add/retain at the original path:

```ts
export { assertSafeRelativePosixPath, resolveInsideScratch } from "./scratch-access";
export { createSyntheticScratch } from "./scratch-fixture";
export type { ScratchTree } from "./scratch-fixture";
```

WalkedFile, walkScratchFiles, readScratchFileUtf8, writeScratchFileUtf8 and assertNotUnderUserRepo remain exported declarations.

Explicit local imports for the residual (replace the original import block); re-export statements bind nothing locally:

```ts
import { closeSync, constants as fsConstants, fstatSync, lstatSync, readdirSync, writeSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { FABRIC_LIMITS } from "./constants";
import { FabricTaskError } from "./types";
import { FILE_MODE, assertRegularFile, assertRealDirectory, openFlags, openTrustedScratchRoot, closeTrustedScratchRoot, openScratchRelativePath, readAllFromFd, assertSafeRelativePosixPath, resolveInsideScratch, ensureScratchRelativeDir } from "./scratch-access";
```

The residual does not call createSyntheticScratch or name ScratchTree; its re-exports need no matching local import.

## Module-level state and cycles

No top-level let, Map, Set, WeakMap or active lock exists. O_DIRECTORY (23), O_NOFOLLOW (24), FILE_MODE (25) move once to scratch-access.ts; the feature-detected filesystem flag values remain eagerly captured at module evaluation. TrustedScratchDir (27–31) has a single type owner there. File descriptors and intermediateFds (137) remain operation-local, with unchanged close paths. createSyntheticScratch's trusted handle and cleanup capture (282,302–320) stay together in scratch-fixture.ts. No singleton root or new registry is introduced.
New direction: scratch façade → fixture → access → FabricTaskError; scratch façade → access. Access never imports scratch or scratch-fixture. Extracting fixture alone would produce fixture → scratch → fixture through openTrustedScratchRoot/openScratchRelativePath; moving the complete access group removes that cycle. Keep assertSafeRelativePosixPath with openScratchRelativePath so their mutual file-placement dependency cannot point back to the façade. Existing no-follow checks, inode checks, path resolution, synchronous writes and cleanup are moved verbatim, not redesigned.

Existing lane evidence found no cycle through this file. Recheck the concrete resolved graph at implementation tip, including type-only edges; typecheck alone does not prove acyclicity. This plan introduces only the directed edges above. Do not change protected core roots, turn startServer async, or add activation imports into them.

## Tests

Direct import/dynamic-import test `rg -l` list, all **unchanged** at their original import path:

- `tests/lab/lab-fabric-task.test.ts` — unchanged (import at 49).

Discovery commands (run across all tests, not just tests/lab):

```sh
rg -l 'src/lab/fabric/scratch' tests --glob '*.ts'
rg -n 'src/lab/fabric/scratch|scratch\.ts' tests --glob '*.ts'
rg -n 'readFileSync|Bun\.file|readFile\(|source\(' tests --glob '*.ts'
```

Dedicated source-text readers of this file: **none found**. No retarget-to-leaf or add-leaf-to-scan-list is required for a dedicated source oracle.
The generic `tests/lab/core-lab-boundary.test.ts` reads traversed source at **69**, protected roots at **278/336**, and the server composition source at **355**. It reports the first edge into Lab before traversing that target, so these Lab leaves are not dedicated source-text inputs on a successful run. Disposition: **unchanged**, no scan-list addition, never edit `PROTECTED` (20–28). Include its existing negative-fixture cases in the implementation gate.

Additional transitive-barrel/behavioral coverage: `tests/lab/lab-fabric-outcome-validation.test.ts` — unchanged; `tests/lab/lab-fabric-persistence-boundary.test.ts` — unchanged. Run `tests/lab` for all indirect callers.

Guards to drive red once during implementation (temporary mutations must be restored before committing):

Drive the existing traversal rejection at `tests/lab/lab-fabric-task.test.ts:551` red once by a temporary bypass of the moved path validator, restore and rerun. Keep special-file (572), intermediate-symlink IO (586), patch-path boundary (812), and user-repository exclusion (856) cases unchanged. For the split specifically, verify the public ScratchTree return shape, fixture contents and cleanup behavior through the existing synthetic-patch tests (379,388).

No tests or red mutations were run while drafting this plan; these are executor obligations.

## Verification

Instantiate `002_layer_map.md` Per-layer gate in the dedicated layer worktree, not this docs worktree:

```sh
bun run typecheck
bun test tests/lab/lab-fabric-task.test.ts tests/lab/lab-fabric-outcome-validation.test.ts tests/lab/lab-fabric-persistence-boundary.test.ts
bun test tests/lab
bun run privacy:scan
bun test tests/lab/core-lab-boundary.test.ts
wc -l src/lab/fabric/scratch-access.ts src/lab/fabric/scratch-fixture.ts src/lab/fabric/scratch.ts
rg -n 'lab/fabric/scratch|from "./scratch"' src gui/src scripts tests
git diff --check
git diff --numstat origin/dev...HEAD
# Full repository suite: remote only, exact branch tip; pipefail preserves failures.
ssh lidge 'bash -o pipefail -c "cd ~/ocx-ci/opencodex && git fetch origin codex/split-lab-fabric-scratch && git checkout -q FETCH_HEAD && git rev-parse HEAD && bun install --frozen-lockfile && bun run test 2>&1 | tail -15"'
```

Required outcome: all local gates exit 0; focused/domain tests have zero failures; every leaf and residual ≤400. The boundary test is included explicitly even though no protected source is edited. Confirm the remote printed SHA equals the layer tip and save the full exit status plus test totals; the tail alone is not proof. Full suite remains remote-only.

Compare resolved direct consumer bindings against the 5-file baseline above (raw basename grep is only a candidate search and can include unrelated modules). Leaf names matching the search are not new original-path consumers. Existing public callers must not need migration.  Use the already available parser/import-graph mechanism, or a read-only resolver, to report no cycles containing this residual or any new leaf, including type edges; do not install a new analyzer just for this split. Verify moved declaration bodies are identical to origin/dev after stripping only the newly required export modifiers, and inspect `git diff --color-moved` for accidental behavior edits.

For PR readiness, record exact-head CI (Linux, macOS, Windows) and review status separately from local checks. No tests, typecheck, privacy scan or remote suite have been executed in this docs-only delegation.

## Accept criteria

1. Exactly this layer's original source plus the listed 2 new leaves and necessary existing-test adjustments are changed at implementation time; no other S15 file is implemented in this PR.
2. The complete inventory above has exactly one implementation/type owner per declaration; all original public names resolve from `src/lab/fabric/scratch.ts`, with no newly public private helper.
3. Every moved body, constant initializer, comment-backed order and signature matches the pinned source; only import/export plumbing changes.
4. Leaf line counts are 249 for `src/lab/fabric/scratch-access.ts`, 63 for `src/lab/fabric/scratch-fixture.ts` (or verified formatted equivalents ≤400); residual is approximately 128, always ≤400. No deferred >400 residual.
5. State owners and operation lifetimes match the state section; resolved import graph has no cycle involving the partition.
6. Direct test imports and all source-oracle dispositions are applied exactly as listed; named guards have recorded red→restored-green evidence, without weakening assertions or editing protected roots.
7. Every instantiated local gate and exact-tip remote suite succeeds; source/consumer inventory and privacy scan are recorded. No repository-wide local suite.
8. The parent has explicitly resolved the raw-diff size exception/topology escalation before source implementation.
9. PR base is `codex/split-lab-fabric-observe`, stack map contains all five layers, and exact-head CI is green. No merge is performed.

## PR

Title: `refactor(lab-fabric): separate scratch access from fixture lifetime (split S15 L5/5)`

Branch: `codex/split-lab-fabric-scratch`. Base: `dev`. Closes: **none**.

Use every section of `.github/PULL_REQUEST_TEMPLATE.md` (Summary, Verification, Checklist). Include this full DEV-STACK-03 map; placeholder PR numbers are intentional until the parent creates the PRs. Review only this layer's diff against its base; L5 is the current layer.

| Layer | PR | Branch | Base | Review focus |
|---|---|---|---|---|
| L1/5 | #TBD-S15-L1 | codex/split-lab-events-validate | dev | separate field subject and claim validators |
| L2/5 | #TBD-S15-L2 | codex/split-lab-ledger-store | codex/split-lab-events-validate | isolate ledger lock ownership |
| L3/5 | #TBD-S15-L3 | codex/split-lab-artifacts-sanitize | dev | separate lexical redaction and UTF-8 truncation |
| L4/5 | #TBD-S15-L4 | codex/split-lab-fabric-observe | codex/split-lab-artifacts-sanitize | isolate producer outcome validation |
| L5/5 | #TBD-S15-L5 | codex/split-lab-fabric-scratch | dev | separate scratch access from fixture lifetime |

Base: dev — no dependency on the layers below; no cascade obligation.

No merge authorization is conveyed by the plan. The current delegated task performs no Git mutation or PR action.
