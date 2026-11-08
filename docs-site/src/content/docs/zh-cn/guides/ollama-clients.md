---
title: Ollama 兼容客户端
description: 让使用 Ollama API 的工具连接 opencodex，并使用已配置的提供商模型。
---

opencodex 支持 Ollama HTTP API 的一个子集，因此只能与 Ollama 通信的工具也可以使用你在 opencodex
中已配置的模型。请求会被转换到 Chat Completions 路径，并发送给所选提供商。opencodex 不会在你的机器上
下载、存储或运行模型。

## 连接客户端

将代理地址用作 Ollama 主机。默认本地安装如下：

```bash
export OLLAMA_HOST=http://127.0.0.1:10100
curl "$OLLAMA_HOST/api/tags"
```

当代理要求 API 密钥时（例如绑定到 `0.0.0.0`），按与 `/v1/chat/completions` 相同的方式发送，
例如 `Authorization: Bearer <opencodex key>`。带有模型范围的密钥只能看到并使用被允许的模型。这些端点只在主监听器上
提供；无认证的回环监听器、Remote Link 和 hub 管理入口都不会暴露它们。

## 端点

| 端点 | 行为 |
| --- | --- |
| `GET /api/version` | opencodex 版本。 |
| `GET /api/tags` | 以 `provider/model` 名称列出已配置的提供商模型。 |
| `POST /api/show` | `{ "model": "provider/model" }` 只返回已知信息；不包含文件大小、摘要、模板或许可证。 |
| `POST /api/chat` | 使用 `system`、`user`、`assistant` 和 `tool` 消息进行对话。 |
| `POST /api/generate` | 单个提示词，可选 `system`。 |

其他所有 `/api/*` 路径仍属于 opencodex 管理 API。

## 支持的请求字段

- `model`：`/api/tags` 中的名称。
- `stream`：默认为 `true`（按行分隔的 JSON）。设为 `false` 可得到单个 JSON 响应。
- `images`：用户消息（chat）或请求（generate）中的 base64 PNG、JPEG、GIF 或 WebP。
- `tools`（仅 chat）：函数工具。请原样回传 assistant 消息，包括每个调用的 `id`；`tool` 结果按
  `tool_call_id` 匹配，没有时按 `tool_name` 匹配。
- `options`：`temperature`、`top_p`、`num_predict` 和 `stop`。
- `format`：仅支持 `"json"`。

每个 `/api/chat` 请求中，所有 assistant 消息的**工具调用总数最多为 1,024 次**，已返回结果的调用也计入总数。
超过上限时，请求会在发送给提供商之前返回 HTTP 400。请缩短对话历史后重试，并将保留的工具结果与对应的
assistant 工具调用一起保留。

其他内容会以 HTTP 400 拒绝，而不是被忽略，包括 `think`、`keep_alive`、`suffix`、`raw`、
`template`、`context`、其他 `options`、JSON Schema 形式的 `format` 以及图片 URL。不提供 Ollama 的模型管理和
嵌入端点。

组合、路由策略、`--fast` 或 effort 别名，以及会转发调用方自身凭据的提供商，不能在这里选择。
这类请求会在向上游发送任何内容之前失败。

## 响应

完成的回复带有 `done: true`，`done_reason` 为 `stop`、`tool_calls` 或 `length`。
提供商报告用量时才会出现 `prompt_eval_count` 和 `eval_count`；不报告耗时字段。流式响应会在上游回复完全结束后
恰好发送一行 `done: true`。

错误使用 Ollama 格式 `{ "error": "message" }` 并保留 HTTP 状态，速率限制和繁忙拒绝时也会带上
`Retry-After`。因内容过滤或未知原因停止的回复会作为错误返回，而不会当作正常停止。如果流在开始后失败，最后一行是
`error` 对象，之后不会有 `done: true` 行。

这些请求会像其他流量一样出现在仪表板的请求日志中，响应头 `x-opencodex-request-id` 指向对应的记录。
