---
title: Codex App 模型选择器
description: opencodex 模型如何通过共享 Codex 目录出现在 Codex App、Codex CLI 和 Codex TUI 中。
---

opencodex 不会修改 Codex App。它会写入 Codex CLI/TUI 已经使用的同一套 Codex 配置和模型目录。
Codex App 也会读取这份共享状态，因此路由模型可以像普通 Codex 目录条目一样出现在 App 的模型
选择器中。

OpenAI 身份固定为两种：bare native id 是由 `codexAccountMode` 控制 Pool（默认）或 Direct 的
单一 `openai` 组，`openai-apikey/<model>` 是 API key。切换模式不会改变模型 id。API GPT-5.6 使用 1,050,000
context / 922,000 max input；`*-pro` picker id 保持公开身份，线上使用 base 模型加
`reasoning.mode: "pro"`。

## 集成路径

`ocx init`、`ocx start` 和 `ocx sync` 会保持解析后的 `CODEX_HOME` 目录下这些文件一致：

```text
$CODEX_HOME/config.toml
$CODEX_HOME/opencodex.config.toml
$CODEX_HOME/opencodex-catalog.json
$CODEX_HOME/models_cache.json
```

使用默认的 loopback 监听地址时，Codex 会保留内置的 `openai` provider id。opencodex 通过以下
根级键把该 provider 和模型目录指向代理：

```toml
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
openai_base_url = "http://127.0.0.1:10100/v1"
```

如果 hostname 不是 loopback，Codex 还需要发送生成的 API 认证 header。此模式会使用根级
`model_provider = "opencodex"` 和一个独立的 Responses 兼容 provider：

```toml
[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://your-host:10100/v1"
wire_api = "responses"
requires_openai_auth = true
env_http_headers = { "x-opencodex-api-key" = "OPENCODEX_API_AUTH_TOKEN" }
```

`websockets` 默认关闭。只有设置 `"websockets": true` 时，独立 provider 和目录条目才会声明
`supports_websockets = true`。在 loopback 模式下，Codex 的内置 provider 可能会先尝试
WebSocket；若代理未启用该功能，则返回 `426`，让 Codex 回退到 HTTP/SSE。完整的注入与恢复流程见
[Codex 集成](/zh-cn/guides/codex-integration/)。

## 为什么路由模型会显示

Codex 模型选择器要求条目符合 Codex 目录结构。opencodex 会克隆一个原生 Codex 模型模板，然后
替换路由模型的身份信息：

```text
slug = "anthropic/claude-sonnet-..."
display_name = "anthropic/claude-sonnet-..."
visibility = "list"
```

克隆后的条目会保留 reasoning 级别、shell 类型、API 支持标志和 base instructions 等严格解析器
所需字段。随后，opencodex 会移除该路由无法兑现的原生专属能力，例如 OpenAI service-tier 元数据。

## v2.7.1 模型范围

原生回退列表包含 `gpt-5.5`、`gpt-5.4`、`gpt-5.4-mini`、
`gpt-5.3-codex-spark` 以及 GPT-5.6 Sol/Terra/Luna。对于 GPT-5.5/5.4 系列，opencodex 会
保留已安装 Codex 目录中信息更完整的实时条目，仅在条目缺失时才合成。内置的上游快照只用于
GPT-5.6，以便提供每个模型真实的身份和元数据，而不是套用旧模板近似生成。

| 路由 | 选择器 id 与目录元数据 |
| --- | --- |
| Codex 登录（Pool 或 Direct） | `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`（372,000 token） |
| OpenAI（API key） | `openai-apikey/gpt-5.6-*` 和 `openai-apikey/gpt-5.6-*-pro`（1,050,000；max input 922,000） |
| OpenRouter | `openrouter/openai/gpt-5.6-sol`、`openrouter/openai/gpt-5.6-terra`、`openrouter/openai/gpt-5.6-luna`（1,050,000） |
| Cursor | 静态回退目录包含 `cursor/gpt-5.6-sol`、`cursor/gpt-5.6-terra`、`cursor/gpt-5.6-luna`（1,000,000），以及 `cursor/grok-4.5`、`cursor/grok-4.5-fast`（500,000）；账号的实时发现结果决定最终显示哪些模型。 |
| xAI | 以实时发现结果为准；回退目录默认使用 `xai/grok-4.5`，上下文为 500,000，并提供 `low` / `medium` / `high` reasoning 控制。 |

固定的 GPT-5.6 条目会保留精确的上游 reasoning 阶梯。Sol 和 Terra 从 `low` 到 `ultra`，Luna
最高到 `max`。Sol 默认使用 `low`，Terra 和 Luna 默认使用 `medium`。`ultra` 是客户端侧的
“最大 reasoning + 主动委派”选项，到达后端时会转换为 `max`。模型出现在选择器中只表示目录已经
准备好；关联的账号或 API key 仍需具备该模型的实际权限。

## 原生与路由模型开关

仪表盘的 Models 页面通过同一个 `disabledModels` 管理两类模型：

- 路由 id 使用 `provider/model` 命名空间。禁用后，该模型会从同步目录和 `/v1/models` 中移除。
- 原生 GPT id 是不含 `/` 的 slug。禁用时不会删除目录条目，而是将 `visibility` 改为 `hide`，
  以便重新启用时精确恢复原条目；禁用期间，OpenAI 列表格式也会省略它。
- 原生模型行来自受支持的静态集合，因此即使模型已禁用，仍会留在仪表盘中供你重新启用。

可见性处理位于快照升级之后。每次切换模型后，管理 API 都会刷新目录，并强制把 Codex 模型缓存
标记为过期。

## Multi-agent surface 模式

opencodex 为每个目录条目的 `multi_agent_version` 提供三态 override：

| 模式 | 效果 |
| --- | --- |
| **v1** | 强制所有模型使用 v1 multi-agent surface，并覆盖上游固定值（包括 Sol/Terra）。 |
| **base**（安装默认值） | 恢复上游固定值：Sol/Terra 使用 v2，Luna 使用 v1；未固定的模型遵循 Codex 的 `multi_agent_v2` 功能开关。 |
| **v2** | 强制所有模型使用 v2 multi-agent surface，并覆盖上游固定值（包括 Luna）。 |

可从 Dashboard 或 Models 页面、`ocx v2 mode v1|default|v2`，或通过带
`{ "multiAgentMode": "v1" }` 的 `PUT /api/v2` 设置该模式。变更从新的 Codex session 开始生效。

:::caution
在 v2（`multi_agent_v2`）界面中，生成的子代理会继承父 session 的模型。仪表盘中的委派模型/
reasoning 选择器只是 v1 prompt 指引，并不是由代理在每次生成时执行跨模型路由。权威说明见
[子代理界面](/zh-cn/guides/sub-agent-surface/)。
:::

## 顶级 reasoning 档位

目录中显示哪些 reasoning 档位与 v1/base/v2 界面模式无关。生成的、支持 reasoning 的条目会提供
`max`，以便直接指定的子代理强度通过校验；当前生成的路由条目和旧一代原生 GPT 条目还会提供
`ultra`。精确的上游 GPT-5.6 阶梯会原样保留，因此 Luna 只有 `max`，没有 `ultra`。

在实际请求中，路由 adapter 会映射或限制不受支持的档位。对于真实最高档位为 `xhigh` 的旧原生
模型，`nativeEffortClamp` 会把直接指定的 `max` 或 `ultra` 选择转换为 `xhigh`，例如 GPT-5.5。
Sol、Terra 和 Luna 都有真实的 `max` 档位。

## Fast tier 规则

Codex 在配置文件中这样保存 fast 模式：

```toml
service_tier = "fast"

[features]
fast_mode = true
```

模型目录和运行时请求使用的 tier id 则是 `priority`。opencodex 会保留这一差异。原生 OpenAI
透传模型继续支持 fast；路由到非 OpenAI provider 的模型会移除 service-tier 元数据，避免显示
无法兑现的 fast 选项。

## 子代理选择

Codex 会按 `priority` 升序排列选择器中可见的目录条目，并将前五个显示为 `spawn_agent` 模型
override。你可以通过 `subagentModels` 或仪表盘的 Subagents 页面选择最多五个原生 id 或
`provider/model` id；opencodex 会按所选顺序赋予它们 0-4 的 priority。其他模型仍可通过精确 id
直接调用。

置顶模型列表与 Dashboard 的 **Sub-agent delegation** 指引相互独立。尤其需要注意，置顶模型
override 不能绕过 v2 的父模型继承规则。

## 刷新模型状态

如果选择器仍显示旧条目，请刷新目录并重新打开目标 Codex 界面：

```bash
ocx sync
```

当目录的可见性、priority 或元数据发生变化时，opencodex 会用一个刻意标记为过期的缓存 wrapper
重写 `models_cache.json`，使 Codex 下次刷新模型时读取新目录。
