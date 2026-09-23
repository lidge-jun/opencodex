---
title: Factory Droid 桥接
description: 通过本地兼容 Responses 的桥接服务，将 Factory Droid 模型接入 opencodex。
---

Factory Droid 是代理运行时，并非有文档支持的 OpenAI 兼容推理端点。如果指向 Factory 内部 LLM URL 的自定义 provider 返回 `403 Forbidden`，仅更换 opencodex adapter 或添加 provider header，也不能使这条私有路径成为受支持的公开 API。

可行的集成方式如下：

```text
Text-only Responses client
  -> opencodex (http://127.0.0.1:10100/v1/responses)
  -> local Responses bridge (http://127.0.0.1:11435/v1/responses)
  -> official droid exec command
  -> Factory account and selected model
```

这样 Factory 凭据始终留在官方 Droid 客户端中。OpenCodex 则接收独立的、仅供本地桥接使用的 token。

## 失败现象及原因

| 症状 | 原因 | 解决办法 |
| --- | --- | --- |
| Factory LLM URL 返回 `403 Forbidden` | 该 URL 不是为第三方客户端提供的通用 OpenAI 端点 | 通过官方 Droid CLI 或 SDK 调用 Factory |
| `/models/models` 返回 `404` | provider 的 base URL 已经以 `/models` 结尾 | 将 `baseUrl` 设为 API 根路径；不要包含发现路径 |
| 模型搜索失败 | 桥接服务没有提供完整的实时目录 | 设置 `liveModels: false` 并提供静态 `models` 列表 |
| loopback provider 被拒绝 | 默认禁止访问私有网络 | 只为 loopback 桥接设置 `allowPrivateNetwork: true` |
| `${DROID_BRIDGE_TOKEN}` 无法解析 | opencodex 服务环境中缺少该变量 | 将变量注入服务进程，而不只是交互式 shell |
| `OutputTextDelta without active item` | 桥接服务在打开输出项及内容部分之前发送了文本增量 | 按顺序发送完整的 Responses SSE 生命周期 |

因此，同一 Factory 凭据可能在 `droid exec` 中正常工作，但直接请求无文档支持的 LLM URL 仍返回 `403`。两者测试的是不同产品，不应视为矛盾。

## 前置条件

1. 安装 [Droid CLI](https://docs.factory.ai/droid-cli/quickstart) 并登录。
2. 确认有界的无交互请求可用：

   ```bash
   droid exec --model glm-5.2 --output-format json "Reply with DROID_OK only."
   ```

3. 运行调用 `droid exec`（或官方 Droid SDK）的本地桥接服务，并提供：

   - `GET /healthz`
   - `GET /v1/models`
   - `POST /v1/responses`

Factory 将 `droid exec` 作为无交互自动化入口，并建议脚本使用 JSON 输出。对于需要长期运行的集成，Factory 还在 [Droid Exec 指南](https://docs.factory.ai/droid-exec/overview)中记录了流式 JSON-RPC，以及官方 TypeScript 和 Python SDK。

## 桥接契约

将桥接服务绑定到 `127.0.0.1`，要求随机生成的 bearer token，限制请求大小，并对模型 ID 使用允许列表。最小桥接仅接受以下 Responses `input` 形式：

- 非空字符串；或者
- 仅包含 `message` 项的数组。每条消息的角色必须为 `user`、`developer`、`system` 或 `assistant`，内容必须是字符串或纯文本内容部分（输入角色使用 `input_text`，assistant 历史记录使用 `output_text`）。

调用 Droid 前应验证完整请求。如果输入部分包含图片或文件，`tools` 包含任何工具定义，或 `input` 包含工具调用或结果（`function_call`、`function_call_output`、`custom_tool_call` 或 `custom_tool_call_output`），请返回 HTTP `400`，并使用 Responses 风格的 `invalid_request_error`。使用稳定的桥接专用代码，例如 `unsupported_bridge_input`，且在消息中指出被拒绝的字段。即使 `stream: true`，也必须在启动 SSE 之前完成验证；不要将不支持的内容丢弃、字符串化或展平成提示词。

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

对于被接受的请求，桥接服务应：

1. 将被接受的 Responses `input` 转换为提示词；
2. 调用 `droid exec --model <id> --output-format json <prompt>`；
3. 解析最终的 `result` 和 `session_id`；
4. 返回 OpenAI Responses 封装；
5. 在需要续接时，将 `previous_response_id` 映射到 Droid 会话 ID。

对于流式响应，请依次发送以下生命周期事件：

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

不要在 `0.0.0.0` 上公开桥接服务，也不要把 Factory 凭据复用为桥接 bearer token。

## OpenCodex provider 配置

使用明确的 provider ID `droid` 创建自定义 provider：

```bash
ocx provider add droid \
  --adapter openai-responses \
  --base-url http://127.0.0.1:11435/v1 \
  --default-model glm-5.2 \
  --allow-private-network
```

这会创建 `providers.droid` 配置条目。在仪表盘中打开 **Providers → droid → Edit
JSON**，并将该 provider 的值替换为：

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

模型 ID 仅为示例。只保留已登录的 Factory 账户能通过 `droid exec` 使用的模型。不要为此 provider 添加 Factory 专用推理 header：它的上游是本地桥接服务，不是 Factory HTTP 端点。

保存 provider 或修改静态目录后，同步并重启 Codex，让新会话读取更新后的目录：

```bash
ocx sync --restart-codex
ocx doctor
```

`--restart-codex` 会重启匹配的 app-server，并完全退出及重新启动 Codex 桌面应用，从而结束正在进行的对话。使用 `--restart-app-server-only` 可让桌面应用继续运行。请先完成或保存这些会话，再执行重启。

## 验证完整路径

分别检查每个边界：

```bash
curl -fsS http://127.0.0.1:11435/healthz
ocx doctor
ocx access test droid/glm-5.2 --protocol responses
```

provider 行或模型选择器条目只能证明目录可见。只有 Responses 探测通过 `droid/<model>` 路由返回后，才能确认集成可用。

## 当前限制

上述最小桥接只转换文本及 Responses SSE 生命周期，**没有**实现完整的双向 Codex function/tool-call 协议。Codex App 和 `codex exec` 通常会发送工具定义，即使提示词要求不要调用工具；当前 Codex CLI 也没有移除这些定义的通用标志。最小桥接必须按上述 `400` 契约拒绝此类请求。工具定义、工具调用、工具结果、权限、取消和丰富的 Droid 事件，需要基于 Factory 流式 JSON-RPC 模式或官方 Droid SDK 构建有状态桥接服务。应将 `ocx access test` 的成功视为文本路径验证，而非 Codex 代理或工具路径验证。
