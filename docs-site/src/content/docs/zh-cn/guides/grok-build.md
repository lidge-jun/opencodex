---
title: Grok Build
description: 在 xAI 的 Grok Build CLI 中使用任何由 opencodex 路由的模型——在代理运行期间，模型会自动注册到 ~/.grok/config.toml。
---

opencodex 在本地端口提供一个与 OpenAI 兼容的 `POST /v1/chat/completions`（以及 `/v1/responses`），而 Grok Build 支持针对与 OpenAI 兼容的服务器使用自定义模型。从这次集成开始，opencodex 会将其全部可见目录自动注册到 Grok Build 中，无需手动编辑配置。

## 自动注册

当 `~/.grok` 存在时，`ocx start`（以及 `ocx ensure` / `ocx restart`）会向 `~/.grok/config.toml` 写入一个受管理的区块：

```toml
# >>> opencodex managed block — do not edit (removed by `ocx stop`) >>>
[model_providers.opencodex]
base_url = "http://127.0.0.1:10100/v1"
api_backend = "responses"
api_key = "opencodex-loopback"
extra_headers = { "x-opencodex-grok" = "1" }

[model.ocx-gpt-5-6-sol]
model = "gpt-5.6-sol"
model_provider = "opencodex"
name = "OCX gpt-5.6-sol"
context_window = 272000
supports_reasoning_effort = true
reasoning_effort = "low"

[[model.ocx-gpt-5-6-sol.reasoning_efforts]]
id = "low"
value = "low"
label = "Low"
description = "Quick, fast implementations"
default = true
# ... remaining rungs for this model, then one [model.ocx-*] table per visible model,
# each referencing model_provider = "opencodex" ...
# <<< opencodex managed block <<<
```

- **增量式：** 受边界线之外的你自己的配置不会被触碰。首次向已存在文件注入之前，会先写入一次性备份到 `~/.grok/config.toml.bak-opencodex`。
- **幂等：** 每次 `ocx start`（以及在启用自动启动时的 `ocx ensure`）都会用当前目录替换这段有边界线的区块。
- **卸载时移除：** `ocx stop`、`ocx eject`、`ocx uninstall`，以及非服务模式下的守护进程正常关闭，都会删除这段有边界线的区块，并将你的文件逐字节恢复。若在服务管理器下运行，卸载流程会通过 `ocx stop`/`ocx uninstall` 进行（服务模式进程会刻意在重启后保留该区块）。
- **冲突安全：** 你自己的 `[model.*]` 表中已经定义过的别名会被保留（opencodex 会为自己的条目追加后缀）；受损的边界线（有起始标记但没有结束标记）会拒绝任何自动变更，并要求手动修复。

然后在 Grok Build 中选择一个模型：

```bash
grok models          # lists ocx-* entries alongside native grok models
grok -m ocx-anthropic-claude-opus-4-8 -p "hello"
# or in the TUI: /model ocx-anthropic-claude-opus-4-8
```

## 推理强度

Grok Build 的 `/effort`（以及 `--effort`）适用于目录条目声明了推理档位的模型。
模型列表会读取原始 `GET /v1/models` 响应，其中的条目需要包含
`supports_reasoning_effort` 和 `reasoning_efforts` 菜单选项。这组档位经过 Grok 兼容投影后
会写入每个受管理的 `[model.*]` 表，包括 `supports_reasoning_effort`、默认
`reasoning_effort` 和 `[[model.<alias>.reasoning_efforts]]` 选择项。对于路由模型，
opencodex 会映射已配置的提供方档位（`reasoningEfforts` /
`modelReasoningEfforts`，以及 `modelDefaultReasoningEfforts` 中的默认值）。这些元数据
描述代理配置的路由档位；适配器可以模拟推理，或将档位映射到提供方专用字段。档位列表
为空的模型不会显示 effort 控件。原生 GPT-5.6 条目会保留固定的上游推理档位。
模型声明的有效 Grok 档位（包括 `none` 和 `minimal`）都会保留。不受支持或重复的档位
（包括 Codex 专用的 `ultra`）会从文件中省略，从而确保写出的每个选项都可执行。

Grok Build 通过 Responses API 与 opencodex 通信。当路由声明推理档位时，Responses
直通会按配置转发 `reasoning.summary`，因此推理轨迹会以 Responses reasoning 项的形式
原生到达 Grok。需要模型执行推理且不返回轨迹的客户端，可以设置
`reasoning.summary: "none"`。显式设置的 `reasoning.summary` 优先于路由默认值。

## 认证说明

即使在 loopback 上，Grok Build 对自定义模型也要求一个非空 API key。注入的条目携带的是占位符（`opencodex-loopback`）——opencodex 会忽略 loopback 连接的接入密钥，因此这里不涉及任何真实机密。

**自动注册仅限 loopback。** 当 opencodex 绑定到非 loopback 主机时——包括通配符 `0.0.0.0` 和 `::`，它们会暴露所有网卡——请求需要你的真实接入令牌，而受管理区块无法安全地携带它。把字面令牌写进去会把你的密钥放进 `~/.grok/config.toml`，并在下次 `ocx start`/`ensure`/`restart` 时覆盖你在那里设置的内容。所以在这种情况下，opencodex 根本不会写入任何内容（并且会移除早先 loopback 绑定留下的任何区块），然后你需要在受管理标记之外自己配置这些模型，因为 opencodex 在那里做的任何事都不会覆盖它们。精确表结构见[手动方案](#manual-recipe-without-auto-registration)，并同时设置 `base_url`（从你运行 `grok` 的位置实际可达的主机）和 `api_key`（你的 `OPENCODEX_API_AUTH_TOKEN`）。

不要在这里把 `api_key` 换成 `env_key`。解析失败的 `env_key` 不会阻止请求——Grok 会回退到你的 xAI 会话令牌，并把它发送到该条目指定的 `base_url`，而对于局域网部署来说，这通常是一个并非 xAI 的明文 HTTP 端点。

注入在 provider 条目上的 `api_key` 会在这些模型的 Grok 凭据链中排在首位，因此对接 opencodex 时不需要额外登录 Grok。原生 grok 模型以及任何会直接联系 xAI 的 harness 功能，仍然保留你正常的 `grok login` / `XAI_API_KEY` 配置。

## 手动方案（不使用自动注册）

如果你自己管理 `~/.grok/config.toml`——或者 opencodex 绑定在非 loopback 地址上——请在 `# >>> opencodex managed block` 标记之外，添加一个 `[model_providers.opencodex]` 区块以及引用它的逐模型表：

```toml
[model_providers.opencodex]
base_url = "http://127.0.0.1:10100/v1"
api_backend = "responses"
api_key = "opencodex-loopback"

[model.ocx-opus]
model = "anthropic/claude-opus-4-8"
model_provider = "opencodex"
```

如果代理可通过网络访问，请把 `base_url` 指向 `grok` 实际可以连接的地址，并使用你的接入令牌：

```toml
[model_providers.opencodex]
base_url = "http://192.168.1.10:10100/v1"   # the reachable host, not 127.0.0.1
api_backend = "responses"
api_key = "your-OPENCODEX_API_AUTH_TOKEN"

[model.ocx-opus]
model = "anthropic/claude-opus-4-8"
model_provider = "opencodex"
```

托管区块现在使用 `[model_providers.<id>]` 继承，需要 Grok Build 0.2.109 或更高版本（发布于 2026-07-21）。在更早的版本上，继承的 `base_url` 不会应用到推理路由——请升级，或在每个 `[model.*]` 表上使用逐模型直接字段（`base_url`/`api_backend`/`api_key`）。

任何包含点号的别名都要加引号：裸写的 `[model.grok-4.5]` 是一个三段式键路径，而不是 id `grok-4.5`。为此，生成的别名会完全避免使用点号。

## 已知限制

- **服务安装后的 `ocx restart`：** 运行中的代理负责重启授权和排空协调；旧进程退出后，由已安装的服务管理器启动替换进程。服务监督始终保留。仅在 loopback 自动注册模式下，受管理区块也会在交接期间保留；非 loopback 部署使用手动管理的 Grok 配置。只有确认同一端口上出现另一个经过身份验证且健康的进程后，命令才会成功。
- **配置读取时机：** 先启动 opencodex，再启动 `grok`，结果最可预测。Grok Build 会监视 `~/.grok/config.toml`，并在 `[model]` 表实际发生变化时重新加载（大约一秒的防抖，按内容比较），因此刷新后的区块可以在无需重启的情况下进入已打开的会话。要确认 Grok 解析到了什么，可以运行 `grok inspect`：它会列出已加载的配置来源，并提示被拒绝的字段，但不会打印最终解析出的模型列表。当前 Grok Build 会报告并跳过无效的模型字段，同时保留该模型条目的其余部分。TOML 语法错误仍会阻止文件加载。opencodex 会以原子方式写入文件，因此 Grok 每次重新加载时都会看到完整文档。
- **目录更新：** 有边界线的区块反映的是注入时的目录状态。添加提供方或模型后，运行 `ocx ensure`（或重启代理）以刷新它。
