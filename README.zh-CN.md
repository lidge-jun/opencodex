<h3 align="center">make codex open!</h3>
<p align="center"><code>npm install -g @bitkyc08/opencodex</code> · <code>ocx start</code> · <b>localhost:10100</b></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@bitkyc08/opencodex"><img src="https://img.shields.io/npm/v/@bitkyc08/opencodex?color=cb3837&label=npm&logo=npm" alt="npm version"></a>
  <a href="https://github.com/lidge-jun/opencodex/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@bitkyc08/opencodex?color=blue" alt="license"></a>
  <img src="https://img.shields.io/node/v/@bitkyc08/opencodex?logo=node.js&label=node" alt="node version">
</p>

<p align="center">
  <img src="assets/banner.png" alt="opencodex — 让 Codex 接入任意 LLM" width="820">
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.ko.md">한국어</a> · <b>简体中文</b> · 📖 <a href="https://lidge-jun.github.io/opencodex/zh-cn/"><b>完整文档 →</b></a>
</p>

<p align="center">
  <img src="assets/architecture.png" alt="opencodex 架构 — Codex CLI 通过 opencodex 代理路由到任意 LLM 提供商" width="820">
</p>

在 Codex 中使用 Claude、Gemini、Grok、GLM、DeepSeek、Kimi、Qwen、Ollama 或任意其他 LLM —— 无需等待 OpenAI 添加支持。

opencodex 是一个轻量级本地代理，把 Codex 的 Responses API 翻译成你的 provider 所讲的协议。streaming、tool 调用、reasoning token、图片 —— 全部双向工作。

<p align="center">
  <img src="assets/demo.gif" alt="opencodex 演示 —— 在 Codex 应用中用路由的非 OpenAI 模型执行任务" width="820">
</p>
<p align="center"><sub><b>在 Codex 里运行任意模型。</b>选好 provider 即可 —— 同样的 Codex 工作流，不同的大脑。</sub></p>

它还能为 Codex 认证管理一个 **ChatGPT 账户池**。添加多个 ChatGPT / Codex 账户，在仪表盘中刷新它们的
5 小时 / 每周 / 30 天配额，并让新会话自动路由到使用量最低的健康账户。现有 Codex 线程会固定在启动它的
账户上，因此长时间的 SSH、tmux 或移动端连接的会话不会在对话中途切换账户。

```
Codex CLI / App / SDK ──/v1/responses──▶ opencodex ──▶ Any provider
                                              │
              Anthropic · Google · xAI · Kimi · Ollama Cloud · Groq
              OpenRouter · Azure · DeepSeek · GLM · …and OpenAI itself
```

```mermaid
flowchart LR
  codex[Codex 会话<br/>CLI, App, SSH, 移动端] --> proxy[opencodex]
  proxy --> existing{已有线程?}
  existing -->|是| pinned[保持同一<br/>ChatGPT 账户]
  existing -->|新会话| quota[刷新配额<br/>5h, 每周, 30d]
  quota --> pick[选择使用量最低<br/>的健康账户]
  pick --> upstream[ChatGPT / Codex 后端]
  pinned --> upstream
  upstream --> outcomes[配额 / 认证结果]
  outcomes -->|429| cooldown[冷却 + failover]
  outcomes -->|401 / 403| reauth[标记需重新认证]
  cooldown --> quota
```

## 支持平台

| 操作系统 | 状态 | 服务管理 |
|---|---|---|
| macOS (arm64 / x64) | 完整支持 | launchd |
| Linux (x64 / arm64) | 完整支持 | systemd（用户级） |
| Windows (x64) | 完整支持 | Task Scheduler |

需要 [Node](https://nodejs.org) 18+。Bun 运行时会在 `npm install` 时自动打包，无需单独安装。三个平台都原生运行（Windows 不需要 WSL）。

## 快速开始

```bash
# 安装（自动打包 Bun 运行时 —— 只需 Node 18+）
npm install -g @bitkyc08/opencodex

# 交互式初始化（写入配置 + 注入 Codex）
ocx init

# 启动代理
ocx start

# 正常使用 Codex —— 请求已经通过 opencodex 路由
codex "Write a hello world in Rust"
```

<details>
<summary><b>遇到 "bundled Bun runtime is missing" 错误？</b></summary>

<br/>

opencodex 把 Bun 运行时作为依赖打包，并通过 Node 启动器运行，所以你**不需要**自己安装 Bun。如果看到 "bundled Bun runtime is missing" 错误，说明安装时跳过了 lifecycle 脚本或 optional 依赖。请不带这些标志重新安装：

```bash
npm install -g @bitkyc08/opencodex   # 不要加 --ignore-scripts、--omit=optional
```

</details>

## 亮点

- **在 Codex 中使用任意 LLM。** 5 种协议 adapter 覆盖 Anthropic Messages、Google Gemini、Azure、OpenAI Responses 直通，以及所有 OpenAI 兼容 Chat Completions 端点 —— 即开箱即用的 **40+ provider**。
- **安全地池化 ChatGPT 账户。** 现有 Codex 线程保持在一个账户上，而新会话可以从池中自动挑选使用量更低的账户，并带有配额刷新和非 PII 请求标签。
- **登录一次，免填 API key。** xAI、Anthropic、Kimi 支持 OAuth，可用现有账户认证，token 自动刷新。也可以转发 `codex login`、粘贴 API key，或使用 `${ENV_VAR}` 引用 —— 随你选择。
- **Codex 在哪里能用，它就在哪里能用。** 自动注入 Codex CLI、TUI、App 和 SDK。路由模型像原生模型一样出现在 Codex 的模型选择器里。
- **委派给合适的模型。** 在仪表盘或 config 中把最多 5 个路由/原生模型放进 Codex 的 subagent 选择器 —— 复杂任务交给 reasoning 模型，快速任务交给便宜模型。
- **给任意模型超能力。** 非 OpenAI 模型也能通过你的 ChatGPT 登录上运行的 `gpt-5.4-mini` sidecar 获得真正的网页搜索和图片理解。
- **看清正在发生什么。** Web 仪表盘展示 provider、OAuth 状态、模型选择和实时请求日志 —— 不必再猜测请求为何失败。
- **后台运行。** 安装为系统服务（launchd / systemd / Task Scheduler）后开机自启，无需操心。
- **干净退出，零残留。** `ocx stop`（或仪表盘的 Stop 按钮）会关闭代理、停止已安装的后台服务，并将 Codex 恢复为原始配置。之后 `codex` 就像从未安装过 opencodex 一样工作 —— 无残留配置，无僵尸进程。

## 添加 Provider

最简单的方式：用 Web 仪表盘。

```bash
ocx gui
```

这会打开 `http://localhost:10100` 仪表盘。在这里：

1. 点击 **"Add Provider"**。
2. 从 **40+ 内置 provider** 中选择，或输入自定义的 OpenAI 兼容端点。
3. 粘贴 API key（Anthropic、xAI、Kimi 也可用 OAuth 登录）。
4. 模型会从 provider 的 `/v1/models` 端点**自动发现**。

新 provider 立即可用，无需重启。

你也可以通过 `ocx init`（交互式 CLI）或直接编辑 `~/.opencodex/config.json` 来添加 provider。

## 模型路由

通过 `provider/model` 格式指定路由模型，在 Codex 中直接使用：

```bash
# 通过 Anthropic 使用 Claude Opus
codex -m "anthropic/claude-opus-4-8" "解释这个 stack trace"

# 通过 Google 使用 Gemini
codex -m "google/gemini-3-pro" "为 auth.ts 写单元测试"

# 通过 Ollama Cloud 使用 GLM
codex -m "ollama-cloud/glm-5.2" "写一个 SQL migration"

# 通过 Ollama 使用本地模型
codex -m "ollama/llama3" "重构这个函数"
```

省略 `provider/` 前缀时，opencodex 会路由到默认 provider，或根据模型名模式自动匹配（例如 `claude-*`
路由到 Anthropic，`gpt-*` 路由到 OpenAI）。

路由模型也会出现在 **Codex App** 模型选择器中，并带有按模型的 reasoning effort 控制：

<p align="center">
  <img src="assets/codex-app-picker.png" alt="Codex App 展示 opencodex 路由模型及 reasoning effort 选择器" width="480">
</p>

## ChatGPT 账户池

打开仪表盘中的 **Codex Auth** 来添加池账户，并选择由哪个账户处理下一个 Codex 会话。
opencodex 保持两种独立行为：

- **现有会话保持 affinity。** 线程 id 绑定到所选账户并在后续轮次复用，因此长请求或移动/SSH 连接的会话
  会继续使用同一账户。
- **新会话可自动路由。** 启用自动切换后，opencodex 比较 5 小时、每周、30 天使用量中最热的配额窗口，
  当活跃账户越过阈值时，为新会话挑选使用量更低的合格账户。
- **内置配额查询。** 仪表盘可一键刷新所有账户配额，请求日志用非 PII 的账户序号标记池流量。
- **失败即 fail-closed。** token 失败会标记需重新认证，而不是悄悄回退到另一个凭证；429 配额响应会让账户
  进入冷却，并可将后续工作 failover 到另一个合格的池账户。

## Provider 与 adapter

| Provider | Adapter | 认证方式 |
|---|---|---|
| OpenAI（ChatGPT 登录） | `openai-responses` | 转发（无需 key） |
| OpenAI（API key） | `openai-responses` | key |
| Umans AI Coding Plan | `anthropic` | key |
| Anthropic Claude | `anthropic` | oauth / key |
| xAI Grok | `openai-chat` | oauth / key |
| Kimi（Moonshot） | `openai-chat` | oauth / key |
| Google Gemini | `google` | key |
| Azure OpenAI | `azure-openai` | key |
| Ollama Cloud + 17 家 provider 目录 | `openai-chat` | key |
| Ollama / vLLM / LM Studio（本地） | `openai-chat` | key（通常留空） |
| 任意 OpenAI 兼容端点 | `openai-chat` | key |

此外还有 DeepSeek、Groq、OpenRouter、Together、Fireworks、Cerebras、Mistral、Hugging Face、NVIDIA NIM、MiniMax、Qwen Portal 等等。完整列表可通过 `ocx init` 查看，或参阅 [provider 文档](https://lidge-jun.github.io/opencodex/zh-cn/reference/configuration/)。

## CLI

```bash
ocx init                       # 交互式初始化
ocx start [--port 10100]       # 启动代理
ocx stop                       # 停止并恢复原生 Codex 配置
ocx restore                    # 仅恢复，不停止（别名：ocx eject）
ocx uninstall                  # 移除 service/shim/config 并恢复原生 Codex
ocx ensure                     # 按需启动 + 刷新 Codex config/cache
ocx sync                       # 刷新模型列表 + 重新注入 Codex
ocx status                     # 查看代理是否在运行
ocx login <xai|anthropic|kimi> # OAuth 登录
ocx logout <provider>          # 移除已保存的登录
ocx gui                        # 打开 Web 仪表盘
ocx codex-shim install         # 运行 codex 时自动启动代理
ocx service <install|start|stop|status|uninstall>   # 后台服务（launchd/systemd/schtasks）
ocx update [--tag preview]     # 更新 opencodex；preview 安装保持 @preview
```

### 自动启动：service vs shim

opencodex 提供两种自动启动代理的方式：

| | `ocx service install` | `ocx codex-shim install` |
|---|---|---|
| **方式** | OS 服务管理器（launchd / systemd / schtasks） | 包装 `codex` 脚本启动器；不会改动真实 `codex.exe` |
| **时机** | 登录后始终运行 | 按需 — 仅在运行 `codex` 时启动 |
| **重启** | 崩溃后自动重启 | 每次调用 `codex` 时启动一次 |
| **Codex 更新** | 不受影响 | 下次运行 `ocx codex-shim install` 或 `ocx update` 时修复 |
| **移除** | `ocx service uninstall` | `ocx codex-shim uninstall` |

如需常驻代理，使用 **service**（推荐开发环境）。轻量按需启动使用 **shim**。
如果配置的代理端口已被占用，`ocx start` 会自动选择另一个空闲本地端口并更新 Codex 使用它。

### 卸载

删除 npm 包之前，先清理本地状态：

```bash
ocx uninstall
npm uninstall -g @bitkyc08/opencodex
```

`ocx uninstall` 会停止代理、移除已安装的 service、移除 Codex shim、恢复原生 Codex config/catalog/history，并删除 `~/.opencodex`。

## 配置

配置文件路径：`~/.opencodex/config.json`。

**云端 provider 示例：**

```json
{
  "port": 10100,
  "defaultProvider": "anthropic",
  "providers": {
    "anthropic": {
      "adapter": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "authMode": "oauth",
      "defaultModel": "claude-sonnet-4-6"
    },
    "ollama-cloud": {
      "adapter": "openai-chat",
      "baseUrl": "https://ollama.com/v1",
      "apiKey": "${OLLAMA_API_KEY}",
      "defaultModel": "glm-5.2"
    }
  }
}
```

provider 条目还可以标注路由目录元数据。`contextWindow` 设置 provider 级别、对 Codex 可见的上下文上限，
`modelContextWindows` 设置按模型的上限，`modelInputModalities` 设置按模型的目录输入提示，例如 `["text"]`
或 `["text", "image"]`。这些值只会对实时 `/models` 元数据设上限，绝不会抬高更小的实时上下文窗口。完整字段
参阅配置参考。

> **通过 Z.AI 使用 GLM-5.2 1M 上下文：** 在 `openai-chat` adapter 下，`glm-5.2` 和 `glm-5.2[1m]` 都可用 ——
> opencodex 会在发送请求前剥离末尾的 `[1m]` 后缀，因为 OpenAI 兼容端点会拒绝带方括号的 id（Z.AI 400 code
> 1211）。`[1m]` 后缀是 Claude-Code / Anthropic 端点的约定；若要原生使用，请把 `anthropic` adapter 指向
> Z.AI 的 coding base（`https://api.z.ai/api/coding/paas/v4`）。1M 上下文窗口通过模型目录
> （`modelContextWindows`）设置，而不是模型名。

**本地 provider 示例（Ollama / vLLM / LM Studio）：**

```json
{
  "port": 10100,
  "defaultProvider": "local",
  "providers": {
    "local": {
      "adapter": "openai-chat",
      "baseUrl": "http://localhost:11434/v1",
      "apiKey": "",
      "defaultModel": "qwen3:32b"
    }
  }
}
```

本地 provider 的 `apiKey` 通常留空。只要你的本地服务暴露了 OpenAI 兼容的 Chat Completions 端点，opencodex 就能直接对接。

WebSocket 传输默认关闭。只有当你希望 Codex 使用 Responses WebSocket 而不是 HTTP/SSE 时，才需要设置 `"websockets": true`。

### 远程访问

默认情况下 opencodex 绑定到 `127.0.0.1`（回环）且无需额外认证。
如果你设置 `"hostname": "0.0.0.0"` 把代理暴露到局域网，opencodex 会要求一个 bearer token 来同时保护管理
API（`/api/*`）和数据平面（`/v1/responses`）：

```bash
export OPENCODEX_API_AUTH_TOKEN="your-secret-token"
ocx start
```

绑定到非回环地址时若缺少该环境变量，代理会拒绝启动。若为局域网访问安装后台服务，请在 `ocx service install`
之前于同一 shell 中导出相同变量，以便服务管理器接收到它。客户端（脚本、远程机器）必须在每个请求中带上 token：

```
x-opencodex-api-key: your-secret-token
```

token 以常量时间比较，以防止时序攻击。

opencodex 会自动 remap Codex resume 历史，使旧的 OpenAI 对话和 opencodex 创建的项目线程在代理活动期间仍在
Codex App 中可见。原始 provider/source 元数据记录在 `~/.opencodex/codex-history-backup.json`。`ocx stop` /
`ocx restore` 会把备份的 OpenAI 行恢复到 OpenAI，并把剩余的 opencodex 用户线程也 eject 到 OpenAI，这样原生
Codex 不会尝试 resume 一个其 provider 已不在 `config.toml` 中的线程。

如果你测试过备份支持出现之前的旧开发版本（`syncResumeHistory` 已经 remap 了历史），可以运行显式恢复命令：

```bash
ocx recover-history --legacy-openai
```

每个字段的详细说明参阅 **[配置参考](https://lidge-jun.github.io/opencodex/zh-cn/reference/configuration/)**。

## 文档

完整文档——安装、provider 配置、路由、sidecar、Codex 集成、Codex App 模型选择器、CLI/配置参考——由 [`docs-site/`](./docs-site) 目录下的 Astro 站点构建，发布在 **[lidge-jun.github.io/opencodex](https://lidge-jun.github.io/opencodex/zh-cn/)**。

维护者 source of truth 位于 [`structure/`](./structure)，历史调查和诊断笔记保留在 [`docs/`](./docs)。

## 开发

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run dev:proxy    # 以开发模式启动代理 API
bun run dev:gui      # 在另一个终端启动仪表盘 dev 服务器
bun x tsc --noEmit   # 类型检查
```

`bun run dev` 作为 `bun run dev:proxy` 的别名保留以兼容旧用法。在源码检出中，代理 API 暴露 `/healthz`、
`/v1/responses`、`/api/*`；只有在 `bun run build:gui` 生成 `gui/dist` 之后，`GET /` 才会提供打包后的仪表盘。
开发前端时请单独运行：

```bash
bun run dev:gui
```

参阅 **[贡献指南](https://lidge-jun.github.io/opencodex/zh-cn/contributing/)**。

## 免责声明

opencodex 是一个独立的社区维护项目，**与 OpenAI、Anthropic 或任何其他提供商无关，也未获得其认可。**

某些提供商——尤其是 Anthropic (Claude)——可能会对通过第三方代理路由 API 流量的账户进行暂停或限制。**使用风险自负 (UAYOR)。** 在连接提供商之前，请查阅其服务条款以确认是否允许基于代理的访问。opencodex 维护者不对上游提供商采取的任何账户操作承担责任。

## 许可证

MIT
