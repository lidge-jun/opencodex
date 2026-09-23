---
title: Factory Droid 橋接
description: 透過本機 Responses 相容橋接，將 Factory Droid 模型連接至 opencodex。
---

Factory Droid 是代理執行環境，不是有公開文件的 OpenAI 相容推論端點。如果指向 Factory 內部 LLM URL 的自訂 provider 回傳 `403 Forbidden`，只變更 opencodex adapter 或增加 provider 標頭，不會讓這條私有路由變成受支援的公開 API。

可運作的整合方式如下：

```text
Text-only Responses client
  -> opencodex (http://127.0.0.1:10100/v1/responses)
  -> local Responses bridge (http://127.0.0.1:11435/v1/responses)
  -> official droid exec command
  -> Factory account and selected model
```

這會讓 Factory 憑證留在官方 Droid 用戶端。OpenCodex 使用另一把只供本機橋接使用的 token。

## 失敗原因與修正方式

| 症狀 | 原因 | 修正方式 |
| --- | --- | --- |
| Factory LLM URL 回傳 `403 Forbidden` | 該 URL 不是有文件的第三方用戶端通用 OpenAI 端點 | 透過官方 Droid CLI 或 SDK 呼叫 Factory |
| `/models/models` 回傳 `404` | provider base URL 已以 `/models` 結尾 | 將 API 根路徑用作 `baseUrl`，不要包含探索路徑 |
| 模型搜尋失敗 | 橋接未公開完整的即時目錄 | 設定 `liveModels: false` 並提供靜態 `models` 清單 |
| loopback provider 遭拒 | 預設拒絕私有網路存取 | 只對 loopback 橋接設定 `allowPrivateNetwork: true` |
| `${DROID_BRIDGE_TOKEN}` 無法解析 | opencodex 服務環境中缺少此變數 | 將它注入服務程序，而非只設定於互動式 shell |
| `OutputTextDelta without active item` | 橋接在開啟輸出項目與內容部分之前就送出文字增量 | 依序送出完整的 Responses SSE 生命週期 |

因此，同一 Factory 憑證可能可用於 `droid exec`，但直接請求無文件的 LLM URL 仍回傳 `403`。兩項結果測試的是不同產品，並不矛盾。

## 前置條件

1. 安裝 [Droid CLI](https://docs.factory.ai/droid-cli/quickstart) 並登入。
2. 確認有界的無介面請求可運作：

   ```bash
   droid exec --model glm-5.2 --output-format json "Reply with DROID_OK only."
   ```

3. 執行呼叫 `droid exec`（或官方 Droid SDK）的本機橋接，並公開：

   - `GET /healthz`
   - `GET /v1/models`
   - `POST /v1/responses`

Factory 將 `droid exec` 列為非互動式自動化介面，並建議指令碼使用 JSON 輸出。對於長期運作的整合，Factory 也在 [Droid Exec 指南](https://docs.factory.ai/droid-exec/overview)中介紹串流 JSON-RPC，以及官方 TypeScript 與 Python SDK。

## 橋接契約

將橋接綁定到 `127.0.0.1`，要求隨機產生的 bearer token、限制請求大小，並將模型 ID 納入 allowlist。最小橋接只接受以下 Responses `input` 形式：

- 非空字串；或
- 只包含 `message` 項目的陣列。每則訊息的角色必須是 `user`、`developer`、`system` 或 `assistant`，內容必須是字串，或只含文字內容部分（輸入角色使用 `input_text`，assistant 歷史使用 `output_text`）。

呼叫 Droid 前應驗證完整請求。如果輸入部分是圖片或檔案，`tools` 包含任何工具定義，或 `input` 包含工具呼叫或結果（`function_call`、`function_call_output`、`custom_tool_call` 或 `custom_tool_call_output`），應回傳 HTTP `400`，並附上 Responses 風格的 `invalid_request_error`。使用穩定且橋接專用的代碼，例如 `unsupported_bridge_input`，並在訊息中指出遭拒欄位。即使 `stream: true`，也必須在啟動 SSE 前完成；絕不可把不支援的內容丟棄、轉成字串或攤平成提示詞。

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "unsupported_bridge_input",
    "param": "tools",
    "message": "The minimal Droid bridge does not accept tool definitions."
  }
}
```

對於接受的請求，橋接應：

1. 將接受的 Responses `input` 轉成提示詞。
2. 呼叫 `droid exec --model <id> --output-format json <prompt>`；
3. 解析最終的 `result` 與 `session_id`；
4. 回傳 OpenAI Responses envelope；以及
5. 需要接續時，將 `previous_response_id` 對應到 Droid session ID。

對串流回應，應依序送出以下生命週期：

```text
response.created
response.output_item.added
response.content_part.added
response.output_text.delta
response.output_text.done
response.content_part.done
response.output_item.done
response.completed
```

不要將橋接暴露在 `0.0.0.0`，也不要重用 Factory 憑證作為橋接 bearer token。

## OpenCodex provider 設定

使用明確的 provider ID `droid` 建立自訂 provider：

```bash
ocx provider add droid \
  --adapter openai-responses \
  --base-url http://127.0.0.1:11435/v1 \
  --default-model glm-5.2 \
  --allow-private-network
```

這會建立 `providers.droid` 設定項目。在儀表板開啟 **Providers → droid → Edit JSON**，並將該 provider 的值替換為：

```json
{
  "adapter": "openai-responses",
  "baseUrl": "http://127.0.0.1:11435/v1",
  "responsesPath": "/responses",
  "allowPrivateNetwork": true,
  "authMode": "key",
  "apiKey": "${DROID_BRIDGE_TOKEN}",
  "liveModels": false,
  "models": ["glm-5.2", "glm-5.2-fast", "kimi-k3"],
  "defaultModel": "glm-5.2"
}
```

模型 ID 僅供示例。只保留已登入 Factory 帳號可透過 `droid exec` 使用的模型。不要為此 provider 增加 Factory 專用推論標頭：其上游是本機橋接，不是 Factory HTTP 端點。

儲存 provider 或變更靜態目錄後，請同步並重新啟動 Codex，讓新工作階段讀取更新後的目錄：

```bash
ocx sync --restart-codex
ocx doctor
```

`--restart-codex` 會重新啟動符合條件的 app-server，並完全退出及重新開啟 Codex 桌面應用程式，結束即時對話。使用 `--restart-app-server-only` 可讓桌面應用程式保持執行。請在完成或儲存那些工作階段後才重新啟動。

## 驗證完整路由

分別檢查每個邊界：

```bash
curl -fsS http://127.0.0.1:11435/healthz
ocx doctor
ocx access test droid/glm-5.2 --protocol responses
```

provider 資料列或模型選擇器項目只證明目錄中看得到模型。只有 Responses 探測成功經由 `droid/<model>` 路由返回，整合才算運作。

## 目前限制

上述最小橋接只轉譯文字與 Responses SSE 生命週期，**沒有**實作完整的雙向 Codex function／tool call 協定。即使提示詞要求不要呼叫工具，Codex App 與 `codex exec` 通常仍會送出工具定義；目前 Codex CLI 也沒有能移除這些定義的通用旗標。最小橋接必須依上述 `400` 契約拒絕這些請求。工具定義、工具呼叫、工具結果、權限、取消及豐富的 Droid 事件，需要以 Factory 串流 JSON-RPC 模式或官方 Droid SDK 建立具狀態的橋接。請將 `ocx access test` 成功視為文字路徑驗證，而非 Codex 代理或工具路徑的驗證。
