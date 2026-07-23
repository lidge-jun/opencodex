---
title: Codex 集成
description: opencodex 如何将自身注入 Codex、同步模型目录、驱动 subagent 选择器，并干净地恢复。
---

opencodex 通过编辑 Codex 读取的两样东西，让 Codex 经由 proxy 路由：它的配置（`$CODEX_HOME/config.toml`，默认 `~/.codex/config.toml`）和它的模型目录。每一次编辑都是幂等且可逆的。

OpenAI 提供一条 bare `openai` Codex 登录路径和 `openai-apikey/<model>` API 路径。
`openai` 可选 Pool（默认，主账户加添加账户）或 Direct（当前 caller/主登录 bearer），模型 id
保持不变。路径之间不会 fallback。shipped v1 配置迁移到 marker 2，并保留
`config.json.pre-openai-tiers-v2.bak` 供手动恢复。

## 配置注入

`ocx init`、`ocx start` 和 `ocx sync` 都会调用注入器。在默认的 loopback 绑定下，它会保留 Codex
内置的 `openai` 提供商 id，并将该提供商指向 opencodex：

```toml
# 位于第一个 table 之前的根级键
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
# Auto-injected by opencodex
openai_base_url = "http://127.0.0.1:10100/v1"

[features]
fast_mode = true
```

proxy 的默认端口为 `10100`，提供 `POST /v1/responses`、`POST /v1/responses/compact`、
`POST /v1/images/generations`、`POST /v1/images/edits`、`GET /v1/models`、`GET /healthz`
以及 `/api/*` 管理 API。

### 内置图像生成（`image_gen`）

Codex 的内置 `image_gen` 工具不经过 `/v1/responses`——codex-rs 扩展直接 POST
`{base_url}/images/generations`（附带参考图像时为 `/images/edits`），使用与聊天相同的
ChatGPT bearer 认证。由于注入的 `base_url` 指向 opencodex，proxy 会把这些调用中继到
OpenAI 上游：

- **单一、感知模式的 forward 候选：** Pool 选择合格的主账户或添加账户；Direct 使用 caller
  OAuth bearer。图像请求遵循同一模式。
- **OpenAI API key：** 仅当 forward 候选没有拥有认证失败时使用。不会用单独计费的 API 调用掩盖
  损坏或过期的 Pool 凭证。
- **两者都没有：** proxy 返回明确的错误而不是含糊的 404。其他路由提供商（Cursor、Gemini、
  Kiro 等）无法提供图像生成；如果想完全关闭该工具，可在 Codex 中执行
  `codex features disable image_generation`（即 `config.toml` 的
  `[features] image_generation = false`）。

如果 `hostname` 不是 loopback 地址，Codex 必须发送自动生成的 API 认证请求头。此时注入器会改用
专用提供商：

```toml
# 根级键
model_provider = "opencodex"
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"

# 追加到文件末尾
# Auto-injected by opencodex
[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://your-host:10100/v1"
wire_api = "responses"
requires_openai_auth = true
env_http_headers = { "x-opencodex-api-key" = "OPENCODEX_API_AUTH_TOKEN" }
# supports_websockets = true   # 仅当 config.websockets 为 true
```

当 OpenCodex 管理路由时，两种模式都会把 `$CODEX_HOME/opencodex.config.toml` 写成参考/回退配置。
loopback 模式下，其中包含自动注入被移除时可手动合并的根级键；non-loopback 模式下，其中包含
专用提供商配置。外部提供商模式不会修改此配置文件。

:::caution
`openai_base_url`、`model_provider`、`model_catalog_json` 等根级键**必须**位于第一个 `[table]`
头之前。注入器会保证这一位置，并清理自己留下的旧值和重复项。用户自己设置的根级
`openai_base_url` 不会被覆盖；如果检测到该值，同步仍会更新模型目录，但会明确提示路由没有注入。
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

在 WSL 中，如果未设置 `CODEX_HOME`，且 Linux 侧 `~/.codex/config.toml` 不存在，opencodex 还会检查
`/mnt/c/Users/*/.codex/config.toml` 下的 Windows Codex Desktop home。只有候选项恰好为一个时才会
使用该目录，让 WSL app-server mode 和 Windows Codex Desktop 共享同一份 config 与 auth 文件。要覆盖
此检测，请显式设置 `CODEX_HOME`。

在专用提供商模式下，`requires_openai_auth = true` 会让 Codex App/TUI 的账号门控界面与原生
Codex 保持一致。opencodex 也提供 `/v1/responses` WebSocket。专用提供商仅在
`"websockets": true` 时声明 `supports_websockets = true`；loopback 模式下，Codex 的内置提供商
可能会先尝试 WebSocket，如果功能未启用，proxy 会返回 `426`，使 Codex 回退到 HTTP/SSE。

## 线程标识与历史记录

默认 loopback 方式会让新线程继续使用 Codex 原生的 `openai` 提供商标识，因此普通的恢复历史无需
重映射。第一次同步时，它还会把旧版 opencodex 改过标识的线程迁回 `openai`。non-loopback 的专用
提供商模式会在运行期间把历史记录映射到 `opencodex`，退出时再恢复已备份的元数据。若希望完全不修改
历史记录，请设置 `syncResumeHistory: false`。

## 模型目录同步

Codex 显示的模型来自一个磁盘上的目录（默认为 `$CODEX_HOME/opencodex-catalog.json`）。在启动时以及执行 `ocx sync` 时，opencodex 会：

1. **备份**一次原始目录到 `~/.opencodex/catalog-backup.json`（以便置顶操作可逆）。
2. **获取**符合条件的提供商实时模型目录（缓存约 5 分钟；失败时先回退到上一份正常列表，再回退到
   已配置的 `models[]`）。`forward` 认证没有模型端点；Cursor 使用 `GetUsableModels` RPC，而不是
   `/models`。
3. **合并**路由模型，作为带命名空间的条目（`provider/model`），从原生 Codex 目录模板克隆而来，以便 Codex 严格的解析器接受它们。
4. **应用过滤**：`config.disabledModels`，以及每个提供商非空的 `selectedModels` allowlist。
5. **重新排序**，使置顶模型排在最前（见下文），然后将合并后的目录写回。

路由目录条目还会把 GPT-5 身份文案改为真实的上游模型名称。reasoning 选项会依据提供商和模型元数据，
使用 Codex 的 `low | medium | high | xhigh | max | ultra` 档位；上游不支持的值会在发送请求前完成
映射或下调。

## subagent 选择器

Codex 的 `spawn_agent` 会按优先级排序，然后展示**前 5 个在选择器中可见的目录模型**。
`subagentModels` 最多接受五个 id，可以同时使用裸原生 GPT slug 和带命名空间的 `provider/model`
路由；所选模型会按顺序获得 0–4 的优先级。

```json
{
  "subagentModels": [
    "gpt-5.5",
    "gpt-5.6-sol",
    "anthropic/claude-opus-4-8",
    "xai/grok-4.5",
    "cursor/gpt-5.6-terra"
  ]
}
```

优先级排序：置顶（0–4）< 其他路由（5）< 原生（9）。你也可以从 [web 仪表盘](/opencodex/zh-cn/guides/web-dashboard/) 管理这一项。

## Codex 账号预热

向 Codex 账号池添加 ChatGPT 账号时，opencodex 会在保存前向 Codex Responses 后端发送一个小型
streaming 请求来验证凭据。输入使用真正的 Responses item 数组
（`input: [{ type: "message", ... }]`），并等待 `response.completed`。默认模型为
`gpt-5.4-mini`；若该模型返回 HTTP 400，则改用 `gpt-5.5` 重试。结构化的上游错误详情会显示给用户，
但不会泄露原始响应正文。后台重新验证是独立功能，默认关闭；只有启用 Token Guardian、将 `chatgpt`
刷新策略设为 `proactive`，并把 `tokenGuardian.codexWarmupEnabled` 设为 true 时才会运行。

## 恢复原生 Codex

opencodex 绝不会把你困住。**`ocx stop` 是完全恢复原生 Codex 的单一命令** ——
它会停止 proxy、停止后台服务（如已安装），并剥除所有注入的行和路由的目录条目，使普通的 `codex`
完全像 opencodex 从未存在过一样工作：

```bash
ocx stop       # 停止 proxy + 服务，恢复原生 Codex
ocx restore    # 不停止 proxy 仅恢复  (别名: ocx eject)
ocx restore back # 让普通 Codex 重新指向仍在运行的 proxy
```

当 opencodex 作为受管的 [后台服务](/opencodex/zh-cn/reference/cli/#ocx-service) 运行时，它会设置 `OCX_SERVICE=1`，这样由服务驱动的重启**不会**反复改写 Codex 配置——只有显式的 `ocx stop` / `ocx service stop` 才会恢复原生 Codex。
