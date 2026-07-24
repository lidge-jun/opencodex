---
title: Adapters
description: Provider adapter 的目标、请求构建方式与各自特性。
---

**adapter** 负责在 opencodex 的内部请求/响应模型与某个 provider 的 wire 格式之间转换。每个
adapter 都实现 `ProviderAdapter` 接口（`src/adapters/base.ts`）：

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

`buildRequest` 把 `OcxParsedRequest` 转成上游 HTTP 请求；`parseStream` / `parseResponse` 把 provider
回复转回内部 `AdapterEvent`。`fetchResponse` 允许 adapter 自己负责重试和 timeout；`runTurn` 支持
无法表示成一次 HTTP fetch 加一条响应流的 transport。随后
[`bridge.ts`](/zh-cn/reference/architecture/#桥接器) 把 event 转成 Responses SSE。

## `openai-chat`

**目标：** OpenAI **Chat Completions**（`POST {baseUrl}/chat/completions`）以及所有兼容 provider，
包括 xAI、Kimi、DeepSeek、GLM、Groq、OpenRouter、Ollama（本地与云端）等。
**认证：** `key`（Bearer）。

- 把内部消息转换成 OpenAI role；工具映射为 `{type:"function", function:{…}}` 和
  `tool_choice`（`auto`/`none`/`required` 或具名函数）。
- **重写 Codex 的 GPT-5 身份提示词**，改成与模型无关的介绍，避免路由模型自称 OpenAI。
- 精确层级不可用时，**把 `reasoning_effort` 限制到模型公布的子集**。除非 provider 显式配置
  alias，`xhigh` 与 `max` 保持为不同标签。对于 `provider.noReasoningModels` 中的 id，则**完全
  省略**该参数。
- 流式输出 `delta.content`（文本）、`delta.reasoning_content`（thinking）和
  `delta.tool_calls[]`，并收集 `usage`。

## `openai-responses`

**目标：** OpenAI **Responses API**。**`passthrough: true`** —— 转发原始请求 body，并把响应
**不经转换**地流式传回。
**认证：** `forward`（转发调用方 header）或 `key`。

- `forward` URL → `{baseUrl}/responses`。`key` provider 默认保留原有的 `{baseUrl}/v1/responses` 构造。
- `key` provider 可设置经过验证的相对 `responsesPath`；adapter 会移除 `baseUrl` 末尾的一个 `/`，并向 `{trimmedBaseUrl}{responsesPath}` 发送请求。Ark Agent Plan 使用 `baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3"` 和 `responsesPath: "/responses"`。
- `forward` 模式只会转发安全的 header allowlist（`FORWARD_HEADERS`）：authorization、ChatGPT
  account id 和 OpenAI beta/originator/session header。这条 ChatGPT 登录路径也为
  [sidecar](/zh-cn/guides/sidecars/) 提供支持。

## `anthropic`

**目标：** Anthropic **Messages**（`/v1/messages`）。
**认证：** `key`（`x-api-key`）或 `oauth`（Bearer + `anthropic-beta`，用于 Claude Pro/Max）。

- 把消息转换成 Anthropic content block（text、base64 image、`tool_use`、`thinking`）。
- **Extended thinking 计算：** Anthropic 要求 `max_tokens > thinking.budget_tokens`。adapter 把
  reasoning effort 映射成 budget（minimal 1024 … max 32000），再计算留有输出余量的安全
  `max_tokens`；启用 thinking 后会**移除 `temperature`/`top_p`**，因为 Anthropic 禁止此组合。
- 始终发送 `anthropic-version: 2023-06-01`。流式输出
  `content_block_delta`（`text_delta`、`thinking_delta`、`input_json_delta`）。

## `google`

**目标：** Google **Gemini**、**Vertex AI** 和 Antigravity **Cloud Code Assist**。AI Studio 使用
`/v1beta/models/{model}:streamGenerateContent`，其他模式使用各自的 Google 原生 endpoint。
**认证：** 根据 `googleMode` 选择 API key、Vertex ADC 或 Google Antigravity OAuth。

- 系统提示词 → `systemInstruction`；消息 → `contents[]`（assistant → `model`）；工具 →
  `functionDeclarations`；data URL 图像 → `inline_data`。
- Gemini 省略 tool-call id 时会合成 id。Antigravity 会保留并重放真实 `thoughtSignature`，使
  reasoning continuity 延续到后续 turn。

## `kiro`

**目标：** Kiro 使用的 Amazon CodeWhisperer Streaming `GenerateAssistantResponse` 服务
（`https://runtime.{region}.kiro.dev/`）。
**认证：** Kiro credential 中的 region/profile metadata，加上作为 Bearer 的 Kiro OAuth access
token。

- 构建 Kiro `conversationState`，映射 Codex 工具和工具结果，并发送 Kiro wire 支持的 image block。
- 解码 `application/vnd.amazon.eventstream`，重建 text/thinking/tool event，检测被截断的工具
  JSON。上游不返回 token 数量，因此 usage 采用估算值。
- 经 `fetchResponse` 负责有界重试和分类/脱敏后的错误；非流式 parser 会排空同一 event stream，
  供 web-search loop 使用。

## `cursor`

**目标：** `api2.cursor.sh` 上采用 HTTP/2 Connect streaming 的
`agent.v1.AgentService/Run`。
**认证：** `provider.apiKey` 或转发 authorization header 中的 Cursor OAuth/access token。

- 使用 `runTurn`，而不是常规 fetch/parse 路径。请求、server event、工具参数、usage checkpoint
  和 client reply 由 `cursor/gen/agent_pb.ts` 中的 `@bufbuild/protobuf` schema 编码，并 frame 成
  Connect message。
- 经 content-addressed blob 重放对话状态，把 server tool call 映射回 Codex，用 protobuf
  `GetUsableModels` RPC 发现实时 Cursor 模型，并且只在 run request 尚未 commit 到 wire 前重试。
- Cursor 原生本地 filesystem/shell/network 执行默认被拒绝。显式 `mcpServers` 与
  `desktopExecutor` 集成分别需要 opt-in；`unsafeAllowNativeLocalExec` 会启用更广泛的内置
  executor，并绕过 Codex 审批和 sandbox 语义。

## `azure-openai`（别名：`azure`）

**目标：** **Azure OpenAI**。封装 `openai-responses`，因此同样是 `passthrough: true`。
**认证：** 用 `api-key` header 进行 `key` 认证，而非 Bearer。

- 把请求构建交给 Responses passthrough，验证 `baseUrl` 不含未解析的 template placeholder，
  再用 `api-key` 替换 `Authorization`。配置的 URL 直接指向 Azure v1 Responses API，因此 adapter
  不会追加 `api-version`。

## `open2-beta`

**目标：** 使用 `solar-chat.v1` WebSocket frame 的 Upstage Open2 公测 Web 客户端。
**认证：** 通过 `GET /api/session` 自动创建和刷新匿名 `solar_session` cookie；目前不需要 API key。
即使配置了 API key，adapter 也会忽略它，绝不会把它复用为 HTTP 或 WebSocket cookie。

- 这是连接 private-beta Web protocol 的非官方 bridge，并非稳定的公开 API。仅在匿名公测开放期间
  暂时免费且无需 key；Upstage 可能随时更改、限制、要求认证或移除它。
- 使用 `runTurn` 管理 WebSocket lifecycle，并验证 ready protocol 和 event sequence。独立的累计
  usage snapshot 会保留，并与最终 usage 合并而不重复计数。
- 刷新的 session cookie 只保存在进程内存中，不会持久化；OpenCodex 重启后即丢失。
- `none` 是关闭 reasoning 的 sentinel。catalog 只公布 `medium`、`high`、`max`；`low`/`minimal`
  映射到 `medium`，`xhigh` 映射到 `high`。
- `runTurn` 绕过 sidecar，因此不会公布 hosted web search。当前 upstream wire 也不支持 Codex client
  tool 或 native vision。
- 配置 outbound HTTP(S) proxy 时会 fail closed，避免 WebSocket 绕过 proxy。只有确实需要直接连接时，
  才应把 Open2 host 加入 `NO_PROXY`。

## 图像工具（`image.ts`）

支持视觉的 adapter 共用以下 helper：

- `parseDataUrl(url)` —— 把 `data:<type>;base64,<data>` URL 拆成 `{ mediaType, base64 }`，供
  Anthropic/Google image block 使用。
- `contentPartsToText(content)` —— 为纯文本工具消息把 content part 扁平化成文本。未描述的图像
  会变成简短的 `[image]` marker，而不是导致 token 暴涨的 base64 blob。
