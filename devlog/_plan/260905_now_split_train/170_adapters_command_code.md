# 170 — S05 L2: Command Code messages and workspace

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: **pure-move**; C3 structural planning, scoped docs-only delegation. Read 000/001/002 S05 and lane 014's Command Code audit. No code, test runs, git mutations, or parent-owned orchestration/loop/goal operations in this task.
- Goal: retain the adapter factory and transport in `src/adapters/command-code.ts`, reducing 637 lines to an expected **395**, with independently owned wire-message and workspace leaves.
- Non-goals: changing proprietary wire semantics, canonical model IDs, effort refresh/retry, cache TTL/capacity, filesystem/git collection behavior, credentials, diagnostics, or public API.
- Context/map: `src/adapters/registry.ts:5` and four test files import the module. Existing dependencies at lines 1–15 cover crypto, git/fs, types, budget, bounded body, debug, reasoning catalog, identity, tool nudge and image parsing. Intended graph: registry → original adapter boundary → messages and workspace leaves; the workspace leaf alone → existing git/fs imports; messages → existing image/types modules. Blast radius: adapter-local.
- Chosen structural move: extract the two existing helper clusters unchanged, retain request/stream/fetch closures. Do nothing leaves 637 >400; deleting/configuring cannot remove responsibilities; reusing another provider compiler would alter wire pairing. Reject moving only workspace metadata: 637 −116 + shims remains >500. The two cohesive leaves fit the residual cap without touching transport or inventing a shared framework.
- Verifier: 002 **Per-layer gate**, instantiated below, with cache identity/eviction and wire pairing checks.
- Stop: executor records exact-head green L2 PR, never merges; drafting delegate stops after this assigned document is statically complete.
- Escalation: actual changed source lines >500, new cycles, new source oracle, non-move edits, or a leaf/residual >400. The source diff is near the ceiling; do not spend that margin on reformatting. More layers or a size exception belong to the parent.

## Symbol inventory

Inclusive definition ranges were extracted with an in-memory Babel TypeScript AST from `git show origin/dev:src/adapters/command-code.ts`. Basis: `origin/dev` = `1362b1a3841b4de20177e5d65865a513dd7936c4`; docs HEAD `4cc219549`. Imports are documented separately below. Consumer counts are distinct files importing this exact symbol through the original path: `rg -l 'command-code' src gui/src scripts tests -g '*.ts' -g '*.tsx'`, followed by relative-path/import-name filtering. Generic text matches (for example `usage`) and unrelated same-basename modules are excluded. Private definitions have zero external import consumers. 34 definitions; 5 static importer files.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `COMMAND_CODE_MODEL_ALIASES` | const | 19–24 | no | 0 | `src/adapters/command-code.ts (residual)` |
| `canonicalCommandCodeModelId` | function | 26–28 | no | 0 | `src/adapters/command-code.ts (residual)` |
| `toolResultText` | function | 31–34 | no | 0 | `src/adapters/command-code-messages.ts` |
| `mediaTypeFromUrl` | function | 37–44 | no | 0 | `src/adapters/command-code-messages.ts` |
| `wireImagePart` | function | 47–51 | no | 0 | `src/adapters/command-code-messages.ts` |
| `wireMessages` | function | 67–154 | no | 0 | `src/adapters/command-code-messages.ts` |
| `visibleTools` | function | 156–168 | no | 0 | `src/adapters/command-code.ts (residual)` |
| `toolChoiceInstruction` | function | 170–182 | no | 0 | `src/adapters/command-code.ts (residual)` |
| `wireTools` | function | 184–190 | no | 0 | `src/adapters/command-code.ts (residual)` |
| `currentWorkingDirectory` | function | 192–194 | no | 0 | `src/adapters/command-code.ts (residual)` |
| `MAX_WORKSPACE_STRUCTURE_ENTRIES` | const | 197–197 | no | 0 | `src/adapters/command-code-workspace.ts` |
| `MAX_RECENT_COMMITS` | const | 199–199 | no | 0 | `src/adapters/command-code-workspace.ts` |
| `MAX_RECENT_COMMIT_LENGTH` | const | 201–201 | no | 0 | `src/adapters/command-code-workspace.ts` |
| `MAX_GIT_STATUS_LENGTH` | const | 203–203 | no | 0 | `src/adapters/command-code-workspace.ts` |
| `WORKSPACE_METADATA_TTL_MS` | const | 205–205 | no | 0 | `src/adapters/command-code-workspace.ts` |
| `MAX_WORKSPACE_METADATA_ENTRIES` | const | 207–207 | yes | 1 | `src/adapters/command-code-workspace.ts` |
| `projectSlug` | function | 210–212 | no | 0 | `src/adapters/command-code-workspace.ts` |
| `GitWorkspaceInfo` | interface | 214–220 | no | 0 | `src/adapters/command-code-workspace.ts` |
| `workspaceMetadataCache` | const | 222–222 | yes | 1 | `src/adapters/command-code-workspace.ts` |
| `pruneWorkspaceMetadataCache` | function | 228–247 | yes | 1 | `src/adapters/command-code-workspace.ts` |
| `execFile` | const | 249–249 | no | 0 | `src/adapters/command-code-workspace.ts` |
| `gitWorkspaceInfo` | function | 252–283 | no | 0 | `src/adapters/command-code-workspace.ts` |
| `commandCodeConfig` | function | 285–311 | no | 0 | `src/adapters/command-code-workspace.ts` |
| `usage` | function | 313–327 | no | 0 | `src/adapters/command-code.ts (residual)` |
| `eventError` | function | 329–336 | no | 0 | `src/adapters/command-code.ts (residual)` |
| `isMissingToolResultError` | function | 345–348 | no | 0 | `src/adapters/command-code.ts (residual)` |
| `ndjson` | function | 350–387 | no | 0 | `src/adapters/command-code.ts (residual)` |
| `decodeEventLine` | function | 409–422 | no | 0 | `src/adapters/command-code.ts (residual)` |
| `stripEventFrame` | function | 425–427 | no | 0 | `src/adapters/command-code.ts (residual)` |
| `isReasoningEffortRejection` | function | 429–431 | no | 0 | `src/adapters/command-code.ts (residual)` |
| `requestWithoutReasoningEffort` | function | 433–442 | no | 0 | `src/adapters/command-code.ts (residual)` |
| `fetchCommandCode` | function | 444–459 | no | 0 | `src/adapters/command-code.ts (residual)` |
| `supportedCommandCodeEffort` | function | 461–484 | no | 0 | `src/adapters/command-code.ts (residual)` |
| `createCommandCodeAdapter` | function | 486–637 | yes | 4 | `src/adapters/command-code.ts (residual)` |

## Leaf partition

Use the existing provider-prefixed sibling convention (`src/adapters/ollama-native-url.ts:9`, `src/adapters/kiro-thinking.ts:1`), not a convenience index. All extraction exports serve the production factory; current public cache exports keep their original path.

| New file | Symbols | Moved slice (comments included) | Expected lines |
|---|---|---|---:|
| `src/adapters/command-code-messages.ts` | `toolResultText`, `mediaTypeFromUrl`, `wireImagePart`, `wireMessages` | 30–154 (125 lines) | 129 |
| `src/adapters/command-code-workspace.ts` | `MAX_WORKSPACE_STRUCTURE_ENTRIES`, `MAX_RECENT_COMMITS`, `MAX_RECENT_COMMIT_LENGTH`, `MAX_GIT_STATUS_LENGTH`, `WORKSPACE_METADATA_TTL_MS`, `MAX_WORKSPACE_METADATA_ENTRIES`, `projectSlug`, `GitWorkspaceInfo`, `workspaceMetadataCache`, `pruneWorkspaceMetadataCache`, `execFile`, `gitWorkspaceInfo`, `commandCodeConfig` | 196–311 (116 lines) | 120 |

Messages leaf own imports (three lines + separator):
```ts
import type { OcxContentPart, OcxMessage } from "../types";
import { namespacedToolName } from "../types";
import { parseDataUrl } from "./image";
```
Export only `wireMessages`; preserve its nested `closePendingCalls` and the tool-result/image-carrier ordering as a single body (67–154).

Workspace leaf own imports (three lines + separator):
```ts
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { opendir } from "node:fs/promises";
```
Keep the three existing cache exports; also export `projectSlug` and `commandCodeConfig` for the residual factory. `GitWorkspaceInfo` and all other helpers/constants stay private.

Residual keeps model aliasing, `visibleTools`, `toolChoiceInstruction`, `wireTools`, `currentWorkingDirectory`, all event/framing/fetch/reasoning helpers, and `createCommandCodeAdapter`. Remove original imports at 2, 3, 4 and 15; trim `OcxContentPart`/`OcxMessage` from the type import at 5. Keep the other dependencies unchanged.

Line ledger using the displayed single-line imports: 637 −125 −116 −4 old import lines +3 boundary lines = **395**. New leaves 129 +120; total 644 =637 +7 net import/separator lines. No #b is required. Planned changed-source estimate: 246 deletions +253 additions =499, including the retained type-import edit; verify actual numstat before declaring ready. Additional formatting can cross the ceiling. Tests/documentation do not justify hiding the actual total review diff.

There are no #a/#b parts in approved S05. Within this layer, the messages leaf has zero external consumers; the workspace cache API has one test consumer, so move messages first, then workspace, while publishing one independently verified layer. Do not expose intermediate >400 state as completed debt.

## Re-export block

The residual adds exactly:
```ts
export { MAX_WORKSPACE_METADATA_ENTRIES, workspaceMetadataCache, pruneWorkspaceMetadataCache } from "./command-code-workspace";
import { projectSlug, commandCodeConfig } from "./command-code-workspace";
import { wireMessages } from "./command-code-messages";
```
`createCommandCodeAdapter` remains inline exported at the original boundary (old 486–637). No type was previously exported. Re-exporting cache names creates no local binding; the residual does not use those three names. It needs the explicit local imports above at old call sites 503, 507 and 528. Do not import the cache back into the residual to recreate or wrap it.

## Module-level state and cycles

- `workspaceMetadataCache` (222): sole allocation moves to workspace. `pruneWorkspaceMetadataCache` (228–247), TTL (205), cap (207), cache lookup/insert in `gitWorkspaceInfo` (255–281) all move together. Existing tests' `clear/set/delete` operations continue to hit that same object through the re-export.
- `execFile` (249) remains initialized once by `promisify` in workspace, not per request. Workspace policy constants (197–207) stay with that owner.
- `COMMAND_CODE_MODEL_ALIASES` (19–24) remains residual, immutable by type. No top-level let, WeakMap, lock or timer. The timeout controller/timer at 445–457 are fetch-local and untouched.
- Message arrays and pending carriers (68–74) remain invocation-local. Cache lifetime stays process/module-scoped; no duplicate instance or initialization/reset hook is added.
- Lane G1 reported no cycle. Leaves import existing downstream types/image/node APIs and never import `command-code.ts`, adapter registry or one another. Moving just `commandCodeConfig` while reading the cache from the residual would form a back-edge; the full workspace cluster avoids it.
- Coupling: workspace's existing externally exposed cache is a common-state contract preserved, not widened; only one owner mutates it in production. Message/factory edge is functional. No new validation boundary or defensive checks.

## Tests

Direct-import list from `rg -l 'adapters/command-code"' tests -g '*.ts'` (all unchanged):
- `tests/adapters/buffered-response-shape-guards.test.ts:3` — unchanged; keep its original-path import.
- `tests/providers/command-code-error-finish.test.ts:2` — unchanged; keep its original-path import.
- `tests/providers/command-code-provider.test.ts:2` — unchanged; keep its original-path import.
- `tests/providers/command-code-workspace-cache.test.ts:2` — unchanged; keep its original-path import.

Additional indirect gates remain unchanged:
- `tests/adapters/adapter-registry-authority.test.ts`
- `tests/adapters/adapter-tool-conformance.test.ts`
- `tests/adapters/adapter-buffered-tool-conformance.test.ts`

Filename-specific source-text readers: **none**. The O1 search is `rg -l 'readFileSync|Bun\\.file|readFile\\(' tests -g '*.test.ts' | xargs rg -l 'adapters/command-code|command-code.ts'`, followed by source inspection, not counting OAuth/config fixture reads as adapter source readers. Generic `tests/lab/core-lab-boundary.test.ts:69` reads transitive source; unchanged, automatically visits both static leaves. No retarget-to-leaf and no add-leaf-to-scan-list; PROTECTED at line 20 stays untouched.

During C, drive the existing eviction guard red once by temporarily disconnecting pruning from the workspace-owned Map, using `tests/providers/command-code-workspace-cache.test.ts:19` (prune call 27), then restore. Also verify original/leaf `workspaceMetadataCache` strict identity in an in-memory import check; this requires no new committed test or API. Drive the Lab guard red with a temporary leaf→Lab edge and restore. Preserve the framing tests at `tests/adapters/buffered-response-shape-guards.test.ts:172`; their NDJSON code stays in the residual, so no oracle migration.

## Verification

Implementation-only commands: none were run for this docs-only delegation. This instantiates `002_layer_map.md` → **Per-layer gate** (the `003` reference in 000 is stale).

```sh
bun run typecheck
bun test tests/providers/command-code-workspace-cache.test.ts tests/providers/command-code-provider.test.ts tests/providers/command-code-error-finish.test.ts tests/adapters/buffered-response-shape-guards.test.ts tests/adapters/adapter-registry-authority.test.ts tests/adapters/adapter-tool-conformance.test.ts tests/adapters/adapter-buffered-tool-conformance.test.ts
bun run privacy:scan
bun test tests/lab/core-lab-boundary.test.ts
wc -l src/adapters/command-code-workspace.ts src/adapters/command-code-messages.ts src/adapters/command-code.ts
rg -l 'from "[^"]*/command-code"' src gui/src scripts tests
git diff --check
git diff --numstat origin/dev...HEAD -- src tests
```

Focused domains: `tests/providers` Command Code files and `tests/adapters` framing/registry/tool conformance. The original-path static importer list must retain 5 unique files after exact relative-path filtering (the raw basename rg can include unrelated modules). Keep exports/types resolvable; count alone is not proof. No protected-root edits are needed; the Lab guard is included because adapters are transitively reachable. Each listed leaf and residual must be ≤400 physical lines. Compare normalized AST bodies before/after, allowing only location, import/export modifiers and required import binding changes; preserve comments and exact error/wire literals.

Run the resolved-relative-import/re-export graph walk from lane 014's G1, including type edges, at the layer tip; no return path from any new leaf to its old boundary or another leaf may appear. The Lab guard checks optional-subsystem reachability, not general cycles.

Full suite is **never local**; executor uses the existing authorized remote checkout only after verifying its ownership, with pipeline failure propagation:
```sh
ssh lidge 'bash -o pipefail -c "cd ~/ocx-ci/opencodex && git fetch origin codex/split-adapters-command-code && git checkout -q FETCH_HEAD && git rev-parse HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15"'
```
Record remote HEAD equal to PR head, full-suite exit status and totals, local focused/typecheck/privacy results, and the complete exact-head CI rollup. A tail without the test exit status is not evidence. Re-run only invalidated checks after a lower-layer cascade; no merge/auto-merge.


## Accept criteria

1. All 34 definitions have one inventory owner; extracted bodies are unchanged; retained NDJSON/fetch/reasoning/factory logic is untouched.
2. Original four exports remain available; the original and leaf cache bindings are strictly identical and TTL/cap/eviction ordering match.
3. Exactly five direct importer files remain at the old path; no caller migrations, new registry or wildcard exports.
4. Two leaves ≤400 (129 and 120 expected), residual ≤400 (395 expected); no #b; measured changed source lines ≤500 or parent approval is required before execution continues.
5. No type/runtime cycle, no new Lab path, no new module-level cache/timer; request framing/abort/error behavior remains unchanged.
6. Listed behavioral tests and red→green probes pass at L2; typecheck/privacy and remote full suite plus complete CI rollup prove that exact head.
7. L2 base is L1; any lower-layer edit cascades and invalidates affected evidence. Review this layer only; do not merge.

## PR

Title: `refactor(adapters): isolate Command Code messages and workspace (split S05 L2/3)`

Branch: `codex/split-adapters-command-code`.

Base: dev — no dependency on the layers below; no cascade obligation.

Closes: none.

| # | PR | Layer | Branch | Base | Review focus |
|---|---|---|---|---|---|
| 1 | #TBD-S05-L1 | xAI tool schema | `codex/split-adapters-xai-tool-schema` | `dev` | Schema-analysis extraction |
| 2 | #TBD-S05-L2 | Command Code | `codex/split-adapters-command-code` | `dev` | Wire messages and single-owner workspace cache |
| 3 | #TBD-S05-L3 | Ollama native | `codex/split-adapters-ollama-native` | `dev` | Request compilation and response translation |

L2 is this PR; review only its diff. Fill Summary, Verification and Checklist from the repository PR template and include the stack map. Parent owns git/PR operations; this document grants no merge permission.
