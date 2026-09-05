# S04 L2/5 — catalog

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

Docs basis: `4cc219549`; source basis: `origin/dev = 1362b1a3841b4de20177e5d65865a513dd7936c4`. Every source line range below refers to `src/adapters/cursor/catalog.ts` at that source commit, not a future leaf. Read alongside 000_plan.md, 001_stale_check.md, 002_layer_map.md, and ../260905_modular_debt_ledger/014_lane_adapters_media.md (lane 014; relevant file subsection). Status: diff-level plan only; no code, Git mutation, test run, or orchestration performed by this delegate.

## Loop spec

- Archetype: **pure-move**. Work class C3 structural planning, docs-only delegated mode; the parent owns all loop/goal state.
- Goal: move the inventoried responsibilities into the named sibling leaves, each ≤400 lines, preserving the original public import path and leaving 398 expected lines in the original.
- Non-goals: no exported rename/removal, no behavior or signature change, no dependency/tooling installation, no new validation, no changes to generated protobufs, native-exec ownership, live transport scheduling, registry policy, or unrelated files. No production-module execution or test run in this drafting task.
- Verifier: 002_layer_map.md **Per-layer gate**, instantiated in Verification below. Planned commands are for the layer executor; they are not results from this draft.
- Stop: parent records an independently verified, exact-tip layer with all accepts met and exact-head CI rollup; no merge. Stop implementation immediately on a changed signature, string/wire delta, duplicated state, cycle, unaccounted source-reader, or unsupported layer-size claim.
- Escalation: source drift, required files outside this partition/test list, an actual behavior defect, or the sizing conflict below goes to the parent; do not repair it opportunistically. Unreleased security findings go only to approved scratch, never this public devlog.

Implementation sizing escalation: the move body is 322 lines (≤500 if counted once), but ordinary additions + deletions is at least 644 before glue. 002 does not define a move-discount metric. Parent must settle that metric or approve a move-only exception/revise topology before claiming the ≤500 changeset gate. This draft does not waive it.

Structural decision and pre-change map: Static capability data/types occupy lines 7–328 and need no runtime dependency. Parser, selection, and live observation code occupy 330–716. Rejected: separate parser with setters in the original would introduce a reverse dependency unless additional seams moved; unnecessary here. Chosen: catalog-data.ts owns the existing ordered table and four supporting public types, while catalog.ts retains all parsing and live evidence. Pattern matches native-exec-common.ts and native-exec-tools.ts sibling naming. Current consumers include providers/registry.ts:21 and cursor/discovery.ts:8; current boundary → claude-id (1–5). Intended graph: consumers → catalog → catalog-data and claude-id. Feature boundary preserved across provider/server/catalog callers; no consumer retarget.

No-code alternatives: doing nothing leaves the requested size debt; deletion/configuration cannot preserve these existing behaviors while shortening their implementation; reuse means moving the current declarations, not inventing equivalent helpers. Owner search: `rg --files src/adapters/cursor`, `rg -n '<symbol>' src gui/src scripts tests`, and the lane-014 seam audit. The named new siblings do not already exist. Existing stable imports are compatibility boundaries, not permission for new convenience barrels.

## Symbol inventory

AST evidence: `git show origin/dev:src/adapters/cursor/catalog.ts`; working-tree bytes compared equal; `ast-grep run --lang typescript --kind <kind> --json=compact src/adapters/cursor/catalog.ts` for lexical/variable/function/interface/type-alias/class declarations, filtered to top-level source starts. Ranges are inclusive, include an `export` modifier on the same line, and exclude preceding comments. 42 owned top-level declarations; imports are dependencies, not redeclared owned symbols.

Consumer counting: `rg -l 'catalog' src gui/src scripts tests` narrows candidates; resolve static `from` and dynamic `import()` relative specifiers to this exact file; then `rg -l -w '<symbol>' <resolved-consumer-files>` counts distinct referencing consumer files. Count excludes the defining file. Private declarations have 0 external bound consumers; their local references move with the partition. This is a file count, not call-site count; do not reuse 001's broad basename heuristic as symbol fan-in.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `CursorVariantKind` | type | 24–24 | yes | 0 | `catalog-data.ts` |
| `CursorThinkingOrder` | type | 26–26 | yes | 0 | `catalog-data.ts` |
| `CursorVariantSpec` | interface | 28–35 | yes | 0 | `catalog-data.ts` |
| `CursorCapability` | interface | 37–53 | yes | 0 | `catalog-data.ts` |
| `K` | const | 55–55 | no | 0 | `catalog-data.ts` |
| `CONTEXT_200K` | const | 56–56 | no | 0 | `catalog-data.ts` |
| `CONTEXT_256K` | const | 57–57 | no | 0 | `catalog-data.ts` |
| `CONTEXT_272K` | const | 58–58 | no | 0 | `catalog-data.ts` |
| `CONTEXT_500K` | const | 59–59 | no | 0 | `catalog-data.ts` |
| `CONTEXT_1M` | const | 60–60 | no | 0 | `catalog-data.ts` |
| `CONTEXT_GEMINI` | const | 62–62 | no | 0 | `catalog-data.ts` |
| `FULL` | const | 64–64 | no | 0 | `catalog-data.ts` |
| `T` | const | 65–65 | no | 0 | `catalog-data.ts` |
| `E` | const | 66–66 | no | 0 | `catalog-data.ts` |
| `CURSOR_CAPABILITIES` | const | 74–328 | yes | 3 | `catalog-data.ts` |
| `LEVEL_TOKENS` | const | 330–330 | no | 0 | `catalog.ts` (residual) |
| `ParsedCursorVariantId` | interface | 332–340 | yes | 0 | `catalog.ts` (residual) |
| `stripLevelSuffix` | function | 342–358 | no | 0 | `catalog.ts` (residual) |
| `REAL_1M_WIRE_IDS` | const | 371–371 | no | 0 | `catalog.ts` (residual) |
| `parseCursorVariantId` | function | 373–438 | yes | 2 | `catalog.ts` (residual) |
| `finishParse` | function | 440–443 | no | 0 | `catalog.ts` (residual) |
| `defaultKindFor` | function | 445–447 | no | 0 | `catalog.ts` (residual) |
| `upgradeToFast` | function | 458–465 | yes | 1 | `catalog.ts` (residual) |
| `cursorFastCapableBases` | function | 468–473 | yes | 3 | `catalog.ts` (residual) |
| `cursorFastIdFor` | function | 487–494 | yes | 4 | `catalog.ts` (residual) |
| `normalizeRequestedEffort` | function | 496–499 | no | 0 | `catalog.ts` (residual) |
| `codexEffortRank` | function | 501–516 | no | 0 | `catalog.ts` (residual) |
| `cursorVariantEffort` | function | 519–531 | yes | 0 | `catalog.ts` (residual) |
| `CursorResolvedSelection` | interface | 533–541 | yes | 0 | `catalog.ts` (residual) |
| `CursorLiveClaudeWireIdentity` | type | 543–543 | no | 0 | `catalog.ts` (residual) |
| `composeWireId` | function | 550–577 | no | 0 | `catalog.ts` (residual) |
| `resolveCursorSelection` | function | 587–621 | yes | 6 | `catalog.ts` (residual) |
| `liveCursorMaxModeBases` | let | 629–629 | no | 0 | `catalog.ts` (residual) |
| `liveCursorClaudeWireIdentities` | let | 630–630 | no | 0 | `catalog.ts` (residual) |
| `recordLiveCursorClaudeModels` | function | 632–640 | yes | 3 | `catalog.ts` (residual) |
| `liveCursorClaudeWireIdentitiesForTests` | function | 642–644 | yes | 1 | `catalog.ts` (residual) |
| `resetLiveCursorClaudeWireIdentitiesForTests` | function | 646–648 | yes | 2 | `catalog.ts` (residual) |
| `recordLiveCursorMaxModeModels` | function | 650–657 | yes | 2 | `catalog.ts` (residual) |
| `liveCursorMaxModeBasesForTests` | function | 659–661 | yes | 0 | `catalog.ts` (residual) |
| `CursorUmbrellaRow` | interface | 663–670 | yes | 0 | `catalog.ts` (residual) |
| `cursorGrokFastSelection` | function | 678–695 | yes | 1 | `catalog.ts` (residual) |
| `cursorUmbrellaRows` | function | 702–716 | yes | 4 | `catalog.ts` (residual) |

Resolved direct importers: 14 distinct files (7 production, 7 tests). Production paths:

- `src/adapters/cursor/discovery.ts` — unchanged.
- `src/adapters/cursor/request-builder.ts` — unchanged.
- `src/claude/model-info.ts` — unchanged.
- `src/codex/catalog/provider-fetch.ts` — unchanged.
- `src/providers/registry.ts` — unchanged.
- `src/server/index.ts` — unchanged.
- `src/server/management/agent-settings-routes.ts` — unchanged.

## Leaf partition

All paths below are new sibling files under `src/adapters/cursor/`, following the existing kebab-case native-exec-* and protobuf-* convention. Each symbol body and attached comment moves without rewriting. Physical slice accounting includes blank lines/comments; keep slice contents in their original relative order. Expected sizes use the exact compact import/re-export lines shown; multiline formatting consumes spare budget and must be recounted, especially catalog.ts.

### `src/adapters/cursor/catalog-data.ts`

- Transfer source slices: 7–328 (322 physical lines).
- Symbols: `CursorVariantKind`, `CursorThinkingOrder`, `CursorVariantSpec`, `CursorCapability`, `K`, `CONTEXT_200K`, `CONTEXT_256K`, `CONTEXT_272K`, `CONTEXT_500K`, `CONTEXT_1M`, `CONTEXT_GEMINI`, `FULL`, `T`, `E`, `CURSOR_CAPABILITIES`.
- Expected line count: 322 moved + 0 import lines = **322**, ≤400.
- Own imports: none; standard Bun/JavaScript globals are not module imports.

### Residual `src/adapters/cursor/catalog.ts`

Retain: `LEVEL_TOKENS`, `ParsedCursorVariantId`, `stripLevelSuffix`, `REAL_1M_WIRE_IDS`, `parseCursorVariantId`, `finishParse`, `defaultKindFor`, `upgradeToFast`, `cursorFastCapableBases`, `cursorFastIdFor`, `normalizeRequestedEffort`, `codexEffortRank`, `cursorVariantEffort`, `CursorResolvedSelection`, `CursorLiveClaudeWireIdentity`, `composeWireId`, `resolveCursorSelection`, `liveCursorMaxModeBases`, `liveCursorClaudeWireIdentities`, `recordLiveCursorClaudeModels`, `liveCursorClaudeWireIdentitiesForTests`, `resetLiveCursorClaudeWireIdentitiesForTests`, `recordLiveCursorMaxModeModels`, `liveCursorMaxModeBasesForTests`, `CursorUmbrellaRow`, `cursorGrokFastSelection`, `cursorUmbrellaRows`.

Keep original claude-id import lines 1–5. Move the explanatory header with the data (7–328), then insert the two local imports and two re-export lines below. This yields 398 lines; do not pad the near-limit residual with extra blank lines.

Accounting: 716 − 322 moved  + 2 local import lines + 2 re-export lines = **398** expected lines. All leaves plus residual total 720 = 716 original + 4 net import/export glue lines. No >400 residual and no #a/#b/#c part in this approved map. A size-policy escalation is not a hidden #b commitment; if the parent adds parts, re-plan lower-consumer leaves first and publish each intermediate residual count.

No private declaration becomes an inter-leaf API. Preserve even the currently unused CONTEXT_256K (57); deleting it is not part of the pure move.

## Re-export block

Insert into the original file exactly these named lines; current exported declarations that stay local remain exported in place (`ParsedCursorVariantId`, `parseCursorVariantId`, `upgradeToFast`, `cursorFastCapableBases`, `cursorFastIdFor`, `cursorVariantEffort`, `CursorResolvedSelection`, `resolveCursorSelection`, `recordLiveCursorClaudeModels`, `liveCursorClaudeWireIdentitiesForTests`, `resetLiveCursorClaudeWireIdentitiesForTests`, `recordLiveCursorMaxModeModels`, `liveCursorMaxModeBasesForTests`, `CursorUmbrellaRow`, `cursorGrokFastSelection`, `cursorUmbrellaRows`). Do not use export-star and do not re-export newly exposed internal-only seams.

```ts
export { CURSOR_CAPABILITIES } from "./catalog-data";
export type { CursorVariantKind, CursorThinkingOrder, CursorVariantSpec, CursorCapability } from "./catalog-data";
```

Re-export binds nothing locally. The original needs these explicit leaf imports in addition to its retained original imports:

```ts
import { CURSOR_CAPABILITIES } from "./catalog-data";
import type { CursorVariantKind, CursorVariantSpec } from "./catalog-data";
```

## Module-level state and cycles

`REAL_1M_WIRE_IDS` at 371 stays solely in catalog.ts with parseCursorVariantId. Both top-level mutable bindings stay in catalog.ts: `liveCursorMaxModeBases` (629; ReadonlySet initialized with new Set) and `liveCursorClaudeWireIdentities` (630; ReadonlyMap initialized with new Map). Their setters/getters/reset (632–661) and resolver reads (609, 618) remain colocated. The exported CURSOR_CAPABILITIES object (74–328), FULL array (64), and context constants have a single catalog-data.ts allocation; retain insertion order and alias references. No timer/lock/WeakMap. The data leaf imports nothing, including no type import from catalog.ts; the four types move with it. This prevents even a type-only catalog-data ↔ catalog cycle. Existing temporal live-observation coupling is unchanged, not replaced by a second registry or snapshot.

Read-only graph check of this planned layer's new imports found no return cycle involving `catalog-data.ts`. The stack still inherits the **L1 type-only-cycle prerequisite** documented in 110_adapters_cursor_tool_definitions.md: `src/types.ts:112 → src/types/provider.ts:701 → native-exec-desktop.ts:19 → native-exec-tools.ts:25 → tool-definitions.ts → src/types.ts`. Do not claim whole-stack type acyclicity until the parent resolves that out-of-scope prerequisite; these later leaves do not repair it. The local partition/line accounting here remains conditional on a valid L1 parent.

The leaf direction listed in Loop spec is the allowed DAG. Sibling leaves import their canonical owner directly, never this original facade. Preserve initialization order for cross-constant references. Verify both runtime and type-only edges; a typecheck alone does not prove acyclicity. Compare the resolved import graph at the parent and tip; zero new cycles and no path from any new leaf back to the original are required. Existing external-format/provenance checks remain at the same trust boundary; do not reinterpret validation while relocating it.

## Tests

Exact direct-test list from `rg -l 'adapters/cursor/catalog' tests`, with specifier resolution to discard comments/other basenames:

- `tests/providers/cursor/cursor-catalog.test.ts` — **unchanged** import path and assertions.
- `tests/providers/cursor/cursor-display-names.test.ts` — **unchanged** import path and assertions.
- `tests/providers/cursor/cursor-fast-listing.test.ts` — **unchanged** import path and assertions.
- `tests/providers/cursor/cursor-fast-tier.test.ts` — **unchanged** import path and assertions.
- `tests/providers/cursor/cursor-static-catalog.test.ts` — **unchanged** import path and assertions.
- `tests/providers/cursor/cursor-umbrella-rows.test.ts` — **unchanged** import path and assertions.
- `tests/providers/cursor/cursor-uncallable-quarantine.test.ts` — **unchanged** import path and assertions.

No source-text oracle for catalog.ts was found. Tests that call the legacy effort-map an oracle are behavioral wire-id comparisons, not readFileSync/Bun.file source readers. All seven direct test importers below remain unchanged; no retarget or scan-list additions.

Transitive source-reader exception: `tests/lab/core-lab-boundary.test.ts:69` reads each resolved source file while walking static imports/re-exports. A read-only replay of that walk from `src/server/responses/core.ts` reaches this target (413 visited files at the basis). Disposition: **unchanged**; new leaves are automatically included through named imports/re-exports, so no manual add-leaf-to-scan-list and no retarget. Never edit its PROTECTED roots (lines 20–28). At implementation time drive this guard red once with a temporary forbidden leaf edge to `../../lab/paths`, then restore and prove green; no forbidden edge may enter a commit.

In C phase, drive `tests/providers/cursor/cursor-catalog.test.ts:189` red by temporarily changing the Opus 5 fast ladder in catalog-data.ts; drive `:214` red by temporarily changing kimi-k3 maxModeVerified. Restore the exact table, then run all listed tests. Preserve live-reset identity assertion at :121 and live-evidence assertion at :223.

No test file is added by this plan, hence no test-layout manifest change. If extra regression coverage proves necessary, extend the existing focused files first and report scope expansion instead of silently creating new tests.

## Verification

Instantiate 002's Per-layer gate in this layer's dedicated worktree, not in the docs worktree. Nothing in this code fence was run by the drafting delegate.

```sh
bun run typecheck
# Focused domain: providers/cursor (includes the direct Cursor tests listed above)
bun test tests/providers/cursor

# Transitive source-graph guard; justified even though only adapters files move
bun test tests/lab/core-lab-boundary.test.ts
bun run privacy:scan
wc -l src/adapters/cursor/catalog-data.ts src/adapters/cursor/catalog.ts
rg -n 'from "[^"]*/catalog"' src gui/src scripts tests | wc -l
rg -l 'adapters/cursor/catalog' tests
# Full suite: remote only; preserve pipeline failure rather than trusting tail's exit status
ssh lidge 'set -o pipefail; cd ~/ocx-ci/opencodex && git fetch origin codex/split-adapters-cursor-catalog && git checkout -q FETCH_HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15'
```

Focused named subset (for initial tight red/green and for an exact task manifest):

```sh
bun test tests/providers/cursor/cursor-catalog.test.ts tests/providers/cursor/cursor-display-names.test.ts tests/providers/cursor/cursor-fast-listing.test.ts tests/providers/cursor/cursor-fast-tier.test.ts tests/providers/cursor/cursor-request-builder.test.ts tests/providers/cursor/cursor-static-catalog.test.ts tests/providers/cursor/cursor-umbrella-rows.test.ts tests/providers/cursor/cursor-uncallable-quarantine.test.ts
```

Use the named subset for the temporary mutation checks, then the domain gate after restoration; do not rerun an unchanged passing check solely for confidence. Full suite is **never local**. Remote parent workflow must bind FETCH_HEAD/full-suite output to this exact PR head SHA, preserve a complete remote log as well as its summary, and ensure the remote checkout is exclusively owned before checkout; do not operate on unrelated dirty remote work.

Importer proof: compare the 14-file resolved importer set above at parent and tip. Existing external consumer paths stay unchanged. New leaf imports are planned internal edges, not lost callers; count them separately. The simple 002 line-count command is supporting evidence only: multiline and dynamic imports require the resolved-file check. Export-name/type identity must be checked independently. Run a resolved runtime+type import-cycle scan with available repository tooling or a read-only resolver; do not install a dependency just for this split. Review `git diff --numstat codex/split-cursor-desktop-executor-contract...HEAD` with move-aware comparison and separately record raw additions + deletions; apply the sizing escalation above, not an unrecorded exception. Require green exact-head CI rollup, not merely an empty required-check list.

## Accept criteria

1. Source basis and parent branch are recorded; every owned top-level declaration in this table has exactly one post-move owner, with identical body/signature and attached explanatory comments.
2. All current 21 exports remain importable from `src/adapters/cursor/catalog.ts`, with the same value/reference/type identity; no new internal-only export leaks through that original path. Residual local calls are bound by explicit imports.
3. Every planned leaf is ≤400 lines and residual is ≤400 (expected 398); actual `wc -l` agrees or the exact formatting delta is recorded. No omitted #b debt.
4. Object key order, all effort arrays, default variants, quarantines, windows, wirePrefix values, and live-state singletons are identical; old aliases and Max Mode evidence semantics remain unchanged.
5. All 14 existing resolved importers remain; direct test imports/assertions and transitive source-reader semantics are preserved. Planned red mutations fail the named guards once, are removed, and the restored focused/domain checks pass with 0 failures.
6. Single-owner state allocations, allowed DAG edges, and no new runtime/type cycles are mechanically verified. Lab PROTECTED roots and optional-subsystem activation remain untouched.
7. Typecheck and privacy scan exit 0; remote-only full suite exits 0 at the exact layer SHA; exact-head CI rollup is green. No local full suite, no merge, and no unrelated changes.
8. Parent-to-tip size obeys the agreed 500-line metric or the parent explicitly resolves the documented exception/topology escalation before implementation; this draft itself is not evidence of an approved exception.

## PR

Title: `refactor(adapters-cursor): isolate static Cursor capability data (split S04 L2/5)`

Branch: `codex/split-adapters-cursor-catalog`. Base: `codex/split-cursor-desktop-executor-contract`. Closes: **none**.

Use every section of `.github/PULL_REQUEST_TEMPLATE.md` (Summary, Verification, Checklist); paste the stack map below into Summary. Review only this layer's parent-to-tip diff. Replace PR placeholders with actual numbers when opened; no PR is created by this draft.

| # | PR | Branch | Base | Review focus |
|---|---|---|---|---|
| 0 (105) | #TBD-S04-L0 | `codex/split-cursor-desktop-executor-contract` | `dev` | desktop-executor-contract |
| 1 | #TBD-S04-L1 | `codex/split-adapters-cursor-tool-definitions` | `codex/split-cursor-desktop-executor-contract` | tool-definitions |
| 2 | #TBD-S04-L2 | `codex/split-adapters-cursor-catalog` | `codex/split-cursor-desktop-executor-contract` | catalog |
| 3 | #TBD-S04-L3 | `codex/split-adapters-cursor-images` | `codex/split-cursor-desktop-executor-contract` | images |
| 4 | #TBD-S04-L4 | `codex/split-adapters-cursor-request-builder` | `codex/split-adapters-cursor-images` | request-builder |
| 5 | #TBD-S04-L5 | `codex/split-adapters-cursor-protobuf-events` | `codex/split-adapters-cursor-tool-definitions` | protobuf-events |

Current layer: **L2**. Parent: `codex/split-cursor-desktop-executor-contract` (#TBD-S04-L0).
Changes to parent `codex/split-cursor-desktop-executor-contract` require rebasing this layer and cascading only
through its actual dependency descendants, with exact-tip/base rechecks
(DEV-STACK-02); sibling layer numbering creates no dependency. Merge remains
parent-before-child and separately authorized, never part of this draft.
