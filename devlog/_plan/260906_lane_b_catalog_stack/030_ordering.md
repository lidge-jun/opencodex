# 030 — Preserve configured Go efforts and separate complete picker order

Class: C3 cross-module catalog contract. One future PABCD cycle consumes this document after the model-toggle/context layers (010/020), before management (040). This cycle carries only #3571; message recovery #3568 is explicitly outside it.

## Outcome and necessity

Configured canonical `opencode-go` efforts survive generation and retained sync without injected max/ultra. A nonblank bare catalog id in `modelPickerOrder` opts into complete-picker display ordering; exact ids outrank raw/encoded equivalents. Routed-only and empty configurations retain legacy behavior. Display sorting must leave OpenCodex's natural-priority guidance candidates unchanged. Native Codex advertisements are a separate consumer and may follow the changed display order. Existing `applyReasoningLevels`, `slugEquivalenceKey`, `SPAWN_PRIORITY_FIELD`, and observed-state merge own these behaviors; reuse them, with no new catalog engine or provider roster.

## Current owners and amendment anchors

- `src/codex/catalog/sync.ts:315,358,412`: `deriveEntry` currently preserves exact combo/forward ladders, but Go uses ordinary synthetic tiers. Pass a separate `preserveExactReasoning` predicate to both derive branches; do not alter exact-combo metadata policy.
- `src/codex/catalog/effort.ts:223-247`: `preserveExact` already skips synthetic max/ultra insertion; retain this owner unchanged.
- `src/codex/catalog/sync.ts:518,654-668`: builder currently applies routed display ordering and records natural spawn priority. Reject whitespace-only entries consistently, without trimming significant ids or changing routed-only ordering.
- `src/codex/catalog/sync.ts:781,814`: add `modelPickerRank`, `applyFullModelPickerOrder`, optional order/selectors on `ObservedCatalogMergeInput`; retain the backwards-compatible wrapper at `sync.ts:1215` with empty defaults.
- `src/codex/convergence.ts:344` and `src/codex/catalog/sync.ts:1764`: both production merge callers must pass order and account selectors. A helper-only test is not proof of caller wiring.
- Retained native rows restore natural priority before recomputing featured priority; retained OCX routed rows rebuild featured rank with selector stride and reset obsolete display overrides. Apply full order only after native/routed admission and multi-agent version assignment.
- `src/codex/catalog/sync.ts:177-208`: `effectiveSubagentRoster` actually reads `opencodex_spawn_priority`, then visibility/v2 filters and the five-row cap. Inspect this consumer on every carry amendment, not only emitted priorities.
- `src/types/config.ts` documents `modelPickerOrder`; it has diverged since the source base and the previous context phase also touches this file. Apply only the comment delta, preserving the new context contract.

## Focused implementation deltas

The appendix contains the full pinned textual source delta, including complete NEW test files. Key reviewable boundaries are:

```diff
 const preserveExact = isExactComboCatalogModel(model, exactComboSlugs);
+const preserveExactReasoning = preserveExact || model?.provider === "opencode-go";
-applyReasoningLevels(entry, model?.reasoningEfforts, model?.defaultReasoningEffort, preserveExact);
+applyReasoningLevels(entry, model?.reasoningEfforts, model?.defaultReasoningEffort, preserveExactReasoning);
```

Use the same predicate in the native-template branch, preserving `codexForwardNativeCapabilityAlias !== null`. Retained merge must independently exclude `opencode-go/` from mock-max insertion while preserving the existing Reserve and exact-combo exclusions.

```diff
 const mergedModels = mergeCatalogEntriesFromObservedState({
+  modelPickerOrder,
+  accountSelectors,
   catalogModels,
```

Repeat at retained sync. Complete ordering preserves `entry[SPAWN_PRIORITY_FIELD] ?? entry.priority ?? 9`, records that natural value, and sets display priority to exact/equivalent rank or `pickerOrder.length + natural`; empty/routed-only input returns before mutation. The retained-row block must execute before final routed filtering/merge, using fresh `featured` and selector stride. Do not transplant the whole 1,800-line sync module.

## Activation and regression matrix

| Test owner | Activate | Required observation |
|---|---|---|
| NEW `tests/codex-integration/catalog-go-exact-efforts.test.ts` | Derive Go with null and native template, `[high,max]` and `[high,xhigh]`; merge both disk-only and fresh-only Muse | Exact effort/default ladders, no synthetic max for Muse; other provider still has max/ultra |
| NEW `tests/codex-integration/catalog-full-picker-order.test.ts` | Bare native id + Go routed ids, then apply twice | Specified complete display order; unchanged stored natural ranks and byte-equivalent repeated result |
| Same | Empty, whitespace-only, routed-only, raw slash upstream id plus encoded id | Legacy behavior; no whitespace activation; exact rank wins equivalence and no suffix aliasing |
| Same | Start full order, switch to empty/routed-only during provider outage; change featured order, promote/demote; zero/two selectors and nonzero picker index | Healthy and degraded rows agree on both display and spawn rank; second merge is stable; input snapshot unmutated |
| Same plus existing `codex-v2-gate.test.ts` | Change picker only while retaining configured subagent roster; use v2 eligibility | Same five OpenCodex guidance candidates and valid exact Go effort membership |
| Existing `tests/codex-integration/codex-catalog.test.ts` | Existing normalization/recovery fixtures | Existing native Reserve/exact ladders and account rows retain their contracts; align assertions only for intentional Go tier change |
| Existing `tests/test-layout.test.ts`, `tests/test-layout-tooling.test.ts` | NEW file registration | Both explicit layout map and expected fixture contain both file names in codex-integration |

Source tests cover most matrix rows. Add a production-entry convergence/retained-sync assertion to the existing catalog tests if source tests only call the helper: configure order, run each entry under fixture IO, then compare displayed ids and `effectiveSubagentRoster` before/after. Use known fixture helpers, no live service. CI commands to select this family for a focused rerun are `bun test tests/codex-integration/catalog-full-picker-order.test.ts tests/codex-integration/catalog-go-exact-efforts.test.ts tests/codex-integration/codex-catalog.test.ts tests/codex-integration/codex-v2-gate.test.ts tests/test-layout.test.ts tests/test-layout-tooling.test.ts` on a CI runner only; full required CI still applies.

## Docs, dependencies, and unresolved acceptance

- English and French `guides/model-ordering.md` must explicitly describe opt-in and migration: old lists containing previously ignored bare ids now change complete ordering. Do not introduce a pinned-native allowlist restriction: the public source contract deliberately allows new bare catalog ids.
- English provider reference adds Go efforts/config-key examples and a roster link. The source's dated endpoint claims are not independently provider-validated by this research; carry as configured examples or require fresh primary evidence before describing them as current supported roster. No provider requests are authorized here.
- Proposed SoT amendment, MODIFY `structure/03_catalog-and-subagents.md:35`: add: “Complete picker order is enabled by a nonblank bare id in modelPickerOrder. Display priority is independent of opencodex_spawn_priority; retained rows recompute natural ranks from the current featured roster and account-selector stride. Canonical opencode-go rows preserve configured reasoning ladders in generation and retained merges.” Main owns applying this documented delta in C.
- 020 → 030 shares `src/types/config.ts`; 030 → 040 shares `tests/codex-integration/codex-catalog.test.ts` and English provider reference. Coordinate one sequential integration owner; no recovery dependency on lane A's #3568.
- No dashboard JSX change in #3571. For functional UI evidence obtain isolated CI-produced catalog/model-list output and a Codex picker capture showing native-first order plus unchanged subagent list; an old author's local-release screenshot is not carried-head proof. No local build or live default service mutation.
- No newly established algorithm blocker in this read-only source review. Pending: exact-head CI, caller-level coverage, docs build gap, source-era bare-id warning disposition, and refreshed independent review. Source metadata has no guaranteed complete review-thread list; stale CodeRabbit prose is not an unresolved-thread verdict.

## Source and baseline

Read on 2026-09-06 KST in `/Users/jun/.codex/worktrees/f80e/opencodex` at `81871b3fa7034250b8d5ba2cbbfde44e40f0e69c`. Pinned source: [PR #3571](https://github.com/lidge-jun/opencodex/pull/3571), head `0a935c5694229760c8c1cd5a62072107d8ae6696`, source base `6585e6a70f42be8b6c81ff20d4fa0f39f7da03db`. Inputs are captured `.tmp/lane-b/3571.json` and `.patch`; no claim of a fresh remote status check is made. `git show -s` independently confirmed the head commit author below.

| Source commit | Actual commit author | Subject |
|---|---|---|
| `e57a57d5f0299fefd37d0f3d661e7b8d81afda1d` | voiys &lt;matej2714@gmail.com&gt; | fix(catalog): preserve Go efforts and support native-first picker order |
| `d745d8a417dc8b56372625b656bde778270ddf41` | voiys &lt;matej2714@gmail.com&gt; | fix(codex): reset retained picker order after provider outages |
| `90eaaddd815f5f70263fbfe90f4968c41856fa2a` | voiys &lt;matej2714@gmail.com&gt; | fix(codex): normalize picker orders and retain slug compatibility |
| `0a935c5694229760c8c1cd5a62072107d8ae6696` | voiys &lt;matej2714@gmail.com&gt; | fix(codex): refresh retained spawn ranks during discovery outages |

Preserve original commit authors on a clean replay; for reimplementation or squash put `Co-authored-by: voiys <matej2714@gmail.com>` in each carried logical commit and the final squash body. PR login alone is not an author trailer.

Safe carry strategy: main revalidates pinned source/head and incoming parent; replay the complete reviewed source series in order or reproduce its exact delta with attribution. Preserve source follow-up commits, not only the initial feature commit. Publish a child against its still-open parent; after parent squash, rebuild the child on the new dev ancestry and re-run exact-head CI. Retarget surviving children before parent branch deletion. Push uses the user's authorized `--no-verify` to avoid local hooks; this does not substitute for CI. Once dev contains the complete carried behavior, close the superseded source PR with a carry reference; do not close it for a partial/default-only slice. No linked issue is invented.

## Exact change ledger

Every source changed file is accounted for below. “Same base” means a read-only `git hash-object` of current file bytes matches the patch's old blob prefix; it does not prove future cherry-pick cleanliness. “Drift” requires contextual reconciliation. Source binary is explicitly unreviewed. All textual hunks were inspected as source behavior; appendix preserves exact before/after, including complete NEW test content. No source production file was edited.

| Operation | Exact path | Baseline / disposition |
|---|---|---|
| MODIFY | `docs-site/src/content/docs/fr/guides/model-ordering.md` | Same base; reviewed textual delta |
| MODIFY | `docs-site/src/content/docs/guides/model-ordering.md` | Same base; reviewed textual delta |
| MODIFY | `docs-site/src/content/docs/reference/configuration/providers.md` | Drift; preserve current unrelated edits |
| MODIFY | `scripts/test-layout/layout.json` | Same base; reviewed textual delta |
| MODIFY | `src/codex/catalog/sync.ts` | Same base; reviewed textual delta |
| MODIFY | `src/codex/convergence.ts` | Same base; reviewed textual delta |
| MODIFY | `src/types/config.ts` | Drift; preserve current unrelated edits |
| NEW | `tests/codex-integration/catalog-full-picker-order.test.ts` | New source file, absent locally |
| NEW | `tests/codex-integration/catalog-go-exact-efforts.test.ts` | New source file, absent locally |
| MODIFY | `tests/codex-integration/codex-catalog.test.ts` | Same base; reviewed textual delta |
| MODIFY | `tests/codex-integration/codex-v2-gate.test.ts` | Same base; reviewed textual delta |
| MODIFY | `tests/fixtures/test-layout-expected.json` | Same base; reviewed textual delta |
| MODIFY (planned SoT addition) | `structure/03_catalog-and-subagents.md` | Public contract prose delta specified above; not in source PR |

## Execution boundary and verifier

This is a docs-only roadmap deliverable, not an implementation or merge receipt. The main agent owns 000, the goal/FSM, branch operations, integration, and final acceptance. No local tests, suites, typecheck, builds, hooks, provider requests, commits, pushes, or GitHub writes were run by this researcher. The next implementation cycle must re-read this plan against its actual parent tip.

Loop archetype: spec-satisfaction repair. Trigger: carry the pinned public source PR into lane B. Stop: required behaviors, exact-head CI, reviewer disposition and parent integration all have durable evidence. Expected result: DONE only after verified dev ancestry; NOOP only if equivalent behavior is already landed; unresolved correctness/CI evidence is pending, not DONE. Scope and unattended resource bounds are inherited from main's 000; this document does not arm or amend the goal. Upward escalation: return concrete caller/test evidence to main if the carry contract cannot be satisfied; additional worker dispatch requires main's planned scope.

CI-only verifier, inspected at the baseline below:

- `.github/workflows/ci.yml:5` uses unfiltered `pull_request`, so child PR bases are supported. `changes` at lines 181-218 admits `src/**`, `tests/**`, `scripts/**`, `gui/**`; source changes also admit packaging.
- Linux `test 1/4..4/4`, lines 255-316, invokes `scripts/ci/run-bun-test-batches.sh`. That runner enumerates `tests` (line 197), admits `.test.ts` files (lines 46-68), and excludes only storage/API-usage families into dedicated jobs; the catalog/management files in this plan are included. Each actual batch runs `bun test --isolate --timeout 60000` under a process timeout (lines 121-126). Read logs to prove the named files ran; aggregate green alone is insufficient.
- `gates`, lines 390-449, runs root TypeScript (`bun x tsc --noEmit`), GUI tests (`cd gui && bun test --isolate tests`), privacy scan and skill-surface check. GUI changes additionally run `bun run lint` and `bun run build`; `gui/package.json:8` expands build to `tsc -b && vite build`. GUI lint is `oxlint .`, including changed locale/UI inputs; the separately named `lint:i18n` script is not a dedicated CI step.
- macOS runs two full-suite shards (lines 451-547). Windows full-suite six shards (lines 658-769) run only on `workflow_dispatch` with lane `all`; do not infer Windows full-suite coverage from packaging smoke or PR aggregate success. Main must obtain an exact-ref dispatch if Windows full-suite evidence is required, then verify the run head.
- `.github/workflows/deploy-docs.yml:3-10,24-33` builds Astro only on main push or manual dispatch and then deploys. Normal PR CI has no Astro docs build. Do not trigger this deploy workflow merely to obtain a pre-merge check. Main must arrange an approved non-deploy CI verifier on the exact candidate commit or explicitly retain this as a readiness gap; this research does not add workflow code or authorize deployment.
- Save head SHA, parent/base SHA, run URL, executed job conclusions, named test logs, approvals and unresolved-thread disposition. Source-author reported passes are historical claims, not carried-head validation. Never attest local checks that were intentionally prohibited.


## Pinned public source delta

Reconcile only the touched hunks at the implementation parent. The conceptual deltas above and acceptance amendments take precedence over copying this source verbatim. This appendix records public source-PR behavior only.

````diff
diff --git a/docs-site/src/content/docs/fr/guides/model-ordering.md b/docs-site/src/content/docs/fr/guides/model-ordering.md
index cac2b0667c..64408efa53 100644
--- a/docs-site/src/content/docs/fr/guides/model-ordering.md
+++ b/docs-site/src/content/docs/fr/guides/model-ordering.md
@@ -23,7 +23,7 @@ priorités `i * N + j`, où `j` est la position du sélecteur en base zéro ; un
 sont déplacées hors de ces groupes de sélecteurs. Codex continue de n’annoncer que les cinq premières
 lignes visibles dans le sélecteur.
 
-Les priorités sans sélecteur pertinentes sont :
+Sans ordre global du sélecteur, les priorités sans sélecteur pertinentes sont :
 
 | Entrée du catalogue | Priorité | Source |
 | --- | --- : | --- |
@@ -134,8 +134,31 @@ au-delà de ce bloc mis en avant :
 Les lignes routées indiquées apparaissent dans l’ordre configuré. Une ligne absente du tableau conserve sa
 priorité normale et reste donc devant la bande d’affichage de `modelPickerOrder` ; indiquez toutes les
 lignes routées dont vous souhaitez contrôler l’ordre relatif. Une ligne également présente dans
-`subagentModels` conserve sa priorité de mise en avant. `modelPickerOrder` ne réorganise ni les lignes
-natives non qualifiées ni celles qualifiées par un compte ; utilisez `subagentModels` pour celles-ci.
+`subagentModels` conserve sa priorité de mise en avant. Une liste contenant uniquement des identifiants
+routés conserve la position normale des lignes natives.
+
+Pour ordonner tout le sélecteur, incluez un identifiant natif non qualifié :
+
+```json
+{
+  "modelPickerOrder": ["gpt-5.6-sol", "opencode-go/glm-5.3"]
+}
+```
+
+Les lignes indiquées apparaissent d’abord dans l’ordre du tableau, puis les lignes absentes
+selon leur priorité naturelle. La correspondance est exacte : `gpt-5.6-sol` et
+`openai/gpt-5.6-sol` désignent deux lignes distinctes. Pour une ligne qualifiée par un compte,
+indiquez son identifiant complet, sélecteur inclus. Les formes brute et encodée du même
+identifiant routé sont acceptées, avec priorité aux correspondances exactes. Les entrées
+vides sont ignorées.
+
+### Migration : identifiants natifs dans les listes existantes
+
+Auparavant, les identifiants natifs dans `modelPickerOrder` étaient ignorés. Une liste
+existante contenant un identifiant natif non qualifié ordonne désormais tout le sélecteur,
+y compris les lignes mises en avant. Supprimez ces identifiants pour conserver l’ancien
+comportement limité aux lignes routées. Les listes absentes, vides ou uniquement routées
+conservent leur comportement ; les priorités des candidats sous-agents ne changent pas.
 
 `modelPickerOrder` ne modifie jamais l’ensemble des candidats de `spawn_agent`. Il change uniquement la
 priorité visible par Codex dans le sélecteur, tandis qu’OpenCodex conserve la priorité naturelle de chaque
diff --git a/docs-site/src/content/docs/guides/model-ordering.md b/docs-site/src/content/docs/guides/model-ordering.md
index 696f631a58..352c8ddb12 100644
--- a/docs-site/src/content/docs/guides/model-ordering.md
+++ b/docs-site/src/content/docs/guides/model-ordering.md
@@ -23,7 +23,7 @@ priorities `i * N + j`, where `j` is the selector's zero-based position; a route
 rows are moved outside those selector groups. Codex still advertises only the first five
 picker-visible rows.
 
-The relevant no-selector priorities are:
+Without complete-picker ordering, the relevant no-selector priorities are:
 
 | Catalog entry | Priority | Source |
 | --- | ---: | --- |
@@ -133,8 +133,28 @@ featured block:
 Listed routed rows appear in the configured order. A routed row omitted from the array keeps its
 normal priority, so it remains ahead of the `modelPickerOrder` display band; list every routed row
 whose relative position you want to control. A row also present in `subagentModels` keeps its
-featured priority. Bare native and account-qualified native rows are not reordered by
-`modelPickerOrder`; use `subagentModels` for those rows.
+featured priority. With a routed-only list, native rows keep their normal positions.
+
+To order the complete picker, include a bare native id:
+
+```json
+{
+  "modelPickerOrder": ["gpt-5.6-sol", "opencode-go/glm-5.3"]
+}
+```
+
+Listed rows appear first in array order, followed by unlisted rows in natural priority
+order. Matching uses exact catalog ids: `gpt-5.6-sol` and `openai/gpt-5.6-sol` are separate
+rows. Raw and encoded spellings of the same routed id are also accepted, with exact
+matches taking precedence. Empty entries are ignored. Account-qualified rows need
+their selector-qualified id in the list.
+
+### Migration note: native ids in existing orders
+
+Previously, native ids in `modelPickerOrder` were ignored. An existing list containing
+a bare native id now activates complete-picker ordering, including featured rows.
+Remove bare native ids to keep the previous routed-only behavior. Unset, empty and
+routed-only lists retain their behavior; subagent candidate priorities are unchanged.
 
 `modelPickerOrder` never changes the `spawn_agent` candidate set. It changes only the
 Codex-visible picker priority while opencodex retains each moved row's natural priority for
diff --git a/docs-site/src/content/docs/reference/configuration/providers.md b/docs-site/src/content/docs/reference/configuration/providers.md
index ab8a154ecb..24f175a09a 100644
--- a/docs-site/src/content/docs/reference/configuration/providers.md
+++ b/docs-site/src/content/docs/reference/configuration/providers.md
@@ -810,3 +810,21 @@ ids with context `922000` and max input `922000`; OpenRouter seeds `openai/gpt-5
   "visionSidecar": { "enabled": true }
 }
 ```
+
+
+## OpenCode Go reasoning efforts
+
+Go catalog rows preserve their configured reasoning efforts exactly, including during
+catalog sync. OpenCodex does not append synthetic `max` or `ultra` choices to these rows.
+Use `modelReasoningEfforts` and `modelDefaultReasoningEfforts` for each model's accepted
+upstream values. Key these per-provider maps by upstream model ID, not the routed
+`opencode-go/<model-id>` catalog slug. For example, Omen Alpha (`omen-alpha`) accepts `low`, `high`,
+and `max`; Muse Spark 1.3 Contributor (`muse-spark-1.3-contributor`) accepts `minimal`, `low`, `medium`, `high`, and `xhigh` (Go endpoint validation, 2026-09-05).
+See the [OpenCode Go model list](https://opencode.ai/docs/go/#models) for the current roster.
+A configured subset can exclude the lower tiers. Other providers retain their existing behavior.
+
+For a native-first picker, include native ids in `modelPickerOrder` followed by the
+routed ids. This orders the complete picker while preserving the separate subagent
+candidate priorities. Routed-only orders keep their previous behavior. See the
+[ordering migration note](/guides/model-ordering/#migration-note-native-ids-in-existing-orders).
+`modelDisplayNames` on a provider controls readable labels without changing wire ids.
diff --git a/scripts/test-layout/layout.json b/scripts/test-layout/layout.json
index 29dd2c5f1c..7f3fa69999 100644
--- a/scripts/test-layout/layout.json
+++ b/scripts/test-layout/layout.json
@@ -255,6 +255,8 @@
     "bun-stream-caps.test.ts": "lib",
     "cancel-body-on-abort.test.ts": "server",
     "catalog-cursor-search.test.ts": "codex-integration",
+    "catalog-full-picker-order.test.ts": "codex-integration",
+    "catalog-go-exact-efforts.test.ts": "codex-integration",
     "catalog-input-modality-enum.test.ts": "codex-integration",
     "catalog-llamacpp-capabilities.test.ts": "codex-integration",
     "catalog-oauth-observation.test.ts": "codex-integration",
diff --git a/src/codex/catalog/sync.ts b/src/codex/catalog/sync.ts
index 3f5f472baf..7b0be6e19b 100644
--- a/src/codex/catalog/sync.ts
+++ b/src/codex/catalog/sync.ts
@@ -315,6 +315,8 @@ export function deriveEntry(
   contextCap?: NativeContextLimitsInput,
 ): RawEntry {
   const preserveExact = isExactComboCatalogModel(model, exactComboSlugs);
+  // Go exposes model-specific upstream enums; synthetic tiers mislead subagent overrides.
+  const preserveExactReasoning = preserveExact || model?.provider === "opencode-go";
   const codexForwardNativeCapabilityAlias = model?.codexForwardNativeCapabilityAlias === true
     ? upstreamNativeEntry(model.id)
     : null;
@@ -359,7 +361,7 @@ export function deriveEntry(
         e,
         model?.reasoningEfforts,
         model?.defaultReasoningEffort,
-        preserveExact || codexForwardNativeCapabilityAlias !== null,
+        preserveExactReasoning || codexForwardNativeCapabilityAlias !== null,
       );
       // This exact provider/model pair is the ChatGPT/Codex forward surface. Keep the pinned
       // native tool/search/responses-lite contract while preserving the routed slug and wire id.
@@ -409,7 +411,7 @@ export function deriveEntry(
   };
   if (isRouted) {
     applyRoutedCodexToolMode(entry, model?.codexToolMode);
-    applyReasoningLevels(entry, model?.reasoningEfforts, model?.defaultReasoningEffort, preserveExact);
+    applyReasoningLevels(entry, model?.reasoningEfforts, model?.defaultReasoningEffort, preserveExactReasoning);
   }
   else {
     applyReasoningLevels(entry, isGpt56NativeSlug(slug) ? undefined : ["low", "medium", "high", "xhigh"]);
@@ -518,7 +520,7 @@ export function buildCatalogEntriesFromObservedState({
   // before. The spawn_agent candidate window is derived separately from SPAWN_PRIORITY_FIELD, so
   // this display reorder cannot change which rows are spawn candidates.
   const pickerOrder = Array.isArray(modelPickerOrder)
-    ? modelPickerOrder.filter((id): id is string => typeof id === "string" && id.length > 0)
+    ? modelPickerOrder.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
     : [];
   const pickerOrderRank = new Map(pickerOrder.map((slug, i) => [slug, i] as const));
   const pickerOrderActive = pickerOrder.length > 0;
@@ -779,12 +781,33 @@ export const CANONICAL_NATIVE_CATALOG_CONTENT_POLICY: Readonly<
   unsupportedNativeEntries: "drop",
 });
 
+/** Preserve exact-id precedence while accepting the existing raw/encoded slug spellings. */
+function modelPickerRank(order: readonly string[]): (slug: string) => number | undefined {
+  const exact = new Map(order.map((slug, index) => [slug, index]));
+  const equivalent = new Map(order.map((slug, index) => [slugEquivalenceKey(slug), index]));
+  return slug => exact.get(slug) ?? equivalent.get(slugEquivalenceKey(slug));
+}
+
+/** A picker order containing native ids orders the whole list, without changing spawn ranks. */
+export function applyFullModelPickerOrder(entries: RawEntry[], order: readonly string[]): void {
+  const pickerOrder = order.filter(slug => slug.trim().length > 0);
+  if (!pickerOrder.some(slug => !slug.includes("/"))) return;
+  const rankOf = modelPickerRank(pickerOrder);
+  for (const entry of entries) {
+    const natural = entry[SPAWN_PRIORITY_FIELD] ?? entry.priority ?? 9;
+    entry[SPAWN_PRIORITY_FIELD] = natural;
+    entry.priority = rankOf(String(entry.slug)) ?? pickerOrder.length + Number(natural);
+  }
+}
+
 export interface ObservedCatalogMergeInput {
   readonly catalogModels: readonly RawEntry[];
   readonly baselineCatalogModels: readonly RawEntry[];
   readonly routedEntries: readonly RawEntry[];
   readonly baseline: ReadonlyMap<string, number>;
   readonly featured: readonly string[];
+  readonly modelPickerOrder?: readonly string[];
+  readonly accountSelectors?: readonly string[];
   readonly wsEnabled: boolean;
   readonly template: RawEntry | null;
   readonly disabledModels: ReadonlySet<string>;
@@ -817,6 +840,8 @@ export function mergeCatalogEntriesFromObservedState({
   routedEntries,
   baseline,
   featured,
+  modelPickerOrder = [],
+  accountSelectors = [],
   wsEnabled,
   template,
   disabledModels,
@@ -975,7 +1000,9 @@ export function mergeCatalogEntriesFromObservedState({
         finished.priority = nativePriority(slug, upstream.priority);
         return finished;
       }
-      const preserved = normalizeServiceTiers({ ...m, priority: nativePriority(slug, m.priority) });
+      const preserved = normalizeServiceTiers({ ...m, priority: nativePriority(slug, m[SPAWN_PRIORITY_FIELD] ?? m.priority) });
+      // Recompute spawn rank from current featured models, not a prior picker override.
+      delete preserved[SPAWN_PRIORITY_FIELD];
       // Older natives kept from disk still need the mock top tiers (max + ultra always
       // for subagent max spawns; wire-clamped to the model's real top rung).
       if (!isGpt56NativeSlug(slug) && slug !== NATIVE_RESERVE_MODEL) ensureUltraReasoningLevel(preserved);
@@ -1060,6 +1087,32 @@ export function mergeCatalogEntriesFromObservedState({
     // remain outside provider ownership and survive unless a fresh row replaces their exact slug.
     return !isOcxAuthoredRoutedEntry(entry);
   });
+  // Retained rows bypass the builder. Recompute managed spawn ranks from current config
+  // before either display-order mode; a saved display override is not current roster authority.
+  const pickerOrder = modelPickerOrder.filter(slug => slug.trim().length > 0);
+  const fullPickerOrder = pickerOrder.some(slug => !slug.includes("/"));
+  const rankOf = modelPickerRank(pickerOrder);
+  const featuredRankOf = modelPickerRank(featured);
+  const priorityStride = Math.max(accountSelectors.length, 1);
+  for (const entry of preservedRoutedEntries) {
+    const natural = entry[SPAWN_PRIORITY_FIELD];
+    if (typeof natural === "number") {
+      entry.priority = natural;
+      delete entry[SPAWN_PRIORITY_FIELD];
+    }
+    const slug = String(entry.slug);
+    if (!isOcxAuthoredRoutedEntry(entry) || isNativeAliasCatalogEntry(entry)) continue;
+    const featuredRank = featuredRankOf(slug);
+    entry.priority = featuredRank !== undefined
+      ? featuredRank * priorityStride
+      : (accountSelectors.length > 0 ? 1_000 : 0) + 5;
+    if (featuredRank !== undefined || fullPickerOrder) continue;
+    const pickerIndex = rankOf(slug);
+    if (pickerIndex !== undefined) {
+      entry[SPAWN_PRIORITY_FIELD] = entry.priority;
+      entry.priority = PICKER_ORDER_PRIORITY_BASE + pickerIndex * priorityStride;
+    }
+  }
   let finalRoutedEntries = [...admittedRoutedEntries, ...preservedRoutedEntries];
   finalRoutedEntries = finalRoutedEntries.filter(entry => {
     const slug = typeof entry.slug === "string" ? entry.slug : "";
@@ -1134,7 +1187,7 @@ export function mergeCatalogEntriesFromObservedState({
     // Mock-max universality (260709): preserved routed entries from disk may predate
     // the max rung — ensure it here so subagent max spawns validate on every
     // reasoning-capable entry. max only: 5.6 exact ladders (luna: no ultra) stay intact.
-    if (!exactCombo && !reserveProjection) {
+    if (!exactCombo && !reserveProjection && !String(e.slug ?? "").startsWith("opencode-go/")) {
       const levels = Array.isArray(e.supported_reasoning_levels)
         ? e.supported_reasoning_levels as Array<{ effort?: string }>
         : [];
@@ -1161,6 +1214,7 @@ export function mergeCatalogEntriesFromObservedState({
     multiAgentV2Enabled,
     { keepNativeChatGptOnV1, preserveDefaultMultiAgentVersion: isReserveCatalogProjection },
   );
+  applyFullModelPickerOrder(versionedEntries, modelPickerOrder);
   for (const entry of versionedEntries) {
     const kind = entry.opencodex_catalog_kind;
     if (trustedAccountBoundNativeCatalogSlug(entry) === undefined
@@ -1762,6 +1816,8 @@ function writeRetainedCatalogSync({
     }).filter(entry => trustedAccountBoundNativeCatalogSlug(entry) !== undefined)
     : [];
   catalog.models = mergeCatalogEntriesFromObservedState({
+    modelPickerOrder,
+    accountSelectors,
     catalogModels: catalogModelsForMerge,
     baselineCatalogModels: baselineCatalog?.models ?? [],
     routedEntries: goEntries,
diff --git a/src/codex/convergence.ts b/src/codex/convergence.ts
index df765a7853..8b30bb9eb2 100644
--- a/src/codex/convergence.ts
+++ b/src/codex/convergence.ts
@@ -342,6 +342,8 @@ function prepareCatalog(
     )),
   );
   const mergedModels = mergeCatalogEntriesFromObservedState({
+    modelPickerOrder,
+    accountSelectors,
     catalogModels,
     baselineCatalogModels,
     routedEntries,
diff --git a/src/types/config.ts b/src/types/config.ts
index 8cf1246979..425a8e095a 100644
--- a/src/types/config.ts
+++ b/src/types/config.ts
@@ -418,17 +418,14 @@ export interface OcxConfig {
   /** One-time featured-roster upgrade marker; later user ordering is preserved. */
   subagentModelsVersion?: number;
   /**
-   * Optional full picker ordering for the Codex model catalog, independent of the
-   * 5-slot `subagentModels` spawn_agent cap. DISPLAY-ONLY: it controls the visual order of
-   * the Codex model picker for large routed catalogs (10-20+ models) that would otherwise sort
-   * arbitrarily and reshuffle on every rebuild. Values are routed `<provider>/<model>` catalog
-   * slugs (matched by exact slug or `provider/id`); native OpenAI passthrough rows and
-   * account-qualified native rows are not reordered (order native rows via `subagentModels`).
-   * Listed routed rows appear in array order; rows not listed keep their normal display order.
-   * `subagentModels`-featured rows keep their top position. When unset or empty, catalog
-   * priority is unchanged. This changes ONLY what the user sees in the picker: the spawn_agent
-   * candidate set is derived from each row's natural priority and is provably unaffected, even
-   * when every routed row is listed (see opencodex_spawn_priority / effectiveSubagentRoster).
+   * Display-only order for the Codex picker, independent of subagentModels.
+   * Routed-only lists order non-featured routed rows; featured and native rows keep
+   * their normal positions. Including a bare native id opts into ordering the complete
+   * picker: listed ids appear first in array order, followed by unlisted rows in their
+   * natural priority order. Exact catalog ids take precedence over equivalent raw/encoded
+   * routed ids; empty entries are ignored. The separate natural spawn
+   * priority is preserved, so display order does not change subagent candidates.
+   * Unset or empty leaves catalog priorities unchanged.
    */
   modelPickerOrder?: string[];
   /**
diff --git a/tests/codex-integration/catalog-full-picker-order.test.ts b/tests/codex-integration/catalog-full-picker-order.test.ts
new file mode 100644
index 0000000000..1dbda27090
--- /dev/null
+++ b/tests/codex-integration/catalog-full-picker-order.test.ts
@@ -0,0 +1,111 @@
+import { routedSlug } from "../../src/providers/slug-codec";
+import { expect, test } from "bun:test";
+import { buildCatalogEntriesFromObservedState, mergeCatalogEntriesFromObservedState, CANONICAL_NATIVE_CATALOG_CONTENT_POLICY, applyFullModelPickerOrder, deriveEntry, mergeCatalogEntriesForSync, SPAWN_PRIORITY_FIELD } from "../../src/codex/catalog/sync";
+
+test("native-first picker order preserves Go subagent ranks and is repeatable", () => {
+  const rows: any[] = [
+    { slug: "opencode-go/glm-5.3", priority: 0 },
+    { slug: "gpt-5.6-sol", priority: 9 },
+    { slug: "gpt-6-astra", priority: 9 },
+  ];
+  const order = ["gpt-6-astra", "gpt-5.6-sol", "opencode-go/glm-5.3"];
+  applyFullModelPickerOrder(rows, order);
+  expect([...rows].sort((a,b) => a.priority-b.priority).map(r => r.slug)).toEqual(order);
+  expect(rows.map(r => r[SPAWN_PRIORITY_FIELD])).toEqual([0,9,9]);
+  const once = structuredClone(rows);
+  applyFullModelPickerOrder(rows, order);
+  expect(rows).toEqual(once);
+});
+
+test("existing routed-only ordering retains its behavior", () => {
+  const rows: any[] = [{ slug: "opencode-go/glm-5.3", priority: 1000 }];
+  applyFullModelPickerOrder(rows, ["opencode-go/glm-5.3"]);
+  expect(rows).toEqual([{ slug: "opencode-go/glm-5.3", priority: 1000 }]);
+});
+
+
+test("sync refreshes native spawn rank when featured models change", () => {
+  const sol = deriveEntry(null, "gpt-5.6-sol", "Sol", 105);
+  const order = ["gpt-5.6-sol"];
+  applyFullModelPickerOrder([sol], order);
+  expect(sol[SPAWN_PRIORITY_FIELD]).toBe(105);
+
+  const baseline = new Map([["gpt-5.6-sol", 9]]);
+  const promoted = mergeCatalogEntriesForSync([sol], [], baseline, ["gpt-5.6-sol"], false);
+  applyFullModelPickerOrder(promoted, order);
+  expect(promoted.find(entry => entry.slug === sol.slug)?.[SPAWN_PRIORITY_FIELD]).toBe(0);
+
+  const demoted = mergeCatalogEntriesForSync(promoted, [], baseline, ["opencode-go/glm-5.3"], false);
+  applyFullModelPickerOrder(demoted, order);
+  expect(demoted.find(entry => entry.slug === sol.slug)?.[SPAWN_PRIORITY_FIELD]).toBe(101);
+});
+
+
+test("bare native ids and routed slugs match exactly, without suffix aliases", () => {
+  const rows: any[] = [
+    { slug: "openai/gpt-5.6-sol", priority: 2 },
+    { slug: "gpt-5.6-sol", priority: 9 },
+    { slug: "other/gpt-5.6-sol", priority: 3 },
+  ];
+  applyFullModelPickerOrder(rows, ["gpt-5.6-sol", "openai/gpt-5.6-sol"]);
+  expect(rows.map(row => row.priority)).toEqual([1, 0, 5]);
+  expect(rows.map(row => row[SPAWN_PRIORITY_FIELD])).toEqual([2, 9, 3]);
+});
+
+test.each([
+  { order: [] as string[] },
+  { order: ["gpt-5.6-sol", "opencode-go/glm-5.3"], after: ["opencode-go/glm-5.3"] },
+  { order: ["gpt-5.6-sol", "opencode-go/glm-5.3"], before: ["opencode-go/glm-5.3"], after: [] },
+  { order: ["gpt-5.6-sol", "opencode-go/team/model"], modelId: "team/model", before: ["other/model", "opencode-go/team/model"], after: ["opencode-go/team/model", "other/model"] },
+
+  { order: ["", "opencode-go/glm-5.3"] },
+  { order: [" ", "opencode-go/glm-5.3"] },
+  { order: [""] },
+  { order: ["opencode-go/team/model"], modelId: "team/model" },
+  { order: ["opencode-go/glm-5.3"] },
+  { order: ["other/model", "opencode-go/glm-5.3"] },
+])("degraded discovery refreshes ranks and remains stable for %j", ({ order, modelId = "glm-5.3", before = [], after = [] }) => {
+  for (const accountSelectors of [[], ["account-a", "account-b"]]) {
+    const slug = routedSlug("opencode-go", modelId);
+    const fresh = (modelPickerOrder: readonly string[], featured: readonly string[] = []) => buildCatalogEntriesFromObservedState({
+      template: null, gptSlugs: [],
+      goModels: [{ id: modelId, provider: "opencode-go", displayName: "GLM 5.3", reasoningEfforts: ["high", "max"] }],
+      featured, modelPickerOrder, wsEnabled: false, multiAgentMode: "default",
+      exactComboSlugs: new Set(), accountSelectors, suppressedBareNativeSlugs: new Set(),
+      disabledNativeAccountSlugs: new Set(), multiAgentV2Enabled: false,
+    });
+    const merge = (catalogModels: Record<string, unknown>[], routedEntries: Record<string, unknown>[], modelPickerOrder: readonly string[], degraded: boolean, featured: readonly string[] = []) =>
+      mergeCatalogEntriesFromObservedState({
+        catalogModels, routedEntries, modelPickerOrder, accountSelectors,
+        baselineCatalogModels: [], baseline: new Map(), featured, wsEnabled: false,
+        template: null, disabledModels: new Set(), selectedModelsByProvider: new Map(),
+        gatheredProviderNames: new Set(["opencode-go"]),
+        degradedProviderNames: new Set(degraded ? ["opencode-go"] : []),
+        legacyCustomModelSlugs: new Set(), multiAgentMode: "default", multiAgentV2Enabled: false,
+        exactComboSlugs: new Set(), hasPhysicalComboProvider: false, includeNativeOpenAi: true,
+        accountBoundEntries: [],
+        policy: { ...CANONICAL_NATIVE_CATALOG_CONTENT_POLICY, warningPolicy: "suppress" },
+      });
+    const fullOrder = ["gpt-5.6-sol", slug];
+    const previous = merge([], fresh(fullOrder, before), fullOrder, false, before);
+    const saved = structuredClone(previous);
+    const healthy = merge(previous, fresh(order, after), order, false, after);
+    const degraded = merge(previous, [], order, true, after);
+    const row = (entries: Record<string, unknown>[]) => entries.find(entry => entry.slug === slug)!;
+    expect(row(degraded).priority).toBe(row(healthy).priority);
+    expect(row(degraded)[SPAWN_PRIORITY_FIELD]).toBe(row(healthy)[SPAWN_PRIORITY_FIELD]);
+    expect(merge(degraded, [], order, true, after)).toEqual(degraded);
+    expect(previous).toEqual(saved);
+  }
+});
+
+
+test("full ordering ignores empty entries and accepts raw upstream ids with slashes", () => {
+  const slug = routedSlug("vendor", "team/model");
+  const rows = [{ slug, priority: 1000 }, { slug: "gpt-5.6-sol", priority: 9 }];
+  applyFullModelPickerOrder(rows, ["", "gpt-5.6-sol", "vendor/team/model"]);
+  expect(rows.map(row => row.priority)).toEqual([1, 0]);
+  const exact = [{ slug, priority: 5 }];
+  applyFullModelPickerOrder(exact, ["gpt-5.6-sol", slug, "vendor/team/model"]);
+  expect(exact[0]!.priority).toBe(1);
+});
diff --git a/tests/codex-integration/catalog-go-exact-efforts.test.ts b/tests/codex-integration/catalog-go-exact-efforts.test.ts
new file mode 100644
index 0000000000..5fa4da816b
--- /dev/null
+++ b/tests/codex-integration/catalog-go-exact-efforts.test.ts
@@ -0,0 +1,39 @@
+import { expect, test } from "bun:test";
+import { deriveEntry, mergeCatalogEntriesForSync } from "../../src/codex/catalog/sync";
+
+for (const template of [null, { slug: "gpt-5.6-sol", supported_reasoning_levels: [{ effort: "ultra" }] }]) {
+  test(`Go preserves exact configured efforts (${template ? "template" : "fallback"})`, () => {
+    for (const [id, efforts] of [
+      ["glm-5.3", ["high", "max"]],
+      ["glm-5.3-flash", ["high", "max"]],
+      ["omen-alpha", ["high", "max"]],
+      ["deepseek-v4-flash-vision-exp", ["high", "max"]],
+      ["muse-spark-1.3-contributor", ["high", "xhigh"]],
+    ] as const) {
+      const entry = deriveEntry(template, `opencode-go/${id}`, "Go", 1, {
+        provider: "opencode-go", id, reasoningEfforts: [...efforts], defaultReasoningEffort: efforts[1],
+      });
+      expect(entry.supported_reasoning_levels.map((level: { effort: string }) => level.effort)).toEqual([...efforts]);
+      expect(entry.default_reasoning_level).toBe(efforts[1]);
+    }
+  });
+}
+
+test("other providers retain their existing virtual tiers", () => {
+  const entry = deriveEntry(null, "other/model", "Other", 1, {
+    provider: "other", id: "model", reasoningEfforts: ["high"],
+  });
+  expect(entry.supported_reasoning_levels.map((level: { effort: string }) => level.effort)).toEqual(["high", "max", "ultra"]);
+});
+
+test("sync does not reintroduce max for Muse", () => {
+  const muse = deriveEntry(null, "opencode-go/muse-spark-1.3-contributor", "Muse", 1, {
+    provider: "opencode-go", id: "muse-spark-1.3-contributor",
+    reasoningEfforts: ["high", "xhigh"], defaultReasoningEffort: "xhigh",
+  });
+  for (const [disk, fresh] of [[[muse], []], [[], [muse]]]) {
+    const entries = mergeCatalogEntriesForSync(disk, fresh, new Map(), [], false);
+    const entry = entries.find(e => e.slug === muse.slug)!;
+    expect(entry.supported_reasoning_levels.map((level: { effort: string }) => level.effort)).toEqual(["high", "xhigh"]);
+  }
+});
diff --git a/tests/codex-integration/codex-catalog.test.ts b/tests/codex-integration/codex-catalog.test.ts
index 37d8c69798..cc394a548d 100644
--- a/tests/codex-integration/codex-catalog.test.ts
+++ b/tests/codex-integration/codex-catalog.test.ts
@@ -5445,11 +5445,11 @@ describe("Codex catalog routed normalization", () => {
     const expected = [
       { slug: "deepseek/deepseek-v4-flash", efforts: ["low", "high", "max", "ultra"] },
       { slug: "deepseek/deepseek-v4-pro", efforts: ["low", "high", "max", "ultra"] },
-      { slug: "opencode-go/deepseek-v4-flash", efforts: ["low", "high", "max", "ultra"] },
-      { slug: "opencode-go/deepseek-v4-pro", efforts: ["low", "high", "max", "ultra"] },
-      { slug: "opencode-go/glm-5.2", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
-      { slug: "opencode-go/glm-5.1", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
-      { slug: "opencode-go/glm-5", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
+      { slug: "opencode-go/deepseek-v4-flash", efforts: ["low", "high", "max"] },
+      { slug: "opencode-go/deepseek-v4-pro", efforts: ["low", "high", "max"] },
+      { slug: "opencode-go/glm-5.2", efforts: ["low", "medium", "high", "xhigh", "max"] },
+      { slug: "opencode-go/glm-5.1", efforts: ["low", "medium", "high", "xhigh", "max"] },
+      { slug: "opencode-go/glm-5", efforts: ["low", "medium", "high", "xhigh", "max"] },
       { slug: "zai/glm-5.2", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
       { slug: "zai/glm-5.2[1m]", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
       { slug: "zhipu-bigmodel/glm-4.6", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
diff --git a/tests/codex-integration/codex-v2-gate.test.ts b/tests/codex-integration/codex-v2-gate.test.ts
index 8d3e2d9dc5..6e8b6a18c1 100644
--- a/tests/codex-integration/codex-v2-gate.test.ts
+++ b/tests/codex-integration/codex-v2-gate.test.ts
@@ -100,14 +100,13 @@ function installModeHintRuntime(supported = true): string {
 describe("catalog ultra (always-on)", () => {
   const routed = [{ id: "glm-5.2", provider: "opencode-go", reasoningEfforts: ["low", "medium", "high", "xhigh"] }];
 
-  test("routed + old natives always advertise mock max AND ultra", () => {
+  test("Go keeps declared efforts while old natives retain mock tiers", () => {
     const entries = buildCatalogEntries(template(), ["gpt-5.5"], routed as never, [], false);
     const native = entries.find(e => e.slug === "gpt-5.5")!;
     const glm = entries.find(e => e.slug === "opencode-go/glm-5.2")!;
     expect(efforts(native)).toContain("ultra");
     expect(efforts(native)).toContain("max");
-    expect(efforts(glm)).toContain("ultra");
-    expect(efforts(glm)).toContain("max"); // mock max: adapters/wire clamp keep it honest
+    expect(efforts(glm)).toEqual(["low", "medium", "high", "xhigh"]);
   });
 
   test("gpt-5.6-sol keeps native ultra + max; luna has max but no native ultra (upstream ladder)", () => {
diff --git a/tests/fixtures/test-layout-expected.json b/tests/fixtures/test-layout-expected.json
index 114c699eaf..8dba5cfb55 100644
--- a/tests/fixtures/test-layout-expected.json
+++ b/tests/fixtures/test-layout-expected.json
@@ -92,6 +92,8 @@
   "bun-stream-caps.test.ts": "lib",
   "cancel-body-on-abort.test.ts": "server",
   "catalog-cursor-search.test.ts": "codex-integration",
+  "catalog-full-picker-order.test.ts": "codex-integration",
+  "catalog-go-exact-efforts.test.ts": "codex-integration",
   "catalog-input-modality-enum.test.ts": "codex-integration",
   "catalog-llamacpp-capabilities.test.ts": "codex-integration",
   "catalog-oauth-observation.test.ts": "codex-integration",

````

## Consuming P refresh

Parent preparation head is 29f98462c4a63cf217347c26668733169fd65736. Source #3571 remains OPEN at 0a935c5694229760c8c1cd5a62072107d8ae6696, and its full patch passes applicability on this parent. All four non-merge source commits identify voiys <matej2714@gmail.com>. The existing modelPickerOrder field survives config loading through the established root passthrough schema; no new persistence field is introduced. Preserve providerContextCapValues from 020.

The initial roadmap listed source English/French edits, but six other existing model-ordering guides also contain the legacy native-order contract. MODIFY docs-site/src/content/docs/{ja,ko,ru,tr,zh-cn,zh-tw}/guides/model-ordering.md with the same complete-order opt-in, exact/equivalent matching, unchanged spawn roster and existing-list migration warning. Do not create new locales or alter unrelated routing semantics. The runtime/template output remains separately verified from any native client capture; a synthetic rendering must never be described as an actual client capture.

Delegation: main carries the final source diff and owns SoT/commits; catalog worker supplies caller-level coverage and a captured generated-list comparison; docs worker owns the six translated guides; independent code reviewer checks priorities/retained paths; remote verifier uses isolated exact-head tests/docs plus a native client capture if the installed client can be run safely with synthetic state. No local test/build/typecheck and no real personal proxy/account calls. Final merge gates remain unchanged.

## C evidence-driven contract clarification

The independent native-consumer audit distinguishes three concepts: OpenCodex natural-priority guidance (must remain unchanged), native advertised five (can follow changed display priority), and exact-name override eligibility (not restricted to the advertised five). This preserves the already-recorded #1649 design while correcting the earlier unqualified wording. No wire rewriting or native-client patch is added. The source appendix above remains an immutable record of the original PR and is not a current universal native-advertisement guarantee.

Native source d2d5b702 (local upstream checkout, not claimed to match binary0.153.4) shows both V1/exposedV2 using native priority; current valid generated before/after data demonstrates the expected displacement. The actual0.153.4 capture proves picker/data consumption only until a separate toolspec capture is obtained. V1 has no OCX preferred-roster injection; V2 guidance is conditional on catalog state. New production-writer fixture failures remain blockers for the natural-guidance criterion and cannot be waived by this wording correction.
