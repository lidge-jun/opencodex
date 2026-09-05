# S04 L1/5 — tool-definitions

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Existing split implementation history; aggregate delivery pending. Original PR is not individually merged.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

Docs basis: `4cc219549`; source basis: `origin/dev = 1362b1a3841b4de20177e5d65865a513dd7936c4`. Every source line range below refers to `src/adapters/cursor/tool-definitions.ts` at that source commit, not a future leaf. Read alongside 000_plan.md, 001_stale_check.md, 002_layer_map.md, and ../260905_modular_debt_ledger/014_lane_adapters_media.md (lane 014; relevant file subsection). Status: diff-level plan only; no code, Git mutation, test run, or orchestration performed by this delegate.

## Loop spec

- Archetype: **pure-move**. Work class C3 structural planning, docs-only delegated mode; the parent owns all loop/goal state.
- Goal: move the inventoried responsibilities into the named sibling leaves, each ≤400 lines, preserving the original public import path and leaving 113 expected lines in the original.
- Non-goals: no exported rename/removal, no behavior or signature change, no dependency/tooling installation, no new validation, no changes to generated protobufs, native-exec ownership, live transport scheduling, registry policy, or unrelated files. No production-module execution or test run in this drafting task.
- Verifier: 002_layer_map.md **Per-layer gate**, instantiated in Verification below. Planned commands are for the layer executor; they are not results from this draft.
- Stop: parent records an independently verified, exact-tip layer with all accepts met and exact-head CI rollup; no merge. Stop implementation immediately on a changed signature, string/wire delta, duplicated state, cycle, unaccounted source-reader, or unsupported layer-size claim.
- Escalation: the explicit type-only-cycle prerequisite in Module-level state and cycles blocks implementation at this basis; source drift, required files outside this partition/test list, an actual behavior defect, or the sizing conflict below goes to the parent; do not repair it opportunistically. Unreleased security findings go only to approved scratch, never this public devlog.

Implementation sizing escalation: this exact partition transfers 667 existing physical lines before import/export glue, already over 002's 500 changed-source-line bound even if moves are counted only once. Under additions + deletions it is at least 1334 lines. The fixed S04 five-layer map has no #b slot. Do not silently call this PR ≤500: the parent must either approve a documented move-only size exception or revise the layer topology (and obtain approval for extra layer docs) before implementation. This bounded draft does not alter 002 or invent a sixth branch.

Structural decision and pre-change map: Wire identity/choice policy (118–268, 326–396, 608–619), schemas (44–116, 399–444, 541–606), and model guidance (446–536, 621–736) have separate inputs. Keep structured-tool advertisement and protobuf serialization in the original boundary. Rejected: moving guidance alone leaves 661 lines; deleting descriptions or rewriting tool policy changes behavior. Chosen: three sibling leaves, matching native-exec-fs.ts / native-exec-network.ts / native-exec-tools.ts. Existing boundary consumers include protobuf-request.ts:63, native-exec-mcp.ts:28, and live-transport.ts:79. Current edges are consumer → tool-definitions → ../../types, gen/agent_pb, ../exec-tool-result-normalize (lines 1–6); new edges are boundary → naming/schema/guidance, schema → naming, guidance → naming. Feature-local blast radius; no package API or registration changes.

No-code alternatives: doing nothing leaves the requested size debt; deletion/configuration cannot preserve these existing behaviors while shortening their implementation; reuse means moving the current declarations, not inventing equivalent helpers. Owner search: `rg --files src/adapters/cursor`, `rg -n '<symbol>' src gui/src scripts tests`, and the lane-014 seam audit. The named new siblings do not already exist. Existing stable imports are compatibility boundaries, not permission for new convenience barrels.

## Symbol inventory

AST evidence: `git show origin/dev:src/adapters/cursor/tool-definitions.ts`; working-tree bytes compared equal; `ast-grep run --lang typescript --kind <kind> --json=compact src/adapters/cursor/tool-definitions.ts` for lexical/variable/function/interface/type-alias/class declarations, filtered to top-level source starts. Ranges are inclusive, include an `export` modifier on the same line, and exclude preceding comments. 76 owned top-level declarations; imports are dependencies, not redeclared owned symbols.

Consumer counting: `rg -l 'tool-definitions' src gui/src scripts tests` narrows candidates; resolve static `from` and dynamic `import()` relative specifiers to this exact file; then `rg -l -w '<symbol>' <resolved-consumer-files>` counts distinct referencing consumer files. Count excludes the defining file. Private declarations have 0 external bound consumers; their local references move with the partition. This is a file count, not call-site count; do not reuse 001's broad basename heuristic as symbol fan-in.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `OCX_RESPONSES_TOOL_PROVIDER` | const | 8–8 | yes | 5 | `tool-naming.ts` |
| `CODEX_EXEC_COMMAND_TOOL` | const | 9–9 | yes | 0 | `tool-naming.ts` |
| `CODEX_SHELL_COMMAND_TOOL` | const | 10–10 | yes | 0 | `tool-naming.ts` |
| `CODEX_UNIFIED_EXEC_TOOL` | const | 12–12 | yes | 0 | `tool-naming.ts` |
| `CODEX_WAIT_TOOL` | const | 13–13 | yes | 0 | `tool-naming.ts` |
| `CODEX_APPLY_PATCH_TOOL` | const | 14–14 | yes | 1 | `tool-naming.ts` |
| `CODEX_TOOL_SEARCH_TOOL` | const | 15–15 | yes | 0 | `tool-naming.ts` |
| `CURSOR_EDIT_FILE_TOOL` | const | 16–16 | yes | 1 | `tool-naming.ts` |
| `CURSOR_MULTI_EDIT_TOOL` | const | 17–17 | yes | 2 | `tool-naming.ts` |
| `CURSOR_STRUCTURED_EDIT_TOOLS` | const | 18–18 | yes | 0 | `tool-naming.ts` |
| `CURSOR_EXEC_COMMAND_TOOL` | const | 19–19 | yes | 0 | `tool-naming.ts` |
| `CODEX_SHELL_BRIDGE_TOOL_NAMES` | const | 20–20 | yes | 0 | `tool-naming.ts` |
| `CURSOR_SHELL_ALIAS_SYSTEM_NOTE` | const | 21–22 | yes | 1 | `tool-guidance.ts` |
| `NEIGHBOR_AGENT_TOOL_NAMES` | const | 23–23 | no | 0 | `tool-guidance.ts` |
| `NEIGHBOR_AGENT_TOOL_ALIASES` | const | 24–30 | no | 0 | `tool-guidance.ts` |
| `CURSOR_GENERIC_TOOL_USE_USER_HINT` | const | 32–42 | yes | 0 | `tool-guidance.ts` |
| `CURSOR_EXEC_COMMAND_INPUT_SCHEMA` | const | 44–56 | yes | 1 | `tool-schemas.ts` |
| `CURSOR_EDIT_FILE_INPUT_SCHEMA` | const | 65–74 | yes | 1 | `tool-schemas.ts` |
| `CURSOR_MULTI_EDIT_INPUT_SCHEMA` | const | 77–97 | yes | 1 | `tool-schemas.ts` |
| `CODEX_SHELL_BRIDGE_ARG_NORMALIZE_SCHEMA` | const | 104–116 | yes | 0 | `tool-schemas.ts` |
| `isCodexShellBridgeToolName` | function | 118–120 | yes | 1 | `tool-naming.ts` |
| `resolveShellBridgeAliasKey` | function | 126–139 | yes | 1 | `tool-naming.ts` |
| `cursorToolChoiceAliases` | function | 141–147 | yes | 1 | `tool-naming.ts` |
| `catalogHasBareCodexShellBridge` | function | 149–153 | no | 0 | `tool-naming.ts` |
| `cursorToolChoiceMatches` | function | 162–177 | no | 0 | `tool-naming.ts` |
| `isBareCodexShellBridgeTool` | function | 179–181 | yes | 1 | `tool-naming.ts` |
| `isCursorResponsesProvider` | function | 183–185 | no | 0 | `tool-naming.ts` |
| `CURSOR_EXECUTION_PATH_TOOL_NAMES` | const | 187–191 | no | 0 | `tool-naming.ts` |
| `isCursorExecutionPathTool` | function | 194–197 | yes | 1 | `tool-naming.ts` |
| `isCursorWaitTool` | function | 200–202 | yes | 1 | `tool-naming.ts` |
| `isCursorCodeModeExecTool` | function | 208–214 | yes | 1 | `tool-naming.ts` |
| `cursorRequestUsesCodeMode` | function | 227–234 | yes | 3 | `tool-naming.ts` |
| `isBareCodexExecCommandTool` | function | 237–239 | no | 0 | `tool-naming.ts` |
| `cursorRequestHasShellAlias` | function | 241–243 | yes | 3 | `tool-naming.ts` |
| `cursorRequestHasExecutionPath` | function | 245–249 | no | 0 | `tool-naming.ts` |
| `cursorRequestAdvertisesApplyPatch` | function | 251–257 | yes | 2 | `tool-naming.ts` |
| `isCursorStructuredEditToolName` | function | 259–261 | yes | 2 | `tool-naming.ts` |
| `isCursorSyntheticStructuredEditTool` | function | 264–268 | yes | 2 | `tool-naming.ts` |
| `cursorStructuredEditTools` | function | 284–312 | yes | 3 | `tool-definitions.ts` (residual) |
| `cursorRequestAdvertisesStructuredEdits` | function | 319–324 | yes | 0 | `tool-definitions.ts` (residual) |
| `CURSOR_CLIENT_TOOL_WIRE_PREFIX` | const | 326–326 | no | 0 | `tool-naming.ts` |
| `CURSOR_PROXY_OWNED_BARE_TOOL_NAMES` | const | 327–336 | no | 0 | `tool-naming.ts` |
| `isCursorBareClientToolWireAliased` | function | 339–344 | no | 0 | `tool-naming.ts` |
| `cursorToolWireName` | function | 346–351 | yes | 4 | `tool-naming.ts` |
| `clientSemanticToolNameFromCursorWire` | function | 353–357 | no | 0 | `tool-naming.ts` |
| `CURSOR_MCP_DISPLAY_PREFIX` | const | 366–366 | no | 0 | `tool-naming.ts` |
| `normalizeCursorWireName` | function | 368–370 | yes | 1 | `tool-naming.ts` |
| `CURSOR_TEXT_TOOL_MARKER` | const | 382–385 | no | 0 | `tool-naming.ts` |
| `normalizeCursorTextToolMarkers` | function | 387–390 | yes | 1 | `tool-naming.ts` |
| `responsesToolNameFromCursorWire` | function | 392–396 | yes | 1 | `tool-naming.ts` |
| `cursorToolInputSchema` | function | 399–401 | yes | 1 | `tool-schemas.ts` |
| `cursorToolArgNormalizeSchema` | function | 408–413 | yes | 2 | `tool-schemas.ts` |
| `shellBridgeArgNormalizeSchema` | function | 415–444 | no | 0 | `tool-schemas.ts` |
| `isGenericToolUseCountDemoPrompt` | function | 446–461 | yes | 2 | `tool-guidance.ts` |
| `requestedCursorToolUseCount` | function | 463–478 | yes | 1 | `tool-guidance.ts` |
| `cursorGenericToolUseHint` | function | 480–489 | no | 0 | `tool-guidance.ts` |
| `activeTextMentionsGenericToolUseHint` | function | 491–495 | no | 0 | `tool-guidance.ts` |
| `shouldAppendCursorGenericToolUseHint` | function | 497–506 | yes | 0 | `tool-guidance.ts` |
| `appendCursorGenericToolUseHint` | function | 508–514 | yes | 2 | `tool-guidance.ts` |
| `shouldUseNativeExecOnlyForGenericToolUse` | function | 516–524 | yes | 0 | `tool-guidance.ts` |
| `cursorToolsForActivePrompt` | function | 526–536 | yes | 5 | `tool-guidance.ts` |
| `shellBridgeRequiredCommandKeys` | function | 541–553 | yes | 0 | `tool-schemas.ts` |
| `defaultShellBridgeArgNormalizeSchema` | function | 556–564 | yes | 1 | `tool-schemas.ts` |
| `cursorShellBridgeDropError` | function | 566–568 | yes | 1 | `tool-schemas.ts` |
| `nonEmptyShellBridgeCommandFromArgs` | function | 574–597 | yes | 1 | `tool-schemas.ts` |
| `cursorShellBridgeArgsValid` | function | 599–606 | yes | 1 | `tool-schemas.ts` |
| `cursorToolAllowedByChoice` | function | 608–619 | yes | 1 | `tool-naming.ts` |
| `quotedNames` | function | 621–623 | no | 0 | `tool-guidance.ts` |
| `advertisedCoversNeighbor` | function | 625–629 | no | 0 | `tool-guidance.ts` |
| `unavailableNeighborAgentToolNames` | function | 631–633 | no | 0 | `tool-guidance.ts` |
| `discoveryToolLabel` | function | 635–641 | no | 0 | `tool-guidance.ts` |
| `buildCursorToolGuidanceSystemNote` | function | 643–736 | yes | 3 | `tool-guidance.ts` |
| `encodeCursorInputSchema` | function | 738–743 | yes | 1 | `tool-definitions.ts` (residual) |
| `buildCursorToolDefinitions` | function | 745–760 | yes | 4 | `tool-definitions.ts` (residual) |
| `cursorMcpToolsEncodedSize` | function | 763–769 | yes | 2 | `tool-definitions.ts` (residual) |
| `cursorMcpToolEncodedSize` | function | 772–777 | yes | 1 | `tool-definitions.ts` (residual) |

Resolved direct importers: 13 distinct files (8 production, 5 tests). Production paths:

- `src/adapters/cursor.ts` — unchanged.
- `src/adapters/cursor/live-transport.ts` — unchanged.
- `src/adapters/cursor/native-exec-mcp.ts` — unchanged.
- `src/adapters/cursor/native-exec-tools.ts` — unchanged.
- `src/adapters/cursor/native-exec.ts` — unchanged.
- `src/adapters/cursor/protobuf-events.ts` — unchanged.
- `src/adapters/cursor/protobuf-request.ts` — unchanged.
- `src/adapters/cursor/request-builder.ts` — unchanged.

## Leaf partition

All paths below are new sibling files under `src/adapters/cursor/`, following the existing kebab-case native-exec-* and protobuf-* convention. Each symbol body and attached comment moves without rewriting. Physical slice accounting includes blank lines/comments; keep slice contents in their original relative order. Expected sizes use the exact compact import/re-export lines shown; multiline formatting consumes spare budget and must be recounted, especially catalog.ts.

### `src/adapters/cursor/tool-naming.ts`

- Transfer source slices: 8–20, 118–268, 326–396, 608–619 (247 physical lines).
- Symbols: `OCX_RESPONSES_TOOL_PROVIDER`, `CODEX_EXEC_COMMAND_TOOL`, `CODEX_SHELL_COMMAND_TOOL`, `CODEX_UNIFIED_EXEC_TOOL`, `CODEX_WAIT_TOOL`, `CODEX_APPLY_PATCH_TOOL`, `CODEX_TOOL_SEARCH_TOOL`, `CURSOR_EDIT_FILE_TOOL`, `CURSOR_MULTI_EDIT_TOOL`, `CURSOR_STRUCTURED_EDIT_TOOLS`, `CURSOR_EXEC_COMMAND_TOOL`, `CODEX_SHELL_BRIDGE_TOOL_NAMES`, `isCodexShellBridgeToolName`, `resolveShellBridgeAliasKey`, `cursorToolChoiceAliases`, `catalogHasBareCodexShellBridge`, `cursorToolChoiceMatches`, `isBareCodexShellBridgeTool`, `isCursorResponsesProvider`, `CURSOR_EXECUTION_PATH_TOOL_NAMES`, `isCursorExecutionPathTool`, `isCursorWaitTool`, `isCursorCodeModeExecTool`, `cursorRequestUsesCodeMode`, `isBareCodexExecCommandTool`, `cursorRequestHasShellAlias`, `cursorRequestHasExecutionPath`, `cursorRequestAdvertisesApplyPatch`, `isCursorStructuredEditToolName`, `isCursorSyntheticStructuredEditTool`, `CURSOR_CLIENT_TOOL_WIRE_PREFIX`, `CURSOR_PROXY_OWNED_BARE_TOOL_NAMES`, `isCursorBareClientToolWireAliased`, `cursorToolWireName`, `clientSemanticToolNameFromCursorWire`, `CURSOR_MCP_DISPLAY_PREFIX`, `normalizeCursorWireName`, `CURSOR_TEXT_TOOL_MARKER`, `normalizeCursorTextToolMarkers`, `responsesToolNameFromCursorWire`, `cursorToolAllowedByChoice`.
- Expected line count: 247 moved + 1 import lines = **248**, ≤400.
- Own imports:

```ts
import { namespacedToolName, toolChoiceAliases, type OcxRequestOptions, type OcxTool } from "../../types";
```

### `src/adapters/cursor/tool-schemas.ts`

- Transfer source slices: 44–117, 398–444, 538–606 (190 physical lines).
- Symbols: `CURSOR_EXEC_COMMAND_INPUT_SCHEMA`, `CURSOR_EDIT_FILE_INPUT_SCHEMA`, `CURSOR_MULTI_EDIT_INPUT_SCHEMA`, `CODEX_SHELL_BRIDGE_ARG_NORMALIZE_SCHEMA`, `cursorToolInputSchema`, `cursorToolArgNormalizeSchema`, `shellBridgeArgNormalizeSchema`, `shellBridgeRequiredCommandKeys`, `defaultShellBridgeArgNormalizeSchema`, `cursorShellBridgeDropError`, `nonEmptyShellBridgeCommandFromArgs`, `cursorShellBridgeArgsValid`.
- Expected line count: 190 moved + 2 import lines = **192**, ≤400.
- Own imports:

```ts
import type { OcxTool } from "../../types";
import { CODEX_SHELL_COMMAND_TOOL, isBareCodexExecCommandTool, isBareCodexShellBridgeTool, isCodexShellBridgeToolName } from "./tool-naming";
```

### `src/adapters/cursor/tool-guidance.ts`

- Transfer source slices: 21–43, 446–536, 621–736 (230 physical lines).
- Symbols: `CURSOR_SHELL_ALIAS_SYSTEM_NOTE`, `NEIGHBOR_AGENT_TOOL_NAMES`, `NEIGHBOR_AGENT_TOOL_ALIASES`, `CURSOR_GENERIC_TOOL_USE_USER_HINT`, `isGenericToolUseCountDemoPrompt`, `requestedCursorToolUseCount`, `cursorGenericToolUseHint`, `activeTextMentionsGenericToolUseHint`, `shouldAppendCursorGenericToolUseHint`, `appendCursorGenericToolUseHint`, `shouldUseNativeExecOnlyForGenericToolUse`, `cursorToolsForActivePrompt`, `quotedNames`, `advertisedCoversNeighbor`, `unavailableNeighborAgentToolNames`, `discoveryToolLabel`, `buildCursorToolGuidanceSystemNote`.
- Expected line count: 230 moved + 3 import lines = **233**, ≤400.
- Own imports:

```ts
import type { OcxRequestOptions, OcxTool } from "../../types";
import { CODE_MODE_RESULT_ECHO_SENTENCE } from "../exec-tool-result-normalize";
import { CODEX_SHELL_BRIDGE_TOOL_NAMES, CODEX_TOOL_SEARCH_TOOL, CODEX_UNIFIED_EXEC_TOOL, clientSemanticToolNameFromCursorWire, cursorRequestAdvertisesApplyPatch, cursorRequestHasExecutionPath, cursorRequestHasShellAlias, cursorRequestUsesCodeMode, cursorToolAllowedByChoice, cursorToolWireName, isCodexShellBridgeToolName, isCursorExecutionPathTool, isCursorStructuredEditToolName } from "./tool-naming";
```

### Residual `src/adapters/cursor/tool-definitions.ts`

Retain: `cursorStructuredEditTools`, `cursorRequestAdvertisesStructuredEdits`, `encodeCursorInputSchema`, `buildCursorToolDefinitions`, `cursorMcpToolsEncodedSize`, `cursorMcpToolEncodedSize`.

Remove only original imports at lines 4 and 6 (their bindings now live in leaves); retain lines 1–3 and 5. Insert the two local imports and three re-export lines below.

Accounting: 777 − 667 moved − 2 net removed import lines + 2 local import lines + 3 re-export lines = **113** expected lines. All leaves plus residual total 786 = 777 original + 9 net import/export glue lines. No >400 residual and no #a/#b/#c part in this approved map. A size-policy escalation is not a hidden #b commitment; if the parent adds parts, re-plan lower-consumer leaves first and publish each intermediate residual count.

Add `export` to the existing private declarations `isBareCodexExecCommandTool` (237), `cursorRequestHasExecutionPath` (245), and `clientSemanticToolNameFromCursorWire` (353) inside tool-naming.ts so sibling production leaves can use them. Do not re-export these new internal seams from tool-definitions.ts. All other currently private declarations remain private.

## Re-export block

Insert into the original file exactly these named lines; current exported declarations that stay local remain exported in place (`cursorStructuredEditTools`, `cursorRequestAdvertisesStructuredEdits`, `encodeCursorInputSchema`, `buildCursorToolDefinitions`, `cursorMcpToolsEncodedSize`, `cursorMcpToolEncodedSize`). Do not use export-star and do not re-export newly exposed internal-only seams.

```ts
export { OCX_RESPONSES_TOOL_PROVIDER, CODEX_EXEC_COMMAND_TOOL, CODEX_SHELL_COMMAND_TOOL, CODEX_UNIFIED_EXEC_TOOL, CODEX_WAIT_TOOL, CODEX_APPLY_PATCH_TOOL, CODEX_TOOL_SEARCH_TOOL, CURSOR_EDIT_FILE_TOOL, CURSOR_MULTI_EDIT_TOOL, CURSOR_STRUCTURED_EDIT_TOOLS, CURSOR_EXEC_COMMAND_TOOL, CODEX_SHELL_BRIDGE_TOOL_NAMES, isCodexShellBridgeToolName, resolveShellBridgeAliasKey, cursorToolChoiceAliases, isBareCodexShellBridgeTool, isCursorExecutionPathTool, isCursorWaitTool, isCursorCodeModeExecTool, cursorRequestUsesCodeMode, cursorRequestHasShellAlias, cursorRequestAdvertisesApplyPatch, isCursorStructuredEditToolName, isCursorSyntheticStructuredEditTool, cursorToolWireName, normalizeCursorWireName, normalizeCursorTextToolMarkers, responsesToolNameFromCursorWire, cursorToolAllowedByChoice } from "./tool-naming";
export { CURSOR_EXEC_COMMAND_INPUT_SCHEMA, CURSOR_EDIT_FILE_INPUT_SCHEMA, CURSOR_MULTI_EDIT_INPUT_SCHEMA, CODEX_SHELL_BRIDGE_ARG_NORMALIZE_SCHEMA, cursorToolInputSchema, cursorToolArgNormalizeSchema, shellBridgeRequiredCommandKeys, defaultShellBridgeArgNormalizeSchema, cursorShellBridgeDropError, nonEmptyShellBridgeCommandFromArgs, cursorShellBridgeArgsValid } from "./tool-schemas";
export { CURSOR_SHELL_ALIAS_SYSTEM_NOTE, CURSOR_GENERIC_TOOL_USE_USER_HINT, isGenericToolUseCountDemoPrompt, requestedCursorToolUseCount, shouldAppendCursorGenericToolUseHint, appendCursorGenericToolUseHint, shouldUseNativeExecOnlyForGenericToolUse, cursorToolsForActivePrompt, buildCursorToolGuidanceSystemNote } from "./tool-guidance";
```

Re-export binds nothing locally. The original needs these explicit leaf imports in addition to its retained original imports:

```ts
import { CURSOR_EDIT_FILE_TOOL, CURSOR_MULTI_EDIT_TOOL, cursorRequestAdvertisesApplyPatch, cursorToolAllowedByChoice, cursorToolWireName, OCX_RESPONSES_TOOL_PROVIDER } from "./tool-naming";
import { CURSOR_EDIT_FILE_INPUT_SCHEMA, CURSOR_MULTI_EDIT_INPUT_SCHEMA, cursorToolInputSchema } from "./tool-schemas";
```

## Module-level state and cycles

`CURSOR_PROXY_OWNED_BARE_TOOL_NAMES` at 327–336 is the only top-level Set; tool-naming.ts owns the sole allocation. `CURSOR_TEXT_TOOL_MARKER` at 382–385 is a global RegExp with mutable lastIndex; keep one instance in tool-naming.ts with normalizeCursorTextToolMarkers (387–390), no cloned regex. All top-level constants are assigned exactly once in the inventory, including the execution-path array (187–191), schema objects (44–116), neighbor lookup object (24–30), and hint string (32–42). No top-level let, Map, WeakMap, timer, or lock. Function-local Sets remain inside their moved functions. Naming must not import schemas/guidance/original: cursorToolAllowedByChoice moves with cursorToolChoiceMatches and cursorToolWireName, preventing naming → original → naming. Schema imports the existing deprecated predicate rather than rewriting its call. Guidance takes only naming predicates and the existing echo sentence; it never imports the original. Sequential/functional coupling stays explicit; no shared cache service is introduced.

prerequisite landed as layer 105 (003 TYPE-CYCLE-01)

The leaf direction listed in Loop spec is the allowed DAG. Sibling leaves import their canonical owner directly, never this original facade. Preserve initialization order for cross-constant references. Verify both runtime and type-only edges; a typecheck alone does not prove acyclicity. Compare the resolved import graph at the parent and tip; zero new cycles and no path from any new leaf back to the original are required. Existing external-format/provenance checks remain at the same trust boundary; do not reinterpret validation while relocating it.

## Tests

Exact direct-test list from `rg -l 'adapters/cursor/tool-definitions' tests`, with specifier resolution to discard comments/other basenames:

- `tests/providers/cursor/cursor-request-builder.test.ts` — **unchanged** import path and assertions.
- `tests/providers/cursor/cursor-structured-edit.test.ts` — **unchanged** import path and assertions.
- `tests/providers/cursor/cursor-tool-choice.test.ts` — **unchanged** import path and assertions.
- `tests/providers/cursor/cursor-tool-definitions.test.ts` — **unchanged** import path and assertions.
- `tests/responses/responses-tool-conformance.test.ts` — **unchanged** import path and assertions.

No test reads tool-definitions.ts as source. The basename/full-path source-reader search returns no source-body guard for this file. Runtime importers below remain unchanged, including responses-tool-conformance.test.ts. No retarget-to-leaf or add-leaf-to-scan-list operation is needed.

Transitive source-reader exception: `tests/lab/core-lab-boundary.test.ts:69` reads each resolved source file while walking static imports/re-exports. A read-only replay of that walk from `src/server/responses/core.ts` reaches this target (413 visited files at the basis). Disposition: **unchanged**; new leaves are automatically included through named imports/re-exports, so no manual add-leaf-to-scan-list and no retarget. Never edit its PROTECTED roots (lines 20–28). At implementation time drive this guard red once with a temporary forbidden leaf edge to `../../lab/paths`, then restore and prove green; no forbidden edge may enter a commit.

In C phase only, drive `tests/providers/cursor/cursor-tool-definitions.test.ts:43` red by temporarily breaking the ordinary bare-name alias predicate in tool-naming.ts, and `:328` red by temporarily removing the pinned-choice escape in tool-guidance.ts. Restore immediately, then rerun the focused files; never commit mutants or weaken assertions. Also retain schema byte-equivalence tests at :81 and :106 and guidance/code-mode assertions at :360 and :499.

No test file is added by this plan, hence no test-layout manifest change. If extra regression coverage proves necessary, extend the existing focused files first and report scope expansion instead of silently creating new tests.

## Verification

Instantiate 002's Per-layer gate in this layer's dedicated worktree, not in the docs worktree. Nothing in this code fence was run by the drafting delegate.

```sh
bun run typecheck
# Focused domain: providers/cursor (includes the direct Cursor tests listed above)
bun test tests/providers/cursor
bun test tests/adapters/adapter-tool-conformance.test.ts
bun test tests/responses/responses-tool-conformance.test.ts
# Transitive source-graph guard; justified even though only adapters files move
bun test tests/lab/core-lab-boundary.test.ts
bun run privacy:scan
wc -l src/adapters/cursor/tool-naming.ts src/adapters/cursor/tool-schemas.ts src/adapters/cursor/tool-guidance.ts src/adapters/cursor/tool-definitions.ts
rg -n 'from "[^"]*/tool-definitions"' src gui/src scripts tests | wc -l
rg -l 'adapters/cursor/tool-definitions' tests
# Full suite: remote only; preserve pipeline failure rather than trusting tail's exit status
ssh lidge 'set -o pipefail; cd ~/ocx-ci/opencodex && git fetch origin codex/split-adapters-cursor-tool-definitions && git checkout -q FETCH_HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15'
```

Focused named subset (for initial tight red/green and for an exact task manifest):

```sh
bun test tests/adapters/adapter-tool-conformance.test.ts tests/providers/cursor/cursor-request-builder.test.ts tests/providers/cursor/cursor-structured-edit.test.ts tests/providers/cursor/cursor-tool-choice.test.ts tests/providers/cursor/cursor-tool-definitions.test.ts tests/responses/responses-tool-conformance.test.ts
```

Use the named subset for the temporary mutation checks, then the domain gate after restoration; do not rerun an unchanged passing check solely for confidence. Full suite is **never local**. Remote parent workflow must bind FETCH_HEAD/full-suite output to this exact PR head SHA, preserve a complete remote log as well as its summary, and ensure the remote checkout is exclusively owned before checkout; do not operate on unrelated dirty remote work.

Importer proof: compare the 13-file resolved importer set above at parent and tip. Existing external consumer paths stay unchanged. New leaf imports are planned internal edges, not lost callers; count them separately. The simple 002 line-count command is supporting evidence only: multiline and dynamic imports require the resolved-file check. Export-name/type identity must be checked independently. Run a resolved runtime+type import-cycle scan with available repository tooling or a read-only resolver; do not install a dependency just for this split. Review `git diff --numstat codex/split-cursor-desktop-executor-contract...HEAD` with move-aware comparison and separately record raw additions + deletions; apply the sizing escalation above, not an unrecorded exception. Require green exact-head CI rollup, not merely an empty required-check list.

## Accept criteria

1. Source basis and parent branch are recorded; every owned top-level declaration in this table has exactly one post-move owner, with identical body/signature and attached explanatory comments.
2. All current 55 exports remain importable from `src/adapters/cursor/tool-definitions.ts`, with the same value/reference/type identity; no new internal-only export leaks through that original path. Residual local calls are bound by explicit imports.
3. Every planned leaf is ≤400 lines and residual is ≤400 (expected 113); actual `wc -l` agrees or the exact formatting delta is recorded. No omitted #b debt.
4. Schema payloads and emitted guidance strings remain byte-identical; namespace aliases, tool_choice pins, code-mode detection, and synthetic-edit provenance remain unchanged.
5. All 13 existing resolved importers remain; direct test imports/assertions and transitive source-reader semantics are preserved. Planned red mutations fail the named guards once, are removed, and the restored focused/domain checks pass with 0 failures.
6. Single-owner state allocations, allowed DAG edges, and no new runtime/type cycles are mechanically verified. Lab PROTECTED roots and optional-subsystem activation remain untouched.
7. Typecheck and privacy scan exit 0; remote-only full suite exits 0 at the exact layer SHA; exact-head CI rollup is green. No local full suite, no merge, and no unrelated changes.
8. Parent-to-tip size obeys the agreed 500-line metric or the parent explicitly resolves the documented exception/topology escalation before implementation; this draft itself is not evidence of an approved exception.

## PR

Title: `refactor(adapters-cursor): separate tool naming schemas and guidance (split S04 L1/5)`

Branch: `codex/split-adapters-cursor-tool-definitions`. Base: `codex/split-cursor-desktop-executor-contract`. Closes: **none**.

Use every section of `.github/PULL_REQUEST_TEMPLATE.md` (Summary, Verification, Checklist); paste the stack map below into Summary. Review only this layer's parent-to-tip diff. Replace PR placeholders with actual numbers when opened; no PR is created by this draft.

| # | PR | Branch | Base | Review focus |
|---|---|---|---|---|
| 0 (105) | #TBD-S04-L0 | `codex/split-cursor-desktop-executor-contract` | `dev` | desktop-executor-contract |
| 1 | #TBD-S04-L1 | `codex/split-adapters-cursor-tool-definitions` | `codex/split-cursor-desktop-executor-contract` | tool-definitions |
| 2 | #TBD-S04-L2 | `codex/split-adapters-cursor-catalog` | `codex/split-cursor-desktop-executor-contract` | catalog |
| 3 | #TBD-S04-L3 | `codex/split-adapters-cursor-images` | `codex/split-cursor-desktop-executor-contract` | images |
| 4 | #TBD-S04-L4 | `codex/split-adapters-cursor-request-builder` | `codex/split-adapters-cursor-images` | request-builder |
| 5 | #TBD-S04-L5 | `codex/split-adapters-cursor-protobuf-events` | `codex/split-adapters-cursor-tool-definitions` | protobuf-events |

Current layer: **L1**. Parent: `codex/split-cursor-desktop-executor-contract` (#TBD-S04-L0).
Changes to parent `codex/split-cursor-desktop-executor-contract` require rebasing this layer and cascading only
through its actual dependency descendants, with exact-tip/base rechecks
(DEV-STACK-02); sibling layer numbering creates no dependency. Merge remains
parent-before-child and separately authorized, never part of this draft.

## P stale-check (2026-09-05, wp110)

Base branch `codex/split-cursor-desktop-executor-contract` = 97df51515 (PR #3557, CI green). `git diff` of tool-definitions.ts between that tip and origin/dev is empty (777 lines); slice anchors 8/20/21/43/44/117/118/268/326/396/398/444/446/536/538/606/608/619/621/736/738 confirmed by sed. Executor rules: no bun run test; OCX_TEST_NO_QUEUE=1 on focused runs; CI hygiene requires a test change in the same PR.

## Execution record (B/C/D, 2026-09-05)

- Executor worktree: `/tmp/ocx-split-110.CXPieV/wt` (branch `codex/split-adapters-cursor-tool-definitions`, base `codex/split-cursor-desktop-executor-contract` 97df51515). Executor: gpt-6-astra high (Russell, 01a06f21-e324-73c3-8b50-b69ae5b5e3c2).
- Commits: 5091dd604 (move: tool-naming 252, tool-schemas 195, tool-guidance 236, tool-definitions residual 112) and 73672ffd2 (test: cursor-tool-definitions.test.ts +13 — seam identity via both paths for naming/schemas/guidance; tool-naming has no ./tool-* import). Diff vs base: 5 files, +701/−670.
- Local gate: typecheck 0; focused (5 files) 203 pass / 0 fail; core-lab-boundary 17/0; privacy passed; 13 original-path importers unchanged; naming imports no sibling leaf.
- Red-drives: (a) bare-name predicate → :44 fails, restored; (b) pinned-choice escape → :340 fails, restored; (c) lab import in tool-naming → core-lab-boundary:288 fails with chain core → adapter-resolve → registry → cursor → tool-definitions → tool-naming → lab/paths, restored 17/0.

- Adversarial diff review (Singer, gpt-6-astra high, 01a06f25-a703-7883-b091-93c43f87958e): GO-WITH-FIXES (blockers=0): all slices preserved (10 blank separators inserted, whitespace only), residual exact except original blank line 7, 55 exports identical, 3 internal seams not re-exported, runtime + type-inclusive graph zero new cycles (one pre-existing types→request→provider→mcp-config type cycle, TYPE-CYCLE-01). Non-blocking nit — quote-sensitive root guard — fixed in fdddbd3e1 (regex `from\s+["']\.\/tool-`), test 29/0.
- lidge full suite at 73672ffd2: SUITE_EXIT=0, 18014 pass / 0 fail / 16 skip; rerun at fdddbd3e1 recorded below.

- lidge full suite at fdddbd3e1: SUITE_EXIT=0, 18014 pass / 0 fail / 16 skip (/tmp/suite-split-110.log).
- PR: https://github.com/lidge-jun/opencodex/pull/3570 (base codex/split-cursor-desktop-executor-contract, head fdddbd3e1). CI rollup at record time: OPEN draft=false base=codex/split-cursor-desktop-executor-contract fdddbd3e1 =1 =10 CANCELLED=1 SKIPPED=2 SUCCESS=11
