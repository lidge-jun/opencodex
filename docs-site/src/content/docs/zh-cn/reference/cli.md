---
title: CLI 参考
description: 每一个 ocx 命令和参数。
---

opencodex 的命令行工具是 `ocx`。运行 `ocx help`(或 `--help` / `-h`)查看用法。

## 安装与生命周期

### `ocx init`

交互式安装向导。会依次询问 provider(预设或自定义)、API key(字面值或 `${ENV}`)、默认模型以及代理端口;保存 `~/.opencodex/config.json`;并可选择性地将代理注入到 `$CODEX_HOME/config.toml`（默认 `~/.codex/config.toml`）。

### `ocx start [--port <port>]`

启动代理服务器(默认端口 `10100`)。会写入一个 PID 文件,并拒绝启动第二个实例。启动时,它会将每个 provider 的模型同步到 Codex 的目录中。关闭时,它会恢复原生 Codex —— 除非它是作为受管服务启动的(`OCX_SERVICE=1`)。

```bash
ocx start
ocx start --port 8080
```

### `ocx stop`

停止正在运行的代理(通过 PID),删除 PID 文件,并恢复原生 Codex。如果已安装受管后台服务,`ocx stop`
会先停止该服务(使其不会重新生成代理)。同样的操作也可通过 web 仪表盘的 **Stop** 按钮
(`POST /api/stop`)触发。

### `ocx restore` &nbsp;·&nbsp; `ocx eject`

在**不**停止代理的情况下恢复原生 Codex —— 移除注入的配置行和已路由的目录条目,使普通的 `codex` 重新以原生方式工作。`eject` 是 `restore` 的别名。

### `ocx status`

打印只读诊断摘要: 代理 PID、`/healthz` 可达性、仪表盘 URL、配置文件路径、默认
provider、Codex 自动启动设置、服务状态和 shim 状态。

## 模型与 Codex

### `ocx sync`

从每个已配置的 provider 获取实时模型列表,并将合并后的目录重新注入到 Codex 中。在添加 provider 后运行它,或用于刷新可用模型。

## 认证

### `ocx login <provider>`

为某个 provider 运行 OAuth 登录流程,并将凭据存储在 `~/.opencodex/auth.json` 中(自动刷新)。支持:`xai`、`anthropic`、`kimi`。

```bash
ocx login xai
```

### `ocx logout <provider>`

移除某个 provider 已存储的 OAuth 凭据。

## 仪表盘

### `ocx gui`

在 `http://localhost:<port>` 打开 [Web 仪表盘](/opencodex/zh-cn/guides/web-dashboard/),如果代理尚未运行,则自动启动它。

## 后台服务

### `ocx service <subcommand>`

将 opencodex 作为受登录管理的后台服务运行(macOS 上为 **launchd**,Linux 上为 **systemd user unit**,Windows 上为 **Task Scheduler**),它会在登录时自动启动,并在崩溃后自动重启。服务运行时会设置 `OCX_SERVICE=1`,因此重启不会反复改动 Codex 配置。

| Subcommand | Action |
| --- | --- |
| `install` | 创建并启动服务。 |
| `start` | 启动已安装的服务。 |
| `stop` | 停止服务并恢复原生 Codex。 |
| `status` | 报告服务是否正在运行。 |
| `uninstall` | 移除服务并恢复原生 Codex。(别名:`remove`) |

```bash
ocx service install
ocx service status
ocx service uninstall
```

### `ocx codex-shim <subcommand>`

将 PATH 上的 `codex` 二进制替换为轻量级包装脚本，在运行 `codex` 时自动启动 opencodex
代理。原始二进制会被备份，卸载时自动恢复。

如果 Codex 更新覆盖了包装脚本，下次调用 `install` 时会自动修复——新版二进制会被备份，
然后写入新的包装脚本。

| Subcommand | Action |
| --- | --- |
| `install` | 安装 shim（如果过期则自动修复）。 |
| `uninstall` | 移除 shim 并恢复原始 Codex 二进制。 |
| `status` | 报告 shim 状态（已安装 / 过期 / 缺失）。 |

```bash
ocx codex-shim install
ocx codex-shim status
ocx codex-shim uninstall
```

:::tip[Service vs Shim]
如需常驻代理，请使用 `ocx service`（推荐）。如需无守护进程的轻量按需启动，
请使用 `ocx codex-shim`——仅在运行 `codex` 时启动代理。
:::

## 帮助

`ocx help`、`ocx --help`、`ocx -h` —— 打印用法和示例。

:::note
`ocx gui` 可以正常工作,但未包含在简短的 `ocx help` 列表中。
:::
