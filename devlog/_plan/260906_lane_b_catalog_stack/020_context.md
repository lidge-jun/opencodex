# 020 — Preserve selected provider context limits

Status: planned; source-inspection only. Research captured 2026-09-05T16:34:39.759005+00:00. Local anchor: `81871b3fa7034250b8d5ba2cbbfde44e40f0e69c`. Source: [PR #3654](https://github.com/lidge-jun/opencodex/pull/3654), issue [#3651](https://github.com/lidge-jun/opencodex/issues/3651). Source head `8facdb0d8c10109701015c0f6109fc67b1d9dd3c`, source base `0b7f60ee259bdd0e5c68b62936fe153af151e9dd`. Live GraphQL confirmed this head remains OPEN with zero unresolved threads on 2026-09-05 UTC (2026-09-06 KST).

## Execution contract

This is an implementation design for one later PABCD cycle, not an implementation receipt. The main agent owns the FSM, host goal, 000 roadmap, branch stack, publication, and merge. This delegated research made no production edits, ran no local tests/typecheck/build, and changed no refs.

Loop archetype: spec-satisfaction repair. Trigger: the linked public issue and source PR. Verifier: exact carried-head GitHub CI plus targeted behavior evidence below. Stop: all activation scenarios accounted for, CI producers successful, author attribution retained, and merge commit proven reachable from dev. Expected outcomes: DONE after that evidence, NOOP only if current dev already implements the same behavior; otherwise retain explicit BLOCKED/NEEDS_HUMAN evidence without claiming completion. Upward escalation: main reclaims a slice after two distinct agents fail its packet; downward delegation requires a P-phase amendment. Resource and credential limits inherit the main lane-B 000 plan; this document authorizes no independent goal, workflow dispatch, deployment, or account change.

The future executor must re-read the nearest src/GUI/docs AGENTS before code changes. No local tests, suites, typecheck, lint, builds, or dependency installation: CI is the execution verifier. Read-only `git apply --check` below checks textual portability only, not correctness.

## CI evidence contract

Source inspection at the recorded local HEAD establishes coverage, not passing execution:

- `.github/workflows/ci.yml:182-201` selects runtime/tests/GUI changes; both source diffs select `ci` and `gui`.
- `ci.yml:255-316`: four Linux shards invoke `bash scripts/ci/run-bun-test-batches.sh "$TEST_SHARD"`. `scripts/ci/run-bun-test-batches.sh:46-64,196-204` enumerates test files and excludes only the dedicated storage/API-usage families; the targeted files below are included.
- `ci.yml:422-428`: root TypeScript checks and `cd gui && bun test --isolate tests`; GUI lint/build at 416-420 and 442-446, privacy scan at 430-431. These are CI commands, never instructions to run locally.
- macOS test execution is at `ci.yml:532`; Windows is **dispatch-only** at `ci.yml:661-662` and runs six shards at 754. A normal PR check does not prove Windows test execution. Main must obtain appropriate exact-head dispatch evidence before claiming three-platform coverage.
- `ci.yml:917-933` permits skipped producers. Inspect actual test/gates job results and tested commit (including the PR merge ref and its head parent), not just aggregate `ci=success`.
- `.github/workflows/react-doctor.yml:15-18,46-57` scans PR changes in `gui` and blocks warnings. It is an additional review gate, not a replacement for GUI tests.
- `.github/workflows/deploy-docs.yml:3-10,25-32` builds docs only on main push or dispatch; normal PR CI has no Astro-docs build. Do not dispatch a deploying workflow merely to get validation. Main must arrange non-deploy hosted docs-build evidence or explicitly retain that verification gap. Local builds remain prohibited.

Before merging a carried layer, refresh source/head/base/review status, inspect exact-head CI jobs and remaining findings, preserve coauthor credit through squash, and verify the resulting merge SHA is an ancestor of fetched dev. Only then close the superseded source PR and its resolved issue; a source PR carried through another PR is not automatically merged/closed. Retarget/rebase the next child onto dev after its parent lands; do not delete a parent branch while an open child still targets it. These are main-owned future actions.

## Scope and caller proof

C3 context-state contract; provider-removal integration receives the affected persistence review. Outcome: off → reload → on preserves an explicit cap such as 128,000 and does not force 922,000. Persist selection independently of activation. No new context-cap endpoint, automatic enable on read, changed account entitlement, arbitrary native-window expansion or redesign of the context modal.

`gui/src/pages/Models.tsx:733-741` currently sends `NATIVE_GPT56_OPT_IN_WINDOW` when a native group is enabled. `src/providers/context-cap.ts:46-54` deletes active state on off and uses global value on every implicit enable. `src/server/management/provider-routes.ts:1399-1503` owns all three public request branches and refreshes live state/catalog after writes. `src/config.ts:1137` and `src/types/config.ts:607` carry only active limits. `src/codex/catalog/metadata.ts:301-304` exempts ordinary native windows from the 922k ceiling.

Reuse `context-cap.ts` for two maps: `providerContextCaps` is the only active input; new `providerContextCapValues` remembers the last selection. `selectedProviderContextCaps` merges sanitized remembered values first, active values last. Existing `providerContextCap` (line 10) remains unchanged, so disabled selections never activate catalog capping. `nativeContextLimits` at `metadata.ts:242-263` reads only active caps; long-window opt-in at 278-299 retains per-model ceilings. `src/codex/catalog/provider-fetch.ts:626` keys discovery by active caps; remembered-only changes do not need a new runtime cache key.

Provider removal/rename consumers are not optional: `providerEditorCandidate` at `provider-routes.ts:267-271`, editor adoption at 288-291, persisted editor callback at 849-852, direct deletion at 1381-1385, and `provider-id-rewrite.ts:113-124`. All must move/clear remembered state along with active state, without enabling it.

## Exact source carry map

| Operation | Path |
|---|---|
| NEW | `docs-site/public/screenshots/openai-context-cap-off.png` |
| NEW | `docs-site/public/screenshots/openai-context-cap-on.png` |
| MODIFY | `docs-site/src/content/docs/reference/management-api.md` |
| MODIFY | `gui/src/pages/Models.tsx` |
| MODIFY | `gui/src/pages/models-shared.ts` |
| MODIFY | `gui/tests/models-native-group-controls.test.ts` |
| MODIFY | `gui/tests/models-status-toast.test.tsx` |
| MODIFY | `src/codex/catalog/metadata.ts` |
| MODIFY | `src/config.ts` |
| MODIFY | `src/providers/context-cap.ts` |
| MODIFY | `src/providers/provider-id-rewrite.ts` |
| MODIFY | `src/server/management/provider-routes.ts` |
| MODIFY | `src/types/config.ts` |
| MODIFY | `tests/codex-integration/native-model-toggle.test.ts` |
| MODIFY | `tests/providers/provider-id-rewrite.test.ts` |
| MODIFY | `tests/server/management-provider-validation.test.ts` |

All 14 textual source files were reviewed. Both PNGs are accounted for as evidence assets; blob identity verified but pixels not inspected. Existing tests are extended, so source carry requires no new test-layout registration.

### Carry method and attribution

Prefer a **final diff port** atop the 010 child branch. Actual commit metadata names **Robin Bially <7304732+RobinBially@users.noreply.github.com>** on original `216c11a4941e1b00dc8a069de4ab75128c5f8abf` and clarification `202028670b8f3ec8b8b51761a89cccae081b32a7`. Preserve both contributions with `Co-authored-by: Robin Bially <7304732+RobinBially@users.noreply.github.com>` in the carry commit and eventual squash body. Merge commits brought in evolving dev; do not cherry-pick them blindly. The two non-merge commits can be considered for selective cherry-pick, but no cherry-pick was tested and the final delta must be compared to the pinned final PR diff.

Read-only `git apply --check --exclude='*.png' .tmp/lane-b/3654.patch` returned 0 against the recorded HEAD, before 010 is applied. Cached text equals the local source base-to-head diff after normalizing abbreviated index-hash lines. This is not proof against the future stacked parent. Preserve dev's unrelated xAI changes: `src/config.ts:583-587` and provider creation/patch handling changed since the source base; port hunks rather than replacing those files.

Binary source assets to carry from the pinned head (the cached patch omits payload):

- `docs-site/public/screenshots/openai-context-cap-off.png`, blob `092f7377f9781e9ea6b52b04cee5b1069c59f9c6`.
- `docs-site/public/screenshots/openai-context-cap-on.png`, blob `204cbd24a72b0d37efe900cedc02f72d9515fb51`.

## Implementation sequence within this phase

1. Add the optional positive-integer map to OcxConfig and Zod config schema; no default map is required. Existing configs lacking it must retain active values via the merged selector.
2. Add selector/forget helpers and modify per-provider/global/all-provider mutations exactly as the source diff. Use existing top-level deletion provenance helper when a map empties. Keep active-only readers unchanged.
3. Extend rename handling to both fields and preserve collision reporting. Switch editor candidate, persisted editor and direct provider removal from disable to forget. Adopt remembered values back into live config after successful editor persistence.
4. Expose `values` on GET and every successful PUT response. Update the route comment at current `provider-routes.ts:1433-1436`: implicit enable restores remembered value, then global default; it no longer always chooses global. Retain existing validation and catalog-refresh branches.
5. Add GUI response/cache/state for `values`; old server/cache fallback is `values ?? caps ?? {}`. Remove the native-only forced enable value and display `active ?? remembered ?? global`. Keep the select present but disabled while cap is off; custom drafts use that same displayed selection.
6. Remove only the special 922k bypass for ordinary native windows in `metadata.ts`; keep `longWindowOptInCeiling`, provider/per-model overlay precedence, and supported ceiling clamps intact.
7. Carry source tests, fill the concrete branch-coverage gaps below, synchronize directly affected documentation, and obtain hosted CI/rendered evidence. Do not implement any later layer here.

## Activation matrix and exact test changes

| Scenario / trigger | Required observed result | Test owner |
|---|---|---|
| First enable, no saved selection, global 350k | active and returned selected value 350k | source-added `tests/server/management-provider-validation.test.ts` |
| Explicit 128k, off, reload, implicit on | no active map while off, persisted remembered 128k; returns to active 128k | same source test |
| Remembered 128k while off | `providerContextCap` undefined and native/routed catalog not narrowed by remembered map | extend same test to inspect off-state catalog, not only config |
| Active legacy config with no remembered map | selection response derives active value; first off records it; reload/on restores it | extend same test file with legacy active 128k fixture |
| Global value change without setAll | existing enabled and disabled choices unchanged; first-time provider gets new global | existing test at 4168-4189 plus remembered assertion |
| Enabled A=128k, disabled B remembers 256k, `{value:600000,setAll:true}` | A active/remembered 600k, B still disabled/remembered 256k; B later restores 256k | add explicit two-provider case near existing 4196-4202; source only exercises all-active case |
| Same initial state, `{setAll:true}` without value | every configured provider active and remembered at global; replaces B's 256k | extend existing 4212-4218 and source-added setAll case |
| `{setAll:false}` | all active caps removed, all selections retained | source test plus multi-provider extension |
| Invalid/mixed body, unknown provider, fractional value floors to zero | existing 400/404, no active or remembered mutation | extend existing negatives at 4243-4321 to snapshot both maps |
| Rename while disabled | remembered key moved, no active cap; destination collision preserved/reported | source `tests/providers/provider-id-rewrite.test.ts` + collision case for remembered map |
| Direct removal or editor removal | both maps lose removed ID after persisted reload and live adoption; other provider selections stay | add cases in `tests/server/management-provider-validation.test.ts` near existing delete/editor fixtures |
| GUI native OpenAI 128k off/on | display stays 128k, aria-pressed changes, request body contains only provider/enabled | source `gui/tests/models-status-toast.test.tsx` |
| GUI reload while disabled, old cached/server response without values | remembered 128k restored after reload; old shape falls back to caps/global without crashing | extend the same rendered test with remount and legacy-response fixtures |
| Cap=922k on gpt-5.4 | window becomes 922k, not 1M | source expectation update in `tests/codex-integration/native-model-toggle.test.ts:299` |
| Supported long window ceilings / narrower overlays | gpt-5.6-sol ≤922k, Astra ≤872k; gpt-5.5 remains 272k; smaller cap and model overlay win | retain/extend existing native toggle cases around 289-315, inspect `metadata.ts:289-304` |

`gui/tests/models-native-group-controls.test.ts` is a source-oracle guard and cannot replace the rendered behavior test. The source GUI test does not remount while disabled, and the source backend test does not exercise a disabled provider through global setAll; those are explicit amendments, not already-proven coverage. Existing `tests/providers/context-cap-unknown-window.test.ts` remains relevant to active-only routed fallback.

## Public documentation synchronization

Source updates `docs-site/src/content/docs/reference/management-api.md:237` with both request shapes. Additional MODIFY paths are required because `docs-site/src/content/docs/reference/configuration/providers.md:31-32` currently contradicts that new API text and lacks the stored-selection field. Apply this exact English row contract:

```diff
-| `providerContextCaps?` | `Record<string, number>` | `{}` | Per-provider Codex-visible context caps. A cap only lowers a known context window. |
+| `providerContextCaps?` | `Record<string, number>` | `{}` | Active provider context limits. Ordinary windows are lowered; native models with a supported long window can expand only up to their own supported ceiling. |
+| `providerContextCapValues?` | `Record<string, number>` | `{}` | Last selected provider limits, retained while disabled. These values do not activate a cap. An enabled value takes precedence over a remembered value. |
-| `contextCapValue?` | `number` | `350000` | Default value used by the dashboard context-cap controls. Changing it applies the value to every routed provider — including providers without an existing `providerContextCaps` entry — only when "apply to every routed provider" is toggled on; otherwise each provider keeps its own cap. |
+| `contextCapValue?` | `number` | `350000` | Default used on first enable. A later enable restores the selected provider value. Updating the global value with `setAll: true` changes enabled caps only; `setAll: true` without a value enables all configured providers at the current global value. |
```

MODIFY `docs-site/src/content/docs/guides/model-routing.md:94-97` by adding after the existing active-cap paragraph: “Switching a cap off retains its selection in `providerContextCapValues`; switching it on restores that selection. A remembered selection never applies a limit while disabled.” Keep the current enabled-only global-update wording. Keep the valid explicit 922k opt-in example in `reference/configuration/providers.md:87-91`; eliminating the switch's forced value does not remove explicit native opt-in support.

Mirror these same key/default/activation semantics in the existing translated references and routing guides below; keep the source English identifiers verbatim and use the established locale prose. For API references append the source `caps`/`values` explanation and two concrete JSON payloads; for providers references replace the stale all-providers global-update claim, insert `providerContextCapValues`, and distinguish supported native ceilings. This is contract synchronization, not unrelated translation cleanup.

- MODIFY `docs-site/src/content/docs/fr/reference/management-api.md`.
- MODIFY `docs-site/src/content/docs/fr/reference/configuration/providers.md`.
- MODIFY `docs-site/src/content/docs/fr/guides/model-routing.md`.
- MODIFY `docs-site/src/content/docs/ja/reference/management-api.md`.
- MODIFY `docs-site/src/content/docs/ja/reference/configuration/providers.md`.
- MODIFY `docs-site/src/content/docs/ja/guides/model-routing.md`.
- MODIFY `docs-site/src/content/docs/ko/reference/management-api.md`.
- MODIFY `docs-site/src/content/docs/ko/reference/configuration/providers.md`.
- MODIFY `docs-site/src/content/docs/ko/guides/model-routing.md`.
- MODIFY `docs-site/src/content/docs/ru/reference/management-api.md`.
- MODIFY `docs-site/src/content/docs/ru/reference/configuration/providers.md`.
- MODIFY `docs-site/src/content/docs/ru/guides/model-routing.md`.
- MODIFY `docs-site/src/content/docs/tr/reference/management-api.md`.
- MODIFY `docs-site/src/content/docs/tr/reference/configuration/providers.md`.
- MODIFY `docs-site/src/content/docs/tr/guides/model-routing.md`.
- MODIFY `docs-site/src/content/docs/zh-cn/reference/management-api.md`.
- MODIFY `docs-site/src/content/docs/zh-cn/reference/configuration/providers.md`.
- MODIFY `docs-site/src/content/docs/zh-cn/guides/model-routing.md`.
- MODIFY `docs-site/src/content/docs/zh-tw/reference/management-api.md`.
- MODIFY `docs-site/src/content/docs/zh-tw/reference/configuration/providers.md`.
- MODIFY `docs-site/src/content/docs/zh-tw/guides/model-routing.md`.

No new GUI visible string is required. The API reference remains the public behavior SoT; `structure/05_gui-and-management-api.md:137` already names the owner and endpoint and needs no ownership rewrite.

## Interphase dependencies and readiness

Stack this as the next layer after 010. Preserve 010's manual-only OpenAI group identity, appended GUI test and manual-visibility documentation. Shared paths with 010: `gui/tests/models-native-group-controls.test.ts`, API references after translation sync. The #3571 layer later shares `src/types/config.ts`; #3659 later shares provider configuration docs. Lane A's proxy work can touch `src/config.ts`; main must reconcile that file rather than overwrite whole snapshots.

Source review thread `discussion_r3940577476` is resolved; carry clarification commit `202028670b8f3ec8b8b51761a89cccae081b32a7` and both setAll meanings. Zero unresolved source review threads was returned; this does not waive independent carried-head review. Source Cross-platform CI run **33974043191** and React Doctor run **33974043207** were `action_required`. No product CI execution pass is established. The concrete remaining gates are hosted execution, branch-coverage additions, documentation parity and rendered carried-head off/reload/on evidence.

Browser evidence must show chosen 128k, disabled 128k after reload, enabled 128k, corresponding request/response payloads, and ordinary-native 922k ceiling behavior. Label the off-state selector as the next-enable choice through the existing context-cap label; do not report the displayed value as an active window. Use the existing browser tooling on a CI/remote-built isolated surface; no local build or service mutation is authorized by this research packet.

## Pinned public source diff

Full textual source diff follows. Binary blobs are pinned above. Amend only the paths and behaviors explicitly named in this phase; do not replace entire files with stale source versions.

```diff
diff --git a/docs-site/src/content/docs/reference/management-api.md b/docs-site/src/content/docs/reference/management-api.md
index 784c6e17f5..133084ba93 100644
--- a/docs-site/src/content/docs/reference/management-api.md
+++ b/docs-site/src/content/docs/reference/management-api.md
@@ -237,6 +237,18 @@ keys are not returned to dashboard clients.
 | `GET, PUT /api/provider-context-caps` | Read or update global, all-provider, or one-provider context caps | 400 invalid request; 404 unknown provider |
 | `GET /api/provider-presets` | Return GUI provider presets derived from the runtime registry | — |
 
+The provider context-cap response includes `caps` (active limits) and `values` (last selected
+values, retained while disabled). Enabling a provider without `value` restores its selection,
+or uses the global `contextCapValue` on first enable. This also applies to OpenAI: the switch
+does not select a special 922k mode. An active cap bounds every native window; models with a
+supported long-context window may expand only up to their own supported ceiling.
+Updating the global value with `{ "value": 600000, "setAll": true }` changes only enabled
+provider caps; disabled providers keep their remembered selections when later enabled.
+In contrast, `{ "setAll": true }` without `value` enables every configured provider at the
+current global value, replacing their remembered selections. Turning a cap off does not
+activate its remembered value or erase the selection.
+
+
 `provider_has_dependent_combos` is a safety barrier: remove or edit the dependent combos before
 deleting their provider.
 
diff --git a/gui/src/pages/Models.tsx b/gui/src/pages/Models.tsx
index 91971cf54d..5b90f29a73 100644
--- a/gui/src/pages/Models.tsx
+++ b/gui/src/pages/Models.tsx
@@ -51,8 +51,6 @@ import {
   fmtK,
   NATIVE_CAP_OPTIONS,
   NATIVE_CAP_OPTION_SET,
-  NATIVE_GPT56_DEFAULT_WINDOW,
-  NATIVE_GPT56_OPT_IN_WINDOW,
   PAGE,
   readCollapsedProviders,
   THREAD_OPTION_SET,
@@ -75,6 +73,7 @@ type CachedModelsPage = {
   selectedModels: ProviderModelMap;
   disabled: string[];
   contextCaps: Record<string, number>;
+  contextCapValues?: Record<string, number>;
   contextCapValue: number;
 };
 
@@ -213,6 +212,7 @@ export default function Models({ apiBase, restartEpoch = 0 }: { apiBase: string;
   const [search, setSearch] = useState<Record<string, string>>({});
   const [limit, setLimit] = useState<Record<string, number>>({});
   const [contextCaps, setContextCaps] = useState<Record<string, number>>(() => cached?.contextCaps ?? {});
+  const [contextCapValues, setContextCapValues] = useState<Record<string, number>>(() => cached?.contextCapValues ?? {});
   const [contextCapValue, setContextCapValue] = useState(() => cached?.contextCapValue ?? 350_000);
   const [customCap, setCustomCap] = useState("");
   const [showCustom, setShowCustom] = useState(false);
@@ -428,6 +428,7 @@ export default function Models({ apiBase, restartEpoch = 0 }: { apiBase: string;
       selectedModels: selectionData,
       disabled: [...nextDisabled],
       contextCaps: capsData.caps ?? {},
+      contextCapValues: capsData.values ?? capsData.caps ?? {},
       contextCapValue: nextCapValue,
     } satisfies CachedModelsPage;
     writeSessionListCache(cacheKey, next);
@@ -447,6 +448,7 @@ export default function Models({ apiBase, restartEpoch = 0 }: { apiBase: string;
     setSelectedModels(next.selectedModels);
     setContextCapValue(next.contextCapValue);
     setContextCaps(next.contextCaps);
+    setContextCapValues(next.contextCapValues ?? next.contextCaps);
   }, []);
 
   const catalogResource = useDataSurface<CachedModelsPage>(
@@ -722,7 +724,7 @@ export default function Models({ apiBase, restartEpoch = 0 }: { apiBase: string;
     }
   };
 
-  const toggleProviderCap = async (provider: string, nativeGroup = false) => {
+  const toggleProviderCap = async (provider: string) => {
     setBusy(true);
     busyRef.current = true;
     setStatus("");
@@ -733,13 +735,12 @@ export default function Models({ apiBase, restartEpoch = 0 }: { apiBase: string;
       const r = await fetch(`${apiBase}/api/provider-context-caps`, {
         method: "PUT",
         headers: { "Content-Type": "application/json" },
-        body: JSON.stringify(enabled && nativeGroup
-          ? { provider, enabled, value: NATIVE_GPT56_OPT_IN_WINDOW }
-          : { provider, enabled }),
+        body: JSON.stringify({ provider, enabled }),
       });
       try {
         const data = await readJsonOrThrow<ProviderContextCapsResponse>(r, t("models.capSaveFailed"));
         setContextCaps(data?.caps ?? {});
+        setContextCapValues(data?.values ?? data?.caps ?? {});
         setOk(true);
         setStatus(t("models.capApplied"));
         await load(true);
@@ -784,6 +785,7 @@ export default function Models({ apiBase, restartEpoch = 0 }: { apiBase: string;
         const data = await readJsonOrThrow<ProviderContextCapsResponse>(r, t("models.capSaveFailed"));
         if (typeof data?.value === "number" && Number.isFinite(data.value) && data.value > 0) setContextCapValue(data.value);
         setContextCaps(data?.caps ?? {});
+        setContextCapValues(data?.values ?? data?.caps ?? {});
         setOk(true);
         setStatus(t("models.capApplied"));
         await load(true);
@@ -828,7 +830,7 @@ export default function Models({ apiBase, restartEpoch = 0 }: { apiBase: string;
   const onSelectProviderCap = (provider: string, raw: string) => {
     if (raw === CUSTOM_OPTION) {
       setProviderCapCustomOpen(prev => ({ ...prev, [provider]: true }));
-      setProviderCapCustomDraft(prev => ({ ...prev, [provider]: String(contextCaps[provider] ?? contextCapValue) }));
+      setProviderCapCustomDraft(prev => ({ ...prev, [provider]: String(contextCaps[provider] ?? contextCapValues[provider] ?? contextCapValue) }));
       return;
     }
     setProviderCapCustomOpen(prev => ({ ...prev, [provider]: false }));
@@ -1176,18 +1178,8 @@ export default function Models({ apiBase, restartEpoch = 0 }: { apiBase: string;
     const recentForProvider = modelDiscovery?.recentArrivals[provider] ?? [];
     const recentIds = new Set(recentForProvider.map(row => row.id));
     const capOn = contextCaps[provider] !== undefined;
-    const providerCap = contextCaps[provider] ?? contextCapValue;
-    // With the cap off, `providerCap` is only the value a future toggle would apply — for the
-    // native group that is the 350k default, which says nothing true about what Codex sees.
-    // The honest number there is the largest window the rows actually advertise.
-    const widestRowWindow = rows.reduce<number | undefined>((widest, row) => {
-      const window = typeof row.contextWindow === "number" && row.contextWindow > 0 ? row.contextWindow : undefined;
-      if (window === undefined) return widest;
-      return widest === undefined || window > widest ? window : widest;
-    }, undefined);
-    const capDisplayValue = capOn
-      ? providerCap
-      : (nativeProviderGroup ? NATIVE_GPT56_DEFAULT_WINDOW : (widestRowWindow ?? providerCap));
+    // Show the value the next enable will actually use, including a remembered selection.
+    const capDisplayValue = contextCaps[provider] ?? contextCapValues[provider] ?? contextCapValue;
     // The native group offers only the three windows GPT-5.6 actually has contracts for
     // (272k live, 372k legacy, 1.05M measured); routed providers keep the generic ladder.
     // The set has to follow the list, or a saved value outside it loses its option.
@@ -1348,7 +1340,7 @@ export default function Models({ apiBase, restartEpoch = 0 }: { apiBase: string;
                   screen-reader user was not told this governs the context window.
                   The number belongs to the adjacent Select, which is where a value
                   goes (020_control_affordances.md). */}
-              <Switch on={capOn} onClick={() => toggleProviderCap(provider, nativeProviderGroup)} disabled={busy} label={t("models.contextCapLabel")} showLabel />
+              <Switch on={capOn} onClick={() => toggleProviderCap(provider)} disabled={busy} label={t("models.contextCapLabel")} showLabel />
               {/* Always rendered, disabled when the cap is off. A cap-off provider used to
                   drop this control entirely, which is the defect the user reported: openai
                   showed 1.05M and anthropic showed nothing, so the two rows started at
diff --git a/gui/src/pages/models-shared.ts b/gui/src/pages/models-shared.ts
index 1575a52ac9..fdc487301c 100644
--- a/gui/src/pages/models-shared.ts
+++ b/gui/src/pages/models-shared.ts
@@ -56,6 +56,7 @@ export interface ProviderContextCapsResponse {
   cap?: number;
   value?: number;
   caps?: Record<string, number>;
+  values?: Record<string, number>;
 }
 
 export interface V2Status {
diff --git a/gui/tests/models-native-group-controls.test.ts b/gui/tests/models-native-group-controls.test.ts
index ffd27ad17f..dbe0d68a3c 100644
--- a/gui/tests/models-native-group-controls.test.ts
+++ b/gui/tests/models-native-group-controls.test.ts
@@ -72,14 +72,9 @@ test("every provider keeps its window readable with the cap switched off", async
   // slot is occupied on every card (040_cap_cluster_and_occupied_slot.md), which makes the
   // property this test protects strictly wider than it was.
   expect(src).not.toContain("{(capOn || nativeProviderGroup) && (");
-  // With the cap off the stored value is only what a future toggle would apply — the 350k
-  // default — so the display falls back to the widest window the rows actually advertise.
-  // Matched as separate fragments because the expression is wrapped across lines now, and
-  // it grew a native branch: with the cap off the native group shows its default window
-  // rather than the widest advertised row. A single-line literal pinned the formatting
-  // instead of the behaviour and broke on the reflow that introduced that branch.
-  expect(src).toContain("const capDisplayValue = capOn");
-  expect(src).toContain("nativeProviderGroup ? NATIVE_GPT56_DEFAULT_WINDOW : (widestRowWindow ?? providerCap)");
+  // The disabled select previews the persisted choice or global default used by enable.
+  expect(src).toContain("contextCaps[provider] ?? contextCapValues[provider] ?? contextCapValue");
+  expect(src).not.toContain("value: NATIVE_GPT56_OPT_IN_WINDOW");
   // The select is inert until the cap is actually on: showing a number is not the same as
   // offering to change one.
   expect(src).toContain("disabled={busy || !capOn}");
diff --git a/gui/tests/models-status-toast.test.tsx b/gui/tests/models-status-toast.test.tsx
index 29c902c2cb..5ecadb078e 100644
--- a/gui/tests/models-status-toast.test.tsx
+++ b/gui/tests/models-status-toast.test.tsx
@@ -175,3 +175,40 @@ test("success toast expires after 6s and a repeated action re-arms it", async ()
   await fireTimers(6000);
   expect(container.querySelector(".action-toast")).toBeNull();
 });
+
+test("OpenAI context switch restores the selected cap instead of forcing 922k", async () => {
+  testWindow.sessionStorage.clear();
+  let caps: Record<string, number> = {openai:128_000};
+  const values = {openai:128_000};
+  const bodies: unknown[] = [];
+  const fallback = globalThis.fetch;
+  globalThis.fetch = (async (input, init) => {
+    const url = String(input);
+    if (url.endsWith("/api/models")) return Response.json([
+      {provider:"openai",id:"gpt-5.5",namespaced:"gpt-5.5",native:true,disabled:false,contextWindow:caps.openai??272_000},
+    ]);
+    if (url.endsWith("/api/providers")) return Response.json([{name:"openai",authMode:"forward",liveModels:false}]);
+    if (url.endsWith("/api/provider-context-caps")) {
+      if (init?.method === "PUT") {
+        const body=JSON.parse(String(init.body)); bodies.push(body);
+        caps=body.enabled ? {openai:values.openai} : {};
+      }
+      return Response.json({caps,values,value:350_000});
+    }
+    return fallback(input,init);
+  }) as typeof fetch;
+  const { createRoot } = await import("react-dom/client");
+  await act(async () => { root=createRoot(container); root.render(<LanguageProvider><Models apiBase="http://localhost" /></LanguageProvider>); });
+  const settle=async()=>{await new Promise(resolve=>testWindow.setTimeout(resolve,0));};
+  await act(settle);
+  const cluster=()=>container.querySelector<HTMLElement>(".models-cap-cluster")!;
+  const toggle=()=>cluster().querySelector<HTMLButtonElement>("button.switch")!;
+  expect(cluster().textContent).toContain("128k");
+  await act(async()=>{toggle().click();await settle();});
+  expect(toggle().getAttribute("aria-pressed")).toBe("false");
+  expect(cluster().textContent).toContain("128k");
+  await act(async()=>{toggle().click();await settle();});
+  expect(toggle().getAttribute("aria-pressed")).toBe("true");
+  expect(cluster().textContent).toContain("128k");
+  expect(bodies).toEqual([{provider:"openai",enabled:false},{provider:"openai",enabled:true}]);
+});
diff --git a/src/codex/catalog/metadata.ts b/src/codex/catalog/metadata.ts
index a50dd9469f..f239ce48b1 100644
--- a/src/codex/catalog/metadata.ts
+++ b/src/codex/catalog/metadata.ts
@@ -299,8 +299,6 @@ function narrowToLimits(raw: number | undefined, slug: string, input: NativeCont
     return overlay !== undefined && cap !== undefined ? Math.min(window, cap) : window;
   }
   const narrowed = overlay === undefined ? raw : Math.min(raw, overlay);
-  // 922k is the GPT-5.6 1M opt-in, not a request to shrink gpt-5.4's 1M window.
-  if (cap === NATIVE_GPT56_MAX_INPUT_TOKENS) return narrowed;
   return applyProviderContextCap(narrowed, cap) ?? narrowed;
 }
 
diff --git a/src/config.ts b/src/config.ts
index d2b0bb707a..cd14e26b9c 100644
--- a/src/config.ts
+++ b/src/config.ts
@@ -1134,6 +1134,7 @@ const configSchema = z.object({
   subagentModels: z.array(z.string().min(1)).optional().catch(undefined),
   clientIntegrations: clientIntegrationsSchema.optional().catch(undefined),
   providerContextCaps: z.record(z.string(), z.number().int().positive()).optional(),
+  providerContextCapValues: z.record(z.string(), z.number().int().positive()).optional(),
   contextCapValue: z.number().int().positive().optional(),
   multiAgentGuidanceEnabled: z.boolean().optional(),
   // Invalid optional recovery config must not discard unrelated provider/account state.
diff --git a/src/providers/context-cap.ts b/src/providers/context-cap.ts
index d10807ced2..9dd10126ad 100644
--- a/src/providers/context-cap.ts
+++ b/src/providers/context-cap.ts
@@ -43,13 +43,21 @@ export function globalContextCapValue(config: Pick<OcxConfig, "contextCapValue">
   return isValidContextCap(value) ? Math.floor(value) : DEFAULT_PROVIDER_CONTEXT_CAP;
 }
 
+/** Active caps win over remembered values from an earlier switch-off. */
+export function selectedProviderContextCaps(config: Pick<OcxConfig, "providerContextCaps" | "providerContextCapValues">): Record<string, number> {
+  return { ...providerContextCaps({ providerContextCaps: config.providerContextCapValues }), ...providerContextCaps(config) };
+}
+
 export function setProviderContextCap(config: OcxConfig, provider: string, enabled: boolean, value?: number): void {
   const next = providerContextCaps(config);
+  const selected = selectedProviderContextCaps(config);
   if (enabled) {
-    next[provider] = isValidContextCap(value) ? Math.floor(value) : globalContextCapValue(config);
+    next[provider] = isValidContextCap(value) ? Math.floor(value) : (selected[provider] ?? globalContextCapValue(config));
+    selected[provider] = next[provider];
   } else {
     delete next[provider];
   }
+  if (Object.keys(selected).length > 0) config.providerContextCapValues = selected;
   if (Object.keys(next).length > 0) config.providerContextCaps = next;
   else deleteConfigTopLevelKey(config, "providerContextCaps");
 }
@@ -66,18 +74,33 @@ export function setGlobalContextCapValue(config: OcxConfig, value: number, apply
   if (!applyToAll) return;
   const caps = providerContextCaps(config);
   for (const provider of Object.keys(caps)) caps[provider] = next;
-  if (Object.keys(caps).length > 0) config.providerContextCaps = caps;
+  if (Object.keys(caps).length > 0) {
+    config.providerContextCaps = caps;
+    config.providerContextCapValues = { ...selectedProviderContextCaps(config), ...caps };
+  }
 }
 
 /** Enable the cap for every named provider at the current value, or clear all caps. */
 export function setAllProviderContextCaps(config: OcxConfig, providerNames: string[], enabled: boolean): void {
+  const selected = selectedProviderContextCaps(config);
   if (!enabled) {
+    if (Object.keys(selected).length > 0) config.providerContextCapValues = selected;
     deleteConfigTopLevelKey(config, "providerContextCaps");
     return;
   }
   const value = globalContextCapValue(config);
   const next: Record<string, number> = {};
-  for (const name of providerNames) next[name] = value;
+  for (const name of providerNames) { next[name] = value; selected[name] = value; }
+  if (Object.keys(selected).length > 0) config.providerContextCapValues = selected;
   if (Object.keys(next).length > 0) config.providerContextCaps = next;
   else deleteConfigTopLevelKey(config, "providerContextCaps");
 }
+
+/** Provider removal clears both the active limit and its remembered selection. */
+export function forgetProviderContextCap(config: OcxConfig, provider: string): void {
+  setProviderContextCap(config, provider, false);
+  const values = { ...config.providerContextCapValues };
+  delete values[provider];
+  if (Object.keys(values).length > 0) config.providerContextCapValues = values;
+  else deleteConfigTopLevelKey(config, "providerContextCapValues");
+}
diff --git a/src/providers/provider-id-rewrite.ts b/src/providers/provider-id-rewrite.ts
index 10a6f3f211..0111a8674a 100644
--- a/src/providers/provider-id-rewrite.ts
+++ b/src/providers/provider-id-rewrite.ts
@@ -112,14 +112,16 @@ export function rewriteProviderReferences(config: OcxConfig, from: string, to: s
 
   // Keys. `providerContextCaps` is KEYED by provider id — a prefix rewrite would
   // silently orphan the cap — and a destination key may already be occupied.
-  const caps = config.providerContextCaps;
-  if (caps && Object.hasOwn(caps, from)) {
-    if (Object.hasOwn(caps, to)) {
-      collisions.push(`providerContextCaps.${to}`);
-    } else {
-      caps[to] = caps[from]!;
-      delete caps[from];
-      changed += 1;
+  for (const field of ["providerContextCaps", "providerContextCapValues"] as const) {
+    const caps = config[field];
+    if (caps && Object.hasOwn(caps, from)) {
+      if (Object.hasOwn(caps, to)) {
+        collisions.push(`${field}.${to}`);
+      } else {
+        caps[to] = caps[from]!;
+        delete caps[from];
+        changed += 1;
+      }
     }
   }
 
diff --git a/src/server/management/provider-routes.ts b/src/server/management/provider-routes.ts
index e26420e003..7b4e10dec6 100644
--- a/src/server/management/provider-routes.ts
+++ b/src/server/management/provider-routes.ts
@@ -60,7 +60,7 @@ import { clearThreadAccountMap } from "../../codex/routing";
 import { primeCodexPoolQuotas } from "../../codex/auth-api";
 import { clearModelCache, getProviderDiscoveryStatus } from "../../codex/model-cache";
 import { getCodexModelEntitlementStatus } from "../../codex/model-entitlements";
-import { DEFAULT_PROVIDER_CONTEXT_CAP, globalContextCapValue, providerContextCap, providerContextCaps, setAllProviderContextCaps, setGlobalContextCapValue, setProviderContextCap } from "../../providers/context-cap";
+import { DEFAULT_PROVIDER_CONTEXT_CAP, globalContextCapValue, providerContextCap, providerContextCaps, selectedProviderContextCaps, forgetProviderContextCap, setAllProviderContextCaps, setGlobalContextCapValue, setProviderContextCap } from "../../providers/context-cap";
 import { modelAutoCompactTokenLimitsConfigError } from "../../providers/auto-compact-budget";
 import { resolveCodexHomeDir } from "../../codex/home";
 import { readUsageEntries } from "../../usage/log";
@@ -267,7 +267,7 @@ function providerEditorCandidate(
   candidate.providers = providers;
   for (const name of removedProviders) {
     dropProviderCustomModels(candidate, name);
-    setProviderContextCap(candidate, name, false);
+    forgetProviderContextCap(candidate, name);
   }
   const validated = validateConfigCandidate(candidate);
   if (!validated.ok) {
@@ -288,6 +288,8 @@ function adoptProviderEditorCandidate(live: OcxConfig, persisted: OcxConfig): vo
   else live.customModels = structuredClone(persisted.customModels);
   if (persisted.providerContextCaps === undefined) delete live.providerContextCaps;
   else live.providerContextCaps = structuredClone(persisted.providerContextCaps);
+  if (persisted.providerContextCapValues === undefined) delete live.providerContextCapValues;
+  else live.providerContextCapValues = structuredClone(persisted.providerContextCapValues);
   if (persisted.disabledModels === undefined) delete live.disabledModels;
   else live.disabledModels = [...persisted.disabledModels];
   if (persisted.modelDiscovery === undefined) delete live.modelDiscovery;
@@ -847,7 +849,7 @@ export async function handleProviderRoutes(ctx: ManagementContext): Promise<Resp
       persisted.modelDiscovery = candidate.config.modelDiscovery;
       for (const name of candidate.removedProviders) {
         dropProviderCustomModels(persisted, name);
-        setProviderContextCap(persisted, name, false);
+        forgetProviderContextCap(persisted, name);
       }
       return {
         changed: true,
@@ -1368,7 +1370,7 @@ export async function handleProviderRoutes(ctx: ManagementContext): Promise<Resp
     delete config.providers[name];
     const { dropProviderCustomModels } = await import("../../providers/provider-id-rewrite");
     const droppedCustomModels = dropProviderCustomModels(config, name);
-    setProviderContextCap(config, name, false);
+    forgetProviderContextCap(config, name);
     save(config);
     await replaceProviderAccountSet(name, null);
     reconcileLiveStateStores();
@@ -1384,7 +1386,7 @@ export async function handleProviderRoutes(ctx: ManagementContext): Promise<Resp
   }
 
   if (url.pathname === "/api/provider-context-caps" && req.method === "GET") {
-    return jsonResponse({ cap: DEFAULT_PROVIDER_CONTEXT_CAP, value: globalContextCapValue(config), caps: providerContextCaps(config) });
+    return jsonResponse({ cap: DEFAULT_PROVIDER_CONTEXT_CAP, value: globalContextCapValue(config), caps: providerContextCaps(config), values: selectedProviderContextCaps(config) });
   }
 
   if (url.pathname === "/api/provider-context-caps" && req.method === "PUT") {
@@ -1400,7 +1402,7 @@ export async function handleProviderRoutes(ctx: ManagementContext): Promise<Resp
       ok: true,
       cap: DEFAULT_PROVIDER_CONTEXT_CAP,
       value: globalContextCapValue(config),
-      caps: providerContextCaps(config),
+      caps: providerContextCaps(config), values: selectedProviderContextCaps(config),
       catalogRefresh,
     });
 
diff --git a/src/types/config.ts b/src/types/config.ts
index df7ac25727..e98d5ac46d 100644
--- a/src/types/config.ts
+++ b/src/types/config.ts
@@ -605,6 +605,8 @@ export interface OcxConfig {
   quotaResetNotify?: OcxQuotaResetNotifyConfig;
   /** Provider-level Codex-visible context caps. Values only lower known model context windows. */
   providerContextCaps?: Record<string, number>;
+  /** Last selected provider caps; retained while a cap is switched off. Not an active limit. */
+  providerContextCapValues?: Record<string, number>;
   /** Global Codex-visible context cap value (tokens). Falls back to DEFAULT_PROVIDER_CONTEXT_CAP. */
   contextCapValue?: number;
   /** Bind hostname. Default "127.0.0.1" (loopback only). Set "0.0.0.0" to expose on all interfaces. */
diff --git a/tests/codex-integration/native-model-toggle.test.ts b/tests/codex-integration/native-model-toggle.test.ts
index 52044cde5a..eac9ec0960 100644
--- a/tests/codex-integration/native-model-toggle.test.ts
+++ b/tests/codex-integration/native-model-toggle.test.ts
@@ -296,7 +296,7 @@ describe("native GPT model toggles (bare slugs in disabledModels)", () => {
     const over = nativeModelRows({ providerContextCaps: { openai: 2_000_000 } });
     expect(over.find(r => r.slug === "gpt-5.6-sol")?.contextWindow).toBe(922_000);
     expect(raised.find(r => r.slug === "gpt-5.5")?.contextWindow).toBe(272_000);
-    expect(raised.find(r => r.slug === "gpt-5.4")?.contextWindow).toBe(1_000_000);
+    expect(raised.find(r => r.slug === "gpt-5.4")?.contextWindow).toBe(922_000);
   });
 
   test("nativeModelRows applies providerContextCaps.openai as a ceiling (#1430)", () => {
diff --git a/tests/providers/provider-id-rewrite.test.ts b/tests/providers/provider-id-rewrite.test.ts
index 1df8753b82..cc87ae55fc 100644
--- a/tests/providers/provider-id-rewrite.test.ts
+++ b/tests/providers/provider-id-rewrite.test.ts
@@ -209,3 +209,10 @@ test("removal leaves the custom-model ownership marker untouched", () => {
     legacyOwnedSlugs: ["agnes-ai/agnes-2.5-flash", "huggingface/DeepSeek-V4-Flash-0731"],
   });
 });
+
+ test("moves remembered provider caps without activating them", () => {
+  const config = { providerContextCapValues: { [FROM]: 128_000 } } as unknown as OcxConfig;
+  expect(rewriteProviderReferences(config, FROM, TO)).toEqual({ changed: 1, collisions: [] });
+  expect(config.providerContextCapValues).toEqual({ [TO]: 128_000 });
+  expect(providerContextCap(config, TO)).toBeUndefined();
+});
diff --git a/tests/server/management-provider-validation.test.ts b/tests/server/management-provider-validation.test.ts
index 35a7924ebe..36bf70be57 100644
--- a/tests/server/management-provider-validation.test.ts
+++ b/tests/server/management-provider-validation.test.ts
@@ -4664,3 +4664,31 @@ describe("provider transport option management contract (#1668, #2816)", () => {
     });
   });
 });
+
+test("OpenAI provider cap remembers an explicit window across off, reload, and on", async () => {
+  mkdirSync(TEST_DIR, { recursive: true });
+  process.env.OPENCODEX_HOME = TEST_DIR;
+  let live: OcxConfig = {
+    port: 0, defaultProvider: "openai", contextCapValue: 350_000,
+    providers: { openai: { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex", liveModels: false } },
+  };
+  saveConfig(live);
+  const put = async (body: unknown) => {
+    const url = new URL("http://localhost/api/provider-context-caps");
+    const response = await handleManagementAPI(new Request(url, {method:"PUT", headers:{"content-type":"application/json"}, body:JSON.stringify(body)}), url, live, {createManagementConvergeCodex:catalogConvergenceFactory()});
+    expect(response?.status).toBe(200);
+    return response!.json();
+  };
+  expect(await put({provider:"openai",enabled:true})).toMatchObject({caps:{openai:350_000}});
+  await put({provider:"openai",enabled:true,value:128_000});
+  expect(await put({provider:"openai",enabled:false})).toMatchObject({caps:{},values:{openai:128_000}});
+  live = loadConfig();
+  expect(live.providerContextCaps).toBeUndefined();
+  expect(await put({provider:"openai",enabled:true})).toMatchObject({caps:{openai:128_000}});
+  const {nativeModelRows} = await import("../../src/codex/catalog");
+  expect(nativeModelRows(live).filter(row=>row.contextWindow !== undefined).every(row=>row.contextWindow! <= 128_000)).toBe(true);
+  await put({setAll:false});
+  expect(loadConfig().providerContextCapValues?.openai).toBe(128_000);
+  await put({setAll:true});
+  expect(loadConfig().providerContextCaps?.openai).toBe(350_000);
+});
```

## Consuming P refresh

Source #3654 remains OPEN at 8facdb0d8c10109701015c0f6109fc67b1d9dd3c. Full binary-preserving patch applicability passes on verified visibility head e556cc9f7. The actual persistence field is providerContextCapValues. Preserve the prior visibility tests and all translated API paragraphs. A confirmed its config overlap is documentation-only; the executable proxy resolver changes live elsewhere. Owner admin steering and preparation-vs-merge gates are recorded in 000.
