---
title: Codex App 模型选择器
description: opencodex 模型如何通过共享 Codex 目录出现在 Codex App、Codex CLI 和 Codex TUI 中。
---

opencodex 不会修补 Codex App。它会写入 Codex CLI/TUI 已经读取的同一套 Codex 配置和模型目录。
因为 Codex App 读取这份共享状态，已路由的模型可以像普通 Codex 目录条目一样出现在 App 的模型选择器中。

## 集成路径

`ocx init`、`ocx start` 和 `ocx sync` 会保持解析后的 `CODEX_HOME` 目录下这些文件一致：

```text
$CODEX_HOME/config.toml
$CODEX_HOME/opencodex.config.toml
$CODEX_HOME/opencodex-catalog.json
$CODEX_HOME/models_cache.json
```

活动 provider 以根级配置键安装：

```toml
model_provider = "opencodex"
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
```

provider 本身注册为 Responses 兼容端点：

```toml
[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://127.0.0.1:10100/v1"
wire_api = "responses"
requires_openai_auth = true
```

`websockets` 默认关闭。只有设置 `"websockets": true` 时，opencodex 才会在 provider 表和目录条目中
广告 `supports_websockets = true`。

## 为什么路由模型会显示

Codex 模型选择器需要 Codex 形状的目录条目。opencodex 会克隆一个原生 Codex 模型模板，然后替换
路由模型身份：

```text
slug = "anthropic/claude-sonnet-..."
display_name = "anthropic/claude-sonnet-..."
visibility = "list"
```

克隆的条目会保留 reasoning 级别、shell 类型、API 支持标志和 base instructions 等严格解析字段。
因此每个路由条目都像一个有效的、可在选择器中显示的 Codex 模型。

## GPT-5.6 rollout metadata

GPT-5.6 Sol、Terra、Luna 按 preview-gated rollout 处理。即使已安装的 Codex 目录暂时落后,
opencodex 也可以作为 documented native additions 添加 `gpt-5.6-sol`、`gpt-5.6-terra`、
`gpt-5.6-luna`。这些条目的 `context_window` 与 `max_context_window` 固定为 372,000 usable tokens,
`auto_compact_token_limit` 按其 90% 计算。

这三个原生条目以及 OpenAI API key/OpenRouter routed fallback 条目都会把 `max` reasoning 作为独立
tier 暴露。模型名出现在选择器中只表示 opencodex 已准备好目录；实际请求是否成功仍取决于连接账号或
provider 的 preview 权限。

## Multi-agent surface mode

opencodex 增加了一个三态 multi-agent surface override,用于控制每个目录条目上的
`multi_agent_version` 字段：

| Mode | Effect |
| --- | --- |
| **All v1** | 强制每个模型使用 v1 multi-agent surface,覆盖 upstream pins（包括 sol/terra）。 |
| **Default**（安装默认值） | 遵循 upstream model pins：sol/terra 使用 v2,luna 使用 v1,其他所有模型跟随 codex 的 `multi_agent_v2` feature flag。 |
| **All v2** | 强制每个模型使用 v2 multi-agent surface,覆盖 upstream pins（包括 luna）。 |

可以从仪表盘 Models 页面（三段控件）、`ocx v2 mode v1|default|v2` 或
带 `{ "multiAgentMode": "v1" }` 的 `PUT /api/v2` 设置该模式。变更会应用到新的 Codex session。

## Ultra reasoning

无论 `multi_agent_v2` toggle 状态如何,目录中都会始终广告 Ultra。v2 toggle 只控制
multi-agent collab surface,不控制 ultra 可见性。在 wire 上,opencodex 会通过
`nativeEffortClamp` 将 ultra 限制到每个模型真实的最高档位（例如 gpt-5.5 ultra 会变成 xhigh）。

## Subagent 选择

Codex 的 `spawn_agent` 只会展示目录中优先级最高的前 5 个模型。你可以通过 `subagentModels` 或
Web 仪表盘选择最多 5 个 `provider/model` 或原生模型 id，opencodex 会把这些条目排到目录前面。

## 刷新模型状态

如果选择器里仍然显示旧条目，请刷新目录并重新打开目标 Codex 界面：

```bash
ocx sync
```

当 opencodex 修改路由模型可见性或目录元数据时，也会使 Codex 的 `models_cache.json` 失效。
