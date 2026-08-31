---
title: "Sidecar：Web Search 與 Vision"
description: 透過原生 ChatGPT sidecar，讓路由模型獲得真實 web search，並讓純文字模型理解圖像。
---

不同路由模型對託管 **Web Search** 和原生**圖像輸入**的支援並不相同。opencodex 透過兩個
sidecar 補齊這些能力；它們可以使用 ChatGPT 登入（`forward`）provider，也可以使用已儲存的
Anthropic OAuth provider；web search 還可透過明確的 `xai` backend 使用已儲存的 Grok OAuth。Sidecar 錯誤會轉換成長度受限的工具結果或圖像提示，不會讓整個 turn
失敗。

:::note[自動選擇後端]
明確的 `backend` 設定優先。Web search 省略時一律使用 `openai`；Vision 有可用 Anthropic
OAuth 帳號時使用 `anthropic`，否則使用 `openai`。明確選擇 `anthropic` 或 `xai` 但沒有可用憑證時
會關閉失敗且不回退。`openai` 同時需要 ChatGPT 登入和已啟用的 `forward` provider。
:::

## Web-search sidecar

當 Codex 為非透傳的路由模型請求託管 `web_search` 時，opencodex 會：

1. **移除**託管的 `web_search` 工具，改為向路由模型提供一個合成的
   `web_search(query)` function 工具。原託管工具的選項會保留並用於 sidecar 呼叫。
2. 讓路由模型在一個小型 **agentic 迴圈**中執行。模型呼叫 `web_search` 時，opencodex 使用所選
   後端：OpenAI 預設以 `gpt-5.6-luna` 執行託管 `web_search`；Anthropic 預設以
   `claude-sonnet-5` 執行 `web_search_20250305`。xAI 預設以 `grok-4.6` 執行託管 `web_search`，
   並在 `xSearch.enabled` 為 true 時將 `x_search` 加入同一請求。Streaming 答案及引用會解析為工具結果。
3. **迴圈**直到模型回答，或真實查詢總數達到 `maxSearchesPerTurn`（預設 3）。達到上限後會移除
   search 工具並強制生成最終答案。如果模型呼叫 `apply_patch` 或 shell 等真實用戶端工具，目前
   turn 會結束，以便這些呼叫到達 Codex。

路由模型的每次迭代都會向上遊請求 `stream: true`，但 opencodex 會在決定搜尋還是回傳最終答案前，
在內部完整緩衝所有語義 event。只有第一次迭代的最終 header/status 和 429 key rotation 會被提前
取得。因此，合成搜尋呼叫和中間輸出不會作為模型輸出暴露給用戶端。

注入結果會包裹在不可信資料邊界中，限制長度，並按來源 URL 去重。在結構化輸出 turn
（`json_schema` / `json_object`）中，結果會以緊湊 JSON 而不是普通文字傳入。若路由模型是純文字
模型，search 模型還會收到指令，用文字描述相關圖像並附上來源 URL。

```json
{
  "webSearchSidecar": {
    "enabled": true,
    "backend": "anthropic",
    "model": "claude-sonnet-5",
    "reasoning": "low",
    "maxSearchesPerTurn": 3,
    "routedModelStallTimeoutMs": 200000,
    "timeoutMs": 200000
  }
}
```

託管後端不允許在 `minimal` reasoning 下使用工具，因此預設值為 `low`。搜尋失敗時，路由模型會
收到長度受限的錯誤結果，仍可依據已有上下文繼續回答。

此路徑採用四個相互獨立的時鐘。`stallTimeoutSec` 是基礎 bridge event-stall 預算。
`connectTimeoutMs`（預設 `200000`）只限制 DNS/TCP/TLS 和最終回應 header。僅可在設定檔中
設定的 `webSearchSidecar.routedModelStallTimeoutMs`（預設 `200000`，整數
`1..2147483647`）限制每次路由模型迭代中原始回應 byte 連續無活動的時間，並在收到每個非空 byte
時重置。`webSearchSidecar.timeoutMs` 獨立限制單次託管搜尋請求。實際 bridge watchdog 為
`max(基礎 stall, connect timeout, 路由模型 stall, sidecar timeout) + 30 秒`。路由模型 stall
不是總生成 timeout。SSE 開始前的失敗會回傳非 2xx JSON；回應 header 開始後發生的生成失敗則以
`response.failed` SSE 傳遞。

## Vision sidecar

當路由模型列在其 provider 的 `noVisionModels` 中，並且請求包含圖像時，opencodex 會在主呼叫
**之前**描述每張圖像，並用文字替換圖像。Dashboard 和管理 API 目前顯示的預設值是
`gpt-5.6-luna`，啟動時也會把明確儲存的舊 `gpt-5.4-mini` 值遷移到 Luna。只有在
`visionSidecar.model` 欄位完全不存在時，vision 執行路徑才會使用程式碼中的 `gpt-5.4-mini` 回退值。

- 圖像可以來自 user、developer 和 tool-result message，也包括 Codex 的 `view_image` 結果。
- 每張圖像會以 `reasoning.effort: "low"` 傳送給設定的原生 vision 模型，描述結果會就地替換
  圖像部分。
- 描述任務最多同時處理 3 張圖像，並保持輸入順序。傳送給描述模型的使用者上下文最多 800 個字元，
  每張圖像注入的描述最多 2,000 個字元。請求不會傳送 ChatGPT 後端不支援的
  `max_output_tokens`。
- 圖像 URL 會在轉發前校驗。data URL 必須是 `png` / `jpeg` / `jpg` / `webp` / `gif`，base64
  資料限制在約 20 MB；只接受 `data:` 和 `https:` scheme。遠端 `https` 圖像由 OpenAI 後端取得，
  而不是代理。
- `noVisionModels` 匹配會忽略 Ollama 風格的 `:size` 字尾，因此一個 `gpt-oss` 條目也能覆蓋
  `gpt-oss:120b`。
- 如果描述失敗，模型會收到簡短的處理錯誤提示。若根本無法建立 sidecar plan，原始圖像會被
  移除，而不會繼續轉發給純文字後端。
- `maxDescriptionsPerTurn`（預設 8）限制每個主模型 turn 的新增描述次數。快取命中和同一 turn
  的重複請求不會消耗配額。成功的 `data:` 圖像描述會按後端、模型、detail、圖像位元組和訊息上下文
  快取；內容可變的 `https:` 圖像不會快取。

```json
{
  "visionSidecar": {
    "enabled": true,
    "backend": "anthropic",
    "model": "claude-sonnet-5",
    "maxDescriptionsPerTurn": 8,
    "timeoutMs": 45000
  }
}
```

純文字模型按 provider 標記：

```json
{
  "providers": {
    "ollama-cloud": {
      "baseUrl": "https://ollama.com/v1",
      "noVisionModels": ["glm-5.2", "gpt-oss", "qwen3-coder", "deepseek-v4-pro"]
    }
  }
}
```

## 儀表板設定與停用

儀表板的視覺附屬服務卡片可以啟用或停用 sidecar，並設定 `maxDescriptionsPerTurn` 和
`timeoutMs`，同時保留既有的模型、後端和推理強度控制。停用不會刪除這些設定；重新啟用後仍會保留原來的模型、後端、推理強度、逾時和次數上限。

`PUT /api/sidecar-settings` 接受相同欄位。部分更新會保留未提交的鍵。`timeoutMs` 使用執行時整數邊界（1–2147483647 毫秒）。

如果更想直接改檔案，仍可在 `config.json` 中把 `enabled` 設為 `false`。Anthropic OAuth 搜尋和圖像描述沿用現有 Claude Code OAuth fingerprint 先例，但仍應使用目標帳號和實際負載充分 soak test。所有欄位見
[設定參考](/zh-tw/reference/configuration/#sidecars)。
