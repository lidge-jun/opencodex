---
title: CLI 生命周期
description: 安装、启动、停止、服务、诊断、同步和更新命令。
---

这些命令用于安装、运行、检查、修复并更新本地 opencodex 代理及其 Codex 集成。

## 初始化

### `ocx init` · `ocx setup`

交互式初始化向导（`setup` 是 `init` 的别名）。会提示选择提供方（预设或自定义）、API key（字面量或 `${ENV}`）、默认模型和代理端口；将内容保存到 `~/.opencodex/config.json`；可选地把代理注入 `$CODEX_HOME/config.toml`（默认 `~/.codex/config.toml`）；并可选安装 Codex 自启动 shim。

## 代理生命周期

### `ocx start [--port <port>]`

启动代理服务器（首选端口 `10100`）。如果该端口已被占用，opencodex 会选择并记录另一个可用端口。它会写入 PID/运行时端口状态，并拒绝启动第二个存活实例。启动时，它会把每个提供方的模型同步到 Codex 的目录中。关闭时，它会恢复原生 Codex，除非它是作为受管服务启动的（`OCX_SERVICE=1`）。

```bash
ocx start
ocx start --port 8080
```

### `ocx stop`

停止正在运行的代理（按 PID），移除 PID 文件，并恢复原生 Codex。如果安装了受管后台服务，`ocx stop` 还会先停止该服务，这样它就无法重新拉起代理。Web 仪表盘的 **Stop** 按钮在多数后端执行同样的操作（`POST /api/stop`），但 Windows 任务计划程序除外：任务结束后包装器仍可能重新拉起代理，只有运行在代理之外的 stop 才能在恢复客户端配置前确认这个重启窗口，因此仪表盘会以 `respawnable_service` 拒绝、不做任何更改，并提示改用 `ocx stop`。

### `ocx restart`

代理正在运行时，请求经过验证的准确 PID 和端口执行原位重启，等待正常排空，并确认同一端口上出现不同的运行时 PID。整个过程保留托管路由和服务监督；若请求结果不确定，也不会将其重放为单独的 stop/start。只有没有代理运行时，命令才回退到常规的 `ensure` 启动。

如果无法将正在运行的监听器验证为对应的运行时 PID（包括升级前的代理），重启会安全失败，不会回退到 `ensure` 或 stop/start。确认所有权后，请依次运行一次 `ocx stop` 和 `ocx start`。

### `ocx ensure`

以幂等方式确保后台代理正在运行，然后同步其当前模型目录。如果 `codexAutoStart` 为 `false`，它会打印自启动已禁用，并且不执行任何操作。

### `ocx restore [back]` · `ocx eject [back]`

在**不停止代理**的情况下恢复原生 Codex——移除注入的配置行和路由后的目录条目，让普通 `codex` 重新以原生方式工作。`eject` 是 `restore` 的别名。

在任一命令后附加 `back`，即可在不改变代理生命周期的前提下，把普通 `codex` 重新指向一个已经在运行的代理：

```bash
ocx restore back
ocx eject back
```

### `ocx recover-history --legacy-openai --yes`

为更早期的开发构建提供显式恢复，这些构建在可逆备份支持存在之前就重映射了 Codex App 历史记录。如果其历史数据库已被锁定，请先关闭 Codex。

这是范围很广且具有破坏性的重标记：所有包含用户消息且当前标记为 `opencodex` 的线程都会改标为 `openai`，`exec` 会规范化为 `cli`，并设置事件标记。正常的专用提供方历史记录也在范围内。请先备份状态，并且仅在确实需要这一完整范围时执行。

### `ocx uninstall` · `ocx remove`

停止服务和代理，移除服务和 Codex shim，恢复原生 Codex，然后仅在所有恢复步骤都成功时才删除 opencodex 本地配置。`remove` 是 `uninstall` 的别名。配置清理需要由全新安装创建的所有权元数据；旧版或共享目录会保留原样。

## 状态与健康

### `ocx status [--json]`

输出只读诊断摘要：代理 PID、`/healthz` 可达性、仪表盘 URL、配置路径、默认提供方、Codex 自启动设置、服务状态、shim 状态，以及已脱敏的实际 Codex home。只有明确且高置信度的 Windows Orca 运行时 home 签名才会添加可执行的 App-home 不匹配警告；它绝不会自动更改 `CODEX_HOME`。

人类可读输出还会在 OAuth 登录摘要之后附加一个 **OAuth 健康** 区块：当所有已知账户都健康时显示 `OAuth health: ok`；否则显示 `OAuth health: warning`，并为每个不健康账户提供一行脱敏信息（提供方、打码后的账户 ID、状态，如需要重新认证、速率或配额受限、刷新冲突等），外加可选的 `Action:` 提示。账户 ID 会被脱敏；tokens 和邮箱绝不会打印。`--json` 协议目前不包含这个健康区块。

```bash
ocx status
ocx status --json
```

简化示例结构：

```json
{
  "schemaVersion": 1,
  "proxy": {
    "running": false,
    "pid": null,
    "health": {
      "ok": false,
      "url": "http://127.0.0.1:10100/healthz",
      "message": "unreachable"
    }
  },
  "dashboard": {
    "url": "http://localhost:10100/"
  },
  "paths": {
    "config": "/Users/example/.opencodex/config.json",
    "pid": "/Users/example/.opencodex/ocx.pid",
    "runtime": "/path/to/bun"
  },
  "runtime": {
    "source": "bundled"
  },
  "codexHome": {
    "effectiveCodexHome": "C:\\Users\\[USER]\\.codex",
    "appCodexHome": "C:\\Users\\[USER]\\.codex",
    "mismatch": false,
    "warning": null,
    "action": null
  },
  "codexAutostart": true,
  "defaultProvider": "openai",
  "service": {
    "summary": "not installed (logs: /Users/example/.opencodex/service.log)"
  },
  "codexShim": {
    "summary": "Codex autostart shim: not installed"
  }
}
```

真实对象还会包含 `listen`（端口、主机名、运行时/配置来源）、配置加载诊断，以及 bundled Codex 插件诊断。JSON schema 仅允许追加字段：未来版本可能新增字段，但现有字段应保持稳定。它刻意不包含 API keys、OAuth tokens、授权头、请求内容、邮箱和账户身份。

### `ocx health [--json]`

对正在运行的代理做身份校验。人类可读输出报告 PID/端口；`--json` 输出 `{ok, pid, port}`。只有在健康时该命令才以 0 退出，否则以 1 退出，因此适合用作服务探针。

### `ocx ready [--json] [--wait [--timeout <seconds>]]`

通过无需认证的 `GET /readyz` 端点检查同步后的就绪状态。就绪时返回 `200`；状态为 `pending` 或
终态 `failed` 时返回 `503`，并带有 `Retry-After: 1`。HTTP 仅返回经脱敏的身份字段
`{service, version, uptime, pid, port, status}`。不支持 `/readyz` 的旧代理会按 `unreachable` 失败关闭；
`/healthz` 是独立的存活检查，不是就绪检查。默认只探测一次；`--wait` 会轮询到就绪或超时，但遇到终态
`failed` 会立即退出。默认超时为 45 秒；`--timeout <seconds>` 必须与 `--wait` 一起使用，取值范围为 1–300 秒的正整数。CLI JSON
输出 `{ready, status, pid, port}`，其中 `status` 为 `ready`、`pending`、`failed` 或
`unreachable`。退出码：就绪为 0；未就绪、pending、failed、超时或无法连接为 1；参数无效为 64。

### `ocx doctor`

运行只读的环境与连通性诊断：状态路径和文件系统类型、WSL 双重安装、代理环境/配置、ChatGPT 可达性、Codex 插件和项目配置警告，以及待处理的历史迁移。Codex app-home 定位部分也会检测狭义的 Windows Orca 运行时 home 不匹配，并在适用时解释服务迁移。此诊断展示的路径会对操作系统用户名进行脱敏。Doctor 会输出修复提示，但不会自动应用。

**OAuth 可靠性** 部分会报告凭据存储是否可写、是否能够在 `OPENCODEX_HOME` 下创建刷新 single-flight/锁文件、不健康的 OAuth 或 Codex 池账户（脱敏 ID）及其恢复 `Action:`，并给出一条静态 OK，说明 Codex 转发路径不会伪造官方客户端元数据。Doctor 绝不会修改凭据或执行修复。

## 目录同步

### `ocx sync [--restart-codex]`

从每个已配置的提供方获取实时模型列表，并将合并后的目录重新注入 Codex。在添加提供方后运行，或用于刷新可用模型。

如果仍有长期运行的 Codex `app-server` 进程，`ocx sync` 会警告它们可能继续提供旧的内存模型列表，即使 `opencodex-catalog.json` / `models_cache.json` 已更新。传入 `--restart-codex` 会仅向当前用户拥有、匹配 `codex … app-server` 和 `codex-code-mode-host` 的进程发送 `SIGTERM`（当前活跃会话可能会被打断）。故意避免使用宽泛的 `pkill -f codex` 匹配。

### `ocx sync-cache [--restart-codex]`

使 Codex 的本地模型选择器缓存失效，让它根据当前激活的 opencodex 目录重新生成。与 `ocx sync` 相同的陈旧 `app-server` 警告和可选 `--restart-codex` 行为同样适用。

## 后台服务

### `ocx service [install|repair|restart|start|stop|status|uninstall|remove]`

将 opencodex 作为登录管理的后台服务运行（macOS **launchd**、Linux **systemd user unit**、Windows **Task Scheduler**），在登录时自动启动，在崩溃时自动重启。服务运行会设置 `OCX_SERVICE=1`，因此重启时不会反复改动 Codex 配置。

| 子命令 | 操作 |
| --- | --- |
| none | 服务不存在时安装并启动；已存在时刷新并重启。正常的 Windows 任务计划程序定义会复用；过时定义可能会重新注册并需要提升权限。 |
| `install` | 创建并启动服务。 |
| `repair` | 就地刷新已安装的服务并重启。正常的 Windows 任务计划程序定义会复用；过时定义可能会重新注册并需要提升权限。 |
| `restart` | `repair` 的别名。 |
| `start` | 启动已安装的服务。 |
| `stop` | 停止服务并恢复原生 Codex。 |
| `status` | 报告服务和代理诊断信息及日志路径。 |
| `uninstall` | 移除服务并恢复原生 Codex。 |
| `remove` | `uninstall` 的别名。 |

```bash
ocx service
ocx service install
ocx service repair
ocx service restart
ocx service status
ocx service uninstall
```

在 Windows 上，bare `ocx service` 只有在 Task Scheduler 和 WinSW 两者的缺失都得到证实后才会走安装路径。如果任一状态查询结果不确定，它会拒绝任何注册并提示运行 `ocx service status`；只有在确认缺失之后才使用显式的 `ocx service install`。

在 Windows 上，`ocx service status` 会单独报告 Task Scheduler 注册状态和已身份验证的 OpenCodex 代理可达性。它不会打印本地化的 `schtasks` 表格，因此在不同 Windows 代码页下摘要仍然可读。

在 Windows 上，创建 Task Scheduler 条目需要提升权限。识别到本地化的访问被拒绝文本时，会沿用现有的指导路径。如果该文本不可读，则回退要求命令形态为 `/create /tn opencodex-proxy /xml <non-empty-path> /f`，状态为 1，并且令牌明确为非提升权限；这时仪表盘的 Startup Safety 操作可以自动请求 UAC。如果该回退无法判断令牌状态，它会保留原始调度器错误。外部任务和操作绝不会发出自动提升标记。请批准仪表盘的 UAC 提示，或在提升权限的 PowerShell 窗口中重新运行 `ocx service install`。

### `ocx codex-shim <install|status|uninstall|remove>`

在 PATH 上把基于脚本的 `codex` 启动器包装为一个轻量自启动脚本。真实的 `codex.exe` 目标会保持不变，以避免破坏精确的可执行文件调用。

提交安装或修复前，OpenCodex 会在跳过服务启动的情况下，用 `--version` 运行已保存的启动器。如果启动器把 `codex` 再次解析到 shim、以非零状态退出、运行超过五秒、留下仍在运行的子进程，或无法被安全验证和清理，OpenCodex 会拒绝并回滚更改。因此 `codex-shim install` 并不是无条件安装。若被拒绝，请重新安装 Codex，使 PATH 条目指向具体的可执行文件或启动器，然后重试；如果动态命令管理器的启动器无法满足这些检查，请改用 `ocx service install`。

升级时，缺少当前验证保护的已安装 Unix shim 会被重新生成并接受探测。如果保存的启动器不安全，OpenCodex 会移除旧 shim 并恢复原始启动器，而不是保留不安全的 wrapper。

仅安装启动器并不能证明 Codex 请求会经过 OpenCodex。完成健康安装后，命令会检查当前 Codex 路由；当路由由外部配置、用户自有网关管理或无法验证时，会显示警告而不是绿色成功。若出站代理变量只存在于当前进程，而 `config.proxy` 未设置或无法解析，也会给出警告，因为 Codex 启动器和后台服务未必继承该环境。这些检查只读且绝不会打印代理值；在依赖自动启动前，请先处理提示的交接配置并运行 `ocx doctor`。

如果已完成的外部 Codex 更新覆盖了已安装的 shim，下一次普通的 `ocx` 命令会先备份稳定的新启动器，再在分发前恢复 shim。零副作用的检查命令 `ocx system codex-cli-update check` 和保留的 `ocx system codex-cli-update` 命名空间中的无效调用都不会执行这项修复。仍在变动中的启动器会保持不动，并在稍后重试。修复失败只会警告，不会让所请求的命令失败；手动回退：`ocx codex-shim install`。将 `codexShimAutoRestore` 设为 `false`，或设置 `OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0`，即可在进程级别关闭自动恢复。

| 子命令 | 操作 |
| --- | --- |
| `install` | 安装 shim（或在过期时修复）。 |
| `uninstall` | 移除 shim 并恢复原始 Codex 二进制。 |
| `remove` | `uninstall` 的别名。 |
| `status` | 报告 shim 状态（已安装、过期或缺失）。 |

```bash
ocx codex-shim install
ocx codex-shim status
ocx codex-shim uninstall
```

:::tip[Service vs Shim]
将 `ocx service` 用于始终在线的后台代理（推荐）。将 `ocx codex-shim` 用于无需守护进程的轻量按需启动——代理只会在启动 `codex` 时运行。
:::

### `ocx tray <install|start|stop|status|uninstall|remove> [--json] [--no-start]`

安装并控制 Windows 状态托盘图标。它会在 Windows 登录时启动，并提供一键代理控制。`start` 和 `stop` 只控制图标本身；要控制代理，请使用其菜单。`--no-start` 适用于 `install`，会安装托盘但不会立即启动。

## 仪表盘

### `ocx gui`

在 `http://localhost:<port>` 打开 [web dashboard](/guides/web-dashboard/)，如果代理未运行则会自动启动。

## 更新

`ocx update` 更新的是 OpenCodex 本身，而不是 Codex CLI。请使用 [system 检查命令](/zh-cn/reference/cli/agents/)中的 `ocx system codex-cli-update check`，对已配置的 Codex CLI 候选项进行有界、只读的 provenance 检查。该命令不会查询 package registry，也不会安装更新。

### `ocx update [--tag latest|preview]`

从 npm 自更新 opencodex。稳定版安装使用 `@latest`；预览版安装保持在 `@preview`，除非你传入 `--tag latest|preview`。它会检测源码检出，并提示你改为运行 `git pull && bun install`；如果你已经是该标签的最新版本，则不会执行任何操作。对于 npm 安装，它会在停止任何进程之前，对 Unix 缓存的所有权和访问权限执行有界检查。嵌套符号链接会通过 `lstat` 检查但不会跟随；Windows 会明确跳过这项仅适用于 Unix 的检查。检查失败时，更新会在托盘和代理仍运行的情况下中止。随后才会在替换文件之前停止正在运行的代理；已安装的服务会自动重建并启动，而前台安装则会打印 `ocx start` 作为下一步。持久化前，仪表板更新记录会隐去用户配置文件/缓存路径以及 UID/GID 值。

```bash
ocx update
ocx update --tag preview
```

当 [Release workflow](https://github.com/lidge-jun/opencodex/actions/workflows/release.yml) 将新版本发布到 npm 时，这些新版本就会变得可用。
