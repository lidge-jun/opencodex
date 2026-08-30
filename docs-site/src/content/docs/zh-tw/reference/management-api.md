---
title: 管理 API
description: opencodex 控制平面的認證、錯誤與端點參考。
---

管理 API 是 opencodex 的控制平面。`http://localhost:10100` 的儀表板是它的一個客戶端；無頭的 `ocx` 供應商、模型、組合、帳號、設定、診斷與生命週期指令也是客戶端。API 僅在代理執行時可用。

使用[網頁儀表板](/zh-tw/guides/web-dashboard/)作為互動式客戶端，或在建構自動化時使用此參考。持久值最終遵循[設定](/zh-tw/reference/configuration/)。

## 認證模型

管理 API 有自己的管理憑證，獨立於 data-plane API 金鑰。在啟動時，opencodex 依此順序解析它：

1. `OPENCODEX_ADMIN_AUTH_TOKEN`，設定時。
2. 強化秘密檔案中生成的 `ocx_admin_*` token。

檔案支援的 token 僅在其目錄與檔案權限或 ACL 已被強化後才被接受。若無法保證，管理認證 fail closed 且 API 回傳 503，直到提供環境 token 或修復檔案狀態。

以任一形式發送管理 token：

```http
X-OpenCodex-API-Key: <admin-token>
```

```http
Authorization: Bearer <admin-token>
```

:::caution
管理 token 必須與每個 data-plane 憑證不同。啟動時拒絕與代理許可金鑰衝突的管理憑證。請勿將管理 token 放入 Codex、Claude Code 或其他模型客戶端；它授權控制平面的變更。
:::

### 回送儀表板 session

在回送綁定上，儀表板 bootstrap 可接收短期的 `ocx_session_*` 憑證。每個 session 持續五分鐘並綁定到精確的儀表板來源。安全請求必須符合該來源。不安全方法還需要瀏覽器 `Origin` 與 session 的 CSRF token。

Session 簽發在需要 data-plane 認證時停用，這包含遠端綁定。遠端操作者必須以原始管理 token 認證；不簽發回送式 GUI session。

## 常見錯誤

下方所有端點列繼承這些邊界錯誤。「Notable errors」欄列出額外的路由專屬結果，而非重複此表。

| 狀態 | 型別或代碼 | 意義 |
| --- | --- | --- |
| 401 | `opencodex admin token required` | 管理 token 或 GUI session 缺失、無效、過期、來源不符或缺少 CSRF 證據 |
| 403 | `cross-origin request blocked` | 請求來源在管理允許清單之外 |
| 404 | `not_found` | 無管理路由符合該方法與路徑 |
| 413 | `request body too large` | POST、PUT 或 PATCH body 超過 2 MiB 管理限制 |
| 503 | `management API unavailable` | 管理憑證初始化或強化不可用 |
| 503 | `oauth_mutation_busy` | 另一個 OAuth 憑證變更持有寫入器；回應包含 `Retry-After: 1` |
| 503 | `catalog_busy` | 目錄收集已達容量；回應包含 `Retry-After: 1` |

## 端點矩陣

### 代理與客戶端設定

| 方法與路徑 | 用途 | Notable errors |
| --- | --- | --- |
| `GET, PUT /api/v2` | 讀取或變更原生多代理 v2 模式與執行緒設定 | 400 無效設定；502 轉換或持久化失敗 |
| `GET, PUT /api/injection-model` | 讀取或設定注入的子代理模型、effort、prompt 與 guidance 設定 | 400 無效模型、effort 或 body |
| `GET, PUT /api/effort-caps` | 讀取或設定全域與子代理 reasoning-effort 上限 | 400 無效階梯值 |
| `GET, PUT /api/subagent-models` | 讀取或排序向子代理廣告的模型 | 400 無效清單或超過五個模型 |
| `GET, PUT /api/subagent-model-fallback` | 讀取或設定有序的 fallback 鏈與輪詢間隔 | 400 無效清單或輪詢間隔 |
| `GET /api/grok` | 讀取 Grok 受管設定狀態與候選模型 | 400 狀態讀取失敗 |
| `PUT /api/grok/selection` | 持久化排除的 Grok 模型 | 400 無效或過大選擇 |
| `POST /api/grok/apply` | 透過受管同步套用持久化的 Grok 設定 | 409 `grok_apply_busy`；400/500 套用失敗 |
| `GET, PUT /api/claude-desktop` | 讀取或持久化 Claude Desktop 路由／原生設定檔 | 400 無效或不可用指派 |
| `POST /api/claude-desktop/apply` | 將儲存的設定檔寫入 Claude Desktop 的受管設定 | 400/500 寫入失敗 |
| `GET /api/claude-desktop/status` | 檢查已儲存 vs 已套用設定檔與 Desktop 健康 | 400 狀態讀取失敗 |
| `GET, PUT /api/claude-code` | 讀取或更新 Claude Code 閘道、auth-mode、model-map、context、agent 與 sidecar 設定 | 400 無效欄位或結構 |

關於模型名冊與加密 worker-task 行為背後的概念，請見[子代理介面](/zh-tw/guides/sub-agent-surface/)。

### 組合

| 方法與路徑 | 用途 | Notable errors |
| --- | --- | --- |
| `GET /api/combos` | 列出正規化的組合及其公開模型 id | 目錄工作可回傳 `catalog_busy` |
| `PUT /api/combos` | 建立、取代或重新命名一個組合 | 400 無效 id、目標、設定、重新命名或普通碰撞；409 Codex 帳號命名空間碰撞 |
| `DELETE /api/combos?id=...` | 刪除一個組合並清除其選擇／冷卻狀態 | 400 缺失 id；404 未知組合 |

關於目標策略、冷卻、別名與路由失敗，請見[組合](/zh-tw/guides/combos/)。

### 設定、啟動、同步與更新

| 方法與路徑 | 用途 | Notable errors |
| --- | --- | --- |
| `GET /api/config` | 回傳遮罩後、管理安全的設定 DTO | — |
| `PUT /api/config` | 停用的全設定取代防護 | 405；請改用聚焦端點 |
| `GET, PUT /api/settings` | 讀取 runtime/啟動設定或更新自動啟動、串流模式與 app 擁有記憶體預算 | 400 無效或空更新 |
| `GET /api/startup-health` | 讀取快取的服務／shim 啟動健康 | — |
| `POST /api/startup-action` | 安裝或修復服務或 Codex shim | 400 無效動作；500 動作失敗 |
| `GET, POST /api/windows-tray` | 讀取 Windows tray 狀態或安裝／啟動／停止／解除安裝它 | 400 不支援平台／動作；500 操作失敗 |
| `GET /api/diagnostics/project-config` | 讀取快取的專案設定警告 | — |
| `POST /api/sync` | 將目前模型目錄同步到 Codex | 500 同步失敗 |
| `GET /api/update/check` | 檢查 `latest` 或 `preview` 更新頻道 | 400 無效 tag |
| `POST /api/update/run` | 啟動更新工作，可選擇接著重啟 | 400 無效 body；工作專屬衝突／錯誤狀態 |
| `GET /api/update/status` | 依 id 輪詢更新工作 | 404 未知工作 |
| `GET, PUT /api/sidecar-settings` | 讀取或更新網頁搜尋與視覺 sidecar 模型／backend 設定 | 400 無效結構、backend 或限制 |
| `GET, PUT /api/shadow-call-settings` | 讀取或更新 shadow-call 攔截設定 | 400 無效結構或值 |

### 日誌、用量與儲存

| 方法與路徑 | 用途 | Notable errors |
| --- | --- | --- |
| `GET /api/logs` | 查詢過濾的記憶體內請求日誌 | — |
| `GET, PUT /api/debug` | 讀取除錯旗標；設定、清除或重置擷取類別 | 400 無效或空更新 |
| `GET /api/debug/logs` | 讀取有界的供應商／除錯日誌項目 | — |
| `GET /api/debug/usage-logs` | 讀取有界的 usage-debug 項目 | — |
| `GET /api/debug/injection-logs` | 讀取有界的 guidance-injection 除錯項目 | — |
| `GET /api/claude/inbound-debug` | 讀取 Claude inbound 除錯狀態與項目 | — |
| `GET /api/usage` | 依範圍與客戶端介面摘要用量 | 若儲存無法讀取則回傳 `error: "read_failed"` 摘要 |
| `GET /api/storage` | 依 bucket 掃描 Codex 儲存用量 | 掃描失敗時回傳 `error: "scan_failed"` payload |
| `POST /api/storage/cleanup/preview` | 預覽已封存 session 清理並回傳綁定摘要 | 400 `invalid_json` 或 `invalid_percent` |
| `POST /api/storage/cleanup` | 隔離或永久移除預覽的已封存集合 | 400 無效輸入；409 過時／忙碌／被參照狀態；500 檔案系統／資料庫失敗 |
| `GET /api/storage/trash` | 列出隔離的清理項目 | 500 `trash_list_failed` |
| `POST /api/storage/trash/restore` | 還原一個隔離項目 | 400 無效 id；404 缺失 trash；409 忙碌／目的地衝突；500 還原失敗 |
| `GET /api/storage/trash/restore/test-stream` | 僅測試的還原串流 hook | 測試 hook 關閉時 404 `not_available` |
| `GET, PUT /api/storage/cleanup-policy` | 讀取或更新排程清理政策與工作狀態 | 400 無效政策 |
| `POST /api/storage/cleanup-policy/run` | 啟動手動清理政策執行 | 409 `already_running`；500 `cleanup_failed` |
| `GET /api/storage/cleanup-policy/test-stream` | 僅測試的政策串流 hook | 不可用時 404 `not_found` |

`models`、`providers` 及 `days[].models` 中的列也帶有 `cacheHitRate`：表示由供應商提示快取提供的輸入權杖比例，並限制在 `[0, 1]`。當供應商未回報快取遙測資料，或該列沒有輸入權杖時，其值為 `null`，絕不會是 `0`；因為「沒有快取資料」與「確實為 0% 的命中率」是不同事實，若圖表將兩者呈現為相同狀態，便會造成誤導。

:::caution
儲存清理端點可移動或永久移除已封存的 session 資料。請務必先預覽並提交回傳的摘要。在可能需要復原時偏好隔離。
:::

### 模型與目錄

| 方法與路徑 | 用途 | Notable errors |
| --- | --- | --- |
| `GET /api/catalog` | 回傳已安裝的 Codex 目錄檔案 | 404 目錄未找到 |
| `GET /api/models` | 回傳儀表板／CLI 模型列 | 收集飽和時 `catalog_busy` |
| `GET /api/client-config?client=...` | 為 `opencode`、`pi`、`omp`、`hermes`、`openclaw`、`kimi`、`gajae` 或 `dsh` 建構唯讀客戶端設定 | 400 不支援客戶端；503 目錄不可用 |
| `PUT /api/disabled-models` | 取代共享的 disabled-model 清單 | 400 無效 JSON |
| `PUT /api/model-visibility` | 原子地變更供應商或模型層級可見性 | 400 無效供應商、scope、目標或 body |
| `GET, POST /api/custom-models` | 列出自訂模型或新增一個 | 400 無效欄位；404 供應商缺失；409 重複模型 |
| `PUT, DELETE /api/custom-models/{id}` | 編輯或刪除一個自訂模型 | 400 無效 id/欄位；404 未找到；409 重複模型 |
| `GET, PUT /api/selected-models` | 讀取供應商允許清單與可用性，或取代一個允許清單 | 400 缺失供應商/body；404 未知供應商 |

### OAuth 帳號、供應商金鑰與 data-plane 金鑰

| 方法與路徑 | 用途 | Notable errors |
| --- | --- | --- |
| `GET /api/oauth/providers` | 列出有公開 OAuth 登入流程的供應商 | — |
| `GET /api/key-providers` | 列出透過 API-key 登入設定的供應商 | — |
| `POST /api/oauth/login` | 啟動 OAuth 登入或帳號新增流程 | 400 未知／無效供應商；`oauth_mutation_busy` |
| `POST /api/oauth/login/code` | 提交手動 callback URL 或授權碼 | 400 無效供應商／碼；`oauth_mutation_busy` |
| `POST /api/oauth/login/cancel` | 取消公開進行中的 OAuth 流程 | 400 未知供應商 |
| `GET /api/oauth/status` | 輪詢一個供應商的 OAuth 流程 | 400 未知供應商 |
| `POST /api/oauth/logout` | 移除所選的供應商憑證 | 400 未知供應商；`oauth_mutation_busy` |
| `GET, DELETE /api/oauth/accounts` | 列出遮罩帳號或移除一個帳號 | 400 無效供應商/id；404 帳號缺失；`oauth_mutation_busy` |
| `PUT /api/oauth/accounts/active` | 選擇現用 OAuth 帳號 | 400 無效供應商／帳號；`oauth_mutation_busy` |
| `GET, PUT, PATCH /api/oauth/accounts/pool` | 讀取或更新 Anthropic OAuth 池政策 | 400 非 Anthropic 供應商或無效政策 |
| `POST /api/oauth/accounts/clear-cooldown` | 清除一個 OAuth 帳號的 runtime 冷卻 | 400 無效供應商／帳號 |
| `PUT /api/oauth/accounts/alias` | 設定或清除 OAuth 帳號別名 | 400 無效供應商／帳號／別名 |
| `GET, POST, DELETE /api/providers/keys` | 列出遮罩供應商金鑰、新增／啟用一個或移除一個 | 400 無效輸入；404 供應商／金鑰缺失 |
| `PUT /api/providers/keys/active` | 選擇供應商的現用金鑰 | 400 無效輸入；404 供應商／金鑰缺失 |
| `PUT /api/providers/keys/alias` | 設定或清除供應商金鑰別名 | 400 無效輸入；404 供應商／金鑰缺失 |
| `GET, POST, PATCH, DELETE /api/keys` | 列出、建立、編輯或刪除 data-plane 許可金鑰 | 400 無效 body/id；404 金鑰缺失 |

憑證清單回應被刻意遮罩。OAuth access token 與完整的供應商 API 金鑰不回傳給儀表板客戶端。

### 供應商

| 方法與路徑 | 用途 | Notable errors |
| --- | --- | --- |
| `GET /api/providers` | 列出遮罩後的供應商設定與探索狀態 | — |
| `POST /api/providers` | 新增或取代一個已驗證的供應商並可選擇設為預設 | 400 無效／危險目的地或設定；409 命名空間碰撞 |
| `PATCH /api/providers?name=...` | 更新允許的供應商欄位、enabled/default 狀態或 OpenAI 帳號模式 | 400 無效欄位或轉換；404 未知供應商 |
| `DELETE /api/providers?name=...` | 刪除供應商，在可能時重新指派預設 | 404 未知供應商；409 `last_provider`；409 `provider_has_dependent_combos` |
| `POST /api/providers/test?name=...` | 執行有界的即時供應商連線／模型探索探測 | 404 未知供應商；失敗通常以 `ok: false` 證據回傳 |
| `GET /api/provider-quotas` | 讀取供應商配額報告；`refresh=1` 強制重新整理 | — |
| `GET, PUT /api/provider-context-caps` | 讀取或更新全域、所有供應商或單一供應商的 context 上限 | 400 無效請求；404 未知供應商 |
| `GET /api/provider-presets` | 回傳從 runtime registry 衍生的 GUI 供應商預設 | — |

`provider_has_dependent_combos` 是安全屏障：在刪除其供應商前，先移除或編輯相依的組合。

### 側邊欄與同意約束動作

| 方法與路徑 | 用途 | Notable errors |
| --- | --- | --- |
| `GET /api/github/star` | 透過使用者的 `gh` session 讀取 repository 加星狀態 | 狀態專屬的固定結果代碼 |
| `POST /api/github/star` | 僅從已認證的人類動作為 repository 加星 | 403 `agent_consent_required`，針對無儀表板 session 證據的 agent 驅動呼叫者 |
| `GET /api/update/badge` | 讀取便宜的側邊欄更新徽章狀態 | — |

:::caution
管理認證證明對代理的存取權；它不證明花費使用者身分的同意。agent 絕不能繞過 `agent_consent_required`。使用者必須選擇是否為 repository 加星。
:::

### 系統生命週期

| 方法與路徑 | 用途 | Notable errors |
| --- | --- | --- |
| `GET /api/system/memory` | 回傳純量行程、heap、串流、回應狀態、看門狗與活躍回合指標 | — |
| `POST /api/system/restart` | 在不移除客戶端注入的情況下開始感知排空的行程重啟 | 回傳 202；重複呼叫回報既有的排空 |
| `POST /api/stop` | 停止服務、還原原生 Codex、移除受管 Grok 注入並排空代理 | 409 服務擁有權衝突 |

### Codex 認證委派

根管理分派器將每個 `/api/codex-auth/*` 請求委派給 Codex 帳號管理員。其路由為：

| 方法與路徑 | 用途 | Notable errors |
| --- | --- | --- |
| `GET, POST, DELETE /api/codex-auth/accounts` | 列出／重新整理或刪除 Codex 帳號。POST 僅保留為已停用的相容 endpoint；成功的 DELETE 回應包含 `catalogRefreshPending`。 | POST 一律回傳 403 `manual_import_disabled`；DELETE 輸入無效時回傳 400 |
| `PUT /api/codex-auth/accounts/alias` | 設定或清除帳號別名 | 400 無效帳號／別名 |
| `PUT /api/codex-auth/accounts/pause` | 暫停或恢復一個帳號 | 400 無效帳號／狀態；404 缺失帳號 |
| `PUT /api/codex-auth/accounts/pause-exhausted` | 暫停配額耗盡的帳號 | 變更鎖失敗變為 503 |
| `POST /api/codex-auth/accounts/clear-cooldown` | 清除一個或所有帳號的 runtime 冷卻 | 400 無效 id |
| `GET, PUT /api/codex-auth/active` | 讀取或選擇現用帳號 | 400 無效或缺失帳號；409 暫停／舊列衝突 |
| `PUT /api/codex-auth/auto-switch` | 設定自動帳號切換的配額閾值 | 400 無效閾值 |
| `PUT, PATCH /api/codex-auth/pool-strategy` | 更新 Codex 帳號池選擇策略 | 400 無效策略／設定 |
| `PUT /api/codex-auth/failover` | 設定帳號容錯移轉閾值 | 400 無效閾值 |
| `GET /api/codex-auth/quota` | 依帳號讀取快取配額狀態 | — |
| `GET /api/codex-auth/reset-credits` | 檢查帳號的 reset-credit 資格 | 400 缺失帳號 id；上游狀態 passthrough；500 查詢失敗 |
| `POST /api/codex-auth/reset-credits/consume` | 消耗一個合格的 reset credit | 400 缺失帳號 id；上游狀態 passthrough；503 `server_busy`；500 消耗失敗 |
| `POST /api/codex-auth/login` | 啟動 Codex 登入或重新認證 | 400 無效請求；衝突／忙碌登入狀態 |
| `POST /api/codex-auth/login/code` | 為 Codex 登入流程提交手動碼 | 400 無效流程／碼 |
| `POST /api/codex-auth/login/cancel` | 取消 Codex 登入流程 | — |
| `GET /api/codex-auth/login-status` | 輪詢流程或帳號登入狀態 | 未知流程回報 `expired`；無活躍流程回報 `idle` |

此委派家族下的設定寫入器或憑證重新整理鎖逾時回傳 HTTP 503 並附帶代碼 `CONFIG_MUTATION_LOCK_UNAVAILABLE`。客戶端應稍後重試，而非將該回應視為永久帳號失敗。

## 選擇客戶端

對於普通管理，[網頁儀表板](/zh-tw/guides/web-dashboard/)提供最安全的引導工作流程。對於無頭主機與自動化，請使用對應的 `ocx` 指令：它們呼叫此相同的即時 API，並在代理不可達或操作失敗時回傳非零結果。直接 HTTP 對需要上述精確端點契約的整合最為有用。
