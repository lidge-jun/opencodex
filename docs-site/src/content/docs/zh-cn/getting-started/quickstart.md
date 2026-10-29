---
title: 快速开始
description: 安装 opencodex，添加第一个提供商，再连接你正在使用的编程工具：Codex、Claude Code、Claude Desktop、Grok Build 或其他受支持的工具。
---

本指南将带你从全新安装，一路走到在你正在使用的编程工具中发出第一次请求。第 1、2 步对所有工具都相同；第 3 步按工具分成几个简短的分支。[客户端支持](/zh-cn/reference/client-support/)页面列出了每个工具及其接入方式。

## 独立二进制文件（无需 npm）

你也可以使用包含 Bun 运行时的发布压缩包中的 `ocx`，无需 npm。
解压时将 `gui/dist` 目录保留在二进制文件旁边，然后运行 `./ocx start`。

## 1. 运行设置向导

```bash
ocx init
```

`ocx init` 会引导你完成：

1. **选择 provider** — 从内置 registry 的 106 个预设中选择一个，或选择 `custom` 手动输入 base URL 和 adapter。
2. **API key** — 粘贴一个 key，或引用一个环境变量，例如 `${ANTHROPIC_API_KEY}`。
3. **默认模型** — 对于 key、本地和 custom provider，接受预设值或输入模型 id。
4. **代理端口** — 默认为 `10100`。
5. **注入到 Codex？** — 在常规 loopback 配置下，opencodex 会在 `$CODEX_HOME/config.toml`（默认 `~/.codex/config.toml`）根级添加 `openai_base_url`，让 Codex 内置的 `openai` provider 指向代理。远程/LAN 绑定则改用带 API 认证 header 的专用 provider 条目。
6. **安装自启动 shim？** — 启用后，启动 `codex` 会先运行 `ocx ensure`。

结果会保存到 `$OPENCODEX_HOME/config.json`（默认 `~/.opencodex/config.json`）。

:::note[GPT-5.6 灰度发布条目]
当前稳定版会为 ChatGPT 透传、OpenAI API key、OpenRouter，以及实验性的 Cursor adapter 预置 GPT-5.6 Sol/Terra/Luna。只有当上游账号具备访问权限时它们才可用。OpenAI API key 和 OpenRouter 预设声明的可用上下文窗口为 922,000 token；Cursor 则保留自己的 adapter 元数据。
:::

## 2. 启动代理

```bash
ocx start            # defaults to port 10100
ocx start --port 8080
```

启动时，opencodex 会：

- 将其 PID 写入 `~/.opencodex/ocx.pid`（并拒绝重复启动）；
- 在 provider 支持时发现实时模型，并**把原生与已路由条目同步进 Codex 的模型目录**；
- 监听 `http://localhost:<port>/v1`。

如果请求的端口已被占用，`ocx start` 会停止并告知你是什么占用了该端口：如果那里响应的是 opencodex，请先运行 `ocx stop`；也可以使用 `ocx start --port <port>` 在空闲端口上启动。它不会自行切换到其他端口；旧行为会让两个代理同时运行，并将 Codex 重新指向后启动的代理。

检查它：

```bash
ocx status
ocx gui       # open the dashboard on the live port
```

## 3. 连接你的工具

选择你所用工具对应的分支。可以同时连接多个工具，它们共用同一组提供商和模型。

### Codex

如果你在第 1 步中接受了 Codex 提示，Codex 现在会透明地通过 opencodex 通信。如果你拒绝了该提示，或因为已有配置而跳过了设置，请在运行 Codex 之前打开仪表盘 **Connect** 页面上的 Codex 开关；[Codex 集成](/zh-cn/guides/codex-integration/)说明了它会修改什么以及如何恢复。

```bash
codex "Refactor this function for readability"
```

要针对某个特定的已路由模型，请使用 Codex 模型选择器中显示的 `provider/model` 形式：

```bash
codex -m "anthropic/claude-opus-5" "Explain this stack trace"
codex -m "ollama-cloud/glm-5.2"      "Write a SQL migration"
```

### Claude Code

先安装 `claude` CLI，然后运行：

```bash
ocx claude
```

`ocx claude` 会在代理未运行时启动它，并以指向 opencodex 的环境启动 Claude Code。额外参数会原样传递。层级默认值、其他启动器以及如何退出，请参见 [Claude Code](/zh-cn/guides/claude-code/)。

### Claude Desktop

```bash
ocx claude desktop
```

全新安装时会为整个应用设置网关配置；已经使用 first-party 模式的安装会保持原模式，可运行 `ocx claude desktop apply --gateway` 明确切换。first-party 模式会让 Desktop 继续使用 claude.ai，只路由其 Code 标签页，详见 [Claude Code](/zh-cn/guides/claude-code/) 中的 Claude Desktop 模式一节。

切换模式后，请完全退出并重新打开 Claude Desktop。

### Grok Build

在本地监听下，当 `~/.grok` 存在时，`ocx start` 会把可见模型注册到 `~/.grok/config.toml`。在 Grok Build 中选择一个 `ocx-*` 模型即可。远程配置和托管区块见 [Grok Build](/zh-cn/guides/grok-build/)。

添加提供商或模型后，运行 `ocx ensure` 或重启代理，Grok Build 才能看到它们。

### 其他工具

有托管集成的工具（OpenCode、Pi、Qoder、WorkBuddy、Kilo、Cline、T3 Code 等）可在仪表盘的 **Connect** 页面连接，或使用：

```bash
ocx integration client enable --client <id>
```

各工具的配置文件以及何时生效，见 [集成](/zh-cn/guides/integrations/)。其他支持自定义端点的工具，可以使用 OpenAI 兼容的 base URL `http://localhost:10100/v1`，或 Anthropic 的 base URL `http://localhost:10100`。

## 选择 sub-agent 模型（可选）

全新配置会在 Codex 的 sub-agent 选择器中提供五个原生模型：`gpt-5.5`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna` 和 `gpt-6-astra`。打开 `ocx gui`，可以替换或重新排序最多五个原生或已路由模型。仪表盘还可以设置一个首选 sub-agent 模型和 reasoning effort。参见 [Sub-agent Surface](/guides/sub-agent-surface/) 以选择 v1/base/v2，并了解何时适用 guidance、原生默认值和 fallback。

## 登录而非粘贴 key

部分 provider 支持真正的账号登录（OAuth，自动刷新）：

```bash
ocx login xai          # or: anthropic, kimi, kiro, google-antigravity, cursor
ocx logout xai
```

OpenAI 本身不需要 key——默认 provider 会直接透传你现有的 `codex login` 凭据（参见 [Providers](/guides/providers/)）。

## 停止与恢复

```bash
ocx stop          # stop the proxy and restore native Codex
ocx restore       # restore native Codex without stopping (alias: ocx eject)
ocx restore back  # route Codex through the still-running proxy again
```

## 下一步

- [工作原理](/getting-started/how-it-works/) — 每个请求会发生什么。
- [Providers](/guides/providers/) — 所有认证方式。
- [配置](/reference/configuration/) — 完整的 `config.json` 参考。
