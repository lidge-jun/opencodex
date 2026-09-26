---
title: Cursor Private Inference
description: 无需公开隧道，在 macOS、Windows 或 Linux 的 Cursor 本地代理版本中使用经 opencodex 路由的模型。
---

普通 Cursor 无法连接你本机上的 proxy。设置“Override OpenAI Base URL”后，Cursor 的后端会构造提示词，并从 Cursor 的服务器调用该 URL；它们会拒绝 loopback、局域网及私有地址。因此，社区里将 Cursor 接入本地模型的方法最后通常都需要 ngrok、Cloudflare Tunnel 或 VPS。

Cursor 另有一个桌面版本 **Cursor Private Inference**，其代理循环在本地运行，并调用你配置的 OpenAI 兼容 gateway。将其指向 opencodex，就能无需隧道、修改应用或 TLS 而使用路由模型。本页介绍这一版本。

## 开始之前

请先阅读本节；这是最容易被忽略的部分。

- **opencodex 不分发此版本。** Cursor 也没有公开说明。它不从 cursor.com 链接，可能随时变化，也可能不再提供。如果你尚未拥有它，本指南不适用；请改用社区的 [`ocx-cursor`](https://www.npmjs.com/package/ocx-cursor) 桥接服务与公开 HTTPS 端点。
- **仍需登录 Cursor。** 登录界面出现在 gateway 对话框之前。
- **无法使用 Cursor 自有模型。** 本地模式下，选择器只列出 gateway 返回的模型。Tab 补全、Cursor 的模型目录（Composer、Auto）及 Cloud Agents 均不可用。如果配置了 Cursor provider，仍可通过 opencodex 自身的 `cursor/*` 路由访问其模型。
- **每个回合都会携带 Cursor 的本地系统提示词**，从第二回合开始约为 23k token。选择模型时请预留这部分预算。
- **它与普通 Cursor 共用身份和数据。** 两者使用相同的 bundle id、`~/.cursor`，以及 macOS 上的 `Application Support/Cursor`、Windows 上的 `%APPDATA%\Cursor` 或 Linux 上的 `~/.config/Cursor`。使用 `--user-data-dir <dir>` 启动，以隔离两个版本；除非想复制设置，否则首次运行时不要勾选“Import data from existing Cursor installation”。

## 识别已安装的版本

两个版本在 Dock 中都叫“Cursor”，且共用 bundle id，因此请检查 `product.json`：

| 平台 | product.json |
|---|---|
| macOS | `/Applications/Cursor Private Inference.app/Contents/Resources/app/product.json` |
| Windows | `%LOCALAPPDATA%\\Programs\\cursor-private-inference\\resources\\app\\product.json` |
| Linux | `<install root>/resources/app/product.json`（AppImage 需要先解压） |

本地代理版本的 `nameLong` 为 `"Cursor Private Inference"`，普通版则为 `"Cursor"`；`version` 是构建版本（撰写时为 3.18.25）。仪表盘的 Integrations > Cursor 卡片会执行相同检查并列出发现的版本。本地模式在工作台 bundle 内启用，不在 `product.json` 中，因此没有可以翻转的标志：如果 `nameLong` 表示普通 Cursor，该安装就无法访问 loopback gateway。

与 gateway 通信的代理循环位于同一安装根目录下的 `extensions/cursor-agent-exec/dist/main.js`。opencodex 会以只读、有界方式读取它，获取 Cursor 的推理强度表；参见“模型与推理强度”。

## 配置 gateway

首先确保 opencodex 正在运行（`ocx service status`）。以下两种方法都可用，最终配置相同。

**在应用中。** Settings → Models → Gateway → Configure gateway：

| 字段 | 值 |
|---|---|
| Base URL | `http://127.0.0.1:10100/v1`（包含 `/v1`；允许普通 `http://` loopback） |
| API Key | 若服务启用了 API 认证，使用 `OPENCODEX_API_AUTH_TOKEN` 的值；否则可使用 `opencodex-loopback` 等任意占位值 |

点击 **Refresh model list**。选择器会填入 opencodex 的 `/v1/models` 列表；启用想要的模型行。

**通过环境变量。** 应用启动时读取：

```text
CURSOR_LOCAL_AGENT_BASE_URL=http://127.0.0.1:10100/v1
CURSOR_LOCAL_AGENT_API_KEY=opencodex-loopback
CURSOR_LOCAL_AGENT_HEADERS=            # optional, newline-separated "Header-Name: value" lines
```

`CURSOR_LOCAL_AGENT_HEADERS` 会拒绝 `User-Agent` 和未解析的 `{...}` 占位符；`{gitOrgRepo}` 与 `{gitBranch}` 会展开。

优先级从高到低为：每个模型的凭据 → Settings 中保存的 gateway → `CURSOR_LOCAL_AGENT_*` → `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`（兼容性回退）。环境变量不会覆盖已保存的 gateway；如果想通过环境变量切换，请先在 Settings 中清除已保存配置。

Cursor Private Inference 是 GUI 应用，仅设置交互式 shell profile 并不足够；变量必须出现在启动应用的进程环境中。

| 操作系统 | 设置位置 |
|---|---|
| macOS | 当前登录会话使用 `launchctl setenv CURSOR_LOCAL_AGENT_BASE_URL http://127.0.0.1:10100/v1`；长期保留可使用带 `EnvironmentVariables` 的 LaunchAgent。从终端启动应用也可以。 |
| Windows | 使用 `setx CURSOR_LOCAL_AGENT_BASE_URL http://127.0.0.1:10100/v1`（用户范围，仅影响新进程），或通过 System Properties → Environment Variables 设置。之后重启应用。 |
| Linux | 对显示管理器会话使用 `~/.profile` 或 `~/.pam_environment`；如果桌面运行在用户 systemd 会话下，则使用 `systemctl --user set-environment CURSOR_LOCAL_AGENT_BASE_URL=http://127.0.0.1:10100/v1`。从终端启动的 AppImage 会继承该 shell 的环境。 |

此版本提供 macOS（arm64、x64、universal）、Windows（x64、arm64）和 Linux（x64、arm64）构建。各平台配置相同。

## 从仪表盘查看

opencodex 仪表盘在 Integrations 下有一个 **Cursor** 标签页（`/#integrations/cursor`）。它对 Cursor 只读：不会写入 Cursor 的设置数据库、钥匙串条目或应用 bundle，因此没有可以直接切换的开关。它会提供配置值，并显示配置是否生效。

- **已安装版本。** 显示是否存在 Cursor Private Inference（含路径和版本）及普通 Cursor（仅路径）。如果只找到普通 Cursor，标签页会向 Cursor 自己的更新通道（`api2.cursor.sh` 上的 `cursor-local` 通道）查询它为当前平台和 CPU 提供的 local-mode 安装程序，显示该版本及指向 `downloads.cursor.com/local-mode/` 安装程序的链接，并链接回本页。opencodex 只显示链接，从不下载、启动或安装任何东西。如果通道无法访问或返回无法使用的内容，标签页会说明目前无法确定安装程序；无论哪种情况，下方的网关值都依然有效。普通 Cursor 本身仍然经由 Cursor 的服务器路由自定义端点，因此无法访问 loopback proxy。
- **Gateway 配置值。** 显示 proxy 自身监听端口上的 Base URL（取自运行时记录，因此即使仪表盘经过反向代理，仍会显示本机 Cursor 可访问的端口），并提供 Copy 按钮。API Key 行取决于绑定方式：不需要凭据时显示可复制的 `opencodex-loopback`；启用了 API 认证，或配置了任何 opencodex API key 时，会提示使用自己的某个 key，并链接到 API Keys 标签页。任何已配置的 key 都可用，并不限于 `OPENCODEX_API_AUTH_TOKEN`。
- **连接情况。** 显示 User-Agent 恰好为 `Cursor/<version>` 的最近一次 `/v1/models` 请求（Cursor 本地代理运行时发送的 header），包括时间和版本。在 Cursor 调用 proxy 前显示“never seen”；在 Cursor 中点击 **Refresh model list** 即会更新。标签页打开期间，卡片每 15 秒刷新一次。
- **Cursor 将显示的内容。** 按下一节规则，预测 opencodex 所公布模型的 Model / Reasoning / Context 表（禁用模型和 provider 允许列表同原始列表一样生效）。这只是预测：Reasoning 档位由 Cursor 自身的表决定。

## 模型与推理强度

选择器使用 opencodex 原始的 `/v1/models` 列表。模型行是否获得 **Reasoning** 控件取决于两点：

1. opencodex 必须在该行声明能力（`api_types` 加上 `capabilities` 对象）。v2.41 起已支持；旧版 proxy 会显示模型，但没有强度控件。
2. 去掉模型 id 最后一个 `/` 之前的部分及任何 `@…` 后缀后，余下部分必须匹配 Cursor 自身的强度表。该表编译在应用的 `extensions/cursor-agent-exec/dist/main.js` 中；opencodex 从检测到的安装读取它，使仪表盘预测跟随 Cursor 更新。卡片会标明读取的构建版本，若未找到则标为“static mirror”。档位由 Cursor 决定，任何 `/v1/models` 字段都无法将模型加入该表。下表是静态镜像携带的 3.18.25 快照：

| 模型 id（最后一个 `/` 之后） | Cursor 显示的档位 | 传输字段 |
|---|---|---|
| `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna` | Low、Medium、High、Extra High | `reasoning.effort` |
| `gpt-5`、`gpt-5.x` | Low、Medium、High、Extra High | `reasoning.effort` |
| `claude-opus-5`、`claude-sonnet-5`、`claude-opus-4.7`、`claude-opus-4.8` | Low、Medium、High、Extra High、Max | `output_config.effort` |
| `claude-opus-4.6`、`claude-opus-4.5`、`claude-sonnet-4.6` | Low、Medium、High、Max | `output_config.effort` |
| `grok-4.3`、`grok-4.5`、`grok-4.6`、`grok-build-latest` | Minimal、Low、Medium、High、Extra High | `reasoning_effort` |
| `gemini-*`（需要 `supports_reasoning`） | Minimal、Low、Medium、High | `reasoning_effort` |
| 其他模型，包括 `claude-fable-5-1`、`kimi-k3` | 无控件 | — |

因此 `anthropic/claude-opus-5` 可用，但无法通过该选择器选到 opencodex 为 GPT-5.6 提供的 `max`／`ultra` 档位。

### 没有控件的模型

`anthropic/claude-fable-5-1`、`cursor/kimi-k3` 等不在表中的模型不会获得 Reasoning 控件。当 gateway 为此类 id 声明 `supports_reasoning` 时，Cursor 会逐个记录日志：“Local provider advertises reasoning support for a model with no hardcoded Bottlerocket effort family”。仍可通过两种方式选择强度：

- **强度专用行**（opencodex 配置中的 `cursorEffortRows: true`，默认关闭）：gateway 会为表外模型的每种强度发布一个选择器条目，例如 `anthropic/claude-fable-5-1--high` 或 `cursor/kimi-k3--max`，并将各条目路由到应用了相应强度的基础模型。Cursor 已能渲染的模型不会增加额外条目，且精确匹配的已知模型 id 始终优先于 `--<effort>` 后缀。启用后点击 Refresh model list。仪表盘卡片会统计每个模型已发布的条目。选择某一行是明确选择，因此其强度也会优先于请求中的 `ocx-effort` 指令。
- **固定默认值**（provider 上的 `modelDefaultReasoningEfforts`）：在 Cursor 未发送强度时生效。

### “Max”的两种含义

普通 Cursor 会在某些模型旁显示 **Max** 开关。这是扩大上下文窗口的 Max Mode，不是推理档位。在本地代理版本中，相同概念显示为模型菜单中的 **Context** 条目；opencodex 会为原生 GPT-5.6 系列启用它：**272K**（默认）或 **922K**（1M 自选，标明费用更高）。所选值限制该回合的上下文。路由模型只显示一个窗口，没有 Context 条目；provider 的上下文上限低于 922K 时，原生模型行也不会显示该条目。

推理强度的 **Max**（opencodex 的 `max`／`ultra`）是另一种含义，无法从此处选择：Cursor 使用自身表中的强度档位，而非 gateway 提供的档位；GPT-5.6 条目最高只有 Extra High。

由于 opencodex 在 `api_types` 中声明 `responses`，该版本会将代理回合发送到 `/v1/responses`，携带 `reasoning.effort`，而非发送到 `/v1/chat/completions`。

这种传输选择会影响 Claude 行：Cursor 只在 Anthropic Messages 传输中通过 `output_config.effort` 发送 Claude 强度。因此，当 Base URL 以 `/v1` 结尾时，即使 Claude 行显示控件，运行时仍使用 provider 默认强度。Base URL 以 `/messages` 结尾则相反：会发送 Claude 强度，但丢弃 OpenAI 系列模型的强度。单个 gateway 条目无法同时服务两种模型系列；上述强度专用行可绕过此限制，因为强度由 opencodex 自行应用。

## 验证

`ocx observe logs` 会将这些回合显示为 `inboundProtocol: responses`，并标记 `admissionKind: loopback`。

| 症状 | 检查项 |
|---|---|
| gateway 返回 401 | API Key 与 `OPENCODEX_API_AUTH_TOKEN` 不匹配；对没有 API 认证的 loopback 绑定，任何值都可用 |
| 选择器为空 | opencodex 未运行，或 Base URL 缺少 `/v1`；修正后点击 Refresh model list |
| 已列出模型但没有 Reasoning 控件 | opencodex 早于 v2.41，或 id 不在 Cursor 表中（仪表盘标记为 —）；启用 `cursorEffortRows` 或设置 provider 默认值 |
| 结构变化未生效 | Cursor 按 Base URL 字符串缓存 `/models`，且不过期；Refresh model list 会重新读取。否则重启应用，或暂时保存另一种 URL 写法（`localhost` 与 `127.0.0.1`） |
| 首回合有 23k token | 属于预期行为；这是 Cursor 的本地系统提示词 |
