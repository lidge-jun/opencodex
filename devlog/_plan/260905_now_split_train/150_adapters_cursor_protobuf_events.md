# S04 L5/5 — protobuf-events

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

Docs basis: `4cc219549`; source basis: `origin/dev = 1362b1a3841b4de20177e5d65865a513dd7936c4`. Every source line range below refers to `src/adapters/cursor/protobuf-events.ts` at that source commit, not a future leaf. Read alongside 000_plan.md, 001_stale_check.md, 002_layer_map.md, and ../260905_modular_debt_ledger/014_lane_adapters_media.md (lane 014; relevant file subsection). Status: diff-level plan only; no code, Git mutation, test run, or orchestration performed by this delegate.

## Loop spec

- Archetype: **pure-move**. Work class C3 structural planning, docs-only delegated mode; the parent owns all loop/goal state.
- Goal: move the inventoried responsibilities into the named sibling leaves, each ≤400 lines, preserving the original public import path and leaving 122 expected lines in the original.
- Non-goals: no exported rename/removal, no behavior or signature change, no dependency/tooling installation, no new validation, no changes to generated protobufs, native-exec ownership, live transport scheduling, registry policy, or unrelated files. No production-module execution or test run in this drafting task.
- Verifier: 002_layer_map.md **Per-layer gate**, instantiated in Verification below. Planned commands are for the layer executor; they are not results from this draft.
- Stop: parent records an independently verified, exact-tip layer with all accepts met and exact-head CI rollup; no merge. Stop implementation immediately on a changed signature, string/wire delta, duplicated state, cycle, unaccounted source-reader, or unsupported layer-size claim.
- Escalation: source drift, required files outside this partition/test list, an actual behavior defect, or the sizing conflict below goes to the parent; do not repair it opportunistically. Unreleased security findings go only to approved scratch, never this public devlog.

Implementation sizing escalation: this exact partition transfers 1250 existing physical lines before import/export glue, already over 002's 500 changed-source-line bound even if moves are counted only once. Under additions + deletions it is at least 2500 lines. The fixed S04 five-layer map has no #b slot. Do not silently call this PR ≤500: the parent must either approve a documented move-only size exception or revise the layer topology (and obtain approval for extra layer docs) before implementation. This bounded draft does not alter 002 or invent a sixth branch.

Structural decision and pre-change map: Patch grammar (362–365, 427–804) and structured edits (366–426, 805–1043) are stateless transforms. State factory/context usage (22–181, 202–271, 1338–1381) is separate from MCP argument/lifecycle handling (182–201, 272–361, 1044–1227). Dispatcher 1228–1336 stays original. Rejected: patch-only extraction leaves about 999 lines; a single patch/edit leaf exceeds 400. Chosen: four siblings using the existing protobuf-request / protobuf-events naming convention; no new index.ts. Current live-transport.ts:27/:55 → original → types, agent_pb, arg-codec, arg-normalize, tool-definitions, translator-budget (1–20). Intended: original dispatcher → state/tool-events; tool-events → state types, patch-grammar, structured-edit; structured-edit → patch-grammar. State never imports tool-events or dispatcher. Feature-local event contract and original public exports preserved.

No-code alternatives: doing nothing leaves the requested size debt; deletion/configuration cannot preserve these existing behaviors while shortening their implementation; reuse means moving the current declarations, not inventing equivalent helpers. Owner search: `rg --files src/adapters/cursor`, `rg -n '<symbol>' src gui/src scripts tests`, and the lane-014 seam audit. The named new siblings do not already exist. Existing stable imports are compatibility boundaries, not permission for new convenience barrels.

## Symbol inventory

AST evidence: `git show origin/dev:src/adapters/cursor/protobuf-events.ts`; working-tree bytes compared equal; `ast-grep run --lang typescript --kind <kind> --json=compact src/adapters/cursor/protobuf-events.ts` for lexical/variable/function/interface/type-alias/class declarations, filtered to top-level source starts. Ranges are inclusive, include an `export` modifier on the same line, and exclude preceding comments. 85 owned top-level declarations; imports are dependencies, not redeclared owned symbols.

Consumer counting: `rg -l 'protobuf-events' src gui/src scripts tests` narrows candidates; resolve static `from` and dynamic `import()` relative specifiers to this exact file; then `rg -l -w '<symbol>' <resolved-consumer-files>` counts distinct referencing consumer files. Count excludes the defining file. Private declarations have 0 external bound consumers; their local references move with the partition. This is a file count, not call-site count; do not reuse 001's broad basename heuristic as symbol fan-in.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `DEFAULT_CONTEXT_USAGE_MAX_ENTRIES` | const | 22–22 | no | 0 | `protobuf-event-state.ts` |
| `DEFAULT_CONTEXT_USAGE_TTL_MS` | const | 23–23 | no | 0 | `protobuf-event-state.ts` |
| `DEFAULT_MAX_CLIENT_TOOL_CALLS` | const | 24–24 | no | 0 | `protobuf-event-state.ts` |
| `CursorContextUsageControls` | interface | 26–34 | yes | 0 | `protobuf-event-state.ts` |
| `CursorContextUsageTracker` | interface | 36–44 | yes | 0 | `protobuf-event-state.ts` |
| `CursorContextUsageEntry` | interface | 46–49 | no | 0 | `protobuf-event-state.ts` |
| `createCursorContextUsageTracker` | function | 58–130 | yes | 5 | `protobuf-event-state.ts` |
| `CursorProtobufEventState` | interface | 132–179 | yes | 2 | `protobuf-event-state.ts` |
| `structuredEditCallIsOurs` | function | 195–200 | no | 0 | `protobuf-tool-events.ts` |
| `createCursorProtobufEventState` | function | 202–248 | yes | 7 | `protobuf-event-state.ts` |
| `observeContextTokens` | function | 250–254 | no | 0 | `protobuf-event-state.ts` |
| `reportableContextTokens` | function | 256–262 | yes | 1 | `protobuf-event-state.ts` |
| `usageFromContextTokens` | function | 264–270 | yes | 1 | `protobuf-event-state.ts` |
| `mcpArgsFromToolCall` | function | 273–277 | yes | 1 | `protobuf-tool-events.ts` |
| `mcpWireNameFromArgs` | function | 279–283 | no | 0 | `protobuf-tool-events.ts` |
| `mcpCursorWireName` | function | 285–287 | no | 0 | `protobuf-tool-events.ts` |
| `decodeMcpArgs` | function | 289–291 | no | 0 | `protobuf-tool-events.ts` |
| `resolveAdvertisedClientToolName` | function | 294–301 | no | 0 | `protobuf-tool-events.ts` |
| `toolSchemaForWireName` | function | 303–306 | no | 0 | `protobuf-tool-events.ts` |
| `decodeMcpArgsNormalized` | function | 308–314 | no | 0 | `protobuf-tool-events.ts` |
| `hasMcpArgBytes` | function | 316–318 | no | 0 | `protobuf-tool-events.ts` |
| `isCompleteJson` | function | 320–328 | no | 0 | `protobuf-tool-events.ts` |
| `normalizeJsonText` | function | 331–343 | no | 0 | `protobuf-tool-events.ts` |
| `resolveCompletedArgs` | function | 355–360 | no | 0 | `protobuf-tool-events.ts` |
| `PATCH_BEGIN` | const | 362–362 | no | 0 | `patch-grammar.ts` |
| `PATCH_END` | const | 363–363 | no | 0 | `patch-grammar.ts` |
| `GIT_HUNK_HEADER` | const | 364–364 | no | 0 | `patch-grammar.ts` |
| `MARKDOWN_FENCE` | const | 365–365 | no | 0 | `patch-grammar.ts` |
| `PATH_ARG_KEYS` | const | 366–366 | no | 0 | `structured-edit.ts` |
| `OLD_STRING_KEYS` | const | 367–367 | no | 0 | `structured-edit.ts` |
| `NEW_STRING_KEYS` | const | 368–368 | no | 0 | `structured-edit.ts` |
| `StructuredEditPair` | type | 370–370 | yes | 0 | `structured-edit.ts` |
| `lineBlockIndex` | function | 373–382 | no | 0 | `structured-edit.ts` |
| `replaceLineBlock` | function | 384–391 | no | 0 | `structured-edit.ts` |
| `foldSequentialStructuredEdits` | function | 399–425 | yes | 1 | `structured-edit.ts` |
| `GIT_NO_NEWLINE` | const | 427–427 | no | 0 | `patch-grammar.ts` |
| `GIT_META_PREFIX` | const | 428–428 | no | 0 | `patch-grammar.ts` |
| `GIT_FILE_HEADER` | const | 429–429 | no | 0 | `patch-grammar.ts` |
| `isCodexFileOpLine` | function | 431–435 | no | 0 | `patch-grammar.ts` |
| `canonicalizeCodexLine` | function | 437–460 | no | 0 | `patch-grammar.ts` |
| `isGitPreambleLine` | function | 462–467 | no | 0 | `patch-grammar.ts` |
| `unquoteGitPath` | function | 469–478 | no | 0 | `patch-grammar.ts` |
| `normalizePatchPath` | function | 481–485 | no | 0 | `patch-grammar.ts` |
| `parseDiffGitPaths` | function | 487–493 | no | 0 | `patch-grammar.ts` |
| `parseGitSidePath` | function | 495–501 | no | 0 | `patch-grammar.ts` |
| `isDevNull` | function | 503–505 | no | 0 | `patch-grammar.ts` |
| `rewriteHunkHeader` | function | 507–509 | no | 0 | `patch-grammar.ts` |
| `isFenceLine` | function | 511–513 | no | 0 | `patch-grammar.ts` |
| `isHunkBodyLine` | function | 515–523 | no | 0 | `patch-grammar.ts` |
| `rewriteCodexFileOpLine` | function | 525–532 | no | 0 | `patch-grammar.ts` |
| `normalizeAddFileBody` | function | 534–556 | no | 0 | `patch-grammar.ts` |
| `hasNonEmptyCodexOp` | function | 558–588 | no | 0 | `patch-grammar.ts` |
| `trimEmptyEdges` | function | 590–596 | no | 0 | `patch-grammar.ts` |
| `cleanHunkLines` | function | 598–612 | no | 0 | `patch-grammar.ts` |
| `isGitSectionStart` | function | 614–617 | no | 0 | `patch-grammar.ts` |
| `splitGitSections` | function | 619–633 | no | 0 | `patch-grammar.ts` |
| `isGitBinarySection` | function | 635–637 | no | 0 | `patch-grammar.ts` |
| `isGitCopySection` | function | 639–641 | no | 0 | `patch-grammar.ts` |
| `isGitEmptyRenameSection` | function | 643–649 | no | 0 | `patch-grammar.ts` |
| `isGitUntranslatableSection` | function | 651–653 | no | 0 | `patch-grammar.ts` |
| `convertGitSection` | function | 655–696 | no | 0 | `patch-grammar.ts` |
| `hasCodexFileOp` | function | 698–700 | no | 0 | `patch-grammar.ts` |
| `sanitizeCodexApplyPatch` | function | 703–749 | yes | 1 | `patch-grammar.ts` |
| `coercePatchInput` | function | 751–772 | no | 0 | `patch-grammar.ts` |
| `sanitizeEmittedApplyPatchArgs` | function | 774–803 | yes | 1 | `patch-grammar.ts` |
| `firstStringArg` | function | 805–811 | no | 0 | `structured-edit.ts` |
| `firstStringOrLines` | function | 813–822 | no | 0 | `structured-edit.ts` |
| `patchLines` | function | 825–829 | no | 0 | `structured-edit.ts` |
| `restoreFlushLeftIndent` | function | 837–856 | no | 0 | `structured-edit.ts` |
| `addFilePatch` | function | 858–864 | no | 0 | `structured-edit.ts` |
| `replacementHunk` | function | 867–892 | no | 0 | `structured-edit.ts` |
| `StructuredEditTranslation` | type | 902–904 | yes | 0 | `structured-edit.ts` |
| `translateStructuredEditCall` | function | 906–1042 | yes | 1 | `structured-edit.ts` |
| `mapSyntheticMcpExecToToolEvents` | function | 1044–1091 | yes | 4 | `protobuf-tool-events.ts` |
| `recordToolCall` | function | 1101–1118 | no | 0 | `protobuf-tool-events.ts` |
| `cursorFreeformWrapperValid` | function | 1126–1136 | no | 0 | `protobuf-tool-events.ts` |
| `dropInvalidFreeformCall` | function | 1138–1143 | no | 0 | `protobuf-tool-events.ts` |
| `dropShellBridgeCall` | function | 1145–1150 | no | 0 | `protobuf-tool-events.ts` |
| `dropStructuredEditCall` | function | 1152–1159 | no | 0 | `protobuf-tool-events.ts` |
| `commitToolCall` | function | 1161–1196 | no | 0 | `protobuf-tool-events.ts` |
| `bufferToolArgs` | function | 1204–1218 | no | 0 | `protobuf-tool-events.ts` |
| `endToolCall` | function | 1220–1226 | no | 0 | `protobuf-tool-events.ts` |
| `mapCursorProtobufServerMessage` | function | 1228–1336 | yes | 4 | `protobuf-events.ts` (residual) |
| `resolvedTurnUsage` | function | 1344–1357 | yes | 1 | `protobuf-event-state.ts` |
| `finalizeTurnEvents` | function | 1365–1381 | yes | 2 | `protobuf-event-state.ts` |

Resolved direct importers: 9 distinct files (1 production, 8 tests). Production paths:

- `src/adapters/cursor/live-transport.ts` — unchanged.

## Leaf partition

All paths below are new sibling files under `src/adapters/cursor/`, following the existing kebab-case native-exec-* and protobuf-* convention. Each symbol body and attached comment moves without rewriting. Physical slice accounting includes blank lines/comments; keep slice contents in their original relative order. Expected sizes use the exact compact import/re-export lines shown; multiline formatting consumes spare budget and must be recounted, especially catalog.ts.

### `src/adapters/cursor/protobuf-event-state.ts`

- Transfer source slices: 22–181, 202–271, 1338–1381 (274 physical lines).
- Symbols: `DEFAULT_CONTEXT_USAGE_MAX_ENTRIES`, `DEFAULT_CONTEXT_USAGE_TTL_MS`, `DEFAULT_MAX_CLIENT_TOOL_CALLS`, `CursorContextUsageControls`, `CursorContextUsageTracker`, `CursorContextUsageEntry`, `createCursorContextUsageTracker`, `CursorProtobufEventState`, `createCursorProtobufEventState`, `observeContextTokens`, `reportableContextTokens`, `usageFromContextTokens`, `resolvedTurnUsage`, `finalizeTurnEvents`.
- Expected line count: 274 moved + 3 import lines = **277**, ≤400.
- Own imports:

```ts
import type { OcxUsage } from "../../types";
import type { TranslatorBudget } from "../../lib/translator-budget";
import type { CursorServerMessage } from "./types";
```

### `src/adapters/cursor/protobuf-tool-events.ts`

- Transfer source slices: 182–201, 272–361, 1044–1227 (294 physical lines).
- Symbols: `structuredEditCallIsOurs`, `mcpArgsFromToolCall`, `mcpWireNameFromArgs`, `mcpCursorWireName`, `decodeMcpArgs`, `resolveAdvertisedClientToolName`, `toolSchemaForWireName`, `decodeMcpArgsNormalized`, `hasMcpArgBytes`, `isCompleteJson`, `normalizeJsonText`, `resolveCompletedArgs`, `mapSyntheticMcpExecToToolEvents`, `recordToolCall`, `cursorFreeformWrapperValid`, `dropInvalidFreeformCall`, `dropShellBridgeCall`, `dropStructuredEditCall`, `commitToolCall`, `bufferToolArgs`, `endToolCall`.
- Expected line count: 294 moved + 8 import lines = **302**, ≤400.
- Own imports:

```ts
import type { McpArgs, ToolCall } from "./gen/agent_pb";
import { decodeCursorArgsMap } from "./arg-codec";
import { normalizeArgKeys } from "./arg-normalize";
import { CODEX_APPLY_PATCH_TOOL, cursorShellBridgeArgsValid, cursorShellBridgeDropError, defaultShellBridgeArgNormalizeSchema, isCodexShellBridgeToolName, normalizeCursorWireName, OCX_RESPONSES_TOOL_PROVIDER, resolveShellBridgeAliasKey, responsesToolNameFromCursorWire } from "./tool-definitions";
import type { CursorServerMessage } from "./types";
import type { CursorProtobufEventState } from "./protobuf-event-state";
import { sanitizeEmittedApplyPatchArgs } from "./patch-grammar";
import { translateStructuredEditCall } from "./structured-edit";
```

### `src/adapters/cursor/patch-grammar.ts`

- Transfer source slices: 362–365, 427–804 (382 physical lines).
- Symbols: `PATCH_BEGIN`, `PATCH_END`, `GIT_HUNK_HEADER`, `MARKDOWN_FENCE`, `GIT_NO_NEWLINE`, `GIT_META_PREFIX`, `GIT_FILE_HEADER`, `isCodexFileOpLine`, `canonicalizeCodexLine`, `isGitPreambleLine`, `unquoteGitPath`, `normalizePatchPath`, `parseDiffGitPaths`, `parseGitSidePath`, `isDevNull`, `rewriteHunkHeader`, `isFenceLine`, `isHunkBodyLine`, `rewriteCodexFileOpLine`, `normalizeAddFileBody`, `hasNonEmptyCodexOp`, `trimEmptyEdges`, `cleanHunkLines`, `isGitSectionStart`, `splitGitSections`, `isGitBinarySection`, `isGitCopySection`, `isGitEmptyRenameSection`, `isGitUntranslatableSection`, `convertGitSection`, `hasCodexFileOp`, `sanitizeCodexApplyPatch`, `coercePatchInput`, `sanitizeEmittedApplyPatchArgs`.
- Expected line count: 382 moved + 0 import lines = **382**, ≤400.
- Own imports: none; standard Bun/JavaScript globals are not module imports.

### `src/adapters/cursor/structured-edit.ts`

- Transfer source slices: 366–426, 805–1043 (300 physical lines).
- Symbols: `PATH_ARG_KEYS`, `OLD_STRING_KEYS`, `NEW_STRING_KEYS`, `StructuredEditPair`, `lineBlockIndex`, `replaceLineBlock`, `foldSequentialStructuredEdits`, `firstStringArg`, `firstStringOrLines`, `patchLines`, `restoreFlushLeftIndent`, `addFilePatch`, `replacementHunk`, `StructuredEditTranslation`, `translateStructuredEditCall`.
- Expected line count: 300 moved + 2 import lines = **302**, ≤400.
- Own imports:

```ts
import { CURSOR_MULTI_EDIT_TOOL, isCursorStructuredEditToolName } from "./tool-definitions";
import { PATCH_BEGIN, PATCH_END, normalizePatchPath } from "./patch-grammar";
```

### Residual `src/adapters/cursor/protobuf-events.ts`

Retain: `mapCursorProtobufServerMessage`.

Replace all original imports at 1–20 with the five explicit imports below. The remaining original consists of dispatcher 1228–1336 and blank lines; add six named re-export lines. Count is 131 − 20 + 5 + 6 = 122.

Accounting: 1381 − 1250 moved − 20 net removed import lines + 5 local import lines + 6 re-export lines = **122** expected lines. All leaves plus residual total 1385 = 1381 original + 4 net import/export glue lines. No >400 residual and no #a/#b/#c part in this approved map. A size-policy escalation is not a hidden #b commitment; if the parent adds parts, re-plan lower-consumer leaves first and publish each intermediate residual count.

New leaf-only exports are existing declarations, not new helpers: protobuf-event-state exports observeContextTokens (250); protobuf-tool-events exports mcpCursorWireName (285), recordToolCall (1101), bufferToolArgs (1204), hasMcpArgBytes (316), cursorFreeformWrapperValid (1126), resolveCompletedArgs (355), commitToolCall (1161); patch-grammar exports PATCH_BEGIN (362), PATCH_END (363), normalizePatchPath (481). Keep these out of the original public export set. Preserve private decodeMcpArgs (289) even if presently unused; do not delete it during a move.

## Re-export block

Insert into the original file exactly these named lines; current exported declarations that stay local remain exported in place (`mapCursorProtobufServerMessage`). Do not use export-star and do not re-export newly exposed internal-only seams.

```ts
export { createCursorContextUsageTracker, createCursorProtobufEventState, reportableContextTokens, usageFromContextTokens, resolvedTurnUsage, finalizeTurnEvents } from "./protobuf-event-state";
export type { CursorContextUsageControls, CursorContextUsageTracker, CursorProtobufEventState } from "./protobuf-event-state";
export { mcpArgsFromToolCall, mapSyntheticMcpExecToToolEvents } from "./protobuf-tool-events";
export { sanitizeCodexApplyPatch, sanitizeEmittedApplyPatchArgs } from "./patch-grammar";
export { foldSequentialStructuredEdits, translateStructuredEditCall } from "./structured-edit";
export type { StructuredEditPair, StructuredEditTranslation } from "./structured-edit";
```

Re-export binds nothing locally. The original needs these explicit leaf imports (this is the complete replacement import block, including retained external dependencies):

```ts
import type { AgentServerMessage } from "./gen/agent_pb";
import type { CursorServerMessage } from "./types";
import { normalizeCursorTextToolMarkers } from "./tool-definitions";
import { observeContextTokens, finalizeTurnEvents, type CursorProtobufEventState } from "./protobuf-event-state";
import { mcpCursorWireName, mcpArgsFromToolCall, recordToolCall, bufferToolArgs, hasMcpArgBytes, cursorFreeformWrapperValid, resolveCompletedArgs, commitToolCall } from "./protobuf-tool-events";
```

## Module-level state and cycles

No top-level mutable let, Map, Set, WeakMap, lock, or timer. Context tracker entries Map is factory-local at :62 and stays inside createCursorContextUsageTracker in protobuf-event-state.ts. Request-local open/completed/client/freeform/provenance collections (:223–228) remain factory-local in that same leaf; do not hoist or clone them. TranslatorBudget remains caller-owned. State functions and tool-events receive the same object; no shared module singleton is introduced. Three default scalars (22–24) are owned by the state leaf; patch regexes and PATCH_BEGIN/PATCH_END by patch-grammar; edit key arrays by structured-edit. The state leaf includes finalizeTurnEvents and resolvedTurnUsage, which do not depend on tool handlers; this avoids state → tool-events → state. Tool-events owns record/commit/end together, avoiding commit → original dispatcher → tool-events. Structured-edit imports the existing normalizePatchPath and patch delimiters from patch-grammar; patch-grammar imports nothing and cannot depend on structured-edit. CursorServerMessage is imported from the existing ./types, not from the original event facade.

Read-only graph check of this planned layer's new imports found no return cycle involving `protobuf-event-state.ts`, `protobuf-tool-events.ts`, `patch-grammar.ts`, `structured-edit.ts`. The stack still inherits the **L1 type-only-cycle prerequisite** documented in 110_adapters_cursor_tool_definitions.md: `src/types.ts:112 → src/types/provider.ts:701 → native-exec-desktop.ts:19 → native-exec-tools.ts:25 → tool-definitions.ts → src/types.ts`. Do not claim whole-stack type acyclicity until the parent resolves that out-of-scope prerequisite; these later leaves do not repair it. The local partition/line accounting here remains conditional on a valid L1 parent.

The leaf direction listed in Loop spec is the allowed DAG. Sibling leaves import their canonical owner directly, never this original facade. Preserve initialization order for cross-constant references. Verify both runtime and type-only edges; a typecheck alone does not prove acyclicity. Compare the resolved import graph at the parent and tip; zero new cycles and no path from any new leaf back to the original are required. Existing external-format/provenance checks remain at the same trust boundary; do not reinterpret validation while relocating it.

## Tests

Exact direct-test list from `rg -l 'adapters/cursor/protobuf-events' tests`, with specifier resolution to discard comments/other basenames:

- `tests/providers/cursor/cursor-interaction-query.test.ts` — **unchanged** import path and assertions.
- `tests/providers/cursor/cursor-live-transport.test.ts` — **unchanged** import path and assertions.
- `tests/providers/cursor/cursor-protobuf-events.test.ts` — **unchanged** import path and assertions.
- `tests/providers/cursor/cursor-structured-edit.test.ts` — **unchanged** import path and assertions.
- `tests/providers/cursor/cursor-tool-arg-decoding.test.ts` — **unchanged** import path and assertions.
- `tests/providers/cursor/cursor-tool-continuation.test.ts` — **unchanged** import path and assertions.
- `tests/providers/cursor/cursor-tool-finalize-race.test.ts` — **unchanged** import path and assertions.
- `tests/responses/responses-state.test.ts` — **unchanged** import path and assertions.

No source-body oracle found for protobuf-events.ts. responses-state.test.ts imports createCursorContextUsageTracker at :23 but reads persisted state artifacts, not this file. Dynamic imports in cursor-interaction-query.test.ts:151/:165/:173/:190/:196 are ordinary API consumers. All tests below remain unchanged; no source retargets or scan-list changes.

Transitive source-reader exception: `tests/lab/core-lab-boundary.test.ts:69` reads each resolved source file while walking static imports/re-exports. A read-only replay of that walk from `src/server/responses/core.ts` reaches this target (413 visited files at the basis). Disposition: **unchanged**; new leaves are automatically included through named imports/re-exports, so no manual add-leaf-to-scan-list and no retarget. Never edit its PROTECTED roots (lines 20–28). At implementation time drive this guard red once with a temporary forbidden leaf edge to `../../lab/paths`, then restore and prove green; no forbidden edge may enter a commit.

In C phase, drive tests/providers/cursor/cursor-structured-edit.test.ts:296 red by temporarily restoring substring folding; :750 red by temporarily dropping the mixed-binary passthrough; :1419 red by temporarily converting the stateless native-exec branch without provenance. Restore immediately. Drive tests/providers/cursor/cursor-protobuf-events.test.ts:1022 red by temporarily removing dispatcher termination gating; preserve :277 atomic parallel emission and :925 absolute checkpoint totals. This validates moved ownership without weakening failure or translator-budget semantics.

No test file is added by this plan, hence no test-layout manifest change. If extra regression coverage proves necessary, extend the existing focused files first and report scope expansion instead of silently creating new tests.

## Verification

Instantiate 002's Per-layer gate in this layer's dedicated worktree, not in the docs worktree. Nothing in this code fence was run by the drafting delegate.

```sh
bun run typecheck
# Focused domain: providers/cursor (includes the direct Cursor tests listed above)
bun test tests/providers/cursor
bun test tests/adapters/adapter-tool-conformance.test.ts
bun test tests/responses/responses-state.test.ts
# Transitive source-graph guard; justified even though only adapters files move
bun test tests/lab/core-lab-boundary.test.ts
bun run privacy:scan
wc -l src/adapters/cursor/protobuf-event-state.ts src/adapters/cursor/protobuf-tool-events.ts src/adapters/cursor/patch-grammar.ts src/adapters/cursor/structured-edit.ts src/adapters/cursor/protobuf-events.ts
rg -n 'from "[^"]*/protobuf-events"' src gui/src scripts tests | wc -l
rg -l 'adapters/cursor/protobuf-events' tests
# Full suite: remote only; preserve pipeline failure rather than trusting tail's exit status
ssh lidge 'set -o pipefail; cd ~/ocx-ci/opencodex && git fetch origin codex/split-adapters-cursor-protobuf-events && git checkout -q FETCH_HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15'
```

Focused named subset (for initial tight red/green and for an exact task manifest):

```sh
bun test tests/adapters/adapter-tool-conformance.test.ts tests/providers/cursor/cursor-interaction-query.test.ts tests/providers/cursor/cursor-live-transport.test.ts tests/providers/cursor/cursor-protobuf-events.test.ts tests/providers/cursor/cursor-structured-edit.test.ts tests/providers/cursor/cursor-tool-arg-decoding.test.ts tests/providers/cursor/cursor-tool-continuation.test.ts tests/providers/cursor/cursor-tool-finalize-race.test.ts tests/responses/responses-state.test.ts
```

Use the named subset for the temporary mutation checks, then the domain gate after restoration; do not rerun an unchanged passing check solely for confidence. Full suite is **never local**. Remote parent workflow must bind FETCH_HEAD/full-suite output to this exact PR head SHA, preserve a complete remote log as well as its summary, and ensure the remote checkout is exclusively owned before checkout; do not operate on unrelated dirty remote work.

Importer proof: compare the 9-file resolved importer set above at parent and tip. Existing external consumer paths stay unchanged. New leaf imports are planned internal edges, not lost callers; count them separately. The simple 002 line-count command is supporting evidence only: multiline and dynamic imports require the resolved-file check. Export-name/type identity must be checked independently. Run a resolved runtime+type import-cycle scan with available repository tooling or a read-only resolver; do not install a dependency just for this split. Review `git diff --numstat codex/split-adapters-cursor-tool-definitions...HEAD` with move-aware comparison and separately record raw additions + deletions; apply the sizing escalation above, not an unrecorded exception. Require green exact-head CI rollup, not merely an empty required-check list.

## Accept criteria

1. Source basis and parent branch are recorded; every owned top-level declaration in this table has exactly one post-move owner, with identical body/signature and attached explanatory comments.
2. All current 18 exports remain importable from `src/adapters/cursor/protobuf-events.ts`, with the same value/reference/type identity; no new internal-only export leaks through that original path. Residual local calls are bound by explicit imports.
3. Every planned leaf is ≤400 lines and residual is ≤400 (expected 122); actual `wc -l` agrees or the exact formatting delta is recorded. No omitted #b debt.
4. Patch and structured-edit output strings/errors are byte-identical; request-local state identity, atomic tool start/delta/end order, late-native argument handling, provenance gates, terminal inertness, usage totals, and translator-budget reservations/close ordering remain unchanged.
5. All 9 existing resolved importers remain; direct test imports/assertions and transitive source-reader semantics are preserved. Planned red mutations fail the named guards once, are removed, and the restored focused/domain checks pass with 0 failures.
6. Single-owner state allocations, allowed DAG edges, and no new runtime/type cycles are mechanically verified. Lab PROTECTED roots and optional-subsystem activation remain untouched.
7. Typecheck and privacy scan exit 0; remote-only full suite exits 0 at the exact layer SHA; exact-head CI rollup is green. No local full suite, no merge, and no unrelated changes.
8. Parent-to-tip size obeys the agreed 500-line metric or the parent explicitly resolves the documented exception/topology escalation before implementation; this draft itself is not evidence of an approved exception.

## PR

Title: `refactor(adapters-cursor): separate patch translation and event-state seams (split S04 L5/5)`

Branch: `codex/split-adapters-cursor-protobuf-events`. Base: `codex/split-adapters-cursor-tool-definitions`. Closes: **none**.

Use every section of `.github/PULL_REQUEST_TEMPLATE.md` (Summary, Verification, Checklist); paste the stack map below into Summary. Review only this layer's parent-to-tip diff. Replace PR placeholders with actual numbers when opened; no PR is created by this draft.

| # | PR | Branch | Base | Review focus |
|---|---|---|---|---|
| 0 (105) | #TBD-S04-L0 | `codex/split-cursor-desktop-executor-contract` | `dev` | desktop-executor-contract |
| 1 | #TBD-S04-L1 | `codex/split-adapters-cursor-tool-definitions` | `codex/split-cursor-desktop-executor-contract` | tool-definitions |
| 2 | #TBD-S04-L2 | `codex/split-adapters-cursor-catalog` | `codex/split-cursor-desktop-executor-contract` | catalog |
| 3 | #TBD-S04-L3 | `codex/split-adapters-cursor-images` | `codex/split-cursor-desktop-executor-contract` | images |
| 4 | #TBD-S04-L4 | `codex/split-adapters-cursor-request-builder` | `codex/split-adapters-cursor-images` | request-builder |
| 5 | #TBD-S04-L5 | `codex/split-adapters-cursor-protobuf-events` | `codex/split-adapters-cursor-tool-definitions` | protobuf-events |

Current layer: **L5**. Parent: `codex/split-adapters-cursor-tool-definitions` (#TBD-S04-L1).
Changes to parent `codex/split-adapters-cursor-tool-definitions` require rebasing this layer and cascading only
through its actual dependency descendants, with exact-tip/base rechecks
(DEV-STACK-02); sibling layer numbering creates no dependency. Merge remains
parent-before-child and separately authorized, never part of this draft.
