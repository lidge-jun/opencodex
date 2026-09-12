# runtime carry

MODIFY exactly the paths in this public source diff. Apply each original commit in order with attribution. Resolve retired structure document into current runtime.md and gui-and-management-api.md; never restore the retired file. Earlier phase dependency: roadmap.

Before/after source contract (review against current dev at P; source diff is the executable carry input):

```diff
diff --git a/docs-site/src/content/docs/fr/guides/combos.md b/docs-site/src/content/docs/fr/guides/combos.md
index 9785135d53..9434a1e98a 100644
--- a/docs-site/src/content/docs/fr/guides/combos.md
+++ b/docs-site/src/content/docs/fr/guides/combos.md
@@ -190,6 +190,8 @@ indique la réinitialisation de fenêtre à venir la plus proche (cinq heures, h
 Le fournisseur dont le quota se renouvelle en premier est ainsi sollicité. Les cibles dépourvues de données de quota
 récentes et les égalités conservent l’ordre de configuration. `weight` et `stickyLimit` n’affectent pas cette stratégie.

+Ce classement et l’exclusion des fournisseurs avant l’envoi exigent des limites récentes d’inférence de modèles applicables dans leur ensemble à l’unique clé API actuelle. Les résumés OAuth ou du compte courant, les routes transmettant les identifiants de l’appelant, les configurations à plusieurs clés et les instantanés dont les identifiants ou la destination ont changé servent uniquement à l’affichage pour cette décision préalable. Il en va de même lorsque les en-têtes `Authorization`, `x-api-key` ou `x-goog-api-key` remplacent les identifiants ; les fenêtres réservées à la recherche ou à MCP sont exclues. Si aucune cible admissible n’a de réinitialisation applicable, l’ordre de configuration prévaut. La sélection des comptes et les nouvelles tentatives appliquent toujours leurs limites habituelles.
+
 ## Que se passe-t-il lorsqu'une cible échoue

 Les échecs d’un combo se répartissent entre ceux qui entraînent un **basculement** et les échecs **terminaux**.
diff --git a/docs-site/src/content/docs/guides/combos.md b/docs-site/src/content/docs/guides/combos.md
index db94da045f..c7d076d9b7 100644
--- a/docs-site/src/content/docs/guides/combos.md
+++ b/docs-site/src/content/docs/guides/combos.md
@@ -202,6 +202,8 @@ shows the soonest upcoming window reset (five-hour, weekly, monthly, or custom).
 provider that refreshes first. Targets without fresh quota data, and ties, keep configuration
 order. Weights and `stickyLimit` do not affect this strategy.

+This ranking and provider exclusion before dispatch require fresh model-inference limits that apply to the current single API key as a whole. OAuth/current-account summaries, caller-forward routes, multiple keys, and snapshots with changed credentials or destinations are display-only for this early decision. The same applies when `Authorization`, `x-api-key`, or `x-goog-api-key` headers override credentials; search-only and MCP-only windows are excluded. If no eligible target has an applicable reset, configuration order wins. Account selection and retries still enforce their normal limits.
+
 ## What happens when a target fails

 Combo failures are divided into **hop** failures and **terminal** failures.
diff --git a/docs-site/src/content/docs/ja/guides/combos.md b/docs-site/src/content/docs/ja/guides/combos.md
index 655dae2232..f6eca53214 100644
--- a/docs-site/src/content/docs/ja/guides/combos.md
+++ b/docs-site/src/content/docs/ja/guides/combos.md
@@ -113,6 +113,8 @@ ocx combo set balanced \

 `reset-window` は、キャッシュされたプロバイダーのクォータスナップショットで、次回のウィンドウリセット（5 時間、週次、月次、またはカスタム）が最も早い適格なターゲットへ、各リクエストをルーティングします。これにより、最初にクォータが補充されるプロバイダーを先に使用します。新しいクォータデータがないターゲットと、リセット時刻が同じターゲットでは、構成順序が維持されます。`weight` と `stickyLimit` はこの戦略に影響しません。

+この順位付けと送信前のプロバイダー除外には、現在の単一 API キー全体に適用される最新のモデル推論制限が必要です。OAuth／現在のアカウントの概要、呼び出し元の認証情報を転送するルート、複数キー、認証情報や送信先が変わったスナップショットは、この事前判断では表示専用です。`Authorization`、`x-api-key`、`x-goog-api-key` ヘッダーで認証情報を上書きする場合も同様で、検索専用および MCP 専用ウィンドウは対象外です。適用可能なリセット情報を持つ適格な対象がなければ、設定順序を使用します。アカウント選択と再試行には引き続き通常の制限が適用されます。
+
 ## ターゲットが失敗すると何が起こるか

 コンボ障害は、**ホップ** 障害と **ターミナル** 障害に分類されます。
diff --git a/docs-site/src/content/docs/ko/guides/combos.md b/docs-site/src/content/docs/ko/guides/combos.md
index 633feb838b..71e557f25c 100644
--- a/docs-site/src/content/docs/ko/guides/combos.md
+++ b/docs-site/src/content/docs/ko/guides/combos.md
@@ -119,6 +119,8 @@ ocx combo set balanced \

 `reset-window`는 캐시된 공급자 할당량 스냅샷에서 가장 가까운 다음 기간 재설정(5시간, 주간, 월간 또는 사용자 지정)이 표시되는 적합한 대상으로 각 요청을 라우팅합니다. 이렇게 하면 가장 먼저 새로 충전되는 공급자를 사용합니다. 최신 할당량 데이터가 없는 대상과 동률인 대상은 설정 순서를 유지합니다. `weight`와 `stickyLimit`은 이 전략에 영향을 주지 않습니다.

+이 순위 결정과 전송 전 공급자 제외에는 현재 단일 API 키의 전체 모델 추론에 적용되는 최신 한도 정보가 필요합니다. OAuth·현재 계정 요약, 호출자 인증을 전달하는 경로, 여러 키, 인증 정보나 목적지가 달라진 스냅샷은 이 사전 판단에서 표시 용도로만 사용합니다. `Authorization`, `x-api-key`, `x-goog-api-key` 헤더로 인증을 덮어쓰는 경우도 같으며, 검색 전용·MCP 전용 기간은 제외합니다. 적격 대상 중 적용 가능한 초기화 정보가 없으면 설정 순서를 따릅니다. 실제 계정 선택과 재시도에는 기존 제한이 계속 적용됩니다.
+
 ## 대상 실패 시 동작

 콤보 실패는 **홉** 실패와 **종결** 실패로 나뉩니다.
diff --git a/docs-site/src/content/docs/ru/guides/combos.md b/docs-site/src/content/docs/ru/guides/combos.md
index 3d4820e521..868416ae5b 100644
--- a/docs-site/src/content/docs/ru/guides/combos.md
+++ b/docs-site/src/content/docs/ru/guides/combos.md
@@ -150,6 +150,8 @@ ocx combo set balanced \
 данных о квоте, а также цели с одинаковым временем сброса сохраняют порядок конфигурации. Значения
 `weight` и `stickyLimit` не влияют на эту стратегию.

+Для этого ранжирования и исключения провайдеров до отправки нужны свежие лимиты инференса моделей, применимые к единственному текущему API-ключу в целом. Сводки OAuth и текущего аккаунта, маршруты с передачей учётных данных вызывающей стороны, несколько ключей и снимки с изменившимися учётными данными или адресом назначения служат только для отображения при этом предварительном решении. То же относится к переопределению учётных данных заголовками `Authorization`, `x-api-key` или `x-goog-api-key`; окна только для поиска или MCP исключаются. Если ни у одной допустимой цели нет подходящего времени сброса, используется порядок конфигурации. При выборе аккаунта и повторных попытках по-прежнему действуют обычные ограничения.
+
 ## Что происходит, когда цель сбоит

 Сбои в combo делятся на **hop**-сбои и **terminal**-сбои.
diff --git a/docs-site/src/content/docs/tr/guides/combos.md b/docs-site/src/content/docs/tr/guides/combos.md
index 8b67170068..520c157e83 100644
--- a/docs-site/src/content/docs/tr/guides/combos.md
+++ b/docs-site/src/content/docs/tr/guides/combos.md
@@ -218,6 +218,8 @@ kullanılır. Güncel kota verisi bulunmayan hedeflerde ve eşitliklerde
 yapılandırma sırası korunur. `weight` değerleri ve `stickyLimit` bu stratejiyi
 etkilemez.

+Bu sıralama ve gönderim öncesi sağlayıcı elemesi, mevcut tek API anahtarının model çıkarımı kullanımının tamamına uygulanan güncel sınırlara dayanır. OAuth veya geçerli hesap özetleri, çağıranın kimlik bilgilerini ileten rotalar, birden fazla anahtar ve kimlik bilgileri ya da hedefi değişmiş anlık görüntüler, bu ön kararda yalnızca görüntüleme amaçlıdır. `Authorization`, `x-api-key` veya `x-goog-api-key` başlıkları kimlik bilgilerini geçersiz kıldığında da aynı kural uygulanır; yalnızca arama veya MCP için olan pencereler hariç tutulur. Uygun hedeflerin hiçbirinde geçerli sıfırlama bilgisi yoksa yapılandırma sırası kullanılır. Hesap seçimi ve yeniden denemelerde normal sınırlar uygulanmaya devam eder.
+
 ## Bir hedef başarısız olduğunda ne olur?

 Kombo hataları **atlama (hop)** hataları ve **uç (terminal)** hatalar olarak
diff --git a/docs-site/src/content/docs/zh-cn/guides/combos.md b/docs-site/src/content/docs/zh-cn/guides/combos.md
index fea189deb3..d84efca472 100644
--- a/docs-site/src/content/docs/zh-cn/guides/combos.md
+++ b/docs-site/src/content/docs/zh-cn/guides/combos.md
@@ -139,6 +139,8 @@ ocx combo set balanced \

 `reset-window` 会将每个请求路由到合格目标中，其缓存的提供商额度快照显示下一个窗口最早重置者（五小时、每周、每月或自定义窗口）。这样会优先消耗最先刷新额度的提供商。没有最新额度数据的目标以及并列目标会保持配置顺序。`weight` 和 `stickyLimit` 不影响此策略。

+此排序和发送前的提供商排除，需要适用于当前单个 API 密钥全部模型推理的最新限额信息。OAuth／当前账户摘要、转发调用方凭据的路由、多密钥以及凭据或目标地址已改变的快照，在这项提前判断中仅供显示。通过 `Authorization`、`x-api-key` 或 `x-goog-api-key` 请求头覆盖凭据时也适用相同规则；仅用于搜索或 MCP 的窗口不参与判断。如果所有符合条件的目标都没有适用的重置时间，则按配置顺序选择。实际账户选择和重试仍执行正常限制。
+
 ## 目标失败时会发生什么

 combo 失败分为 **跳转** 失败和 **终止** 失败。
diff --git a/docs-site/src/content/docs/zh-tw/guides/combos.md b/docs-site/src/content/docs/zh-tw/guides/combos.md
index bb8ef901f9..d82b399e6f 100644
--- a/docs-site/src/content/docs/zh-tw/guides/combos.md
+++ b/docs-site/src/content/docs/zh-tw/guides/combos.md
@@ -154,6 +154,8 @@ ocx combo set balanced \

 `reset-window` 將每個請求路由至快取供應商配額快照顯示下一個時段最早重設的合格目標（五小時、每週、每月或自訂）。這會優先使用最早重新取得額度的供應商。沒有最新配額資料的目標，以及發生平手時，皆維持設定順序。`weight` 與 `stickyLimit` 不影響此策略。

+此排序與傳送前的供應商排除，需要適用於目前單一 API 金鑰全部模型推論的最新限額資訊。OAuth／目前帳戶摘要、轉送呼叫者憑證的路由、多金鑰，以及憑證或目的地位址已變更的快照，在這項預先判斷中僅供顯示。透過 `Authorization`、`x-api-key` 或 `x-goog-api-key` 標頭覆寫憑證時也適用相同規則；僅供搜尋或 MCP 使用的時段不參與判斷。若所有符合條件的目標都沒有適用的重設時間，則依設定順序選擇。實際帳戶選擇與重試仍套用一般限制。
+
 ## 目標失敗時會發生什麼

 Combo 失敗分為**跳轉**失敗與**終端**失敗。
diff --git a/src/combos/resolve.ts b/src/combos/resolve.ts
index 71ea750b6e..9627bf396d 100644
--- a/src/combos/resolve.ts
+++ b/src/combos/resolve.ts
@@ -1,7 +1,6 @@
 import type { OcxComboTarget, OcxConfig } from "../types";
-import { getCachedProviderQuota } from "../providers/quota-routing-cache";
+import { getCachedProviderRoutingQuota } from "../providers/quota-routing-cache";
 import type { ProviderQuota } from "../providers/quota-types";
-import { isCanonicalOpenAiForwardProvider } from "../providers/openai-tiers";
 import { sleepWithAbort } from "../lib/upstream-retry";
 import {
   coolComboTarget,
@@ -65,9 +64,7 @@ function targetProviderIsUsable(config: OcxConfig, target: OcxComboTarget, now:
   if (!Object.hasOwn(config.providers, target.provider)) return false;
   const provider = config.providers[target.provider];
   if (!provider || provider.disabled === true) return false;
-  // Native account selection owns model-scoped quota; a provider summary cannot veto it.
-  return isCanonicalOpenAiForwardProvider(provider)
-    || !cachedProviderQuotaIsExhausted(getCachedProviderQuota(target.provider, now), now);
+  return !cachedProviderQuotaIsExhausted(getCachedProviderRoutingQuota(target.provider, provider, now), now);
 }

 function quotaWindowExhausted(percent: number | undefined, resetAt: number | undefined, now: number): boolean {
@@ -181,6 +178,7 @@ function smoothWeightedIndex(
  * unknown (Infinity).
  */
 function resetWindowIndex(
+  config: OcxConfig,
   targets: Required<OcxComboTarget>[],
   eligible: (target: Required<OcxComboTarget>) => boolean,
   now = Date.now(),
@@ -190,7 +188,9 @@ function resetWindowIndex(
   for (let index = 0; index < targets.length; index++) {
     const target = targets[index]!;
     if (!eligible(target)) continue;
-    const remaining = quotaResetRemainingMs(getCachedProviderQuota(target.provider, now), now);
+    const remaining = quotaResetRemainingMs(
+      getCachedProviderRoutingQuota(target.provider, config.providers[target.provider], now), now,
+    );
     // Strict comparison deliberately retains configured order for ties,
     // including the no-snapshot fallback where every value is Infinity.
     if (selected < 0 || remaining < smallestRemaining) {
@@ -276,7 +276,7 @@ export function pickComboTarget(
       }
     }
   } else if (combo.strategy === "reset-window") {
-    targetIndex = resetWindowIndex(combo.targets, eligible, now);
+    targetIndex = resetWindowIndex(config, combo.targets, eligible, now);
   } else {
     targetIndex = combo.targets.findIndex(eligible);
   }
diff --git a/src/providers/quota-routing-cache.ts b/src/providers/quota-routing-cache.ts
index 065d7338ca..1e45d60065 100644
--- a/src/providers/quota-routing-cache.ts
+++ b/src/providers/quota-routing-cache.ts
@@ -1,15 +1,53 @@
+import { createHash } from "node:crypto";
+import type { OcxProviderConfig } from "../types";
 import type { ProviderQuota, ProviderQuotaReport } from "./quota";
+import { providerUsesKeyAuthOverride, resolveProviderApiKey } from "./key-store";
+import { getProviderRegistryEntry } from "./registry";

-const quotaCache = new Map<string, ProviderQuota>();
+export interface ProviderQuotaRoutingEvidence {
+  quota: ProviderQuota;
+  binding: string;
+}
+
+type CachedQuota = {
+  quota: ProviderQuota;
+  routing?: ProviderQuotaRoutingEvidence | { quota: ProviderQuota; testOnly: true };
+};
+
+const quotaCache = new Map<string, CachedQuota>();
+
+/** Private cache identity; neither key material nor this digest enters management reports. */
+export function providerQuotaRoutingBinding(
+  name: string,
+  provider: OcxProviderConfig,
+  credential = resolveProviderApiKey(provider.apiKey)?.trim(),
+): string | null {
+  if ((provider.authMode ?? "key") !== "key" || !credential) return null;
+  // Registry-owned OAuth/forward rows normalize saved authMode before dispatch.
+  // A key probe must not constrain that later account selection.
+  const entry = getProviderRegistryEntry(name);
+  if (entry && (entry.authKind === "oauth" || entry.authKind === "forward")
+    && !providerUsesKeyAuthOverride(entry, provider, credential)) return null;
+  // Static auth headers can replace or combine with the probed API-key header.
+  // Its semantics belong to the adapter, so it is not provider-wide quota evidence.
+  if (Object.keys(provider.headers ?? {}).some(header =>
+    ["authorization", "x-api-key", "x-goog-api-key"].includes(header.toLowerCase()))) return null;
+  return createHash("sha256").update(JSON.stringify([
+    name, provider.adapter, provider.baseUrl, credential,
+  ])).digest("hex");
+}

 export function clearCachedProviderQuotas(): void {
   quotaCache.clear();
 }

-export function replaceCachedProviderQuotas(reports: ProviderQuotaReport[]): void {
+export function replaceCachedProviderQuotas(
+  reports: ProviderQuotaReport[],
+  routingEvidence?: WeakMap<ProviderQuotaReport, ProviderQuotaRoutingEvidence>,
+): void {
   quotaCache.clear();
   for (const report of reports) {
-    quotaCache.set(report.provider, report.quota);
+    quotaCache.set(report.provider, { quota: report.quota, routing: routingEvidence?.get(report) });
   }
 }

@@ -18,15 +56,34 @@ export function getCachedProviderQuota(
   now: number,
   maxAgeMs = 30 * 60_000,
 ): ProviderQuota | null {
-  const quota = quotaCache.get(provider);
+  const quota = quotaCache.get(provider)?.quota;
   if (!quota) return null;
   if (now - quota.updatedAt > maxAgeMs) return null;
   return quota;
 }

+/** Only inference-wide evidence for this sole credential may rank or veto a whole provider. */
+export function getCachedProviderRoutingQuota(
+  name: string,
+  provider: OcxProviderConfig | undefined,
+  now: number,
+  maxAgeMs = 30 * 60_000,
+): ProviderQuota | null {
+  if (!provider || provider.disabled === true || (provider.authMode ?? "key") !== "key") return null;
+  // An active-key report cannot speak for the other keys the dispatcher may select.
+  if ((provider.apiKeyPool?.length ?? 0) > 1) return null;
+  const routing = quotaCache.get(name)?.routing;
+  if (!routing || now - routing.quota.updatedAt > maxAgeMs) return null;
+  const binding = providerQuotaRoutingBinding(name, provider);
+  if (!binding || (!("testOnly" in routing) && routing.binding !== binding)) return null;
+  return routing.quota;
+}
+
 export function setCachedProviderQuotaForTests(
   provider: string,
   quota: ProviderQuota,
 ): void {
-  quotaCache.set(provider, quota);
+  // Unit tests deliberately assert the supplied quota's scope. Production publication
+  // requires the producer's private, credential-bound evidence map above.
+  quotaCache.set(provider, { quota, routing: { quota, testOnly: true } });
 }
diff --git a/src/providers/quota.ts b/src/providers/quota.ts
index 69ee60626c..6909e46131 100644
--- a/src/providers/quota.ts
+++ b/src/providers/quota.ts
@@ -39,7 +39,9 @@ import {
 } from "./quota-wire";
 import {
   clearCachedProviderQuotas,
+  providerQuotaRoutingBinding,
   replaceCachedProviderQuotas,
+  type ProviderQuotaRoutingEvidence,
 } from "./quota-routing-cache";
 import {
   aggregateCodexPoolCapacity,
@@ -103,6 +105,7 @@ const XAI_CREDITS_URL = `${XAI_BILLING_URL}?format=credits`;
 const LAST_GOOD_MAX_AGE_MS = CODEX_CAPACITY_MAX_QUOTA_AGE_MS;
 const nativeMainReportGenerations = new WeakMap<ProviderQuotaReport, number>();
 const accountReportCurrent = new WeakMap<ProviderQuotaReport, () => boolean>();
+const routingEvidence = new WeakMap<ProviderQuotaReport, ProviderQuotaRoutingEvidence>();
 let providerQuotaBeforePublishForTests: (() => void | Promise<void>) | null = null;

 /** Test-only seam for identity/config invalidation after probes but before publication. */
@@ -447,7 +450,9 @@ async function fetchA6apiQuota(provider: string, config: OcxProviderConfig): Pro
     ? { expiresAt: normalizedExpiry }
     : {};
   if (unlimited) {
-    return report(provider, "a6api:billing", {
+    // Every row is an API-credit constraint on inference, so the display quota is also
+    // the routing projection. Passing it explicitly is the opt-in.
+    const quota: ProviderQuota = {
       creditsUsd: {
         used: 0,
         limit: 0,
@@ -458,7 +463,8 @@ async function fetchA6apiQuota(provider: string, config: OcxProviderConfig): Pro
       },
       customWindows: [{ label: "Unlimited API credits", percent: 0 }],
       updatedAt: Date.now(),
-    });
+    };
+    return keyReport(provider, "a6api:billing", quota, config, apiKey, quota);
   }
   const limitUsd = firstFinite(subscription, ["hard_limit_usd"]);
   const grantedUnits = firstFinite(token, ["total_granted"]);
@@ -481,7 +487,7 @@ async function fetchA6apiQuota(provider: string, config: OcxProviderConfig): Pro
   const percent = normalizePercent((usedUsd / limitUsd) * 100);
   if (percent === undefined) return TERMINAL_QUOTA_FAILURE;
   const label = `API credits ($${remainingUsd.toFixed(2)} of $${limitUsd.toFixed(2)} remaining)`;
-  return report(provider, "a6api:billing", {
+  const quota: ProviderQuota = {
     creditsUsd: {
       used: usedUsd,
       limit: limitUsd,
@@ -491,7 +497,9 @@ async function fetchA6apiQuota(provider: string, config: OcxProviderConfig): Pro
     },
     customWindows: [{ label, percent }],
     updatedAt: Date.now(),
-  });
+  };
+  // The credit balance funds inference itself, so display and routing scope agree.
+  return keyReport(provider, "a6api:billing", quota, config, apiKey, quota);
 }

 function parseOpenCodeGoUsageWindow(value: unknown): { percent: number; resetAt?: number } | null {
@@ -539,7 +547,7 @@ async function fetchOpenCodeGoQuota(provider: string, config: OcxProviderConfig)
     } : {}),
     updatedAt: Date.now(),
   };
-  return report(provider, "opencode-go:usage", quota);
+  return keyReport(provider, "opencode-go:usage", quota, config, apiKey, quota);
 }

 /**
@@ -583,10 +591,13 @@ async function fetchOpenRouterQuota(provider: string, config: OcxProviderConfig)
   if (percent === undefined) return null;
   const remaining = Math.max(0, limit - used);
   const label = `API credits ($${remaining.toFixed(2)} of $${limit.toFixed(2)} remaining)`;
-  return report(provider, "openrouter:key-info", {
+  // The per-key spending cap stops every request this credential can make, so the
+  // whole report is inference-wide routing evidence.
+  const quota: ProviderQuota = {
     customWindows: [{ label, percent }],
     updatedAt: Date.now(),
-  });
+  };
+  return keyReport(provider, "openrouter:key-info", quota, config, apiKey, quota);
 }

 /**
@@ -685,7 +696,7 @@ async function fetchClineQuota(provider: string, config: OcxProviderConfig): Pro
       windows += 1;
     }
   }
-  return windows > 0 ? report(provider, "cline:plan-usage-limits", quota) : null;
+  return windows > 0 ? keyReport(provider, "cline:plan-usage-limits", quota, config, apiKey, quota) : null;
 }

 /**
@@ -757,7 +768,7 @@ async function fetchOllamaCloudQuota(provider: string, config: OcxProviderConfig
   }
   const body = asRecord(await readQuotaJson(response));
   const quota = parseOllamaCloudQuota(body);
-  return quota ? report(provider, "ollama-cloud:usage", quota) : null;
+  return quota ? keyReport(provider, "ollama-cloud:usage", quota, config, apiKey, quota) : null;
 }

 /**
@@ -887,10 +898,18 @@ async function fetchZaiQuota(provider: string, config: OcxProviderConfig): Promi
     // model window — for example a plan reporting only the monthly MCP `TIME_LIMIT` row.
     // Returning `null` here would preserve the previous token windows for up to 30 minutes
     // and keep quota-aware routing acting on a report the provider has already superseded.
-    return quota ? report(provider, "zai:quota-limit", quota) : AUTHORITATIVE_EMPTY_QUOTA;
+    return quota
+      ? keyReport(provider, "zai:quota-limit", quota, config, apiKey, quota)
+      : AUTHORITATIVE_EMPTY_QUOTA;
   }
   const legacy = parseZaiQuotaLegacyFields(data);
-  return legacy ? report(provider, "zai:quota-limit", legacy) : null;
+  if (!legacy) return null;
+  // The legacy monthly figure also carries MCP usage; it is display evidence, not
+  // proof that model inference is unavailable. Modern TOKEN_LIMIT rows above are scoped.
+  const inferenceQuota = { ...legacy };
+  delete inferenceQuota.monthlyPercent;
+  delete inferenceQuota.monthlyResetAt;
+  return keyReport(provider, "zai:quota-limit", legacy, config, apiKey, inferenceQuota);
 }

 /**
@@ -1073,7 +1092,9 @@ async function fetchSyntheticQuota(provider: string, config: OcxProviderConfig):
     quota.customWindows = [...(quota.customWindows ?? []), { label: "Search hourly", percent: searchHourly }];
     windows += 1;
   }
-  return windows > 0 ? report(provider, "synthetic:quotas", quota) : null;
+  const inferenceQuota = { ...quota };
+  delete inferenceQuota.customWindows; // search.hourly does not constrain model inference.
+  return windows > 0 ? keyReport(provider, "synthetic:quotas", quota, config, apiKey, inferenceQuota) : null;
 }

 /**
@@ -1185,6 +1206,31 @@ function report(
   };
 }

+/**
+ * Publish a credential-bound report, and routing evidence only when the producer
+ * hands over its inference-only projection.
+ *
+ * The projection is deliberately not defaulted to the display quota. A producer must
+ * decide that its rows really do constrain inference on the probed credential; omitting
+ * the argument leaves the report display-only, so a new producer cannot inherit
+ * provider-veto authority merely by calling this helper. Ownership alone is not the
+ * scope decision: providerQuotaRoutingBinding resolving is necessary, never sufficient.
+ */
+function keyReport(
+  provider: string,
+  source: string,
+  quota: ProviderQuota,
+  config: OcxProviderConfig,
+  probedCredential: string,
+  inferenceQuota?: ProviderQuota,
+): ProviderQuotaReport | null {
+  const result = report(provider, source, quota);
+  if (!result || !inferenceQuota) return result;
+  const binding = providerQuotaRoutingBinding(provider, config, probedCredential);
+  if (binding) routingEvidence.set(result, { quota: inferenceQuota, binding });
+  return result;
+}
+
 function tagNativeMainReport(
   value: ProviderQuotaReport | null,
   generation: number,
@@ -1193,6 +1239,27 @@ function tagNativeMainReport(
   return value;
 }

+/**
+ * Test-only seam: publish exactly as a credential-bound producer does, and hand back the
+ * routing evidence the publication actually attached.
+ *
+ * Live producers all pass a projection today, so no probe fixture can prove the OTHER half
+ * of the contract: that omitting it stays display-only. Routing an omitted argument through
+ * the real helper keeps that provable, and a re-introduced `= quota` default would be
+ * observed here (a defaulted parameter also fires for an explicitly undefined argument).
+ */
+export function publishKeyReportForTests(
+  provider: string,
+  source: string,
+  quota: ProviderQuota,
+  config: OcxProviderConfig,
+  probedCredential: string,
+  inferenceQuota?: ProviderQuota,
+): { report: ProviderQuotaReport | null; routing: ProviderQuotaRoutingEvidence | undefined } {
+  const result = keyReport(provider, source, quota, config, probedCredential, inferenceQuota);
+  return { report: result, routing: result ? routingEvidence.get(result) : undefined };
+}
+
 function isProviderQuotaReportCurrent(value: ProviderQuotaReport): boolean {
   const generation = nativeMainReportGenerations.get(value);
   return (generation === undefined || isMainAccountIdentityGenerationLive(generation))
@@ -1888,7 +1955,7 @@ export function reconcileProviderAccountQuotaRows(context: GenerationContext): n
     const reports = cache.response.reports.filter(report => context.providerNames.has(report.provider));
     removed += cache.response.reports.length - reports.length;
     cache = { ...cache, response: { ...cache.response, reports } };
-    replaceCachedProviderQuotas(reports);
+    replaceCachedProviderQuotas(reports, routingEvidence);
   }
   liveAccountQuotaKeys = new Set(context.oauthAccountKeys);
   liveProviderQuotaKeys = new Set(context.providerNames);
@@ -2317,7 +2384,7 @@ async function fetchKimiQuota(provider: string, config: OcxProviderConfig, acces
   });
   if (!response.ok) return null;
   const quota = parseKimiQuotaPayload(await readQuotaJson(response));
-  return quota ? report(provider, "kimi:usages", quota) : null;
+  return quota ? keyReport(provider, "kimi:usages", quota, config, accessToken, quota) : null;
 }

 /**
@@ -2444,7 +2511,7 @@ async function fetchCommandCodeQuota(provider: string, config: OcxProviderConfig
   const fiveHour = parseCommandCodeWindow(limits?.fiveHour);
   const weekly = parseCommandCodeWindow(limits?.weekly);
   const creditsUsd = await fetchCommandCodeSpend(bearer, credits, orgQuery);
-  return report(provider, "command-code:credits", {
+  const quota: ProviderQuota = {
     ...(fiveHour ? {
       fiveHourPercent: fiveHour.percent,
       ...(fiveHour.resetAt !== undefined ? { fiveHourResetAt: fiveHour.resetAt } : {}),
@@ -2455,7 +2522,9 @@ async function fetchCommandCodeQuota(provider: string, config: OcxProviderConfig
     } : {}),
     ...(creditsUsd ? { creditsUsd } : {}),
     updatedAt: Date.now(),
-  });
+  };
+  // Rolling windows and the credit balance both gate inference on this bearer.
+  return keyReport(provider, "command-code:credits", quota, config, bearer, quota);
 }

 /** Cursor included usage via api2.cursor.sh (Bearer from OAuth) — unofficial, may change. */
@@ -2964,7 +3033,9 @@ async function maybeFetchProviderQuota(
     // probe to run — the row is the active account's last in-band observation.
     if (provider.authMode === "oauth" && hasPassiveAccountQuota(name)) return fetchPassiveProviderQuota(name);
     const reader = keyQuotaReaderForProvider(name, provider);
-    return reader ? reader(name, provider) : null;
+    // Keep destination/auth fields bound to the same request as the reader's captured
+    // bearer, even if the live provider object changes while the quota probe awaits.
+    return reader ? reader(name, { ...provider }) : null;
   } catch {
     return null;
   }
@@ -3151,7 +3222,7 @@ export async function fetchProviderQuotaReports(config: OcxConfig, forceRefresh
     ) {
       const reports = response.reports.filter(item => mayCommitProviderQuotaKey(item.provider, writerGeneration));
       cache = { key, ts: Date.now(), response: { ...response, reports } };
-      replaceCachedProviderQuotas(reports);
+      replaceCachedProviderQuotas(reports, routingEvidence);
       notifyProviderQuotaSnapshot(reports, config);
     }
     return response;
diff --git a/structure/04_transports-and-sidecars.md b/structure/04_transports-and-sidecars.md
index 3aac18b6ef..23ab3bb17e 100644
--- a/structure/04_transports-and-sidecars.md
+++ b/structure/04_transports-and-sidecars.md
@@ -1638,6 +1638,40 @@ retried. Guarded paths: the ChatGPT passthrough and generic adapter fetch in
 fallback. Adapters with their own `fetchResponse` (kiro, cursor, google) keep their own retry
 policies; kiro imports the shared abort/sleep helpers from this module.

+## Cached quota used by Combo selection
+
+Provider quota reports describe the observed account, model group, or service window; they are
+not automatically proof that every request through the provider is unavailable. Before account
+selection, Combo exclusion and `reset-window` ranking consume only the producer's inference-wide
+subset for the current single API key. Synthetic search windows and legacy ZAI MCP monthly data
+remain display rows, while credential-wide key limits such as the OpenRouter spending cap remain
+eligible for early exclusion.
+
+Routing evidence is published only when a producer hands the reporting helper its inference-only
+projection. Omitting that argument leaves the report display-only, so a new quota producer cannot
+inherit provider-veto authority merely by reporting through the credential-bound helper, and
+ownership by itself is never the scope decision. The producer records the subset it opts into in
+a private WeakMap bound to the provider name, adapter, destination and captured probe credential.
+Publication retains that evidence without adding it to report JSON.
+
+The cache getter rechecks the live key, effective registry authentication, static
+credential headers, key-pool size and freshness. OAuth/current-account reports, caller-forward
+routes and ambiguous credential scopes cannot rank or veto the provider before its normal
+account selection. Restoring a matching configuration may reuse still-fresh evidence; a new
+credential cannot inherit another key's cap. The same getter controls immediate selection,
+bounded cooldown waiting and reset-window ordering. This does not override explicit eligibility,
+target cooldowns, account admission or response-driven retry rules.
+
+```text
+[Decision Log]
+- 목적과 의도: Keep account-, model- and service-scoped quota from disabling an otherwise usable Combo provider while retaining valid single-key inference caps.
+- 기존 구현 및 제약 조건: The routing cache retained only the display quota and treated any exhausted window as a provider-wide veto before account/key selection.
+- 검토한 주요 대안: Remove quota pruning entirely; infer scope from display labels; or require producer-owned inference scope and current credential binding.
+- 선택한 방식: Publish private scoped evidence only for a producer that explicitly supplies its inference projection, and validate it in both provider exclusion and reset-window ranking.
+- 다른 대안 대신 이 방식을 선택한 이유: Display labels cannot prove credential ownership, while deleting the gate would lose valid OpenRouter and other single-key caps.
+- 장점, 단점 및 영향: Scoped/ambiguous reports become unknown for early routing and may require normal dispatch to establish availability; actual account and retry limits remain authoritative.
+```
+
 ## Same-provider combo quota fallback

 For a failover combo with multiple models on the same Codex-login OpenAI provider, a pre-stream
diff --git a/tests/codex-integration/combos.test.ts b/tests/codex-integration/combos.test.ts
index 98174c3848..76e4f26ca9 100644
--- a/tests/codex-integration/combos.test.ts
+++ b/tests/codex-integration/combos.test.ts
@@ -910,7 +910,7 @@ describe("combo failure policy and advancement", () => {
     expect(sleeps).toEqual([1_000]);
   });

-  test("still filters exhausted quota on a noncanonical forward destination", () => {
+  test("does not infer provider-wide quota from a noncanonical forward row without a credential", () => {
     const now = 50_000;
     const config = baseConfig({
       providers: {
@@ -927,7 +927,8 @@ describe("combo failure policy and advancement", () => {

     const pick = pickComboTarget(config, "free", { now });

-    expect(pick?.target.provider).toBe("b");
+    // This is quota selection, not proof that this custom forward route can authenticate.
+    expect(pick?.target.provider).toBe("a");
   });

   test("retains caller eligibility restrictions for native targets", () => {
@@ -1150,6 +1151,20 @@ describe("deterministic combo selection", () => {
     });
   });

+  test.each(["oauth", "header", "key-pool"])("reset-window does not rank an inapplicable snapshot: %s", kind => {
+    const now = Date.now();
+    const config = baseConfig({ combos: { free: { strategy: "reset-window", targets: [
+      { provider: "a", model: "m1" }, { provider: "b", model: "m2" },
+    ] } } });
+    setCachedProviderQuotaForTests("a", { updatedAt: now, weeklyResetAt: now + 2_000 });
+    setCachedProviderQuotaForTests("b", { updatedAt: now, weeklyResetAt: now + 1_000 });
+    expect(pickComboTarget(config, "free", { now })?.target.provider).toBe("b");
+    if (kind === "oauth") config.providers.b!.authMode = "oauth";
+    else if (kind === "header") config.providers.b!.headers = { Authorization: "Bearer different-key" };
+    else config.providers.b!.apiKeyPool = [{ id: "one", key: "one" }, { id: "two", key: "two" }];
+    expect(pickComboTarget(config, "free", { now })?.target.provider).toBe("a");
+  });
+
   test("reset-window treats elapsed resets as unknown and falls back to configured order", () => {
     const now = Date.now();
     const config = baseConfig({
diff --git a/tests/providers/provider-quota.test.ts b/tests/providers/provider-quota.test.ts
index 56d69951d5..0f7ea31451 100644
--- a/tests/providers/provider-quota.test.ts
+++ b/tests/providers/provider-quota.test.ts
@@ -18,10 +18,14 @@ import {
   parseXaiCreditsResponse,
   QUOTA_RESPONSE_MAX_BYTES,
   readProviderQuotaJsonForTests,
+  publishKeyReportForTests,
   setAntigravityAccountQuotaTransportForTests,
   setProviderQuotaBeforePublishForTests,
 } from "../../src/providers/quota";
 import type { OcxConfig } from "../../src/types";
+import { clearComboTargetCooldowns, coolComboTarget, pickComboTarget, pickComboTargetWithWait } from "../../src/combos";
+import { routedProviderConfig } from "../../src/router";
+import { buildOpenAIChatPassthroughRequest } from "../../src/adapters/openai-chat";
 import { PROXY_ENV_KEYS } from "../../src/lib/proxy-env";
 import { repoPath } from "../helpers/repo-root";
 const proxyKeys = PROXY_ENV_KEYS.flatMap(key => [key, key.toLowerCase()]);
@@ -95,6 +99,7 @@ beforeEach(() => {
 });

 afterEach(() => {
+  clearComboTargetCooldowns();
   for (const key of proxyKeys) {
     if (originalProxyEnv[key] === undefined) delete process.env[key];
     else process.env[key] = originalProxyEnv[key];
@@ -703,6 +708,241 @@ describe("fetchProviderQuotaReports", () => {
     } as OcxConfig;
   }

+  function quotaCombo(config: OcxConfig): OcxConfig {
+    const provider = config.defaultProvider;
+    return {
+      ...config,
+      providers: {
+        ...config.providers,
+        fallback: { adapter: "openai-chat", baseUrl: "https://fallback.example/v1", apiKey: "fallback-key" },
+      },
+      combos: { "quota-scope": { strategy: "failover", targets: [
+        { provider, model: "primary-model" }, { provider: "fallback", model: "fallback-model" },
+      ] } },
+    };
+  }
+
+  test("routing quota scope keeps Synthetic search exhaustion out of model selection", async () => {
+    globalThis.fetch = (async () => Response.json({
+      data: { rollingFiveHourLimit: 20, weeklyTokenLimit: 30, search: { hourly: 100 } },
+    })) as typeof fetch;
+    const config = quotaCombo(keyQuotaConfig("synthetic", "https://api.synthetic.new/v2"));
+    const reports = await fetchProviderQuotaReports(config, true);
+    expect(reports.reports[0]?.quota.customWindows?.[0]?.percent).toBe(100);
+    expect(pickComboTarget(config, "quota-scope")?.target.provider).toBe("synthetic");
+  });
+
+  test("routing quota scope keeps ZAI legacy MCP exhaustion out of model selection", async () => {
+    globalThis.fetch = (async () => Response.json({
+      success: true, data: { fiveHourPercent: 20, weeklyPercent: 30, monthlyMCPUsage: 100 },
+    })) as typeof fetch;
+    const config = quotaCombo(keyQuotaConfig("zai", "https://api.z.ai/api/coding/paas/v4"));
+    const reports = await fetchProviderQuotaReports(config, true);
+    expect(reports.reports[0]?.quota.monthlyPercent).toBe(100);
+    expect(pickComboTarget(config, "quota-scope")?.target.provider).toBe("zai");
+  });
+
+  test("routing quota scope keeps a key-bound display-only report out of model selection", async () => {
+    // MiniMax publishes its Token Plan countdown through the display-only path. The provider
+    // is single-key `key` auth, so ownership alone would resolve a routing binding; without
+    // an inference projection the exhausted row must still not rank or veto the target.
+    globalThis.fetch = (async () => Response.json({
+      success: true, data: { remains_time: 0, total_time: 1_000_000_000 },
+    })) as typeof fetch;
+    const config = quotaCombo(keyQuotaConfig("minimax", "https://api.minimax.io/v1"));
+    const reports = await fetchProviderQuotaReports(config, true);
+    expect(reports.reports[0]?.quota.customWindows?.[0]?.percent).toBe(100);
+    expect(pickComboTarget(config, "quota-scope")?.target.provider).toBe("minimax");
+  });
+
+  test("routing quota scope retains the OpenRouter single-key spending cap", async () => {
+    globalThis.fetch = (async () => Response.json({ data: { limit: 20, limit_remaining: 0 } })) as typeof fetch;
+    const config = quotaCombo(keyQuotaConfig("openrouter", "https://openrouter.ai/api/v1"));
+    await fetchProviderQuotaReports(config, true);
+    expect(pickComboTarget(config, "quota-scope")?.target.provider).toBe("fallback");
+  });
+
+  test("keyReport publishes routing evidence only for an explicit inference projection", () => {
+    // The MiniMax case above rides the display-only `report()` path, so it would still pass if
+    // `keyReport`'s projection were quietly defaulted back to the display quota. This drives the
+    // credential-bound helper directly: the binding resolves for BOTH calls (same single-key
+    // provider and probed credential), so the only variable left is the projection itself.
+    const provider = keyQuotaConfig("openrouter", "https://openrouter.ai/api/v1").providers.openrouter!;
+    const exhausted = { monthlyPercent: 100 };
+
+    const omitted = publishKeyReportForTests("openrouter", "openrouter:key-info", exhausted, provider, "openrouter-secret");
+    expect(omitted.report?.quota.monthlyPercent).toBe(100);
+    expect(omitted.routing).toBeUndefined();
+
+    const projected = { monthlyPercent: 100 };
+    const explicit = publishKeyReportForTests(
+      "openrouter", "openrouter:key-info", exhausted, provider, "openrouter-secret", projected,
+    );
+    expect(explicit.routing?.quota).toBe(projected);
+    expect(typeof explicit.routing?.binding).toBe("string");
+  });
+
+  test("routing quota scope does not apply a probed key cap to an Authorization override", async () => {
+    const probeAuth: Array<string | null> = [];
+    globalThis.fetch = (async (_input, init) => {
+      probeAuth.push(new Headers(init?.headers).get("authorization"));
+      return Response.json({ data: { limit: 20, limit_remaining: 0 } });
+    }) as typeof fetch;
+    const config = quotaCombo(keyQuotaConfig("openrouter", "https://openrouter.ai/api/v1", "spent-A"));
+    config.providers.openrouter!.headers = { Authorization: "Bearer live-B" };
+    await fetchProviderQuotaReports(config, true);
+    const request = buildOpenAIChatPassthroughRequest(routedProviderConfig("openrouter", config.providers.openrouter!), {
+      messages: [{ role: "user", content: "synthetic" }],
+    }, "primary-model", false);
+    expect(probeAuth).toEqual(["Bearer spent-A"]);
+    expect(new Headers(request.headers).get("authorization")).toBe("Bearer live-B");
+    expect(pickComboTarget(config, "quota-scope")?.target.provider).toBe("openrouter");
+
+    delete config.providers.openrouter!.headers;
+    await fetchProviderQuotaReports(config, true);
+    expect(pickComboTarget(config, "quota-scope")?.target.provider).toBe("fallback");
+  });
+
+  test("routing quota scope rechecks an Authorization override added after publication", async () => {
+    globalThis.fetch = (async () => Response.json({ data: { limit: 20, limit_remaining: 0 } })) as typeof fetch;
+    const config = quotaCombo(keyQuotaConfig("openrouter", "https://openrouter.ai/api/v1", "spent-A"));
+    await fetchProviderQuotaReports(config, true);
+    expect(pickComboTarget(config, "quota-scope")?.target.provider).toBe("fallback");
+    config.providers.openrouter!.headers = { aUtHoRiZaTiOn: "Bearer live-B" };
+    expect(pickComboTarget(config, "quota-scope")?.target.provider).toBe("openrouter");
+    delete config.providers.openrouter!.headers;
+    expect(pickComboTarget(config, "quota-scope")?.target.provider).toBe("fallback");
+  });
+
+  test("routing quota scope does not apply a probed key cap to an Anthropic x-api-key override", async () => {
+    const probeAuth: Array<string | null> = [];
+    globalThis.fetch = (async (_input, init) => {
+      probeAuth.push(new Headers(init?.headers).get("authorization"));
+      return Response.json({ usage: { limit: "100", used: "100" } });
+    }) as typeof fetch;
+    const config = quotaCombo(keyQuotaConfig("kimi-code", "https://api.kimi.com/coding/v1", "spent-A"));
+    config.providers["kimi-code"]!.adapter = "anthropic";
+    config.providers["kimi-code"]!.headers = { "x-api-key": "live-B" };
+    await fetchProviderQuotaReports(config, true);
+    expect(probeAuth).toEqual(["Bearer spent-A"]);
+    expect(pickComboTarget(config, "quota-scope")?.target.provider).toBe("kimi-code");
+    delete config.providers["kimi-code"]!.headers;
+    await fetchProviderQuotaReports(config, true);
+    expect(pickComboTarget(config, "quota-scope")?.target.provider).toBe("fallback");
+  });
+
+  test.each(["key", "omitted", "custom-key"])("routing quota scope follows effective Kimi authentication: %s", async mode => {
+    globalThis.fetch = (async () => Response.json({ usage: { limit: "100", used: "100" } })) as typeof fetch;
+    const name = mode === "custom-key" ? "kimi-code" : "kimi";
+    const config = quotaCombo(keyQuotaConfig(name, "https://api.kimi.com/coding/v1", "spent-A"));
+    if (mode === "omitted") delete config.providers[name]!.authMode;
+    expect(routedProviderConfig(name, config.providers[name]!).authMode).toBe(mode === "custom-key" ? "key" : "oauth");
+    const report = await fetchProviderQuotaReports(config, true);
+    expect(report.reports[0]?.quota.weeklyPercent).toBe(100);
+    expect(pickComboTarget(config, "quota-scope")?.target.provider).toBe(mode === "custom-key" ? "fallback" : "kimi");
+  });
+
+  test("routing quota scope keeps an exhausted Gemini group from vetoing an Antigravity Claude target", async () => {
+    await saveCredential("google-antigravity", {
+      access: "synthetic-agy-access", refresh: "synthetic-agy-refresh",
+      expires: Date.now() + 3600_000, projectId: "synthetic-project",
+    });
+    const resetTime = new Date(Date.now() + 3600_000).toISOString();
+    setAntigravityAccountQuotaTransportForTests({
+      resolveAddresses: async () => ({ hostname: "daily-cloudcode-pa.googleapis.com", addresses: [{ address: "142.250.0.1", family: 4 }], privateNetwork: false }),
+      pinnedPost: async url => {
+        expect(url.endsWith("retrieveUserQuotaSummary")).toBe(true);
+        return Response.json({ groups: [
+          { displayName: "Gemini Models", buckets: [{ window: "5h", remainingFraction: 0, resetTime }] },
+          { displayName: "Claude and GPT models", buckets: [{ window: "5h", remainingFraction: 1, resetTime }] },
+        ] });
+      },
+    });
+    const config = quotaCombo({ defaultProvider: "google-antigravity", providers: {
+      "google-antigravity": { adapter: "google", authMode: "oauth", baseUrl: "https://daily-cloudcode-pa.googleapis.com" },
+    } } as OcxConfig);
+    config.combos!["quota-scope"]!.targets[0]!.model = "claude-sonnet-4.6";
+    const report = await fetchProviderQuotaReports(config, true);
+    expect(report.reports[0]?.quota.customWindows).toEqual([
+      { label: "Gem", percent: 100, resetAt: Date.parse(resetTime) },
+      { label: "Cla", percent: 0, resetAt: Date.parse(resetTime) },
+    ]);
+    expect(pickComboTarget(config, "quota-scope")?.target).toMatchObject({ provider: "google-antigravity", model: "claude-sonnet-4.6" });
+  });
+
+  test("routing quota scope keeps an active Anthropic account report out of whole-provider selection", async () => {
+    await saveCredential("anthropic", {
+      access: "synthetic-claude-access", refresh: "synthetic-claude-refresh", expires: Date.now() + 3600_000,
+    });
+    globalThis.fetch = (async input => {
+      expect(String(input)).toBe("https://api.anthropic.com/api/oauth/usage");
+      return Response.json({ five_hour: { utilization: 100, resets_at: new Date(Date.now() + 3600_000).toISOString() } });
+    }) as typeof fetch;
+    const config = quotaCombo({ defaultProvider: "anthropic", providers: {
+      anthropic: { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com/v1" },
+    } } as OcxConfig);
+    const report = await fetchProviderQuotaReports(config, true);
+    expect(report.reports[0]?.quota.fiveHourPercent).toBe(100);
+    // Account selection and its exhaustion rules still decide whether this route can dispatch.
+    expect(pickComboTarget(config, "quota-scope")?.target.provider).toBe("anthropic");
+    config.providers.fallback!.disabled = true;
+    const now = Date.now();
+    const waits: number[] = [];
+    coolComboTarget("quota-scope", config.combos!["quota-scope"]!.targets[0]!, { now, cooldownMs: 1_000 });
+    const afterWait = await pickComboTargetWithWait(config, "quota-scope", {
+      now, waitForCooldownMs: 1_000, sleep: async ms => { waits.push(ms); },
+    });
+    expect(waits).toEqual([1_000]);
+    expect(afterWait?.target.provider).toBe("anthropic");
+  });
+
+  test("routing quota scope retains a verified cap through a transient refresh failure", async () => {
+    let transient = false;
+    globalThis.fetch = (async () => transient
+      ? new Response("unavailable", { status: 503 })
+      : Response.json({ data: { limit: 20, limit_remaining: 0 } })) as typeof fetch;
+    const config = quotaCombo(keyQuotaConfig("openrouter", "https://openrouter.ai/api/v1"));
+    await fetchProviderQuotaReports(config, true);
+    expect(pickComboTarget(config, "quota-scope")?.target.provider).toBe("fallback");
+    transient = true;
+    await fetchProviderQuotaReports(config, true);
+    expect(pickComboTarget(config, "quota-scope")?.target.provider).toBe("fallback");
+  });
+
+  test("routing quota scope stops vetoing the provider when a second key is added", async () => {
+    globalThis.fetch = (async () => Response.json({ data: { limit: 20, limit_remaining: 0 } })) as typeof fetch;
+    const config = quotaCombo(keyQuotaConfig("openrouter", "https://openrouter.ai/api/v1"));
+    await fetchProviderQuotaReports(config, true);
+    expect(pickComboTarget(config, "quota-scope")?.target.provider).toBe("fallback");
+    config.providers.openrouter!.apiKeyPool = [
+      { id: "old", key: "openrouter-secret" }, { id: "new", key: "second-key" },
+    ];
+    expect(pickComboTarget(config, "quota-scope")?.target.provider).toBe("openrouter");
+  });
+
+  test("routing quota scope rejects a cached cap after the active key changes", async () => {
+    globalThis.fetch = (async () => Response.json({ data: { limit: 20, limit_remaining: 0 } })) as typeof fetch;
+    const config = quotaCombo(keyQuotaConfig("openrouter", "https://openrouter.ai/api/v1"));
+    await fetchProviderQuotaReports(config, true);
+    config.providers.openrouter!.apiKey = "replacement-key";
+    expect(pickComboTarget(config, "quota-scope")?.target.provider).toBe("openrouter");
+  });
+
+  test("routing quota scope rejects a cached cap after an env key resolves differently", async () => {
+    const previous = process.env.OCX_TEST_ROUTING_QUOTA_KEY;
+    try {
+      process.env.OCX_TEST_ROUTING_QUOTA_KEY = "first-key";
+      globalThis.fetch = (async () => Response.json({ data: { limit: 20, limit_remaining: 0 } })) as typeof fetch;
+      const config = quotaCombo(keyQuotaConfig("openrouter", "https://openrouter.ai/api/v1", "$OCX_TEST_ROUTING_QUOTA_KEY"));
+      await fetchProviderQuotaReports(config, true);
+      process.env.OCX_TEST_ROUTING_QUOTA_KEY = "replacement-key";
+      expect(pickComboTarget(config, "quota-scope")?.target.provider).toBe("openrouter");
+    } finally {
+      if (previous === undefined) delete process.env.OCX_TEST_ROUTING_QUOTA_KEY;
+      else process.env.OCX_TEST_ROUTING_QUOTA_KEY = previous;
+    }
+  });
+
   test("OpenRouter quota renders a credit window against the per-key cap", async () => {
     const seen: Array<{ url: string; authorization?: string; redirect?: RequestRedirect }> = [];
     globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
```

## Current-dev consumer amendment

`src/combos/resolve.ts:126` has a newer catalog `quotaInactiveReason` consumer. MODIFY its loop from separate native-forward exemption + `getCachedProviderQuota(target.provider, now)` to `getCachedProviderRoutingQuota(target.provider, provider, now)`. Unknown routing evidence returns undefined, explicit exhausted evidence retains no_credit. MODIFY the existing quota inactive tests (locate with rg quotaInactiveReason tests) to use credential-bearing provider fixtures and prove display-only/mismatched evidence cannot mark catalog rows inactive. Update stale explanatory comments to reference the scoped cache. This preserves consistency after removed imports and is necessary current-dev integration, not unrelated catalog redesign.

## Design reflection D5 amendment

Accept Bohr D1-D6 with D5 corrected: MODIFY `getCachedProviderRoutingQuota` to return null for nonfinite/negative/future timestamps or age `>= maxAgeMs`, aligning runtime/catalog with the editor's exclusive deadline. Retain display getter compatibility. MODIFY `tests/codex-integration/catalog-zero-credit-picker.test.ts` with genuine WeakMap publication plus positive control; then mutate apiKey/baseUrl/adapter independently and require undefined inactivity. Test timestamp at exactly 30 minutes, future, negative and NaN as unknown. This is the shared scoped evidence boundary, not a new auth flow. No local suites; hosted final tip owns execution.
