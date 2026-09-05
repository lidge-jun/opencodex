# 160 — S05 L1: xAI schema analysis

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Existing split implementation history; aggregate delivery pending. Original PR is not individually merged.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: **pure-move**; C3 boundary planning, docs-only delegated work. Source basis `origin/dev:1362b1a38`; docs HEAD `4cc219549`. Inputs: 000, 001, 002 S05 row, and `../260905_modular_debt_ledger/014_lane_adapters_media.md` xAI section.
- Goal: reduce `src/adapters/xai-tool-schema.ts` from 436 to an expected 351 lines by moving provider-local pointer/value analysis to one 87-line leaf; all four existing public exports retain identity and original import paths.
- Non-goals: no schema-policy changes, budget changes, new validation, helper renames, provider host changes, generic schema library, function-body refactors, or code/test/git mutation in this drafting task.
- Structural decision: callers currently enter the one schema module. `src/adapters/openai-chat.ts:32`, `src/adapters/openai-responses.ts:25`, and `src/server/responses/core.ts:37` consume it; its only import is `../types` at source line 1. Split existing pure primitives, keeping orchestration/budgets in place. Reject doing nothing (436 >400) and a generic reuse/substitution (other schema compilers carry different policy). Consequence: callers → existing schema boundary → dependency-free analysis leaf; feature-local blast radius, zero caller migration.
- Verifier: 002 **Per-layer gate**, instantiated below, plus unchanged schema fixtures and source-body comparison.
- Stop: executor records passing gates and open exact-head green L1 PR; never merge. This delegation stops after the assigned document is written and statically checked.
- Escalation: source drift, an oracle not listed below, a new cycle, changed schema semantics, >400 residual/leaf, or >500 changed source lines requires parent reconciliation. No orchestration/loop/goal commands here.

## Symbol inventory

All source ranges below refer to `origin/dev` = `1362b1a3841b4de20177e5d65865a513dd7936c4`, not the docs HEAD. In-memory Babel TypeScript AST enumeration of `git show origin/dev:src/adapters/xai-tool-schema.ts` supplies inclusive declaration ranges (comments before declarations excluded). Every top-level definition is listed; import bindings are covered separately by the leaf import blocks.

Consumer counts are distinct external files importing that exact symbol from the original module, not textual occurrences or calls. Reproduce candidates with `rg -l 'xai-tool-schema' src gui/src scripts tests -g '*.ts' -g '*.tsx'`, resolve relative import paths, then match imported names. This excludes unrelated same-basename modules and generic words such as `usage`; private definitions have zero external importers. There are 3 direct importer files and 29 definitions.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `isSchemaObject` | function | 3–5 | no | 0 | `src/adapters/xai-schema-analysis.ts` |
| `isXaiSchemaTarget` | function | 7–15 | yes | 2 | `src/adapters/xai-tool-schema.ts (residual)` |
| `XaiToolSchemaCompatibilityError` | class | 18–18 | yes | 2 | `src/adapters/xai-tool-schema.ts (residual)` |
| `stringRequiredFields` | function | 20–24 | no | 0 | `src/adapters/xai-tool-schema.ts (residual)` |
| `XAI_VARIANT_MERGE_KEYS` | const | 27–37 | no | 0 | `src/adapters/xai-tool-schema.ts (residual)` |
| `XAI_MAX_SCHEMA_DEPTH` | const | 46–46 | no | 0 | `src/adapters/xai-tool-schema.ts (residual)` |
| `XAI_MAX_SCHEMA_NODES` | const | 47–47 | no | 0 | `src/adapters/xai-tool-schema.ts (residual)` |
| `XAI_MAX_ROOT_VARIANTS` | const | 48–48 | no | 0 | `src/adapters/xai-tool-schema.ts (residual)` |
| `XaiSchemaBudget` | interface | 51–54 | no | 0 | `src/adapters/xai-tool-schema.ts (residual)` |
| `createXaiSchemaBudget` | function | 57–59 | no | 0 | `src/adapters/xai-tool-schema.ts (residual)` |
| `decodeJsonPointerToken` | function | 61–63 | no | 0 | `src/adapters/xai-schema-analysis.ts` |
| `lookupLocalJsonPointer` | function | 66–75 | yes | 1 | `src/adapters/xai-schema-analysis.ts` |
| `resolveXaiSchemaRefs` | function | 78–132 | no | 0 | `src/adapters/xai-tool-schema.ts (residual)` |
| `xaiVariantIsConcreteObject` | function | 135–138 | no | 0 | `src/adapters/xai-tool-schema.ts (residual)` |
| `variantProperties` | function | 140–142 | no | 0 | `src/adapters/xai-tool-schema.ts (residual)` |
| `xaiPropertyMergeIsLossless` | function | 150–164 | no | 0 | `src/adapters/xai-tool-schema.ts (residual)` |
| `xaiRequiredSetsMatch` | function | 166–169 | no | 0 | `src/adapters/xai-tool-schema.ts (residual)` |
| `xaiLiteralValues` | function | 172–177 | no | 0 | `src/adapters/xai-schema-analysis.ts` |
| `xaiJsonTypeOf` | function | 180–187 | no | 0 | `src/adapters/xai-schema-analysis.ts` |
| `xaiDeclaredTypes` | function | 190–196 | no | 0 | `src/adapters/xai-schema-analysis.ts` |
| `xaiTypesOverlap` | function | 199–202 | no | 0 | `src/adapters/xai-schema-analysis.ts` |
| `xaiSchemasAreProvablyDisjoint` | function | 209–226 | no | 0 | `src/adapters/xai-schema-analysis.ts` |
| `xaiSchemasArePairwiseDisjoint` | function | 229–236 | no | 0 | `src/adapters/xai-schema-analysis.ts` |
| `uniqueXaiSchemas` | function | 239–249 | no | 0 | `src/adapters/xai-tool-schema.ts (residual)` |
| `mergeXaiAdditionalProperties` | function | 251–265 | no | 0 | `src/adapters/xai-tool-schema.ts (residual)` |
| `composeXaiObjectSchemas` | function | 268–292 | no | 0 | `src/adapters/xai-tool-schema.ts (residual)` |
| `XaiRootExpansion` | interface | 295–311 | no | 0 | `src/adapters/xai-tool-schema.ts (residual)` |
| `expandXaiRootObjectSchemas` | function | 313–341 | no | 0 | `src/adapters/xai-tool-schema.ts (residual)` |
| `normalizeXaiToolParameters` | function | 370–436 | yes | 2 | `src/adapters/xai-tool-schema.ts (residual)` |

## Leaf partition

Naming reuses provider-prefixed siblings `src/adapters/ollama-native-url.ts:9` and `src/adapters/kiro-thinking.ts:1`; no index barrel or generic utils module. Original entry stays the compatibility boundary required by cxc-dev §5.

| New file | Symbols | Original source slices including attached comments/blanks | Expected physical lines |
|---|---|---|---:|
| `src/adapters/xai-schema-analysis.ts` | `isSchemaObject`, `decodeJsonPointerToken`, `lookupLocalJsonPointer`, `xaiLiteralValues`, `xaiJsonTypeOf`, `xaiDeclaredTypes`, `xaiTypesOverlap`, `xaiSchemasAreProvablyDisjoint`, `xaiSchemasArePairwiseDisjoint` | 3–6, 61–76, 171–237 | 87 |

Own imports: **none**. Export `isSchemaObject`, `lookupLocalJsonPointer`, and `xaiSchemasArePairwiseDisjoint` from the leaf for real production callers; the other six definitions stay private. This is not test-only exposure. Keep the symbol bodies and pointer decoding order verbatim.

Residual `src/adapters/xai-tool-schema.ts`: every row marked residual stays, including target detection, error class, budget definitions, ref resolver, composition, union expansion and normalizer. Arithmetic: 436 − (4 + 16 + 67) + 2 shim lines = **351**; leaf 87; aggregate 438 includes two new boundary lines. Single L1, no #b required. About 176 added/deleted source lines before metadata; verify actual diff remains ≤500.

## Re-export block

Insert exactly these boundary lines; all other existing exports remain inline:
```ts
export { lookupLocalJsonPointer } from "./xai-schema-analysis";
import { isSchemaObject, lookupLocalJsonPointer, xaiSchemasArePairwiseDisjoint } from "./xai-schema-analysis";
```
The residual retains `import type { OcxProviderConfig } from "../types";`. It calls the locally imported pointer resolver at old line 91, predicate throughout, and disjointness analysis at 419. Re-export alone binds none of them. `isXaiSchemaTarget`, `XaiToolSchemaCompatibilityError`, and `normalizeXaiToolParameters` remain their original inline exports; no wildcard, duplicate export, wrapper, or alias.

## Module-level state and cycles

- `XAI_VARIANT_MERGE_KEYS` (27–37) remains owned only by the residual; constant-by-convention Set, never copied. `XAI_MAX_SCHEMA_DEPTH` (46), `XAI_MAX_SCHEMA_NODES` (47), `XAI_MAX_ROOT_VARIANTS` (48) also remain there.
- No top-level let, Map, WeakMap, timer or lock. The budget is allocated once per tool at 372 and shared by ref resolution (373) and root expansion (379); do not recreate it inside the leaf.
- Sets in disjointness at 190–195 and 213 are invocation-local, not module state.
- Existing lane G1 found no return-path cycle. New graph: boundary → analysis; analysis has no imports. Having analysis import `isSchemaObject` back from the boundary would create a cycle, so the predicate moves with its consumers. Existing `../types` type edge stays only in the residual.
- Coupling: existing provider-format coupling remains inside this feature; new edge is functional, with no lifecycle or shared-cache edge.

## Tests

Exact original-module direct-import query:
```sh
rg -l '["\x27][^"\x27]*adapters/xai-tool-schema(\.ts)?["\x27]' tests -g '*.ts'
```
Result: **empty**. The schema suite tests through `createOpenAIChatAdapter`, not by importing this file; do not invent a direct importer.

- `tests/providers/xai/xai-tool-schema.test.ts:4` — unchanged indirect behavioral oracle. Cases at 226, 251, 301, 326, 353 and 374 cover exclusivity, required promotion, mixed nesting, variant and node budgets.
- `tests/lib/reasoning-replay-scope-source.test.ts:33` reads **openai-chat.ts**, not this file — unchanged, no retarget.
- Filename-specific source-text oracles: **none** after `rg -l 'readFileSync|Bun\\.file|readFile\\(' tests -g '*.test.ts'` candidates were filtered by this basename and inspected.
- Generic transitive source reader: `tests/lab/core-lab-boundary.test.ts:69` in `firstLabPath`, invoked at 284 onward — unchanged; follows the new static import automatically. No add-leaf-to-scan-list or retarget needed. PROTECTED at 20 remains untouched.

Drive red once during implementation, then restore: temporarily make the leaf pairwise-disjoint predicate always true and run the existing overlapping-oneOf case (test declaration 226); it must fail because a oneOf cannot become anyOf. Temporarily add a leaf→Lab static edge and confirm the transitive guard reports it, then remove it. This mutates only the disposable implementation worktree and is not part of this docs pass. Do not weaken assertions to obtain green.

## Verification

Implementation-only commands: none were run for this docs-only delegation. This instantiates `002_layer_map.md` → **Per-layer gate** (the `003` reference in 000 is stale).

```sh
bun run typecheck
bun test tests/providers/xai/xai-tool-schema.test.ts tests/lib/reasoning-replay-scope-source.test.ts
bun run privacy:scan
bun test tests/lab/core-lab-boundary.test.ts
wc -l src/adapters/xai-schema-analysis.ts src/adapters/xai-tool-schema.ts
rg -l 'from "[^"]*/xai-tool-schema"' src gui/src scripts tests
git diff --check
git diff --numstat dev...HEAD -- src tests
```

Focused domains: `tests/providers/xai`, adapter/schema compatibility, and `tests/lib` source oracle. The original-path static importer list must retain 3 unique files after exact relative-path filtering (the raw basename rg can include unrelated modules). Keep exports/types resolvable; count alone is not proof. No protected-root edits are needed; the Lab guard is included because adapters are transitively reachable. Each listed leaf and residual must be ≤400 physical lines. Compare normalized AST bodies before/after, allowing only location, import/export modifiers and required import binding changes; preserve comments and exact error/wire literals.

Run the resolved-relative-import/re-export graph walk from lane 014's G1, including type edges, at the layer tip; no return path from any new leaf to its old boundary or another leaf may appear. The Lab guard checks optional-subsystem reachability, not general cycles.

Full suite is **never local**; executor uses the existing authorized remote checkout only after verifying its ownership, with pipeline failure propagation:
```sh
ssh lidge 'bash -o pipefail -c "cd ~/ocx-ci/opencodex && git fetch origin codex/split-adapters-xai-tool-schema && git checkout -q FETCH_HEAD && git rev-parse HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15"'
```
Record remote HEAD equal to PR head, full-suite exit status and totals, local focused/typecheck/privacy results, and the complete exact-head CI rollup. A tail without the test exit status is not evidence. Re-run only invalidated checks after a lower-layer cascade; no merge/auto-merge.

## Accept criteria

1. All 29 definitions have exactly one owner matching the inventory; all moved bodies equal origin/dev modulo export modifiers.
2. The four original exports remain importable by identical names; `lookupLocalJsonPointer` resolves to the leaf binding, not a wrapper.
3. Original direct importer set remains exactly the three files listed in Loop spec; no protected-root edits.
4. One policy Set owner; one budget per normalization call; no new import cycle or Lab reachability.
5. Actual line counts ≤400 (planned leaf 87, residual 351); no #b debt; source diff ≤500.
6. Unchanged fixtures and both red probes recover to green; the instantiated local/remote/CI gates are recorded against the exact L1 head.
7. Implementation scope is original file + one leaf; existing tests remain behaviorally unchanged. Any extra production file requires escalation.

## PR

Title: `refactor(adapters): isolate xAI schema analysis (split S05 L1/3)`

Branch: `codex/split-adapters-xai-tool-schema`.

Base: dev — no dependency on the layers below; no cascade obligation.

Closes: none.

| # | PR | Layer | Branch | Base | Review focus |
|---|---|---|---|---|---|
| 1 | #TBD-S05-L1 | xAI tool schema | `codex/split-adapters-xai-tool-schema` | `dev` | Schema-analysis extraction |
| 2 | #TBD-S05-L2 | Command Code | `codex/split-adapters-command-code` | `dev` | Wire messages and single-owner workspace cache |
| 3 | #TBD-S05-L3 | Ollama native | `codex/split-adapters-ollama-native` | `dev` | Request compilation and response translation |

L1 is this PR; review only its diff. Use the repository PR template's Summary, Verification and Checklist sections, copying this stack map. Parent owns PR creation, push and approval requests; merge remains forbidden.

## P stale-check (2026-09-05, wp160)

origin/dev 24cc558d5; xai-tool-schema.ts unchanged since 445742966 (436 lines); anchors 3/6/61/76/171/237/370 confirmed by sed. Base `dev` (S05 independent). Executor rules: no bun run test; OCX_TEST_NO_QUEUE=1; CI hygiene requires a test change.

## Execution record (B/C/D, 2026-09-05)

- Executor worktree: `/tmp/ocx-split-160.sWXR9l/wt` (branch `codex/split-adapters-xai-tool-schema`, base origin/dev 24cc558d5). Executor: gpt-6-astra high (Helmholtz, 01a06f34-64cf-7152-9164-276539a08103).
- Commits: ac2be8606 (move: xai-schema-analysis.ts 86 lines, zero imports; xai-tool-schema.ts 351) and 8a404cb88 (test: xai-tool-schema.test.ts +14 — lookupLocalJsonPointer identity via both paths; pairwise-disjoint truth table; leaf has no imports). Diff: 3 files, +102/−87. Production importers unchanged (core.ts, openai-chat.ts, openai-responses.ts); the test is the only new importer.
- Local gate: typecheck 0; focused 14/0; core-lab-boundary 17/0; privacy passed.
- Red-drives: (a) pairwise-disjoint forced true → overlapping-oneOf case fails (oneOf → anyOf) plus the new leaf assertion, restored 14/0; (b) lab import in leaf → boundary chain core → xai-tool-schema → xai-schema-analysis → lab/paths, restored 17/0.

- Adversarial diff review (Popper, gpt-6-astra high, 01a06f37-65d6-7c91-b813-c364df8d01e8): VERDICT: PASS (slices exact modulo the trailing blank line, residual byte-exact, 4 exports resolve with pointer identity, leaf zero imports, test non-tautological, 3 files).
- lidge full suite at 8a404cb88: SUITE_EXIT=0, 18018 pass / 0 fail / 16 skip (/tmp/suite-split-160.log).
- PR: https://github.com/lidge-jun/opencodex/pull/3574 (base dev, head 8a404cb88). CI rollup at record time: OPEN draft=false 8a404cb88 =1 =19 SKIPPED=1 SUCCESS=5
