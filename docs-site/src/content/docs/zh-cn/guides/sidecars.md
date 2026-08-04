---
title: "Sidecar：Web Search 与 Vision"
description: 通过原生 ChatGPT sidecar，让路由模型获得真实 web search，并让纯文本模型理解图像。
---

不同路由模型对托管 **Web Search** 和原生**图像输入**的支持并不相同。opencodex 通过两个
sidecar 补齐这些能力；它们可以使用 ChatGPT 登录（`forward`）provider，也可以使用已存储的
Anthropic OAuth provider。Sidecar 错误会转换成长度受限的工具结果或图像提示，不会让整个 turn
失败。

:::note[自动选择后端]
显式 `backend` 配置优先。省略时，如果已启用 Anthropic OAuth provider 的活动账户未标记
`needsReauth`，则使用 `anthropic`；否则使用 `openai`。显式选择 `anthropic` 但没有可用凭据时
会关闭失败。`openai` 同时需要 ChatGPT 登录和已启用的 `forward` provider。
:::

## Web-search sidecar

当 Codex 为非透传的路由模型请求托管 `web_search` 时，opencodex 会：

1. **移除**托管的 `web_search` 工具，改为向路由模型提供一个合成的
   `web_search(query)` function 工具。原托管工具的选项会保留并用于 sidecar 调用。
2. 让路由模型在一个小型 **agentic 循环**中运行。模型调用 `web_search` 时，opencodex 使用所选
   后端：OpenAI 默认以 `gpt-5.6-luna` 运行托管 `web_search`；Anthropic 默认以
   `claude-sonnet-5` 运行 `web_search_20250305`。Streaming 答案及引用会解析为工具结果。
3. **循环**直到模型回答，或真实查询总数达到 `maxSearchesPerTurn`（默认 3）。达到上限后会移除
   search 工具并强制生成最终答案。如果模型调用 `apply_patch` 或 shell 等真实客户端工具，当前
   turn 会结束，以便这些调用到达 Codex。

路由模型的每次迭代都会向上游请求 `stream: true`，但 opencodex 会在决定搜索还是返回最终答案前，
在内部完整缓冲所有语义 event。只有第一次迭代的最终 header/status 和 429 key rotation 会被提前
取得。因此，合成搜索调用和中间输出不会作为模型输出暴露给客户端。

注入结果会包裹在不可信数据边界中，限制长度，并按来源 URL 去重。在结构化输出 turn
（`json_schema` / `json_object`）中，结果会以紧凑 JSON 而不是普通文本传入。若路由模型是纯文本
模型，search 模型还会收到指令，用文字描述相关图像并附上来源 URL。

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

托管后端不允许在 `minimal` reasoning 下使用工具，因此默认值为 `low`。搜索失败时，路由模型会
收到长度受限的错误结果，仍可依据已有上下文继续回答。

此路径采用四个相互独立的时钟。`stallTimeoutSec` 是基础 bridge event-stall 预算。
`connectTimeoutMs`（默认 `200000`）只限制 DNS/TCP/TLS 和最终响应 header。仅可在配置文件中
设置的 `webSearchSidecar.routedModelStallTimeoutMs`（默认 `200000`，整数
`1..2147483647`）限制每次路由模型迭代中原始响应 byte 连续无活动的时间，并在收到每个非空 byte
时重置。`webSearchSidecar.timeoutMs` 独立限制单次托管搜索请求。实际 bridge watchdog 为
`max(基础 stall, connect timeout, 路由模型 stall, sidecar timeout) + 30 秒`。路由模型 stall
不是总生成 timeout。SSE 开始前的失败会返回非 2xx JSON；响应 header 开始后发生的生成失败则以
`response.failed` SSE 传递。

## Vision sidecar

当路由模型列在其 provider 的 `noVisionModels` 中，并且请求包含图像时，opencodex 会在主调用
**之前**描述每张图像，并用文字替换图像。Dashboard 和管理 API 当前显示的默认值是
`gpt-5.6-luna`，启动时也会把明确保存的旧 `gpt-5.4-mini` 值迁移到 Luna。只有在
`visionSidecar.model` 字段完全不存在时，vision 执行路径才会使用代码中的 `gpt-5.4-mini` 回退值。

- 图像可以来自 user、developer 和 tool-result message，也包括 Codex 的 `view_image` 结果。
- 每张图像会以 `reasoning.effort: "low"` 发送给配置的原生 vision 模型，描述结果会就地替换
  图像部分。
- 描述任务最多同时处理 3 张图像，并保持输入顺序。发送给描述模型的用户上下文最多 800 个字符，
  每张图像注入的描述最多 2,000 个字符。请求不会发送 ChatGPT 后端不支持的
  `max_output_tokens`。
- 图像 URL 会在转发前校验。data URL 必须是 `png` / `jpeg` / `jpg` / `webp` / `gif`，base64
  数据限制在约 20 MB；只接受 `data:` 和 `https:` scheme。远程 `https` 图像由 OpenAI 后端获取，
  而不是代理。
- `noVisionModels` 匹配会忽略 Ollama 风格的 `:size` 后缀，因此一个 `gpt-oss` 条目也能覆盖
  `gpt-oss:120b`。
- 如果描述失败，模型会收到简短的处理错误提示。若根本无法建立 sidecar plan，原始图像会被
  移除，而不会继续转发给纯文本后端。
- `maxDescriptionsPerTurn`（默认 8）限制每个主模型 turn 的新增描述次数。缓存命中和同一 turn
  的重复请求不会消耗配额。成功的 `data:` 图像描述会按后端、模型、detail、图像字节和消息上下文
  缓存；内容可变的 `https:` 图像不会缓存。

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

纯文本模型按 provider 标记：

```json
{
  "providers": {
    "ollama-cloud": {
      "adapter": "openai-chat",
      "baseUrl": "https://ollama.com/v1",
      "noVisionModels": ["glm-5.2", "gpt-oss", "qwen3-coder", "deepseek-v4-pro"]
    }
  }
}
```

## 仪表盘设置与禁用

<!-- TODO(WP5 GUI): GUI 控件完成后补充 sidecar 设置页面操作说明。 -->

配置文件字段现在即可使用。如需禁用某个 sidecar，请在 `config.json` 中把对应的 `enabled` 设为
`false`。Anthropic OAuth 搜索和图像描述沿用现有 Claude Code OAuth fingerprint 先例，但仍应使用
目标账户和实际负载充分 soak test。所有字段见
[配置参考](/zh-cn/reference/configuration/#sidecars)。
