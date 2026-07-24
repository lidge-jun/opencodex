---
title: 快速开始
description: 配置你的第一个 provider,用三条命令让 OpenAI Codex 通过 opencodex 进行路由。
---

本指南将带你从全新安装,一路走到用一个非 OpenAI 模型运行 Codex。

## 1. 运行设置向导

```bash
ocx init
```

`ocx init` 会引导你完成:

1. **选择 provider** —— 从内置 registry 的 50 个预设中选择一个，或选择 `custom` 手动输入
   base URL 和 adapter。
2. **API key** —— 粘贴一个 key,或引用一个环境变量,例如 `${ANTHROPIC_API_KEY}`。
3. **默认模型** —— 对于 API key、本地和 custom provider，可接受预设值或输入模型 id。
4. **代理端口** —— 默认为 `10100`。
5. **注入到 Codex？** —— 在通常的回环地址配置中，opencodex 会在
   `$CODEX_HOME/config.toml`（默认 `~/.codex/config.toml`）根级添加 `openai_base_url`，让 Codex
   内置的 `openai` provider 指向代理。监听远程或 LAN 地址时，则改用带 API 认证 header 的专用 provider 条目。
6. **安装自动启动 shim？** —— 启用后，每次启动 `codex` 都会先运行 `ocx ensure`。

结果会保存到 `$OPENCODEX_HOME/config.json`（默认 `~/.opencodex/config.json`）。

:::note[GPT-5.6 灰度发布条目]
稳定版 v2.7.1 会为 ChatGPT 直通、OpenAI API key、OpenRouter 和实验性 Cursor adapter 预置
GPT-5.6 Sol/Terra/Luna。只有上游账号具备权限时才能实际调用。OpenAI API key 与 OpenRouter
预设会声明 372,000 token 的可用 context window；Cursor 则使用自身 adapter 提供的元数据。
:::

## 2. 启动代理

```bash
ocx start            # 默认端口 10100
ocx start --port 8080
```

启动时,opencodex 会:

- 将其 PID 写入 `~/.opencodex/ocx.pid`(并拒绝重复启动),
- 在 provider 支持时发现实时模型，并**把原生与已路由条目同步进 Codex 的模型目录**，以及
- 在 `http://localhost:<port>/v1` 上监听。

如果请求的端口已被占用，`ocx start` 会选择一个空闲端口，将其写入 `runtime-port.json`，并更新
Codex 配置以使用实际监听端口。

检查它:

```bash
ocx status
ocx gui       # 在实际监听端口打开仪表盘
```

## 3. 使用 Codex

Codex 现在会透明地与 opencodex 通信:

```bash
codex "Refactor this function for readability"
```

若要指定某个已路由的模型,请使用 Codex 模型选择器所显示的 `provider/model` 形式:

```bash
codex -m "anthropic/claude-opus-5" "Explain this stack trace"
codex -m "ollama-cloud/glm-5.2"      "Write a SQL migration"
```

如果你拥有 GPT-5.6 权限，原生 ChatGPT 路径使用裸模型名，API key 和 OpenRouter 路径使用显式
`provider/model` 形式：

```bash
codex -m "gpt-5.6-sol"                    "Plan a risky refactor"
codex -m "openai-apikey/gpt-5.6-terra"    "Review this architecture"
codex -m "openrouter/openai/gpt-5.6-luna" "Summarize this trace"
```

## 选择 sub-agent 模型（可选）

新配置会在 Codex 的 sub-agent 选择器中优先显示 `gpt-5.5`、`gpt-5.6-sol`、
`gpt-5.6-terra`、`gpt-5.6-luna` 和 `gpt-5.4-mini`。通过 `ocx gui`，你可以从原生或已路由模型中
选择并调整最多五个条目的顺序。仪表盘还可以设置一个首选 sub-agent 模型及 reasoning effort；
opencodex 会把这项指引加入 v1 协作请求。

## 登录而非粘贴 key

部分 provider 支持真正的账号登录(OAuth,自动刷新):

```bash
ocx login xai          # 也可使用 anthropic、kimi、kiro、google-antigravity、cursor
ocx logout xai
```

默认 OpenAI 路径**无需 key** —— 它会直接转发你现有的 `codex login` 凭据。若要使用 OpenAI
API key，请添加 `openai-apikey` provider。该预设包含 `gpt-5.6-sol`、`gpt-5.6-terra`、
`gpt-5.6-luna`，但你的 API key 必须拥有实际使用权限
(参见 [Provider](/zh-cn/guides/providers/))。

## 停止与恢复

```bash
ocx stop          # 停止代理并恢复原生 Codex
ocx restore       # 不停止代理，仅恢复原生 Codex（别名：ocx eject）
ocx restore back  # 让 Codex 再次使用仍在运行的代理
```

## 下一步

- [工作原理](/zh-cn/getting-started/how-it-works/) —— 每个请求都发生了什么。
- [Provider](/zh-cn/guides/providers/) —— 各种认证方式。
- [配置](/zh-cn/reference/configuration/) —— 完整的 `config.json` 参考。
