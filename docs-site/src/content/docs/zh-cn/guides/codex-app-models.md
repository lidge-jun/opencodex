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

## Subagent 选择

Codex 的 `spawn_agent` 只会展示目录中优先级最高的前 5 个模型。你可以通过 `subagentModels` 或
Web 仪表盘选择最多 5 个 `provider/model` 或原生模型 id，opencodex 会把这些条目排到目录前面。

## 刷新模型状态

如果选择器里仍然显示旧条目，请刷新目录并重新打开目标 Codex 界面：

```bash
ocx sync
```

当 opencodex 修改路由模型可见性或目录元数据时，也会使 Codex 的 `models_cache.json` 失效。
