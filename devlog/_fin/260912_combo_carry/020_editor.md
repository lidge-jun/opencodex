# editor carry

MODIFY exactly the paths in this public source diff. Apply each original commit in order with attribution. Resolve retired structure document into current runtime.md and gui-and-management-api.md; never restore the retired file. Earlier phase dependency: runtime.

Before/after source contract (review against current dev at P; source diff is the executable carry input):

```diff
diff --git a/docs-site/src/content/docs/fr/guides/combos.md b/docs-site/src/content/docs/fr/guides/combos.md
index 9434a1e98a..9073372327 100644
--- a/docs-site/src/content/docs/fr/guides/combos.md
+++ b/docs-site/src/content/docs/fr/guides/combos.md
@@ -281,9 +281,7 @@ Ouvrez le tableau de bord local et choisissez **Modèles → Combos**. L'espace
 combos, et son sélecteur de cible exclut les modèles désactivés et les combos imbriqués.

 Chaque cible affiche aussi un badge de quota en direct : **Disponible**, **Quota épuisé** ou **Quota inconnu**.
-Enregistrer et Créer ne sont désactivés que lorsque chaque cible activée dispose de preuves fraîches et complètes
-que son quota est épuisé. Les données manquantes, obsolètes, mal formées ou agrégées de façon incomplète restent
-inconnues et ne verrouillent jamais un contrôle. La récupération du quota réactive automatiquement l’action.
+L’éditeur bloque Enregistrer et Créer pour une raison de quota uniquement lorsque chaque cible utilisable dispose d’une confirmation serveur encore valide indiquant que la limite d’inférence liée à ses identifiants configurés est épuisée. Les quotas de compte, de modèle, de recherche et de MCP fournis uniquement à titre d’affichage, ainsi que les informations de routage absentes ou expirées, ne déclenchent pas ce blocage. Le blocage expire à la réinitialisation applicable ou à l’expiration de la validité des données et fait l’objet d’une nouvelle vérification lorsque la page devient active ou visible ; Actualiser recharge à la fois les données des combos et les quotas.

 ### CLI

diff --git a/docs-site/src/content/docs/guides/combos.md b/docs-site/src/content/docs/guides/combos.md
index c7d076d9b7..ef5ccde16c 100644
--- a/docs-site/src/content/docs/guides/combos.md
+++ b/docs-site/src/content/docs/guides/combos.md
@@ -349,10 +349,7 @@ task workflow.
 Open the local dashboard and choose **Models → Combos**. The workspace creates, edits, renames, and removes
 combos, and its target picker excludes disabled models and nested combos.

-Each target also shows a live quota badge: **Available**, **Out of quota**, or **Quota unknown**. Save and
-Create are disabled only when every enabled target has fresh, complete evidence that its quota is exhausted.
-Missing, stale, malformed, or incomplete aggregate evidence stays unknown and never locks a control. Polling
-continues while the workspace is visible, so recovery automatically restores the action. The dashboard
+Each target also shows a live quota badge: **Available**, **Out of quota**, or **Quota unknown**. The editor blocks Save and Create for quota only when every usable target has a current server-confirmed exhausted inference limit for its configured credential. Display-only account, model, search and MCP quota, or missing or expired routing evidence, does not cause this block. The block expires at the applicable reset or freshness boundary and is rechecked when the page becomes active or visible; Refresh reloads both Combo data and quota. The dashboard
 editor does not yet expose `cooldownMs` or `waitForCooldownMs`; use the configuration file or management
 API until the follow-up UI work lands.

diff --git a/docs-site/src/content/docs/ja/guides/combos.md b/docs-site/src/content/docs/ja/guides/combos.md
index f6eca53214..70c902ec6e 100644
--- a/docs-site/src/content/docs/ja/guides/combos.md
+++ b/docs-site/src/content/docs/ja/guides/combos.md
@@ -182,8 +182,7 @@ v1/base/v2 モードと完全な暗号化タスクのワークフローについ
 ローカル ダッシュボードを開き、**Models → コンボ**を選択します。ワークスペースはコンボを作成、編集、名前変更、削除し、そのターゲット ピッカーは無効なモデルとネストされたコンボを除外します。

 各ターゲットには **利用可能**、**クォータを使い切りました**、**クォータ不明** のライブバッジも表示されます。
-保存と作成が無効になるのは、有効な全ターゲットについて、クォータ枯渇を示す新鮮で完全な証拠がある場合だけです。
-欠落、古い、不正、または不完全な集約データは不明のままで、操作をロックしません。クォータが回復すると操作は自動で再び有効になります。ダッシュボードのエディターではまだ `cooldownMs` と `waitForCooldownMs` を設定できません。後続の UI 作業が完了するまでは、構成ファイルまたは管理 API を使用してください。
+エディターがクォータを理由に保存と作成をブロックするのは、使用可能なすべてのターゲットについて、設定された認証情報の推論上限に達したことを示す、サーバーによる確認が現在も有効な場合だけです。表示専用のアカウント・モデル・検索・MCP クォータや、ルーティングの根拠情報の欠落・期限切れによって、このブロックが発生することはありません。ブロックは該当するリセット時刻またはデータの有効期限に解除され、ページがアクティブになるか表示状態になると再確認されます。「更新」はコンボデータとクォータの両方を再読み込みします。ダッシュボードのエディターではまだ `cooldownMs` と `waitForCooldownMs` を設定できません。後続の UI 作業が完了するまでは、構成ファイルまたは管理 API を使用してください。

 ### CLI

diff --git a/docs-site/src/content/docs/ko/guides/combos.md b/docs-site/src/content/docs/ko/guides/combos.md
index 71e557f25c..80eac32c2d 100644
--- a/docs-site/src/content/docs/ko/guides/combos.md
+++ b/docs-site/src/content/docs/ko/guides/combos.md
@@ -187,9 +187,7 @@ v1/base/v2 모드와 암호화된 작업의 전체 흐름은 [Sub-agent Surface]

 로컬 대시보드를 열고 **Models → Combos**를 선택합니다. 워크스페이스는 콤보를 만들고, 편집하고, 이름을 바꾸고, 제거할 수 있으며, 대상 선택기에서는 비활성 모델과 중첩 콤보를 제외합니다.

-각 대상에는 **사용 가능**, **할당량 소진**, **할당량 알 수 없음** 실시간 배지도 표시됩니다. 저장과 만들기 버튼은
-활성화된 모든 대상에 할당량 소진을 입증하는 최신의 완전한 증거가 있을 때만 비활성화됩니다. 누락되거나 오래되거나
-형식이 잘못되었거나 집계가 불완전한 데이터는 알 수 없음으로 남으며 버튼을 잠그지 않습니다. 할당량이 복구되면 버튼도 자동으로 다시 활성화됩니다. 대시보드 편집기에서는 아직 `cooldownMs`나 `waitForCooldownMs`를 설정할 수 없습니다. 후속 UI 작업이 완료될 때까지 구성 파일이나 관리 API를 사용하세요.
+각 대상에는 **사용 가능**, **할당량 소진**, **할당량 알 수 없음** 실시간 배지도 표시됩니다. 편집기는 사용 가능한 모든 대상에 대해 설정된 인증 정보의 추론 한도가 소진되었다는 서버 확인이 현재 유효할 때만 할당량을 이유로 저장과 만들기를 차단합니다. 표시 전용 계정·모델·검색·MCP 할당량이나 누락되거나 만료된 라우팅 근거 정보는 이 차단을 일으키지 않습니다. 차단은 해당 한도의 초기화 시점이나 데이터 유효기간이 끝나면 해제되며 페이지가 활성화되거나 표시될 때 다시 확인됩니다. 새로 고침은 콤보 데이터와 할당량을 모두 다시 불러옵니다. 대시보드 편집기에서는 아직 `cooldownMs`나 `waitForCooldownMs`를 설정할 수 없습니다. 후속 UI 작업이 완료될 때까지 구성 파일이나 관리 API를 사용하세요.

 ### CLI

diff --git a/docs-site/src/content/docs/ru/guides/combos.md b/docs-site/src/content/docs/ru/guides/combos.md
index 868416ae5b..b873f4ed03 100644
--- a/docs-site/src/content/docs/ru/guides/combos.md
+++ b/docs-site/src/content/docs/ru/guides/combos.md
@@ -234,9 +234,7 @@ effort вызывающей стороне и цели.
 переименовывать и удалять combo, а селектор целей исключает отключённые модели и вложенные combo.

 У каждой цели также отображается актуальный значок квоты: **Доступно**, **Квота исчерпана** или **Квота неизвестна**.
-Кнопки сохранения и создания отключаются только тогда, когда для всех включённых целей есть свежие и полные
-данные об исчерпании квоты. Отсутствующие, устаревшие, некорректные или неполные агрегированные данные остаются
-неизвестными и никогда не блокируют управление. Восстановление квоты автоматически снова включает действие. Редактор дашборда пока не предоставляет `cooldownMs` и `waitForCooldownMs`; до появления соответствующего UI используйте файл конфигурации или Management API.
+Редактор блокирует сохранение и создание из-за квоты только тогда, когда для каждой пригодной к использованию цели есть действующее подтверждение сервера об исчерпании лимита инференса для настроенных учётных данных. Квоты аккаунта, модели, поиска и MCP, предназначенные только для отображения, а также отсутствующие или просроченные данные для принятия решения о маршрутизации не вызывают эту блокировку. Блокировка истекает при соответствующем сбросе квоты или окончании срока актуальности данных и проверяется повторно, когда страница становится активной или видимой; «Обновить» повторно загружает и данные combo, и квоты. Редактор дашборда пока не предоставляет `cooldownMs` и `waitForCooldownMs`; до появления соответствующего UI используйте файл конфигурации или Management API.

 ### CLI

diff --git a/docs-site/src/content/docs/tr/guides/combos.md b/docs-site/src/content/docs/tr/guides/combos.md
index 520c157e83..b8cd5bad0d 100644
--- a/docs-site/src/content/docs/tr/guides/combos.md
+++ b/docs-site/src/content/docs/tr/guides/combos.md
@@ -312,9 +312,7 @@ hedef seçicisi ise devre dışı bırakılmış modelleri ve iç içe geçmiş
 hariç tutar.

 Her hedef ayrıca canlı bir kota rozeti gösterir: **Kullanılabilir**, **Kota tükendi** veya **Kota bilinmiyor**.
-Kaydet ve Oluştur yalnızca etkin hedeflerin tamamı için kotanın tükendiğini gösteren güncel ve eksiksiz kanıt varsa
-devre dışı bırakılır. Eksik, eski, bozuk veya tamamlanmamış toplu kanıt bilinmiyor olarak kalır ve denetimleri asla
-kilitlemez. Kota yenilendiğinde işlem otomatik olarak yeniden etkinleşir.
+Düzenleyici, kota nedeniyle Kaydet ve Oluştur işlemlerini yalnızca kullanılabilir hedeflerin tümü için yapılandırılmış kimlik bilgisine ait çıkarım sınırının tükendiğini doğrulayan geçerli sunucu bilgisi varsa engeller. Yalnızca görüntüleme amaçlı hesap, model, arama ve MCP kotaları ya da eksik veya süresi dolmuş yönlendirme kanıtları bu engellemeye neden olmaz. Engelleme, ilgili sıfırlama zamanında veya verinin güncellik süresi dolduğunda sona erer ve sayfa etkin ya da görünür olduğunda yeniden kontrol edilir; Yenile, hem kombo verilerini hem de kotaları yeniden yükler.

 ### CLI

@@ -411,4 +409,3 @@ Hata hedefe özgü olmaktan ziyade uç (terminal) bir hataydı. Geçersiz girdiy
 düzeltin, aşırı büyük bir bağlamı azaltın, bir politika reddini işleyin veya
 reddedilen istek kaynağını düzeltin. Kombolar bu durumlar için atlama yapmaz.

-
diff --git a/docs-site/src/content/docs/zh-cn/guides/combos.md b/docs-site/src/content/docs/zh-cn/guides/combos.md
index d84efca472..abe32ae786 100644
--- a/docs-site/src/content/docs/zh-cn/guides/combos.md
+++ b/docs-site/src/content/docs/zh-cn/guides/combos.md
@@ -211,9 +211,7 @@ combo 失败分为 **跳转** 失败和 **终止** 失败。

 打开本地 dashboard 并选择 **Models → Combos**。该工作区可以创建、编辑、重命名和删除 combo，其目标选择器会排除已禁用的模型和嵌套 combo。

-每个目标还会显示实时额度徽章：**可用**、**额度已用尽**或**额度未知**。只有当所有已启用目标都有最新、
-完整的额度耗尽证据时，保存和创建操作才会被禁用。缺失、过期、格式错误或聚合不完整的证据会保持为未知，
-绝不会锁定控件。额度恢复后，操作会自动重新启用。dashboard 编辑器目前还不能设置 `cooldownMs` 或 `waitForCooldownMs`；在后续 UI 完成前，请使用配置文件或管理 API。
+每个目标还会显示实时额度徽章：**可用**、**额度已用尽**或**额度未知**。只有当每个可用目标均有当前有效的服务器确认，表明其所配置凭据的推理限额已耗尽时，编辑器才会因额度而禁止保存和创建。仅供显示的账户、模型、搜索和 MCP 额度，以及缺失或已过期的路由依据，都不会触发此限制。此限制会在适用的重置时间或数据有效期结束时解除，并在页面变为活动或可见状态时重新检查；刷新会同时重新加载 Combo 数据和额度。dashboard 编辑器目前还不能设置 `cooldownMs` 或 `waitForCooldownMs`；在后续 UI 完成前，请使用配置文件或管理 API。

 ### CLI

diff --git a/docs-site/src/content/docs/zh-tw/guides/combos.md b/docs-site/src/content/docs/zh-tw/guides/combos.md
index d82b399e6f..ce3ad70a94 100644
--- a/docs-site/src/content/docs/zh-tw/guides/combos.md
+++ b/docs-site/src/content/docs/zh-tw/guides/combos.md
@@ -219,9 +219,7 @@ Codex v2 子代理有一個重要限制（[issue #92](https://github.com/lidge-j

 開啟本機儀表板並選擇 **Combos**。該工作區可建立、編輯、重新命名與移除 combo，且其目標 picker 會排除已停用的模型與巢狀 combo。

-每個目標也會顯示即時額度徽章：**可用**、**額度已用盡**或**額度未知**。只有當所有已啟用目標都有最新、
-完整的額度耗盡證據時，儲存與建立操作才會停用。缺失、過期、格式錯誤或聚合不完整的證據會維持未知，
-絕不會鎖住控制項。額度恢復後，操作會自動重新啟用。
+每個目標也會顯示即時額度徽章：**可用**、**額度已用盡**或**額度未知**。只有當每個可用目標均有目前有效的伺服器確認，顯示其所設定憑證的推論限額已耗盡時，編輯器才會因配額而停用儲存與建立。僅供顯示的帳戶、模型、搜尋與 MCP 配額，以及缺失或已過期的路由依據，都不會觸發此限制。此限制會在適用的重設時間或資料有效期限結束時解除，並在頁面變為作用中或可見狀態時重新檢查；重新整理會同時重新載入 Combo 資料與配額。

 ### CLI

diff --git a/gui/src/combo-workspace-data.ts b/gui/src/combo-workspace-data.ts
index bf8b881c55..b89bff656f 100644
--- a/gui/src/combo-workspace-data.ts
+++ b/gui/src/combo-workspace-data.ts
@@ -4,6 +4,7 @@
  */

 import { SUPPORTED_NATIVE_OPENAI_SLUGS } from "../../src/codex/catalog/native-models";
+import { PROVIDER_QUOTA_MAX_AGE_MS } from "../../src/providers/quota-types";
 import type { TKey } from "./i18n/shared";

 export { SUPPORTED_NATIVE_OPENAI_SLUGS };
@@ -92,7 +93,7 @@ export type ComboQuotaState = "available" | "exhausted" | "unknown";
 export type ProviderQuotaStates = Readonly<Record<string, ComboQuotaState>>;

 /** Matches the management endpoint's bounded last-good quota lifetime. */
-export const COMBO_QUOTA_MAX_AGE_MS = 30 * 60_000;
+export const COMBO_QUOTA_MAX_AGE_MS = PROVIDER_QUOTA_MAX_AGE_MS;

 let comboTargetKeySeq = 0;

@@ -282,133 +283,36 @@ function finiteNumber(value: unknown): number | null {
   return typeof value === "number" && Number.isFinite(value) ? value : null;
 }

-function quotaTimestampIsFresh(value: unknown, now: number): boolean {
-  const timestamp = finiteNumber(value);
-  return timestamp !== null && now - timestamp < COMBO_QUOTA_MAX_AGE_MS;
-}
-
-function nonNegativeInteger(value: unknown): number | null {
-  const number = finiteNumber(value);
-  return number !== null && Number.isInteger(number) && number >= 0 ? number : null;
-}
-
-function aggregateWindowIsComplete(value: unknown, now: number): boolean {
-  const window = recordFromUnknown(value);
-  const usedPercent = finiteNumber(window?.usedPercent);
-  return !!window
-    && usedPercent !== null
-    && usedPercent >= 0
-    && nonNegativeInteger(window.includedAccounts) !== null
-    && (nonNegativeInteger(window.includedAccounts) ?? 0) > 0
-    && nonNegativeInteger(window.excludedAccounts) === 0
-    && window.incomplete === false
-    && quotaTimestampIsFresh(window.updatedAt, now);
-}
-
-function aggregateEvidenceIsComplete(value: unknown, now: number): boolean {
-  const aggregation = recordFromUnknown(value);
-  if (
-    !aggregation
-    || aggregation.kind !== "capacity-weighted-v1"
-    || aggregation.scope !== "routable-known"
-    || aggregation.presentation !== "aggregate"
-    || aggregation.incomplete !== false
-  ) return false;
-
-  for (const key of [
-    "includedAccounts",
-    "excludedAccounts",
-    "unknownPlanAccounts",
-    "missingQuotaAccounts",
-    "pausedAccounts",
-    "reauthAccounts",
-    "staleQuotaAccounts",
-    "partialWindowAccounts",
-  ] as const) {
-    if (nonNegativeInteger(aggregation[key]) === null) return false;
-  }
-  if ((nonNegativeInteger(aggregation.includedAccounts) ?? 0) === 0) return false;
-  for (const key of [
-    "excludedAccounts",
-    "unknownPlanAccounts",
-    "missingQuotaAccounts",
-    "pausedAccounts",
-    "reauthAccounts",
-    "staleQuotaAccounts",
-    "partialWindowAccounts",
-  ] as const) {
-    if (aggregation[key] !== 0) return false;
-  }
-
-  let hasWindow = false;
-  for (const key of ["fiveHour", "weekly", "monthly"] as const) {
-    if (!Object.hasOwn(aggregation, key)) continue;
-    if (!aggregateWindowIsComplete(aggregation[key], now)) return false;
-    hasWindow = true;
-  }
-  if (Object.hasOwn(aggregation, "customWindows")) {
-    if (!Array.isArray(aggregation.customWindows)) return false;
-    for (const value of aggregation.customWindows) {
-      const custom = recordFromUnknown(value);
-      if (!custom || typeof custom.label !== "string" || !custom.label.trim()) return false;
-      if (!aggregateWindowIsComplete(custom, now)) return false;
-      hasWindow = true;
-    }
-  }
-  return hasWindow;
+function routingQuotaFromReport(raw: Record<string, unknown>, now: number): {
+  state: "available" | "exhausted";
+  validUntil: number;
+} | null {
+  const routing = recordFromUnknown(raw.routingQuota);
+  if (!routing || (routing.state !== "available" && routing.state !== "exhausted")) return null;
+  const updatedAt = finiteNumber(routing.updatedAt);
+  const validUntil = finiteNumber(routing.validUntil);
+  if (updatedAt === null || updatedAt < 0 || updatedAt > now
+    || now - updatedAt >= COMBO_QUOTA_MAX_AGE_MS
+    || validUntil === null || validUntil <= now
+    || validUntil > updatedAt + COMBO_QUOTA_MAX_AGE_MS) return null;
+  return { state: routing.state, validUntil };
 }

 function quotaStateFromReport(raw: Record<string, unknown>, now: number): ComboQuotaState {
-  if (!quotaTimestampIsFresh(raw.updatedAt, now)) return "unknown";
-  const quota = recordFromUnknown(raw.quota);
-  if (!quota || !quotaTimestampIsFresh(quota.updatedAt, now)) return "unknown";
-  if (raw.aggregation !== undefined && !aggregateEvidenceIsComplete(raw.aggregation, now)) return "unknown";
-
-  let hasEvidence = false;
-  let exhausted = false;
-  for (const key of ["fiveHourPercent", "weeklyPercent", "monthlyPercent"] as const) {
-    if (!Object.hasOwn(quota, key)) continue;
-    const percent = finiteNumber(quota[key]);
-    if (percent === null || percent < 0) return "unknown";
-    hasEvidence = true;
-    if (percent >= 100) exhausted = true;
-  }
-  for (const key of ["fiveHourResetAt", "weeklyResetAt", "monthlyResetAt"] as const) {
-    if (Object.hasOwn(quota, key) && finiteNumber(quota[key]) === null) return "unknown";
-  }
-
-  if (Object.hasOwn(quota, "customWindows")) {
-    if (!Array.isArray(quota.customWindows)) return "unknown";
-    for (const value of quota.customWindows) {
-      const window = recordFromUnknown(value);
-      const percent = finiteNumber(window?.percent);
-      if (!window || typeof window.label !== "string" || !window.label.trim() || percent === null || percent < 0) {
-        return "unknown";
-      }
-      if (Object.hasOwn(window, "resetAt") && finiteNumber(window.resetAt) === null) return "unknown";
-      hasEvidence = true;
-      if (percent >= 100) exhausted = true;
-    }
-  }
+  return routingQuotaFromReport(raw, now)?.state ?? "unknown";
+}

-  if (Object.hasOwn(quota, "creditsUsd")) {
-    const credits = recordFromUnknown(quota.creditsUsd);
-    if (!credits) return "unknown";
-    const used = finiteNumber(credits.used);
-    const limit = finiteNumber(credits.limit);
-    const remaining = finiteNumber(credits.remaining);
-    const percent = finiteNumber(credits.percent);
-    if (used === null || used < 0 || limit === null || limit < 0 || remaining === null || percent === null || percent < 0) {
-      return "unknown";
-    }
-    if (credits.unlimited !== undefined && typeof credits.unlimited !== "boolean") return "unknown";
-    if (Object.hasOwn(credits, "expiresAt") && finiteNumber(credits.expiresAt) === null) return "unknown";
-    hasEvidence = true;
-    if (credits.unlimited !== true && remaining <= 0) exhausted = true;
+/** The next expiry also wakes the page when no poll response has arrived. */
+export function nextProviderQuotaStateExpiration(reports: unknown, now = Date.now()): number | undefined {
+  if (!Array.isArray(reports)) return undefined;
+  let next: number | undefined;
+  for (const value of reports) {
+    const report = recordFromUnknown(value);
+    if (!report || typeof report.provider !== "string" || !report.provider.trim()) continue;
+    const routing = routingQuotaFromReport(report, now);
+    if (routing && (next === undefined || routing.validUntil < next)) next = routing.validUntil;
   }
-
-  if (!hasEvidence) return "unknown";
-  return exhausted ? "exhausted" : "available";
+  return next;
 }

 /** Fail-unknown parser for the live `/api/provider-quotas` report array. */
diff --git a/gui/src/pages/Combos.tsx b/gui/src/pages/Combos.tsx
index ca05ca8fd5..dee11a7e69 100644
--- a/gui/src/pages/Combos.tsx
+++ b/gui/src/pages/Combos.tsx
@@ -5,6 +5,7 @@ import {
   comboModelId,
   parseComboList,
   providerQuotaStatesFromReports,
+  nextProviderQuotaStateExpiration,
   toPutBody,
 } from "../combo-workspace-data";
 import { hideRedundantChatGptForwardProviders } from "../provider-workspace/catalog";
@@ -239,12 +240,24 @@ export default function Combos({
       enabled: active,
     },
   );
-  const providerQuotaStates = useMemo(
-    () => quotaResource.lastAttemptOk
-      ? providerQuotaStatesFromReports(quotaResource.data?.reports)
-      : {},
-    [quotaResource.data, quotaResource.lastAttemptOk],
-  );
+  const [quotaNow, setQuotaClock] = useState(() => Date.now());
+  const quotaReports = active && quotaResource.lastAttemptOk ? quotaResource.data?.reports : undefined;
+  const providerQuotaStates = providerQuotaStatesFromReports(quotaReports, quotaNow);
+  const quotaExpiry = nextProviderQuotaStateExpiration(quotaReports, quotaNow);
+  useEffect(() => {
+    if (!active) return;
+    const recheck = () => setQuotaClock(Date.now());
+    // The render may cross this boundary before effects run. Keep its deadline and wake now.
+    // A new snapshot may be newer than this clock, so unknown state also gets one immediate check.
+    const timer = window.setTimeout(recheck,
+      quotaExpiry === undefined ? 0 : Math.max(0, quotaExpiry - Date.now()));
+    const onVisible = () => { if (document.visibilityState === "visible") recheck(); };
+    document.addEventListener("visibilitychange", onVisible);
+    return () => {
+      window.clearTimeout(timer);
+      document.removeEventListener("visibilitychange", onVisible);
+    };
+  }, [active, apiBase, quotaResource.data, quotaResource.lastAttemptOk, quotaExpiry]);

   const data = state.data ?? retainedData ?? undefined;
   const combos = data?.combos ?? [];
@@ -361,7 +374,7 @@ export default function Combos({
           models={models}
           cataloguedComboIds={cataloguedComboIds}
           loading={false}
-          onRefresh={() => resource.refresh()}
+          onRefresh={() => { resource.refresh(); quotaResource.refresh(); }}
           onSave={saveCombo}
           onRemove={removeCombo}
           onAdd={() => setAdding(true)}
diff --git a/gui/tests/combo-workspace-dirty.test.tsx b/gui/tests/combo-workspace-dirty.test.tsx
index 1f3566dbbe..c82ac799d4 100644
--- a/gui/tests/combo-workspace-dirty.test.tsx
+++ b/gui/tests/combo-workspace-dirty.test.tsx
@@ -2,7 +2,7 @@ import { afterEach, beforeEach, expect, test } from "bun:test";
 import { Window } from "happy-dom";
 import { act, StrictMode } from "react";
 import type { Root } from "react-dom/client";
-import type { ComboItem } from "../src/combo-workspace-data";
+import { type ComboItem, providerQuotaStatesFromReports } from "../src/combo-workspace-data";
 import ComboWorkspace from "../src/components/ComboWorkspace";
 import { LanguageProvider } from "../src/i18n/provider";

@@ -178,11 +178,14 @@ test("dirty Save disables for exhausted targets and re-enables on quota recovery
   document.body.append(container);
   const root = createRoot(container);

-  const render = (quotaState: "available" | "exhausted") => (
+  const now = Date.now();
+  const display = { provider: "openai", updatedAt: now,
+    quota: { updatedAt: now, customWindows: [{ label: "Search", percent: 100 }] } };
+  const render = (routingQuota?: Record<string, unknown>) => (
     <LanguageProvider>
       <ComboWorkspace
         combos={combos}
-        providerQuotaStates={{ openai: quotaState }}
+        providerQuotaStates={providerQuotaStatesFromReports([{ ...display, routingQuota }], now)}
         providers={[{ name: "openai" }]}
         models={[{ provider: "openai", id: "gpt-5" }]}
         loading={false}
@@ -197,7 +200,7 @@ test("dirty Save disables for exhausted targets and re-enables on quota recovery
     </LanguageProvider>
   );

-  await act(async () => { root.render(render("exhausted")); });
+  await act(async () => { root.render(render({ state: "exhausted", updatedAt: now, validUntil: now + 60_000 })); });
   await flushTimers();
   await act(async () => { railButton(container, "combo/alpha").click(); });
   await flushTimers();
@@ -208,7 +211,11 @@ test("dirty Save disables for exhausted targets and re-enables on quota recovery
   expect(container.querySelector<HTMLButtonElement>("#cwi-edit-save")!.disabled).toBe(true);
   expect(container.textContent).toContain("All enabled targets are out of quota");

-  await act(async () => { root.render(render("available")); });
+  await act(async () => { root.render(render()); });
+  expect(container.querySelector<HTMLButtonElement>("#cwi-edit-save")!.disabled).toBe(false);
+  expect(container.textContent).not.toContain("All enabled targets are out of quota");
+
+  await act(async () => { root.render(render({ state: "available", updatedAt: now, validUntil: now + 60_000 })); });
   expect(container.querySelector<HTMLButtonElement>("#cwi-edit-save")!.disabled).toBe(false);
   expect(container.textContent).not.toContain("All enabled targets are out of quota");

diff --git a/gui/tests/combo-workspace-empty.test.tsx b/gui/tests/combo-workspace-empty.test.tsx
index 4fb8416067..ba6efc49d7 100644
--- a/gui/tests/combo-workspace-empty.test.tsx
+++ b/gui/tests/combo-workspace-empty.test.tsx
@@ -5,6 +5,7 @@ import type { Root } from "react-dom/client";
 import { renderToStaticMarkup } from "react-dom/server";
 import ComboWorkspace from "../src/components/ComboWorkspace";
 import { LanguageProvider } from "../src/i18n/provider";
+import { providerQuotaStatesFromReports } from "../src/combo-workspace-data";

 const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
 let previousGlobals: Record<(typeof globals)[number], unknown>;
@@ -134,11 +135,14 @@ test("first-combo Create disables only while every usable target is known exhaus
   document.body.append(container);
   const root = createRoot(container);

-  const render = (quotaState: "available" | "exhausted") => (
+  const now = Date.now();
+  const display = { provider: "openai", updatedAt: now,
+    quota: { updatedAt: now, customWindows: [{ label: "Search", percent: 100 }] } };
+  const render = (routingQuota?: Record<string, unknown>) => (
     <LanguageProvider>
       <ComboWorkspace
         combos={[]}
-        providerQuotaStates={{ openai: quotaState }}
+        providerQuotaStates={providerQuotaStatesFromReports([{ ...display, routingQuota }], now)}
         providers={[{ name: "openai" }]}
         models={[{ provider: "openai", id: "gpt-5" }]}
         loading={false}
@@ -153,7 +157,7 @@ test("first-combo Create disables only while every usable target is known exhaus
     </LanguageProvider>
   );

-  await act(async () => { root.render(render("exhausted")); });
+  await act(async () => { root.render(render({ state: "exhausted", updatedAt: now, validUntil: now + 60_000 })); });
   await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });

   const providerSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Provider"]')!;
@@ -167,7 +171,11 @@ test("first-combo Create disables only while every usable target is known exhaus
   expect(createButton.disabled).toBe(true);
   expect(container.textContent).toContain("All enabled targets are out of quota");

-  await act(async () => { root.render(render("available")); });
+  await act(async () => { root.render(render()); });
+  expect(container.querySelector<HTMLButtonElement>("#cwi-edit-create")!.disabled).toBe(false);
+  expect(container.textContent).not.toContain("All enabled targets are out of quota");
+
+  await act(async () => { root.render(render({ state: "available", updatedAt: now, validUntil: now + 60_000 })); });
   expect(container.querySelector<HTMLButtonElement>("#cwi-edit-create")!.disabled).toBe(false);
   expect(container.textContent).not.toContain("All enabled targets are out of quota");

diff --git a/gui/tests/page-loading-contract.test.tsx b/gui/tests/page-loading-contract.test.tsx
index 2ab6b88385..52a889fb28 100644
--- a/gui/tests/page-loading-contract.test.tsx
+++ b/gui/tests/page-loading-contract.test.tsx
@@ -1,6 +1,6 @@
-import { afterEach, beforeEach, expect, test } from "bun:test";
+import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
 import { Window } from "happy-dom";
-import { act } from "react";
+import { act, useLayoutEffect } from "react";
 import type { Root } from "react-dom/client";
 import Combos from "../src/pages/Combos";
 import { LanguageProvider } from "../src/i18n/provider";
@@ -204,3 +204,111 @@ test("Combos announces silent revalidation over cached content via aria-busy", a
   await act(async () => { root.unmount(); });
   container.remove();
 });
+
+
+test.each(["timer", "visible", "active", "commit-boundary"])("Combos expires a quota block before a new response: %s", async wake => {
+  const { createRoot } = await import("react-dom/client");
+  const startedAt = Date.now();
+  let now = startedAt;
+  const clock = spyOn(Date, "now").mockImplementation(() => now);
+  const schedule = testWindow.setTimeout.bind(testWindow);
+  const cancel = testWindow.clearTimeout.bind(testWindow);
+  const expiryTimers = new Set<number>();
+  let expire: (() => void) | undefined;
+  const scheduleSpy = spyOn(testWindow, "setTimeout").mockImplementation((callback, delay, ...args) => {
+    const timer = schedule(callback, delay, ...args);
+    if (delay === 123_456 && typeof callback === "function") {
+      expiryTimers.add(timer);
+      expire = () => callback(...args);
+    }
+    return timer;
+  });
+  const cancelSpy = spyOn(testWindow, "clearTimeout").mockImplementation(timer => {
+    expiryTimers.delete(timer);
+    cancel(timer);
+  });
+  const item = { id: "alpha", model: "combo/alpha", strategy: "failover", stickyLimit: 1,
+    targets: [{ provider: "keyed", model: "m1" }] };
+  let quotaFetches = 0;
+  const workspaceFetches = new Map<string, number>();
+  const waitForAbort = (signal: AbortSignal | null | undefined) => new Promise<Response>((_resolve, reject) => {
+    if (signal?.aborted) reject(signal.reason);
+    else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
+  });
+  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
+    const url = String(input);
+    if (url.includes("/api/provider-quotas")) {
+      quotaFetches += 1;
+      if (quotaFetches > 1) return waitForAbort(init?.signal);
+      return Response.json({ reports: [{ provider: "keyed", updatedAt: startedAt,
+        quota: { updatedAt: startedAt, fiveHourPercent: 100 },
+        routingQuota: { state: "exhausted", updatedAt: startedAt, validUntil: startedAt + 123_456 },
+      }] });
+    }
+    const count = (workspaceFetches.get(url) ?? 0) + 1;
+    workspaceFetches.set(url, count);
+    if (count > 1) return waitForAbort(init?.signal);
+    if (url.includes("/api/combos")) return Response.json({ combos: [item] });
+    if (url.includes("/api/config")) return Response.json({ providers: {
+      keyed: { adapter: "openai-chat", authMode: "key", baseUrl: "https://provider.example/v1", defaultModel: "m1" },
+    } });
+    if (url.includes("/api/models")) return Response.json([
+      { provider: "keyed", id: "m1" }, { provider: "combo", id: "alpha" },
+    ]);
+    return new Response(null, { status: 404 });
+  }) as typeof fetch;
+  const container = document.createElement("div");
+  document.body.append(container);
+  const root = createRoot(container);
+  function ClockBoundary({ active, expireDuringCommit }: { active: boolean; expireDuringCommit: boolean }) {
+    useLayoutEffect(() => {
+      if (expireDuringCommit) now = startedAt + 123_456;
+    }, [expireDuringCommit]);
+    return <LanguageProvider><Combos apiBase={API_BASE} active={active} /></LanguageProvider>;
+  }
+  const render = (active = true, expireDuringCommit = false) =>
+    <ClockBoundary active={active} expireDuringCommit={expireDuringCommit} />;
+  try {
+    await act(async () => { root.render(render()); });
+    await act(async () => { await new Promise<void>(resolve => schedule(resolve, 0)); });
+    const rail = [...container.querySelectorAll<HTMLButtonElement>(".combos-workspace-rail-row")]
+      .find(row => row.querySelector(".combos-workspace-rail-name")?.textContent === "combo/alpha");
+    expect(rail).toBeDefined();
+    await act(async () => { rail!.click(); });
+    await act(async () => { await new Promise<void>(resolve => schedule(resolve, 0)); });
+    const alias = container.querySelector<HTMLInputElement>("#cwi-edit-alias")!;
+    await act(async () => {
+      Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!.call(alias, "kept-draft");
+      alias.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
+    });
+    expect(container.querySelector<HTMLButtonElement>("#cwi-edit-save")!.disabled).toBe(true);
+    expect(expire).toBeDefined();
+    if (wake === "visible") {
+      Object.defineProperty(testWindow.document, "visibilityState", { configurable: true, value: "hidden" });
+      await act(async () => { testWindow.document.dispatchEvent(new testWindow.Event("visibilitychange")); });
+    } else if (wake === "active" || wake === "commit-boundary") {
+      await act(async () => { root.render(render(false)); });
+    }
+    now = startedAt + 123_456 - (wake === "commit-boundary" ? 1 : 0);
+    await act(async () => {
+      if (wake === "timer") expire!();
+      else if (wake === "visible") {
+        Object.defineProperty(testWindow.document, "visibilityState", { configurable: true, value: "visible" });
+        testWindow.document.dispatchEvent(new testWindow.Event("visibilitychange"));
+      } else root.render(render(true, wake === "commit-boundary"));
+    });
+    if (wake === "commit-boundary") {
+      await act(async () => { await new Promise<void>(resolve => schedule(resolve, 0)); });
+    }
+    expect(container.querySelector<HTMLInputElement>("#cwi-edit-alias")!.value).toBe("kept-draft");
+    expect(container.querySelector<HTMLButtonElement>("#cwi-edit-save")!.disabled).toBe(false);
+    if (wake === "timer") expect(quotaFetches).toBe(1);
+  } finally {
+    await act(async () => { root.unmount(); });
+    container.remove();
+    scheduleSpy.mockRestore();
+    cancelSpy.mockRestore();
+    clock.mockRestore();
+  }
+  expect(expiryTimers.size).toBe(0);
+});
diff --git a/src/providers/quota-routing-cache.ts b/src/providers/quota-routing-cache.ts
index 1e45d60065..3acaf1be50 100644
--- a/src/providers/quota-routing-cache.ts
+++ b/src/providers/quota-routing-cache.ts
@@ -3,6 +3,7 @@ import type { OcxProviderConfig } from "../types";
 import type { ProviderQuota, ProviderQuotaReport } from "./quota";
 import { providerUsesKeyAuthOverride, resolveProviderApiKey } from "./key-store";
 import { getProviderRegistryEntry } from "./registry";
+import { PROVIDER_QUOTA_MAX_AGE_MS } from "./quota-types";

 export interface ProviderQuotaRoutingEvidence {
   quota: ProviderQuota;
@@ -54,7 +55,7 @@ export function replaceCachedProviderQuotas(
 export function getCachedProviderQuota(
   provider: string,
   now: number,
-  maxAgeMs = 30 * 60_000,
+  maxAgeMs = PROVIDER_QUOTA_MAX_AGE_MS,
 ): ProviderQuota | null {
   const quota = quotaCache.get(provider)?.quota;
   if (!quota) return null;
@@ -67,7 +68,7 @@ export function getCachedProviderRoutingQuota(
   name: string,
   provider: OcxProviderConfig | undefined,
   now: number,
-  maxAgeMs = 30 * 60_000,
+  maxAgeMs = PROVIDER_QUOTA_MAX_AGE_MS,
 ): ProviderQuota | null {
   if (!provider || provider.disabled === true || (provider.authMode ?? "key") !== "key") return null;
   // An active-key report cannot speak for the other keys the dispatcher may select.
diff --git a/src/providers/quota-types.ts b/src/providers/quota-types.ts
index 873eb30221..e0bdf9cb4f 100644
--- a/src/providers/quota-types.ts
+++ b/src/providers/quota-types.ts
@@ -8,6 +8,13 @@
  * blocks any later attempt to load one side without the other.
  */

+export const PROVIDER_QUOTA_MAX_AGE_MS = 30 * 60_000;
+
+/** Management-only eligibility evidence; private credential binding never leaves the server. */
+export type ProviderRoutingQuota =
+  | { state: "unknown" }
+  | { state: "available" | "exhausted"; updatedAt: number; validUntil: number };
+
 export interface ProviderQuotaWindow {
   label: string;
   percent: number;
diff --git a/src/providers/quota.ts b/src/providers/quota.ts
index ab23070bea..f6d96c5a35 100644
--- a/src/providers/quota.ts
+++ b/src/providers/quota.ts
@@ -54,6 +54,7 @@ import type {
   ProviderQuota,
   ProviderQuotaCreditsUsd,
   ProviderQuotaWindow,
+  ProviderRoutingQuota,
 } from "./quota-types";
 import {
   clearKiroAccountUsageState,
@@ -139,6 +140,8 @@ export interface ProviderQuotaReport {
   source: string;
   quota: ProviderQuota;
   updatedAt: number;
+  /** Added by the management response projection, never stored on a cached report. */
+  routingQuota?: ProviderRoutingQuota;
   reverseEngineered?: boolean;
   /**
    * The row was OBSERVED in-band on a streaming turn rather than probed.
diff --git a/src/server/management/provider-routes.ts b/src/server/management/provider-routes.ts
index 1439d7899c..847b240994 100644
--- a/src/server/management/provider-routes.ts
+++ b/src/server/management/provider-routes.ts
@@ -57,6 +57,9 @@ import {
 import { extractGoogleAiStudioModelItems } from "../../providers/google-ai-studio-model-discovery";
 import { routedSlug, slugEquals } from "../../providers/slug-codec";
 import { clearAccountQuotaCache, clearProviderQuotaCache, fetchProviderQuotaReports } from "../../providers/quota";
+import { getCachedProviderRoutingQuota } from "../../providers/quota-routing-cache";
+import { PROVIDER_QUOTA_MAX_AGE_MS, type ProviderRoutingQuota } from "../../providers/quota-types";
+import { cachedProviderQuotaIsExhausted } from "../../combos/resolve";
 import { clearKeyCooldowns } from "../../providers/key-failover";
 import { providerRequestPacingStatus } from "../../providers/request-pacing";
 import { CODEX_FORWARD_BASE_URL, isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
@@ -689,12 +692,54 @@ function canonicalOpenAiBudgetPatchError(
     ?? providerEmptyToolOutputConfigError("openai", applied.next);
 }

+function providerRoutingQuota(config: OcxConfig, name: string, now: number): ProviderRoutingQuota {
+  const provider = hasOwnProvider(config.providers, name) ? config.providers[name] : undefined;
+  const quota = getCachedProviderRoutingQuota(name, provider, now);
+  if (!quota || !Number.isFinite(quota.updatedAt) || quota.updatedAt < 0 || quota.updatedAt > now
+    || now >= quota.updatedAt + PROVIDER_QUOTA_MAX_AGE_MS) return { state: "unknown" };
+
+  // Removing search/MCP windows may leave only a timestamp. That is not inference evidence.
+  const percentages = [quota.fiveHourPercent, quota.weeklyPercent, quota.monthlyPercent,
+    ...(quota.customWindows ?? []).map(window => window.percent)];
+  const hasPercentage = percentages.some(value => typeof value === "number" && Number.isFinite(value) && value >= 0);
+  const credits = quota.creditsUsd;
+  const hasCredits = credits !== undefined && Number.isFinite(credits.percent)
+    && credits.percent >= 0 && Number.isFinite(credits.remaining);
+  if (!hasPercentage && !hasCredits) return { state: "unknown" };
+
+  const state = cachedProviderQuotaIsExhausted(quota, now) ? "exhausted" : "available";
+  let validUntil = quota.updatedAt + PROVIDER_QUOTA_MAX_AGE_MS;
+  if (state === "exhausted") {
+    const resets = [quota.fiveHourResetAt, quota.weeklyResetAt, quota.monthlyResetAt,
+      ...(quota.customWindows ?? []).map(window => window.resetAt)]
+      .filter((reset): reset is number => typeof reset === "number" && Number.isFinite(reset)
+        && reset > now && reset < validUntil)
+      .sort((left, right) => left - right);
+    // Reuse dispatch's predicate: another exhausted window or USD cap may still block.
+    for (const reset of resets) {
+      if (!cachedProviderQuotaIsExhausted(quota, reset)) {
+        validUntil = reset;
+        break;
+      }
+    }
+  }
+  return { state, updatedAt: quota.updatedAt, validUntil };
+}
+
 export async function handleProviderRoutes(ctx: ManagementContext): Promise<Response | null> {
   const { req, url, config, deps, principal, convergeCodexCatalog, syncClaudeAgentDefsBestEffort } = ctx;

   if (url.pathname === "/api/provider-quotas" && req.method === "GET") {
     const forceRefresh = url.searchParams.get("refresh") === "1" || url.searchParams.get("refresh") === "true";
-    return jsonResponse(await fetchProviderQuotaReports(config, forceRefresh));
+    const snapshot = await fetchProviderQuotaReports(config, forceRefresh);
+    const now = Date.now();
+    return jsonResponse({
+      ...snapshot,
+      reports: snapshot.reports.map(report => ({
+        ...report,
+        routingQuota: providerRoutingQuota(config, report.provider, now),
+      })),
+    });
   }

   if (url.pathname === "/api/provider-request-pacing" && req.method === "GET") {
diff --git a/structure/04_transports-and-sidecars.md b/structure/04_transports-and-sidecars.md
index ecade01c78..f91195e8bb 100644
--- a/structure/04_transports-and-sidecars.md
+++ b/structure/04_transports-and-sidecars.md
@@ -1657,6 +1657,15 @@ credential cannot inherit another key's cap. The same getter controls immediate
 bounded cooldown waiting and reset-window ordering. This does not override explicit eligibility,
 target cooldowns, account admission or response-driven retry rules.

+The management quota response projects a separate `routingQuota` from this evidence after each
+probe or cached read, using the current provider row. It contains only a state, observation time
+and `validUntil`; the cached display report and private binding remain unchanged. Known states
+expire after 30 minutes or, for exhaustion, when the dispatch predicate first clears at a reset
+boundary. Multiple windows and USD blockers use that same predicate. The Combo editor uses only
+this projection for quota-based Save/Create blocking and treats missing, invalid or expired
+evidence as unknown. It schedules the rendered expiry even when that deadline passes before
+effects run, rechecks on activation/visibility, and refreshes quota alongside Combo data.
+
 ```text
 [Decision Log]
 - 목적과 의도: Keep account-, model- and service-scoped quota from disabling an otherwise usable Combo provider while retaining valid single-key inference caps.
diff --git a/tests/gui/combo-workspace-data.test.ts b/tests/gui/combo-workspace-data.test.ts
index e3d340f2f8..e754020636 100644
--- a/tests/gui/combo-workspace-data.test.ts
+++ b/tests/gui/combo-workspace-data.test.ts
@@ -13,6 +13,7 @@ import {
   isValidComboId,
   parseComboList,
   providerQuotaStatesFromReports,
+  nextProviderQuotaStateExpiration,
   toPutBody,
   updateComboAliasDraft,
   validateComboDraft,
@@ -42,6 +43,31 @@ function quotaReport(
   };
 }

+describe("server-scoped Combo quota", () => {
+  test("display exhaustion without routing authority stays unknown", () => {
+    expect(providerQuotaStatesFromReports([
+      quotaReport("oauth", { fiveHourPercent: 100 }),
+      quotaReport("search", { customWindows: [{ label: "Search", percent: 100 }] }),
+    ], QUOTA_NOW)).toEqual({ oauth: "unknown", search: "unknown" });
+  });
+
+  test("uses current server routing state instead of display windows", () => {
+    expect(providerQuotaStatesFromReports([
+      quotaReport("search", { customWindows: [{ label: "Search", percent: 100 }] }, {
+        routingQuota: { state: "available", updatedAt: QUOTA_NOW, validUntil: QUOTA_NOW + 60_000 },
+      }),
+    ], QUOTA_NOW)).toEqual({ search: "available" });
+  });
+
+  test("expires routing authority at its reset boundary", () => {
+    expect(providerQuotaStatesFromReports([
+      quotaReport("spent", { fiveHourPercent: 100 }, {
+        routingQuota: { state: "exhausted", updatedAt: QUOTA_NOW - 100, validUntil: QUOTA_NOW },
+      }),
+    ], QUOTA_NOW)).toEqual({ spent: "unknown" });
+  });
+});
+
 function combo(overrides: Partial<ComboItem> = {}): ComboItem {
   return {
     id: "free",
@@ -297,87 +323,57 @@ describe("combo-workspace-data", () => {
     ]);
   });

-  test("derives exhausted state from USD, percentage, and custom-window evidence", () => {
+  test("accepts known routing states independently of display data", () => {
     expect(providerQuotaStatesFromReports([
-      quotaReport("usd", {
-        creditsUsd: { used: 10, limit: 10, remaining: 0, percent: 100 },
+      quotaReport("  keyed  ", { fiveHourPercent: 0 }, {
+        routingQuota: { state: "exhausted", updatedAt: QUOTA_NOW, validUntil: QUOTA_NOW + 60_000 },
       }),
-      quotaReport("percent", { fiveHourPercent: 100 }),
-      quotaReport("custom", { customWindows: [{ label: "Daily", percent: 101 }] }),
-    ], QUOTA_NOW)).toEqual({
-      usd: "exhausted",
-      percent: "exhausted",
-      custom: "exhausted",
-    });
-  });
-
-  test("keeps unlimited credits available and stale or malformed evidence unknown", () => {
-    expect(providerQuotaStatesFromReports([
-      quotaReport("unlimited", {
-        creditsUsd: { used: 0, limit: 0, remaining: 0, percent: 0, unlimited: true },
+      quotaReport("unlimited", { creditsUsd: { remaining: 0, unlimited: true } }, {
+        routingQuota: { state: "available", updatedAt: QUOTA_NOW, validUntil: QUOTA_NOW + 60_000 },
       }),
-      quotaReport("stale", { weeklyPercent: 100 }, { updatedAt: QUOTA_NOW - 30 * 60_000 }),
-      quotaReport("malformed", { fiveHourPercent: "100" }),
-      quotaReport("missing", {}),
-    ], QUOTA_NOW)).toEqual({
-      unlimited: "available",
-      stale: "unknown",
-      malformed: "unknown",
-      missing: "unknown",
-    });
+    ], QUOTA_NOW)).toEqual({ keyed: "exhausted", unlimited: "available" });
+  });
+
+  test("rejects malformed, future, stale and overlong routing lifetimes", () => {
+    const fresh = { state: "exhausted", updatedAt: QUOTA_NOW, validUntil: QUOTA_NOW + 1000 };
+    const bad = [
+      undefined, null, [], { ...fresh, state: "maybe" },
+      { ...fresh, updatedAt: "100" }, { ...fresh, updatedAt: NaN },
+      { ...fresh, updatedAt: -1 }, { ...fresh, updatedAt: QUOTA_NOW + 1 },
+      { ...fresh, updatedAt: QUOTA_NOW - 30 * 60_000 },
+      { ...fresh, validUntil: undefined }, { ...fresh, validUntil: Infinity },
+      { ...fresh, validUntil: QUOTA_NOW }, { ...fresh, validUntil: QUOTA_NOW + 30 * 60_000 + 1 },
+    ];
+    for (const routingQuota of bad) {
+      expect(providerQuotaStatesFromReports([
+        quotaReport("keyed", { weeklyPercent: 100 }, { routingQuota }),
+      ], QUOTA_NOW)).toEqual({ keyed: "unknown" });
+    }
   });

-  test("trims provider ids and rejects incomplete aggregate quota evidence", () => {
+  test("complete display aggregates cannot authorize a provider-wide block", () => {
     expect(providerQuotaStatesFromReports([
-      quotaReport("  openai  ", { weeklyPercent: 75 }),
       quotaReport("pool", { weeklyPercent: 100 }, {
         aggregation: {
-          kind: "capacity-weighted-v1",
-          scope: "routable-known",
-          presentation: "aggregate",
-          incomplete: true,
-          excludedAccounts: 1,
-          unknownPlanAccounts: 0,
+          kind: "capacity-weighted-v1", scope: "routable-known", presentation: "aggregate",
+          incomplete: false, includedAccounts: 2, excludedAccounts: 0, unknownPlanAccounts: 0,
+          missingQuotaAccounts: 0, pausedAccounts: 0, reauthAccounts: 0, staleQuotaAccounts: 0,
           partialWindowAccounts: 0,
+          weekly: { usedPercent: 100, includedAccounts: 2, excludedAccounts: 0, incomplete: false, updatedAt: QUOTA_NOW },
         },
       }),
-      quotaReport("malformed-pool", { weeklyPercent: 100 }, {
-        aggregation: {
-          kind: "capacity-weighted-v1",
-          scope: "routable-known",
-          presentation: "aggregate",
-          incomplete: false,
-        },
-      }),
-      quotaReport("complete-pool", { weeklyPercent: 100 }, {
-        aggregation: {
-          kind: "capacity-weighted-v1",
-          scope: "routable-known",
-          presentation: "aggregate",
-          incomplete: false,
-          includedAccounts: 2,
-          excludedAccounts: 0,
-          unknownPlanAccounts: 0,
-          missingQuotaAccounts: 0,
-          pausedAccounts: 0,
-          reauthAccounts: 0,
-          staleQuotaAccounts: 0,
-          partialWindowAccounts: 0,
-          weekly: {
-            usedPercent: 100,
-            includedAccounts: 2,
-            excludedAccounts: 0,
-            incomplete: false,
-            updatedAt: QUOTA_NOW,
-          },
-        },
-      }),
-    ], QUOTA_NOW)).toEqual({
-      openai: "available",
-      pool: "unknown",
-      "malformed-pool": "unknown",
-      "complete-pool": "exhausted",
-    });
+    ], QUOTA_NOW)).toEqual({ pool: "unknown" });
+  });
+
+  test("conflicting duplicate rows stay unknown and the next valid expiry is selected", () => {
+    const rows = [
+      quotaReport("keyed", {}, { routingQuota: { state: "available", updatedAt: QUOTA_NOW, validUntil: QUOTA_NOW + 5000 } }),
+      quotaReport("keyed", {}, { routingQuota: { state: "exhausted", updatedAt: QUOTA_NOW, validUntil: QUOTA_NOW + 1000 } }),
+      quotaReport("bad", {}, { routingQuota: { state: "exhausted", updatedAt: QUOTA_NOW, validUntil: QUOTA_NOW - 1 } }),
+    ];
+    expect(providerQuotaStatesFromReports(rows, QUOTA_NOW)).toEqual({ keyed: "unknown", bad: "unknown" });
+    expect(nextProviderQuotaStateExpiration(rows, QUOTA_NOW)).toBe(QUOTA_NOW + 1000);
+    expect(nextProviderQuotaStateExpiration(rows, QUOTA_NOW + 5000)).toBeUndefined();
   });

   test("combo quota excludes disabled targets and disables only when every usable target is exhausted", () => {
diff --git a/tests/server/management-provider-validation.test.ts b/tests/server/management-provider-validation.test.ts
index 09bfb1e67c..949791f2d6 100644
--- a/tests/server/management-provider-validation.test.ts
+++ b/tests/server/management-provider-validation.test.ts
@@ -48,6 +48,8 @@ import { getAccountSet, saveCredential } from "../../src/oauth/store";
 import { fastPolicyForModel } from "../../src/providers/service-tier";
 import { resolveWireProtocolOverride } from "../../src/server/adapter-resolve";
 import { removeTreeWithRetry } from "../helpers/remove-tree";
+import { clearProviderQuotaCache, fetchProviderQuotaReports, setProviderQuotaBeforePublishForTests } from "../../src/providers/quota";
+import { setCachedProviderQuotaForTests } from "../../src/providers/quota-routing-cache";

 // Full-suite Windows load: startServer + multi-step provider PATCH/GET flows exceed the
 // default 5s per-test budget (same flake class as 810fa115 / claude-management-api).
@@ -136,6 +138,153 @@ afterEach(() => {
   if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
 });

+describe("provider quota routing state", () => {
+  function quotaConfig(name = "openrouter", baseUrl = "https://openrouter.ai/api/v1"): OcxConfig {
+    return { port: 10100, defaultProvider: name, providers: { [name]: {
+      adapter: "openai-chat", authMode: "key", baseUrl, apiKey: "synthetic-probed-key",
+    } } };
+  }
+
+  async function readQuota(cfg: OcxConfig, force = false) {
+    const url = new URL(`http://localhost/api/provider-quotas${force ? "?refresh=1" : ""}`);
+    const response = await handleManagementAPI(new Request(url), url, cfg);
+    expect(response?.status).toBe(200);
+    return response!.json();
+  }
+
+  beforeEach(() => {
+    mkdirSync(TEST_DIR, { recursive: true });
+    process.env.OPENCODEX_HOME = TEST_DIR;
+    clearProviderQuotaCache();
+    setProviderQuotaBeforePublishForTests(null);
+  });
+
+  afterEach(() => {
+    clearProviderQuotaCache();
+    setProviderQuotaBeforePublishForTests(null);
+  });
+
+  test("projects bound inference state without mutating display reports", async () => {
+    const cfg: OcxConfig = {
+      port: 10100,
+      defaultProvider: "openrouter",
+      providers: {
+        openrouter: {
+          adapter: "openai-chat", authMode: "key",
+          baseUrl: "https://openrouter.ai/api/v1", apiKey: "synthetic-probed-key",
+        },
+      },
+    };
+    globalThis.fetch = (async () => Response.json({ data: { limit: 20, limit_remaining: 0 } })) as typeof fetch;
+    const url = new URL("http://localhost/api/provider-quotas");
+    const response = await handleManagementAPI(new Request(url), url, cfg);
+    expect(response?.status).toBe(200);
+    const dto = await response!.json();
+    const row = dto.reports.find((item: { provider: string }) => item.provider === "openrouter");
+    expect(row.routingQuota).toEqual({
+      state: "exhausted", updatedAt: row.quota.updatedAt,
+      validUntil: row.quota.updatedAt + 30 * 60_000,
+    });
+    const cached = await fetchProviderQuotaReports(cfg, false);
+    expect(cached.reports[0]).not.toHaveProperty("routingQuota");
+    expect(row.quota).toEqual(cached.reports[0]!.quota);
+    expect(JSON.stringify(dto)).not.toContain("synthetic-probed-key");
+    expect(JSON.stringify(dto)).not.toContain("binding");
+  });
+
+  test("single-key capacity recovers on refresh and an uncapped key drops its old cap", async () => {
+    const cfg = quotaConfig();
+    let payload = { limit: 20 as number | null, limit_remaining: 0 };
+    globalThis.fetch = (async () => Response.json({ data: payload })) as typeof fetch;
+    expect((await readQuota(cfg)).reports[0].routingQuota.state).toBe("exhausted");
+    payload = { limit: 20, limit_remaining: 8 };
+    expect((await readQuota(cfg, true)).reports[0].routingQuota.state).toBe("available");
+    payload = { limit: null, limit_remaining: 0 };
+    expect((await readQuota(cfg, true)).reports).toEqual([]);
+  });
+
+  test.each(["authorization", "x-api-key", "x-goog-api-key", "key-pool", "oauth"])(
+    "rechecks current credential scope: %s", async change => {
+      const cfg = quotaConfig();
+      globalThis.fetch = (async () => Response.json({ data: { limit: 20, limit_remaining: 0 } })) as typeof fetch;
+      expect((await readQuota(cfg)).reports[0].routingQuota.state).toBe("exhausted");
+      if (change === "key-pool") cfg.providers.openrouter!.apiKeyPool = [
+        { id: "primary", key: "synthetic-probed-key" },
+        { id: "secondary", key: "other-key" },
+      ];
+      else if (change === "oauth") cfg.providers.openrouter!.authMode = "oauth";
+      else cfg.providers.openrouter!.headers = { [change]: "other-credential" };
+      const dto = await readQuota(cfg);
+      expect(dto.reports.every((row: { routingQuota: { state: string } }) => row.routingQuota.state === "unknown")).toBe(true);
+    },
+  );
+
+  test("reads a provider row replaced while the quota probe is awaiting publication", async () => {
+    const cfg = quotaConfig();
+    let replaced = false;
+    globalThis.fetch = (async () => Response.json({ data: { limit: 20, limit_remaining: 0 } })) as typeof fetch;
+    setProviderQuotaBeforePublishForTests(() => {
+      cfg.providers.openrouter = { ...cfg.providers.openrouter!, apiKey: "replacement-key" };
+      replaced = true;
+    });
+    const dto = await readQuota(cfg);
+    expect(replaced).toBe(true);
+    expect(dto.reports.every((row: { routingQuota: { state: string } }) => row.routingQuota.state === "unknown")).toBe(true);
+  });
+
+  test("search-only and MCP-only display windows have no inference authority", async () => {
+    const cfg: OcxConfig = { port: 10100, defaultProvider: "synthetic", providers: {
+      ...quotaConfig("synthetic", "https://api.synthetic.new/v2").providers,
+      ...quotaConfig("zai", "https://api.z.ai/api/coding/paas/v4").providers,
+    } };
+    globalThis.fetch = (async input => String(input).includes("synthetic")
+      ? Response.json({ data: { search: { hourly: 100 } } })
+      : Response.json({ success: true, data: { monthlyMCPUsage: 100 } })) as typeof fetch;
+    const dto = await readQuota(cfg);
+    expect(dto.reports).toHaveLength(2);
+    expect(dto.reports.every((row: { routingQuota: { state: string } }) => row.routingQuota.state === "unknown")).toBe(true);
+    expect(dto.reports.find((row: { provider: string }) => row.provider === "synthetic").quota.customWindows[0].percent).toBe(100);
+    expect(dto.reports.find((row: { provider: string }) => row.provider === "zai").quota.monthlyPercent).toBe(100);
+  });
+
+  test("an exhausted OAuth account report stays display-only", async () => {
+    const cfg = quotaConfig("kimi", "https://api.kimi.com/coding/v1");
+    cfg.providers.kimi!.authMode = "oauth";
+    await saveCredential("kimi", { access: "synthetic-account-access", refresh: "synthetic-account-refresh", expires: Date.now() + 3600_000 });
+    globalThis.fetch = (async () => Response.json({ usage: { limit: "100", used: "100" } })) as typeof fetch;
+    const dto = await readQuota(cfg);
+    expect(dto.reports[0].quota.weeklyPercent).toBe(100);
+    expect(dto.reports[0].routingQuota).toEqual({ state: "unknown" });
+  });
+
+  test("cached responses respect reset boundaries, persistent blockers and evidence expiry", async () => {
+    const cfg = quotaConfig();
+    let probes = 0;
+    globalThis.fetch = (async () => {
+      probes += 1;
+      return Response.json({ data: { limit: 20, limit_remaining: 0 } });
+    }) as typeof fetch;
+    const first = await readQuota(cfg);
+    const now = Date.now();
+    const quota = { updatedAt: now, fiveHourPercent: 100, fiveHourResetAt: now + 10_000,
+      weeklyPercent: 100, weeklyResetAt: now + 20_000 };
+    setCachedProviderQuotaForTests("openrouter", quota);
+    expect((await readQuota(cfg)).reports[0].routingQuota.validUntil).toBe(now + 20_000);
+    setCachedProviderQuotaForTests("openrouter", { ...quota, creditsUsd: { used: 20, limit: 20, remaining: 0, percent: 100 } });
+    expect((await readQuota(cfg)).reports[0].routingQuota.validUntil).toBe(now + 30 * 60_000);
+    setCachedProviderQuotaForTests("openrouter", { updatedAt: now, fiveHourPercent: 100, fiveHourResetAt: now - 1 });
+    expect((await readQuota(cfg)).reports[0].routingQuota.state).toBe("available");
+    setCachedProviderQuotaForTests("openrouter", { updatedAt: now,
+      creditsUsd: { used: 0, limit: 0, remaining: 0, percent: 0, unlimited: true } });
+    expect((await readQuota(cfg)).reports[0].routingQuota.state).toBe("available");
+    setCachedProviderQuotaForTests("openrouter", { ...quota, updatedAt: now - 30 * 60_000 });
+    const stale = await readQuota(cfg);
+    expect(stale.reports[0].routingQuota).toEqual({ state: "unknown" });
+    expect(stale.reports[0].quota).toEqual(first.reports[0].quota);
+    expect(probes).toBe(1);
+  });
+});
+
 describe("provider management validation", () => {
   test("provider reload adopts only the validated disk row without rewriting config", async () => {
     if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
```
