# 010 — Manual OpenAI visibility and replacement rows

Status: planned; source-inspection only. Research captured 2026-09-05T16:34:39.759005+00:00. Local anchor: `81871b3fa7034250b8d5ba2cbbfde44e40f0e69c`. Source: [PR #3653](https://github.com/lidge-jun/opencodex/pull/3653), issue [#3650](https://github.com/lidge-jun/opencodex/issues/3650). Source head `956eedac439922cf7645f130ef8432833e813a9a`, source base `0b7f60ee259bdd0e5c68b62936fe153af151e9dd`. Live GraphQL confirmed this head remains OPEN with zero unresolved threads on 2026-09-05 UTC (2026-09-06 KST).

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

C3 product slice, with the existing management validation boundary retained for independent review. Outcome: manually configured `openai/gpt-5.5` can be toggled without HTTP 400; it replaces the matching bare dashboard row, while account-qualified native rows and native provider controls survive. No route renaming, entitlement change, catalog order redesign, model deletion API, or runtime transport change.

Current `src/server/management/model-routes.ts:567-570` rejects every non-native OpenAI target. `gui/src/pages/Models.tsx:1463` sends the actual row's `native` flag; group visibility at 1218 sends mixed native/manual targets. `gui/src/model-visibility.ts:58-70` serializes these unchanged. Reuse this caller and existing atomic visibility handler, rather than adding an endpoint.

Current `src/server/management/model-rows.ts:125-172` deduplicates routed custom rows but concatenates all native rows. Add bare-native filtering after `visibleCustomModels`/`customNamespaced` are known, before Fast-row metadata at 173-184. `loadExportModels` at 214-216 consumes the same rows and removes disabled entries, so client-config export needs explicit regression coverage. `model-routes.ts:357` returns these rows; `model-routes.ts:490-510` serializes client config via the existing export path. `gui/src/models-groups.ts:84` loses native controls when all visible rows are manual; derive `nativeProviderGroup` also from configured canonical OpenAI `authMode: forward`, while leaving `native` false for manual-only groups.

## Exact source carry map

| Operation | Path |
|---|---|
| NEW | `docs-site/public/screenshots/manual-openai-model-toggle.png` |
| MODIFY | `docs-site/src/content/docs/reference/management-api.md` |
| MODIFY | `gui/src/models-groups.ts` |
| MODIFY | `gui/tests/models-native-group-controls.test.ts` |
| MODIFY | `src/server/management/model-routes.ts` |
| MODIFY | `src/server/management/model-rows.ts` |
| MODIFY | `tests/codex-integration/model-visibility-management-api.test.ts` |

All six textual files were reviewed, including all test hunks. The PNG is accounted for as a binary evidence asset: blob identity verified, pixels not inspected in this docs-only pass. Existing modules and test files are reused; no new runtime abstraction or test manifest entry is needed.

### Carry method and attribution

Prefer a **base-to-final-head diff port**. The source contains merge commits, and the last one resolved `model-rows.ts` against Fast metadata. Applying only the original feature commit loses the final regression assertions. Actual `git show -s` commit metadata identifies **Robin Bially <7304732+RobinBially@users.noreply.github.com>** on:

- `7c5b4d918401d086dc633ab941be1ff9f844b13e`: original feature.
- `6c1b8b2d2f0abc4baa6618cea2e485374dda2aeb`: account-qualified and pending-selection regression additions.
- `956eedac439922cf7645f130ef8432833e813a9a`: final merge resolution, parents `e520ee5e437e6fc1d8482f51950722db9b58049a` and the source base above; adds Fast availability assertions in the existing test.

Use `Co-authored-by: Robin Bially <7304732+RobinBially@users.noreply.github.com>` in the carry commit and squash description. Do not blindly cherry-pick merge commits with `-m`. A selective cherry-pick is possible only if the executor separately ports the final merge resolution and compares resulting source delta to the final PR diff.

Read-only `git apply --check --exclude='*.png' .tmp/lane-b/3653.patch` returned 0 against the recorded HEAD. Cached patch and `git diff <source-base> <source-head>` match after normalizing Git's abbreviated index-hash lines. The patch has no binary payload; the future executor must retrieve `docs-site/public/screenshots/manual-openai-model-toggle.png` from the pinned source commit, blob `d8a0dab0de58bdfee4764341465eeff6a41b4dec`, or capture a replacement from the carried-head UI.

## Implementation sequence within this phase

1. Port the validation hunk without moving existing malformed-request or initial-selection-pending checks (`model-routes.ts:531-542`). Preserve mixed native/routed key handling at 593-635 and catalog convergence.
2. Port bare-native row filtering before current Fast annotations; retain combo precedence, account-qualified IDs and export metadata.
3. Port canonical forward-OpenAI grouping and all source regression tests.
4. Update public API documentation and attach honest UI evidence. Update the translated API error rows listed below so they do not imply that 400 is the only rejection contract.
5. Obtain hosted CI and independent review; then main performs authorized stack merge/issue closure.

## Activation and regression matrix

| Scenario / trigger | Observable proof | Owning test/evidence |
|---|---|---|
| Configured manual OpenAI row, `native:false`, enable then disable | 200; namespaced disabled key changes, native key preserved | source-added `tests/codex-integration/model-visibility-management-api.test.ts` |
| Unconfigured routed OpenAI or unsupported native target | 400, no config mutation | same file, retain existing negatives |
| Pending initial selection with configured or unconfigured manual target | 409 `initial_model_selection_pending`, config equal to before | source-added same file; `tests/providers/initial-selection-write-fence.test.ts` |
| Malformed scope while pending | 400 before pending check; no mutation | source-added same file |
| Bare `gpt-5.5` custom/native collision | one manual row with routed selector and 128k metadata | source-added row-list test |
| Exact account-qualified collision `desktop/<fixture>` | account-qualified native survives custom collision and deletion | source-added row-list test |
| Remove manual entries | bare native row returns, qualified row remains | source-added row-list test |
| Replacement enabled / disabled | `fastRowAvailable` true / false, pending also false | final-head source assertions plus existing pending tests |
| Manual-only canonical forward OpenAI group | `nativeProviderGroup:true`, `native:false`; controls remain | `gui/tests/models-native-group-controls.test.ts` |
| Client-config export after replacement, disable, restoration | uses manual selector once; excludes disabled replacement; restores native selector when manual row removed | extend `tests/server/management-client-config-route.test.ts` using existing export fixture; preserve `tests/config/client-config-export.test.ts` coverage |
| Combined group visibility with bare + custom rows | both target kinds accepted atomically; unrelated provider keys unchanged | add explicit mixed group-scope case to existing visibility test if existing fixtures do not cover OpenAI |

The source GUI grouping test exercises data grouping, not a rendered switch. Future browser evidence must show one manual row, toggle success, account-qualified row retention and native controls in the carried version. Use synthetic accounts; record build/head, DOM/API result and screenshot. The source PNG is prior evidence, not proof that the carried build works.

## Docs additions beyond the source diff

The source English API reference at `docs-site/src/content/docs/reference/management-api.md:194-204` is the public SoT. MODIFY each existing locale's `PUT /api/model-visibility` error cell to append `409 initial_model_selection_pending` and refresh/retry guidance; retain existing translated 400 text. Carry the manual-row paragraph's same semantics without changing API identifiers. Exact existing paths:

- MODIFY `docs-site/src/content/docs/fr/reference/management-api.md`.
- MODIFY `docs-site/src/content/docs/ja/reference/management-api.md`.
- MODIFY `docs-site/src/content/docs/ko/reference/management-api.md`.
- MODIFY `docs-site/src/content/docs/ru/reference/management-api.md`.
- MODIFY `docs-site/src/content/docs/tr/reference/management-api.md`.
- MODIFY `docs-site/src/content/docs/zh-cn/reference/management-api.md`.
- MODIFY `docs-site/src/content/docs/zh-tw/reference/management-api.md`.

No GUI copy key is introduced by this patch. Do not alter unrelated locale content or the structure ownership table (`structure/05_gui-and-management-api.md:138`) which already names the correct owner.

## Interphase dependencies and readiness

010 establishes manual/native group identity consumed by 020's context controls and the later #3659 hide/delete layer. 020 is not mechanically dependent on this change, but must preserve 010's appended GUI test and API paragraph. Later #3659 shares `src/server/management/model-routes.ts`; port it after this visibility contract. Current dev changes since the source base do not touch any of these seven source paths.

Live review thread `discussion_r3940553047` is resolved; source final tests include its account-qualified fixture. The out-of-diff 409 documentation request is also carried. No unresolved source review finding was returned. Contributor-reported passes are not our validation. Source Cross-platform CI run **33974042485** and React Doctor run **33974042542** were `action_required`; neither establishes passing product CI. Merge remains blocked on carried-head executed checks, independent review and valid GUI/docs evidence.

## Pinned public source diff

The following is the full textual base-to-head source patch (PNG retrieval is described above). Apply against current owners, not by copying entire stale source files. Plan amendments above add focused coverage/docs; keep them in this same phase.

```diff
diff --git a/docs-site/src/content/docs/reference/management-api.md b/docs-site/src/content/docs/reference/management-api.md
index 784c6e17f5..ae24513a97 100644
--- a/docs-site/src/content/docs/reference/management-api.md
+++ b/docs-site/src/content/docs/reference/management-api.md
@@ -191,12 +191,20 @@ first and submit the returned digest. Prefer quarantine when recovery may be nee
 | `GET /api/models` | Return the dashboard/CLI model rows | `catalog_busy` when gathering is saturated |
 | `GET /api/client-config?client=...` | Build a read-only client config for any supported file integration | 400 unsupported client; 503 catalog unavailable |
 | `PUT /api/disabled-models` | Replace the shared disabled-model list | 400 invalid JSON |
-| `PUT /api/model-visibility` | Atomically change provider- or model-level visibility | 400 invalid provider, scope, target, or body |
+| `PUT /api/model-visibility` | Atomically change provider- or model-level visibility | 400 invalid provider, scope, target, or body; 409 `initial_model_selection_pending` (refresh the model list and retry) |
 | `GET, POST /api/custom-models` | List custom models or add one | 400 invalid fields; 404 provider missing; 409 duplicate model |
 | `PUT, DELETE /api/custom-models/{id}` | Edit or delete one custom model | 400 invalid id/fields; 404 not found; 409 duplicate model |
 | `GET, PUT /api/selected-models` | Read provider allowlists and availability, or replace one allowlist | 400 missing provider/body; 404 unknown provider; PUT 409 `initial_model_selection_pending` |
 | `GET, PUT /api/model-presets` | Read preset summaries or choose preset/all/custom mode | 400 invalid mode or unsupported preset; 404 unknown provider; PUT 409 `initial_model_selection_pending` |
 
+A manual model replaces the Models dashboard row with the same provider and model ID.
+For OpenAI, the manual row keeps `openai/<model>` and supports the same visibility controls
+as other routed models; removing it restores the bare native dashboard row. Explicit
+account-qualified native rows stay separate. This does not rename bare native routes or
+change account entitlements. Non-native OpenAI visibility targets must match a configured
+manual model.
+
+
 Valid PUT requests to `/api/selected-models` and `/api/model-presets` return HTTP 409 with code `initial_model_selection_pending` until a reliable initial model list is available. Refresh model discovery (for example, `GET /api/models`) and retry after it succeeds.
 
 ### OAuth accounts, provider keys, and data-plane keys
diff --git a/gui/src/models-groups.ts b/gui/src/models-groups.ts
index a8d6ddc69c..3e24aaf459 100644
--- a/gui/src/models-groups.ts
+++ b/gui/src/models-groups.ts
@@ -81,7 +81,8 @@ export function buildProviderModelGroups<Row extends { provider: string; native?
         provider,
         rows: providerRows,
         native: providerRows.length > 0 && providerRows.every(row => row.native === true),
-        nativeProviderGroup: providerRows.some(row => row.native === true),
+        nativeProviderGroup: providerRows.some(row => row.native === true)
+          || (provider === "openai" && configured?.authMode === "forward"),
         liveModels: configured?.liveModels !== false,
         configuredModels: configured?.models ?? [],
         contextWindow: configured?.contextWindow,
diff --git a/gui/tests/models-native-group-controls.test.ts b/gui/tests/models-native-group-controls.test.ts
index ffd27ad17f..14c2f2c6d8 100644
--- a/gui/tests/models-native-group-controls.test.ts
+++ b/gui/tests/models-native-group-controls.test.ts
@@ -98,3 +98,9 @@ test("the native group exposes the context modal alongside the custom-model and
   // The custom-add and cap controls no longer sit behind an isNative guard.
   expect(src).not.toMatch(/\{!isNative && </);
 });
+
+test("the canonical OpenAI card keeps its identity when every visible row is custom", () => {
+  const groups = buildProviderModelGroups([customRow("gpt-5.5")], [{name:"openai",authMode:"forward"}]);
+  expect(groups[0]!.nativeProviderGroup).toBe(true);
+  expect(groups[0]!.native).toBe(false);
+});
diff --git a/src/server/management/model-routes.ts b/src/server/management/model-routes.ts
index e9ea26a90e..c3e9d58cf9 100644
--- a/src/server/management/model-routes.ts
+++ b/src/server/management/model-routes.ts
@@ -566,7 +566,10 @@ export async function handleModelRoutes(ctx: ManagementContext): Promise<Respons
       }
       const id = value.id.trim();
       const native = value.native === true;
-      if (!id || (provider === "openai") !== native || (native && !supportedNative.has(id))) {
+      const configuredOpenAiCustom = provider === "openai" && !native && providerConfig
+        && (config.customModels ?? []).some(model => model.provider === provider && model.modelId === id);
+      if (!id || (native && (provider !== "openai" || !supportedNative.has(id)))
+        || (provider === "openai" && !native && !configuredOpenAiCustom)) {
         return jsonResponse({ error: "invalid model visibility target" }, 400);
       }
       const key = `${native ? "native" : "routed"}:${id}`;
diff --git a/src/server/management/model-rows.ts b/src/server/management/model-rows.ts
index 4a3fbeaa64..4635a9fbfd 100644
--- a/src/server/management/model-rows.ts
+++ b/src/server/management/model-rows.ts
@@ -169,7 +169,11 @@ export async function listManagementModelRows(
       ...(contextCap !== undefined ? { contextCap, contextCapped: m.contextCapped === true } : {}),
     };
   }).filter((row): row is ManagementModelRow => row !== null);
-  const rows = [...native, ...dedupedRouted, ...visibleCustomModels];
+  // Manual OpenAI rows retain their routed selector but replace the bare dashboard row.
+  // Account-qualified rows remain distinct, explicitly selected routes.
+  const visibleNative = native.filter(model => model.id.includes("/")
+    || !customNamespaced.has(routedSlug(model.provider, model.id)));
+  const rows = [...visibleNative, ...dedupedRouted, ...visibleCustomModels];
   // Include disabled rows and configured aliases before the export visibility filter:
   // a hidden real `x--fast` must never become a synthetic selector for another model.
   const knownIds = config.fastRows === false ? new Set<string>() : knownEffortRowIds(config);
diff --git a/tests/codex-integration/model-visibility-management-api.test.ts b/tests/codex-integration/model-visibility-management-api.test.ts
index 6259818667..15bc17f808 100644
--- a/tests/codex-integration/model-visibility-management-api.test.ts
+++ b/tests/codex-integration/model-visibility-management-api.test.ts
@@ -1,5 +1,5 @@
 import { afterEach, beforeEach, describe, expect, test } from "bun:test";
-import { existsSync, mkdirSync} from "node:fs";
+import { existsSync, mkdirSync, writeFileSync } from "node:fs";
 import { join } from "node:path";
 import { nativeModelRows } from "../../src/codex/catalog";
 import { loadConfig, saveConfig } from "../../src/config";
@@ -7,6 +7,8 @@ import { handleManagementAPI } from "../../src/server/management-api";
 import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
 import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
 import { removeTreeWithRetry } from "../helpers/remove-tree";
+import { ManagementRequest as Request } from "../helpers/management-auth";
+import { listManagementModelRows } from "../../src/server/management/model-rows";
 
 const TEST_DIR = join(import.meta.dir, `.tmp-model-visibility-management-${process.pid}`);
 const previousOpencodexHome = process.env.OPENCODEX_HOME;
@@ -365,4 +367,77 @@ describe("atomic model visibility management", () => {
     expect(loadConfig()).toEqual(before);
   });
 });
-import { ManagementRequest as Request } from "../helpers/management-auth";
+
+test("configured manual OpenAI rows can be toggled alongside native rows", async () => {
+  const config = loadConfig();
+  config.providers.openai = {adapter:"openai-responses",authMode:"forward",baseUrl:"https://chatgpt.com/backend-api/codex",liveModels:false};
+  config.customModels = [{id:"manual-gpt",provider:"openai",modelId:"gpt-5.5",contextWindow:128_000}];
+  config.disabledModels = ["openai/gpt-5.5", "gpt-5.4"];
+  expect((await putWithConfig({scope:"models",provider:"openai",targets:[{id:"gpt-5.5",native:false}],enabled:true},config)).status).toBe(200);
+  expect(config.disabledModels).toEqual(["gpt-5.4"]);
+  expect((await putWithConfig({scope:"models",provider:"openai",targets:[{id:"gpt-5.5",native:false},{id:"gpt-5.4",native:true}],enabled:false},config)).status).toBe(200);
+  expect(config.disabledModels).toContain("openai/gpt-5.5");
+  expect(config.disabledModels).toContain("gpt-5.4");
+  expect((await putWithConfig({scope:"models",provider:"openai",targets:[{id:"not-configured",native:false}],enabled:true},config)).status).toBe(400);
+});
+
+test("manual models replace management rows with the same provider/id and deletion restores natives", async () => {
+  const config = loadConfig();
+  config.providers.openai = {adapter:"openai-responses",authMode:"forward",baseUrl:"https://chatgpt.com/backend-api/codex",liveModels:false};
+  config.customModels = [
+    {id:"manual-gpt",provider:"openai",modelId:"gpt-5.5",contextWindow:128_000},
+    {id:"manual-google",provider:"google-antigravity",modelId:"gemini-3.1-pro",contextWindow:128_000},
+  ];
+  config.codexAccountNamespaces = { desktop: "@main" };
+  config.codexAccountPickerEnabled = true;
+  const accountModel = "gpt-5.5-account-fixture";
+  const qualifiedId = `desktop/${accountModel}`;
+  writeFileSync(join(isolatedCodexHome!.path, "models_cache.json"), JSON.stringify({
+    models: [{
+      slug: accountModel, supported_in_api: true, visibility: "list",
+      base_instructions: "You are Codex.", comp_hash: null, shell_type: "unified_exec",
+      supported_reasoning_levels: [{ effort: "medium" }], model_messages: {},
+    }],
+  }));
+  // Even an exact qualified-ID collision must preserve the account-bound native route.
+  config.customModels.push({ id: "manual-qualified", provider: "openai", modelId: qualifiedId });
+  const rows = await listManagementModelRows(config,{entitlementWaitMs:0});
+  expect(rows.filter(row=>row.provider==="openai" && row.id==="gpt-5.5")).toEqual([
+    expect.objectContaining({namespaced:"openai/gpt-5.5",custom:true,customId:"manual-gpt",contextWindow:128_000,fastRowAvailable:true}),
+  ]);
+  expect(rows.filter(row=>row.provider==="google-antigravity" && row.id==="gemini-3.1-pro")).toHaveLength(1);
+  expect(rows.filter(row => row.id === qualifiedId && row.native)).toEqual([
+    expect.objectContaining({ namespaced: qualifiedId, provider: "openai", native: true }),
+  ]);
+  config.disabledModels = ["openai/gpt-5.5"];
+  const disabledRows = await listManagementModelRows(config, { entitlementWaitMs: 0 });
+  expect(disabledRows.find(row => row.namespaced === "openai/gpt-5.5")).toMatchObject({
+    custom: true, disabled: true, fastRowAvailable: false,
+  });
+  config.disabledModels = [];
+  config.customModels = [];
+  const restored = await listManagementModelRows(config,{entitlementWaitMs:0});
+  expect(restored.some(row => row.id === qualifiedId && row.native)).toBe(true);
+  expect(restored.filter(row=>row.provider==="openai" && row.id==="gpt-5.5")).toEqual([
+    expect.objectContaining({namespaced:"gpt-5.5",native:true}),
+  ]);
+});
+
+test("manual OpenAI visibility preserves the pending-selection error contract", async () => {
+  const config = loadConfig();
+  config.providers.openai = {
+    adapter: "openai-responses", authMode: "forward", liveModels: false,
+    baseUrl: "https://chatgpt.com/backend-api/codex",
+    initialModelSelection: { version: 1, registrationId: "11111111-1111-4111-8111-111111111111", status: "pending" },
+  };
+  config.customModels = [{ id: "manual-gpt", provider: "openai", modelId: "gpt-5.5" }];
+  const before = structuredClone(config);
+  for (const target of [{ id: "gpt-5.5", native: false }, { id: "not-configured", native: false }]) {
+    const response = await putWithConfig({ scope: "models", provider: "openai", targets: [target], enabled: true }, config);
+    expect(response.status).toBe(409);
+    expect(await response.json()).toMatchObject({ code: "initial_model_selection_pending" });
+    expect(config).toEqual(before);
+  }
+  expect((await putWithConfig({ scope: "invalid", provider: "openai", targets: [], enabled: true }, config)).status).toBe(400);
+  expect(config).toEqual(before);
+});
```
