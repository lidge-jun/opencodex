---
title: 轉接器
description: 七個 provider adapter 的目標、請求建置方式與各自特性。
---

**adapter** 負責在 opencodex 的內部請求/回應模型與某個 provider 的 wire 格式之間轉換。每個
adapter 都實作 `ProviderAdapter` 介面（`src/adapters/base.ts`）：

```ts
interface ProviderAdapter {
  name: string;
  buildRequest(parsed, incoming?): AdapterRequest | Promise<AdapterRequest>;
  fetchResponse?(request, context): Promise<Response>;   // custom retry/transport
  parseStream(response): AsyncGenerator<AdapterEvent>;
  parseResponse?(response): Promise<AdapterEvent[]>;   // non-streaming
  runTurn?(parsed, incoming, emit): Promise<void>;      // bidirectional transport
}
```

`buildRequest` 把 `OcxParsedRequest` 轉成上游 HTTP 請求；`parseStream` / `parseResponse` 把 provider
回覆轉回內部 `AdapterEvent`。`fetchResponse` 允許 adapter 自己負責重試和 timeout；`runTurn` 支援
無法表示成一次 HTTP fetch 加一條回應流的 transport。隨後
[`bridge.ts`](/zh-tw/reference/architecture/#橋接器) 把 event 轉成 Responses SSE。

## `openai-chat`

**目標：** OpenAI **Chat Completions**（`POST {baseUrl}/chat/completions`）以及所有相容 provider，
包括 xAI、Kimi、DeepSeek、GLM、Groq、OpenRouter、Ollama（本機與雲端）等。
**認證：** `key`（Bearer）。

- 把內部訊息轉換成 OpenAI role；工具對映為 `{type:"function", function:{…}}` 和
  `tool_choice`（`auto`/`none`/`required` 或具名函式）。
- **重寫 Codex 的 GPT-5 身份提示詞**，改成與模型無關的介紹，避免路由模型自稱 OpenAI。
- 精確層級不可用時，**把 `reasoning_effort` 限制到模型公佈的子集**。除非 provider 顯式設定
  alias，`xhigh` 與 `max` 保持為不同標籤。對於 `provider.noReasoningModels` 中的 id，則**完全
  省略**該引數。
- 流式輸出 `delta.content`（文字）、`delta.reasoning_content`（thinking）和
  `delta.tool_calls[]`，並收集 `usage`。

## `openai-responses`

**目標：** OpenAI **Responses API**。**`passthrough: true`** —— 轉發原始請求 body，並把回應
**不經轉換**地流式傳回。
**認證：** `forward`（轉發呼叫方 header）或 `key`。

- DeepSeek 的 stateless Responses parser 會收到按 provider 範圍的歷史正規化：hook 注入的內容會移動到
  明確的 tool-call/result 批次之後。並行呼叫保持在其對應輸出之前分組，因此每個呼叫都留在承載
  推理的 assistant 回合中。寬容的 provider 和歧義的（重複、缺失或亂序的）call ID 保留原始輸入順序。

- `forward` URL → `{baseUrl}/responses`。`key` provider 預設保留原有的 `{baseUrl}/v1/responses` 構造。
- `key` provider 可設定經過驗證的相對 `responsesPath`；adapter 會移除 `baseUrl` 末尾的一個 `/`，並向 `{trimmedBaseUrl}{responsesPath}` 傳送請求。Ark Agent Plan 使用 `baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3"` 和 `responsesPath: "/responses"`。
- `forward` 模式只會轉發安全的 header allowlist（`FORWARD_HEADERS`）：authorization、ChatGPT
  account id 和 OpenAI beta/originator/session header。這條 ChatGPT 登入路徑也為
  [sidecar](/zh-tw/guides/sidecars/) 提供支援。

## `anthropic`

**目標：** Anthropic **Messages**（`/v1/messages`）。
**認證：** `key`（`x-api-key`）或 `oauth`（Bearer + `anthropic-beta`，用於 Claude Pro/Max）。

- 把訊息轉換成 Anthropic content block（text、base64 image、`tool_use`、`thinking`）。
- **Extended thinking 計算：** Anthropic 要求 `max_tokens > thinking.budget_tokens`。adapter 把
  reasoning effort 對映成 budget（minimal 1024 … max 32000），再計算留有輸出餘量的安全
  `max_tokens`；啟用 thinking 後會**移除 `temperature`/`top_p`**，因為 Anthropic 禁止此組合。
- 始終傳送 `anthropic-version: 2023-06-01`。流式輸出
  `content_block_delta`（`text_delta`、`thinking_delta`、`input_json_delta`）。

## `google`

**目標：** Google **Gemini**、**Vertex AI** 和 Antigravity **Cloud Code Assist**。AI Studio 使用
`/v1beta/models/{model}:streamGenerateContent`，其他模式使用各自的 Google 原生 endpoint。
**認證：** 根據 `googleMode` 選擇 API key、Vertex ADC 或 Google Antigravity OAuth。

- 系統提示詞 → `systemInstruction`；訊息 → `contents[]`（assistant → `model`）；工具 →
  `functionDeclarations`；data URL 圖像 → `inline_data`。
- Gemini 省略 tool-call id 時會合成 id。Antigravity 會保留並重放真實 `thoughtSignature`，使
  reasoning continuity 延續到後續 turn。

## `kiro`

**目標：** Kiro 使用的 Amazon CodeWhisperer Streaming `GenerateAssistantResponse` 服務
（`https://runtime.{region}.kiro.dev/`）。
**認證：** Kiro credential 中的 region/profile metadata，加上作為 Bearer 的 Kiro OAuth access
token。

- 建置 Kiro `conversationState`，對映 Codex 工具和工具結果，併傳送 Kiro wire 支援的 image block。
- 解碼 `application/vnd.amazon.eventstream`，重建 text/thinking/tool event，檢測被截斷的工具
  JSON。上游不回傳 token 數量，因此 usage 採用估算值。
- 經 `fetchResponse` 負責有界重試和分類/脫敏後的錯誤；非流式 parser 會排空同一 event stream，
  供 web-search loop 使用。

### 完成與原生 stop reason

Kiro 的 assistant 文字本身沒有可靠的回合結束標記，但終止的 `metadataEvent` 可能帶有原生 `stopReason`。
`END_TURN` 和 `STOP_SEQUENCE` 視為權威結束，其文字直接作為最終回答發出，不再額外往返模型。

只有在 stop reason **缺失**時才走相容路徑。任何顯式原因都已在上游終止了本次推理，因此適配器直接報告而不是
再發一次請求：輸出 token 上限表現為可繼續的 incomplete，上下文視窗耗盡表現為不可重試的 context-length
錯誤，內容過濾或 guardrail 停止表現為 filtered incomplete。沒有真實工具呼叫卻出現的 `TOOL_USE` 被視為
矛盾而非進展。

只有完全沒有 stop reason 時，opencodex 才新增私有的 `codex_kiro_final_answer` 工具並做一次續寫。
重複抑制嚴格限定為空白歸一化後的完全一致：改寫過的狀態更新可能改變本回合的結果（從"仍在進行"變成"已完成"），
丟掉那句話比顯示一次表面重複更糟糕。

### Reasoning effort

`gpt-5.6-sol` 和 `claude-opus-5` 支援原生 effort，且請求欄位名不同。`low` / `medium` / `high` /
`xhigh` / `max` 分別透過 `additionalModelRequestFields.reasoning.effort` 和
`output_config.effort` 傳送。


## `cursor`

**目標：** `api2.cursor.sh` 上採用 HTTP/2 Connect streaming 的
`agent.v1.AgentService/Run`。
**認證：** `provider.apiKey` 或轉發 authorization header 中的 Cursor OAuth/access token。

- 使用 `runTurn`，而不是常規 fetch/parse 路徑。請求、server event、工具引數、usage checkpoint
  和 client reply 由 `cursor/gen/agent_pb.ts` 中的 `@bufbuild/protobuf` schema 編碼，並 frame 成
  Connect message。
- 經 content-addressed blob 重放對話狀態，把 server tool call 對映回 Codex，用 protobuf
  `GetUsableModels` RPC 發現即時 Cursor 模型，並且只在 run request 尚未 commit 到 wire 前重試。
- Cursor 原生本機 filesystem/shell/network 執行預設被拒絕。顯式 `mcpServers` 與
  `desktopExecutor` 整合分別需要 opt-in；`unsafeAllowNativeLocalExec` 會啟用更廣泛的內建
  executor，並繞過 Codex 審批和 sandbox 語義。

## `azure-openai`（別名：`azure`）

**目標：** **Azure OpenAI**。封裝 `openai-responses`，因此同樣是 `passthrough: true`。
**認證：** 用 `api-key` header 進行 `key` 認證，而非 Bearer。

- 把請求建置交給 Responses passthrough，驗證 `baseUrl` 不含未解析的 template placeholder，
  再用 `api-key` 替換 `Authorization`。設定的 URL 直接指向 Azure v1 Responses API，因此 adapter
  不會追加 `api-version`。

## 圖像工具（`image.ts`）

支援視覺的 adapter 共用以下 helper：

- `parseDataUrl(url)` —— 把 `data:<type>;base64,<data>` URL 拆成 `{ mediaType, base64 }`，供
  Anthropic/Google image block 使用。
- `contentPartsToText(content)` —— 為純文字工具訊息把 content part 扁平化成文字。未描述的圖像
  會變成簡短的 `[image]` marker，而不是導致 token 暴漲的 base64 blob。
