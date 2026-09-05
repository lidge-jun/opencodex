# 050 — Effective provider capabilities (#3671)

## Implementation-cycle completion versus landing

This decade cycle ends with a reviewed prepared draft PR, exact-carried-head focused remote activation evidence and remote typecheck, with full CI dispatched. That cycle D does not claim the bug shipped, full CI passed, or an issue resolved. `080_landing.md` retains the mandatory full current-head cross-platform/type/privacy/docs evidence, review, dev ancestry and immediate source-PR/fully-resolved-issue closure gates. Later P consumes the verified prepared stack parent; it need not have landed yet. Only final landing yields feature DONE.


## Candidate implementation contract

Status: candidate planning, not implementation or merge approval. Revalidate at this layer's later P after its lower stack layer lands. This document is the delegated docs-only deliverable; the main agent owns roadmap registration, FSM, goal state, branch integration, CI dispatch and closure.

- Class: C4 for the policy-boundary slice, based on the public PR's requested security review. Archetype: spec-satisfaction repair.
- Trigger: routing policy capability evidence must describe the effective provider dispatch uses, including unavailability.
- Goal: runtime selection and ordinary management dry-run agree on effective transport capabilities and exclude unresolved, missing, or disabled providers before scoring.
- Non-goals: new provider metadata, registry precedence redesign, catalog UI, OAuth refresh, request transport changes, Lab activation changes, release operations, or changing caller-supplied synthetic dry-run evidence semantics.
- Verifier: remote focused routing/API regressions plus exact-head full Cross-platform CI and a remote documentation build. No local tests, typecheck, builds, or verifier execution in this planning assignment.
- Stop: independently working reviewed draft with original authorship and exact-head remote focused/type evidence. Full current-head gates/dev ancestry remain required by 080.
- Memory artifact: this document and the main-owned roadmap/evidence ledger.
- Outcomes: DONE only after verified dev integration; NOOP only if current dev independently contains all behavior and regressions; BLOCKED for unavailable external CI/credentials; NEEDS_HUMAN/UNSAFE for a policy decision outside authorization; a resource checkpoint is reassessment, never fabricated completion.
- Delegation: inherited parallel read-only reviewers are authorized. Main reclaims a packet after two distinct failed workers; further write delegation requires a P amendment with exact ownership.
- Resources: existing gh credentials; future writes confined to the main's own stack branches and explicitly authorized PR/issue integration. This worker writes only this document. No explicit user token/cost cap. A two-hour checkpoint triggers reassessment and an evidence update. No deployment, account-state operation or provider request is necessary.

## Provenance and refresh gate

Inspected September 6, 2026 KST using read-only `gh pr view`, `gh api` reviews/workflow runs, `git show`, and `git diff`.

- Public PR: https://github.com/lidge-jun/opencodex/pull/3671
- Exact original head: `7b1beb9c5eacd8dde22681a5df26804be52380b8`.
- Stable source ref: `refs/codex/a-original/3671`; old `origin/a-original-*` refs were pruned by parallel workers and must not be relied upon.
- Original base: `6585e6a70f42be8b6c81ff20d4fa0f39f7da03db`.
- Inspected current dev/tree: `81871b3fa7034250b8d5ba2cbbfde44e40f0e69c`.
- Original commits, oldest first: `2b1e0e00c12d7287f9324a4a39ec7e966712affe` (effective capability evidence); `7b1beb9c5eacd8dde22681a5df26804be52380b8` (unresolved transport exclusion).
- Both commits authored by **Hako <25837994+devswha@users.noreply.github.com>**, GitHub `@devswha`. Preserve those authors when carrying commits. Any squash/reimplementation and the carrying PR must retain `Co-authored-by: Hako <25837994+devswha@users.noreply.github.com>` so attribution survives integration.
- A read-only diff of original base against inspected dev shows no drift in the eight original touched files. This is a snapshot, not a promise about the later stack parent.
- #3679's refreshed source head is `b05cccf264b4ab61db5d8dee8232c2f89bb1b541`; it does not replace #3671 provenance. Re-read parent changes and resolve integration ownership at later P.

At later P, compare live PR head, stable ref, actual stack parent and dev tip. Inspect each named source hunk and public review again. If any changed, amend this document before carrying the patch. Treat stacked ordering as a user-requested integration constraint; #3671 does not need #3568/#3581 runtime code to function and must be independently testable.

## Source ownership and before/after map

Reuse the existing `routedProviderConfig` callback seam; no new resolver, registry, server endpoint or config option is required. Doing nothing leaves policy and effective transport divergent; changing configured URLs or deleting capability checks does not fix the contract; duplicating registry logic creates drift.

| Operation | Exact path | Before → after |
|---|---|---|
| MODIFY | `src/routing/capability.ts` | Lines 153–160 read raw config plus registry by name → optional resolved-provider argument is authoritative; name-only registry fallback applies only to legacy three-argument callers. Add provider-wide reasoning ladder at lines 223–227, retaining no-reasoning precedence. |
| MODIFY | `src/routing/compatibility/assemble.ts` | Lines 52–60 derive capabilities directly → resolve each active configured candidate through the supplied callback, emit bounded unavailability state on missing/disabled/throw, and compute capabilities only from a resolved provider. |
| MODIFY | `src/routing/evaluator.ts` | Evidence type near line 54 and eligibility lines 280–313 lack transport status → optional `routeResolutionFailed`, `route-unavailable` exclusion and hard eligibility gate independent of unknown policy. |
| MODIFY | `tests/routing/routing-capability-model-matching.test.ts` | Existing model-family tests → retain them and add the complete original effective-transport regression group plus missing/disabled selection regressions below. |
| MODIFY | `tests/routing/routing-profile.test.ts` | Existing management dry-run parity fixture at line 446 → add ordinary dry-run missing/disabled candidate matrix without injected `candidates`. |
| MODIFY | `docs-site/src/content/docs/guides/routing-profile-editor.md` | Dry-run section near line 39 lacks effective transport contract → original explanation plus explicit missing/disabled exclusion. |
| MODIFY | `docs-site/src/content/docs/fr/guides/routing-profile-editor.md` | Same change in French near line 38, preserving corrected typographic apostrophe. |
| MODIFY | `docs-site/src/content/docs/tr/guides/routing-profile-editor.md` | Same change in Turkish near line 53. Original trailing blank-line removal is incidental. |
| MODIFY | `docs-site/src/content/docs/zh-tw/guides/routing-profile-editor.md` | Same change in Traditional Chinese near line 33. |
| MODIFY | `structure/01_runtime.md` | Router ownership row at line 18 says selection only → describe shared effective-provider evidence and hard unavailable-candidate exclusion. |
| NEW | None in production/tests | Existing test files already have layout entries; do not add layout manifest churn. |

Only this plan file is created now. The future layer has ten MODIFY paths. General SOT follows `structure/01_runtime.md`; user-facing truth remains the routing guide. No unpublished investigation details belong in this public unit.

Read-only caller proof: `src/router.ts:299` owns effective registry transport/metadata; `src/router.ts:622` supplies it to assembly and line 625 evaluates; lines 626–635 route the selected provider or throw. `src/server/management/routing-profile-routes.ts:100` supplies the same resolver; lines 384–390 use assembly when `body.candidates` is absent. Preserve the synthetic-evidence branch. `src/routing/capability.ts:130` classifies effective locality; lines 179–193 preserve no-vision precedence. Core/Lab imports remain behind the existing provider slot (`assemble.ts:45`), with no new import of router from assembly.

## Public review disposition

Two prior findings are resolved in original head: French typography and thrown route resolution under permissive unknown policy. One remains open: https://github.com/lidge-jun/opencodex/pull/3671#discussion_r3941006079 . At original-head `assemble.ts:57`, missing/disabled providers skip the resolver but leave failure false. Set the initial state to `!provider || provider.disabled === true` and prove both ordinary dry-run and runtime selection. Do not resolve the review on the basis of this plan.

Current original-head Cross-platform CI run `33973108478` and React Doctor run `33973108496` have conclusion `action_required`; label/hygiene/target success is not product verification. The PR body reports focused successes and a timeout-adjusted affected run, but explicitly does not claim a green default full suite. No such reported run is accepted as this carried layer's verification. Maintainer approval and explicit security review remain pending under `MAINTAINERS.md:57–61`.

## Exact original carry diff

Apply this public source patch as one coherent layer, preserving both original commits/author identity. The subsequent corrections below are required in the same layer before review readiness. This is recorded patch text, not an instruction to run local Git mutations during planning.

````diff
diff --git a/docs-site/src/content/docs/fr/guides/routing-profile-editor.md b/docs-site/src/content/docs/fr/guides/routing-profile-editor.md
index b437c28b3..84b4410f7 100644
--- a/docs-site/src/content/docs/fr/guides/routing-profile-editor.md
+++ b/docs-site/src/content/docs/fr/guides/routing-profile-editor.md
@@ -37,6 +37,13 @@ résultat du plafond.
 
 ## Simuler un profil enregistré
 
+Les capacités des candidats utilisent la configuration effective du fournisseur,
+après application du registre. Les exigences de localité (`localOnly` et
+`remoteAllowed`) utilisent donc l’adresse amont effective. Si elle ne peut pas être
+classée, `unknownEvidence.capability` détermine l’admissibilité du candidat.
+Une configuration de fournisseur invalide qui ne peut pas être résolue est toujours
+exclue avec `route-unavailable`, même si les capacités inconnues sont autorisées.
+
 Sélectionnez un profil enregistré et utilisez **Évaluation à sec** pour ajouter des éléments propres à la requête, tels que la taille de la fenêtre de contexte, l’utilisation d’outils, l’entrée d’images ou la sortie structurée. La simulation évalue l’admissibilité et la notation, mais n’envoie jamais de requête à un modèle en amont.
 
 Les modifications non enregistrées ne sont pas prises en compte par la simulation. Enregistrez d’abord le profil afin que la révision et l’évaluation affichées correspondent à la même configuration.
diff --git a/docs-site/src/content/docs/guides/routing-profile-editor.md b/docs-site/src/content/docs/guides/routing-profile-editor.md
index 5cf5fc6d7..7931f29ad 100644
--- a/docs-site/src/content/docs/guides/routing-profile-editor.md
+++ b/docs-site/src/content/docs/guides/routing-profile-editor.md
@@ -38,6 +38,13 @@ cap outcome.
 
 ## Dry-run a saved profile
 
+Candidate capabilities use the effective provider configuration after registry
+overrides are applied. Locality requirements (`localOnly` and `remoteAllowed`)
+therefore use the effective upstream address. If that address cannot be classified,
+the profile's `unknownEvidence.capability` setting decides eligibility.
+An invalid provider configuration that cannot be resolved is always excluded with
+`route-unavailable`, even when unknown capabilities are allowed.
+
 Select a saved profile and use **Dry-run evaluation** to add request evidence such as context-window size, tool use, image input, or structured output. Dry-run evaluates eligibility and scoring but never sends an upstream model request.
 
 Unsaved edits are not used by dry-run. Save the profile first so the displayed revision and evaluation refer to the same configuration.
diff --git a/docs-site/src/content/docs/tr/guides/routing-profile-editor.md b/docs-site/src/content/docs/tr/guides/routing-profile-editor.md
index dd7aa50d7..ec75bdd17 100644
--- a/docs-site/src/content/docs/tr/guides/routing-profile-editor.md
+++ b/docs-site/src/content/docs/tr/guides/routing-profile-editor.md
@@ -52,6 +52,13 @@ ayrıdır.
 
 ## Kaydedilmiş bir profilde deneme çalıştırması (dry-run) yapma
 
+Aday yetenekleri, kayıt defteri kuralları uygulandıktan sonraki etkin sağlayıcı
+yapılandırmasını kullanır. Yerellik gereksinimleri (`localOnly` ve `remoteAllowed`)
+bu nedenle etkin üst sunucu adresine göre değerlendirilir. Adres sınıflandırılamıyorsa,
+adayın uygunluğunu profilin `unknownEvidence.capability` ayarı belirler.
+Çözümlenemeyen geçersiz sağlayıcı yapılandırmaları, bilinmeyen yeteneklere izin
+verilse bile `route-unavailable` ile her zaman dışlanır.
+
 Kaydedilmiş bir profili seçin ve bağlam penceresi boyutu, araç kullanımı, görsel
 girişi veya yapılandırılmış çıktı gibi istek kanıtları eklemek için **Deneme
 çalıştırması değerlendirmesi (Dry-run evaluation)**'ı kullanın. Deneme
@@ -99,5 +106,3 @@ Düzenleyici şu uç noktaları kullanır:
   }
 }
 ```
-
-
diff --git a/docs-site/src/content/docs/zh-tw/guides/routing-profile-editor.md b/docs-site/src/content/docs/zh-tw/guides/routing-profile-editor.md
index e6ae93a76..0b54e70d5 100644
--- a/docs-site/src/content/docs/zh-tw/guides/routing-profile-editor.md
+++ b/docs-site/src/content/docs/zh-tw/guides/routing-profile-editor.md
@@ -32,6 +32,9 @@ OpenCodex 儀表板中的 **Models → Routing** 分頁可以直接管理 `confi
 
 ## 試跑已儲存的設定檔
 
+候選能力使用套用 registry 覆寫後的有效供應商設定。因此，本地性需求（`localOnly` 與 `remoteAllowed`）會依據實際上游位址判定。若無法分類該位址，則由設定檔的 `unknownEvidence.capability` 決定候選是否合格。
+無法解析的無效供應商設定一律以 `route-unavailable` 排除，即使原則允許未知能力也是如此。
+
 選取一個已儲存的設定檔，使用 **Dry-run evaluation** 加入請求證據，例如 context-window 大小、工具使用、圖片輸入或結構化輸出。試跑會評估資格與評分，但永遠不會送出上游模型請求。
 
 未儲存的編輯不會被試跑使用。請先儲存設定檔，讓顯示的 revision 與評估參照同一份設定。
diff --git a/src/routing/capability.ts b/src/routing/capability.ts
index 8495951a0..7f26e8bbd 100644
--- a/src/routing/capability.ts
+++ b/src/routing/capability.ts
@@ -10,7 +10,7 @@
  * how that affects eligibility.
  */
 
-import { modelInList, type OcxConfig } from "../types";
+import { modelInList, type OcxConfig, type OcxProviderConfig } from "../types";
 import { isCanonicalOpenAiForwardProvider, OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers";
 import { serviceTierSupportForModel } from "../providers/service-tier";
 import { PROVIDER_REGISTRY } from "../providers/registry";
@@ -149,14 +149,20 @@ function localRemoteEvidence(baseUrl: string | undefined): Pick<RouteCapabilityE
  * Assemble canonical capability evidence for one `provider/model` candidate.
  * Sources (in priority order): provider config maps, provider registry hints,
  * cached Codex catalog row, native-model metadata.
+ * Policy assembly supplies the resolved provider so every transport capability
+ * describes the destination dispatch will use. Its maps already include applicable
+ * registry defaults; name-only registry fallbacks must not override that authority.
  */
 export function candidateCapabilityEvidence(
   config: OcxConfig,
   providerName: string,
   modelId: string,
+  resolvedProvider?: OcxProviderConfig,
 ): RouteCapabilityEvidence {
-  const provider = config.providers[providerName];
-  const registryEntry = PROVIDER_REGISTRY.find(entry => entry.id === providerName);
+  const provider = resolvedProvider ?? config.providers[providerName];
+  const registryEntry = resolvedProvider === undefined
+    ? PROVIDER_REGISTRY.find(entry => entry.id === providerName)
+    : undefined;
   const catalogRow = cachedCatalogModels().find(model => model.provider === providerName && model.id === modelId);
   const isNative = providerName === OPENAI_CODEX_PROVIDER_ID && !modelId.includes("/");
 
@@ -224,6 +230,7 @@ export function candidateCapabilityEvidence(
     ? []
     : modelRecordValue(provider?.modelReasoningEfforts, modelId)
       ?? modelRecordValue(registryEntry?.modelReasoningEfforts, modelId)
+      ?? provider?.reasoningEfforts
       ?? (isNative ? nativeReasoningEfforts(modelId) : undefined);
 
   const tierSupport = provider
diff --git a/src/routing/compatibility/assemble.ts b/src/routing/compatibility/assemble.ts
index 1d543690a..d7cebc94b 100644
--- a/src/routing/compatibility/assemble.ts
+++ b/src/routing/compatibility/assemble.ts
@@ -52,11 +52,26 @@ export function assemblePolicyCandidateEvidence(
   return profile.candidates.map(candidate => {
     const key = `${candidate.provider}/${candidate.model}`;
     const compatibility = compatibilityByCandidate?.get(key);
+    const provider = config.providers[candidate.provider];
+    let routed: OcxProviderConfig | undefined;
+    let routeResolutionFailed = false;
+    if (provider && provider.disabled !== true) {
+      try {
+        routed = options.routedProviderConfig(candidate.provider, provider);
+      } catch {
+        // This is known unavailability, not unknown capability evidence. Keep
+        // the failure separate so permissive unknown policies cannot select it.
+        routeResolutionFailed = true;
+      }
+    }
 
     return {
       provider: candidate.provider,
       model: candidate.model,
-      capability: candidateCapabilityEvidence(config, candidate.provider, candidate.model),
+      ...(routeResolutionFailed ? { routeResolutionFailed: true } : {}),
+      capability: routed
+        ? candidateCapabilityEvidence(config, candidate.provider, candidate.model, routed)
+        : undefined,
       health: policyCandidateHealthEvidence(config, candidate, now),
       quota: quotaEvidenceForCandidate({
         provider: candidate.provider,
diff --git a/src/routing/evaluator.ts b/src/routing/evaluator.ts
index a07b83306..7cf801bfe 100644
--- a/src/routing/evaluator.ts
+++ b/src/routing/evaluator.ts
@@ -54,6 +54,8 @@ export interface PolicyCandidateEvidence {
   accountRef?: string;
   /** Codex pool account id (provider "openai"); used to derive account-scoped quota evidence. */
   codexAccountId?: string;
+  /** A failed effective-transport resolution excludes the candidate under every unknown policy. */
+  routeResolutionFailed?: boolean;
   capability?: RouteCapabilityEvidence;
   health?: RouteHealthEvidence;
   quota?: RouteQuotaEvidence;
@@ -278,6 +280,8 @@ export function evaluatePolicyProfile(
       ...requestRequirementFor(requestEvidence, evidence.capability),
     ];
     const exclusions: RouteExclusionReason[] = [];
+    const routeUnavailable = evidence.routeResolutionFailed === true;
+    if (routeUnavailable) exclusions.push({ code: "route-unavailable" });
     const bad = unsatisfiedOrUnknown(requirements);
     for (const requirement of bad) {
       if (requirement.outcome === "unsatisfied") {
@@ -310,7 +314,7 @@ export function evaluatePolicyProfile(
     if (unknownCostBlocked) {
       exclusions.push({ code: "cost-limit-unknown", detail: "maxEstimatedCostUsd" });
     }
-    let eligible = !unsatisfied && !excludedByUnknown && !overCostLimit && !unknownCostBlocked;
+    let eligible = !routeUnavailable && !unsatisfied && !excludedByUnknown && !overCostLimit && !unknownCostBlocked;
 
     // Trace/dry-run copy only: report the profile cap that was applied and the
     // operator-visible outcome. Do not feed this copy into costScore() — that
diff --git a/tests/routing/routing-capability-model-matching.test.ts b/tests/routing/routing-capability-model-matching.test.ts
index bb956c2d8..509eeec2e 100644
--- a/tests/routing/routing-capability-model-matching.test.ts
+++ b/tests/routing/routing-capability-model-matching.test.ts
@@ -1,10 +1,19 @@
-import { describe, expect, test } from "bun:test";
+import { afterEach, beforeEach, describe, expect, test } from "bun:test";
+import { mkdtempSync } from "node:fs";
+import { tmpdir } from "node:os";
+import { join } from "node:path";
+import { validateConfigCandidate } from "../../src/config";
+import { NoEligiblePolicyCandidateError, routeModel, routedProviderConfig } from "../../src/router";
 import { candidateCapabilityEvidence } from "../../src/routing/capability";
+import { assemblePolicyCandidateEvidence } from "../../src/routing/compatibility/assemble";
 import { evaluatePolicyProfile } from "../../src/routing/evaluator";
+import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
+import { getRoutingProfile } from "../../src/routing/profile";
 import { PROVIDER_REGISTRY } from "../../src/providers/registry";
 import { modelRecordValue } from "../../src/reasoning-effort";
 import { isModelTextOnly } from "../../src/vision";
-import type { OcxConfig, OcxProviderConfig } from "../../src/types";
+import type { OcxConfig, OcxProviderConfig, OcxRoutingProfileConfig } from "../../src/types";
+import { removeTreeWithRetry } from "../helpers/remove-tree";
 
 /**
  * `candidateCapabilityEvidence` describes what the resolver will do with a candidate,
@@ -35,6 +44,224 @@ function configFor(provider: OcxProviderConfig): OcxConfig {
   return { providers: { custom: provider } } as unknown as OcxConfig;
 }
 
+describe("policy capability evidence uses the effective provider", () => {
+  let testDir: string;
+  let previousHome: string | undefined;
+
+  beforeEach(() => {
+    previousHome = process.env.OPENCODEX_HOME;
+    testDir = mkdtempSync(join(tmpdir(), "ocx-effective-capability-"));
+    process.env.OPENCODEX_HOME = testDir;
+  });
+
+  afterEach(() => {
+    closeRequestHistoryIndex();
+    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
+    else process.env.OPENCODEX_HOME = previousHome;
+    removeTreeWithRetry(testDir);
+  });
+
+  function policyConfig(
+    name: string,
+    provider: OcxProviderConfig,
+    model: string,
+    require: OcxRoutingProfileConfig["require"],
+  ): OcxConfig {
+    const result = validateConfigCandidate({
+      port: 10100,
+      defaultProvider: name,
+      providers: { [name]: provider },
+      routingProfiles: { guarded: { candidates: [{ provider: name, model }], require } },
+    });
+    if (!result.ok) throw new Error(result.error);
+    return result.config;
+  }
+
+  const localOnly = { localOnly: true, remoteAllowed: false };
+  const loopback = "http://127.0.0.1:11434/v1";
+
+  test("a loopback URL discarded by registry routing cannot satisfy a local-only policy", () => {
+    const config = policyConfig("deepseek", {
+      adapter: "openai-chat", baseUrl: loopback, allowPrivateNetwork: true,
+    }, "deepseek-v4-flash", localOnly);
+    const before = structuredClone(config);
+
+    expect(routeModel(config, "deepseek/deepseek-v4-flash").provider.baseUrl)
+      .toBe("https://api.deepseek.com");
+    expect(() => routeModel(config, "policy/guarded")).toThrow(NoEligiblePolicyCandidateError);
+    expect(config).toEqual(before);
+  });
+
+  test.each(["custom-local", "ollama"])("a genuine local %s endpoint remains eligible", name => {
+    const config = policyConfig(name, {
+      adapter: "openai-chat", baseUrl: loopback, allowPrivateNetwork: true,
+    }, "local-model", localOnly);
+    const before = structuredClone(config);
+
+    const route = routeModel(config, "policy/guarded");
+    expect(route.providerName).toBe(name);
+    expect(route.provider.baseUrl).toBe(loopback);
+    expect(route.routeDecision?.requirements).toEqual([
+      { id: "local-only", expected: true, actual: true, outcome: "satisfied" },
+      { id: "remote-allowed", expected: false, actual: false, outcome: "satisfied" },
+    ]);
+    expect(config).toEqual(before);
+  });
+
+  test("an explicitly public endpoint remains ineligible for a local-only policy", () => {
+    const config = policyConfig("deepseek", {
+      adapter: "openai-chat", baseUrl: "https://api.deepseek.com",
+    }, "deepseek-v4-flash", localOnly);
+    expect(() => routeModel(config, "policy/guarded")).toThrow(NoEligiblePolicyCandidateError);
+  });
+
+  test("a local candidate is selected after excluding a registry-pinned remote candidate", () => {
+    const config = policyConfig("deepseek", {
+      adapter: "openai-chat", baseUrl: loopback, allowPrivateNetwork: true,
+    }, "deepseek-v4-flash", localOnly);
+    config.providers.local = { adapter: "openai-chat", baseUrl: loopback, allowPrivateNetwork: true };
+    config.routingProfiles!.guarded!.candidates.push({ provider: "local", model: "local-model" });
+
+    const route = routeModel(config, "policy/guarded");
+    expect(route.providerName).toBe("local");
+    expect(route.provider.baseUrl).toBe(loopback);
+    expect(route.routeDecision?.candidates.map(candidate => candidate.eligible)).toEqual([false, true]);
+  });
+
+  test("registry no-vision defaults participate before policy image requirements", () => {
+    const config = policyConfig("deepseek", {
+      adapter: "openai-chat", baseUrl: "https://api.deepseek.com",
+      modelInputModalities: { "deepseek-v4-flash": ["text", "image"] },
+    }, "deepseek-v4-flash", { imageInput: true });
+    const routed = routeModel(config, "deepseek/deepseek-v4-flash");
+    expect(isModelTextOnly(routed.provider, routed.modelId)).toBe(true);
+    expect(() => routeModel(config, "policy/guarded")).toThrow(NoEligiblePolicyCandidateError);
+  });
+
+  test("the effective model context ceiling gates a policy requirement", () => {
+    const config = policyConfig("openai-apikey", {
+      adapter: "openai-responses", baseUrl: "https://api.openai.com/v1",
+      modelContextWindows: { "gpt-6-astra": 2_000_000 },
+    }, "gpt-6-astra", { minContextWindow: 1_500_000 });
+    const routed = routeModel(config, "openai-apikey/gpt-6-astra");
+    expect(routed.provider.modelContextWindows?.["gpt-6-astra"]).toBe(1_050_000);
+    expect(() => routeModel(config, "policy/guarded")).toThrow(NoEligiblePolicyCandidateError);
+  });
+
+  test("canonical forward auth filled by routing satisfies the encrypted-task requirement", () => {
+    const config = policyConfig("openai", {
+      adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex",
+    }, "gpt-5.5", { encryptedCodexTasks: true });
+
+    const route = routeModel(config, "policy/guarded");
+    expect(route.provider.authMode).toBe("forward");
+    expect(route.routeDecision?.candidates[0]?.capability?.encryptedCodexTasks).toBe(true);
+    expect(config.providers.openai!.authMode).toBeUndefined();
+  });
+
+  test("the effective provider-wide reasoning ladder participates in policy selection", () => {
+    const config = policyConfig("xiaomi-mimo", {
+      adapter: "openai-chat", baseUrl: "https://api.xiaomimimo.com/v1",
+    }, "mimo-v2.5", { reasoningEffort: "high" });
+
+    const route = routeModel(config, "policy/guarded");
+    expect(route.provider.reasoningEfforts).toEqual(["low", "medium", "high"]);
+    expect(route.routeDecision?.candidates[0]?.capability?.reasoningEfforts)
+      .toEqual(["low", "medium", "high"]);
+    expect(config.providers["xiaomi-mimo"]!.reasoningEfforts).toBeUndefined();
+  });
+
+  test("a same-named custom transport does not inherit an unrelated registry model map", () => {
+    const config = policyConfig("meta-model", {
+      adapter: "openai-responses", baseUrl: "https://custom.example/v1",
+    }, "muse-spark-1.3", { reasoningEffort: "high" });
+    const routed = routeModel(config, "meta-model/muse-spark-1.3");
+    expect(routed.provider.baseUrl).toBe("https://custom.example/v1");
+    expect(routed.provider.modelReasoningEfforts).toBeUndefined();
+    expect(() => routeModel(config, "policy/guarded")).toThrow(NoEligiblePolicyCandidateError);
+  });
+
+  test("an invalid unselected transport cannot prevent a healthy sibling from routing", () => {
+    const config = policyConfig("local", {
+      adapter: "openai-chat", baseUrl: loopback, allowPrivateNetwork: true,
+    }, "local-model", {});
+    config.providers.ollama = { adapter: "openai-chat", baseUrl: " " };
+    config.routingProfiles!.guarded!.candidates.push({ provider: "ollama", model: "local-model" });
+
+    const route = routeModel(config, "policy/guarded");
+    expect(route.providerName).toBe("local");
+    expect(route.provider.baseUrl).toBe(loopback);
+    expect(route.routeDecision?.candidates[1]?.capability).toBeUndefined();
+  });
+
+  test("an unresolved transport contributes no positive capability evidence", () => {
+    const config = policyConfig("ollama", {
+      adapter: "openai-chat", baseUrl: loopback,
+      modelInputModalities: { "local-model": ["text", "image"] },
+    }, "local-model", { imageInput: true });
+    config.providers.ollama!.baseUrl = " ";
+
+    const evidence = assemblePolicyCandidateEvidence(config, getRoutingProfile(config, "guarded")!, Date.now(), {
+      routedProviderConfig,
+    });
+    expect(evidence[0]?.capability).toBeUndefined();
+    expect(() => routeModel(config, "policy/guarded")).toThrow(NoEligiblePolicyCandidateError);
+  });
+
+  test("missing and disabled providers are not resolved for capability evidence", () => {
+    const config = policyConfig("local", {
+      adapter: "openai-chat", baseUrl: loopback, allowPrivateNetwork: true,
+    }, "local-model", { tools: true });
+    config.providers.disabled = { ...config.providers.local!, disabled: true };
+    config.routingProfiles!.guarded!.candidates.push(
+      { provider: "missing", model: "model" },
+      { provider: "disabled", model: "model" },
+    );
+    const resolved: string[] = [];
+    const evidence = assemblePolicyCandidateEvidence(config, getRoutingProfile(config, "guarded")!, Date.now(), {
+      routedProviderConfig: (name, provider) => {
+        resolved.push(name);
+        return routedProviderConfig(name, provider);
+      },
+    });
+
+    expect(resolved).toEqual(["local"]);
+    expect(evidence[0]?.capability?.tools).toBe(true);
+    expect(evidence[1]?.capability).toBeUndefined();
+    expect(evidence[2]?.capability).toBeUndefined();
+  });
+
+  test.each(["allow", "penalize", "exclude"] as const)(
+    "an unresolved first candidate is excluded when unknown capabilities are %s",
+    capability => {
+      const config = policyConfig("ollama", {
+        adapter: "openai-chat", baseUrl: loopback,
+      }, "local-model", {});
+      config.providers.ollama!.baseUrl = " ";
+      config.providers.local = { adapter: "openai-chat", baseUrl: loopback, allowPrivateNetwork: true };
+      const profile = config.routingProfiles!.guarded!;
+      profile.candidates.push({ provider: "local", model: "local-model" });
+      profile.unknownEvidence = { ...profile.unknownEvidence, capability };
+
+      const route = routeModel(config, "policy/guarded");
+      expect(route.providerName).toBe("local");
+      expect(route.routeDecision?.candidates.map(candidate => candidate.eligible)).toEqual([false, true]);
+      expect(route.routeDecision?.candidates[0]?.exclusions).toContainEqual({ code: "route-unavailable" });
+      expect(JSON.stringify(route.routeDecision)).not.toContain("Invalid baseUrl");
+    },
+  );
+
+  test("all unresolved candidates produce a policy exclusion while explicit routing keeps validation", () => {
+    const config = policyConfig("ollama", {
+      adapter: "openai-chat", baseUrl: loopback,
+    }, "local-model", {});
+    config.providers.ollama!.baseUrl = " ";
+
+    expect(() => routeModel(config, "policy/guarded")).toThrow(NoEligiblePolicyCandidateError);
+    expect(() => routeModel(config, "ollama/local-model")).toThrow('Invalid baseUrl for provider "ollama"');
+  });
+});
+
 describe("candidateCapabilityEvidence model matching", () => {
   test("a family entry covers its tagged siblings, as the resolver does", () => {
     const provider = providerWithFamilyEntries();

````

## Required correction on top of the original head

In `src/routing/compatibility/assemble.ts`, change exactly:

```diff
-    let routeResolutionFailed = false;
+    let routeResolutionFailed = !provider || provider.disabled === true;
```

Keep the active-provider `if` and catch intact. Missing/disabled providers must never invoke the resolver. Exception messages must not be copied into evidence or traces.

Append this test inside the original effective-provider describe block in `tests/routing/routing-capability-model-matching.test.ts`, using its `policyConfig`, `loopback` and cleanup fixtures:

```ts
  for (const unavailable of ["missing", "disabled"] as const) {
    test.each(["allow", "penalize", "exclude"] as const)(
      `${unavailable} first candidate is excluded under %s unknown policy`,
      capability => {
        const config = policyConfig("local", {
          adapter: "openai-chat", baseUrl: loopback, allowPrivateNetwork: true,
        }, "local-model", {});
        if (unavailable === "disabled") {
          config.providers.disabled = { ...config.providers.local!, disabled: true };
        }
        const profile = config.routingProfiles!.guarded!;
        profile.candidates.unshift({ provider: unavailable, model: "local-model" });
        profile.unknownEvidence = { ...profile.unknownEvidence, capability };
        const resolved: string[] = [];
        const evidence = assemblePolicyCandidateEvidence(
          config, getRoutingProfile(config, "guarded")!, Date.now(), {
            routedProviderConfig: (name, provider) => {
              resolved.push(name);
              return routedProviderConfig(name, provider);
            },
          },
        );
        expect(resolved).toEqual(["local"]);
        expect(evidence[0]?.routeResolutionFailed).toBe(true);
        expect(evidence[0]?.capability).toBeUndefined();
        const evaluation = evaluatePolicyProfile(config, "guarded", {}, evidence);
        expect(evaluation.selectedIndex).toBe(1);
        expect(evaluation.candidates[0]?.eligible).toBe(false);
        expect(evaluation.candidates[0]?.exclusions).toContainEqual({ code: "route-unavailable" });
        expect(routeModel(config, "policy/guarded").providerName).toBe("local");
        profile.candidates.pop();
        expect(() => routeModel(config, "policy/guarded")).toThrow(NoEligiblePolicyCandidateError);
      },
    );
  }
```

Append inside the existing describe in `tests/routing/routing-profile.test.ts`. Imports and `baseConfig`/ManagementRequest fixtures already exist:

```ts
  for (const unavailable of ["missing", "disabled"] as const) {
    test.each(["allow", "penalize", "exclude"] as const)(
      `API dry-run excludes ${unavailable} provider under %s unknown policy`,
      async capability => {
        const config = baseConfig({
          providers: {
            local: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:11434/v1", allowPrivateNetwork: true },
          },
          defaultProvider: "local",
          routingProfiles: {
            guarded: {
              candidates: [
                { provider: unavailable, model: "local-model" },
                { provider: "local", model: "local-model" },
              ],
              require: {},
              unknownEvidence: { capability },
            },
          },
        });
        if (unavailable === "disabled") {
          config.providers.disabled = { ...config.providers.local!, disabled: true };
        }
        for (const withSibling of [true, false]) {
          if (!withSibling) config.routingProfiles!.guarded!.candidates.pop();
          const req = new ManagementRequest("http://localhost/api/routing-profiles/dry-run", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ profile: "guarded", evidence: {} }),
          });
          const response = await handleManagementAPI(req, new URL(req.url), config, {
            refreshCodexCatalog: async () => {},
          });
          expect(response!.status).toBe(200);
          const body = await response!.json() as {
            selectedIndex: number | null;
            candidates: Array<{ eligible: boolean; exclusions: Array<{ code: string }> }>;
          };
          expect(body.selectedIndex).toBe(withSibling ? 1 : null);
          expect(body.candidates[0]?.eligible).toBe(false);
          expect(body.candidates[0]?.exclusions).toContainEqual({ code: "route-unavailable" });
        }
      },
    );
  }
```

The empty `require` is deliberate: it activates the bug even when capability unknown handling has no unsatisfied requirement to mask it. Existing synthetic `candidates` fixtures retain their meaning. No upstream request is needed for these scenarios.

After each original guide paragraph, add the corresponding exact sentence:

| Path | Added text |
|---|---|
| `docs-site/src/content/docs/guides/routing-profile-editor.md` | Missing or disabled providers are also excluded with `route-unavailable` before scoring. |
| `docs-site/src/content/docs/fr/guides/routing-profile-editor.md` | Les fournisseurs absents ou désactivés sont également exclus avec `route-unavailable` avant le calcul des scores. |
| `docs-site/src/content/docs/tr/guides/routing-profile-editor.md` | Eksik veya devre dışı sağlayıcılar da puanlama öncesinde `route-unavailable` ile dışlanır. |
| `docs-site/src/content/docs/zh-tw/guides/routing-profile-editor.md` | 缺少或停用的供應商也會在評分前以 `route-unavailable` 排除。 |

SOT edit:

```diff
-| `src/router.ts` | Provider/model selection before adapter dispatch. |
+| `src/router.ts` | Provider/model selection before adapter dispatch. Policy execution and ordinary management dry-run share effective-provider capability evidence; unresolved, missing, and disabled providers are excluded before scoring. |
```

## Activation and independent acceptance

| Trigger | Observable proof, required remotely |
|---|---|
| Canonical DeepSeek with configured loopback URL overridden by registry | Direct resolution shows canonical remote destination; local-only policy rejects it. Genuine custom-local and Ollama loopback remain eligible; config snapshots are unchanged. |
| Registry no-vision defaults, capped native API context, filled forward auth and provider-wide reasoning ladder | Policy sees exactly the effective dispatch values; no-reasoning empty ladder remains a known negative. Same-name custom transport does not gain unrelated registry metadata. |
| Resolver throws for first candidate under allow/penalize/exclude | First candidate has `route-unavailable`, no positive capability and `eligible=false`; healthy sibling wins. All invalid candidates produce NoEligiblePolicyCandidateError; explicit routing preserves its validation error. |
| Missing/disabled first candidate; empty requirements under each unknown policy | Resolver spy only sees active sibling, unavailable evidence true; evaluator and runtime choose sibling, all-unavailable policy fails. |
| Ordinary management dry-run without supplied candidate evidence | Missing/disabled candidates remain excluded; selectedIndex is sibling index or null with no sibling. This proves the public review fix at the actual API owner. |
| Core-only runtime and compatibility provider slot | Core/Lab boundary tests pass; no new import chain, timer or asynchronous activation is introduced. |
| Existing three-argument capability helper callers and synthetic dry-run fixtures | Existing model-family/catalog/profile tests remain green; optional argument is backward compatible. |

This layer is independently acceptable only with the original carry plus the review correction and all regression cases together. The predecessor contributes the integration baseline, not deferred tests. Main must independently review the public policy-boundary change; do not rely on the original CodeRabbit status alone.

## Remote verifiers and static workflow coverage

Main verified `the isolated remote verification host`, its existing `REMOTE_SOURCE_CHECKOUT` checkout, and Bun `1.3.14`. Implementation C uses a separate isolated remote clone at the exact carried SHA; do not alter or run checks in that existing checkout. Record the clone path and resolved SHA with every receipt. No local project command execution is permitted at any point.

Implementation C runs focused activation regressions and typecheck remotely. The carrying PR stays draft until full current-head GitHub CI is green; focused success alone does not authorize readiness or landing. The final landing cycle requires every full gate, including the separately verified documentation build and required reviews. Deeper implementation review belongs to the next cycle, after candidate-plan revalidation.

These commands are plans for an isolated remote checkout of the exact carried commit, **not commands to execute on the local Mac**. Record host, exact SHA, command, exit status and full output artifact. Use fixture homes and no real provider traffic.

```sh
# REMOTE ONLY: exact-head focused behavior and core/Lab boundaries
bun test tests/routing/routing-capability-model-matching.test.ts tests/routing/routing-capability-catalog.test.ts tests/routing/policy-execution.test.ts tests/routing/routing-profile.test.ts tests/routing/routing-compatibility.test.ts tests/routing/compatibility-provider-equivalence.test.ts tests/lab/core-lab-boundary.test.ts
# REMOTE ONLY: complete source checks; hosted CI may supply this evidence instead
bun run typecheck
bun run test
bun run privacy:scan
# REMOTE ONLY: docs build in an isolated verification checkout, without publication
cd docs-site
bun install --frozen-lockfile
bun run build
```

For red/green proof, use the remote original carry head without the one-line correction but with the new regression cases: new missing/disabled cases must fail. Add correction on the remote verification candidate and show the same cases green. Do not run this experiment by rewriting this shared worktree.

Static inspection at `81871b3fa` confirms:

- `.github/workflows/ci.yml:7` uses `pull_request: {}` without a base filter, so a child PR targeting a parent branch is covered. Push alone to `codex/*` does not trigger it (`:26–27`); an opened PR or authorized workflow_dispatch is necessary.
- `ci.yml:182–185` includes `src/**` and `tests/**`; this layer must produce `changes.ci=true`. Original workflows awaiting approval provide no test evidence.
- `ci.yml:254–316` runs four Linux shards with `scripts/ci/run-bun-test-batches.sh`. Inspect logs for actual file execution and all shards, including split API/storage jobs, rather than only aggregate status.
- `ci.yml:422–431` covers typecheck and privacy. macOS and Windows suites are configured at `:451`, `:532`, `:625`, and `:754`; inspect the actual selected lane and successful test jobs, not skipped jobs.
- `ci.yml:906` aggregate permits intentionally skipped jobs. An aggregate green with skipped required product jobs is insufficient for this source-changing layer.
- `.github/workflows/deploy-docs.yml:3–9` triggers on main/docs changes or manual dispatch, and contains deployment. It is **not** a PR docs-build verifier. Do not dispatch publication to obtain validation. Use the remote build-only commands above. No CI workflow edits are needed in this layer.

The roadmap cycle changes documentation only; expensive tests may correctly skip there. That success cannot be reused for the later implementation head. Each restack or review fix requires new exact-head evidence.

## Main-owned stack delivery and closure

Carry original commits in order, then commit the targeted review correction and regressions. Publish only own branches with the user's authorized `--no-verify` push policy. Do not rewrite the contributor branch. Populate every repository PR-template section, stack parent link and source attribution. No local gate bypass can substitute for remote product CI.

Merge bottom-up once each layer's exact current head meets review/CI gates. When a lower PR is squash-merged, restack/retarget descendants before deleting lower branches; verify the new parent ancestry and each child diff. Preserve author trailers in the final squash body.

After main verifies the carrying merge SHA is an ancestor of freshly fetched `origin/dev`, immediately close original #3671 as superseded if it did not auto-close, linking the carrying PR/merge. If original #3671 itself is merged, verify its merged state. Do not close it on branch push, PR creation, CI success alone, or merge only into a stack parent. No additional issue is identified as fully resolved by this unit.

## Planning proof

Only this document was written by this worker. The embedded original patch was read directly from the pinned original objects. Source/caller/workflow checks are static; no local tests, typecheck, build, Git mutation, GitHub mutation, goal or FSM transition was performed. The main-owned later P must revalidate all candidate hunks and review state.
