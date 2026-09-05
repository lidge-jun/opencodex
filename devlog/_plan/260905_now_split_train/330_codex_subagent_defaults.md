# 330 — S11 L2/5: src/codex/subagent-defaults.ts

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Deferred before implementation; archival proposal only.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: **pure-move**. Planning class: C3, bounded docs-only delegation; auth/provenance implementation retains C4 security care where noted below.
- Non-goals: No TOML parser replacement, reserialization, generic utility reuse, marker changes, overwrite-policy changes or function-body cleanup. Keep comments, unknown keys, CRLF/LF choice and original bytes on rejection.
- Goal: Extract physical-line scanning, TOML key decoding and scalar string encoding into a pure source leaf while retaining managed-ownership analysis and the transform at the original path.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated in Verification below (the 000 reference to 003 is stale; 002 is authoritative).
- Stop: this delegated turn stops after writing and statically checking this plan; no source edits, tests, git mutations, orchestration, loop or goal commands. The later executor stops on any changed behavior, missing binding, cycle, oversized leaf, failing guard or basis drift. Layer execution ends only at an open PR with recorded green exact-head CI; never merge.
- Escalation: send any extra file/layer requirement or boundary change to the parent. Do not expand this layer into adjacent cleanup or add an unplanned #b.

Basis: docs HEAD `4cc219549`; source `origin/dev = 1362b1a3841b4de20177e5d65865a513dd7936c4`. All source line references below are to that source snapshot. `git diff --numstat origin/dev -- src/codex/subagent-defaults.ts` is empty. Lane audit: `devlog/_plan/260905_modular_debt_ledger/013_lane_providers_codex_oauth_routing.md:546`. No implementation proof is claimed here.

## Symbol inventory

Every top-level declaration is listed, including private declarations and import bindings. Inclusive start–end spans were extracted with `sg run --lang ts --kind <function_declaration|interface_declaration|type_alias_declaration|lexical_declaration> --json=compact src/codex/subagent-defaults.ts` and checked against `git show origin/dev:src/codex/subagent-defaults.ts` with numbered lines. Nested declarations are intentionally not top-level rows.

Consumers = unique **direct importing/re-exporting files**, not identifier occurrences or callers inside this module. Start from `rg -l -F 'subagent-defaults' src gui/src scripts tests`, inspect import/re-export clauses, resolve each relative specifier to this exact file, then intersect each named binding with `rg -l -w '<symbol>' src gui/src scripts tests`. Private declarations have zero external consumers; same-spelling symbols elsewhere are not consumers. Type-only imports count. Imported bindings themselves are local, not exports. Baseline: 6 direct files; test-only leaf imports for new identity assertions do not replace any original import.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `MANAGED_SUBAGENT_DEFAULT_MARKER` | const | 10–10 | yes | 5 | `src/codex/subagent-defaults.ts (residual)` |
| `MANAGED_AGENTS_TABLE_MARKER` | const | 11–11 | yes | 5 | `src/codex/subagent-defaults.ts (residual)` |
| `ManagedSubagentDefaultKey` | type alias | 13–15 | yes | 0 | `src/codex/subagent-defaults.ts (residual)` |
| `ManagedSubagentDefaults` | interface | 17–20 | yes | 1 | `src/codex/subagent-defaults.ts (residual)` |
| `ManagedSubagentDefaultsConflict` | interface | 22–26 | yes | 0 | `src/codex/subagent-defaults.ts (residual)` |
| `ManagedSubagentDefaultsTransformResult` | type alias | 28–41 | yes | 0 | `src/codex/subagent-defaults.ts (residual)` |
| `SourceLine` | interface | 43–48 | no | 0 | `src/codex/subagent-defaults-source.ts` |
| `TargetDefinition` | interface | 50–54 | no | 0 | `src/codex/subagent-defaults.ts (residual)` |
| `TomlShape` | interface | 56–61 | no | 0 | `src/codex/subagent-defaults.ts (residual)` |
| `TARGET_KEYS` | const | 63–66 | no | 0 | `src/codex/subagent-defaults.ts (residual)` |
| `splitSourceLines` | function | 68–87 | no | 0 | `src/codex/subagent-defaults-source.ts` |
| `MultilineStringKind` | type alias | 89–89 | no | 0 | `src/codex/subagent-defaults-source.ts` |
| `markStructuralLines` | function | 96–170 | no | 0 | `src/codex/subagent-defaults-source.ts` |
| `joinSourceLines` | function | 172–174 | no | 0 | `src/codex/subagent-defaults-source.ts` |
| `dominantEol` | function | 176–184 | no | 0 | `src/codex/subagent-defaults-source.ts` |
| `decodeTomlBasicKey` | function | 187–209 | no | 0 | `src/codex/subagent-defaults-source.ts` |
| `canonicalKeySegment` | function | 211–215 | no | 0 | `src/codex/subagent-defaults-source.ts` |
| `KEY_SEGMENT` | const | 217–217 | no | 0 | `src/codex/subagent-defaults-source.ts` |
| `EXACT_TABLE_HEADER` | const | 218–218 | no | 0 | `src/codex/subagent-defaults.ts (residual)` |
| `ARRAY_TABLE_HEADER` | const | 219–219 | no | 0 | `src/codex/subagent-defaults.ts (residual)` |
| `DOTTED_TABLE_HEADER` | const | 220–220 | no | 0 | `src/codex/subagent-defaults.ts (residual)` |
| `KEY_ASSIGNMENT` | const | 221–221 | no | 0 | `src/codex/subagent-defaults.ts (residual)` |
| `DOTTED_ASSIGNMENT` | const | 222–222 | no | 0 | `src/codex/subagent-defaults.ts (residual)` |
| `ANY_TABLE_HEADER` | const | 223–223 | no | 0 | `src/codex/subagent-defaults.ts (residual)` |
| `exactAgentsHeader` | function | 225–229 | no | 0 | `src/codex/subagent-defaults.ts (residual)` |
| `arrayAgentsHeader` | function | 231–235 | no | 0 | `src/codex/subagent-defaults.ts (residual)` |
| `dottedAgentsHeader` | function | 237–242 | no | 0 | `src/codex/subagent-defaults.ts (residual)` |
| `isAnyTableHeader` | function | 244–246 | no | 0 | `src/codex/subagent-defaults.ts (residual)` |
| `assignmentKeyAt` | function | 248–252 | no | 0 | `src/codex/subagent-defaults.ts (residual)` |
| `markerLine` | function | 254–256 | no | 0 | `src/codex/subagent-defaults.ts (residual)` |
| `targetKeyAt` | function | 258–264 | no | 0 | `src/codex/subagent-defaults.ts (residual)` |
| `dottedAssignmentAt` | function | 266–274 | no | 0 | `src/codex/subagent-defaults.ts (residual)` |
| `dottedTargetAt` | function | 276–282 | no | 0 | `src/codex/subagent-defaults.ts (residual)` |
| `analyzeToml` | function | 284–366 | no | 0 | `src/codex/subagent-defaults.ts (residual)` |
| `quotedTomlString` | function | 368–373 | no | 0 | `src/codex/subagent-defaults-source.ts` |
| `containsLoneSurrogate` | function | 375–387 | no | 0 | `src/codex/subagent-defaults-source.ts` |
| `replaceManagedString` | function | 389–396 | no | 0 | `src/codex/subagent-defaults.ts (residual)` |
| `insertedLines` | function | 398–407 | no | 0 | `src/codex/subagent-defaults.ts (residual)` |
| `invalidInput` | function | 409–411 | no | 0 | `src/codex/subagent-defaults.ts (residual)` |
| `transformManagedSubagentDefaults` | function | 419–550 | yes | 2 | `src/codex/subagent-defaults.ts (residual)` |

## Leaf partition

Structural decision: The 550-line file has a standalone lexical layer. Reject a whole-function move of analyzeToml: it depends on ownership markers and target policy shared with the transform. Reject reusing similarly named dominantEol/canonicalKeySegment from unrelated injectors: their co-owned grammar is not this scanner's contract. Choose a zero-dependency subagent-defaults-source.ts sibling, following src/codex/prompt-text-probe.ts and other hyphenated concern siblings. Blast radius: Codex configuration feature; inject.ts remains the only production importer.

Pre-change/intended map: Current: src/codex/inject.ts:75 and five tests → subagent-defaults.ts (no imports). Intended: those callers → subagent-defaults.ts → subagent-defaults-source.ts (no imports). TARGET_KEYS, ownership markers, TomlShape, TargetDefinition, analyzeToml and transformation stay together. SourceLine moves down and is type-imported upward; the lexical leaf never imports the facade or policy types.

The leaf's eleven declarations are currently private and have zero external import consumers. Only eight become named leaf exports for production residual imports; markStructuralLines, MultilineStringKind and decodeTomlBasicKey remain leaf-private. All seven existing public declarations remain verbatim in the original file.

### `src/codex/subagent-defaults-source.ts` — 180 expected lines

Move source bands `src/codex/subagent-defaults.ts:43`–49, `src/codex/subagent-defaults.ts:68`–217, `src/codex/subagent-defaults.ts:368`–388 (178 physical lines including existing inter-declaration comments/blanks). Symbols: `SourceLine`, `splitSourceLines`, `MultilineStringKind`, `markStructuralLines`, `joinSourceLines`, `dominantEol`, `decodeTomlBasicKey`, `canonicalKeySegment`, `KEY_SEGMENT`, `quotedTomlString`, `containsLoneSurrogate`.

Keep existing exported declarations exported. Add the `export` modifier (without changing a body/signature) only to these formerly private declarations needed by another production module: `SourceLine`, `splitSourceLines`, `joinSourceLines`, `dominantEol`, `canonicalKeySegment`, `KEY_SEGMENT`, `quotedTomlString`, `containsLoneSurrogate`. Every other private declaration stays private; none of the new internal exports is added to the facade.

Own imports (complete):

```ts
// None: this leaf has no imports.
```

### Residual `src/codex/subagent-defaults.ts` — 375 expected lines

Keep these declarations: `MANAGED_SUBAGENT_DEFAULT_MARKER`, `MANAGED_AGENTS_TABLE_MARKER`, `ManagedSubagentDefaultKey`, `ManagedSubagentDefaults`, `ManagedSubagentDefaultsConflict`, `ManagedSubagentDefaultsTransformResult`, `TargetDefinition`, `TomlShape`, `TARGET_KEYS`, `EXACT_TABLE_HEADER`, `ARRAY_TABLE_HEADER`, `DOTTED_TABLE_HEADER`, `KEY_ASSIGNMENT`, `DOTTED_ASSIGNMENT`, `ANY_TABLE_HEADER`, `exactAgentsHeader`, `arrayAgentsHeader`, `dottedAgentsHeader`, `isAnyTableHeader`, `assignmentKeyAt`, `markerLine`, `targetKeyAt`, `dottedAssignmentAt`, `dottedTargetAt`, `analyzeToml`, `replaceManagedString`, `insertedLines`, `invalidInput`, `transformManagedSubagentDefaults`.

Accounting: 550 original − 178 moved − 0 replaced import/header lines + 2 explicit import lines + 0 named re-export lines + 1 separator = **375**. Each leaf estimate is its source-band count + own import lines + two header/separator lines. These are physical-line estimates using the compact exact import blocks below, not a claim of measured implementation output. Preserve comments, allow readable multiline imports, and remeasure after formatting; no file may exceed 400. No residual >400 and no #b required by file length. No #a/#b/#c parts are added in this five-layer map. Original function bodies over 50 lines remain unchanged as an explicit pure-move exception; splitting their logic is out of scope.

## Re-export block

Insert at the existing feature boundary, using named re-exports only. This is preservation of an established path, not a new internal index barrel. Re-exports create no local bindings.

```ts
// No public declaration moves in this layer; add no re-export statements.
```

Retain these current exports as declarations in the original file (not copies): `MANAGED_SUBAGENT_DEFAULT_MARKER`, `MANAGED_AGENTS_TABLE_MARKER`, `ManagedSubagentDefaultKey`, `ManagedSubagentDefaults`, `ManagedSubagentDefaultsConflict`, `ManagedSubagentDefaultsTransformResult`, `transformManagedSubagentDefaults`. Together with the block above this preserves the complete old type/value export set; leaf-private API is not added to the facade.

Explicit residual imports (add alongside any unchanged original imports):

```ts
import { splitSourceLines, joinSourceLines, dominantEol, canonicalKeySegment, KEY_SEGMENT, quotedTomlString, containsLoneSurrogate } from "./subagent-defaults-source";
import type { SourceLine } from "./subagent-defaults-source";
```

## Module-level state and cycles

No module-level let, Map, Set, WeakMap, lock or flight. TARGET_KEYS at 63–66 stays in the residual as the sole readonly target-policy array. KEY_SEGMENT at 217 moves with canonicalKeySegment; regexes at 218–223 stay and import KEY_SEGMENT. Source scanner state multiline/squareDepth/curlyDepth (97–99) remains invocation-local. analyzeToml's definitions Map at 315 and transform's desired Map at 449 remain per invocation in the residual. No new cache or shared parser instance. Moving SourceLine and all scalar encoders together avoids even a type-only leaf → facade return edge.

Lane 013 reported no static return-path cycle for this source. This plan's new local graph is acyclic by the dependency direction above; this is not a substitute for the executor's fresh whole-relative-graph return-path scan. Include type-only imports/re-exports, not merely runtime imports. New edges are Functional/Sequential coupling, not shared mutable Common state; preserve existing invocation ordering rather than adding locks or global owners. No leaf imports `./subagent-defaults` or any facade that routes back into itself. No lazy import workaround.

## Tests

Direct importer list, reproduced by `rg -l -F 'src/codex/subagent-defaults' tests` (all **unchanged**, including import path and existing assertions):

- `tests/codex-integration/codex-inject-integration.test.ts` — unchanged.
- `tests/codex-integration/codex-inject.test.ts` — unchanged.
- `tests/codex-integration/codex-journal.test.ts` — unchanged.
- `tests/codex-integration/codex-sync-api.test.ts` — unchanged.
- `tests/routing/subagent-defaults.test.ts` — unchanged.

Text-oracle inventory: **none found** for this exact source path. Inspected basename/path matches and segmented `repoPath` forms for `readFileSync`, `Bun.file` and source-reader helpers, consistent with lane 013. There is therefore no source-read line to retarget and no explicit scan-list entry to add. A basename occurrence in `tests/fixtures/test-layout-expected.json` is test registration, not a source read. Generic recursive import-graph coverage is unchanged and discovers imports naturally. If implementation finds a computed/path-list source oracle not captured here, stop and extend the inventory with its exact read line before moving code; do not weaken it.

All existing test imports remain unchanged. In particular tests/routing/subagent-defaults.test.ts:39 must retain exact comment/sibling/table ordering, :61 CRLF preservation, :231 escaped-key recognition, :262 escaped table names, :275 nested arrays and :294 multiline arrays. No public exports move in this layer, so no vacuous facade identity test is added. The existing CRLF guard at :61 is the red-once guard for this extraction: temporarily make dominantEol return LF for a CRLF fixture in the leaf, observe that focused test fail, restore its original body, then verify green. Keep markStructuralLines and scalar Unicode tests reachable through transformManagedSubagentDefaults; do not export scanner internals through the public facade for tests.

These red-once mutations are future disposable-worktree verification steps, never persistent changes. They were not performed during drafting. Extend existing test files only; no new test file or test-layout entry is planned. `tests/lab/core-lab-boundary.test.ts` PROTECTED roots are never edited.

## Verification

Future implementation commands only; **none run in this docs-only task**. Execute against this layer's own tip, domains **routing, codex-integration**, not the eventual stack top.

```sh
bun run typecheck
bun test tests/routing/subagent-defaults.test.ts tests/codex-integration/codex-inject-integration.test.ts tests/codex-integration/codex-journal.test.ts tests/codex-integration/codex-sync-api.test.ts tests/codex-integration/codex-inject.test.ts
bun run privacy:scan
wc -l src/codex/subagent-defaults-source.ts src/codex/subagent-defaults.ts
rg -l -F 'codex/subagent-defaults' src gui/src scripts tests
# Resolve relative import/re-export paths and compare the original consumer file set.
# Full suite: lidge only, no local full-suite invocation; keep the full exit status/log.
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-codex-subagent-defaults && git checkout -q FETCH_HEAD && bun install --frozen-lockfile && bun run test'
```

For the 002 importer gate, the expected **existing** direct consumer set is 6: `src/codex/inject.ts`, `tests/codex-integration/codex-inject-integration.test.ts`, `tests/codex-integration/codex-inject.test.ts`, `tests/codex-integration/codex-journal.test.ts`, `tests/codex-integration/codex-sync-api.test.ts`, `tests/routing/subagent-defaults.test.ts`. The rg line above is a candidate list, not the count: same-directory imports and aliases require the path resolution described in Symbol inventory. Compare file sets, not statement counts; added leaf imports in identity tests are intentional. No original consumer migrates away from this boundary. Typecheck must still resolve every old export.

Cycle verification: repeat lane 013 SG-GRAPH using `sg run --lang ts --kind import_statement --json=compact src` and `sg run --lang ts --kind export_statement --json=compact src`; resolve relative .ts/.tsx/index targets, include type edges, and search for a return path to the original or any new leaf. Require no new return path; record the scoped graph result. Do not install a new dependency tool for this layer.

The 002 conditional Lab gate is not triggered by these planned source paths (none is src/server, src/router.ts or src/lib). If the implementation touches one of those paths, that is an expansion requiring parent approval and `bun test tests/lab/core-lab-boundary.test.ts`; keep PROTECTED unchanged. All new leaves must stay free of a transitive Lab dependency regardless.

Record red then green for the guard named in Tests, typecheck exit 0, focused tests 0 failures, privacy scan exit 0, actual per-file line counts, full-suite exit 0 on lidge, the exact tested SHA and CI rollup. The remote worktree is parent-coordinated; confirm ownership before checkout and require its tested SHA to equal the PR head. Do not mask test exit status with an unguarded tail pipeline. Revalidate after any cascade.

## Accept criteria

1. Source still matches the stated basis or the plan is refreshed for every changed symbol before extraction. The actual source diff remains at most 500 added-plus-deleted lines; otherwise escalate before publication.
2. Every inventory declaration has exactly one owner; all function bodies/signatures and constant/type definitions are moved verbatim, apart from the necessary export modifiers and import paths. No public export is renamed, deleted, wrapped or newly invented.
3. Every current export remains importable from `src/codex/subagent-defaults.ts`; moved values pass identity guards where applicable, and residual references are satisfied by real imports, not a re-export-only assumption.
4. Actual 1 new leaves and the residual are each ≤400 physical lines. Record counts rather than relying on these estimates. No hidden #b or unplanned source file is required.
5. Unmarked values still produce the same conflicts; malformed/ambiguous input remains byte-for-byte unchanged; quoted keys, multiline strings, nested arrays and CRLF edits remain identical.
6. State/constant ownership matches this plan; fresh relative-import graph reports no new cycle, including type-only edges, and no new Lab reachability.
7. Existing tests/imports/source guards are retained without weakening; the specified guard is demonstrated red once and restored green. All instantiated 002 gates and exact-head CI are green with recorded evidence.
8. PR uses the template, correct base and complete five-layer map. No merge, release, deployment, dependency installation on the user's running service, or unrelated code change is included.

## PR

Title: `refactor(codex): isolate format-preserving subagent TOML lexing (split S11 L2/5)`

Branch: `codex/split-codex-subagent-defaults`. Base: `dev`. Closes: **none**.

Use `.github/PULL_REQUEST_TEMPLATE.md` with Summary, Verification and Checklist. Put the measured move size and any parent-approved exception in Summary, evidence tied to this PR head in Verification, and include the stack map below. Review this layer's diff only. PR numbers are intentionally unassigned planning placeholders, not existing PR claims.

| # | PR | Layer | Branch | Base | Review focus |
|---|---|---|---|---|---|
| 1 | #TBD-S11-L1 |  L1 | `codex/split-combos-types` | `dev` | isolate combo identifiers from validation |
| 2 | #TBD-S11-L2 | **L2 — this layer** | `codex/split-codex-subagent-defaults` | `dev` | isolate format-preserving subagent TOML lexing |
| 3 | #TBD-S11-L3 |  L3 | `codex/split-codex-cli-install-provenance` | `dev` | separate install evidence from classification |
| 4 | #TBD-S11-L4 |  L4 | `codex/split-routing-trace` | `dev` | separate trace contracts and evidence codecs |
| 5 | #TBD-S11-L5 |  L5 | `codex/split-oauth-github-copilot` | `dev` | isolate GitHub device grant transport |

Base: dev — no dependency on the layers below; no cascade obligation.

DEV-STACK-04: merges remain separately authorized; this task performs none.
