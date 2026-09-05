# 320 — S11 L1/5: src/combos/types.ts

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Existing split implementation history; aggregate delivery pending. Original PR is not individually merged.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: **pure-move**. Planning class: C3, bounded docs-only delegation; auth/provenance implementation retains C4 security care where noted below.
- Non-goals: Do not change native-alias admission, validation order/messages, whitespace normalization, default effort, target weights, or the selector persisted for a native alias.
- Goal: Move the namespace/identifier/selector primitives into one dependency-only leaf; leave alias/schema validation and normalized config construction at the existing boundary.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated in Verification below (the 000 reference to 003 is stale; 002 is authoritative).
- Stop: this delegated turn stops after writing and statically checking this plan; no source edits, tests, git mutations, orchestration, loop or goal commands. The later executor stops on any changed behavior, missing binding, cycle, oversized leaf, failing guard or basis drift. Layer execution ends only at an open PR with recorded green exact-head CI; never merge.
- Escalation: send any extra file/layer requirement or boundary change to the parent. Do not expand this layer into adjacent cleanup or add an unplanned #b.

Basis: docs HEAD `4cc219549`; source `origin/dev = 1362b1a3841b4de20177e5d65865a513dd7936c4`. All source line references below are to that source snapshot. `git diff --numstat origin/dev -- src/combos/types.ts` is empty. Lane audit: `devlog/_plan/260905_modular_debt_ledger/013_lane_providers_codex_oauth_routing.md:716`. No implementation proof is claimed here.

## Symbol inventory

Every top-level declaration is listed, including private declarations and import bindings. Inclusive start–end spans were extracted with `sg run --lang ts --kind <function_declaration|interface_declaration|type_alias_declaration|lexical_declaration> --json=compact src/combos/types.ts` and checked against `git show origin/dev:src/combos/types.ts` with numbered lines. Nested declarations are intentionally not top-level rows.

Consumers = unique **direct importing/re-exporting files**, not identifier occurrences or callers inside this module. Start from `rg -l -F 'types' src gui/src scripts tests`, inspect import/re-export clauses, resolve each relative specifier to this exact file, then intersect each named binding with `rg -l -w '<symbol>' src gui/src scripts tests`. Private declarations have zero external consumers; same-spelling symbols elsewhere are not consumers. Type-only imports count. Imported bindings themselves are local, not exports. Baseline: 19 direct files; test-only leaf imports for new identity assertions do not replace any original import.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `isCodexReasoningEffort` | import binding(s) | 1–1 | no | 0 (local imports) | residual |
| `SUPPORTED_NATIVE_OPENAI_SLUGS` | import binding(s) | 2–2 | no | 0 (local imports) | residual; identifiers.ts |
| `OcxComboConfig, OcxComboDefaultEffort, OcxComboReasoningEffortMode, OcxComboStrategy, OcxComboTarget, OcxConfig, OcxProviderConfig` | import binding(s) | 3–11 | no | 0 (local imports) | residual; identifiers.ts (only its three needed types) |
| `COMBO_NAMESPACE` | const | 13–13 | yes | 3 | `src/combos/identifiers.ts` |
| `preservesPhysicalComboProvider` | function | 15–20 | yes | 1 | `src/combos/identifiers.ts` |
| `COMBO_ID_PATTERN` | const | 22–22 | no | 0 | `src/combos/identifiers.ts` |
| `COMBO_ALIAS_PATTERN` | const | 28–28 | no | 0 | `src/combos/types.ts (residual)` |
| `NATIVE_OPENAI_FAMILY_PATTERN` | const | 30–30 | no | 0 | `src/combos/types.ts (residual)` |
| `ComboValidationIssue` | interface | 32–35 | yes | 0 | `src/combos/types.ts (residual)` |
| `NormalizedComboConfig` | interface | 37–52 | yes | 10 | `src/combos/types.ts (residual)` |
| `isNativeAliasCombo` | function | 55–61 | yes | 1 | `src/combos/identifiers.ts` |
| `targetKey` | function | 63–65 | yes | 3 | `src/combos/identifiers.ts` |
| `parseComboModelId` | function | 67–72 | yes | 1 | `src/combos/identifiers.ts` |
| `comboModelId` | function | 74–76 | yes | 3 | `src/combos/identifiers.ts` |
| `comboPublicModelId` | function | 79–82 | yes | 4 | `src/combos/identifiers.ts` |
| `comboDisabledModelId` | function | 88–93 | yes | 1 | `src/combos/identifiers.ts` |
| `comboDisabledModelSelectors` | function | 96–103 | yes | 1 | `src/combos/identifiers.ts` |
| `resolveComboId` | function | 109–123 | yes | 3 | `src/combos/identifiers.ts` |
| `comboAliasIssues` | function | 129–168 | yes | 1 | `src/combos/types.ts (residual)` |
| `ComboValidationOptions` | interface | 170–176 | yes | 0 | `src/combos/types.ts (residual)` |
| `comboConfigIssues` | function | 178–353 | yes | 2 | `src/combos/types.ts (residual)` |
| `comboConfigError` | function | 355–362 | yes | 1 | `src/combos/types.ts (residual)` |
| `normalizeComboConfig` | function | 364–382 | yes | 1 | `src/combos/types.ts (residual)` |
| `comboDefaultEffort` | function | 384–394 | yes | 1 | `src/combos/types.ts (residual)` |
| `isValidComboId` | function | 396–398 | yes | 1 | `src/combos/identifiers.ts` |
| `listComboIds` | function | 400–402 | yes | 1 | `src/combos/types.ts (residual)` |
| `listLiveComboTargetKeys` | function | 404–414 | yes | 1 | `src/combos/types.ts (residual)` |
| `getCombo` | function | 416–423 | yes | 2 | `src/combos/types.ts (residual)` |

## Leaf partition

Structural decision: The 423-line boundary mixes identifiers with schema issue collection. Reject deleting or configuring away live exports, and reject moving only comboConfigIssues: it calls isValidComboId, targetKey and comboAliasIssues, so that move alone would create a reverse import. Choose one identifiers leaf, preserving src/combos/types.ts and the existing src/combos/index.ts facade. Existing sibling names src/combos/request.ts and src/combos/resolve.ts support the short concern name identifiers.ts. Blast radius: local combo feature, with unchanged callers in config, catalog, routing and management.

Pre-change/intended map: Current: src/config.ts:50, src/combos/resolve.ts:6 and src/combos/index.ts:1 → types.ts → ../reasoning-effort, ../codex/catalog/native-models, ../types. Intended: the same callers → types.ts → identifiers.ts → native-models / shared types; types.ts retains reasoning-effort and its native-slug check. identifiers.ts never imports ./types or ./index. Existing index → types → identifiers is a compatibility path, not a new convenience barrel.

The 001 note's basename-only fanin 946 is not a usable importer count for types.ts. Path-resolved rg candidates identify 19 direct importer/re-exporter files (20 statements), not every unrelated types module. Count downstream index.ts users separately; do not migrate them.

### `src/combos/identifiers.ts` — 89 expected lines

Move source bands `src/combos/types.ts:13`–22, `src/combos/types.ts:54`–124, `src/combos/types.ts:396`–399 (85 physical lines including existing inter-declaration comments/blanks). Symbols: `COMBO_NAMESPACE`, `preservesPhysicalComboProvider`, `COMBO_ID_PATTERN`, `isNativeAliasCombo`, `targetKey`, `parseComboModelId`, `comboModelId`, `comboPublicModelId`, `comboDisabledModelId`, `comboDisabledModelSelectors`, `resolveComboId`, `isValidComboId`.

Keep existing exported declarations exported. All other private declarations stay private.

Own imports (complete):

```ts
import { SUPPORTED_NATIVE_OPENAI_SLUGS } from "../codex/catalog/native-models";
import type { OcxComboConfig, OcxComboTarget, OcxConfig } from "../types";
```

### Residual `src/combos/types.ts` — 332 expected lines

Keep these declarations: `COMBO_ALIAS_PATTERN`, `NATIVE_OPENAI_FAMILY_PATTERN`, `ComboValidationIssue`, `NormalizedComboConfig`, `comboAliasIssues`, `ComboValidationOptions`, `comboConfigIssues`, `comboConfigError`, `normalizeComboConfig`, `comboDefaultEffort`, `listComboIds`, `listLiveComboTargetKeys`, `getCombo`.

Accounting: 423 original − 85 moved − 12 replaced import/header lines + 4 explicit import lines + 1 named re-export lines + 1 separator = **332**. Each leaf estimate is its source-band count + own import lines + two header/separator lines. These are physical-line estimates using the compact exact import blocks below, not a claim of measured implementation output. Preserve comments, allow readable multiline imports, and remeasure after formatting; no file may exceed 400. No residual >400 and no #b required by file length. No #a/#b/#c parts are added in this five-layer map. Original function bodies over 50 lines remain unchanged as an explicit pure-move exception; splitting their logic is out of scope.

## Re-export block

Insert at the existing feature boundary, using named re-exports only. This is preservation of an established path, not a new internal index barrel. Re-exports create no local bindings.

```ts
export { COMBO_NAMESPACE, preservesPhysicalComboProvider, isNativeAliasCombo, targetKey, parseComboModelId, comboModelId, comboPublicModelId, comboDisabledModelId, comboDisabledModelSelectors, resolveComboId, isValidComboId } from "./identifiers";
```

Retain these current exports as declarations in the original file (not copies): `ComboValidationIssue`, `NormalizedComboConfig`, `comboAliasIssues`, `ComboValidationOptions`, `comboConfigIssues`, `comboConfigError`, `normalizeComboConfig`, `comboDefaultEffort`, `listComboIds`, `listLiveComboTargetKeys`, `getCombo`. Together with the block above this preserves the complete old type/value export set; leaf-private API is not added to the facade.

Explicit residual imports (replace the old import block):

```ts
import { isCodexReasoningEffort } from "../reasoning-effort";
import { SUPPORTED_NATIVE_OPENAI_SLUGS } from "../codex/catalog/native-models";
import type { OcxComboConfig, OcxComboDefaultEffort, OcxComboReasoningEffortMode, OcxComboStrategy, OcxComboTarget, OcxProviderConfig } from "../types";
import { COMBO_NAMESPACE, isValidComboId, targetKey } from "./identifiers";
```

## Module-level state and cycles

No top-level let, Map, Set, WeakMap, lock or flight is created here. COMBO_ID_PATTERN (22) moves to identifiers.ts; COMBO_ALIAS_PATTERN (28) and NATIVE_OPENAI_FAMILY_PATTERN (30) stay in the original. They are non-global regular expressions, not mutable shared cursors. COMBO_NAMESPACE (13) has one leaf definition. SUPPORTED_NATIVE_OPENAI_SLUGS is imported at line 2; its single owner remains src/codex/catalog/native-models.ts, even though both facade and leaf import it. The Set at line 302 and the Set in listLiveComboTargetKeys at 407 are invocation-local and stay with their functions. The tempting leaf → ./types cycle is avoided by importing Ocx types directly from ../types and moving all identifier-to-identifier callees together.

Lane 013 reported no static return-path cycle for this source. This plan's new local graph is acyclic by the dependency direction above; this is not a substitute for the executor's fresh whole-relative-graph return-path scan. Include type-only imports/re-exports, not merely runtime imports. New edges are Functional/Sequential coupling, not shared mutable Common state; preserve existing invocation ordering rather than adding locks or global owners. No leaf imports `./types` or any facade that routes back into itself. No lazy import workaround.

## Tests

Direct importer list, reproduced by `rg -l -F 'src/combos/types' tests` (all **unchanged**, including import path and existing assertions):

- `tests/codex-integration/codex-catalog.test.ts` — unchanged.

Text-oracle inventory: **none found** for this exact source path. Inspected basename/path matches and segmented `repoPath` forms for `readFileSync`, `Bun.file` and source-reader helpers, consistent with lane 013. There is therefore no source-read line to retarget and no explicit scan-list entry to add. A basename occurrence in `tests/fixtures/test-layout-expected.json` is test registration, not a source read. Generic recursive import-graph coverage is unchanged and discovers imports naturally. If implementation finds a computed/path-list source oracle not captured here, stop and extend the inventory with its exact read line before moving code; do not weaken it.

Broader unchanged behavior coverage through src/combos/index.ts: tests/codex-integration/combos.test.ts, tests/routing/combo-management-api.test.ts and tests/providers/provider-id-rewrite.test.ts. Preserve tests/codex-integration/combos.test.ts:179 (model ID spelling), :193 (native disable selectors), :205 (canonical-before-alias precedence), :869 (alias validation), :916 (ordered issue rows), and :1030 (physical combo provider). Add a moved-export identity assertion to tests/codex-integration/combos.test.ts: reuse the existing ../../src/combos public entry (add a namespace import there if needed) and import the leaf via ../../src/combos/identifiers and compare all 11 moved public values with toBe. Drive that guard red once using a temporary wrapper for comboModelId at the facade, restore the named re-export, then prove green. Do not make the behavioral tests bypass the facade.

These red-once mutations are future disposable-worktree verification steps, never persistent changes. They were not performed during drafting. Extend existing test files only; no new test file or test-layout entry is planned. `tests/lab/core-lab-boundary.test.ts` PROTECTED roots are never edited.

## Verification

Future implementation commands only; **none run in this docs-only task**. Execute against this layer's own tip, domains **codex-integration, routing, providers**, not the eventual stack top.

```sh
bun run typecheck
bun test tests/codex-integration/codex-catalog.test.ts tests/codex-integration/combos.test.ts tests/routing/combo-management-api.test.ts tests/providers/provider-id-rewrite.test.ts
bun run privacy:scan
wc -l src/combos/identifiers.ts src/combos/types.ts
rg -l -F 'combos/types' src gui/src scripts tests
# Resolve relative import/re-export paths and compare the original consumer file set.
# Full suite: lidge only, no local full-suite invocation; keep the full exit status/log.
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-combos-types && git checkout -q FETCH_HEAD && bun install --frozen-lockfile && bun run test'
```

For the 002 importer gate, the expected **existing** direct consumer set is 19: `src/codex/account-namespaces.ts`, `src/codex/catalog/aggregation.ts`, `src/codex/catalog/bundled.ts`, `src/codex/catalog/effort.ts`, `src/codex/catalog/metadata.ts`, `src/codex/catalog/parsing.ts`, `src/codex/catalog/provider-fetch.ts`, `src/codex/catalog/sync.ts`, `src/combos/failover.ts`, `src/combos/index.ts`, `src/combos/request.ts`, `src/combos/resolve.ts`, `src/config.ts`, `src/lib/state-store-registrations.ts`, `src/router.ts`, `src/server/effort-row.ts`, `src/server/fast-row.ts`, `src/server/management/model-routes.ts`, `tests/codex-integration/codex-catalog.test.ts`. The rg line above is a candidate list, not the count: same-directory imports and aliases require the path resolution described in Symbol inventory. Compare file sets, not statement counts; added leaf imports in identity tests are intentional. No original consumer migrates away from this boundary. Typecheck must still resolve every old export.

Cycle verification: repeat lane 013 SG-GRAPH using `sg run --lang ts --kind import_statement --json=compact src` and `sg run --lang ts --kind export_statement --json=compact src`; resolve relative .ts/.tsx/index targets, include type edges, and search for a return path to the original or any new leaf. Require no new return path; record the scoped graph result. Do not install a new dependency tool for this layer.

The 002 conditional Lab gate is not triggered by these planned source paths (none is src/server, src/router.ts or src/lib). If the implementation touches one of those paths, that is an expansion requiring parent approval and `bun test tests/lab/core-lab-boundary.test.ts`; keep PROTECTED unchanged. All new leaves must stay free of a transitive Lab dependency regardless.

Record red then green for the guard named in Tests, typecheck exit 0, focused tests 0 failures, privacy scan exit 0, actual per-file line counts, full-suite exit 0 on lidge, the exact tested SHA and CI rollup. The remote worktree is parent-coordinated; confirm ownership before checkout and require its tested SHA to equal the PR head. Do not mask test exit status with an unguarded tail pipeline. Revalidate after any cascade.

## Accept criteria

1. Source still matches the stated basis or the plan is refreshed for every changed symbol before extraction. The actual source diff remains at most 500 added-plus-deleted lines; otherwise escalate before publication.
2. Every inventory declaration has exactly one owner; all function bodies/signatures and constant/type definitions are moved verbatim, apart from the necessary export modifiers and import paths. No public export is renamed, deleted, wrapped or newly invented.
3. Every current export remains importable from `src/combos/types.ts`; moved values pass identity guards where applicable, and residual references are satisfied by real imports, not a re-export-only assumption.
4. Actual 1 new leaves and the residual are each ≤400 physical lines. Record counts rather than relying on these estimates. No hidden #b or unplanned source file is required.
5. Native aliases still use canonical disable selectors; alias validation keeps its exact issue order; listLiveComboTargetKeys still sees the same normalized targets.
6. State/constant ownership matches this plan; fresh relative-import graph reports no new cycle, including type-only edges, and no new Lab reachability.
7. Existing tests/imports/source guards are retained without weakening; the specified guard is demonstrated red once and restored green. All instantiated 002 gates and exact-head CI are green with recorded evidence.
8. PR uses the template, correct base and complete five-layer map. No merge, release, deployment, dependency installation on the user's running service, or unrelated code change is included.

## PR

Title: `refactor(combos): isolate combo identifiers from validation (split S11 L1/5)`

Branch: `codex/split-combos-types`. Base: `dev`. Closes: **none**.

Use `.github/PULL_REQUEST_TEMPLATE.md` with Summary, Verification and Checklist. Put the measured move size and any parent-approved exception in Summary, evidence tied to this PR head in Verification, and include the stack map below. Review this layer's diff only. PR numbers are intentionally unassigned planning placeholders, not existing PR claims.

| # | PR | Layer | Branch | Base | Review focus |
|---|---|---|---|---|---|
| 1 | #TBD-S11-L1 | **L1 — this layer** | `codex/split-combos-types` | `dev` | isolate combo identifiers from validation |
| 2 | #TBD-S11-L2 |  L2 | `codex/split-codex-subagent-defaults` | `dev` | isolate format-preserving subagent TOML lexing |
| 3 | #TBD-S11-L3 |  L3 | `codex/split-codex-cli-install-provenance` | `dev` | separate install evidence from classification |
| 4 | #TBD-S11-L4 |  L4 | `codex/split-routing-trace` | `dev` | separate trace contracts and evidence codecs |
| 5 | #TBD-S11-L5 |  L5 | `codex/split-oauth-github-copilot` | `dev` | isolate GitHub device grant transport |

Base: dev — no dependency on the layers below; no cascade obligation.

DEV-STACK-04: merges remain separately authorized; this task performs none.

## P stale-check (2026-09-05, wp320)

origin/dev 3c920af5f; combos/types.ts unchanged since 445742966 (423 lines); anchors 13/22/54/124/396/399 confirmed by sed. Base `dev` (S11 independent). The plan already names the CI-hygiene test change (identity assertion in tests/codex-integration/combos.test.ts). Executor rules: no bun run test; OCX_TEST_NO_QUEUE=1.

## A amendment (Darwin audit, GO-WITH-FIXES blockers=2 → folded)

1. Cycle gate: the executor/reviewer graph walk must include inline `import("…")` type edges (src/types/provider.ts:695/:701 at HEAD) in addition to import/export statements; compare against base — pre-existing type cycles (types → provider → mcp-config → types; types → provider → native-exec-desktop → … → tool-definitions → types) are unchanged and permitted (003 TYPE-CYCLE-01). The new leaf must not join any.
2. Size gate: acceptance criterion 1 (raw ≤500) is void; 003 PURE-MOVE-SIZE-01 binds (85 relocated lines; ≤150 non-move; audit measured ~22 before test edits).
3. Test anchors at base: alias validation starts at combos.test.ts:873 (not 869); ordered rows at :920.
Audit-verified: 28/28 inventory rows; leaf = exactly 12 declarations (11 public + COMBO_ID_PATTERN) with 2 minimal imports; residual imports exact (comboModelId/parseComboModelId/resolveComboId unused by residual); 22 exports (19 values + 3 interfaces), combos/index.ts uses named re-exports; 19 direct importer files / 20 statements; only codex-catalog.test.ts imports src/combos/types directly (type-only).

## Execution record (B/C/D, 2026-09-05)

- Executor worktree: `/tmp/ocx-split-320.whwuzf/wt` (branch `codex/split-combos-types`, base origin/dev 3c920af5f). Executor: gpt-6-astra high (Nietzsche, 01a06f8a-a1ff-71f3-9510-256f8d2dc3b2).
- Commits: 093c4efd6 (move: identifiers.ts 90, types.ts 333), aa695d933 (test: combos.test.ts +25 — 11-value identity facade vs leaf; leaf has no ./types or ./index import), 0c914bf26 (main agent: trimmed the EOF blank → identifiers.ts 89). Diff: 3 files.
- Local gate: typecheck 0; focused (combos, codex-catalog, combo-management-api, provider-id-rewrite) 372 pass / 0 fail; core-lab-boundary 17/0; privacy passed; 19 direct importers unchanged.
- Cycle gate (executor script incl. inline import() type edges): 18 files / 31 relative + 2 inline edges walked; no path returns to types.ts, index.ts or the leaf; 3 pre-existing type cycles unchanged (TYPE-CYCLE-01).
- Red-drives: (a) facade wrapper for comboModelId → identity test :1223 fails, restored; (b) comboDisabledModelSelectors broken → combos.test.ts:203 (test :193) fails, restored.

- Adversarial diff review (Avicenna, gpt-6-astra high, 01a06f8e-9394-7dd1-8738-3bf5a1227f77): VERDICT: PASS (slices exact, residual exact, 22/22 exports, index.ts 18 names intact, walk incl. inline type imports base 19/34 → HEAD 20/38 with no new cycle, test non-tautological).
- lidge full suite at 0c914bf26: SUITE_EXIT=0, 18067 pass / 0 fail / 16 skip (/tmp/suite-split-320.log).
- PR: https://github.com/lidge-jun/opencodex/pull/3594 (base dev, head 0c914bf26). CI rollup at record time: OPEN draft=false 0c914bf26 =1 =9 SKIPPED=2 SUCCESS=17
