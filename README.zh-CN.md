<p align="center">
  <img src="assets/banner.png" alt="opencodex — 让 Codex 接入任意 LLM" width="820">
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.ko.md">한국어</a> · <b>简体中文</b> · 📖 <a href="https://lidge-jun.github.io/opencodex/zh-cn/"><b>完整文档 →</b></a>
</p>

<p align="center">
  <img src="assets/architecture.png" alt="opencodex 架构 — Codex CLI 通过 opencodex 代理路由到任意 LLM 提供商" width="820">
</p>

Codex 只认 Responses API（`/v1/responses`）。opencodex 做的事情很简单：架在 Codex 和你的 LLM provider 中间，把协议实时翻译过去——streaming、tool 调用、reasoning、图片，全都覆盖，双向通信。

```
Codex CLI / App / SDK ──/v1/responses──▶ opencodex ──▶ Any provider
                                              │
              Anthropic · Google · xAI · Kimi · Ollama Cloud · Groq
              OpenRouter · Azure · DeepSeek · GLM · …and OpenAI itself
```

## 支持平台

| 操作系统 | 状态 | 服务管理 |
|---|---|---|
| macOS (arm64 / x64) | 完整支持 | launchd |
| Linux (x64 / arm64) | 完整支持 | systemd（用户级） |
| Windows (x64) | 完整支持 | Task Scheduler |

需要 [Bun](https://bun.sh) 1.1+。三个平台都原生运行（Windows 不需要 WSL）。

## 快速开始

```bash
# 安装
npm install -g @bitkyc08/opencodex      # 或者: bun install -g @bitkyc08/opencodex

# 交互式初始化（写入配置 + 注入 Codex）
ocx init

# 启动代理
ocx start

# 正常使用 Codex —— 请求已经通过 opencodex 路由
codex "Write a hello world in Rust"
```

<details>
<summary><b>还没装 <a href="https://bun.sh">bun</a>？</b> —— 先装一下（opencodex 跑在 bun 上）</summary>

<br/>

```bash
# macOS / Linux / WSL
curl -fsSL https://bun.sh/install | bash

# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"
```

装完之后重新跑 `npm install -g @bitkyc08/opencodex`。（`ocx` 是 bun 原生二进制，所以 bun 必须在你的 `PATH` 里。）

</details>

## 亮点

- **一个代理，20+ provider。** Anthropic、Google、xAI、Kimi、Ollama Cloud、Groq、Azure、DeepSeek、OpenRouter……装一次就全通了。
- **5 种 adapter 覆盖一切。** Anthropic Messages、Google Gemini、Azure、OpenAI Responses 直通，以及**所有 OpenAI 兼容 Chat Completions** 端点——不管你用什么 LLM，总有一个 adapter 能接上。
- **三种认证方式，随你挑。** OAuth 登录（xAI / Anthropic / Kimi，token 自动刷新）、转发 `codex login`、或直接粘贴 API key（支持 `${ENV_VARS}`）。内置 18 家 provider 的 API key 目录（含 **Ollama Cloud**）。
- **即插即用 Codex 全家桶。** 自动向 `~/.codex/config.toml` 注入 `[model_providers.opencodex]`，并写入共享模型目录——路由模型直接出现在 Codex 的模型选择器里，CLI、TUI、App、SDK 全部适用。
- **Subagent 控制。** 在 `subagentModels` 或 Web 仪表盘中，把最多 5 个路由/原生模型置顶到 Codex 的 `spawn_agent` 选择器。
- **Sidecar 能力加持。** 非 OpenAI 模型也能拥有真正的**网页搜索**和**图片理解**——通过你的 ChatGPT 登录借用一个 `gpt-5.4-mini` 来实现。
- **Web 仪表盘。** 管理 provider、OAuth 登录、模型选择、请求日志，都在浏览器里完成。
- **HTTP/SSE 为默认，WebSocket 按需开启。** 只有显式设置 `"websockets": true` 时，代理才会广告 `supports_websockets`。
- **干净退出，零残留。** `ocx stop`（或仪表盘的 Stop 按钮）会关闭代理、停止后台服务（如果有的话）、并将 Codex 恢复为原始配置。之后 `codex` 命令就像从未安装过 opencodex 一样正常工作。

## 添加 Provider

最简单的方式：用 Web 仪表盘。

```bash
ocx gui          # 在浏览器中打开 localhost:10100
```

仪表盘提供 20+ 内置 provider 模板（Anthropic、Google、xAI、Kimi、Ollama Cloud、Groq、DeepSeek、OpenRouter 等等）。选一个，填入 API key 或用 OAuth 登录，保存即可。opencodex 会自动发现该 provider 支持的模型，并同步到 Codex 的模型选择器中。

如果你更习惯手动配置，直接编辑 `~/.opencodex/config.json`，在 `providers` 对象中添加一项即可。详见下方[配置](#配置)章节。

## 模型路由

通过 `provider/model` 格式指定路由模型，在 Codex 中直接使用：

```bash
codex -m "anthropic/claude-opus-4-8"   "解释这个 stack trace"
codex -m "google/gemini-2.5-pro"       "重构这段代码"
codex -m "xai/grok-4"                  "写一个 SQL migration"
codex -m "ollama-cloud/glm-5.2"        "生成单元测试"
codex -m "deepseek/deepseek-r1"        "分析这个性能瓶颈"
```

不指定 provider 前缀时，Codex 使用你配置的 `defaultProvider` 和 `defaultModel`。

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
| Azure OpenAI | `azure` | key |
| Ollama Cloud + 17 家 provider 目录 | `openai-chat` | key |
| Ollama / vLLM / LM Studio（本地） | `openai-chat` | key（通常留空） |
| 任意 OpenAI 兼容端点 | `openai-chat` | key |

## CLI

```bash
ocx init                       # 交互式初始化
ocx start [--port 10100] [-b|--background]  # 启动代理；--background 脱离终端
ocx stop                       # 停止并恢复原生 Codex 配置
ocx restore                    # 仅恢复，不停止（别名：ocx eject）
ocx sync                       # 刷新模型列表 + 重新注入 Codex
ocx status                     # 查看代理是否在运行
ocx login <xai|anthropic|kimi> # OAuth 登录
ocx logout <provider>          # 移除已保存的登录
ocx gui                        # 打开 Web 仪表盘
ocx codex-shim install         # 运行 codex 时自动启动代理
ocx service <install|start|stop|status|uninstall>   # 后台服务（launchd/systemd/schtasks）
ocx update                     # 更新到最新版
```

### 自动启动：service vs shim

opencodex 提供两种自动启动代理的方式：

| | `ocx service install` | `ocx codex-shim install` |
|---|---|---|
| **方式** | OS 服务管理器（launchd / systemd / schtasks） | 将 `codex` 二进制替换为包装脚本 |
| **时机** | 登录后始终运行 | 按需 — 仅在运行 `codex` 时启动 |
| **重启** | 崩溃后自动重启 | 每次调用 `codex` 时启动一次 |
| **Codex 更新** | 不受影响 | 下次运行 `ocx codex-shim install` 或 `ocx update` 时修复 |
| **移除** | `ocx service uninstall` | `ocx codex-shim uninstall` |

如需常驻代理，使用 **service**（推荐开发环境）。轻量按需启动使用 **shim**。

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

每个字段的详细说明参阅 **[配置参考](https://lidge-jun.github.io/opencodex/zh-cn/reference/configuration/)**。

## 文档

完整文档——安装、provider 配置、路由、sidecar、Codex 集成、Codex App 模型选择器、CLI/配置参考——由 [`docs-site/`](./docs-site) 目录下的 Astro 站点构建，发布在 **[lidge-jun.github.io/opencodex](https://lidge-jun.github.io/opencodex/zh-cn/)**。

维护者 source of truth 位于 [`structure/`](./structure)，历史调查和诊断笔记保留在 [`docs/`](./docs)。

## 开发

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run dev          # 以开发模式启动代理
bun x tsc --noEmit   # 类型检查
```

参阅 **[贡献指南](https://lidge-jun.github.io/opencodex/zh-cn/contributing/)**。

## 免责声明

opencodex 是一个独立的社区维护项目，**与 OpenAI、Anthropic 或任何其他提供商无关，也未获得其认可。**

某些提供商——尤其是 Anthropic (Claude)——可能会对通过第三方代理路由 API 流量的账户进行暂停或限制。**使用风险自负 (UAYOR)。** 在连接提供商之前，请查阅其服务条款以确认是否允许基于代理的访问。opencodex 维护者不对上游提供商采取的任何账户操作承担责任。

## 许可证

MIT
