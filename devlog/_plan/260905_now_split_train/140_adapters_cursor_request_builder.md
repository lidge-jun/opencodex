# S04 L4/5 — request-builder

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

Docs basis: `4cc219549`; source basis: `origin/dev = 1362b1a3841b4de20177e5d65865a513dd7936c4`. Every source line range below refers to `src/adapters/cursor/request-builder.ts` at that source commit, not a future leaf. Read alongside 000_plan.md, 001_stale_check.md, 002_layer_map.md, and ../260905_modular_debt_ledger/014_lane_adapters_media.md (lane 014; relevant file subsection). Status: diff-level plan only; no code, Git mutation, test run, or orchestration performed by this delegate.

## Loop spec

- Archetype: **pure-move**. Work class C3 structural planning, docs-only delegated mode; the parent owns all loop/goal state.
- Goal: move the inventoried responsibilities into the named sibling leaves, each ≤400 lines, preserving the original public import path and leaving 363 expected lines in the original.
- Non-goals: no exported rename/removal, no behavior or signature change, no dependency/tooling installation, no new validation, no changes to generated protobufs, native-exec ownership, live transport scheduling, registry policy, or unrelated files. No production-module execution or test run in this drafting task.
- Verifier: 002_layer_map.md **Per-layer gate**, instantiated in Verification below. Planned commands are for the layer executor; they are not results from this draft.
- Stop: parent records an independently verified, exact-tip layer with all accepts met and exact-head CI rollup; no merge. Stop implementation immediately on a changed signature, string/wire delta, duplicated state, cycle, unaccounted source-reader, or unsupported layer-size claim.
- Escalation: source drift, required files outside this partition/test list, an actual behavior defect, or the sizing conflict below goes to the parent; do not repair it opportunistically. Unreleased security findings go only to approved scratch, never this public devlog.

Sizing: 145 moved lines, at least 290 additions + deletions before glue; the planned extraction fits the 500-line layer budget. Confirm actual parent-to-tip numstat at implementation time.

Structural decision and pre-change map: Budget selection and catalog-limit wording (38–182) only need tool metadata, choice policy, and exact protobuf byte sizing. Request assembly (476–518), checkpoint lookup (401–474), identity and digest logic (325–399), and model selection remain original. Rejected: moving conversation/checkpoint code introduces unnecessary lifetime coupling. Chosen: tool-budget.ts sibling in the existing cursor flat layout. Current callers cursor.ts and live-transport.ts:17 → request-builder → catalog/tool-definitions/images/discovery/checkpoint-store/thread-continuity (1–36). New edge original → tool-budget → tool-definitions; no reverse edge or new mutable state. This is one local functional/sequential extraction; no provider contract changes.

No-code alternatives: doing nothing leaves the requested size debt; deletion/configuration cannot preserve these existing behaviors while shortening their implementation; reuse means moving the current declarations, not inventing equivalent helpers. Owner search: `rg --files src/adapters/cursor`, `rg -n '<symbol>' src gui/src scripts tests`, and the lane-014 seam audit. The named new siblings do not already exist. Existing stable imports are compatibility boundaries, not permission for new convenience barrels.

## Symbol inventory

AST evidence: `git show origin/dev:src/adapters/cursor/request-builder.ts`; working-tree bytes compared equal; `ast-grep run --lang typescript --kind <kind> --json=compact src/adapters/cursor/request-builder.ts` for lexical/variable/function/interface/type-alias/class declarations, filtered to top-level source starts. Ranges are inclusive, include an `export` modifier on the same line, and exclude preceding comments. 28 owned top-level declarations; imports are dependencies, not redeclared owned symbols.

Consumer counting: `rg -l 'request-builder' src gui/src scripts tests` narrows candidates; resolve static `from` and dynamic `import()` relative specifiers to this exact file; then `rg -l -w '<symbol>' <resolved-consumer-files>` counts distinct referencing consumer files. Count excludes the defining file. Private declarations have 0 external bound consumers; their local references move with the partition. This is a file count, not call-site count; do not reuse 001's broad basename heuristic as symbol fan-in.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `CURSOR_TOOL_COUNT_LIMIT` | const | 39–39 | yes | 1 | `tool-budget.ts` |
| `CURSOR_TOOL_BYTES_LIMIT` | const | 40–40 | yes | 1 | `tool-budget.ts` |
| `CursorToolBudgetResult` | interface | 42–45 | no | 0 | `tool-budget.ts` |
| `explicitlySelectedNames` | function | 47–50 | no | 0 | `tool-budget.ts` |
| `toolPriority` | function | 52–68 | no | 0 | `tool-budget.ts` |
| `isPinnedCursorTool` | function | 70–72 | no | 0 | `tool-budget.ts` |
| `applyCursorToolBudget` | function | 79–170 | yes | 2 | `tool-budget.ts` |
| `catalogLimitNote` | function | 172–181 | no | 0 | `tool-budget.ts` |
| `cursorFastRequested` | function | 191–193 | yes | 0 | `request-builder.ts` (residual) |
| `cursorRequestEmitsFastVariant` | function | 203–208 | yes | 2 | `request-builder.ts` (residual) |
| `normalizeCursorModelId` | function | 216–248 | no | 0 | `request-builder.ts` (residual) |
| `contentPartToText` | function | 250–266 | no | 0 | `request-builder.ts` (residual) |
| `toolResultToText` | function | 268–277 | no | 0 | `request-builder.ts` (residual) |
| `contentToText` | function | 279–285 | no | 0 | `request-builder.ts` (residual) |
| `requestMessage` | function | 287–310 | no | 0 | `request-builder.ts` (residual) |
| `cursorRequestMessagesFromRaw` | function | 316–323 | yes | 2 | `request-builder.ts` (residual) |
| `generatedCursorConversationId` | function | 325–327 | yes | 0 | `request-builder.ts` (residual) |
| `cursorConversationIdFromClientThread` | function | 330–339 | yes | 0 | `request-builder.ts` (residual) |
| `resolveCursorConversationId` | function | 347–362 | yes | 0 | `request-builder.ts` (residual) |
| `cursorClientThreadOwner` | function | 364–366 | yes | 1 | `request-builder.ts` (residual) |
| `updateFramed` | function | 368–374 | no | 0 | `request-builder.ts` (residual) |
| `cursorInstructionDigest` | function | 376–384 | yes | 2 | `request-builder.ts` (residual) |
| `cursorCoveredPrefixDigest` | function | 386–394 | yes | 2 | `request-builder.ts` (residual) |
| `CreateCursorRequestOptions` | interface | 396–399 | yes | 0 | `request-builder.ts` (residual) |
| `lookupPrefixSnapshot` | function | 401–420 | no | 0 | `request-builder.ts` (residual) |
| `lineageMismatch` | function | 422–436 | no | 0 | `request-builder.ts` (residual) |
| `resolveCursorCheckpoint` | function | 438–474 | no | 0 | `request-builder.ts` (residual) |
| `createCursorRequest` | function | 476–518 | yes | 10 | `request-builder.ts` (residual) |

Resolved direct importers: 13 distinct files (2 production, 10 tests, 1 test helper). Production paths:

- `src/adapters/cursor.ts` — unchanged.
- `src/adapters/cursor/live-transport.ts` — unchanged.

## Leaf partition

All paths below are new sibling files under `src/adapters/cursor/`, following the existing kebab-case native-exec-* and protobuf-* convention. Each symbol body and attached comment moves without rewriting. Physical slice accounting includes blank lines/comments; keep slice contents in their original relative order. Expected sizes use the exact compact import/re-export lines shown; multiline formatting consumes spare budget and must be recounted, especially catalog.ts.

### `src/adapters/cursor/tool-budget.ts`

- Transfer source slices: 38–182 (145 physical lines).
- Symbols: `CURSOR_TOOL_COUNT_LIMIT`, `CURSOR_TOOL_BYTES_LIMIT`, `CursorToolBudgetResult`, `explicitlySelectedNames`, `toolPriority`, `isPinnedCursorTool`, `applyCursorToolBudget`, `catalogLimitNote`.
- Expected line count: 145 moved + 2 import lines = **147**, ≤400.
- Own imports:

```ts
import { isAllowedToolChoice, type OcxTool, type OcxToolChoice } from "../../types";
import { cursorMcpToolEncodedSize, cursorMcpToolsEncodedSize, cursorToolAllowedByChoice, cursorToolChoiceAliases, cursorStructuredEditTools, cursorToolWireName, isCursorStructuredEditToolName, isBareCodexShellBridgeTool, isCursorExecutionPathTool, isCursorWaitTool } from "./tool-definitions";
```

### Residual `src/adapters/cursor/request-builder.ts`

Retain: `cursorFastRequested`, `cursorRequestEmitsFastVariant`, `normalizeCursorModelId`, `contentPartToText`, `toolResultToText`, `contentToText`, `requestMessage`, `cursorRequestMessagesFromRaw`, `generatedCursorConversationId`, `cursorConversationIdFromClientThread`, `resolveCursorConversationId`, `cursorClientThreadOwner`, `updateFramed`, `cursorInstructionDigest`, `cursorCoveredPrefixDigest`, `CreateCursorRequestOptions`, `lookupPrefixSnapshot`, `lineageMismatch`, `resolveCursorCheckpoint`, `createCursorRequest`.

Replace original tool-definitions import block 16–28 (13 lines) with `import { cursorToolsForActivePrompt } from "./tool-definitions";` (1 line). Narrow line 10 to `import { namespacedToolName, toolChoiceAliases } from "../../types";` (same one line); do not opportunistically delete pre-existing unused toolChoiceAliases or OcxToolCall. Add one local import and one re-export below. Other imports stay.

Accounting: 518 − 145 moved − 12 net removed import lines + 1 local import lines + 1 re-export lines = **363** expected lines. All leaves plus residual total 510 = 518 original − 8 net import/export glue lines. No >400 residual and no #a/#b/#c part in this approved map. A size-policy escalation is not a hidden #b commitment; if the parent adds parts, re-plan lower-consumer leaves first and publish each intermediate residual count.

Export the existing private catalogLimitNote (172–181) from tool-budget.ts for createCursorRequest; do not re-export it from request-builder.ts. CursorToolBudgetResult remains private to the leaf; inference preserves the applyCursorToolBudget signature.

## Re-export block

Insert into the original file exactly these named lines; current exported declarations that stay local remain exported in place (`cursorFastRequested`, `cursorRequestEmitsFastVariant`, `cursorRequestMessagesFromRaw`, `generatedCursorConversationId`, `cursorConversationIdFromClientThread`, `resolveCursorConversationId`, `cursorClientThreadOwner`, `cursorInstructionDigest`, `cursorCoveredPrefixDigest`, `CreateCursorRequestOptions`, `createCursorRequest`). Do not use export-star and do not re-export newly exposed internal-only seams.

```ts
export { CURSOR_TOOL_COUNT_LIMIT, CURSOR_TOOL_BYTES_LIMIT, applyCursorToolBudget } from "./tool-budget";
```

Re-export binds nothing locally. The original needs these explicit leaf imports in addition to its retained original imports:

```ts
import { applyCursorToolBudget, catalogLimitNote } from "./tool-budget";
```

## Module-level state and cycles

No top-level let, Map, Set, WeakMap, lock, timer, or cache in this source. CURSOR_TOOL_COUNT_LIMIT (39) and CURSOR_TOOL_BYTES_LIMIT (40) move once to tool-budget.ts. selectedNames, keptSet (99), candidate arrays, and byte counters remain per invocation within the moved function; never hoist them. Thread/checkpoint stores keep their existing owners and imports in the residual. tool-budget.ts imports only ../../types and ./tool-definitions; it must not import request-builder, discovery, checkpoint-store, or images. The exported limit constants are re-exported, not recreated. Existing budget→serialization functional coupling is retained.

Read-only graph check of this planned layer's new imports found no return cycle involving `tool-budget.ts`. The stack still inherits the **L1 type-only-cycle prerequisite** documented in 110_adapters_cursor_tool_definitions.md: `src/types.ts:112 → src/types/provider.ts:701 → native-exec-desktop.ts:19 → native-exec-tools.ts:25 → tool-definitions.ts → src/types.ts`. Do not claim whole-stack type acyclicity until the parent resolves that out-of-scope prerequisite; these later leaves do not repair it. The local partition/line accounting here remains conditional on a valid L1 parent.

The leaf direction listed in Loop spec is the allowed DAG. Sibling leaves import their canonical owner directly, never this original facade. Preserve initialization order for cross-constant references. Verify both runtime and type-only edges; a typecheck alone does not prove acyclicity. Compare the resolved import graph at the parent and tip; zero new cycles and no path from any new leaf back to the original are required. Existing external-format/provenance checks remain at the same trust boundary; do not reinterpret validation while relocating it.

## Tests

Exact direct-test list from `rg -l 'adapters/cursor/request-builder' tests`, with specifier resolution to discard comments/other basenames:

- `tests/providers/cursor/cursor-default-catalog-suppression.test.ts` — **unchanged** import path and assertions.
- `tests/providers/cursor/cursor-effort-suffix.test.ts` — **unchanged** import path and assertions.
- `tests/providers/cursor/cursor-fast-tier.test.ts` — **unchanged** import path and assertions.
- `tests/providers/cursor/cursor-images.test.ts` — **unchanged** import path and assertions.
- `tests/providers/cursor/cursor-request-builder.test.ts` — **unchanged** import path and assertions.
- `tests/providers/cursor/cursor-structured-edit.test.ts` — **unchanged** import path and assertions.
- `tests/providers/cursor/cursor-tool-choice.test.ts` — **unchanged** import path and assertions.
- `tests/providers/cursor/cursor-ultra-mode.test.ts` — **unchanged** import path and assertions.
- `tests/providers/cursor/cursor-umbrella-rows.test.ts` — **unchanged** import path and assertions.
- `tests/responses/responses-state.test.ts` — **unchanged** import path and assertions.

Direct test helper (not itself a runnable test):

- `tests/helpers/adapter-conformance/wire-drivers.ts` — **unchanged**; exercised by `tests/adapters/adapter-tool-conformance.test.ts:15`.

No source-text oracle reads request-builder.ts. responses-state.test.ts imports it at :22 but its readFileSync calls read persisted state/test files, not this source; unchanged. All direct tests and the wire-drivers.ts helper below keep the original path. No retarget or scan-list changes.

Transitive source-reader exception: `tests/lab/core-lab-boundary.test.ts:69` reads each resolved source file while walking static imports/re-exports. A read-only replay of that walk from `src/server/responses/core.ts` reaches this target (413 visited files at the basis). Disposition: **unchanged**; new leaves are automatically included through named imports/re-exports, so no manual add-leaf-to-scan-list and no retarget. Never edit its PROTECTED roots (lines 20–28). At implementation time drive this guard red once with a temporary forbidden leaf edge to `../../lab/paths`, then restore and prove green; no forbidden edge may enter a commit.

In C phase, drive `tests/providers/cursor/cursor-request-builder.test.ts:524` red by temporarily replacing actual byte measurement in tool-budget.ts with a wrong value; drive :693 red by temporarily lowering execution-path priority. Restore exact implementation before green. Keep :596/:616/:641/:675 priority cases and tests/providers/cursor/cursor-structured-edit.test.ts:122/:131. No mutants now.

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
wc -l src/adapters/cursor/tool-budget.ts src/adapters/cursor/request-builder.ts
rg -n 'from "[^"]*/request-builder"' src gui/src scripts tests | wc -l
rg -l 'adapters/cursor/request-builder' tests
# Full suite: remote only; preserve pipeline failure rather than trusting tail's exit status
ssh lidge 'set -o pipefail; cd ~/ocx-ci/opencodex && git fetch origin codex/split-adapters-cursor-request-builder && git checkout -q FETCH_HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15'
```

Focused named subset (for initial tight red/green and for an exact task manifest):

```sh
bun test tests/adapters/adapter-tool-conformance.test.ts tests/providers/cursor/cursor-default-catalog-suppression.test.ts tests/providers/cursor/cursor-effort-suffix.test.ts tests/providers/cursor/cursor-fast-tier.test.ts tests/providers/cursor/cursor-images.test.ts tests/providers/cursor/cursor-request-builder.test.ts tests/providers/cursor/cursor-structured-edit.test.ts tests/providers/cursor/cursor-tool-choice.test.ts tests/providers/cursor/cursor-ultra-mode.test.ts tests/providers/cursor/cursor-umbrella-rows.test.ts tests/responses/responses-state.test.ts
```

Use the named subset for the temporary mutation checks, then the domain gate after restoration; do not rerun an unchanged passing check solely for confidence. Full suite is **never local**. Remote parent workflow must bind FETCH_HEAD/full-suite output to this exact PR head SHA, preserve a complete remote log as well as its summary, and ensure the remote checkout is exclusively owned before checkout; do not operate on unrelated dirty remote work.

Importer proof: compare the 13-file resolved importer set above at parent and tip. Existing external consumer paths stay unchanged. New leaf imports are planned internal edges, not lost callers; count them separately (tool-budget.ts newly imports tool-definitions.ts while request-builder still imports cursorToolsForActivePrompt, so tool-definitions fan-in gains one planned file at L4). The simple 002 line-count command is supporting evidence only: multiline and dynamic imports require the resolved-file check. Export-name/type identity must be checked independently. Run a resolved runtime+type import-cycle scan with available repository tooling or a read-only resolver; do not install a dependency just for this split. Review `git diff --numstat codex/split-adapters-cursor-images...HEAD` with move-aware comparison and separately record raw additions + deletions; apply the sizing escalation above, not an unrecorded exception. Require green exact-head CI rollup, not merely an empty required-check list.

## Accept criteria

1. Source basis and parent branch are recorded; every owned top-level declaration in this table has exactly one post-move owner, with identical body/signature and attached explanatory comments.
2. All current 14 exports remain importable from `src/adapters/cursor/request-builder.ts`, with the same value/reference/type identity; no new internal-only export leaks through that original path. Residual local calls are bound by explicit imports.
3. Every planned leaf is ≤400 lines and residual is ≤400 (expected 363); actual `wc -l` agrees or the exact formatting delta is recorded. No omitted #b debt.
4. Identical selected and omitted tool order, exact protobuf byte accounting, execution-path/wait pairing, synthetic-edit budgeting, and catalog-limit note text; no checkpoint or conversation identifier changes.
5. All 13 existing resolved importers remain; direct test imports/assertions and transitive source-reader semantics are preserved. Planned red mutations fail the named guards once, are removed, and the restored focused/domain checks pass with 0 failures.
6. Single-owner state allocations, allowed DAG edges, and no new runtime/type cycles are mechanically verified. Lab PROTECTED roots and optional-subsystem activation remain untouched.
7. Typecheck and privacy scan exit 0; remote-only full suite exits 0 at the exact layer SHA; exact-head CI rollup is green. No local full suite, no merge, and no unrelated changes.
8. Parent-to-tip size obeys the agreed 500-line metric or the parent explicitly resolves the documented exception/topology escalation before implementation; this draft itself is not evidence of an approved exception.

## PR

Title: `refactor(adapters-cursor): extract Cursor tool budget selection (split S04 L4/5)`

Branch: `codex/split-adapters-cursor-request-builder`. Base: `codex/split-adapters-cursor-images`. Closes: **none**.

Use every section of `.github/PULL_REQUEST_TEMPLATE.md` (Summary, Verification, Checklist); paste the stack map below into Summary. Review only this layer's parent-to-tip diff. Replace PR placeholders with actual numbers when opened; no PR is created by this draft.

| # | PR | Branch | Base | Review focus |
|---|---|---|---|---|
| 0 (105) | #TBD-S04-L0 | `codex/split-cursor-desktop-executor-contract` | `dev` | desktop-executor-contract |
| 1 | #TBD-S04-L1 | `codex/split-adapters-cursor-tool-definitions` | `codex/split-cursor-desktop-executor-contract` | tool-definitions |
| 2 | #TBD-S04-L2 | `codex/split-adapters-cursor-catalog` | `codex/split-cursor-desktop-executor-contract` | catalog |
| 3 | #TBD-S04-L3 | `codex/split-adapters-cursor-images` | `codex/split-cursor-desktop-executor-contract` | images |
| 4 | #TBD-S04-L4 | `codex/split-adapters-cursor-request-builder` | `codex/split-adapters-cursor-images` | request-builder |
| 5 | #TBD-S04-L5 | `codex/split-adapters-cursor-protobuf-events` | `codex/split-adapters-cursor-tool-definitions` | protobuf-events |

Current layer: **L4**. Parent: `codex/split-adapters-cursor-images` (#TBD-S04-L3).
Changes to parent `codex/split-adapters-cursor-images` require rebasing this layer and cascading only
through its actual dependency descendants, with exact-tip/base rechecks
(DEV-STACK-02); sibling layer numbering creates no dependency. Merge remains
parent-before-child and separately authorized, never part of this draft.
