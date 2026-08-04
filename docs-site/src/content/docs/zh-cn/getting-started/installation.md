---
title: 安装
description: 安装 opencodex(ocx)代理及其前置条件,并验证它能够运行。
---

安装 opencodex 后会得到 `ocx` 和 `opencodex` 两个等价命令，它们都指向同一个基于 Bun 的
小型本地 HTTP 服务器。模型请求会发往路由所选的 provider；当已路由模型需要时，可选的
vision 和网络搜索 sidecar 也可以使用你的 ChatGPT 登录凭据。

## 前置条件

| 要求 | 原因 |
| --- | --- |
| **[Node](https://nodejs.org) ≥ 18** | `ocx` 运行在 Bun 运行时上，但运行时会在 `npm install` 时自动打包，你**无需**自己安装 Bun。 |
| **[OpenAI Codex](https://openai.com/codex)**(CLI、App 或 SDK) | opencodex 所代理的客户端。opencodex 会写入 `$CODEX_HOME/config.toml`（默认 `~/.codex/config.toml`）。 |
| 一个 provider 账号或 API key | Anthropic、xAI、Kimi、Ollama Cloud、OpenRouter、OpenAI API key、一个 OpenAI 兼容端点,或你的 ChatGPT 登录凭据。 |

## 安装

```bash
npm install -g @bitkyc08/opencodex
```

:::note[npm 拦截了 bun postinstall？]
较新的 npm 可能会拦截 bun 的 postinstall 脚本（`npm warn install-scripts ...
blocked because they are not covered by allowScripts`），导致捆绑的 Bun
运行时未能就绪。请允许 bun 脚本后重新安装。注意 npm 警告给出的缩写命令
缺少包名，会把当前目录重新安装进去，请始终显式写上包名：

```bash
npm install -g --allow-scripts=bun @bitkyc08/opencodex

# 如果最初是用 sudo 安装的，请继续使用 sudo：
sudo npm install -g --allow-scripts=bun @bitkyc08/opencodex
```
:::

确认两个命令都已加入 `PATH`：

```bash
ocx --version
opencodex --version
```

### 发布渠道

稳定的 `latest` 渠道已经包含 ChatGPT、OpenAI API key、OpenRouter 以及实验性 Cursor 路由所需的
GPT-5.6 Sol/Terra/Luna 目录信息，但这些条目本身不会授予上游模型权限。只有在测试尚未正式发布的
opencodex 构建时，才需要使用 preview 渠道：

```bash
npm install -g @bitkyc08/opencodex@preview
ocx update --tag preview
```

## 从源码运行

若要对 opencodex 本身进行开发:

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run dev:proxy   # 以开发模式启动代理 API (src/cli/index.ts start)
bun run dev:gui     # 启动仪表盘 dev 服务器 (另一个终端)
```

`bun run dev` 作为 `bun run dev:proxy` 的别名保留。代理 API 暴露 `/healthz`、`/v1/responses`、
`/api/*`;只有在 `bun run build:gui` 生成 `gui/dist` 之后,`GET /` 才会提供打包后的仪表盘。
开发仪表盘时,请用 `bun run dev:gui` 单独运行前端。

## 会创建哪些内容

opencodex 状态文件位于 `$OPENCODEX_HOME`（默认 `~/.opencodex`），Codex 集成文件位于
`$CODEX_HOME`（默认 `~/.codex`）。

| 路径 | 用途 |
| --- | --- |
| `$OPENCODEX_HOME/config.json` | 你的 provider、默认 provider、端口及选项。 |
| `$OPENCODEX_HOME/ocx.pid` | 正在运行的代理的 PID（单实例保护）。 |
| `$OPENCODEX_HOME/runtime-port.json` | 当前 PID、主机名和端口，包括自动选择的备用端口。 |
| `$OPENCODEX_HOME/auth.json` | 执行 `ocx login` 后保存的 OAuth 凭据。 |
| `$OPENCODEX_HOME/catalog-backup*.json` | opencodex 修改 Codex 模型目录前创建的备份。 |
| `$CODEX_HOME/config.toml` | 仅监听回环地址时，opencodex 会添加由自身标记管理的根级 `openai_base_url`；监听非回环地址时，则使用 `model_provider = "opencodex"` 和 `[model_providers.opencodex]`，以便 Codex 发送 API 认证 header。 |
| `$CODEX_HOME/opencodex.config.toml` | 与 Codex 主配置一同写入的备用/参考 profile。 |
| `$CODEX_HOME/opencodex-catalog.json` | 供 Codex 使用的原生与已路由模型目录。 |

:::note
opencodex 绝不会删除你的 Codex 配置。每次注入都是可逆的 —— `ocx stop`、`ocx restore`
或 `ocx eject` 会精确剥离 opencodex 所添加的那些行,并恢复原生 Codex。
:::

## 下一步

继续阅读 [快速开始](/zh-cn/getting-started/quickstart/) 以配置你的第一个 provider,
或阅读 [工作原理](/zh-cn/getting-started/how-it-works/) 了解其架构。
