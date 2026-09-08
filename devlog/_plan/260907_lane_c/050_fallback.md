# 3252 implementation contract

Carry source commits with -x. Preserve configured fallback models absent from availability. Add focused GUI tests for add/remove/reorder/save and unavailable model round-trip. Reuse existing /api/v2 (enabled, multiAgentMode, keepNativeChatGptOnV1) and report recovery enabled/eligibility as unknown when the server does not expose it, never fabricate recovery settings state for contextual native-parent/routed-child V2 guidance. Never infer all workflows are native; warn conditionally, show disabled/eligible/experimental/unknown state truthfully, link issue 92. No roster-reuse switch. Update all locales and codex-integration docs; actual UI screenshot. New PR body is valid Markdown, removes unsupported roster-switch claims.

Validation: local tests/typecheck/build/install NOT RUN by instruction. Read diff and source; top remote CI exercises changed test paths. Each conditional branch listed above is exercised by controlled fixtures; screenshot inspects GUI state. No new enforcement layer; existing API guards remain authoritative.

## Public source diff (MODIFY/NEW paths)

```diff
diff --git a/gui/src/components/subagents-workspace/SubagentDelegationSection.tsx b/gui/src/components/subagents-workspace/SubagentDelegationSection.tsx
index 46c0447a7..7c3b0e942 100644
--- a/gui/src/components/subagents-workspace/SubagentDelegationSection.tsx
+++ b/gui/src/components/subagents-workspace/SubagentDelegationSection.tsx
@@ -28,6 +28,13 @@ export interface SubagentDelegationSectionProps {
   onUltraModeSave: (patch: UltraModePatch) => void;
   ultraLoadFailed: boolean;
   onUltraModeRetry: () => void;
+  fallback: string[];
+  fallbackPollMs: number;
+  fallbackBusy: boolean;
+  availableModels: string[];
+  onFallbackChange: (models: string[]) => void;
+  onFallbackPollMsChange: (pollMs: number) => void;
+  onFallbackSave: () => void;
 }
 
 export default function SubagentDelegationSection({
@@ -44,6 +51,7 @@ export default function SubagentDelegationSection({
   onUltraModeSave,
   ultraLoadFailed,
   onUltraModeRetry,
+  fallback, fallbackPollMs, fallbackBusy, availableModels, onFallbackChange, onFallbackPollMsChange, onFallbackSave,
 }: SubagentDelegationSectionProps) {
   const t = useT();
   // A present empty/whitespace hint is an upstream override that suppresses the
@@ -97,6 +105,31 @@ export default function SubagentDelegationSection({
         </div>
       </div>
 
+      <div className="swi-delegation-row swi-fallback-editor">
+        <div className="setting-copy">
+          <div className="font-semibold">{t("sub.fallbackLabel")}</div>
+          <div className="muted setting-hint">{t("sub.fallbackHint")}</div>
+        </div>
+        <div className="swi-fallback-controls">
+          {fallback.map((modelName, index) => (
+            <div key={modelName} className="swi-fallback-row">
+              <span>{index + 1}. {modelName}</span>
+              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const next = [...fallback]; if (index > 0) [next[index - 1], next[index]] = [next[index], next[index - 1]]; onFallbackChange(next); }} disabled={fallbackBusy || index === 0} aria-label={t("sub.moveUp", { m: modelName })}>↑</button>
+              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const next = [...fallback]; if (index < next.length - 1) [next[index], next[index + 1]] = [next[index + 1], next[index]]; onFallbackChange(next); }} disabled={fallbackBusy || index === fallback.length - 1} aria-label={t("sub.moveDown", { m: modelName })}>↓</button>
+              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onFallbackChange(fallback.filter(item => item !== modelName))} disabled={fallbackBusy}>×</button>
+            </div>
+          ))}
+          <select className="input" value="" onChange={e => { if (e.target.value && !fallback.includes(e.target.value)) onFallbackChange([...fallback, e.target.value]); }} disabled={fallbackBusy}>
+            <option value="">{t("sub.fallbackAdd")}</option>
+            {availableModels.filter(modelName => !fallback.includes(modelName)).map(modelName => <option key={modelName} value={modelName}>{modelName}</option>)}
+          </select>
+          <label className="setting-hint">{t("sub.fallbackPoll")}
+            <input className="input" type="number" min={5000} max={600000} step={1000} value={fallbackPollMs} onChange={e => onFallbackPollMsChange(Number(e.target.value) || 60000)} disabled={fallbackBusy} /> ms
+          </label>
+          <button type="button" className="btn btn-primary btn-sm" onClick={onFallbackSave} disabled={fallbackBusy}>{t("common.save")}</button>
+        </div>
+      </div>
+
       <div className="swi-delegation-row">
         <div className="setting-copy">
           <div className="font-semibold">{t("dash.syncCodexSubagentDefaults")}</div>
diff --git a/gui/src/components/subagents-workspace/SubagentsWorkspace.tsx b/gui/src/components/subagents-workspace/SubagentsWorkspace.tsx
index a22bd2a30..30b722b2b 100644
--- a/gui/src/components/subagents-workspace/SubagentsWorkspace.tsx
+++ b/gui/src/components/subagents-workspace/SubagentsWorkspace.tsx
@@ -37,6 +37,12 @@ export interface SubagentsWorkspaceProps {
   onToggle: (m: string) => void;
   onMove: (i: number, dir: -1 | 1) => void;
   onSave: () => void;
+  fallback: string[];
+  fallbackPollMs: number;
+  fallbackBusy: boolean;
+  onFallbackChange: (models: string[]) => void;
+  onFallbackPollMsChange: (pollMs: number) => void;
+  onFallbackSave: () => void;
   delegation: {
     model: string;
     effort: string;
@@ -63,6 +69,7 @@ export default function SubagentsWorkspace({
   onToggle,
   onMove,
   onSave,
+  fallback, fallbackPollMs, fallbackBusy, onFallbackChange, onFallbackPollMsChange, onFallbackSave,
   delegation,
 }: SubagentsWorkspaceProps) {
   const t = useT();
@@ -237,6 +244,13 @@ export default function SubagentsWorkspace({
             onUltraModeSave={delegation.onUltraModeSave}
             ultraLoadFailed={delegation.ultraLoadFailed}
             onUltraModeRetry={delegation.onUltraModeRetry}
+            fallback={fallback}
+            fallbackPollMs={fallbackPollMs}
+            fallbackBusy={fallbackBusy}
+            availableModels={available}
+            onFallbackChange={onFallbackChange}
+            onFallbackPollMsChange={onFallbackPollMsChange}
+            onFallbackSave={onFallbackSave}
           />
         </section>
       </div>
diff --git a/gui/src/i18n/de.ts b/gui/src/i18n/de.ts
index 429379396..2bb0b10c1 100644
--- a/gui/src/i18n/de.ts
+++ b/gui/src/i18n/de.ts
@@ -672,6 +672,12 @@ export const de: Record<TKey, string> = {
   "sub.ultraModeLoadFail": "Ultra-Modus-Einstellungen konnten nicht geladen werden — läuft der Proxy?",
   "sub.ultraModeSaveFail": "Ultra-Modus-Einstellungen konnten nicht gespeichert werden",
   "sub.ultraModeSaved": "Ultra-Modus gespeichert. Gilt für neue Codex-Sitzungen.",
+  "sub.fallbackLabel": "Fallback-Kette für Sub-Agenten",
+  "sub.fallbackHint": "Geordnete Modelle, die versucht werden, wenn ein Sub-Agent-Modell nicht verfügbar ist oder fehlschlägt.",
+  "sub.fallbackAdd": "Fallback-Modell hinzufügen…",
+  "sub.fallbackPoll": "Intervall der Verfügbarkeitsprüfung",
+  "sub.fallbackSaved": "Fallback-Einstellungen für Sub-Agenten gespeichert.",
+  "sub.fallbackSaveFailed": "Fallback-Einstellungen konnten nicht gespeichert werden",
   "logs.title": "Anfrage-Protokolle",
   "logs.tabLogs": "Protokolle",
   "logs.tabDebug": "Diagnose",
diff --git a/gui/src/i18n/en.ts b/gui/src/i18n/en.ts
index 9cbf8699f..e1346616a 100644
--- a/gui/src/i18n/en.ts
+++ b/gui/src/i18n/en.ts
@@ -315,6 +315,12 @@ export const en = {
   "dash.visionTimeout": "Timeout",
   "dash.visionTimeoutInvalid": "Enter an integer from {min} to {max} milliseconds.",
   "dash.visionAdvancedPopover": "Advanced vision settings",
+  "sub.fallbackLabel": "Sub-agent fallback chain",
+  "sub.fallbackHint": "Ordered models tried when a sub-agent model is unavailable or fails.",
+  "sub.fallbackAdd": "Add fallback model…",
+  "sub.fallbackPoll": "Availability check interval",
+  "sub.fallbackSaved": "Sub-agent fallback settings saved.",
+  "sub.fallbackSaveFailed": "Failed to save fallback settings",
   "dash.shadowCallIntercept": "Shadow Call Intercept",
   "dash.shadowCallInterceptHint": "Intercepts Codex App's background helper calls ({models}) for title generation and commit messages and redirects them to your chosen model.",
   "dash.shadowCallWarning": "⚠ When enabled, ALL requests for {models} will be replaced with the selected model.",
diff --git a/gui/src/i18n/fr.ts b/gui/src/i18n/fr.ts
index ec171e627..d5d29b0be 100644
--- a/gui/src/i18n/fr.ts
+++ b/gui/src/i18n/fr.ts
@@ -305,6 +305,12 @@ export const fr: Record<TKey, string> = {
   "dash.visionTimeout": "Délai d’expiration",
   "dash.visionTimeoutInvalid": "Saisissez un entier compris entre {min} et {max} millisecondes.",
   "dash.visionAdvancedPopover": "Paramètres de vision avancés",
+  "sub.fallbackLabel": "Chaîne de secours des sous-agents",
+  "sub.fallbackHint": "Modèles essayés dans l’ordre lorsqu’un modèle de sous-agent est indisponible ou échoue.",
+  "sub.fallbackAdd": "Ajouter un modèle de secours…",
+  "sub.fallbackPoll": "Intervalle de vérification de disponibilité",
+  "sub.fallbackSaved": "Paramètres de secours des sous-agents enregistrés.",
+  "sub.fallbackSaveFailed": "Échec de l’enregistrement des paramètres de secours",
   "dash.shadowCallIntercept": "Interception des appels fantômes",
   "dash.shadowCallInterceptHint": "Intercepte les appels auxiliaires en arrière-plan de l’application Codex ({models}) pour générer les titres et les messages de commit, puis les redirige vers le modèle choisi.",
   "dash.shadowCallWarning": "⚠ Lorsque cette option est activée, TOUTES les requêtes destinées à {models} sont remplacées par le modèle sélectionné.",
diff --git a/gui/src/i18n/ja.ts b/gui/src/i18n/ja.ts
index c71bd7a04..747438bdc 100644
--- a/gui/src/i18n/ja.ts
+++ b/gui/src/i18n/ja.ts
@@ -632,6 +632,12 @@ export const ja: Record<TKey, string> = {
   "sub.ultraModeLoadFail": "ウルトラモード設定を読み込めませんでした — プロキシは実行中ですか？",
   "sub.ultraModeSaveFail": "ウルトラモード設定の保存に失敗しました",
   "sub.ultraModeSaved": "ウルトラモードを保存しました。新しい Codex セッションから適用されます。",
+  "sub.fallbackLabel": "サブエージェントのフォールバックチェーン",
+  "sub.fallbackHint": "サブエージェントモデルが利用できないか失敗した場合に順番に試すモデルです。",
+  "sub.fallbackAdd": "フォールバックモデルを追加…",
+  "sub.fallbackPoll": "利用可能性チェック間隔",
+  "sub.fallbackSaved": "サブエージェントのフォールバック設定を保存しました。",
+  "sub.fallbackSaveFailed": "フォールバック設定の保存に失敗しました",
 
   // logs
   "logs.title": "リクエストログ",
diff --git a/gui/src/i18n/ko.ts b/gui/src/i18n/ko.ts
index 63ac30442..ecc0e4560 100644
--- a/gui/src/i18n/ko.ts
+++ b/gui/src/i18n/ko.ts
@@ -689,6 +689,12 @@ export const ko: Record<TKey, string> = {
   "sub.ultraModeLoadFail": "울트라 모드 설정을 불러오지 못했습니다 — 프록시가 실행 중인가요?",
   "sub.ultraModeSaveFail": "울트라 모드 설정 저장에 실패했습니다",
   "sub.ultraModeSaved": "울트라 모드가 저장되었습니다. 새 Codex 세션부터 적용됩니다.",
+  "sub.fallbackLabel": "서브에이전트 폴백 체인",
+  "sub.fallbackHint": "서브에이전트 모델을 사용할 수 없거나 실패할 때 순서대로 시도할 모델입니다.",
+  "sub.fallbackAdd": "폴백 모델 추가…",
+  "sub.fallbackPoll": "가용성 확인 간격",
+  "sub.fallbackSaved": "서브에이전트 폴백 설정을 저장했습니다.",
+  "sub.fallbackSaveFailed": "폴백 설정을 저장하지 못했습니다",
 
   // logs
   "logs.title": "요청 로그",
diff --git a/gui/src/i18n/ru.ts b/gui/src/i18n/ru.ts
index 9f220ba2b..852eb4467 100644
--- a/gui/src/i18n/ru.ts
+++ b/gui/src/i18n/ru.ts
@@ -687,6 +687,12 @@ export const ru: Record<TKey, string> = {
   "sub.ultraModeLoadFail": "Не удалось загрузить настройки ультра-режима — работает ли прокси?",
   "sub.ultraModeSaveFail": "Не удалось сохранить настройки ультра-режима",
   "sub.ultraModeSaved": "Ультра-режим сохранён. Применяется к новым сеансам Codex.",
+  "sub.fallbackLabel": "Цепочка резервных моделей субагента",
+  "sub.fallbackHint": "Модели, которые последовательно пробуются, если модель субагента недоступна или завершается ошибкой.",
+  "sub.fallbackAdd": "Добавить резервную модель…",
+  "sub.fallbackPoll": "Интервал проверки доступности",
+  "sub.fallbackSaved": "Настройки резервных моделей субагента сохранены.",
+  "sub.fallbackSaveFailed": "Не удалось сохранить настройки резервных моделей",
 
   // logs
   "logs.title": "Журнал запросов",
diff --git a/gui/src/i18n/tr.ts b/gui/src/i18n/tr.ts
index aee152cd3..71d9e7313 100644
--- a/gui/src/i18n/tr.ts
+++ b/gui/src/i18n/tr.ts
@@ -694,6 +694,12 @@ export const tr: Record<TKey, string> = {
   "sub.ultraModeLoadFail": "Ultra modu ayarları yüklenemedi — proxy çalışıyor mu?",
   "sub.ultraModeSaveFail": "Ultra modu ayarları kaydedilemedi",
   "sub.ultraModeSaved": "Ultra modu kaydedildi. Yeni Codex oturumlarına uygulanır.",
+  "sub.fallbackLabel": "Alt ajan yedek zinciri",
+  "sub.fallbackHint": "Alt ajan modeli kullanılamadığında veya başarısız olduğunda sırayla denenecek modeller.",
+  "sub.fallbackAdd": "Yedek model ekle…",
+  "sub.fallbackPoll": "Kullanılabilirlik kontrol aralığı",
+  "sub.fallbackSaved": "Alt ajan yedek ayarları kaydedildi.",
+  "sub.fallbackSaveFailed": "Yedek ayarlar kaydedilemedi",
 
   // logs
   "logs.title": "İstek Günlükleri",
diff --git a/gui/src/i18n/zh-TW.ts b/gui/src/i18n/zh-TW.ts
index 39c9e2f0b..50659c2e6 100644
--- a/gui/src/i18n/zh-TW.ts
+++ b/gui/src/i18n/zh-TW.ts
@@ -541,6 +541,12 @@ export const zhTW: Record<TKey, string> = {
   "sub.ultraModeLoadFail": "無法載入超級模式設定 — 代理是否在執行？",
   "sub.ultraModeSaveFail": "儲存超級模式設定失敗",
   "sub.ultraModeSaved": "超級模式已儲存。適用於新的 Codex 會話。",
+  "sub.fallbackLabel": "子代理備援鏈",
+  "sub.fallbackHint": "子代理模型無法使用或失敗時，依序嘗試的模型。",
+  "sub.fallbackAdd": "新增備援模型…",
+  "sub.fallbackPoll": "可用性檢查間隔",
+  "sub.fallbackSaved": "子代理備援設定已儲存。",
+  "sub.fallbackSaveFailed": "備援設定儲存失敗",
   "logs.title": "請求日誌",
   "logs.tabLogs": "日誌",
   "logs.tabDebug": "除錯",
diff --git a/gui/src/i18n/zh.ts b/gui/src/i18n/zh.ts
index 1ba4cabfa..ded94d699 100644
--- a/gui/src/i18n/zh.ts
+++ b/gui/src/i18n/zh.ts
@@ -682,6 +682,12 @@ export const zh: Record<TKey, string> = {
   "sub.ultraModeLoadFail": "无法加载超级模式设置 — 代理是否在运行？",
   "sub.ultraModeSaveFail": "保存超级模式设置失败",
   "sub.ultraModeSaved": "超级模式已保存。适用于新的 Codex 会话。",
+  "sub.fallbackLabel": "子代理回退链",
+  "sub.fallbackHint": "子代理模型不可用或失败时按顺序尝试的模型。",
+  "sub.fallbackAdd": "添加回退模型…",
+  "sub.fallbackPoll": "可用性检查间隔",
+  "sub.fallbackSaved": "子代理回退设置已保存。",
+  "sub.fallbackSaveFailed": "保存回退设置失败",
 
   // logs
   "logs.title": "请求日志",
diff --git a/gui/src/pages/Subagents.tsx b/gui/src/pages/Subagents.tsx
index 6b54d39ff..299c9306f 100644
--- a/gui/src/pages/Subagents.tsx
+++ b/gui/src/pages/Subagents.tsx
@@ -8,7 +8,7 @@ import { useDataSurface } from "../data-surface";
 import { DataSurfaceSkeleton } from "../components/data-surface";
 import { useSubagentDelegation, type UltraModePatch, type UltraModeState } from "./use-subagent-delegation";
 
-type CachedSubagents = { available: string[]; chosen: string[] };
+type CachedSubagents = { available: string[]; chosen: string[]; fallback: string[]; pollMs: number };
 
 function seedSubagents(cacheKey: string): CachedSubagents | null {
   return readSessionListCache<CachedSubagents>(cacheKey);
@@ -19,6 +19,9 @@ export default function Subagents({ apiBase }: { apiBase: string }) {
   const cacheKey = `ocx.subagents.v1:${apiBase}`;
   const cached = seedSubagents(cacheKey);
   const [chosen, setChosen] = useState<string[]>(() => cached?.chosen ?? []);
+  const [fallback, setFallback] = useState<string[]>(() => cached?.fallback ?? []);
+  const [fallbackPollMs, setFallbackPollMs] = useState(() => cached?.pollMs ?? 60000);
+  const [fallbackBusy, setFallbackBusy] = useState(false);
   const [status, setStatus] = useState("");
   const [ok, setOk] = useState(false);
   const [busy, setBusy] = useState(false);
@@ -117,16 +120,24 @@ export default function Subagents({ apiBase }: { apiBase: string }) {
   const loadSubagents = useCallback(async (signal?: AbortSignal): Promise<CachedSubagents> => {
     // The resource layer's deadline abort must reach the wire — a signal dropped
     // here is a store that can only settle by race timeout.
-    const res = await fetch(`${apiBase}/api/subagent-models`, { signal });
-    const response = await readJsonOrThrow<{ available?: string[]; chosen?: string[] }>(res, t("sub.loadFail"));
-    if (!response) throw new Error(t("sub.loadFail"));
-    const available = response.available ?? [];
+    const [rosterRes, fallbackRes] = await Promise.all([
+      fetch(`${apiBase}/api/subagent-models`, { signal }),
+      fetch(`${apiBase}/api/subagent-model-fallback`, { signal }),
+    ]);
+    const response = await readJsonOrThrow<{ available?: string[]; chosen?: string[] }>(rosterRes, t("sub.loadFail"));
+    const fallbackResponse = await readJsonOrThrow<{ available?: string[]; models?: string[]; pollMs?: number }>(fallbackRes, t("sub.loadFail"));
+    if (!response || !fallbackResponse) throw new Error(t("sub.loadFail"));
+    const available = response.available ?? fallbackResponse.available ?? [];
     const availableSet = new Set(available);
     const next = {
       available,
       chosen: (response.chosen ?? []).filter(model => availableSet.has(model)),
+      fallback: (fallbackResponse.models ?? []).filter(model => availableSet.has(model)),
+      pollMs: fallbackResponse.pollMs ?? 60000,
     };
     setChosen(next.chosen);
+    setFallback(next.fallback);
+    setFallbackPollMs(next.pollMs);
     writeSessionListCache(cacheKey, next);
     return next;
   }, [apiBase, cacheKey, t]);
@@ -174,7 +185,7 @@ export default function Subagents({ apiBase }: { apiBase: string }) {
       const d = await readJsonOrThrow<{ applied?: string[] }>(r, t("sub.saveFailed"));
       const applied = d?.applied ?? chosen;
       if (d?.applied) setChosen(d.applied);
-      writeSessionListCache(cacheKey, { available, chosen: applied });
+      writeSessionListCache(cacheKey, { available, chosen: applied, fallback, pollMs: fallbackPollMs });
       setOk(true);
       setStatus(t("sub.saved", { n: applied.length, cmd: "ocx sync" }));
     } catch (error) {
@@ -186,6 +197,28 @@ export default function Subagents({ apiBase }: { apiBase: string }) {
     }
   };
 
+  const saveFallback = async () => {
+    if (fallbackBusy) return;
+    setFallbackBusy(true);
+    try {
+      const r = await fetch(`${apiBase}/api/subagent-model-fallback`, {
+        method: "PUT",
+        headers: { "Content-Type": "application/json" },
+        body: JSON.stringify({ models: fallback, pollMs: fallbackPollMs }),
+      });
+      const d = await readJsonOrThrow<{ models?: string[]; pollMs?: number }>(r, t("sub.fallbackSaveFailed"));
+      if (d?.models) setFallback(d.models);
+      if (d?.pollMs) setFallbackPollMs(d.pollMs);
+      setOk(true);
+      setStatus(t("sub.fallbackSaved"));
+    } catch (error) {
+      setOk(false);
+      setStatus(error instanceof Error && error.message ? error.message : t("sub.networkError"));
+    } finally {
+      setFallbackBusy(false);
+    }
+  };
+
   // The skeleton owns the live region while this resource has no content yet.
   if (state.showSkeleton && !snapshot) {
     return <DataSurfaceSkeleton label={t("sub.loading")} rows={4} />;
@@ -214,7 +247,13 @@ export default function Subagents({ apiBase }: { apiBase: string }) {
         busy={busy}
         onToggle={toggle}
         onMove={move}
-        onSave={() => { void save(); }}
+          onSave={() => { void save(); }}
+          fallback={fallback}
+          fallbackPollMs={fallbackPollMs}
+          fallbackBusy={fallbackBusy}
+          onFallbackChange={setFallback}
+          onFallbackPollMsChange={setFallbackPollMs}
+          onFallbackSave={() => { void saveFallback(); }}
         delegation={{
           model: delegation.model,
           effort: delegation.effort,

```

Audit amendment: cache server-confirmed fallback values after fallback Save; roster Save preserves committed fallback snapshot, never draft. Add independent-save and remount regressions. Existing dashboard density, CSS tokens, Select and icon library retained; no concept art needed for utility editor.
