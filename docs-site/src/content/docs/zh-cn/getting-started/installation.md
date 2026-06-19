---
title: 安装
description: 安装 opencodex(ocx)代理及其前置条件,并验证它能够运行。
---

opencodex 以单个 CLI `ocx` 的形式发布。它作为一个小型本地 HTTP 服务器运行(基于 Bun 构建),除了你所配置的
provider 之外,绝不会把你的流量发送到任何地方。

## 前置条件

| 要求 | 原因 |
| --- | --- |
| **[Bun](https://bun.sh) ≥ 1.1**(推荐)或 **Node ≥ 20** | `ocx` 运行在 Bun 运行时上;服务运行器会调用 `bun`。 |
| **[OpenAI Codex](https://openai.com/codex)**(CLI、App 或 SDK) | opencodex 所代理的客户端。opencodex 会写入 `~/.codex/config.toml`。 |
| 一个 provider 账号或 API key | Anthropic、xAI、Kimi、Ollama Cloud、OpenRouter、一个 OpenAI 兼容端点,或你的 ChatGPT 登录凭据。 |

## 安装

```bash
# With npm (recommended)
npm install -g @bitkyc08/opencodex

# With Bun
bun install -g @bitkyc08/opencodex
```

验证该二进制文件已在你的 `PATH` 中:

```bash
ocx --help
```

## 从源码运行

若要对 opencodex 本身进行开发:

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run dev      # starts the proxy in dev mode (src/cli.ts start)
```

Web 仪表盘位于 `gui/`,单独运行:

```bash
cd gui && bun install && bun dev
```

## 会创建哪些内容

| 路径 | 用途 |
| --- | --- |
| `~/.opencodex/config.json` | 你的 provider、默认 provider、端口及选项。 |
| `~/.opencodex/ocx.pid` | 正在运行的代理的 PID(单实例保护)。 |
| `~/.opencodex/auth.json` | 已存储的 OAuth 凭据(当你执行 `ocx login` 时)。 |
| `~/.opencodex/catalog-backup.json` | 原始的 Codex 模型目录,在任何编辑前备份。 |
| `~/.codex/config.toml` | 在 `ocx init` 时,opencodex 会在此追加一个 `[model_providers.opencodex]` 表。 |

:::note
opencodex 绝不会删除你的 Codex 配置。每次注入都是可逆的 —— `ocx stop`、`ocx restore`
或 `ocx eject` 会精确剥离 opencodex 所添加的那些行,并恢复原生 Codex。
:::

## 下一步

继续阅读 [快速开始](/opencodex/zh-cn/getting-started/quickstart/) 以配置你的第一个 provider,
或阅读 [工作原理](/opencodex/zh-cn/getting-started/how-it-works/) 了解其架构。
