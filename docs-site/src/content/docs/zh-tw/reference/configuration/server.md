---
title: 伺服器與執行階段設定
description: 監聽器、遠端存取、許可金鑰、逾時、儲存、sidecar、shadow call 與啟動行為。
---

伺服器設定控制本機代理如何監聽、保護遠端流量、管理資源，並在供應商請求周圍執行輔助功能。

## 伺服器欄位

| 欄位 | 型別 | 預設值 | 意義 |
| --- | --- | --- | --- |
| `port` | `number` | `10100` | 代理監聽連接埠。 |
| `hostname?` | `string` | `"127.0.0.1"` | 綁定位址。非回送綁定需要 `OPENCODEX_API_AUTH_TOKEN`。 |
| `proxy?` | `string` | — | 對外 HTTP(S) 代理 URL 或 `${ENV_VAR}`。僅在那些變數未設定時套用至 `HTTP_PROXY` / `HTTPS_PROXY`；回送保留在 `NO_PROXY` 中。 |
| `emptyCompletionRetry?` | `boolean` | `false` | 明確啟用：當 Responses 完成時沒有文字或工具呼叫，以相同請求重試一次。重試可能產生費用。`OCX_EMPTY_COMPLETION_RETRY=0` 可在不變更設定的情況下停用；combo 與 routed-compaction turn 不適用。 |
| `stallTimeoutSec?` | `number` | `300` | 在 `response.incomplete` 前無上游資料的秒數。最小 1。 |
| `connectTimeoutMs?` | `number` | `200000` | 每次嘗試的 DNS/TCP/TLS/final-header 截止時間；它在 body 生成前結束。 |
| `shutdownTimeoutMs?` | `number` | `5000` | 在中止活躍回合前的優雅排空截止時間。 |
| `websockets?` | `boolean` | `false` | 廣告並允許面向 client 的 Responses WebSocket 路徑。False 時 client 使用 HTTP/SSE；不會停用符合條件的 canonical ChatGPT upstream WS 最佳化。 |
| `corsAllowOrigins?` | `string[]` | `[]` | 額外的精確 CORS 來源。回送來源恆被允許。 |
| `apiKeys?` | `OcxApiKey[]` | `[]` | 生成的 `ocx_…` 憑證，在非回送綁定上被管理與 data-plane 認證接受。由儀表板管理。 |
| `storageCleanupPolicy?` | `StorageCleanupPolicy` | 停用 | 選擇加入的已封存 session 清理政策。永不隱含啟用。 |
| `appOwnedMemoryBudgetMb?` | `number` | `256` | 以 MiB 為單位、可被驅逐的 app 擁有日誌、快取、blob 與 continuation payload 上限。範圍 64–4096；非 RSS 上限。 |
| `codexAutoStart?` | `boolean` | `true` | 讓 Codex shim 在啟動 Codex 前執行 `ocx ensure`。False 使 ensure 為 no-op。 |
| `codexShimAutoRestore?` | `boolean` | `true` | 在完成的外部 Codex 更新取代已安裝的 shim 後還原它。環境退出：`OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0`。 |
| `syncResumeHistory?` | `boolean` | `true` | 可逆的 Codex App 歷史相容性。原始中繼資料由 `ocx stop` / `ocx restore` 備份並還原。 |
| `shadowCallIntercept?` | `{ enabled?: boolean; model?: string; sourceModels?: string[] }` | off | 將識別的 Codex helper/shadow call 重定向到所選模型，以低 effort 執行。預設來源前綴為 `gpt-5.4-mini` 與 `gpt-5.6-luna`。 |
| `webSearchSidecar?` | `OcxWebSearchSidecarConfig` | 可用時開啟 | 網頁搜尋 sidecar 選項。 |
| `visionSidecar?` | `OcxVisionSidecarConfig` | 可用時開啟 | 圖片描述 sidecar 選項。 |
| `images?` | `OcxImagesConfig` | 自動 OpenAI 選擇 | Codex `image_gen` 的獨立 Images 中繼選項。 |

若較舊的開發組建在備份支援存在前變更了 resume-history 中繼資料，請執行 `ocx recover-history --legacy-openai` 以強制原生供應商復原。

## 遠端存取

預設的 `127.0.0.1` 綁定僅限回送。如 `0.0.0.0` 的非回送位址需要在 `/api/*` 與 data plane 上都進行 token 認證。在啟動前匯出 token：

```bash
export OPENCODEX_API_AUTH_TOKEN="your-secret-token"
ocx start
```

代理在沒有此變數時拒絕遠端綁定。對於背景服務，請在 `ocx service install` 前匯出它，以便 launchd、systemd 或 Task Scheduler 接收它。客戶端應發送：

```text
x-opencodex-api-key: your-secret-token
```

| 端點 | `Authorization: Bearer` | `x-opencodex-api-key` | `x-api-key` |
| --- | --- | --- | --- |
| `/v1/responses` | 不接受 | **必填** | 不接受 |
| `/v1/chat/completions` | 不接受 | **必填** | 不接受 |
| `/v1/messages` | 接受 | 接受 | 接受 |
| `/v1/messages/count_tokens` | 接受 | 接受 | 接受 |
| `/v1/models` | 接受 | 接受 | 接受 |

Responses 與 Chat Completions 為可能的 Codex Direct passthrough 保留 `Authorization`，因此那裡僅接受專屬的許可標頭。儀表板生成的 `apiKeys` 可在啟動後取代環境 token；候選值以常數時間比對。

Messages 與 `count_tokens` 為相容路由客戶端仍接受三種許可形式。但在非回環綁定上，原生 Anthropic 透傳只透過
`x-opencodex-api-key` 接受代理許可，並將 `Authorization` 與 `x-api-key` 保留給 Anthropic
憑證。放在這些供應商標頭中的代理許可密鑰會在轉發前移除。

:::caution[LAN 暴露]
`0.0.0.0` 綁定將代理與設定的供應商存取暴露給 LAN。僅在受信任的網路上搭配強 token 使用。
:::

### 無法接收 token 的本機用戶端

遠端綁定要求每個呼叫者都要有憑證，包括本機呼叫者。這會破壞一個特定情境：由 host process 啟動、
直接解析 Codex entrypoint（`require.resolve('@openai/codex/bin/codex.js')`）的 `codex app-server`
永遠不會經過生成的 `codex` shim，因此它不會繼承 `OPENCODEX_API_AUTH_TOKEN`，每次模型呼叫都會在
stream 開啟前以 `401` 失敗。

`unauthenticatedLoopbackListener` 會開啟第二個綁定到 `127.0.0.1` 的 listener，不要求憑證即可
放行。主 listener 不受影響——遠端呼叫者仍需要 token。

```json
{
  "hostname": "0.0.0.0",
  "port": 10100,
  "unauthenticatedLoopbackListener": { "enabled": true, "port": 10200 }
}
```

接著 `ocx sync` 會把 `base_url = "http://127.0.0.1:10200/v1"` 寫入受管的 Codex provider 區塊，
並省略 auth header，因此直接生成的 app-server 不需要任何憑證管線即可運作。

該 port 是必填的，且必須與 proxy port 不同。它絕不會由 OS 指派：臨時 port 會在重啟時改變，而
已執行的 app-server 仍保留先前的 `base_url`。

該 listener 只服務 `POST /v1/responses`、其 WebSocket upgrade、`POST /v1/responses/compact` 與
`GET /v1/models`。其他一切，包括 `/api/*` 與儀表板，都會回傳 `404`。

:::danger[這是一個未認證的介面]
機器上的每個 process 都可以使用此 listener。它會耗用帳號配額與付費 provider 憑證，也可能耗盡
已認證遠端用戶端依賴的共享 turn 容量。請勿在共用或多租戶主機上啟用。

綁定到 `127.0.0.1` 表示 kernel 會拒絕遠端連線，但不會阻止瀏覽器：你造訪的頁面可以讓瀏覽器連到
`127.0.0.1`。因此該 listener 套用與一般 loopback 綁定相同的 `Host` 與 `Origin` 檢查。預設關閉。
:::

### SSH 連接埠轉發

遠端使用不需要遠端綁定。保持回送並轉發它：

```bash
ssh -L 20100:localhost:10100 you@remote
```

任何本機連接埠皆可。Host 解析為 `localhost`、`127.0.0.1` 或 `::1` 的請求，不論連接埠皆保持回送，因此 `http://localhost:20100/v1` 可運作。在客戶端設定該 base URL；`ocx` 僅將預設的本機 `127.0.0.1` 位址寫入受管客戶端設定。

供應商 OAuth callback 在固定遠端連接埠監聽。在遠端機器上登入或也轉發該連接埠：

```bash
ssh -L 20100:localhost:10100 -L 1455:localhost:1455 you@remote
```

:::caution[轉發的回送未認證]
普通 `ssh -L` 在你的本機回送上監聽，對預設的未認證綁定是安全的。請勿使用 `ssh -g -L`、廣泛的容器發布，或將客戶端暴露在 `0.0.0.0` 上的轉發模式。不確定時請用 `ssh -L 127.0.0.1:20100:localhost:10100` 明確綁定。
:::

## 儲存清理

`storageCleanupPolicy` 預設停用。啟用時，它在已封存位元組超過 `trigger.archivedBytesOver` 後於 `startup`、`daily`、`weekly` 或 `manual` 執行。它朝 `target.reduceToBytes` 或 `target.removeOldestPercent` 選擇最舊的封存。`mode` 預設為 `quarantine`；僅將 `permanent` 作為明確的破壞性選擇。政策持久化 `lastRun` 與 `nextRun`。在 Storage 頁面或以 `GET`/`PUT /api/storage/cleanup-policy` 設定它；以 `POST /api/storage/cleanup-policy/run` 觸發手動執行。

## Claude Code（`claudeCode`）

這些設定治理 `/v1/messages`、`/v1/messages/count_tokens`、`ocx claude` 啟動器與 Claude 儀表板頁面。

| Key | 型別 | 預設值 | 說明 |
| --- | --- | --- | --- |
| `claudeCode.bodyStallSec?` | `number` | `90` | 原生 passthrough body 在讀取待決時的不活動預算（秒），非總持續時間。最小 1；精確 `0` 停用。 |
| `claudeCode.bodyMaxBytes?` | `number` | `67108864` | 串流與緩衝回應的累積原生 passthrough body 上限。精確 `0` 停用。 |
| `claudeCode.authMode?` | `"proxy" \| "subscription"` | 自動 | 啟動如何處理 `ANTHROPIC_AUTH_TOKEN`。自動每次啟動偵測認證；明確值永不被覆寫。 |
| `claudeCode.authModeMigratedAt?` | `string` | 未設定 | 內部一次性升級標記。請勿手動設定。 |
| `claudeCode.subagentEffort?` | `"low" \| "medium" \| "high" \| "xhigh" \| "max"` | 繼承 | 寫入生成的 `~/.claude/agents/ocx-*.md` 的 effort；與 Codex guidance 與代理上限分開。透過 `ocx claude` 重啟以重新生成。 |

自動認證在找到已儲存的 Claude 認證時選擇訂閱，無認證時選擇 proxy，偵測不明確時選擇訂閱並附帶警告。請見[Claude Code 認證模式](/zh-tw/guides/claude-code/#auth-mode)。

## Shadow call

Codex 使用小型 helper 模型處理如標題與 commit 訊息等任務。啟用 `shadowCallIntercept` 以將識別的來源模型前綴重定向到另一個已設定的模型。替換以低 effort 執行。僅在客戶端使用不同的 helper id 時設定 `sourceModels`。

```json
{
  "shadowCallIntercept": {
    "enabled": true,
    "model": "gpt-5.5",
    "sourceModels": ["gpt-5.4-mini", "gpt-5.6-luna"]
  }
}
```

## Sidecar

### `images`（`OcxImagesConfig`）

| 欄位 | 型別 | 預設值 | 意義 |
| --- | --- | --- | --- |
| `provider?` | `string` | 自動 OpenAI 選擇 | 用於 `/v1/images/generations` 與 `/v1/images/edits` 的明確自訂 API-key `openai-responses` 供應商。Registry 管理的 id 被拒絕。 |
| `timeoutMs?` | `number` | `300000` | 一個獨立 Images 請求的整體請求逾時。 |

明確選擇在供應商缺失、停用、不相容或缺少可用金鑰時 fail closed；它永不後退到另一個付費上游。端點必須實作 Codex 預期的 OpenAI Images API 路徑與回應結構。

### `webSearchSidecar`（`OcxWebSearchSidecarConfig`）

| 欄位 | 型別 | 預設值 | 意義 |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | 可用時開啟 | 主開關。 |
| `backend?` | `"openai" \| "anthropic" \| "xai" \| "gemini" \| "exa"` | `openai` | 明確設定優先；省略時一律使用 `openai`。`anthropic` 與 `xai` 僅在明確設定時執行；`gemini` 與 `exa` 在 executor 推出前仍為保留值。 |
| `model?` | `string` | 視 backend 而定 | OpenAI 為 `gpt-5.6-luna`、Anthropic 為 `claude-sonnet-5`、xAI 為 `grok-4.6`。舊版明確 `gpt-5.4-mini` 在啟動時遷移。 |
| `exaApiKey?` | `string` | 無 | `exa` backend 的操作員金鑰。僅可寫入：管理讀取永遠不會傳回已儲存的值。 |
| `xSearch?` | `object` | 省略 | xAI 專用的託管 `x_search` opt-in：`enabled`、互斥的 `allowedXHandles` / `excludedXHandles` 陣列（最多 20 項），以及 ISO `fromDate` / `toDate`（`YYYY-MM-DD`）。 |
| `reasoning?` | `string` | `low` | Sidecar effort。`minimal` 在網頁搜尋時被拒絕。 |
| `maxSearchesPerTurn?` | `number` | `3` | 每個主模型回合允許的實際搜尋。 |
| `routedModelStallTimeoutMs?` | `number` | `200000` | 僅設定檔的路由模型原始 body 不活動截止時間。整數 1–2147483647；每個非空 chunk 重置它。 |
| `timeoutMs?` | `number` | `60000` | 一個代管搜尋的截止時間。 |

OpenAI backend 需要 ChatGPT 登入與啟用的 ChatGPT `forward` 供應商。Claude-inbound 路由重播將主 ChatGPT 認證注入內部請求。Anthropic backend 使用來自已啟用 Anthropic OAuth 供應商的現用已儲存憑證。明確選擇的 Anthropic backend 在無可用帳號時 fail closed 而非後退。Anthropic 執行器使用其原生 `web_search_20250305` 工具。xAI backend 需要可用的已儲存 Grok OAuth 帳號，使用託管 `web_search`，並在 `xSearch.enabled` 為 true 時加入託管 `x_search`。格式錯誤的 `xSearch` 管理輸入會傳回 `400`；格式錯誤的持久化區塊會在規劃期間 fail closed。`gemini` 與 `exa` 通道絕不會因憑證探索或 fallback 而啟用；操作員必須明確選擇它們。`exaApiKey` 可在寫入時接受，但會從管理回應中省略。

四個時鐘治理搜尋：基礎 `stallTimeoutSec`、`connectTimeoutMs`、路由模型不活動與代管搜尋逾時。有效的橋接看門狗為最大值加 30 秒。路由停滯是不活動防護，而非總生成截止時間。

### `visionSidecar`（`OcxVisionSidecarConfig`）

| 欄位 | 型別 | 預設值 | 意義 |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | 可用時開啟 | 主圖片描述開關。 |
| `backend?` | `"openai" \| "anthropic"` | 自動 | 明確值優先；未設定時優先使用可用的已儲存 Anthropic OAuth 憑證，否則使用 `openai`。 |
| `model?` | `string` | 視 backend 而定 | OpenAI 為 `gpt-5.4-mini` 或 Anthropic 為 `claude-sonnet-5`。 |
| `maxDescriptionsPerTurn?` | `number` | `8` | 每個主回合允許的新描述快取未命中。`0` 停用呼叫；無效值使用預設。 |
| `timeoutMs?` | `number` | `45000` | Sidecar 擷取逾時。整數 1–2147483647。 |

視覺僅對發送到其供應商 `noVisionModels` 中模型的圖片啟用。OpenAI 的登入／forward 需求與搜尋相同；明確選擇的 Anthropic 在無可用憑證時 fail closed。成功的 `data:` 描述使用以 backend、模型、細節、圖片位元組與正規化訊息 context 為 key 的有界快取。命中與同回合重複不消耗限制。遠端 `https:` 圖片與失敗或空的描述不被快取。

Anthropic OAuth sidecar 重用 opencodex 既有的 Claude Code OAuth 指紋。請對預期帳號與工作負載進行浸泡測試。
