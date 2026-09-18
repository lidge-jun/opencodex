# Containment source-pinned change design

Source: PR #4313 at 676b97ff1314b24f5da9949732bfad45809f2eae. Initial carry uses the following public diff, revalidated against current dev at phase P. Every diff header is the exact NEW/MODIFY file map. Main resolves conflicts against current owners; no wholesale replacement from a stale head.

Before: current merge-base behavior in removed lines. After: added lines below. Tests are authored but NOT RUN locally; final-tip hosted CI observes these files. No new dependency or persisted schema is introduced by containment/continuation; relay owner state remains bounded/process-local and needs separate security review.

Activation: synthetic ordinal-bearing session_meta; history_mode DB columns including legacy rows; migration between preflight and artifact completion; config restoration failure; rollout replacement before first-line patch/append. Observe refusal, byte-identical preimages and no DB provider transition. Containment tier is runtime validation; executing surface history-provider/inject; native concurrent writer can bypass cross-process scheduling checks; residual race remains; wording is defensive containment, final native-writer lock: none.

Current-dev adaptation: source/tests/locale hunks are applied as scoped diffs; eight structure additions are appended to their current owning docs without replacing existing sections. `git apply --check --exclude=structure/*` validates patch shape only. This is not a product test.

```diff
diff --git a/docs-site/src/content/docs/fr/guides/codex-integration.md b/docs-site/src/content/docs/fr/guides/codex-integration.md
index e8a4deae4f..68af97b7b4 100644
--- a/docs-site/src/content/docs/fr/guides/codex-integration.md
+++ b/docs-site/src/content/docs/fr/guides/codex-integration.md
@@ -416,3 +416,9 @@ ocx restore back # point plain Codex at the running proxy again
 Lorsque opencodex s'exécute comme [service d'arrière-plan géré](/fr/reference/cli/lifecycle/#ocx-service-installrepairstartstopstatusuninstallremove), il définit
 `OCX_SERVICE=1` afin qu'un redémarrage déclenché par le service ne modifie **pas** sans cesse la configuration
 Codex. Seule l'exécution explicite de `ocx stop` ou `ocx service stop` restaure Codex natif.
+
+## Refus de sécurité pour l’historique paginé
+
+Une transition de fournisseur peut renvoyer `history_paginated_requires_native_writer` si le stockage concerné prend en charge la pagination, même pour ses lignes legacy. OpenCodex conserve configuration, profil, catalogue, historique et preuves de restauration au lieu d’attribuer des numéros hors de Codex. Les sorties sans transition, comme la préservation d’un fournisseur externe, restent disponibles.
+
+Ne supprimez pas un fournisseur encore référencé, ne répétez pas `ocx sync` ou une restauration legacy et ne réécrivez pas un historique actif. Conservez les fichiers, fermez la conversation avant toute récupération et signalez l’erreur exacte et les versions sans publier de données privées. Utilisez un correctif vérifié coordonné avec le processus natif d’écriture. Une sauvegarde ou le succès d’un script ne prouve pas le rétablissement de l’affichage : vérifiez la conversation après réouverture de Codex.
diff --git a/docs-site/src/content/docs/guides/codex-integration.md b/docs-site/src/content/docs/guides/codex-integration.md
index a99b880fc1..f36d7b0a70 100644
--- a/docs-site/src/content/docs/guides/codex-integration.md
+++ b/docs-site/src/content/docs/guides/codex-integration.md
@@ -772,3 +772,9 @@ injection. Explicit external-provider opt-out behavior is unchanged.
 In **Subagents → Delegation settings**, edit the ordered fallback chain and its availability polling interval (5000–600000 ms), then save it separately from the featured roster. A configured target that is no longer advertised remains in the chain until you remove it. The roster and fallback chain are separate settings; this editor does not make the roster replace the fallback policy.

 When a routed preferred model may receive V2 work from a native ChatGPT parent, the panel explains the upstream encrypted-task limitation. Readable tasks from routed parents are unaffected. The guidance uses `/api/v2` mode and native V1 pin state; the current API does not expose recovery activation or request-specific eligibility, so the panel reports those as unknown. V1/plaintext-compatible delegation remains an alternative. Experimental V2 recovery, where eligible and explicitly enabled, adds quota usage, latency, backend dependence and possible fidelity loss; it does not repair the upstream protocol. See [sub-agent surfaces](/guides/sub-agent-surface/) and [the upstream limitation](https://github.com/lidge-jun/opencodex/issues/92).
+
+## Paginated history safety refusal
+
+When an affected history store supports paginated records, a provider transition may return `history_paginated_requires_native_writer`. OpenCodex preserves the current configuration, profile, catalog, rollout and restore provenance instead of assigning ordinals outside Codex. This includes legacy rows in a migration-capable store. No-transition exits, such as preserving an external provider, remain available.
+
+Do not delete a provider definition still referenced by a conversation, repeatedly run `ocx sync` or legacy recovery, or rewrite an active rollout to work around this refusal. Keep the current files, close the affected conversation before any recovery, and report the exact error and versions without uploading private history. Use a verified fix with native-writer coordination; a backup or a successful script alone does not prove the conversation is visible again. Check the restored conversation in Codex after reopening.
diff --git a/docs-site/src/content/docs/ja/guides/codex-integration.md b/docs-site/src/content/docs/ja/guides/codex-integration.md
index 4ce54074d3..9fb892e763 100644
--- a/docs-site/src/content/docs/ja/guides/codex-integration.md
+++ b/docs-site/src/content/docs/ja/guides/codex-integration.md
@@ -280,3 +280,9 @@ ocx restore back # point plain Codex at the running proxy again
 ```

 opencodex が管理対象 [バックグラウンドサービス](/reference/cli/#ocx-service) として実行される場合、`OCX_SERVICE=1` が設定されるため、サービス主導の再起動によって Codex 設定がスラッシングされなくなります。明示的な `ocx stop` / `ocx service stop` のみがネイティブ Codex を復元します。
+
+## ページ分割履歴の保護による拒否
+
+対象の履歴ストアがページ分割をサポートする場合、プロバイダー変更は `history_paginated_requires_native_writer` で拒否されることがあります。Codex の外で番号を割り当てず、設定、プロファイル、カタログ、履歴ファイル、復元情報を保持します。移行可能なストアの legacy 行も対象です。外部プロバイダーを保持するだけの経路は利用できます。
+
+会話が参照するプロバイダー定義を削除したり、`ocx sync` や旧式の復元を繰り返したり、使用中の履歴を書き換えたりしないでください。ファイルを保持し、復元前に対象の会話を閉じ、個人の履歴を公開せず正確なエラーとバージョンを報告してください。ネイティブの書き込み処理と連携する検証済みの修正が必要です。バックアップやスクリプトの成功だけでは表示の復元は証明されません。再度開いた Codex で確認してください。
diff --git a/docs-site/src/content/docs/ko/guides/codex-integration.md b/docs-site/src/content/docs/ko/guides/codex-integration.md
index 584e77adb0..7ae5a2aa09 100644
--- a/docs-site/src/content/docs/ko/guides/codex-integration.md
+++ b/docs-site/src/content/docs/ko/guides/codex-integration.md
@@ -291,3 +291,9 @@ ocx restore back # point plain Codex at the running proxy again
 ```

 opencodex가 managed [background service](/reference/cli/#ocx-service)로 실행될 때는 `OCX_SERVICE=1`을 설정하므로 service-driven restart가 Codex config를 흔들지 **않습니다**. 네이티브 Codex를 복원하는 것은 명시적인 `ocx stop` / `ocx service stop`뿐입니다.
+
+## 페이지 분할 기록 보호에 따른 거부
+
+영향받는 기록 저장소가 페이지 분할을 지원하면 프로바이더 전환이 `history_paginated_requires_native_writer`로 거부될 수 있습니다. OpenCodex는 Codex 밖에서 순번을 지정하는 대신 현재 설정, 프로필, 카탈로그, 대화 원본과 복원 근거를 보존합니다. 변환 가능한 저장소의 `legacy` 행도 포함됩니다. 외부 프로바이더 보존처럼 전환을 하지 않는 경로는 계속 사용할 수 있습니다.
+
+대화가 참조하는 프로바이더 정의를 삭제하거나, `ocx sync`·레거시 복구를 반복하거나, 실행 중인 대화 원본을 고쳐 우회하지 마세요. 현재 파일을 보존하고 복구 전에 해당 대화를 닫은 뒤, 개인 대화 내용을 올리지 말고 정확한 오류와 버전을 보고하세요. 네이티브 기록 작성자와 조정하는 검증된 수정이 필요합니다. 백업이나 스크립트 성공만으로 표시 복구가 증명되지는 않으므로 Codex를 다시 열어 확인하세요.
diff --git a/docs-site/src/content/docs/ru/guides/codex-integration.md b/docs-site/src/content/docs/ru/guides/codex-integration.md
index e695830370..f23b7543a4 100644
--- a/docs-site/src/content/docs/ru/guides/codex-integration.md
+++ b/docs-site/src/content/docs/ru/guides/codex-integration.md
@@ -409,3 +409,9 @@ ocx restore back # point plain Codex at the running proxy again
 Когда opencodex работает как управляемая [фоновая служба](/reference/cli/#ocx-service), он
 устанавливает `OCX_SERVICE=1`, чтобы service-driven restart **не** дёргал конфигурацию Codex —
 только явный `ocx stop` / `ocx service stop` восстанавливает нативный Codex.
+
+## Защитный отказ для постраничной истории
+
+Если затронутое хранилище поддерживает постраничную историю, смена провайдера может вернуть `history_paginated_requires_native_writer`, в том числе для строк legacy. OpenCodex сохраняет конфигурацию, профиль, каталог, историю и данные восстановления, не назначая номера вне Codex. Пути без смены провайдера, например сохранение внешнего провайдера, остаются доступны.
+
+Не удаляйте используемое разговором определение провайдера, не повторяйте `ocx sync` или legacy-восстановление и не переписывайте активную историю. Сохраните файлы, закройте разговор перед восстановлением и сообщите точную ошибку и версии без публикации личной истории. Требуется проверенное исправление с согласованием с нативным процессом записи. Наличие резервной копии или успешный скрипт не доказывает восстановление отображения: проверьте разговор после повторного открытия Codex.
diff --git a/docs-site/src/content/docs/tr/guides/codex-integration.md b/docs-site/src/content/docs/tr/guides/codex-integration.md
index 23b9b87f2e..501f05d8c9 100644
--- a/docs-site/src/content/docs/tr/guides/codex-integration.md
+++ b/docs-site/src/content/docs/tr/guides/codex-integration.md
@@ -467,3 +467,9 @@ opencodex yönetilen bir [arka plan servisi](/tr/reference/cli/#ocx-service)
 olarak çalıştığında `OCX_SERVICE=1` ayarlar, böylece servis odaklı bir yeniden
 başlatma Codex yapılandırmasını **bozmaz** — yalnızca açık bir `ocx stop` / `ocx
 service stop` yerel Codex'i geri yükler.
+
+## Sayfalanmış geçmiş için güvenlik reddi
+
+Etkilenen geçmiş deposu sayfalamayı destekliyorsa sağlayıcı değişimi `history_paginated_requires_native_writer` döndürebilir; legacy satırlar da buna dahildir. OpenCodex, Codex dışında sıra numarası atamak yerine yapılandırmayı, profili, kataloğu, geçmişi ve geri yükleme kanıtlarını korur. Harici sağlayıcıyı korumak gibi değişim yapmayan yollar kullanılabilir.
+
+Konuşmanın kullandığı sağlayıcı tanımını silmeyin, `ocx sync` veya legacy kurtarmayı tekrarlamayın ve etkin geçmişi yeniden yazmayın. Dosyaları koruyun, kurtarmadan önce konuşmayı kapatın ve özel geçmişi yayımlamadan tam hatayı ve sürümleri bildirin. Yerel yazıcıyla koordineli, doğrulanmış bir düzeltme gerekir. Yedek veya başarılı betik görüntünün düzeldiğini kanıtlamaz; Codex’i yeniden açıp konuşmayı kontrol edin.
diff --git a/docs-site/src/content/docs/zh-cn/guides/codex-integration.md b/docs-site/src/content/docs/zh-cn/guides/codex-integration.md
index 71d2b81473..37c12243f8 100644
--- a/docs-site/src/content/docs/zh-cn/guides/codex-integration.md
+++ b/docs-site/src/content/docs/zh-cn/guides/codex-integration.md
@@ -353,3 +353,9 @@ ocx restore back # point plain Codex at the running proxy again
 当 opencodex 作为受管的 [background service](/reference/cli/#ocx-service) 运行时，它会设置
 `OCX_SERVICE=1`，这样由服务驱动的重启**不会**反复改写 Codex config——只有显式的
 `ocx stop` / `ocx service stop` 才会恢复原生 Codex。
+
+## 分页历史记录安全拒绝
+
+如果受影响的历史存储支持分页，提供商切换可能返回 `history_paginated_requires_native_writer`。OpenCodex 会保留当前配置、配置档、模型目录、历史文件及恢复依据，而不是在 Codex 之外分配序号；可迁移存储中的 legacy 记录也受保护。仅保留外部提供商而不执行切换的路径仍然可用。
+
+不要删除会话仍在引用的提供商定义、反复运行 `ocx sync` 或旧版恢复，也不要改写正在使用的历史文件来绕过拒绝。保留文件，在恢复前关闭相关会话，并只报告准确的错误和版本，不要公开私人历史。需要与原生写入器协调的已验证修复。备份或脚本成功并不能证明显示已恢复；重新打开 Codex 后检查会话。
diff --git a/docs-site/src/content/docs/zh-tw/guides/codex-integration.md b/docs-site/src/content/docs/zh-tw/guides/codex-integration.md
index c9f8090987..c24cd53d09 100644
--- a/docs-site/src/content/docs/zh-tw/guides/codex-integration.md
+++ b/docs-site/src/content/docs/zh-tw/guides/codex-integration.md
@@ -360,3 +360,9 @@ ocx restore back # 讓普通 Codex 再次指向仍在執行的 proxy
 當 opencodex 作為受管的 [背景服務](/zh-tw/reference/cli/#ocx-service) 執行時，會設定 `OCX_SERVICE=1`，
 因此 service 驅動的 restart **不會**反覆改寫 Codex 設定；只有明確執行 `ocx stop` 或
 `ocx service stop` 才會恢復原生 Codex。
+
+## 分頁歷史記錄安全拒絕
+
+如果受影響的歷史儲存區支援分頁，提供者切換可能傳回 `history_paginated_requires_native_writer`。OpenCodex 會保留目前設定、設定檔、模型目錄、歷史檔案及復原依據，而不在 Codex 之外分配序號；可遷移儲存區中的 legacy 記錄也受保護。不執行切換、僅保留外部提供者的路徑仍可使用。
+
+請勿刪除對話仍參照的提供者定義、反覆執行 `ocx sync` 或舊版復原，也不要改寫使用中的歷史檔案來繞過拒絕。保留檔案，復原前關閉相關對話，只回報確切錯誤與版本，不要公開私人歷史。需要與原生寫入器協調的已驗證修正。備份或指令碼成功不能證明顯示已復原；重新開啟 Codex 後確認對話。
diff --git a/src/codex/history-provider.ts b/src/codex/history-provider.ts
index d7f1832e8f..e121d7007d 100644
--- a/src/codex/history-provider.ts
+++ b/src/codex/history-provider.ts
@@ -1,5 +1,5 @@
 import { createHash } from "node:crypto";
-import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeSync } from "node:fs";
+import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeSync } from "node:fs";
 import { dirname, join, resolve } from "node:path";
 import { zstdDecompressSync } from "node:zlib";
 import { Database } from "bun:sqlite";
@@ -75,14 +75,21 @@ function openStateDb(stateDbPath: string): Database {
  * rollout's updated_at), and forcing it backwards could hide a real edit from list ordering.
  */
 function appendRolloutLine(path: string, line: string): Buffer {
-  const fd = openSync(path, "a");
+  assertLegacyHistoryRecord(line);
+  // No O_CREAT: a disappeared target is not an invitation to recreate history.
+  const fd = openSync(path, constants.O_RDWR | constants.O_APPEND);
   const buf = Buffer.from(line.endsWith("\n") ? line : `${line}\n`, "utf8");
   try {
+    assertLegacyHistoryWritable(path, fd);
+    historyAppendHooks?.beforeWrite?.(path);
+    assertHistoryDescriptorIdentity(path, fd);
     let offset = 0;
     while (offset < buf.length) {
       offset += writeSync(fd, buf, offset, buf.length - offset, null);
     }
     try { fsyncSync(fd); } catch { /* best-effort durability */ }
+    historyAppendHooks?.afterWrite?.(path);
+    assertHistoryDescriptorIdentity(path, fd);
   } finally {
     closeSync(fd);
   }
@@ -186,21 +193,38 @@ function readFirstLineProviderValue(path: string, expectedId: string): string |
   }
 }

-function patchFirstLineProviderInPlace(path: string, expectedId: string, provider: string): FirstLineProviderResult {
-  if (!existsSync(path)) return "unsafe";
+function patchFirstLineProviderInPlace(
+  path: string, expectedId: string, provider: string,
+  expectedIdentity: { dev: number | bigint; ino: number | bigint },
+): FirstLineProviderResult {
+  historyAppendHooks?.beforeFirstLineOpen?.(path);
   const fd = openSync(path, "r+");
   try {
+    const assertIdentity = (): void => {
+      assertHistoryDescriptorIdentity(path, fd);
+      const held = fstatSync(fd);
+      if (held.dev !== expectedIdentity.dev || held.ino !== expectedIdentity.ino) {
+        throw new CodexHistoryIntegrityError("history_rollout_identity_changed");
+      }
+    };
+    assertIdentity();
+    assertLegacyHistoryWritable(path, fd);
     const firstLine = readFirstRolloutLine(fd);
     if (firstLine === null) return "unsafe";
     const plan = planFirstLineProvider(firstLine, expectedId, provider);
     if (plan.state === "unsafe") return "unsafe";
     if (plan.state === "current") return "current";
     const out = Buffer.from(plan.patchedLine, "utf8");
+    historyAppendHooks?.beforeFirstLineWrite?.(path);
+    assertIdentity();
+    assertLegacyHistoryWritable(path, fd);
     let offset = 0;
     while (offset < out.length) {
       offset += writeSync(fd, out, offset, out.length - offset, offset);
     }
     try { fsyncSync(fd); } catch { /* best-effort durability */ }
+    historyAppendHooks?.afterFirstLineWrite?.(path);
+    assertIdentity();
     return "patched";
   } finally {
     closeSync(fd);
@@ -221,6 +245,101 @@ class CodexHistoryIntegrityError extends Error {
   }
 }

+/** Paginated ordinals and projection offsets belong to Codex's live writer.
+ * O_APPEND does not allocate an ordinal or update that writer's in-memory cursor.
+ * Refuse before changing the DB, manifest, or first-line provider; never guess N+1.
+ */
+function assertLegacyHistoryRecord(line: string): void {
+  let value: unknown;
+  try { value = JSON.parse(line); } catch { throw new CodexHistoryIntegrityError("history_rollout_record_invalid"); }
+  if (value === null || typeof value !== "object" || Array.isArray(value)) {
+    throw new CodexHistoryIntegrityError("history_rollout_record_invalid");
+  }
+  const record = value as Record<string, unknown>;
+  const payload = record.payload;
+  if (Object.hasOwn(record, "ordinal") || (payload !== null && typeof payload === "object" && (payload as Record<string, unknown>).history_mode === "paginated")) {
+    throw new CodexHistoryIntegrityError("history_paginated_requires_native_writer");
+  }
+}
+
+function assertHistoryDescriptorIdentity(path: string, fd: number): void {
+  const held = fstatSync(fd);
+  let current: ReturnType<typeof lstatSync>;
+  try { current = lstatSync(path); } catch { throw new CodexHistoryIntegrityError("history_rollout_identity_changed"); }
+  if (!current.isFile() || current.isSymbolicLink() || current.dev !== held.dev || current.ino !== held.ino) {
+    throw new CodexHistoryIntegrityError("history_rollout_identity_changed");
+  }
+}
+
+let historyAppendHooks: {
+  beforeWrite?: (path: string) => void;
+  afterWrite?: (path: string) => void;
+  beforeFirstLineOpen?: (path: string) => void;
+  beforeFirstLineWrite?: (path: string) => void;
+  afterFirstLineWrite?: (path: string) => void;
+} | undefined;
+export function setHistoryAppendHooksForTests(hooks: typeof historyAppendHooks): void { historyAppendHooks = hooks; }
+
+function assertLegacyHistoryWritable(path: string, heldFd?: number): void {
+  if (!path || !existsSync(path)) return;
+  const fd = heldFd ?? openSync(path, "r");
+  try {
+    assertHistoryDescriptorIdentity(path, fd);
+    const first = readFirstRolloutLine(fd);
+    if (!first) throw new CodexHistoryIntegrityError("history_rollout_record_invalid");
+    assertLegacyHistoryRecord(first);
+  } finally {
+    if (heldFd === undefined) closeSync(fd);
+  }
+}
+
+/** A store with history_mode can migrate legacy rows while Codex is running.
+ * Refuse the entire external mutation, not only rows already marked paginated.
+ */
+function assertLegacyHistoryStore(db: Database): void {
+  const columns = db.query<{ name: string }, []>("PRAGMA table_info(threads)").all();
+  if (columns.some(column => column.name === "history_mode")) {
+    throw new CodexHistoryIntegrityError("history_paginated_requires_native_writer");
+  }
+}
+
+/** Read-only preflight before the injector changes provider definitions.
+ * Native paginated history cannot participate in the legacy relabel protocol.
+ * Returning a refusal preserves the existing config as well as the rollout.
+ */
+export function preflightCodexHistoryInjection(
+  providerTableMode: boolean,
+  resumeHistory: boolean,
+  stateDbPath?: string,
+): string | null {
+  let db: Database | undefined;
+  try {
+    const resolvedPath = stateDbPath ?? resolveCodexStateDbPath();
+    if (!existsSync(resolvedPath)) return null;
+    db = new Database(resolvedPath, { readonly: true });
+    const columns = db.query<{ name: string }, []>("PRAGMA table_info(threads)").all();
+    const paginatedColumn = columns.some(column => column.name === "history_mode");
+    const rows = db.query<{ rollout_path: string; history_mode: string | null }, []>(`
+      SELECT rollout_path, ${paginatedColumn ? "history_mode" : "NULL AS history_mode"}
+      FROM threads
+      WHERE ${providerTableMode
+        ? resumeHistory ? "model_provider IN ('openai', 'opencodex')" : "0"
+        : "model_provider = 'opencodex'"}
+    `).all();
+    for (const row of rows) {
+      if (paginatedColumn || row.history_mode === "paginated") return "history_paginated_requires_native_writer";
+      assertLegacyHistoryWritable(row.rollout_path);
+    }
+    return null;
+  } catch (error) {
+    return error instanceof CodexHistoryIntegrityError
+      ? error.message
+      : "history_injection_preflight_unavailable";
+  } finally {
+    db?.close();
+  }
+}
+
 function integrityFailureResult(error: CodexHistoryIntegrityError): CodexHistorySyncResult {
   return {
     rows: error.progress.rows,
@@ -1026,6 +1145,7 @@ function updateSessionMeta(
   } = {},
 ): SessionMetaUpdateResult {
   if (!path || !existsSync(path)) return { changed: false, durableProvider: false };
+  const validatedIdentity = lstatSync(path);
   if (options.expectedFileIdentity !== undefined
     && historyFileIdentity(path) !== options.expectedFileIdentity) {
     return { changed: false, durableProvider: false, conflict: true };
@@ -1040,6 +1160,11 @@ function updateSessionMeta(
   if (!latest) return { changed: false, durableProvider: false };
   const record = latest.record;

+  assertLegacyHistoryWritable(path);
+  if (Object.hasOwn(record, "ordinal") || record.payload.history_mode === "paginated") {
+    throw new CodexHistoryIntegrityError("history_paginated_requires_native_writer");
+  }
+
   const latestProvider = typeof record.payload.model_provider === "string" && record.payload.model_provider
     ? record.payload.model_provider
     : "openai";
@@ -1094,8 +1219,9 @@ function updateSessionMeta(
     let firstLine: FirstLineProviderResult = "current";
     if (patch.provider !== undefined) {
       try {
-        firstLine = patchFirstLineProviderInPlace(path, expectedId, patch.provider);
-      } catch {
+        firstLine = patchFirstLineProviderInPlace(path, expectedId, patch.provider, validatedIdentity);
+      } catch (error) {
+        if (error instanceof CodexHistoryIntegrityError) throw error;
         firstLine = "unsafe";
       }
     }
@@ -1122,8 +1248,9 @@ function updateSessionMeta(
   let firstLine: FirstLineProviderResult = "current";
   if (patch.provider !== undefined) {
     try {
-      firstLine = patchFirstLineProviderInPlace(path, expectedId, patch.provider);
-    } catch {
+      firstLine = patchFirstLineProviderInPlace(path, expectedId, patch.provider, validatedIdentity);
+    } catch (error) {
+      if (error instanceof CodexHistoryIntegrityError) throw error;
       firstLine = "unsafe";
     }
     if (options.requireDurableProvider && firstLine === "unsafe") {
@@ -1151,6 +1278,8 @@ function relabelAllRoutedHistoryToOpenai(db: Database): { rows: number; files: n
     `)
     .all();

+  if (rows.length > 0) assertLegacyHistoryStore(db);
+  for (const row of rows) assertLegacyHistoryWritable(row.rollout_path);
   let files = 0;
   for (const row of rows) {
     try {
@@ -1158,8 +1287,8 @@ function relabelAllRoutedHistoryToOpenai(db: Database): { rows: number; files: n
         provider: "openai",
         source: row.source === "exec" ? "cli" : undefined,
       }).changed) files++;
-    } catch {
-      /* explicit legacy recovery still relabels the DB when an old rollout is missing */
+    } catch (error) {
+      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
     }
   }

@@ -1302,6 +1431,8 @@ function syncCodexHistoryProviderUnsafe(provider: CodexHistoryProvider, stateDbP
       `)
       .all();

+    if (openaiRows.length + execRows.length > 0) assertLegacyHistoryStore(db);
+    for (const row of [...openaiRows, ...execRows]) assertLegacyHistoryWritable(row.rollout_path);
     const manifest = readBackup(backupPath, stateDbPath).manifest;
     for (const row of [...openaiRows, ...execRows]) rememberOriginal(manifest, row);
     writeBackup(backupPath, manifest, stateDbPath);
@@ -1367,15 +1498,15 @@ function syncCodexHistoryProviderUnsafe(provider: CodexHistoryProvider, stateDbP
       for (const row of openaiRows) {
         try {
           if (updateSessionMeta(row.rollout_path, row.id, { provider: "opencodex" }).changed) files++;
-        } catch {
-          /* keep DB migration moving; the manifest still carries exact original metadata */
+        } catch (error) {
+          if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
         }
       }
       for (const row of execRows) {
         try {
           if (updateSessionMeta(row.rollout_path, row.id, { source: "cli" }).changed) files++;
-        } catch {
-          /* keep DB migration moving; the manifest still carries exact original metadata */
+        } catch (error) {
+          if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
         }
       }
     });
@@ -1409,9 +1540,12 @@ function restoreCodexHistoryProvider(stateDbPath: string, backupPath: string): C
   const manifest = backup.manifest;
   const entries = Object.values(manifest.entries);

+  for (const entry of entries) assertLegacyHistoryWritable(entry.rolloutPath);
+
   const db = openStateDb(stateDbPath);
   try {
     if (entries.length === 0) return { rows: 0, files: 0 };
+    assertLegacyHistoryStore(db);

     // Validate the whole manifest-to-database target set before touching a rollout. Only the
     // OpenCodex post-image (or an already-restored target from an interrupted retry) is owned by
@@ -1547,6 +1681,7 @@ function restoreCodexHistoryProvider(stateDbPath: string, backupPath: string): C

 export function restoreLegacyOpenaiHistory(stateDbPath = resolveCodexStateDbPath()): CodexHistorySyncResult {
   if (!existsSync(stateDbPath)) return { rows: 0, files: 0 };
+  try {
   const retried = withHistoryRetryResult(() => {
     const db = openStateDb(stateDbPath);
     try {
@@ -1556,6 +1691,10 @@ export function restoreLegacyOpenaiHistory(stateDbPath = resolveCodexStateDbPath
     }
   });
   return retried.ok ? retried.value : { rows: 0, files: 0, failed: true, failureReason: retried.reason };
+  } catch (error) {
+    if (error instanceof CodexHistoryIntegrityError) return integrityFailureResult(error);
+    throw error;
+  }
 }

 /**
diff --git a/src/codex/inject.ts b/src/codex/inject.ts
index 12ae087ac4..65661963fb 100644
--- a/src/codex/inject.ts
+++ b/src/codex/inject.ts
@@ -46,7 +46,7 @@ import {
 } from "./journal";
 import { withCatalogWriteSerialization } from "./catalog-write-serialization";
 import { restoreCodexCatalogWithPermit } from "./catalog/sync";
-import { syncCodexHistoryProvider, type CodexHistoryFailureReason } from "./history-provider";
+import { preflightCodexHistoryInjection, syncCodexHistoryProvider, type CodexHistoryFailureReason } from "./history-provider";
 import {
   describeHistoryJobFailure,
   deriveCodexHistoryOperation,
@@ -75,6 +75,7 @@ import {
   parseTomlString,
   readRootTomlString,
   resolveCodexConfigPath,
+  resolveCodexStateDbPath,
   tomlString,
 } from "./paths";
 import { resolveEffectiveProjectModelProvider } from "./project-config-warnings";
@@ -899,10 +900,37 @@ export interface CodexInjectResult {
   nativeSubagentDefaultsWarning?: string;
 }

+class CodexHistoryPreflightRefusal extends Error {}
+class CodexRestoreRefusal extends Error {}
+let historyArtifactStageForTests: ((stage: string) => void) | undefined;
+export function setHistoryArtifactStageForTests(hook: typeof historyArtifactStageForTests): void {
+  historyArtifactStageForTests = hook;
+}
+let beforeRestoreConfigForTests: ((kind: string) => void) | undefined;
+export function setBeforeRestoreConfigForTests(hook: typeof beforeRestoreConfigForTests): void {
+  beforeRestoreConfigForTests = hook;
+}
+let beforeHistoryArtifactCommitForTests: ((kind: string) => void) | undefined;
+export function setBeforeHistoryArtifactCommitForTests(hook: typeof beforeHistoryArtifactCommitForTests): void {
+  beforeHistoryArtifactCommitForTests = hook;
+}
+
 export async function injectCodexConfig(
   port: number,
   config?: OcxConfig,
   options: InjectCodexOptions = {},
+): Promise<CodexInjectResult> {
+  try { return await injectCodexConfigImpl(port, config, options); }
+  catch (error) {
+    if (error instanceof CodexHistoryPreflightRefusal) return { success: false, message: `Codex config injection refused: ${error.message}. Existing configuration and history were preserved.` };
+    throw error;
+  }
+}
+
+async function injectCodexConfigImpl(
+  port: number,
+  config?: OcxConfig,
+  options: InjectCodexOptions = {},
 ): Promise<CodexInjectResult> {
   // Point Codex at the unauthenticated loopback listener when it is enabled (#1102).
   //
@@ -929,6 +957,10 @@ export async function injectCodexConfig(
   }

   const rawContent = readFileSync(CODEX_CONFIG_PATH, "utf-8");
+  const preflightTableMode = usesProviderTable(routingTarget);
+  const compactionOnly = routingTarget.clientCompaction === true
+    && routingTarget.desktopAuthless !== true
+    && routingTarget.requiresAdmissionToken !== true;
   const activeProvider = externalCodexModelProvider(rawContent);
   if (activeProvider) {
     // A launcher may have journaled before the provider manager took ownership. Never let shutdown
@@ -1138,6 +1170,29 @@ export async function injectCodexConfig(
   );
   content = applyEol(content, eol);

+  // Resolve storage from the normalized candidate. Owned duplicate catalog keys
+  // are repairable above and must not make this read-only preflight throw.
+  const historyPreflight = (): string | null => {
+    try {
+      return preflightCodexHistoryInjection(
+        preflightTableMode,
+        config?.syncResumeHistory !== false && !compactionOnly,
+        resolveCodexStateDbPath({ readConfig: () => content }),
+      );
+    } catch {
+      return "history_injection_preflight_unavailable";
+    }
+  };
+  const historyPreflightError = historyPreflight();
+  if (historyPreflightError) {
+    return {
+      success: false,
+      message: `Codex config injection refused: ${historyPreflightError}. `
+        + "Existing provider definitions and conversation files were preserved. "
+        + "Paginated history requires native-writer coordination; do not run legacy recovery or retry this transition blindly.",
+    };
+  }
+
   /*
    * The witness, built from the FINAL bytes. Everything it hashes is either the
    * output about to be written or evidence that can be re-read under the lock;
@@ -1228,6 +1283,12 @@ export async function injectCodexConfig(
   }

   const applyNativeArtifacts = (): void => {
+    beforeHistoryArtifactCommitForTests?.(eligibility.kind);
+    const historyError = historyPreflight();
+    if (historyError) throw new CodexHistoryPreflightRefusal(historyError);
+    const preImages = captureCodexPreImages();
+    try {
+    historyArtifactStageForTests?.("after-preflight");
     writeJournal({
       currentStateIsNative: journalBaselineIsNative(),
       configContent: baselineContent,
@@ -1237,6 +1298,7 @@ export async function injectCodexConfig(
     // must not gain the new injection's hash and later overwrite preserved user edits.
     if (hasUnverifiedJournalBaseline(baselineContent, readCurrentProfile())) throw new Error(unverifiedJournalMessage);
     atomicWriteFile(CODEX_CONFIG_PATH, content);
+    historyArtifactStageForTests?.("after-config");
     atomicWriteFile(CODEX_PROFILE_PATH, profileContent);
     markJournalInjectedState(content, profileContent, {
       // A root override is ours whenever we wrote one and no user-owned value won. That is
@@ -1257,6 +1319,16 @@ export async function injectCodexConfig(
       // already points at that path and therefore needs no textual rewrite.
       injectedCatalogPath: catalogPath,
     });
+    historyArtifactStageForTests?.("after-artifacts");
+    // Detect migration throughout the artifact transaction, not just at entry.
+    // This is compensation, not a native-writer lock or permission to append ordinals.
+    const finalHistoryError = historyPreflight();
+    if (finalHistoryError) throw new CodexHistoryPreflightRefusal(finalHistoryError);
+    } catch (error) {
+      const compensated = restoreCodexPreImages(preImages);
+      if (!compensated.complete) throw new CodexPartialWriteError(compensated.unrestored);
+      throw error;
+    }
   };

   /*
@@ -1638,6 +1710,8 @@ function hasOpencodexRouting(content: string): boolean {
 export function removeCodexConfig(
   options: { preserveProfile?: boolean } = {},
 ): { success: boolean; message: string } {
+  const historyError = preflightCodexHistoryInjection(false, false);
+  if (historyError) return { success: false, message: `Codex configuration preserved: ${historyError}. Native writer coordination is required.` };
   if (!existsSync(CODEX_CONFIG_PATH)) {
     if (!options.preserveProfile && existsSync(CODEX_PROFILE_PATH))
       unlinkSync(CODEX_PROFILE_PATH);
@@ -1838,8 +1912,21 @@ export function skippedRestoreEnvelope(success: boolean, message: string): Codex
 }

 /** The config/profile half of a native restore, reported as one artifact. */
-function restoreCodexConfigInline(): CodexRestoreConfigResult {
+function restoreCodexConfigInline(kind = "sync"): CodexRestoreConfigResult {
+  const preImages = captureCodexPreImages();
+  const result = restoreCodexConfigInlineImpl(kind);
+  if (result.state === "failed") {
+    const compensated = restoreCodexPreImages(preImages);
+    if (!compensated.complete) throw new CodexPartialWriteError(compensated.unrestored);
+  }
+  return result;
+}
+
+function restoreCodexConfigInlineImpl(kind: string): CodexRestoreConfigResult {
   try {
+    beforeRestoreConfigForTests?.(kind);
+    const historyError = preflightCodexHistoryInjection(false, false);
+    if (historyError) return { state: "failed", changed: false, action: "failed", message: `Codex configuration and journal preserved: ${historyError}.` };
     const journal = restoreJournalState();
     if (journal.unverified) {
       return {
@@ -1912,6 +1999,17 @@ function restoreCodexCatalogArtifact(
  */
 export async function restoreNativeCodexAsync(
   options: { revalidateDesiredState?: boolean } = {},
+): Promise<CodexNativeRestoreResult> {
+  try {
+    return await restoreNativeCodexAsyncImpl(options);
+  } catch (error) {
+    if (!(error instanceof CodexRestoreRefusal)) throw error;
+    return skippedRestoreEnvelope(false, error.message);
+  }
+}
+
+async function restoreNativeCodexAsyncImpl(
+  options: { revalidateDesiredState?: boolean },
 ): Promise<CodexNativeRestoreResult> {
   const activeProvider = currentExternalCodexModelProvider();
   if (activeProvider) {
@@ -1929,8 +2027,12 @@ export async function restoreNativeCodexAsync(
   if (options.revalidateDesiredState) {
     const ownership = inspectNativeCodexOwnership();
     if (ownership.ownership === "foreign") return foreignOwnershipRestoreRefusal(ownership.reason);
+    if (shouldSyncCodexOnStart(loadConfig())) return desiredEnabledRestoreSkip();
   }

+  const historyError = preflightCodexHistoryInjection(false, false);
+  if (historyError) return skippedRestoreEnvelope(false, `Native restore refused: ${historyError}. Config, catalog, history and provenance were preserved.`);
+
   const eligibility = codexWriteCoordinationEligibility({
     coordinatorPath: () =>
       resolveCodexCoordinatorDatabasePath(resolveEffectiveUserIdentity(), getCodexHome()),
@@ -1980,7 +2082,9 @@ export async function restoreNativeCodexAsync(
         const preImages = captureCodexPreImages();
         let restored: CodexRestoreConfigResult;
         try {
-          restored = restoreCodexConfigInline();
+          restored = restoreCodexConfigInline(eligibility.kind);
+          // Throw inside N so the published remove transition rolls back too.
+          if (restored.state === "failed") throw new CodexRestoreRefusal(restored.message);
         } catch (error) {
           const compensated = restoreCodexPreImages(preImages);
           if (!compensated.complete) throw new CodexPartialWriteError(compensated.unrestored);
@@ -2021,9 +2125,10 @@ export async function restoreNativeCodexAsync(
     if (options.revalidateDesiredState && shouldSyncCodexOnStart(loadConfig())) {
       return desiredEnabledRestoreSkip();
     }
-    config = restoreCodexConfigInline();
+    config = restoreCodexConfigInline(eligibility.kind);
   }

+  if (config.state === "failed") return skippedRestoreEnvelope(false, config.message);
   const catalog = restoreCodexCatalogArtifact(options.revalidateDesiredState === true, journaledCatalogPath);
   const outcome = await runCodexHistoryJob({
     ...resolveCodexHistoryJobTarget(),
@@ -2055,8 +2160,7 @@ export async function restoreNativeCodexAsync(
   const base = catalog.removed > 0
     ? `${config.message} Catalog restored to ${catalog.kept} native model(s) (dropped ${catalog.removed} proxy-routed).`
     : config.message;
-  const success = config.state !== "failed"
-    && catalog.state !== "failed"
+  const success = catalog.state !== "failed"
     && history.state !== "failed";
   return {
     success,
@@ -2074,11 +2178,14 @@ export function restoreNativeCodex(options: { skipHistory?: boolean; revalidateD
   if (options.revalidateDesiredState && shouldSyncCodexOnStart(loadConfig())) {
     return desiredEnabledRestoreSkip();
   }
+  const historyError = preflightCodexHistoryInjection(false, false);
+  if (historyError) return skippedRestoreEnvelope(false, `Native restore refused: ${historyError}. Config, catalog, history and provenance were preserved.`);
   // Captured before the config half: a successful journal restore DELETES the journal, and
   // restoring the config can drop `model_catalog_json`. Either one would hide the routed
   // catalog we actually wrote (#1798).
   const journaledCatalogPath = journaledInjectedCatalogPath();
   const config = restoreCodexConfigInline();
+  if (config.state === "failed") return skippedRestoreEnvelope(false, config.message);
   const catalog = restoreCodexCatalogArtifact(options.revalidateDesiredState === true, journaledCatalogPath);
   // Design B (loopback) steady state: threads are already tagged openai, so prove the
   // no-op with a readonly probe instead of write-opening a DB the Codex app may hold
@@ -2115,7 +2222,7 @@ export function restoreNativeCodex(options: { skipHistory?: boolean; revalidateD
     ? `${config.message} Catalog restored to ${catalog.kept} native model(s) (dropped ${catalog.removed} proxy-routed).`
     : config.message;
   return {
-    success: config.state !== "failed" && catalog.state !== "failed" && history.state !== "failed",
+    success: catalog.state !== "failed" && history.state !== "failed",
     message,
     artifacts: { config, catalog, history },
   };
diff --git a/structure/catalog.md b/structure/catalog.md
index 9a0ca08296..8600070638 100644
--- a/structure/catalog.md
+++ b/structure/catalog.md
@@ -261,3 +261,11 @@ provider wire mapping; unpinned native requests retain their existing pass-throu
 > Decision record: [ADR-0025](decisions/ADR-0025-ultra-reasoning-level.md)

 > Decision record: [ADR-0026](decisions/ADR-0026-ultra-reasoning-level.md)
+
+## Paginated history writer boundary
+
+Catalog convergence can include a provider-history transition. Paginated history refusal is an explicit incomplete transition, not successful migration; see [Codex Home](codex-home.md#paginated-history-writer-boundary).
+
+Injection preflights affected history using the normalized config candidate before writing config/profile/journal, then checks again after the complete artifact write. Detected migration restores all three preimages before returning a structured refusal, including on legacy-uncoordinated homes. A failed config restore stops catalog/history work; coordinated restore rolls back its published remove transition. Legacy first-line provider patches are bound to the validated file identity before and after writing. These compensating checks do not provide a native-writer lock or authorize external ordinal allocation.
+
+The legacy external writer is now refused for affected rows in any store whose schema includes history_mode, even while their row mode is still legacy. This deliberately sacrifices automatic relabeling on migration-capable stores rather than racing native conversion. Synchronous/asynchronous restore, inline journal restore, and direct config removal preserve all artifacts on the same refusal.
diff --git a/structure/codex-home.md b/structure/codex-home.md
index 9b5e1ded4a..e3389bdf33 100644
--- a/structure/codex-home.md
+++ b/structure/codex-home.md
@@ -223,3 +223,11 @@ a deliberate user choice:
 - Project-level Codex config that bypasses managed routing
   (`src/codex/project-config-warnings.ts`), surfaced by `ocx doctor` as a warning rather than an
   override.
+
+## Paginated history writer boundary
+
+`src/codex/history-provider.ts` rejects provider-history changes with `history_paginated_requires_native_writer` when a target begins with an ordinal-bearing record or declares `history_mode=paginated`. Apply, manifest-backed restore, and explicit legacy recovery preflight all selected targets before changing database rows or manifests. The append boundary checks again. Codex owns ordinal allocation and the live projection cursor; reading the last ordinal and appending N+1 is not safe concurrent coordination. Legacy unnumbered rollouts retain their existing behavior. This guard prevents the observed stable-format corruption; it does not implement native-writer integration or guarantee a concurrent legacy-to-paginated conversion is excluded.
+
+Injection preflights affected history using the normalized config candidate before writing config/profile/journal, then checks again after the complete artifact write. Detected migration restores all three preimages before returning a structured refusal, including on legacy-uncoordinated homes. A failed config restore stops catalog/history work; coordinated restore rolls back its published remove transition. Legacy first-line provider patches are bound to the validated file identity before and after writing. These compensating checks do not provide a native-writer lock or authorize external ordinal allocation.
+
+The legacy external writer is now refused for affected rows in any store whose schema includes history_mode, even while their row mode is still legacy. This deliberately sacrifices automatic relabeling on migration-capable stores rather than racing native conversion. Synchronous/asynchronous restore, inline journal restore, and direct config removal preserve all artifacts on the same refusal.
diff --git a/structure/config.md b/structure/config.md
index 224c5a350d..d8384e82b2 100644
--- a/structure/config.md
+++ b/structure/config.md
@@ -192,3 +192,11 @@ the residual directory for manual review; there is no recursive-delete fallback.
 ## Remote client key files

 Client connection metadata stores a stable `apiKeyId` and a non-secret rotation `pendingOperation`. The current data secret remains only in `service-api-token`; a bounded rotation temporarily keeps the old secret in owner-only `service-api-token.prev`. Commit or recovery clears the marker before orphan cleanup. `ocx disconnect` is local-only and leaves remote revocation to the hub's **Integrations → API Keys** page. Hub and local usage stores are not mirrored.
+
+## Paginated history writer boundary
+
+Authless routing cannot relabel paginated history through the legacy file writer. A refused history transition must be reported; provider-definition retention during that refusal remains an integration concern. See [Codex Home](codex-home.md#paginated-history-writer-boundary).
+
+Injection preflights affected history using the normalized config candidate before writing config/profile/journal, then checks again after the complete artifact write. Detected migration restores all three preimages before returning a structured refusal, including on legacy-uncoordinated homes. A failed config restore stops catalog/history work; coordinated restore rolls back its published remove transition. Legacy first-line provider patches are bound to the validated file identity before and after writing. These compensating checks do not provide a native-writer lock or authorize external ordinal allocation.
+
+The legacy external writer is now refused for affected rows in any store whose schema includes history_mode, even while their row mode is still legacy. This deliberately sacrifices automatic relabeling on migration-capable stores rather than racing native conversion. Synchronous/asynchronous restore, inline journal restore, and direct config removal preserve all artifacts on the same refusal.
diff --git a/structure/gui-and-management-api.md b/structure/gui-and-management-api.md
index c6b35fbad8..9d2ca44805 100644
--- a/structure/gui-and-management-api.md
+++ b/structure/gui-and-management-api.md
@@ -504,3 +504,11 @@ converge the Codex catalog once and return its disposition. The Models UI owns a
 picker data resource so failure cannot erase the ordinary model inventory; Apply publishes through
 the resource's generation fence, and Most used reads usage only on explicit Apply. Stored mode
 survives availability drift, while complete/native custom orders await explicit replacement.
+
+## Paginated history writer boundary
+
+Settings convergence must surface paginated-history refusal rather than claim history was migrated. See [Codex Home](codex-home.md#paginated-history-writer-boundary).
+
+Injection preflights affected history using the normalized config candidate before writing config/profile/journal, then checks again after the complete artifact write. Detected migration restores all three preimages before returning a structured refusal, including on legacy-uncoordinated homes. A failed config restore stops catalog/history work; coordinated restore rolls back its published remove transition. Legacy first-line provider patches are bound to the validated file identity before and after writing. These compensating checks do not provide a native-writer lock or authorize external ordinal allocation.
+
+The legacy external writer is now refused for affected rows in any store whose schema includes history_mode, even while their row mode is still legacy. This deliberately sacrifices automatic relabeling on migration-capable stores rather than racing native conversion. Synchronous/asynchronous restore, inline journal restore, and direct config removal preserve all artifacts on the same refusal.
diff --git a/structure/ops/docs-and-release.md b/structure/ops/docs-and-release.md
index 6d7988af78..bcf89f8933 100644
--- a/structure/ops/docs-and-release.md
+++ b/structure/ops/docs-and-release.md
@@ -300,3 +300,11 @@ This keeps release runs short and makes release a deployment of a verified commi
 ## Remote Hub locale and release gate

 The Remote Hub guide and affected CLI, server-config, management-API, and dashboard references have eight sources: root English plus `fr`, `ko`, `zh-cn`, `zh-tw`, `ru`, `ja`, and `tr`. English is canonical; commands, defaults, endpoint auth, and warnings remain exact in translations. A release requires the remote-only focused/full gates, privacy scan, GUI/docs builds, protocol compatibility receipts, and the MAINTAINERS security review for the exact head.
+
+## Paginated history writer boundary
+
+History-provider regression coverage includes numbered rollout apply/restore refusal without changing source bytes or provenance. See [Codex Home](../codex-home.md#paginated-history-writer-boundary).
+
+Injection preflights affected history using the normalized config candidate before writing config/profile/journal, then checks again after the complete artifact write. Detected migration restores all three preimages before returning a structured refusal, including on legacy-uncoordinated homes. A failed config restore stops catalog/history work; coordinated restore rolls back its published remove transition. Legacy first-line provider patches are bound to the validated file identity before and after writing. These compensating checks do not provide a native-writer lock or authorize external ordinal allocation.
+
+The legacy external writer is now refused for affected rows in any store whose schema includes history_mode, even while their row mode is still legacy. This deliberately sacrifices automatic relabeling on migration-capable stores rather than racing native conversion. Synchronous/asynchronous restore, inline journal restore, and direct config removal preserve all artifacts on the same refusal.
diff --git a/structure/providers/openai-tiers.md b/structure/providers/openai-tiers.md
index 9f86870bae..2e13055dea 100644
--- a/structure/providers/openai-tiers.md
+++ b/structure/providers/openai-tiers.md
@@ -368,3 +368,11 @@ model settings, and noncanonical `openai` rows never receive that recovery path.
 `GET /api/codex-auth/accounts?refresh=1` treats missing main credentials, HTTP 401, and allowlisted
 terminal 403 codes as `needsReauth`; generic permission failures remain non-terminal, and a
 successful main usage refresh clears the runtime mark.
+
+## Paginated history writer boundary
+
+Provider account selection does not authorize relabeling paginated Codex records; the [history writer boundary](../codex-home.md#paginated-history-writer-boundary) applies independently of account mode.
+
+Injection preflights affected history using the normalized config candidate before writing config/profile/journal, then checks again after the complete artifact write. Detected migration restores all three preimages before returning a structured refusal, including on legacy-uncoordinated homes. A failed config restore stops catalog/history work; coordinated restore rolls back its published remove transition. Legacy first-line provider patches are bound to the validated file identity before and after writing. These compensating checks do not provide a native-writer lock or authorize external ordinal allocation.
+
+The legacy external writer is now refused for affected rows in any store whose schema includes history_mode, even while their row mode is still legacy. This deliberately sacrifices automatic relabeling on migration-capable stores rather than racing native conversion. Synchronous/asynchronous restore, inline journal restore, and direct config removal preserve all artifacts on the same refusal.
diff --git a/structure/runtime.md b/structure/runtime.md
index 3099c13bfd..edcb0c7712 100644
--- a/structure/runtime.md
+++ b/structure/runtime.md
@@ -185,3 +185,11 @@ not an authentication or entitlement decision.
 ## Remote Hub hardening ownership

 `src/remote/protocol.ts` owns pure interval/feature negotiation. `src/remote/hub-state.ts` owns the `GET|HEAD /v1/hub-state` contract, its caps, and the parser both sides share. `src/client/hub-client.ts` owns bounded, schema-validated remote catalog consumption, hub-state reads, and key-id probes; `src/client/hub-state.ts` owns the resolution and the owner-stamped 0600 cache, and a failed read reports "unavailable" rather than degrading to the client's own local provider and login state. `src/client/hub-relay.ts` is a fixed-authority management relay with URL, header, body, redirect, and stream bounds. The public data listener remains the direct client→hub path; the loopback management ingress never serves data-plane routes.
+
+## Paginated history writer boundary
+
+Provider-history transitions refuse paginated rollout writes before changing history state; see [Codex Home](codex-home.md#paginated-history-writer-boundary).
+
+Injection preflights affected history using the normalized config candidate before writing config/profile/journal, then checks again after the complete artifact write. Detected migration restores all three preimages before returning a structured refusal, including on legacy-uncoordinated homes. A failed config restore stops catalog/history work; coordinated restore rolls back its published remove transition. Legacy first-line provider patches are bound to the validated file identity before and after writing. These compensating checks do not provide a native-writer lock or authorize external ordinal allocation.
+
+The legacy external writer is now refused for affected rows in any store whose schema includes history_mode, even while their row mode is still legacy. This deliberately sacrifices automatic relabeling on migration-capable stores rather than racing native conversion. Synchronous/asynchronous restore, inline journal restore, and direct config removal preserve all artifacts on the same refusal.
diff --git a/structure/subagents.md b/structure/subagents.md
index a3513a726a..8b55aa1f03 100644
--- a/structure/subagents.md
+++ b/structure/subagents.md
@@ -195,3 +195,11 @@ Claude ModelInfo ordering receives optional `{ modelPickerOrder, featured }` aft
 It orders routed output groups after alias deduplication, preserving the collision winner and
 base/1M/Fast siblings. Native groups and explicit Desktop profile ownership are unchanged.
 Native Codex advertisements still follow display priority; private guidance ranks do not freeze them.
+
+## Paginated history writer boundary
+
+History metadata for parent or child threads follows the same [paginated writer boundary](codex-home.md#paginated-history-writer-boundary); a child source does not authorize external ordinal allocation.
+
+Injection preflights affected history using the normalized config candidate before writing config/profile/journal, then checks again after the complete artifact write. Detected migration restores all three preimages before returning a structured refusal, including on legacy-uncoordinated homes. A failed config restore stops catalog/history work; coordinated restore rolls back its published remove transition. Legacy first-line provider patches are bound to the validated file identity before and after writing. These compensating checks do not provide a native-writer lock or authorize external ordinal allocation.
+
+The legacy external writer is now refused for affected rows in any store whose schema includes history_mode, even while their row mode is still legacy. This deliberately sacrifices automatic relabeling on migration-capable stores rather than racing native conversion. Synchronous/asynchronous restore, inline journal restore, and direct config removal preserve all artifacts on the same refusal.
diff --git a/tests/codex-integration/codex-history-provider.test.ts b/tests/codex-integration/codex-history-provider.test.ts
index fbc97238de..972245846f 100644
--- a/tests/codex-integration/codex-history-provider.test.ts
+++ b/tests/codex-integration/codex-history-provider.test.ts
@@ -1,10 +1,11 @@
-import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
+import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
 import { tmpdir } from "node:os";
 import { join } from "node:path";
 import { Database } from "bun:sqlite";
 import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
 import { classifyRecoverableHistoryError, countPendingOpencodexHistory, historyBackupPathFor, isRecoverableHistoryError, migrateHistoryToOpenai, restoreLegacyOpenaiHistory, restoredUserEventFor, setAfterNoopPendingCountForTests, setAfterStrictHistoryRolloutAppendForTests, setBeforeHistoryApplyTransactionForTests, setBeforeHistoryBackupConsumeForTests, setBeforeStrictHistoryRolloutAppendForTests, setHistoryDbBusyTimeoutForTests, snapshotCodexHistoryNoop, syncCodexHistoryProvider, withHistoryRetry } from "../../src/codex/history-provider";
 import { INVALID_HISTORY_BACKUP_FIXTURES, validHistoryBackupFixture } from "../helpers/codex-history-manifest-fixtures";
+import { preflightCodexHistoryInjection, setHistoryAppendHooksForTests } from "../../src/codex/history-provider";

 // Windows CI: a transient file lock can consume the full production 5s busy timeout, tripping
 // bun's 5s default per-test timeout by itself. Fail fast into withHistoryRetry instead.
@@ -15,6 +16,7 @@ setDefaultTimeout(30_000);

 const noopSnapshotArtifacts = new Set<string>();
 afterEach(() => {
+  setHistoryAppendHooksForTests(undefined);
   setBeforeHistoryBackupConsumeForTests(undefined);
   setBeforeStrictHistoryRolloutAppendForTests(undefined);
   setAfterStrictHistoryRolloutAppendForTests(undefined);
@@ -101,6 +103,135 @@ function makeFixture({ includeExec = false, includeLegacy = false } = {}) {
 }

 describe("Codex history provider sync", () => {
+  test.each(["{broken", "null", "[]", "42", '"text"'])("invalid first record %s is a structured integrity failure", (first) => {
+    const fixture = makeFixture();
+    noopSnapshotArtifacts.add(join(fixture.dbPath,".."));
+    writeFileSync(fixture.rollout, first + "\n");
+    expect(syncCodexHistoryProvider("opencodex",fixture.dbPath,fixture.backupPath)).toMatchObject({failed:true,rows:0,files:0,integrityCode:"history_rollout_record_invalid"});
+    const db = new Database(fixture.dbPath);
+    db.run("UPDATE threads SET model_provider='opencodex'");
+    db.close();
+    expect(restoreLegacyOpenaiHistory(fixture.dbPath)).toMatchObject({failed:true,rows:0,files:0,integrityCode:"history_rollout_record_invalid"});
+    expect(readFileSync(fixture.rollout,"utf8")).toBe(first+"\n");
+  });
+
+  test.each(["beforeWrite", "afterWrite"] as const)("descriptor-bound append refuses path replacement %s", (stage) => {
+    const fixture = makeFixture();
+    noopSnapshotArtifacts.add(join(fixture.dbPath,".."));
+    const replacement=JSON.stringify({ordinal:0,type:"session_meta",payload:{id:"thread-1",history_mode:"paginated",model_provider:"openai"}})+"\n";
+    setHistoryAppendHooksForTests({[stage]:(path:string)=>{
+      if(path!==fixture.rollout)return;
+      renameSync(path,path+".old");
+      writeFileSync(path,replacement);
+    }});
+    expect(syncCodexHistoryProvider("opencodex",fixture.dbPath,fixture.backupPath)).toMatchObject({failed:true,rows:0,integrityCode:"history_rollout_identity_changed"});
+    expect(readFileSync(fixture.rollout,"utf8")).toBe(replacement);
+    const db=new Database(fixture.dbPath,{readonly:true});
+    expect(db.query("SELECT model_provider FROM threads WHERE id='thread-1'").get()).toEqual({model_provider:"openai"});
+    db.close();
+  });
+
+  for (const stage of ["beforeFirstLineOpen", "beforeFirstLineWrite", "afterFirstLineWrite"] as const) {
+    test.each([false, true])(`first-line identity guard preserves replacement (${stage}, strict=%s)`, (strict) => {
+      const fixture = makeFixture();
+      noopSnapshotArtifacts.add(join(fixture.dbPath, ".."));
+      // Leave enough first-line padding for forward provider replacement in place.
+      const raw = readFileSync(fixture.rollout, "utf8");
+      writeFileSync(fixture.rollout, raw.replace('"model_provider":"openai"', '"model_provider":"openai"                '));
+      if (strict) expect(syncCodexHistoryProvider("opencodex", fixture.dbPath, fixture.backupPath).rows).toBe(1);
+      const provider = strict ? "opencodex" : "openai";
+      const replacement = JSON.stringify({ordinal:0,type:"session_meta",payload:{id:"thread-1",history_mode:"paginated",model_provider:provider}}) + "\n";
+      let fired = false;
+      setHistoryAppendHooksForTests({[stage]:(path:string)=>{
+        if(path!==fixture.rollout || fired)return;
+        fired=true;
+        renameSync(path,path+".old");
+        writeFileSync(path,replacement);
+      }});
+      const result=syncCodexHistoryProvider(strict?"openai":"opencodex",fixture.dbPath,fixture.backupPath);
+      expect(fired).toBe(true);
+      expect(result).toMatchObject({failed:true,rows:0,integrityCode:strict?"history_backup_partial_restore":"history_rollout_identity_changed"});
+      expect(readFileSync(fixture.rollout,"utf8")).toBe(replacement);
+      const db=new Database(fixture.dbPath,{readonly:true});
+      expect(db.query("SELECT model_provider FROM threads WHERE id='thread-1'").get()).toEqual({model_provider:provider});
+      db.close();
+      if(strict) expect(existsSync(fixture.backupPath)).toBe(true);
+    });
+  }
+
+  test("late paginated conversion rolls back routing instead of swallowing integrity failure",()=>{
+    const fixture=makeFixture();
+    noopSnapshotArtifacts.add(join(fixture.dbPath,".."));
+    const replacement=JSON.stringify({ordinal:0,type:"session_meta",payload:{id:"thread-1",history_mode:"paginated",model_provider:"openai"}})+"\n";
+    setBeforeHistoryApplyTransactionForTests(()=>writeFileSync(fixture.rollout,replacement));
+    expect(syncCodexHistoryProvider("opencodex",fixture.dbPath,fixture.backupPath)).toMatchObject({failed:true,rows:0,integrityCode:"history_paginated_requires_native_writer"});
+    expect(readFileSync(fixture.rollout,"utf8")).toBe(replacement);
+    const db=new Database(fixture.dbPath,{readonly:true});
+    expect(db.query("SELECT model_provider FROM threads WHERE id='thread-1'").get()).toEqual({model_provider:"openai"});
+    db.close();
+  });
+  test("refuses legacy rows in a migration-capable store before external writes", () => {
+    const fixture = makeFixture();
+    noopSnapshotArtifacts.add(join(fixture.dbPath, ".."));
+    const before = readFileSync(fixture.rollout, "utf8");
+    const db = new Database(fixture.dbPath);
+    db.run("ALTER TABLE threads ADD COLUMN history_mode TEXT DEFAULT 'legacy'");
+    db.close();
+    expect(syncCodexHistoryProvider("opencodex", fixture.dbPath, fixture.backupPath)).toMatchObject({failed:true,rows:0,files:0,integrityCode:"history_paginated_requires_native_writer"});
+    expect(readFileSync(fixture.rollout,"utf8")).toBe(before);
+    expect(existsSync(fixture.backupPath)).toBe(false);
+  });
+  test("injection preflight preserves provider definitions needed by paginated threads", () => {
+    const fixture = makeFixture({ includeLegacy: true });
+    noopSnapshotArtifacts.add(join(fixture.dbPath, ".."));
+    const db = new Database(fixture.dbPath);
+    db.run("ALTER TABLE threads ADD COLUMN history_mode TEXT DEFAULT 'legacy'");
+    db.run("UPDATE threads SET history_mode='paginated' WHERE id='thread-3'");
+    db.close();
+    expect(preflightCodexHistoryInjection(false, false, fixture.dbPath)).toBe("history_paginated_requires_native_writer");
+    expect(preflightCodexHistoryInjection(true, true, fixture.dbPath)).toBe("history_paginated_requires_native_writer");
+    expect(preflightCodexHistoryInjection(true, false, fixture.dbPath)).toBeNull();
+    expect(existsSync(fixture.backupPath)).toBe(false);
+  });
+
+  for (const marker of ["ordinal", "history_mode"] as const) {
+    test(`refuses paginated ${marker} before routing any row or writing a manifest`, () => {
+      const fixture = makeFixture();
+      noopSnapshotArtifacts.add(join(fixture.dbPath, ".."));
+      const records = readFileSync(fixture.rollout, "utf8").trim().split("\n").map(line => JSON.parse(line));
+      if (marker === "ordinal") records.forEach((record, ordinal) => { record.ordinal = ordinal; });
+      else records[0].payload.history_mode = "paginated";
+      const before = records.map(record => JSON.stringify(record)).join("\n") + "\n";
+      writeFileSync(fixture.rollout, before);
+      const result = syncCodexHistoryProvider("opencodex", fixture.dbPath, fixture.backupPath);
+      expect(result).toMatchObject({ rows: 0, files: 0, failed: true, integrityCode: "history_paginated_requires_native_writer" });
+      expect(readFileSync(fixture.rollout, "utf8")).toBe(before);
+      expect(existsSync(fixture.backupPath)).toBe(false);
+      const db = new Database(fixture.dbPath, { readonly: true });
+      expect(db.query("SELECT model_provider FROM threads WHERE id = 'thread-1'").get()).toEqual({ model_provider: "openai" });
+      db.close();
+    });
+  }
+
+  test("preserves a routed paginated rollout and its restore manifest", () => {
+    const fixture = makeFixture();
+    noopSnapshotArtifacts.add(join(fixture.dbPath, ".."));
+    expect(syncCodexHistoryProvider("opencodex", fixture.dbPath, fixture.backupPath).failed).toBeUndefined();
+    const records = readFileSync(fixture.rollout, "utf8").trim().split("\n").map(line => JSON.parse(line));
+    records.forEach((record, ordinal) => { record.ordinal = ordinal; });
+    const before = records.map(record => JSON.stringify(record)).join("\n") + "\n";
+    writeFileSync(fixture.rollout, before);
+    const manifest = readFileSync(fixture.backupPath, "utf8");
+    for (const result of [syncCodexHistoryProvider("openai", fixture.dbPath, fixture.backupPath), restoreLegacyOpenaiHistory(fixture.dbPath)]) {
+      expect(result).toMatchObject({ rows: 0, files: 0, failed: true, integrityCode: "history_paginated_requires_native_writer" });
+    }
+    expect(readFileSync(fixture.rollout, "utf8")).toBe(before);
+    expect(readFileSync(fixture.backupPath, "utf8")).toBe(manifest);
+    const db = new Database(fixture.dbPath, { readonly: true });
+    expect(db.query("SELECT model_provider FROM threads WHERE id = 'thread-1'").get()).toEqual({ model_provider: "opencodex" });
+    db.close();
+  });
+
   test("maps resumable Codex threads to opencodex via the latest session_meta", () => {
     const { dbPath, backupPath, rollout } = makeFixture();

diff --git a/tests/codex-integration/codex-inject-integration.test.ts b/tests/codex-integration/codex-inject-integration.test.ts
index 57e83650f1..0b30d78703 100644
--- a/tests/codex-integration/codex-inject-integration.test.ts
+++ b/tests/codex-integration/codex-inject-integration.test.ts
@@ -34,10 +34,10 @@ function runInject(codexHome: string, ocxHome: string, configJson = "{}"): { std
   return { stdout: result.stdout?.trim() ?? "", status: result.status ?? 1 };
 }

-function runRestore(codexHome: string, ocxHome: string): { stdout: string; status: number } {
+function runRestore(codexHome: string, ocxHome: string, asyncRestore = false): { stdout: string; status: number } {
   const script = `
-    const { restoreNativeCodex } = require("./src/codex/inject");
-    console.log(JSON.stringify(restoreNativeCodex()));
+    const { restoreNativeCodex, restoreNativeCodexAsync } = require("./src/codex/inject");
+    console.log(JSON.stringify(${asyncRestore ? "await restoreNativeCodexAsync()" : "restoreNativeCodex()"}));
   `;
   const result = spawnSync(process.execPath, ["--eval", script], {
     cwd: repoRoot,
@@ -68,6 +68,124 @@ describe("injectCodexConfig integration (Design B)", () => {
     removeTreeWithRetry(ocxHome);
   });

+  for (const stage of ["before-preflight", "after-preflight", "after-config", "after-artifacts"]) {
+  test.each([false,true])(`commit-boundary history refusal returns a result after rollback (${stage}, legacy=%s)`,(legacy)=>{
+    const original=legacy ? DESIGN_B_BLOCK+"\n" : 'model="test"\n';
+    writeFileSync(join(codexHome,"config.toml"),original);
+    if(legacy) writeFileSync(join(codexHome,"opencodex.config.toml"),"[invalid profile\n");
+    const script=`
+      const {Database}=require("bun:sqlite");
+      const {join}=require("node:path");
+      const {injectCodexConfig,setBeforeHistoryArtifactCommitForTests,setHistoryArtifactStageForTests}=require("./src/codex/inject");
+      let kind;
+      const migrate=()=>{
+        const db=new Database(join(process.env.CODEX_HOME,"state_5.sqlite"));
+        db.run("CREATE TABLE threads (rollout_path TEXT, model_provider TEXT, history_mode TEXT)");
+        db.run("INSERT INTO threads VALUES ('fixture','opencodex','paginated')");
+        db.close();
+      };
+      setBeforeHistoryArtifactCommitForTests(value=>{
+        kind=value;
+        if (${JSON.stringify(stage)} === "before-preflight") migrate();
+      });
+      setHistoryArtifactStageForTests(value=>{if(value===${JSON.stringify(stage)})migrate();});
+      const result=await injectCodexConfig(10100,{});
+      console.log(JSON.stringify({kind,result}));
+    `;
+    const child=spawnSync(process.execPath,["--eval",script],{cwd:repoRoot,env:{...process.env,CODEX_HOME:codexHome,OPENCODEX_HOME:ocxHome},encoding:"utf8",timeout:SPAWN_BUDGET_MS-5000});
+    expect(child.status).toBe(0);
+    const value=JSON.parse(child.stdout);
+    expect(value.kind).toBe(legacy?"legacy-uncoordinated":"coordinated");
+    expect(value.result).toMatchObject({success:false});
+    expect(value.result.message).toContain("history_paginated_requires_native_writer");
+    expect(readFileSync(join(codexHome,"config.toml"),"utf8")).toBe(original);
+    expect(existsSync(join(codexHome,"opencodex-journal.json"))).toBe(false);
+    if(legacy) expect(readFileSync(join(codexHome,"opencodex.config.toml"),"utf8")).toBe("[invalid profile\n");
+    else expect(existsSync(join(codexHome,"opencodex.config.toml"))).toBe(false);
+  });
+  }
+
+  test.each(["sync", "legacy-uncoordinated", "coordinated"])("config restore failure aborts every later artifact (%s)", (kind) => {
+    const original = kind === "coordinated" ? 'model="test"\n' : DESIGN_B_BLOCK + "\n";
+    writeFileSync(join(codexHome, "config.toml"), original);
+    if (kind !== "coordinated") writeFileSync(join(codexHome, "opencodex.config.toml"), "[invalid profile\n");
+    const catalog = '{"models":[],"sentinel":"preserve"}\n';
+    writeFileSync(join(codexHome, "models_cache.json"), catalog);
+    const script = `
+      const {Database}=require("bun:sqlite");
+      const {join}=require("node:path");
+      const {restoreNativeCodex,restoreNativeCodexAsync,setBeforeRestoreConfigForTests}=require("./src/codex/inject");
+      const readState=${kind === "coordinated" ? 'require("./src/codex/transition-state").readCodexTransitionState' : "()=>null"};
+      const before=readState();
+      let observed;
+      setBeforeRestoreConfigForTests(value=>{
+        observed=value;
+        const db=new Database(join(process.env.CODEX_HOME,"state_5.sqlite"));
+        db.run("CREATE TABLE threads (rollout_path TEXT, model_provider TEXT, history_mode TEXT)");
+        db.run("INSERT INTO threads VALUES ('fixture','opencodex','paginated')");
+        db.close();
+      });
+      const result=${kind === "sync" ? "restoreNativeCodex()" : "await restoreNativeCodexAsync()"};
+      console.log(JSON.stringify({observed,result,before,after:readState()}));
+    `;
+    const child=spawnSync(process.execPath,["--eval",script],{cwd:repoRoot,env:{...process.env,CODEX_HOME:codexHome,OPENCODEX_HOME:ocxHome},encoding:"utf8",timeout:SPAWN_BUDGET_MS-5000});
+    expect(child.status).toBe(0);
+    const value=JSON.parse(child.stdout);
+    expect(value.observed).toBe(kind);
+    expect(value.result.success).toBe(false);
+    if(kind==="coordinated") {
+      // Never advance durable generation/tx state when config restoration fails.
+      expect(value.before.state).toMatchObject({nativeGeneration:0,currentTxId:null});
+      expect(value.after.state).toEqual(value.before.state);
+    }
+    for (const artifact of Object.values(value.result.artifacts)) {
+      expect(artifact).toMatchObject({state:"skipped",changed:false});
+    }
+    expect(readFileSync(join(codexHome,"config.toml"),"utf8")).toBe(original);
+    expect(readFileSync(join(codexHome,"models_cache.json"),"utf8")).toBe(catalog);
+    expect(existsSync(join(codexHome,"opencodex-journal.json"))).toBe(false);
+    if(kind!=="coordinated") expect(readFileSync(join(codexHome,"opencodex.config.toml"),"utf8")).toBe("[invalid profile\n");
+    else expect(existsSync(join(codexHome,"opencodex.config.toml"))).toBe(false);
+  });
+
+  test.each([false, true])("paginated history preserves config and profile before provider transition (authless=%s)", (authless) => {
+    const original = 'model_provider = "opencodex"\n[model_providers.opencodex]\nname="OpenCodex"\nbase_url="http://127.0.0.1:10100/v1"\nwire_api="responses"\n';
+    const configPath = join(codexHome, "config.toml");
+    const profilePath = join(codexHome, "opencodex.config.toml");
+    writeFileSync(configPath, original);
+    writeFileSync(profilePath, "# preserve profile\n");
+    const rollout = join(codexHome, "fixture.jsonl");
+    const bytes = JSON.stringify({ordinal:0,type:"session_meta",payload:{id:"fixture",history_mode:"paginated",model_provider:"opencodex"}}) + "\n";
+    writeFileSync(rollout, bytes);
+    const db = new Database(join(codexHome, "state_5.sqlite"));
+    db.run("CREATE TABLE threads (id TEXT, rollout_path TEXT, model_provider TEXT, history_mode TEXT)");
+    db.run("INSERT INTO threads VALUES ('fixture', ?, 'opencodex', 'paginated')", rollout);
+    db.close();
+    const result = runInject(codexHome, ocxHome, JSON.stringify({codexDesktopAuthless:authless}));
+    expect(result.status).toBe(0);
+    expect(JSON.parse(result.stdout)).toMatchObject({success:false});
+    expect(result.stdout).toContain("history_paginated_requires_native_writer");
+    expect(readFileSync(configPath,"utf8")).toBe(original);
+    expect(readFileSync(profilePath,"utf8")).toBe("# preserve profile\n");
+    expect(readFileSync(rollout,"utf8")).toBe(bytes);
+    expect(existsSync(join(codexHome,"opencodex-journal.json"))).toBe(false);
+    const restoreScript = `
+      const { restoreNativeCodex, restoreNativeCodexAsync, removeCodexConfig } = require("./src/codex/inject");
+      const results = [restoreNativeCodex(), await restoreNativeCodexAsync(), removeCodexConfig()];
+      console.log(JSON.stringify(results));
+    `;
+    const restored = spawnSync(process.execPath, ["--eval", restoreScript], {
+      cwd: repoRoot, env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome },
+      encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000,
+    });
+    expect(restored.status).toBe(0);
+    for (const outcome of JSON.parse(restored.stdout)) expect(outcome.success).toBe(false);
+    expect(readFileSync(configPath,"utf8")).toBe(original);
+    expect(readFileSync(profilePath,"utf8")).toBe("# preserve profile\n");
+    expect(readFileSync(rollout,"utf8")).toBe(bytes);
+    expect(existsSync(join(codexHome,"opencodex-journal.json"))).toBe(false);
+  });
+
   test("remote target validate-only writes nothing; commit journals client ownership and restores exact preimage", () => {
     const original = '# remote baseline\nmodel_provider = "openai"\n';
     writeFileSync(join(codexHome, "config.toml"), original, "utf8");
@@ -760,7 +878,7 @@ describe("injectCodexConfig integration (Design B)", () => {
     expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
   });

-  test("restoreNativeCodex removes a stale journal without changing external provider state", () => {
+  test.each([false,true])("restore removes a stale journal without changing external provider state (async=%s)", (asyncRestore) => {
     const configPath = join(codexHome, "config.toml");
     const config = 'model_provider = "custom"\nmodel = "third-party-model"\n';
     writeFileSync(configPath, config, "utf8");
@@ -782,7 +900,9 @@ describe("injectCodexConfig integration (Design B)", () => {
       id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, model_provider TEXT NOT NULL,
       source TEXT NOT NULL, first_user_message TEXT NOT NULL, has_user_event INTEGER NOT NULL
     )`);
-    db.run(`INSERT INTO threads VALUES ('thread-custom', ?, 'custom', 'cli', 'hello', 1)`, rolloutPath);
+      db.run(`INSERT INTO threads VALUES ('thread-custom', ?, 'custom', 'cli', 'hello', 1)`, rolloutPath);
+      db.run("ALTER TABLE threads ADD COLUMN history_mode TEXT DEFAULT 'legacy'");
+      db.run("INSERT INTO threads VALUES ('old-routed', ?, 'opencodex', 'cli', 'older', 1, 'paginated')", rolloutPath);
     db.close();
     const dbBefore = readFileSync(dbPath);

@@ -795,7 +915,7 @@ describe("injectCodexConfig integration (Design B)", () => {
       timestamp: new Date().toISOString(),
     }), "utf8");

-    const r = runRestore(codexHome, ocxHome);
+      const r = runRestore(codexHome, ocxHome, asyncRestore);
     expect(r.status).toBe(0);
     const result = JSON.parse(r.stdout);
     expect(result.success).toBe(true);
```

## Design reflection amendment HIST-ARCH-02

Accepted: native restore preflight must include manifest-owned targets whose DB provider already equals openai after an interrupted restore. MODIFY preflightCodexHistoryInjection: when providerTableMode is false, call readBackup(historyBackupPathFor(resolvedPath), resolvedPath), collect Object.values(manifest.entries), refuse history_mode-capable stores with any such entries and assertLegacyHistoryWritable for each entry.rolloutPath before scanning current routed rows. Use the existing read-only manifest reader, not a new parser. An invalid/foreign manifest maps to the existing integrity failure string before config mutation.

NEW regression inside existing codex-inject-integration.test.ts: seed legacy routed history with syncCodexHistoryProvider(opencodex), leaving a nonempty real manifest; set its DB provider back to openai, add history_mode TEXT DEFAULT legacy, then call native restore. Assert success=false; config/profile/journal/backup/rollout bytes unchanged. Both sync and async restore must refuse. Hosted CI only; locally NOT RUN.

Preservation statement is conditional on detected incompatibility before/within artifact transaction. Native migration after final preflight is a residual race; no global atomicity or native writer lock is claimed.

Additional compensation review material is held in local scratch under repository security-note policy. It is an implementation prerequisite; do not interpret the public source diff as unchanged adoption.
