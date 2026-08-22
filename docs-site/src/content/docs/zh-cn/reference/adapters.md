---
title: Adapters
description: 七个 provider adapter 的目标、请求构建方式与各自特性。
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
- **工具结果中的图片**会在工具轮次结束后，作为后续 user vision 消息（`image_url` 部分）发送，
  因为 `role:"tool"` 的内容只能是文本；`[image]` 标记仍保留在工具消息中作为锚点。
- **重写 Codex 的 GPT-5 身份提示词**，改成与模型无关的介绍，避免路由模型自称 OpenAI。
- 精确层级不可用时，**把 `reasoning_effort` 限制到模型公布的子集**。除非 provider 显式配置
  alias，`xhigh` 与 `max` 保持为不同标签。对于 `provider.noReasoningModels` 中的 id，则**完全
  省略**该参数。
- 流式输出 `delta.content`（文本）、`delta.reasoning_content`（thinking）和
  `delta.tool_calls[]`，并收集 `usage`。
- ClinePass 使用经实时验证的网关格式 `reasoning: { enabled: true, effort }`；关闭 reasoning 时使用
  `{ enabled: false }`。其公开 API 文档目前没有说明这一请求格式。adapter 会保留请求的 `low`、
  `medium`、`high`、`xhigh` 或 `max` 档位，把 `delta.reasoning_content` 或 `delta.reasoning`
  作为 reasoning delta，通过 `stream_options.include_usage` 请求流式 usage，并从非流式响应 envelope 中读取 usage。

## `openai-responses`

**目标：** OpenAI **Responses API**。**`passthrough: true`** —— 通常原样转发请求与响应，仅对
路由网关应用范围有限的兼容性转换。
**认证：** 规范 OpenAI `forward` 只转发安全的调用方 header allowlist；非规范 `forward` 不会
转发调用方 authorization，只使用已配置的静态 header；`key` 使用已配置的 provider key。

对于非规范 Responses 网关，Codex 的客户端执行型 `tool_search` 声明会作为公共 function tool
以不与现有 function 名称冲突的方式发送；匹配的请求历史和 JSON/SSE function call 会恢复为
客户端私有的 `tool_search` 生命周期。规范 OpenAI forward 路径仍保持原生私有类型不变。

使用 `key` 认证时，[`retryOn429`](/zh-cn/reference/configuration/) 同样适用：流开始前的 429
会等待并先于其他处理或故障转移，在相同 key 上重放完全相同请求，与翻译后的
`openai-chat`/Anthropic 请求路径一致。自定义 `runTurn` 传输不在 HTTP 重试循环之内。

- DeepSeek 的 stateless Responses parser 会收到按 provider 范围的历史归一化：hook 注入的上下文会移动到
  明确的 tool-call/result 批次之后。并行调用保持在其对应输出之前分组，因此每个调用都留在承载
  推理的 assistant 回合中。宽容的 provider 和歧义的（重复、缺失或乱序的）call ID 保留原始输入顺序。

- `forward` URL → `{baseUrl}/responses`。`key` provider 默认保留原有的 `{baseUrl}/v1/responses` 构造。
- `key` provider 可设置经过验证的相对 `responsesPath`；adapter 会移除 `baseUrl` 末尾的一个 `/`，并向 `{trimmedBaseUrl}{responsesPath}` 发送请求。Ark Agent Plan 使用 `baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3"` 和 `responsesPath: "/responses"`。
- `forward` 模式只会转发安全的 header allowlist（`FORWARD_HEADERS`）：authorization、ChatGPT
  account id 和 OpenAI beta/originator/session header。这条 ChatGPT 登录路径也为
  [sidecar](/zh-cn/guides/sidecars/) 提供支持。

## `anthropic`

**目标：** Anthropic **Messages**（`/v1/messages`）。
**认证：** `key`（默认 `x-api-key`，或设置 `apiKeyTransport: "bearer"` 后使用 `Authorization: Bearer`）或 `oauth`（Bearer + `anthropic-beta`，用于 Claude Pro/Max）。

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
- Gemini 省略 tool-call id 时会合成 id。Vertex 与 Antigravity 会保留并重放不透明
  `thoughtSignature`，使 tool-result 后续 turn 保持 reasoning continuity。签名缓存会快照到配置
  目录，因此代理重启后后续 turn 仍可继续。

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
### 完成与原生 stop reason

Kiro 的 assistant 文本本身没有可靠的回合结束标记，但终止的 `metadataEvent` 可能带有原生 `stopReason`。
`END_TURN` 和 `STOP_SEQUENCE` 只能证明本次推理已停止；Kiro 也可能给进展文本加上该标记。因此在启用工具的
回合中，普通文本仍作为 commentary，并通过私有完成工具做一次校验。

`END_TURN`、`STOP_SEQUENCE` 或缺失 stop reason 时可以走一次完成兼容路径。其他显式原因已在上游终止本次推理，因此适配器直接报告而不是
再发一次请求：输出 token 上限表现为可继续的 incomplete，上下文窗口耗尽表现为不可重试的 context-length
错误，内容过滤或 guardrail 停止表现为 filtered incomplete。没有真实工具调用却出现的 `TOOL_USE` 被视为
矛盾而非进展。

启用工具时，opencodex 会添加私有 `codex_kiro_final_answer`。重试不会制造空的 assistant/user 回合，
而会保留原始 user/tool-result，并在发送前校验角色交替、非空结构消息以及 tool use/result 配对。
完成工具的回答即使与先前 commentary 完全相同，也会作为 `final_answer` 发出。

### Reasoning effort

`gpt-5.6-sol` 和 `claude-opus-5` 支持原生 effort，且请求字段名不同。`low` / `medium` / `high` /
`xhigh` / `max` 分别通过 `additionalModelRequestFields.reasoning.effort` 和
`output_config.effort` 发送。


## `cursor`

**目标：** 默认使用 `api2.cursor.sh` 上采用 HTTP/2 Connect streaming 的
`agent.v1.AgentService/Run`。配置 `upstreamHttpVersion: "http1.1"`（或 `"h1"`）后，改用
Cursor 的 HTTP/1.1 兼容传输：通过 `agent.v1.AgentService/RunSSE` 接收 server output，并通过
`aiserver.v1.BidiService/BidiAppend` 发送 client message。
**认证：** `provider.apiKey` 或转发 authorization header 中的 Cursor OAuth/access token。

- 使用 `runTurn`，而不是常规 fetch/parse 路径。请求、server event、工具参数、usage checkpoint
  和 client reply 由 `cursor/gen/agent_pb.ts` 中的 `@bufbuild/protobuf` schema 编码，并 frame 成
  Connect message。
- 经 content-addressed blob 重放对话状态，把 server tool call 映射回 Codex，用 protobuf
  `GetUsableModels` RPC 发现实时 Cursor 模型，并且只在 run request 尚未 commit 到 wire 前重试。
- 模型实时发现和推理都会遵守 `upstreamHttpVersion`。`auto`、`http2` 与 `h2` 保持原有 HTTP/2
  transport；只有 `http1.1` 与 `h1` 会选择兼容模式。
- 保留 `cursor/grok-4.5-fast` 作为可选模型，但向 Cursor 发送规范的 `grok-4.5` 模型，并将独立的
  `effort` 和 `fast=true` 值放入 `requested_model.parameters`。
- Cursor 原生本地 filesystem/shell/network 执行默认被拒绝。显式 `mcpServers` 与
  `desktopExecutor` 集成分别需要 opt-in；`unsafeAllowNativeLocalExec` 会启用更广泛的内置
  executor，并绕过 Codex 审批和 sandbox 语义。

## `azure-openai`（别名：`azure`）

**目标：** **Azure OpenAI**。封装 `openai-responses`，因此同样是 `passthrough: true`。
**认证：** 用 `api-key` header 进行 `key` 认证，而非 Bearer。

- 把请求构建交给 Responses passthrough，验证 `baseUrl` 不含未解析的 template placeholder，
  再用 `api-key` 替换 `Authorization`。配置的 URL 直接指向 Azure v1 Responses API，因此 adapter
  不会追加 `api-version`。

## 图像工具（`image.ts`）

支持视觉的 adapter 共用以下 helper：

- `parseDataUrl(url)` —— 把 `data:<type>;base64,<data>` URL 拆成 `{ mediaType, base64 }`，供
  Anthropic/Google image block 使用。
- `contentPartsToText(content)` —— 为纯文本工具消息把 content part 扁平化成文本。未描述的图像
  会变成简短的 `[image]` marker，而不是导致 token 暴涨的 base64 blob。
