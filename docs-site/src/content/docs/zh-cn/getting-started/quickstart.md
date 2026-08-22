---
title: 快速开始
description: 配置你的第一个 provider，并在三条命令内让 OpenAI Codex 通过 opencodex 路由。
---

本指南将带你从全新安装，一路走到用一个非 OpenAI 模型运行 Codex。

## 1. 运行设置向导

```bash
ocx init
```

`ocx init` 会引导你完成：

1. **选择 provider** — 从内置 registry 的 79 个预设中选择一个，或选择 `custom` 手动输入 base URL 和 adapter。
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

如果请求的端口已被占用，`ocx start` 会选择一个空闲端口，将其记录到 `runtime-port.json`，并更新 Codex 以使用这个实际监听地址。

检查它：

```bash
ocx status
ocx gui       # open the dashboard on the live port
```

## 3. 使用 Codex

Codex 现在会透明地通过 opencodex 通信：

```bash
codex "Refactor this function for readability"
```

要针对某个特定的已路由模型，请使用 Codex 模型选择器中显示的 `provider/model` 形式：

```bash
codex -m "anthropic/claude-opus-5" "Explain this stack trace"
codex -m "ollama-cloud/glm-5.2"      "Write a SQL migration"
```

## 选择 sub-agent 模型（可选）

全新配置会在 Codex 的 sub-agent 选择器中提供五个原生模型：`gpt-5.5`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna` 和 `gpt-5.4-mini`。打开 `ocx gui`，可以替换或重新排序最多五个原生或已路由模型。仪表盘还可以设置一个首选 sub-agent 模型和 reasoning effort。参见 [Sub-agent Surface](/guides/sub-agent-surface/) 以选择 v1/base/v2，并了解何时适用 guidance、原生默认值和 fallback。

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
