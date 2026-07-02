---
title: Codex 集成
description: opencodex 如何将自身注入 Codex、同步模型目录、驱动 subagent 选择器，并干净地恢复。
---

opencodex 通过编辑 Codex 读取的两样东西，让 Codex 经由 proxy 路由：它的配置（`$CODEX_HOME/config.toml`，默认 `~/.codex/config.toml`）和它的模型目录。每一次编辑都是幂等且可逆的。

## 配置注入

`ocx init`（以及 `ocx sync`）会调用注入器，写入：

```toml
# at the document root — Codex reads this as the active provider
model_provider = "opencodex"
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"

# appended at end of file (TOML tables are position-independent)
[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://127.0.0.1:10100/v1"
wire_api = "responses"
requires_openai_auth = true
# supports_websockets = true   # 仅当 config.websockets 为 true
```

它还会在 `$CODEX_HOME/opencodex.config.toml` 写入一个可选的 profile，以便你显式启用：

```bash
codex --profile opencodex "…"
```

:::caution
根级的 `model_provider` 键**必须**位于第一个 `[table]` 头之前，否则 Codex 会将其解析为某个 table 的一部分而忽略它。注入器会保证这一放置位置，并在重写前剥除任何散落或重复的副本——因此重新运行 `ocx init` / `ocx sync` 绝不会产生重复项。
:::

## 共享模型目录

Codex CLI、TUI、App 和 SDK 都读取同一个 Codex home。opencodex 会从 `CODEX_HOME` 解析该目录，
未设置时回退到 `~/.codex`，并管理以下文件：

```text
$CODEX_HOME/config.toml
$CODEX_HOME/opencodex.config.toml
$CODEX_HOME/opencodex-catalog.json
$CODEX_HOME/models_cache.json
```

`requires_openai_auth = true` 让 Codex App/TUI 的账号门控界面与原生 Codex 保持一致。
WebSocket 传输是单独的：opencodex 提供 `/v1/responses` WebSocket 端点，但只有在
`~/.opencodex/config.json` 中设置 `"websockets": true` 时才会广告 `supports_websockets = true`。

## 模型目录同步

Codex 显示的模型来自一个磁盘上的目录（默认为 `$CODEX_HOME/opencodex-catalog.json`）。在启动时以及执行 `ocx sync` 时，opencodex 会：

1. **备份**一次原始目录到 `~/.opencodex/catalog-backup.json`（以便置顶操作可逆）。
2. **获取**每个提供商的实时 `/models` 列表（缓存约 5 分钟；失败时回退到上一份正常列表，再回退到提供商已配置的 `models[]`）。
3. **合并**路由模型，作为带命名空间的条目（`provider/model`），从原生 Codex 目录模板克隆而来，以便 Codex 严格的解析器接受它们。
4. **过滤**掉 `config.disabledModels` 中的任何条目。
5. **重新排序**，使置顶模型排在最前（见下文），然后将合并后的目录写回。

路由的目录条目还会将其 GPT-5 身份重写为真实的上游模型名称，并且只暴露 `low | medium | high` 推理级别。

## subagent 选择器

Codex 的 `spawn_agent` 只会展示目录中**前 5 个路由模型**。`subagentModels`（最多 5 个 `provider/model` id）通过赋予它们最低的优先级数字使其排在最前，从而控制这 5 个是哪些：

```json
{
  "subagentModels": [
    "anthropic/claude-opus-4-8",
    "ollama-cloud/glm-5.2",
    "xai/grok-4.3"
  ]
}
```

优先级排序：置顶（0–4）< 其他路由（5）< 原生（9）。你也可以从 [web 仪表盘](/opencodex/zh-cn/guides/web-dashboard/) 管理这一项。

## 恢复原生 Codex

opencodex 绝不会把你困住。**`ocx stop` 是完全恢复原生 Codex 的单一命令** ——
它会停止 proxy、停止后台服务（如已安装），并剥除所有注入的行和路由的目录条目，使普通的 `codex`
完全像 opencodex 从未存在过一样工作：

```bash
ocx stop       # 停止 proxy + 服务，恢复原生 Codex
ocx restore    # 不停止 proxy 仅恢复  (别名: ocx eject)
```

当 opencodex 作为受管的 [后台服务](/opencodex/zh-cn/reference/cli/#ocx-service) 运行时，它会设置 `OCX_SERVICE=1`，这样由服务驱动的重启**不会**反复改写 Codex 配置——只有显式的 `ocx stop` / `ocx service stop` 才会恢复原生 Codex。
