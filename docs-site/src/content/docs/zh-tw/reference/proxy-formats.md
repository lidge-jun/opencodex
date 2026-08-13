---
title: 代理 API 格式
description: Responses、Chat Completions、Anthropic Messages、模型目錄、WebSocket、realtime 與 compaction 介面的 wire 層級參考。
---

opencodex 以多種客戶端方言呈現一個本機代理。Codex 客戶端可說 Responses API，OpenAI 相容的 app 可說 Chat Completions，而 Claude Code 可說 Anthropic Messages，而不需要每個上游供應商實作每種格式。

正常轉譯路徑為：

```text
客戶端方言 → 內部 Responses 模型 → 供應商 adapter → 供應商 wire 格式
供應商事件 → 內部 adapter 事件 → 客戶端方言
```

Responses 表示是橋接的中心。原生相容的路由可跳過部分轉譯並 passthrough 請求，但認證、路由、許可控制與回應安全仍在代理邊界發生。在[設定](/zh-tw/reference/configuration/)中設定監聽器與許可金鑰；當一個公開模型 id 應在多個目標間選擇時使用[組合](/zh-tw/guides/combos/)。

## 端點概覽

| 客戶端介面 | 端點 | 成功的非串流結果 | 成功的串流或 socket 結果 |
| --- | --- | --- | --- |
| OpenAI Responses | `POST /v1/responses` | Responses JSON | Responses SSE，或 WebSocket 上的 Responses JSON text frame |
| OpenAI Chat Completions | `POST /v1/chat/completions` | `chat.completion` JSON | `chat.completion.chunk` SSE，以 `[DONE]` 結束 |
| Anthropic Messages | `POST /v1/messages` | Anthropic `message` JSON | Anthropic Messages SSE |
| Anthropic token 計數 | `POST /v1/messages/count_tokens` | `{ "input_tokens": number }` | 不適用 |
| 模型探索 | `GET /v1/models` | 三種目錄契約之一 | 不適用 |
| 語音與 Realtime | `POST /v1/live`, `POST /v1/realtime/calls` | 中繼的 call-creation 回應 | 一個獨立的 sideband WebSocket 雙向中繼 frame |
| Responses compaction | `POST /v1/responses/compact` | 取代歷史 JSON | 不適用 |

## `POST /v1/responses`

這是原生 opencodex data-plane 結構。請求 body 必須是帶有非空 `model` 的 JSON 物件。`input` 可為字串或 Responses 項目陣列。

### 接受的請求欄位

| 區域 | 接受的結構 |
| --- | --- |
| 模型與輸入 | 必填的非空 `model`；可選字串 `input` 或項目陣列 |
| 訊息項目 | `user`、`developer`、`system` 與 `assistant` 訊息；字串內容或適合該角色的型別內容區塊 |
| 內容區塊 | Text、輸入圖片、輸入檔案、輸出文字、拒絕，以及 reasoning summary/text 區塊（在其父項目允許時） |
| 工具歷史 | `function_call`、`function_call_output`、`custom_tool_call` 與 `custom_tool_call_output` 項目 |
| 工具 | Function 工具加上鬆散的內建或代管工具項目；`tool_choice` 接受 `auto`、`none`、`required`、具名 function/custom 選擇、代管選擇或 `allowed_tools` |
| Reasoning | `reasoning.effort` 與 `reasoning.summary`（`auto`、`concise`、`detailed` 或 `none`） |
| 接續與快取 | `previous_response_id`、`store` 與 `prompt_cache_key` |
| 生成控制 | `max_output_tokens`、`temperature`、`top_p`、`stop`、`presence_penalty` 與 `frequency_penalty` |
| 服務與執行 | `stream`、`service_tier`、`parallel_tool_calls`、`instructions`、`metadata` 與 `user` |
| 延伸 Responses 欄位 | `background`、`include`、`prompt`、`text` 與 `truncation` 對相容路由被接受 |

未知的項目型別被接受為鬆散的型別項目以向前相容。轉譯的 adapter 僅處理它識別的項目型別，且可能拒絕其供應商無法表示的功能。

### JSON 與 SSE 輸出

在 `stream: true` 時，回應為 `text/event-stream`。橋接發出 Responses 事件如 `response.created`、output-item 與 text/tool delta，以及恰好一個終端 `response.completed`、`response.failed` 或 `response.incomplete` 事件。正常串流以 `data: [DONE]` 結束。

在 `stream: false` 或無 `stream` 時，相同的 adapter 事件被收集為一個 Responses JSON 物件。兩種形式都保留所選模型、輸出項目、終端狀態與 usage。

每個終端 Responses usage 物件都包含兩個 detail 物件，即使供應商未回報那些細節：

```json
{
  "input_tokens": 0,
  "output_tokens": 0,
  "total_tokens": 0,
  "input_tokens_details": { "cached_tokens": 0 },
  "output_tokens_details": { "reasoning_tokens": 0 }
}
```

可用時，`input_tokens_details` 亦可包含 `cache_write_tokens`。恆存在的 detail 物件是對嚴格 Responses 客戶端的相容性保證；零可能意指「未回報」，不一定是「供應商未執行此類工作」。

### 同路徑上的 WebSocket 升級

當 `websockets` 啟用時，客戶端可升級 `/v1/responses` 而非開啟 HTTP POST。認證與來源許可在 WebSocket 握手期間發生。它們不在每個 frame 內重複。

客戶端發送 JSON text frame：

```json
{
  "type": "response.create",
  "model": "provider/model",
  "input": "Hello",
  "tools": [],
  "generate": true
}
```

除了 `type` 之外的一切成為 Responses 請求 body，且代理為該回合強制串流。新的 `response.create` 取代並取消該 socket 上的前一個回合。
`response.processed` 被接受為 no-op 確認。無法解析或不相關的 frame 型別被忽略。

伺服器 frame 為 JSON text frame。成功的串流輸出使用會出現在 SSE `data:` 列中的相同 JSON payload，而無 SSE 封裝或 `[DONE]`。非串流的內部結果被重新框架為 `response.created`、零或多個 `response.output_item.done` frame，然後是終端 frame。錯誤使用此封裝：

```json
{
  "type": "error",
  "status": 502,
  "error": {
    "type": "upstream_error",
    "message": "..."
  },
  "headers": {}
}
```

帶有 `generate: false` 的暖機 frame 不呼叫上游。它回傳合成的
`response.created` 後接 `response.completed`，兩者皆有空的回應 id 且無輸出。

:::note
當 WebSocket 停用時，升級嘗試收到附帶代碼 `upgrade_required` 的 HTTP 426。Codex 將該握手結果視為回退到該 session 的 HTTP 的信號。它不是失敗的模型回合。
:::

## `POST /v1/chat/completions`

此端點接受帶有必填 `model` 與非空 `messages` 陣列的 OpenAI 相容 Chat Completions 請求。它將 system、user、assistant 與 tool 訊息轉譯為內部 Responses 項目；轉譯 function 工具、tool choice、圖片、reasoning effort 與支援的回應格式；執行正常 Responses 路由管線；然後將結果轉譯回來。

結構化輸出是該轉譯的一部分：帶 `json_object` 或 `json_schema` 的 `response_format` 被轉發到路由的 `openai-chat` 模型。在 `POST /v1/responses` 上，等效請求欄位是 `text.format`：原生 Responses 路由在原始 Responses body 中保留它，並在模型路由到 `openai-chat` 供應商時轉譯為 `response_format`。列在供應商 `noStructuredOutputModels` 中的模型會在該 chat wire 上省略 `response_format`；同儕模型保留轉譯。未分類的後端收到該欄位並回傳自己的錯誤，而非由代理猜測其能力。

非串流輸出有 `object: "chat.completion"`。串流輸出使用帶有
`object: "chat.completion.chunk"`、choice delta、帶有 `finish_reason` 的終端 choice 與
`data: [DONE]` 的 SSE 物件。Tool-call 與 usage 資訊在來源事件帶有它們時被轉譯回來。

由於內部執行路徑基於 Responses，供應商 adapter 可施加較窄的功能集。例如，所選 adapter 無法表示的請求功能以錯誤回傳，而非靜默變更其意義。

## `POST /v1/messages` 與 `count_tokens`

這些端點說 Claude Code 與相容客戶端使用的 Anthropic Messages 方言。多數請求被轉譯為 Responses、正常路由，然後轉譯回 Anthropic JSON 或 Anthropic SSE。

原生 Anthropic passthrough 僅在以下全部為真時合格：

- 原生 passthrough 未在 Claude Code 設定中被停用；
- 請求的模型以 `claude` 或 `anthropic` 開頭；
- 請求帶有原生 Anthropic bearer 或 `x-api-key` 憑證；
- 在非回環 listener 上，請求還只透過 `x-opencodex-api-key` 攜帶有效代理許可；且
- 無設定的別名或模型映射為路由目標聲明該模型 id。

合格的請求以 Anthropic 方言轉發，使原生 beta 標頭、thinking 簽章與訂閱身分保持端到端。否則它走 Responses 往返。

專用許可標頭絕不轉發。`Authorization` 或 `x-api-key` 中的代理許可密鑰也會被移除，
而另一標頭中的真正 Anthropic 憑證會保留。以逗號合併的模糊憑證標頭會 fail closed。

`POST /v1/messages/count_tokens` 遵循相同的模型解析與 passthrough 決策。原生合格的請求被轉發到 Anthropic 的計數端點。其他請求使用基於 system 內容、訊息與工具的本機檔案式估計並回傳：

```json
{ "input_tokens": 123 }
```

## `GET /v1/models`

相同路由服務三個期待不相容目錄封裝的客戶端。除非也存在 `client_version`，否則 Anthropic flavor 勝出。

| 契約 | 觸發 | 頂層結構 | 模型 id 行為 |
| --- | --- | --- | --- |
| Anthropic 模型清單 | `anthropic-version` 標頭或 `?flavor=anthropic`，無 `client_version` | `{ "data": [...] }` 含 Anthropic model-info 項目 | Claude Code 收到可讀 id；Desktop 可收到其設定檔專屬的別名家族 |
| Codex 目錄 | `client_version` query 參數 | `{ "models": [...] }` | 原生與路由項目帶有更豐富的 Codex 目錄欄位、可見性、effort、WebSocket 與多代理中繼資料 |
| 普通 OpenAI 清單 | 無觸發 | `{ "object": "list", "data": [...] }` | 可見的原生 id 為裸 id；路由 id 為別名或 `provider/model` |

## `POST /v1/live` 與 Realtime sideband

`POST /v1/live` 接受 ChatGPT/Codex App Frameless call-creation 介面。
`POST /v1/realtime/calls` 接受 OpenAI Realtime call-creation 介面。opencodex 選擇一個合格的 OpenAI 家族路由、為上游認證模式正規化 call-creation 請求，並中繼有界的回應。

在 call 建立後，客戶端可使用任何支援的入站形式加入 sideband WebSocket：

- `/v1/live/{callId}`
- `/v1/realtime/calls/{callId}`
- `/v1/realtime?call_id={callId}`

代理正規化上游 join URL，然後雙向透明中繼 text 與 binary frame。客戶端協定標頭被保留，而上游認證保持代理擁有。

## `POST /v1/responses/compact`

Compaction 為需要縮短長 Responses 對話的客戶端回傳取代歷史。

| 路由型別 | 行為 |
| --- | --- |
| 規範 ChatGPT 或官方 OpenAI 路由 | 以解析的帳號與模型認證將請求轉發到原生 `/responses/compact` 端點 |
| 其他路由模型 | 執行一個內部、非串流、無工具的 compaction 回合，帶有 `compaction_trigger`；需要恰好一個合成的 `compaction` 項目，其 `encrypted_content` 為 `ocx1:` 封裝；將該摘要解碼為 v1 取代歷史 |

原生 compact 回應以 32 MiB 上限緩衝，包含其宣告的 `Content-Length` 已超過限制的回應。Compact 專屬失敗包含：

| 狀態 | 型別或代碼 | 意義 |
| --- | --- | --- |
| 400 | `invalid_request_error` | 無效 JSON/body 結構或缺失模型 |
| 404 | `invalid_request_error` | 請求的模型無法被路由 |
| 499 | `client_cancelled` | 客戶端在中繼或緩衝時取消 |
| 502 | `compact_response_too_large` | 原生 compact 輸出超過 32 MiB |
| 502 | `upstream_error` | 連線、讀取或合成 compaction 回合失敗 |
| 502 | `invalid_response_error` | 合成回合未產生恰好一個有效、非空的 `ocx1:` compaction 項目 |

## 認證矩陣

在僅回送綁定上，data-plane 許可不需要設定的金鑰。在遠端綁定上，請使用下方矩陣。「專屬」意指 `X-OpenCodex-API-Key`；其他欄意指 `Authorization: Bearer ...` 與 `x-api-key`。

| 介面 | 專屬 | Bearer | `x-api-key` |
| --- | --- | --- | --- |
| `/v1/responses` HTTP 與 WebSocket | 必填 | 代理許可被拒 | 被拒 |
| `/v1/responses/compact` | 必填 | 代理許可被拒 | 被拒 |
| `/v1/chat/completions` | 必填 | 代理許可被拒 | 被拒 |
| `/v1/messages` 與 `/v1/messages/count_tokens` | 接受 | 接受 | 接受 |
| `/v1/models` | 接受 | 接受 | 接受 |
| `/v1/live`、`/v1/realtime/calls` 與 sideband join | 接受 | 接受 | 接受 |

Responses 家族與 Chat 請求為供應商或 Codex Direct passthrough 保留 `Authorization`，因此遠端代理金鑰必須使用專屬標頭。Messages 與 Realtime 介面需要更廣的客戶端相容性，因此接受所有三種形式。

:::caution
Data-plane 金鑰不是管理憑證。管理 API 使用獨立的管理秘密；請見[管理 API](/zh-tw/reference/management-api/)。絕不為兩個平面重用同一個秘密。
:::

## 常見錯誤詞彙

錯誤在需要時使用客戶端方言的封裝，但這些狀態／代碼意義是穩定的：

| 狀態 | 型別或代碼 | 意義 |
| --- | --- | --- |
| 401 | `authentication_error` | 必填的代理許可憑證缺失或無效 |
| 403 | `origin_rejected` | Responses/OpenAI data-plane 請求或 WebSocket 升級來自不允許的來源 |
| 503 | `combo_unavailable` | 所選組合中的每個目標都不可用、在冷卻中、停用或因其他原因不合格 |
| 400 | `unreadable_encrypted_agent_task` | 加密的 v2 worker task 沒有可消耗它的合格原生 ChatGPT 目標 |
| 426 | `upgrade_required` | Responses WebSocket 傳輸被停用或升級失敗；請使用 HTTP |

Anthropic 來源的失敗以 Anthropic 的錯誤封裝渲染，因此該方言上的來源拒絕是 403 `permission_error`，而非 OpenAI 風格的 `origin_rejected` body。

## 加密內容衛生

代理將真實的後端密文視為不透明。結構有效的密文被逐位元組保留：opencodex 不解密它、轉譯其內容，或為另一個供應商重新加密它。

某些 agent hook 在歷史上曾將明文控制文字放入 `encrypted_content` 插槽。為相容性，代理將該明文分離為 text 部分，同時保留任何結構有效的 Fernet run 不變。若 `agent_message` 在該修復期間失去所有加密部分，它成為普通使用者訊息。若目前的 v2 task 保持真正加密但所選路由目標無法讀取原生 ChatGPT 密文，opencodex 以 `unreadable_encrypted_agent_task` 失敗，而非發送不可讀的位元組給該供應商。關於 worker task 周圍的客戶端行為，請見[子代理介面](/zh-tw/guides/sub-agent-surface/)。
