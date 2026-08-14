---
title: Proxy API 格式
description: 面向 Responses、Chat Completions、Anthropic Messages、模型目录、WebSocket、realtime 和 compaction 各表面的传输层参考。
---

opencodex 以多种客户端方言提供一个本地代理。Codex 客户端可以使用
Responses API，兼容 OpenAI 的应用可以使用 Chat Completions，而 Claude Code 可以使用
Anthropic Messages，而不需要每个上游提供方都实现每一种格式。

标准转换路径如下：

```text
client dialect → internal Responses model → provider adapter → provider wire format
provider events → internal adapter events → client dialect
```

Responses 表示是这座桥的中心。原生兼容的路由可以跳过部分转换并直接透传请求，
但认证、路由、准入控制和响应安全仍然发生在代理边界。请在
[Configuration](/reference/configuration/) 中配置监听器和准入密钥；当一个公开模型 ID
需要在多个目标之间选择时，请使用 [Combos](/guides/combos/)。

## 端点总览

| 客户端表面 | 端点 | 成功的非流式结果 | 成功的流式或套接字结果 |
| --- | --- | --- | --- |
| OpenAI Responses | `POST /v1/responses` | Responses JSON | Responses SSE，或通过 WebSocket 传输的 Responses JSON 文本帧 |
| OpenAI Chat Completions | `POST /v1/chat/completions` | `chat.completion` JSON | 以 `chat.completion.chunk` SSE 结尾并带 `[DONE]` |
| Anthropic Messages | `POST /v1/messages` | Anthropic `message` JSON | Anthropic Messages SSE |
| Anthropic token count | `POST /v1/messages/count_tokens` | `{ "input_tokens": number }` | 不适用 |
| 模型发现 | `GET /v1/models` | 三种目录契约之一 | 不适用 |
| 语音和 Realtime | `POST /v1/live`, `POST /v1/realtime/calls` | 转发的调用创建响应 | 独立的 sideband WebSocket 双向转发帧 |
| Responses compaction | `POST /v1/responses/compact` | 替换历史 JSON | 不适用 |

## `POST /v1/responses`

这是 opencodex 原生的数据平面形状。请求体必须是一个包含非空 `model` 的 JSON 对象。`input` 可以是字符串，也可以是 Responses 项目数组。

### 接受的请求字段

| 区域 | 接受的形态 |
| --- | --- |
| 模型和输入 | 必需的非空 `model`；可选的字符串 `input` 或项目数组 |
| 消息项 | `user`、`developer`、`system` 和 `assistant` 消息；字符串内容，或适用于该角色的类型化内容块 |
| 内容块 | 当其父项允许时，可包含文本、输入图像、输入文件、输出文本、拒绝，以及 reasoning summary/text 块 |
| 工具历史 | `function_call`、`function_call_output`、`custom_tool_call` 和 `custom_tool_call_output` 项 |
| 工具 | 函数工具以及宽松的内建或托管工具条目；`tool_choice` 接受 `auto`、`none`、`required`、命名的 function/custom 选择、托管选择，或 `allowed_tools` |
| 推理 | `reasoning.effort` 和 `reasoning.summary`（`auto`、`concise`、`detailed` 或 `none`） |
| 续接和缓存 | `previous_response_id`、`store` 和 `prompt_cache_key` |
| 生成控制 | `max_output_tokens`、`temperature`、`top_p`、`stop`、`presence_penalty` 和 `frequency_penalty` |
| 服务和执行 | `stream`、`service_tier`、`parallel_tool_calls`、`instructions`、`metadata` 和 `user` |
| 扩展 Responses 字段 | 兼容路由接受 `background`、`include`、`prompt`、`text` 和 `truncation` |

未知项目类型会作为宽松的类型化项被接受，以保证前向兼容。已翻译的适配器只处理它们能识别的项目类型，并且可能会拒绝其提供方无法表示的特性。

### JSON 和 SSE 输出

当 `stream: true` 时，响应为 `text/event-stream`。桥会发出 Responses 事件，例如
`response.created`、输出项和文本/工具增量，以及且仅有一个终止的
`response.completed`、`response.failed` 或 `response.incomplete` 事件。正常的流以
`data: [DONE]` 结束。

当 `stream: false` 或未提供 `stream` 时，同样的适配器事件会被收集为一个 Responses JSON
对象。两种形式都会保留所选模型、输出项、终止状态和 usage。

面向客户端的 Responses SSE 帧按 SSE 块分隔符之前的原始字节计算，每帧限制为 4 MiB。对于 HTTP，未终止的上游帧一旦超过该限制，会以合成的 `response.failed` 事件并随后发送 `data: [DONE]` 的方式 fail closed。对于 Responses WebSocket 桥，相同情况会发送 502 `websocket_protocol_error` 并取消上游 reader。已经完整到达的 Responses 终止帧具有优先权；其后的超大或格式错误字节会被丢弃，而不会把已经完成的轮次替换为传输失败。

每个终止的 Responses usage 对象都包含两个 detail 对象，即使提供方没有报告这些细节：

```json
{
  "input_tokens": 0,
  "output_tokens": 0,
  "total_tokens": 0,
  "input_tokens_details": { "cached_tokens": 0 },
  "output_tokens_details": { "reasoning_tokens": 0 }
}
```

在可用时，`input_tokens_details` 还可以包含 `cache_write_tokens`。始终存在的 detail 对象是严格 Responses 客户端的兼容性保证；零可能表示“未报告”，不一定表示“提供方没有进行此类工作”。

### 同一路径上的 WebSocket 升级

当启用 `websockets` 时，客户端可以升级 `/v1/responses`，而不是发起 HTTP POST。
认证和 origin 准入会在 WebSocket 握手期间发生，不会在每个帧内重复。

客户端发送 JSON 文本帧：

```json
{
  "type": "response.create",
  "model": "provider/model",
  "input": "Hello",
  "tools": [],
  "generate": true
}
```

除 `type` 之外的一切都会成为 Responses 请求体，并且代理会强制该轮为流式。新的
`response.create` 会取代并取消该 socket 上的上一轮。`response.processed` 被接受为无操作确认。无法解析或无关的帧类型会被忽略。

服务器帧是 JSON 文本帧。成功的流式输出使用与 SSE `data:` 行中相同的 JSON 负载，只是不带 SSE 封装或 `[DONE]`。非流式的内部结果会被重新封装为 `response.created`，接着是零个或多个 `response.output_item.done` 帧，然后是一个终止帧。错误使用以下封装：

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

带 `generate: false` 的 warmup 帧不会调用上游。它会返回一个合成的
`response.created`，随后是 `response.completed`，两者都带空的 response id 且没有输出。

:::note
当 WebSocket 被禁用时，升级尝试会收到 HTTP 426，错误码为
`upgrade_required`。Codex 会把该握手结果视为会话回退到 HTTP 的信号。
这不是一次失败的模型轮次。
:::

## `POST /v1/chat/completions`

该端点接受与 OpenAI 兼容的 Chat Completions 请求，要求提供 `model` 和一个非空的
`messages` 数组。它会把 system、user、assistant 和 tool 消息转换为内部 Responses 项；
转换 function tools、tool choice、图像、reasoning effort 和受支持的 response formats；
运行标准的 Responses 路由管线；然后再把结果转换回去。

非流式输出的 `object: "chat.completion"`。流式输出使用 SSE 对象，`object: "chat.completion.chunk"`、
choice 增量、带 `finish_reason` 的终止 choice，以及 `data: [DONE]`。工具调用和 usage 信息会在源事件携带它们时被转换回去。

由于内部执行路径基于 Responses，因此提供方适配器可以施加更窄的特性集。例如，若请求中的某个特性无法被所选适配器表示，它会作为错误返回，而不是静默改变其含义。

## `POST /v1/messages` 和 `count_tokens`

这些端点使用 Claude Code 和兼容客户端所采用的 Anthropic Messages 方言。大多数请求会被转换为 Responses，按常规路由，然后再转换回 Anthropic JSON 或 Anthropic SSE。

只有在满足以下全部条件时，原生 Anthropic 透传才有资格启用：

- Claude Code 配置中尚未禁用原生透传；
- 请求的模型以 `claude` 或 `anthropic` 开头；
- 请求携带原生 Anthropic bearer 或 `x-api-key` 凭证；
- 在非回环监听器上，请求还仅通过 `x-opencodex-api-key` 携带有效代理准入；并且
- 没有配置的别名或模型映射把该 model id 声明为一个被路由目标。

符合条件的请求会以 Anthropic 方言转发，因此原生 beta 头、thinking 签名和订阅身份都能端到端保留。否则它会走 Responses 往返。

专用准入请求头绝不会转发。`Authorization` 或 `x-api-key` 中的代理准入密钥也会被移除，
而另一个请求头中的真实 Anthropic 凭据会保留。含逗号拼接的歧义凭据请求头会 fail closed。

`POST /v1/messages/count_tokens` 采用相同的模型解析和透传决策。符合原生条件的请求会转发到 Anthropic 的 count 端点。其他请求会使用本地文档化的估算值，对 system 内容、messages 和 tools 进行统计，并返回：

```json
{ "input_tokens": 123 }
```

## `GET /v1/models`

同一路由要服务三种期望不兼容目录封装的客户端。除非同时存在 `client_version`，否则 Anthropic 形态优先。

| 契约 | 触发条件 | 顶层形态 | 模型 ID 行为 |
| --- | --- | --- | --- |
| Anthropic model list | `anthropic-version` 头或 `?flavor=anthropic`，且没有 `client_version` | `{ "data": [...] }`，包含 Anthropic model-info 条目 | Claude Code 收到可读 ID；Desktop 可以收到其 profile-specific 别名族 |
| Codex catalog | `client_version` 查询参数 | `{ "models": [...] }` | 原生和路由条目携带更丰富的 Codex catalog 字段、可见性、effort、WebSocket 和 multi-agent 元数据 |
| Plain OpenAI list | 两个触发条件都没有 | `{ "object": "list", "data": [...] }` | 可见的原生 ID 是裸值；路由 ID 是别名或 `provider/model` |

## `POST /v1/live` 和 Realtime sideband

`POST /v1/live` 接受 ChatGPT/Codex App 的 Frameless call-creation 表面。
`POST /v1/realtime/calls` 接受 OpenAI Realtime 的 call-creation 表面。opencodex 会选择
一个符合条件的 OpenAI 家族路由，将 call-creation 请求规范化为上游认证模式，并转发有界响应。

完成调用创建后，客户端可以使用任一受支持的入站形式加入 sideband WebSocket：

- `/v1/live/{callId}`
- `/v1/realtime/calls/{callId}`
- `/v1/realtime?call_id={callId}`

代理会规范化上游 join URL，然后在双向透明转发文本和二进制帧。客户端协议头会被保留，而上游认证仍由代理拥有。

## `POST /v1/responses/compact`

Compaction 会为需要缩短长 Responses 会话的客户端返回替换历史。

| 路由类型 | 行为 |
| --- | --- |
| Canonical ChatGPT 或官方 OpenAI 路由 | 将请求转发到原生 `/responses/compact` 端点，并使用已解析的账号和模型认证 |
| 其他路由模型 | 运行一次内部的、非流式、无工具的 compaction 轮次，并带 `compaction_trigger`；要求且只允许一个 synthetic `compaction` 项，其 `encrypted_content` 是一个 `ocx1:` 封装；把该摘要解码为 v1 替换历史 |

原生 compact 响应会被缓冲，最大 32 MiB，即使其声明的 `Content-Length` 已经超过该限制也是如此。compact 专用失败包括：

| 状态 | 类型或 code | 含义 |
| --- | --- | --- |
| 400 | `invalid_request_error` | 非法的 JSON/主体形状或缺少 model |
| 404 | `invalid_request_error` | 请求的 model 无法被路由 |
| 499 | `client_cancelled` | 客户端在转发或缓冲期间取消了请求 |
| 502 | `compact_response_too_large` | 原生 compact 输出超过 32 MiB |
| 502 | `upstream_error` | 连接、读取，或合成 compaction 轮次失败 |
| 502 | `invalid_response_error` | 合成轮次没有产出恰好一个有效、非空的 `ocx1:` compaction 项 |

## 认证矩阵

在仅绑定到 loopback 的情况下，数据平面准入不需要配置密钥。在远程绑定上，请使用下表。“Dedicated” 指 `X-OpenCodex-API-Key`；其他列指 `Authorization: Bearer ...` 和 `x-api-key`。

| 表面 | Dedicated | Bearer | `x-api-key` |
| --- | --- | --- | --- |
| `/v1/responses` HTTP 和 WebSocket | 必需 | 被代理准入拒绝 | 被拒绝 |
| `/v1/responses/compact` | 必需 | 被代理准入拒绝 | 被拒绝 |
| `/v1/chat/completions` | 必需 | 被代理准入拒绝 | 被拒绝 |
| `/v1/messages` 和 `/v1/messages/count_tokens` | 接受 | 接受 | 接受 |
| `/v1/models` | 接受 | 接受 | 接受 |
| `/v1/live`、`/v1/realtime/calls` 和 sideband join | 接受 | 接受 | 接受 |

Responses 家族和 Chat 请求会把 `Authorization` 留给提供方或 Codex Direct
透传，因此远程代理密钥必须使用专用头。Messages 和 Realtime 表面需要更广泛的客户端兼容性，因此接受这三种形式。

:::caution
数据平面密钥不是管理凭证。管理 API 使用单独的 admin secret；
请参见 [Management API](/reference/management-api/)。切勿把同一个密钥同时用于两个平面。
:::

## 常见错误词汇

错误会在需要时使用客户端方言的封装，但这些状态/code 含义是稳定的：

| 状态 | 类型或 code | 含义 |
| --- | --- | --- |
| 401 | `authentication_error` | 所需的代理准入凭证缺失或无效 |
| 403 | `origin_rejected` | 一条 Responses/OpenAI 数据平面请求或 WebSocket 升级来自不允许的 origin |
| 503 | `combo_unavailable` | 所选 combo 中的所有目标都不可用、处于冷却、已禁用或以其他方式不具备资格 |
| 400 | `unreadable_encrypted_agent_task` | 一个加密的 v2 worker task 没有任何可消费它的合格原生 ChatGPT 目标 |
| 426 | `upgrade_required` | Responses WebSocket 传输被禁用，或升级失败；请改用 HTTP |

Anthropic 来源的失败会以 Anthropic 的错误封装呈现，因此该方言中的 origin 拒绝会是
403 `permission_error`，而不是 OpenAI 风格的 `origin_rejected` body。

## 加密内容卫生

代理把真正的后端密文视为不透明数据。结构有效的密文会逐字节保留：opencodex 不会对其解密、翻译其内容，或为另一个提供方重新加密。

某些 agent hook 历史上会把明文控制文本放进 `encrypted_content` 槽。为兼容起见，代理会把那部分明文拆分为文本片段，同时保持任何结构有效的 Fernet 片段不变。如果一个 `agent_message` 在该修复过程中失去了所有加密部分，它就会变成普通的 user message。如果当前的 v2 task 仍然真的是加密的，但所选路由目标无法读取原生 ChatGPT 密文，opencodex 会以
`unreadable_encrypted_agent_task` 失败，而不是把不可读字节发送给该提供方。有关 worker task 周边的客户端行为，请参见 [Sub-agent Surface](/guides/sub-agent-surface/)。
