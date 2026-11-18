---
title: Ollama 相容用戶端
description: 讓使用 Ollama API 的工具連接 opencodex，並使用已設定的供應商模型。
---

opencodex 支援 Ollama HTTP API 的一個子集，因此只能與 Ollama 溝通的工具也能使用你在 opencodex
中已設定的模型。請求會轉換到 Chat Completions 路徑，並送往所選供應商。opencodex 不會在你的電腦上
下載、儲存或執行模型。

## 連接用戶端

將代理位址作為 Ollama 主機。預設本機安裝如下：

```bash
export OLLAMA_HOST=http://127.0.0.1:10100
curl "$OLLAMA_HOST/api/tags"
```

當代理要求 API 金鑰時（例如綁定到 `0.0.0.0`），請以與 `/v1/chat/completions` 相同的方式傳送，
例如 `Authorization: Bearer <opencodex key>`。具有模型範圍的金鑰只能看到並使用允許的模型。這些端點只在主要監聽器上
提供；無驗證的回送監聽器、Remote Link 與 hub 管理入口都不會公開它們。

## 端點

| 端點 | 行為 |
| --- | --- |
| `GET /api/version` | opencodex 版本。 |
| `GET /api/tags` | 以 `provider/model` 名稱列出已設定的供應商模型。 |
| `POST /api/show` | `{ "model": "provider/model" }` 只回傳已知資訊；不包含檔案大小、摘要、範本或授權。 |
| `POST /api/chat` | 使用 `system`、`user`、`assistant` 與 `tool` 訊息進行對話。 |
| `POST /api/generate` | 單一提示詞，可選 `system`。 |

其他所有 `/api/*` 路徑仍屬於 opencodex 管理 API。

## 支援的請求欄位

- `model`：`/api/tags` 中的名稱。
- `stream`：預設為 `true`（以換行分隔的 JSON）。設為 `false` 可取得單一 JSON 回應。
- `images`：使用者訊息（chat）或請求（generate）中的 base64 PNG、JPEG、GIF 或 WebP。
- `tools`（僅限 chat）：函式工具。請原樣回傳 assistant 訊息，包括每個呼叫的 `id`；`tool` 結果依
  `tool_call_id` 對應，沒有時依 `tool_name` 對應。
- `options`：`temperature`、`top_p`、`num_predict` 與 `stop`。
- `format`：僅支援 `"json"`。

每個 `/api/chat` 請求中，所有 assistant 訊息的**工具呼叫總數最多為 1,024 次**，已傳回結果的呼叫也計入總數。
超過上限時，請求會在傳送給供應商之前回傳 HTTP 400。請縮短對話歷史後重試，並將保留的工具結果與對應的
assistant 工具呼叫一起保留。

其他內容會以 HTTP 400 拒絕，而不是被忽略，包括 `think`、`keep_alive`、`suffix`、`raw`、
`template`、`context`、其他 `options`、JSON Schema 形式的 `format` 以及圖片 URL。不提供 Ollama 的模型管理與
嵌入端點。

組合、路由政策、`--fast` 或 effort 別名，以及會轉送呼叫者自身憑證的供應商，無法在這裡選擇。
這類請求會在向上游傳送任何內容之前失敗。

## 回應

完成的回覆帶有 `done: true`，`done_reason` 為 `stop`、`tool_calls` 或 `length`。
供應商回報用量時才會出現 `prompt_eval_count` 與 `eval_count`；不回報耗時欄位。串流會在上游回覆完全結束後
恰好傳送一行 `done: true`。

錯誤使用 Ollama 格式 `{ "error": "message" }` 並保留 HTTP 狀態，速率限制與忙碌拒絕時也會附上
`Retry-After`。因內容過濾或未知原因停止的回覆會以錯誤回傳，而不會當作正常停止。如果串流在開始後失敗，最後一行是
`error` 物件，之後不會有 `done: true` 行。

這些請求會像其他流量一樣出現在儀表板的請求記錄中，回應標頭 `x-opencodex-request-id` 指向對應的記錄列。
