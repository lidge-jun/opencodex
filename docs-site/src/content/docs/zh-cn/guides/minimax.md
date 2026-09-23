---
title: MiniMax 客户端
description: 通过 OpenCodex 路由 MiniMax Code 和 MiniMax CLI 的文本命令，同时避免暴露 MiniMax 凭据。
---

MiniMax 发布两种不同的命令行产品。OpenCodex 在它们实际提供的协议边界上分别集成：

- **MiniMax Code**（`mcode`）是支持自定义 Anthropic Messages 提供商的编程代理。
- **MiniMax CLI**（`mmx`）是多模态平台 CLI。只有其 `text` 资源使用 OpenCodex 可以路由的 Anthropic 兼容 API。

## MiniMax Code

先按照 MiniMax 的说明安装并登录 MiniMax Code，然后启动 OpenCodex 并连接可逆的文件集成：

```bash
ocx start
ocx integration client enable --client mcode
ocx mcode
```

![使用隔离示例数据展示的 MiniMax Code 集成](/screenshots/minimax-code-integration.png)

此集成向 `~/.minimax/config.yaml` 合并一个配置块：

```yaml
custom_provider:
  opencodex:
    name: OpenCodex
    kind: custom
    enabled: true
    api: anthropic-messages
    options:
      apiKey: opencodex-loopback
      baseURL: http://127.0.0.1:10100
      authMode: api-key
    models:
      anthropic/claude-opus-5:
        limit:
          context: 1000000
```

实际生成的模型列表，以及已知的上下文窗口和推理强度级别，来自运行中的 OpenCodex 目录。没有可靠上下文窗口或强度级别的模型会省略相应字段，而不会采用猜测值。MCode 在会话中保留当前选定的强度，因此 OpenCodex 导出 `effortOptions` 时不会覆盖该选择。配置块不会写入真实密钥，不会替换 `defaultModel`，也不会修改 MiniMax 登录。在 MCode 中，请从 `custom_provider:opencodex/...` 下选择模型。

`ocx mcode` 会在启动客户端前确认该提供商指向当前运行的代理。首次启用后，端口或目录能力变化时，`ocx sync` 会刷新由 OpenCodex 管理的配置块。自动同步不会创建不归其管理的配置块、重建你已删除的配置块，也不会覆盖 OpenCodex 写入后又被修改的文件；若确实要重新连接，请使用启用命令。可以通过同一经过审计的集成系统禁用或恢复：

```bash
ocx integration client disable --client mcode
ocx integration client history --client mcode
ocx integration client restore --op <opId> [--confirm-drift]
```

支持 `MINIMAX_DATA_DIR` 和旧版 `MAVIS_DATA_DIR`。相对路径覆盖会被拒绝，因为 OpenCodex 和 MCode 可能从不同工作目录启动。

## MiniMax CLI（`mmx`）

单独安装官方 CLI：

```bash
npm install -g mmx-cli
mmx --version
```

使用封装命令和 OpenCodex 模型 id，通过 OpenCodex 路由文本命令：

```bash
ocx mmx text chat \
  --model anthropic/claude-opus-5 \
  --message "Explain this function"

ocx mmx --output json text chat \
  --model openai/gpt-5.6-sol \
  --message "Return a JSON summary"
```

MMX 在其 API 基础 URL 下固定使用 `/anthropic/v1/messages`。封装命令在子进程存活期间启动临时回环桥接器。它只接受发送至该 Messages 路径及 `/anthropic/v1/messages/count_tokens` 的 POST 请求，并映射到 OpenCodex 现有的 `/v1/messages` 与 `/v1/messages/count_tokens` 数据平面，同时保留请求体和查询数据。规范的 OpenCodex 请求转换、用量核算以及已配置的下游提供商认证仍会生效；提供商会根据配置收到 `x-api-key` 或 bearer 传输。流式处理会保留 Anthropic 消息和内容事件。转发前，桥接器会移除传入的准入凭据标头，并固定使用公开的 `opencodex-loopback` 占位符。它不会代理任意 Anthropic 资源，也绝不会暴露到回环地址以外。

封装命令还会创建一个只包含该占位符的临时 `MMX_CONFIG_DIR`，并在 `mmx` 退出后删除。你的 `~/.mmx/config.json`、OAuth 令牌和 MiniMax API 密钥不会被加载或复制。

以下限制是有意设计的：

- 只有 `text chat` 和 `text repl` 会通过 OpenCodex 路由。
- 封装命令拒绝 `--api-key`、`--base-url` 和 `--region`，以免调用方凭据或目标选择器与隔离桥接器冲突。
- 桥接器仅限回环地址，因为 MMX 无法向远程绑定发送 OpenCodex 专用的 `x-opencodex-api-key` 准入标头。
- 对 `image`、`video`、`speech`、`music`、`vision`、`search`、`quota`、`auth`、`config`、`file` 和 `update` 使用普通 `mmx`；它们调用 OpenCodex 不模拟的 MiniMax 专用 API。

`mmx` 的默认文本模型为 `MiniMax-M3`。如需特定的 OpenCodex 路由，请传入 `--model <provider/model>`；否则由普通 OpenCodex 模型路由规则决定默认 id 是否可用。
