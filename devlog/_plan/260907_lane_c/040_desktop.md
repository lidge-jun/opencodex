# 3860 implementation contract

Carry source patch plus skipped-sync correction with -x. Default false/absent OFF, true remains true; persist preference before sync and surface sync failures. All nine locales and existing screenshot. Independent auth boundary review confirms remote admission/upstream credentials unchanged.

Validation: local tests/typecheck/build/install NOT RUN by instruction. Read diff and source; top remote CI exercises changed test paths. Each conditional branch listed above is exercised by controlled fixtures; screenshot inspects GUI state. No new enforcement layer; existing API guards remain authoritative.

## Public source diff (MODIFY/NEW paths)

```diff
diff --git a/docs-site/src/content/docs/guides/codex-integration.md b/docs-site/src/content/docs/guides/codex-integration.md
index 7d66e72c3..ff2df04fd 100644
--- a/docs-site/src/content/docs/guides/codex-integration.md
+++ b/docs-site/src/content/docs/guides/codex-integration.md
@@ -215,6 +215,15 @@ HTTP/SSE.
 
 ### Authless Codex Desktop (opt-in)
 
+In **Dashboard → Overview**, **Open Codex without signing in** controls this existing
+opt-in preference. The switch defaults to **off** when the setting is absent or false;
+an existing explicit `codexDesktopAuthless: true` stays enabled. The dashboard saves
+the preference and runs a full sync. Restart Codex Desktop after changing it.
+If synchronization fails, the saved preference remains and the dashboard shows the error;
+retry **Sync** before restarting. Account-gated Desktop features may be unavailable
+when enabled. Upstream credentials, local eligibility, remote admission authentication
+and user-owned gateway settings retain their existing requirements.
+
 Codex Desktop shows its ChatGPT login screen whenever the active provider requires OpenAI auth. If
 your OpenCodex setup never uses ChatGPT credentials (routed providers only, or a blocked
 `chatgpt.com`), you can opt out of that gate:
diff --git a/gui/src/i18n/de.ts b/gui/src/i18n/de.ts
index 5faab4b35..495104bd4 100644
--- a/gui/src/i18n/de.ts
+++ b/gui/src/i18n/de.ts
@@ -299,6 +299,8 @@ export const de: Record<TKey, string> = {
   "models.staleBanner": "Codex zeigt eine ältere Modellliste als dieser Katalog. Starte Codex neu, um sie neu zu laden.",
   "dash.codexAutoStart": "opencodex mit Codex starten",
   "dash.codexAutoStartHint": "Erlaubt einem installierten Launcher-Shim, ocx ensure auszuführen. Diese Einstellung installiert keinen Neustartschutz; prüfe den effektiven Zustand unter Startsicherheit.",
+  "dash.codexDesktopAuthless": "Codex ohne Anmeldung öffnen",
+  "dash.codexDesktopAuthlessHint": "Standardmäßig aus. Überspringt die separate Desktop-Anmeldung bei geeigneten lokalen Verbindungen. Zugangsdaten für den Anbieter bleiben erforderlich. Codex nach einer Änderung neu starten. Kontogebundene Desktop-Funktionen können fehlen.",
   "dash.searchModel": "Such-Sidecar-Modell",
   "dash.searchModelHint": "Modell für web_search bei nicht über OpenAI gerouteten Modellen. Erfordert ChatGPT-Login.",
   "dash.searchReasoning": "Such-Reasoning-Aufwand",
diff --git a/gui/src/i18n/en.ts b/gui/src/i18n/en.ts
index c71208942..22a380785 100644
--- a/gui/src/i18n/en.ts
+++ b/gui/src/i18n/en.ts
@@ -311,6 +311,8 @@ export const en = {
   "models.staleBanner": "Codex is showing an older model list than this catalog. Restart Codex to reload it.",
   "dash.codexAutoStart": "Start opencodex with Codex",
   "dash.codexAutoStartHint": "Allows an installed launcher shim to run ocx ensure. This setting does not install restart protection; check Startup safety for the effective state.",
+  "dash.codexDesktopAuthless": "Open Codex without signing in",
+  "dash.codexDesktopAuthlessHint": "Off by default. Skip the separate Desktop sign-in for eligible local connections. Upstream credentials are still required. Restart Codex after changing this setting. Account-gated Desktop features may be unavailable.",
   "dash.searchModel": "Search sidecar model",
   "dash.searchModelHint": "Model used for web_search on non-OpenAI routed models. Requires ChatGPT login.",
   "dash.searchReasoning": "Search reasoning effort",
diff --git a/gui/src/i18n/fr.ts b/gui/src/i18n/fr.ts
index e1b3519ef..9f0f26517 100644
--- a/gui/src/i18n/fr.ts
+++ b/gui/src/i18n/fr.ts
@@ -301,6 +301,8 @@ export const fr: Record<TKey, string> = {
   "models.staleBanner": "Codex affiche une liste de modèles plus ancienne que ce catalogue. Redémarrez Codex pour la recharger.",
   "dash.codexAutoStart": "Démarrer opencodex avec Codex",
   "dash.codexAutoStartHint": "Permet à un mécanisme de lancement installé d’exécuter ocx ensure. Ce réglage n’installe pas de protection au redémarrage ; consultez Sécurité du démarrage pour connaître l’état effectif.",
+  "dash.codexDesktopAuthless": "Ouvrir Codex sans se connecter",
+  "dash.codexDesktopAuthlessHint": "Désactivé par défaut. Ignore la connexion Desktop séparée pour les connexions locales admissibles. Les identifiants du fournisseur restent nécessaires. Redémarrez Codex après toute modification. Certaines fonctions Desktop liées au compte peuvent être indisponibles.",
   "dash.searchModel": "Modèle auxiliaire de recherche",
   "dash.searchModelHint": "Modèle utilisé pour web_search sur les modèles routés autres qu’OpenAI. Nécessite une connexion à ChatGPT.",
   "dash.searchReasoning": "Effort de raisonnement pour la recherche",
diff --git a/gui/src/i18n/ja.ts b/gui/src/i18n/ja.ts
index cf9483158..55a6fe249 100644
--- a/gui/src/i18n/ja.ts
+++ b/gui/src/i18n/ja.ts
@@ -308,6 +308,8 @@ export const ja: Record<TKey, string> = {
   "models.staleBanner": "Codex はこのカタログより古いモデル一覧を表示しています。Codex を再起動すると読み直されます。",
   "dash.codexAutoStart": "Codex と一緒に opencodex を起動",
   "dash.codexAutoStartHint": "インストール済み launcher shim に ocx ensure の実行を許可します。この設定だけでは再起動保護はインストールされません。起動安全性で実際の状態を確認してください。",
+  "dash.codexDesktopAuthless": "ログインせずに Codex を開く",
+  "dash.codexDesktopAuthlessHint": "既定ではオフです。対象のローカル接続で Desktop の個別ログインを省略します。上流プロバイダーの認証情報は引き続き必要です。変更後は Codex を再起動してください。アカウントに依存する Desktop 機能が利用できない場合があります。",
   "dash.searchModel": "検索サイドカーモデル",
   "dash.searchModelHint": "非 OpenAI ルーティングモデルで web_search に使うモデル。ChatGPT ログインが必要です。",
   "dash.searchReasoning": "検索の推論負荷",
diff --git a/gui/src/i18n/ko.ts b/gui/src/i18n/ko.ts
index c1959482b..19285b150 100644
--- a/gui/src/i18n/ko.ts
+++ b/gui/src/i18n/ko.ts
@@ -303,6 +303,8 @@ export const ko: Record<TKey, string> = {
   "models.staleBanner": "Codex가 이 카탈로그보다 오래된 모델 목록을 보여주고 있습니다. Codex를 재시작하면 새로 읽습니다.",
   "dash.codexAutoStart": "Codex 실행 시 opencodex 시작",
   "dash.codexAutoStartHint": "설치된 launcher shim이 ocx ensure를 실행하도록 허용합니다. 이 설정은 재부팅 보호를 설치하지 않으므로 시작 안전성에서 실제 상태를 확인하세요.",
+  "dash.codexDesktopAuthless": "로그인 없이 Codex 열기",
+  "dash.codexDesktopAuthlessHint": "기본값은 꺼짐입니다. 지원되는 로컬 연결에서 별도의 Desktop 로그인을 건너뜁니다. 업스트림 인증 정보는 여전히 필요합니다. 변경 후 Codex를 다시 시작하세요. 계정에 연결된 Desktop 기능을 사용하지 못할 수 있습니다.",
   "dash.searchModel": "서치 사이드카 모델",
   "dash.searchModelHint": "비-OpenAI 라우팅 모델의 web_search에 사용되는 모델입니다. ChatGPT 로그인 필요.",
   "dash.searchReasoning": "서치 추론 강도",
diff --git a/gui/src/i18n/ru.ts b/gui/src/i18n/ru.ts
index 0109f5ebd..87704912a 100644
--- a/gui/src/i18n/ru.ts
+++ b/gui/src/i18n/ru.ts
@@ -308,6 +308,8 @@ export const ru: Record<TKey, string> = {
   "models.staleBanner": "Codex показывает список моделей старее этого каталога. Перезапустите Codex, чтобы перечитать его.",
   "dash.codexAutoStart": "Запускать opencodex вместе с Codex",
   "dash.codexAutoStartHint": "Разрешает установленному launcher shim выполнять ocx ensure. Эта настройка не устанавливает защиту перезапуска; проверьте фактическое состояние в разделе безопасности запуска.",
+  "dash.codexDesktopAuthless": "Открывать Codex без входа",
+  "dash.codexDesktopAuthlessHint": "По умолчанию выключено. Пропускает отдельный вход в Desktop для допустимых локальных подключений. Учётные данные провайдера по-прежнему нужны. После изменения перезапустите Codex. Функции Desktop, связанные с аккаунтом, могут быть недоступны.",
   "dash.searchModel": "Модель сайдкара поиска",
   "dash.searchModelHint": "Модель, используемая для web_search на маршрутизируемых моделях, отличных от OpenAI. Требуется вход в аккаунт ChatGPT.",
   "dash.searchReasoning": "Уровень рассуждений для поиска",
diff --git a/gui/src/i18n/tr.ts b/gui/src/i18n/tr.ts
index fa8b8e9c2..807eeae32 100644
--- a/gui/src/i18n/tr.ts
+++ b/gui/src/i18n/tr.ts
@@ -309,6 +309,8 @@ export const tr: Record<TKey, string> = {
   "models.staleBanner": "Codex, bu katalogdan daha eski bir model listesi gösteriyor. Yeniden okumak için Codex'i yeniden başlatın.",
   "dash.codexAutoStart": "opencodex'i Codex ile başlat",
   "dash.codexAutoStartHint": "Yüklü bir shim'in ocx ensure çalıştırmasına izin verir. Arka plan servisi veya yeniden başlatma koruması kurmaz; sistem durumu için Başlatma Güvenliği'ne bakın.",
+  "dash.codexDesktopAuthless": "Codex’i oturum açmadan başlat",
+  "dash.codexDesktopAuthlessHint": "Varsayılan olarak kapalıdır. Uygun yerel bağlantılarda ayrı Desktop oturum açma adımını atlar. Sağlayıcı kimlik bilgileri yine gereklidir. Değişiklikten sonra Codex’i yeniden başlatın. Hesaba bağlı Desktop özellikleri kullanılamayabilir.",
   "dash.searchModel": "Arama yan araç modeli",
   "dash.searchModelHint": "OpenAI dışı yönlendirilen modellerde web_search için kullanılan model. ChatGPT girişi gerektirir.",
   "dash.searchReasoning": "Arama akıl yürütme çabası",
diff --git a/gui/src/i18n/zh-TW.ts b/gui/src/i18n/zh-TW.ts
index 3bc246543..62e1f0711 100644
--- a/gui/src/i18n/zh-TW.ts
+++ b/gui/src/i18n/zh-TW.ts
@@ -200,6 +200,8 @@ export const zhTW: Record<TKey, string> = {
   "models.staleBanner": "Codex 顯示的模型清單比目前的目錄舊。重新啟動 Codex 即可重新讀取。",
   "dash.codexAutoStart": "隨 Codex 啟動 opencodex",
   "dash.codexAutoStartHint": "允許已安裝的 launcher shim 執行 ocx ensure。此設定不會安裝重新啟動保護；請在啟動安全中檢查實際狀態。",
+  "dash.codexDesktopAuthless": "無需登入即可開啟 Codex",
+  "dash.codexDesktopAuthlessHint": "預設關閉。為符合條件的本機連線略過獨立的 Desktop 登入。仍需上游供應商憑證。變更後請重新啟動 Codex。依賴帳戶的 Desktop 功能可能無法使用。",
   "dash.searchModel": "搜尋附屬模型",
   "dash.searchModelHint": "用於非 OpenAI 路由模型的 web_search 的模型。需要 ChatGPT 登入。",
   "dash.searchReasoning": "搜尋推理強度",
diff --git a/gui/src/i18n/zh.ts b/gui/src/i18n/zh.ts
index b10c48688..994691442 100644
--- a/gui/src/i18n/zh.ts
+++ b/gui/src/i18n/zh.ts
@@ -303,6 +303,8 @@ export const zh: Record<TKey, string> = {
   "models.staleBanner": "Codex 显示的模型列表比当前目录旧。重启 Codex 即可重新读取。",
   "dash.codexAutoStart": "随 Codex 启动 opencodex",
   "dash.codexAutoStartHint": "允许已安装的 launcher shim 运行 ocx ensure。此设置不会安装重启保护；请在启动安全中检查实际状态。",
+  "dash.codexDesktopAuthless": "无需登录即可打开 Codex",
+  "dash.codexDesktopAuthlessHint": "默认关闭。为符合条件的本地连接跳过单独的 Desktop 登录。仍需上游提供商凭据。更改后请重启 Codex。依赖账户的 Desktop 功能可能不可用。",
   "dash.searchModel": "搜索附属模型",
   "dash.searchModelHint": "用于非 OpenAI 路由模型的 web_search 的模型。需要 ChatGPT 登录。",
   "dash.searchReasoning": "搜索推理强度",
diff --git a/gui/src/pages/dashboard-overview-sections.tsx b/gui/src/pages/dashboard-overview-sections.tsx
index 8da531f97..6606c4f56 100644
--- a/gui/src/pages/dashboard-overview-sections.tsx
+++ b/gui/src/pages/dashboard-overview-sections.tsx
@@ -163,7 +163,7 @@ export function DashboardInjectionPanel({ d }: { apiBase: string; d: Dash }) {
 
 export function DashboardMaintenancePanel({ d }: { d: Dash }) {
   const {
-    t, runSync, syncing, updateTriggerRef, openUpdateDialog, updateLoading, updateOpen,
+    t, runSync, syncing, settingsSaving, updateTriggerRef, openUpdateDialog, updateLoading, updateOpen,
     syncResult, syncError, updateJob, reconnecting, clearSyncFeedback,
   } = d;
   const syncHoldsWarning = !!syncResult && (
@@ -211,7 +211,7 @@ export function DashboardMaintenancePanel({ d }: { d: Dash }) {
             <div className="muted text-control dash-sync-hint">{t("dash.syncModelsHint")}</div>
           </div>
           <div className="maintenance-actions">
-            <button type="button" className="btn btn-ghost btn-sm" onClick={handleRunSync} disabled={syncing}>
+            <button type="button" className="btn btn-ghost btn-sm" onClick={handleRunSync} disabled={syncing || settingsSaving}>
               <IconRefresh className={syncing ? "spin-icon" : undefined} /> {syncing ? t("dash.syncing") : t("dash.syncRun")}
             </button>
             <button
@@ -438,7 +438,7 @@ function VisionAdvancedPopover({ t, open, triggerRef, onClose, maxValue, maxInva
 
 export function DashboardSidecarPanels({ d }: { d: Dash }) {
   const {
-    t, settings, settingsSaving, toggleCodexAutoStart,
+    t, settings, settingsSaving, syncing, toggleCodexAutoStart, toggleCodexDesktopAuthless,
     sidecar, sidecarSaving, sidecarModels, visionModels, models, saveSidecar,
     shadowCall, shadowCallSaving, shadowCallHelpTriggerRef, shadowCallHelpOpen, setShadowCallHelpOpen, saveShadowCall,
   } = d;
@@ -496,7 +496,7 @@ export function DashboardSidecarPanels({ d }: { d: Dash }) {
             type="button"
             className={`switch ${settings?.codexAutoStart ?? true ? "on" : ""}`}
             onClick={toggleCodexAutoStart}
-            disabled={!settings || settingsSaving}
+            disabled={!settings || settingsSaving || syncing}
             aria-label={t("dash.codexAutoStart")}
             aria-pressed={settings?.codexAutoStart ?? true}
           >
@@ -505,6 +505,26 @@ export function DashboardSidecarPanels({ d }: { d: Dash }) {
         </div>
       </div>
 
+      <div className="panel">
+        <div className="spread">
+          <div style={{ flex: 1, minWidth: 0 }}>
+            <div className="font-semibold">{t("dash.codexDesktopAuthless")}</div>
+            <div className="muted setting-hint">{t("dash.codexDesktopAuthlessHint")}</div>
+            {settings?.catalogRefreshPending && <div className="muted setting-hint" role="status">{t("codexAuth.catalogRefreshPending")}</div>}
+          </div>
+          <button
+            type="button"
+            className={`switch ${settings?.codexDesktopAuthless ?? false ? "on" : ""}`}
+            onClick={toggleCodexDesktopAuthless}
+            disabled={!settings || settingsSaving || syncing}
+            aria-label={t("dash.codexDesktopAuthless")}
+            aria-pressed={settings?.codexDesktopAuthless ?? false}
+          >
+            <span className="knob" />
+          </button>
+        </div>
+      </div>
+
       <div className="dash-sidecar-grid">
         {/* Both sidecar cards wear the DashboardInjectionPanel shell: the PANEL is
             the flex row, copy left, controls right. */}
diff --git a/gui/src/pages/dashboard-shared.ts b/gui/src/pages/dashboard-shared.ts
index 0793a7def..d24051028 100644
--- a/gui/src/pages/dashboard-shared.ts
+++ b/gui/src/pages/dashboard-shared.ts
@@ -48,6 +48,8 @@ export interface ProviderInfo { name: string; adapter: string; baseUrl: string;
 export interface ModelInfo { id: string; provider: string; namespaced: string; owned_by?: string; reasoningEfforts?: string[] }
 export interface SettingsData {
   codexAutoStart: boolean;
+  codexDesktopAuthless?: boolean;
+  catalogRefreshPending?: boolean;
   /** Whether a login may open a browser on the machine running the proxy. */
   oauthOpenBrowser?: boolean;
   port: number;
diff --git a/gui/src/pages/use-dashboard-data.ts b/gui/src/pages/use-dashboard-data.ts
index 6f84950ce..6da776ea1 100644
--- a/gui/src/pages/use-dashboard-data.ts
+++ b/gui/src/pages/use-dashboard-data.ts
@@ -607,23 +607,24 @@ export function useDashboardData(apiBase: string) {
     finally { setInjectionSaving(false); }
   };
 
-  const toggleCodexAutoStart = async () => {
-    if (!settings || settingsSaving) return;
-    const next = !settings.codexAutoStart;
+  const toggleCodexSetting = async (key: "codexAutoStart" | "codexDesktopAuthless") => {
+    if (!settings || settingsSaving || syncing) return;
+    const next = !(settings[key] ?? (key === "codexAutoStart"));
     setSettingsSaving(true);
     settingsMutationInFlightRef.current = true;
-    setSettings({ ...settings, codexAutoStart: next });
+    setSettings({ ...settings, [key]: next });
     try {
       const res = await fetch(`${apiBase}/api/settings`, {
         method: "PUT",
         headers: { "Content-Type": "application/json" },
-        body: JSON.stringify({ codexAutoStart: next }),
+        body: JSON.stringify({ [key]: next }),
       });
-      const data = await requireJson<{ codexAutoStart: boolean; startupHealth?: SettingsData["startupHealth"] }>(res, "save failed");
+      const data = await requireJson<SettingsData>(res, "save failed");
       settingsMutationEpochRef.current += 1;
-      setSettings(prev => prev ? { ...prev, codexAutoStart: data.codexAutoStart, startupHealth: data.startupHealth ?? prev.startupHealth } : prev);
+      setSettings(prev => prev ? { ...prev, [key]: data[key], catalogRefreshPending: key === "codexDesktopAuthless" ? data.catalogRefreshPending : prev.catalogRefreshPending, startupHealth: data.startupHealth ?? prev.startupHealth } : prev);
+      if (key === "codexDesktopAuthless") await runSync();
     } catch {
-      setSettings(prev => prev ? { ...prev, codexAutoStart: !next } : prev);
+      setSettings(prev => prev ? { ...prev, [key]: !next } : prev);
       setError(true);
     } finally {
       settingsMutationInFlightRef.current = false;
@@ -631,6 +632,9 @@ export function useDashboardData(apiBase: string) {
     }
   };
 
+  const toggleCodexAutoStart = () => toggleCodexSetting("codexAutoStart");
+  const toggleCodexDesktopAuthless = () => toggleCodexSetting("codexDesktopAuthless");
+
   // Clears the sync result/error in this hook. The dashboard toast owns its own dismissal
   // timer but must publish the dismissal here: syncResult/syncError live above the dashboard
   // tabs, so a component-local flag alone would let a stale result remount as a fresh toast
@@ -649,6 +653,7 @@ export function useDashboardData(apiBase: string) {
       const res = await fetch(`${apiBase}/api/sync`, { method: "POST" });
       const data = await requireJson<SyncResult & { projectConfigGrouped?: ProjectCodexConfigGroup[] }>(res, "sync failed");
       setSyncResult(data);
+      setSettings(prev => prev ? { ...prev, catalogRefreshPending: false } : prev);
       if (data.projectConfigGrouped) setProjectConfigWarnings(data.projectConfigGrouped);
     } catch (err) {
       setSyncError(err instanceof Error ? err.message : String(err));
@@ -789,7 +794,7 @@ export function useDashboardData(apiBase: string) {
     effortCapHelpTriggerRef, updateTriggerRef, maHelpTriggerRef, shadowCallHelpTriggerRef,
     effortCapHelpDialogRef, updateDialogRef, maHelpDialogRef, shadowCallHelpDialogRef,
     filteredGroups, sidecarModels, visionModels,
-    saveSidecar, saveShadowCall, switchMaMode, toggleCodexAutoStart, runSync, clearSyncFeedback,
+    saveSidecar, saveShadowCall, switchMaMode, toggleCodexAutoStart, toggleCodexDesktopAuthless, runSync, clearSyncFeedback,
     fetchUpdateCheck, closeUpdateDialog, openUpdateDialog, changeUpdateChannel, runUpdate,
   };
 }
diff --git a/gui/tests/vision-sidecar-dashboard.test.tsx b/gui/tests/vision-sidecar-dashboard.test.tsx
index dc762de58..994a40912 100644
--- a/gui/tests/vision-sidecar-dashboard.test.tsx
+++ b/gui/tests/vision-sidecar-dashboard.test.tsx
@@ -12,7 +12,7 @@ import { LanguageProvider } from "../src/i18n/provider";
 import { DashboardSidecarPanels } from "../src/pages/dashboard-overview-sections";
 import type { SidecarData, SidecarPatch } from "../src/pages/dashboard-shared";
 import { mergeSidecarSetting } from "../src/pages/dashboard-shared";
-import type { useDashboardData } from "../src/pages/use-dashboard-data";
+import { useDashboardData } from "../src/pages/use-dashboard-data";
 
 const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
 let previousGlobals: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
@@ -382,4 +382,79 @@ test("model and reasoning saves still omit enabled, limit, and timeout", async (
   expect(patches).toHaveLength(2);
   expect(patches[1]).toEqual({ vision: { reasoning: "high" } });
   assertVisionControlFieldsOmitted(patches[1]!);
-});
\ No newline at end of file
+});
+
+test("Desktop login switch defaults off, preserves explicit opt-in, and disables while saving", async () => {
+  const { d } = harness();
+  let clicks = 0;
+  d.toggleCodexDesktopAuthless = async () => { clicks += 1; };
+  d.settings = { codexAutoStart: true, port: 10100, hostname: "127.0.0.1" };
+  await mount(d);
+  const toggle = () => host.querySelector<HTMLButtonElement>(`button[aria-label="${en["dash.codexDesktopAuthless"]}"]`)!;
+  expect(toggle().getAttribute("aria-pressed")).toBe("false");
+  d.settings.codexDesktopAuthless = true;
+  await mount(d);
+  expect(toggle().getAttribute("aria-pressed")).toBe("true");
+  await act(async () => { toggle().click(); });
+  expect(clicks).toBe(1);
+  d.settings.codexDesktopAuthless = false;
+  d.settings.catalogRefreshPending = true;
+  d.settingsSaving = true;
+  await mount(d);
+  expect(toggle().getAttribute("aria-pressed")).toBe("false");
+  expect(toggle().disabled).toBe(true);
+  expect(host.textContent).toContain(en["codexAuth.catalogRefreshPending"]);
+});
+
+
+test.each([undefined, false, true])("Desktop login preference %s persists before full sync; sync failure keeps the saved preference", async (initial) => {
+  const originalFetch = globalThis.fetch;
+  const writes: Array<{ path: string; body: unknown }> = [];
+  let latest: Dash | undefined;
+  let saved = initial;
+  const apiBase = `/authless-test-${String(initial)}`;
+  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
+    const path = String(input);
+    if (init?.method === "PUT") {
+      const body = JSON.parse(String(init.body));
+      writes.push({ path, body });
+      if (body.codexDesktopAuthless !== undefined) {
+        saved = body.codexDesktopAuthless;
+        return Response.json({ codexDesktopAuthless: saved, catalogRefreshPending: true });
+      }
+      return Response.json({ codexAutoStart: body.codexAutoStart, catalogRefreshPending: false });
+    }
+    if (path.endsWith("/api/sync")) {
+      writes.push({ path, body: null });
+      return Response.json({ error: "sync unavailable" }, { status: 503 });
+    }
+    if (path.endsWith("/api/settings")) {
+      return Response.json({ codexAutoStart: true, codexDesktopAuthless: saved, port: 10100, hostname: "127.0.0.1" });
+    }
+    return Response.json({}, { status: 503 });
+  }) as typeof fetch;
+  function Harness() { latest = useDashboardData(apiBase); return null; }
+  try {
+    const { createRoot } = await import("react-dom/client");
+    await act(async () => {
+      root = createRoot(host);
+      root.render(<LanguageProvider><Harness /></LanguageProvider>);
+    });
+    expect(latest?.settings?.codexDesktopAuthless).toBe(initial);
+    await act(async () => { await latest!.toggleCodexDesktopAuthless(); });
+    expect(writes).toEqual([
+      { path: `${apiBase}/api/settings`, body: { codexDesktopAuthless: !initial } },
+      { path: `${apiBase}/api/sync`, body: null },
+    ]);
+    expect(latest?.settings?.codexDesktopAuthless).toBe(!initial);
+    expect(latest?.syncError).toBe("sync unavailable");
+    expect(latest?.settings?.catalogRefreshPending).toBe(true);
+    await act(async () => { await latest!.toggleCodexAutoStart(); });
+    expect(latest?.settings?.codexAutoStart).toBe(false);
+    expect(latest?.settings?.catalogRefreshPending).toBe(true);
+  } finally {
+    await act(async () => { root?.unmount(); });
+    root = null;
+    globalThis.fetch = originalFetch;
+  }
+});
diff --git a/tests/codex-integration/codex-inject.test.ts b/tests/codex-integration/codex-inject.test.ts
index 84ac5f67b..b6be3c2f6 100644
--- a/tests/codex-integration/codex-inject.test.ts
+++ b/tests/codex-integration/codex-inject.test.ts
@@ -31,8 +31,8 @@ describe("Codex config injection", () => {
   });
 
   describe("authless Codex Desktop opt-in (#1107)", () => {
-    test("default target on loopback stays Design B and byte-identical", () => {
-      const target = standaloneCodexRoutingTarget(10100, {});
+    test.each([undefined, false])("disabled preference %s on loopback stays Design B and byte-identical", (codexDesktopAuthless) => {
+      const target = standaloneCodexRoutingTarget(10100, { codexDesktopAuthless });
       expect(target.desktopAuthless).toBeUndefined();
       expect(buildProfileFile(target, null)).toBe(buildProfileFile(10100, null));
       expect(buildProviderTableBlock(target)).toContain("requires_openai_auth = true");

```

Audit amendment: clear catalogRefreshPending only if sync status is affirmative success, not HTTP 200 skipped. Add skipped/no-write regression.

## Lane E documentation handoff

After run 34106956362 reported a GUI lint failure, include the separately prepared code-mode host-rule translations in the seven fr/ja/ko/ru/tr/zh-cn/zh-tw Codex integration guides. The patch adds 51 documentation lines matching the existing English paragraph; it does not modify runtime code or provider guides. Apply on the Desktop layer, record `docs handoff from lane E` and `[skip ci]` in its own commit, then cascade the fallback layer and dispatch the top CI again. Local documentation install/build remains NOT RUN.
