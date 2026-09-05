# 040 — S02 providers L1/4

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Existing split implementation history; aggregate delivery pending. Original PR is not individually merged.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Loop spec

- Archetype: **pure-move**. Classification: C3 architecture planning, docs-only bounded delegation. cxc-dev §1/§5 and cxc-dev-architecture determine size, compatibility and state ownership; parent owns loop/goal/orchestration.
- Goal: separate OpenAI destination classification, preserving every historical export and observable behavior of `src/providers/openai-tiers.ts`.
- Non-goals: no model refresh, endpoint/auth-policy changes, validation redesign, caching, new runtime dependency, bug fix, generated metadata rewrite, repository-wide local test, merge, release or deployment. Existing behavior stays literal, including comments explaining it.
- Verifier: `002_layer_map.md` **Per-layer gate**, instantiated below. Current task verifies documentation only, not runtime correctness.
- Stop: this plan is complete when the inventory, ownership, exact wiring, test disposition and count ledger are consistent; execution stops only after its own tip passes the instantiated gate and records exact-head CI. Do not defer a failing layer upward.
- Escalation: any required source write outside the target/new leaf, semantic delta, new cycle, or missing gate evidence returns to the parent.

Structural decision: the 416-line module combines destination predicates with a 301-line migration area. Move destination constants/predicates into one co-located leaf; leave migration helpers, projection type and collision class together. Rejected alternatives: doing nothing/configuring cannot meet the line limit; deleting declarations would change behavior; changing all consumer imports would widen churn; a new provider framework or generic utils barrel is unnecessary. Existing `src/types.ts → src/types/*`, `src/config/*.ts`, and `src/codex/catalog.ts → src/codex/catalog/*` establish kebab-case co-located leaf convention. Keep legacy facades as explicit compatibility boundaries; no new index.ts or export-star barrel.

## Symbol inventory

Basis: `origin/dev` = `1362b1a3841b4de20177e5d65865a513dd7936c4`; docs HEAD `4cc219549`. Every range in this document is an original-source line range, not the intermediate branch's shifted coordinates. `git diff origin/dev -- src/providers/openai-tiers.ts` was empty.

Ranges were measured with `sg run --lang typescript --kind <kind> --json=compact src/providers/openai-tiers.ts`, taking column-zero export/lexical/function/interface/type-alias/class declarations. Imports are listed separately below; the inventory does not confuse nested declarations with ESM state.

Consumer count = distinct `rg -l -w '<symbol>'` files among resolved static/dynamic importers of this exact module under `src gui/src scripts tests` (`*.ts`/`*.tsx`), excluding the defining file. This is textual fan-in within the importer set, not call frequency. Private symbols have zero external import consumers; coincident names/comments elsewhere are excluded. Importer discovery starts with `rg -l 'openai-tiers' src gui/src scripts tests` and resolves each relative specifier, so other registries do not count.

| symbol | kind | lines start–end | exported? | consumers (count from rg) | target leaf |
|---|---|---|---|---:|---|
| `OPENAI_CODEX_PROVIDER_ID` | const | 6–6 | yes | 30 | openai-tiers/destination.ts (L1) |
| `LEGACY_OPENAI_MULTI_PROVIDER_ID` | const | 7–7 | yes | 3 | openai-tiers/destination.ts (L1) |
| `OPENAI_API_PROVIDER_ID` | const | 8–8 | yes | 10 | openai-tiers/destination.ts (L1) |
| `LEGACY_CHATGPT_PROVIDER_ID` | const | 9–9 | yes | 2 | openai-tiers/destination.ts (L1) |
| `CODEX_FORWARD_BASE_URL` | const | 11–11 | yes | 8 | openai-tiers/destination.ts (L1) |
| `LEGACY_OPENAI_MULTI_PREFIX` | const | 12–12 | no | 0 | residual original file |
| `canonicalCodexForwardProvider` | function | 14–21 | no | 0 | residual original file |
| `normalizedBaseUrl` | function | 23–32 | no | 0 | openai-tiers/destination.ts (L1) |
| `isCanonicalOpenAiForwardProvider` | function | 34–38 | yes | 35 | openai-tiers/destination.ts (L1) |
| `OPENAI_API_ORIGIN` | const | 40–40 | no | 0 | openai-tiers/destination.ts (L1) |
| `OPENAI_API_BASE_URL` | const | 41–41 | no | 0 | openai-tiers/destination.ts (L1) |
| `OPENAI_API_RESPONSES_URL` | const | 42–42 | no | 0 | openai-tiers/destination.ts (L1) |
| `resolvedResponsesEndpoint` | function | 53–62 | no | 0 | openai-tiers/destination.ts (L1) |
| `isOfficialOpenAiResponsesDestination` | function | 64–68 | no | 0 | openai-tiers/destination.ts (L1) |
| `supportsNativeResponsesCompactEndpoint` | function | 76–84 | yes | 2 | openai-tiers/destination.ts (L1) |
| `isOpenAiOperatedResponsesDestination` | function | 94–98 | yes | 2 | openai-tiers/destination.ts (L1) |
| `destinationDecodesNativeCompactionBlob` | function | 111–114 | yes | 1 | openai-tiers/destination.ts (L1) |
| `OpenAiTierMigrationProjection` | interface | 116–121 | yes | 0 | residual original file |
| `OpenAiTierMigrationCollisionError` | class | 123–130 | yes | 2 | residual original file |
| `managedLegacyMultiOverlay` | function | 132–152 | no | 0 | residual original file |
| `validLegacyOverlayCosts` | function | 155–168 | no | 0 | residual original file |
| `rewriteLegacyOpenAiSelectedId` | function | 170–174 | no | 0 | residual original file |
| `rewriteLegacyOpenAiModelList` | function | 176–179 | no | 0 | residual original file |
| `rewriteLegacyOpenAiCostKeys` | function | 186–201 | no | 0 | residual original file |
| `mergeLegacyOpenAiProviderRows` | function | 203–229 | no | 0 | residual original file |
| `hasKnownLegacyOpenAiReference` | function | 231–251 | no | 0 | residual original file |
| `rewriteLegacyOpenAiReferences` | function | 253–292 | no | 0 | residual original file |
| `isKnownLegacyValuePath` | function | 294–313 | no | 0 | residual original file |
| `unknownLegacyOpenAiWarnings` | function | 315–335 | no | 0 | residual original file |
| `resolvedOpenAiMode` | function | 337–354 | no | 0 | residual original file |
| `projectOpenAiTierMigration` | function | 356–416 | yes | 4 | residual original file |

## Leaf partition

NEW `src/providers/openai-tiers/destination.ts`: destination identity/classification only. Move original ranges **6–11 and 23–114** (98 lines); 101 expected lines including the following two imports and one separator. All 15 symbols listed below are owned here:

`OPENAI_CODEX_PROVIDER_ID`, `LEGACY_OPENAI_MULTI_PROVIDER_ID`, `OPENAI_API_PROVIDER_ID`, `LEGACY_CHATGPT_PROVIDER_ID`, `CODEX_FORWARD_BASE_URL`, `normalizedBaseUrl`, `isCanonicalOpenAiForwardProvider`, `OPENAI_API_ORIGIN`, `OPENAI_API_BASE_URL`, `OPENAI_API_RESPONSES_URL`, `resolvedResponsesEndpoint`, `isOfficialOpenAiResponsesDestination`, `supportsNativeResponsesCompactEndpoint`, `isOpenAiOperatedResponsesDestination`, `destinationDecodesNativeCompactionBlob`.

Own imports:

```ts
import type { OcxProviderConfig } from "../../types";
import { openaiResponsesUrl } from "../../adapters/openai-responses-url";
```

MODIFY `src/providers/openai-tiers.ts`: retain prefix at 12, canonical provider factory at 14–21, and the full migration area at 116–416. Expected residual **321 lines** using four import statements + separator + one re-export statement + separator + the 314 original retained body/blank lines (5–416 minus the 98 moved lines). No #b is needed. The migration class/type stay exported in place; the factory is private and imports destination constants directly. Physical accounting: 416 − 98 moved − 4 original header lines + 7 replacement header/separator lines = 321; preserve the original body and verify actual wc at implementation.

## Re-export block

The nine moved runtime exports remain importable from `src/providers/openai-tiers.ts`. Its three other exports (projection type, collision class, migration function) stay as their original declarations. Re-exporting does not create local bindings, so use the separate import below.

```ts
import type { CodexAccountMode, OcxConfig, OcxProviderConfig, ProviderCostOverlay } from "../types";
import { OPENAI_PROVIDER_TIER_VERSION } from "../types";
import { MAX_COST4_RATE } from "../usage/expected-prices";
import { OPENAI_CODEX_PROVIDER_ID, LEGACY_OPENAI_MULTI_PROVIDER_ID, LEGACY_CHATGPT_PROVIDER_ID, CODEX_FORWARD_BASE_URL, isCanonicalOpenAiForwardProvider } from "./openai-tiers/destination";
export { OPENAI_CODEX_PROVIDER_ID, LEGACY_OPENAI_MULTI_PROVIDER_ID, OPENAI_API_PROVIDER_ID, LEGACY_CHATGPT_PROVIDER_ID, CODEX_FORWARD_BASE_URL, isCanonicalOpenAiForwardProvider, supportsNativeResponsesCompactEndpoint, isOpenAiOperatedResponsesDestination, destinationDecodesNativeCompactionBlob } from "./openai-tiers/destination";
```

No `export type { ... }` is needed for this layer: no exported type moves.

## Module-level state and cycles

No top-level let/Map/Set/WeakMap/lock/timer exists. Top-level constants at 6–12 and 40–42 are identity strings; destination.ts owns those at 6–11 and 40–42, while residual owns LEGACY_OPENAI_MULTI_PREFIX at 12. Each has one owner. The Sets at 135, 178, 299, 316 and 415 are function-local (overlay allowlist, deduplication, known paths, warnings); they remain in their original functions and are not promoted to ESM state.

Current dependents include `src/config.ts:80`, `src/routing/health.ts:21`, `src/routing/capability.ts:14`, `src/router.ts:33` and `src/codex/catalog/parsing.ts:20` (53 resolved callers total). Current dependencies are `src/providers/openai-tiers.ts:1–4`: types, tier version, URL builder, cost ceiling. Intended direction: callers → old facade → destination leaf → URL builder/types; migration residual → destination constants/predicate. destination.ts never imports `../openai-tiers`, `config.ts` or `registry.ts`. Keeping the helper's cost shape validation with migration preserves its existing cycle-avoidance rationale at 138–140. No cycle was found for the original target in lane 013; verify no new return edge after extraction. Blast radius is one local provider feature; coupling is functional, with no shared mutable state.

## Tests

Complete resolved `rg -l` importer list under tests: seven test files plus the child fixture. All eight are **unchanged** and keep the historical module path:

- `tests/adapters/openai/openai-provider-option-migration.test.ts` — unchanged.
- `tests/adapters/openai/openai-provider-option-startup.test.ts` — unchanged.
- `tests/adapters/openai/openai-provider-option.test.ts` — unchanged.
- `tests/codex-integration/codex-convergence-account-selectors.test.ts` — unchanged.
- `tests/fixtures/openai-provider-option-migration-child.ts` — unchanged.
- `tests/responses/responses-compaction-routing.test.ts` — unchanged.
- `tests/responses/responses-compaction.test.ts` — unchanged.
- `tests/responses/responses-inbound-store-default.test.ts` — unchanged.

The child fixture dynamically imports the facade at `tests/fixtures/openai-provider-option-migration-child.ts:97`; this is a behavioral module address, not a source-text oracle. The migration test's original assertion begins at `tests/adapters/openai/openai-provider-option-migration.test.ts:36` and stays untouched.

Direct source-text oracles for `openai-tiers.ts`: **none**, confirmed by basename/full/segmented-path searches and source-read filtering (lane 013 agrees). No retarget-to-leaf or add-leaf-to-scan-list is required. `tests/lab/core-lab-boundary.test.ts:69` is the existing recursive graph source reader: unchanged, it automatically reaches destination.ts through the facade; keep PROTECTED at line 20 untouched.

Planned red-once checks: temporarily make the moved canonical predicate accept key auth or a query-bearing URL and confirm `tests/adapters/openai/openai-provider-option.test.ts:37–38` fails; restore. Perturb the moved compact endpoint predicate and drive `tests/responses/responses-compaction-routing.test.ts:154–169` red; restore and rerun. Do not weaken assertions or mutate the migration projection snapshots. No tests are run in this drafting task.

## Verification

Instantiate `002_layer_map.md` → **Per-layer gate** at this layer's exact tip. This delegated turn is docs-only: do not run these now. Remote full-suite execution, branch creation and PR publication belong to the parent/executor, not this drafting task.

```sh
bun run typecheck
bun test tests/adapters/openai/openai-provider-option.test.ts tests/adapters/openai/openai-provider-option-migration.test.ts tests/adapters/openai/openai-provider-option-startup.test.ts
bun test tests/responses/responses-compaction-routing.test.ts tests/responses/responses-compaction.test.ts tests/responses/responses-inbound-store-default.test.ts tests/codex-integration/codex-convergence-account-selectors.test.ts
bun run privacy:scan
bun test tests/lab/core-lab-boundary.test.ts
wc -l src/providers/openai-tiers/destination.ts src/providers/openai-tiers.ts
rg -n 'from "[^"]*/openai-tiers"' src gui/src scripts tests | wc -l
git diff --check
# Remote only, after parent confirms this checkout is dedicated to the layer:
ssh lidge 'cd ~/ocx-ci/opencodex && git fetch origin codex/split-providers-openai-tiers && git checkout -q FETCH_HEAD && bun install --frozen-lockfile >/dev/null && bun run test 2>&1 | tail -15'
```

The 002 grep is a trend signal, not an exact module-resolution count: it omits `./registry`, dynamic imports and type-only ownership corrections. Compare the resolved importer list as well: 53 existing callers, no call-site change. Run no repository-wide local suite. Every local focused group above must show zero failures; typecheck/privacy/diff checks must exit zero. The remote pipeline's final `tail` exit status alone is not proof of Bun success: retain the complete log and Bun exit status (pipefail or PIPESTATUS in the executor shell), exact tested commit, and pass/fail totals. Record exact-head CI rollup before claiming PR-ready. No passes are claimed here.

Static architecture verification is separate from typecheck: use the installed ast-grep import/export scan, resolve relative .ts/.tsx/index paths, include type-only edges and compare return paths to the baseline witnesses in Module-level state and cycles. Reject any new leaf-to-facade edge or new SCC; unresolved existing strict cycle constraints go back to the parent. Compare moved AST bodies/literal arrays with original spans (permit only import/export wiring, indentation, and array wrapper/spread scaffolding). Keep exported function signatures and original-path runtime export names identical.

## Accept criteria

1. Exactly one new runtime leaf is planned at the stated path; wc reports leaf ≤400 and original ≤400 (expected 101 and 321).
2. All 31 original top-level declarations appear exactly once in the inventory; every moved body matches its cited origin/dev span.
3. The nine moved runtime exports are explicitly re-exported; the three migration exports stay declared in place. All 53 legacy-path callers still resolve without edits.
4. Residual migration imports its five needed destination names explicitly; no leaf imports its facade and no new shared state/cycle is introduced.
5. All eight test/support importers retain their paths; source-reader dispositions are honored and required red-once checks are restored to green.
6. Each instantiated per-layer gate succeeds at the exact layer tip, remote full-suite exit is captured honestly, and exact-head CI evidence is attached before PR-ready.
7. The PR base and four-row stack map match this document; no merge occurs.

## PR

Title: `refactor(providers): separate OpenAI destination classification (split S02 L1/4)`

Branch: `codex/split-providers-openai-tiers`. Base: `dev`. Closes: **none**.

Use all sections of `.github/PULL_REQUEST_TEMPLATE.md` (Summary, Verification, Checklist), recording only this layer's exact-tip evidence. Review only this layer's diff. Placeholder PR numbers below are intentional planning references, not opened PRs.

| # | PR | Layer | Branch | Base | Review focus |
|---|---|---|---|---|---|
| 1 | #TBD-S02-L1 | **Current: separate OpenAI destination classification** | `codex/split-providers-openai-tiers` | `dev` | destination predicates and migration parity |
| 2 | #TBD-S02-L2 | extract private model metadata | `codex/split-providers-registry-a` | `dev` | model values and single ownership |
| 3 | #TBD-S02-L3 | extract registry contracts and primary entries | `codex/split-providers-registry-b` | `codex/split-providers-registry-a` | types, initial entries, FastWire import |
| 4 | #TBD-S02-L4 | finish ordered registry entry extraction | `codex/split-providers-registry-c` | `codex/split-providers-registry-b` | tail ordering and final size |

Base: dev — no dependency on the layers below; no cascade obligation. Publication is parent-owned; merges remain prohibited for this split train.

## P stale-check (2026-09-05, wp040)

origin/dev 4dde2db97; `git diff --stat 445742966 origin/dev -- src/providers/openai-tiers.ts` empty (416 lines). Symbol anchors 6/11/12/14/23/34/114/116/356 confirmed by sed. Base `dev` (S02 bottom). The plan's new subdirectory `src/providers/openai-tiers/` has no sibling precedent inside src/providers (all flat files); the audit decides between the subdirectory and a flat `src/providers/openai-tiers-destination.ts` sibling.

## A amendment (Boyle audit, VERDICT: PASS)

Naming adopted: flat sibling `src/providers/openai-tiers-destination.ts` (src/providers has no subdirectories; prefix grouping like alibaba-region-*.ts is the local convention). Path substitutions for execution: leaf imports become `"../types"` and `"../adapters/openai-responses-url"`; residual import + re-export become `"./openai-tiers-destination"`. Red-drive citation widened to responses-compaction-routing.test.ts:154–172. The "array wrapper/spread scaffolding" allowance at the old line 129 is void; only 003 PURE-MOVE-SIZE-01 transformations apply. Everything else in this doc stands.

## Execution record (B/C/D, 2026-09-05)

- Executor worktree: `/tmp/ocx-split-040.Q03dcg/wt` (branch `codex/split-providers-openai-tiers`, base origin/dev 4dde2db97). Executor: gpt-6-astra high (Turing, 01a06f0a-5f61-7893-8515-ca31ed11afc2).
- Commits: 73bb38781 (move: openai-tiers-destination.ts 102 lines, openai-tiers.ts 319) and 58dba9e0b (test: openai-provider-option.test.ts +13 — leaf bindings are identical to the facade re-exports; leaf does not import the facade). Diff: 3 files, +117/−99.
- Local gate: typecheck 0; focused (7 files) 179 pass / 0 fail; core-lab-boundary 17/0; privacy passed.
- Red-drives: (a) key-auth accepted → openai-provider-option.test.ts:37 fails (3/1), restored 4/0; (b) compact predicate inverted → responses-compaction-routing.test.ts:154 and :167 fail (0/2), restored 2/0.

- Adversarial diff review (Gauss, gpt-6-astra high, 01a06f0e-518b-7402-8031-bf81e930bb3a): VERDICT: PASS first round (byte-identical slices, exact reconstruction, 12 exports preserved, no leaf→facade edge via Bun.Transpiler.scanImports, 3 files).
- C receipt at 58dba9e0b: typecheck 0, focused (option + compaction-routing + lab-boundary) 0 fail, privacy 0, DIRTY 0.
- lidge full suite at 58dba9e0b: SUITE_EXIT=0, 18014 pass / 0 fail / 16 skip (/tmp/suite-split-providers-openai-tiers.log).
- PR: https://github.com/lidge-jun/opencodex/pull/3566 (base dev, head 58dba9e0b). CI rollup at record time: OPEN draft=false 58dba9e0b =1 =18 CANCELLED=1 SKIPPED=2 SUCCESS=5
