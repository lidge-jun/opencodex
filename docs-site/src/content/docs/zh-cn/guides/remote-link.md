---
title: 远程链接
description: 通过 SSH 将 OpenCodex 主机与子机连接起来。
---

机器链接通过 SSH 连接 OpenCodex **主机（Home）** 与 **子机（Child）**。主机通过 SSH 隧道为子机提供服务，两台电脑各自继续在 `10100` 端口运行本地 OpenCodex 服务。控制台会通过 SSH 传递子机专用的链接密钥，因此不需要手动输入令牌。

## 要求

- 主机可以使用 OpenSSH 密钥登录子机。
- 对于由子机发起的链接，子机必须能使用 OpenSSH 密钥登录主机（不支持密码登录）。
- 子机已安装 OpenCodex 2.66.0 或更高版本（由子机发起的链接还要求主机也满足）。
- 两台计算机均可运行 macOS、Linux 或 Windows x64。Windows 需要 OpenSSH Server 和 Windows PowerShell，无需 Git Bash 或 curl。
- 从主机添加子机的控制台需在主机上打开，或使用已配对的 Hub 会话。将当前电脑转换为子机需要操作员配对的控制台会话；无凭据签发的本地会话不能提交这项路由更改。

不支持密码 SSH。可从 Home 或 Child 发起链接。Windows 通过同一固定主机密钥的 OpenSSH 连接执行 PowerShell。

## 从 `#remote` 添加子机

1. 打开控制台的 `#remote`，开启 Remote Link。
2. 选择 **Home**，然后点击 **Continue**。SSH 主机列表会打开。
3. 从 SSH 候选主机中选择主机，或输入 SSH 配置别名。
4. 运行连接测试，并将显示的主机指纹与目标电脑的指纹进行比较。比较指纹可以在 SSH 信任主机前发现错误的电脑或已更换的主机密钥。
5. 确认指纹，然后连接子机。

控制台不会要求输入令牌。它会先探测主机，只有明确确认指纹后才能应用链接。

添加子机窗口会说明子机通过 SSH 使用此主机的提供商，并列出上述前提条件。别名来自运行 OpenCodex 的主机上的 `~/.ssh/config`，不一定是显示浏览器的电脑。如果发现成功但没有主机，请添加如下 `Host` 条目后重新扫描。也可以手动输入已有别名；选择或输入别名后即可启用连接测试。窗口还提供本指南的链接。

```sshconfig
Host devbox
  HostName devbox.example.com
  User you
  IdentityFile ~/.ssh/id_ed25519
```

如果发现失败，窗口会显示加载失败、可用的请求原因和重试按钮，而不是声称列表为空。连接测试失败的具体原因和清理后的 SSH 提示只在活动窗口中显示，不会在背后重复显示。检查原因，必要时使用下方 SSH 诊断方法，然后重试。重新扫描会保留输入的别名，但连接前必须重新检查指纹。

## 将这台电脑连接为子机

在要使用主机提供商的电脑上：

1. 在控制台中打开 `#remote` 并开启 Remote Link。
2. 选择 **Child**。SSH 主机列表会打开。
3. 选择主机的 SSH 主机，运行连接测试，然后比较并确认其主机指纹。
4. 阅读提示后选择 **Connect as Child**。

连接会重启这台电脑上的 OpenCodex。已在运行的 Codex 请求会先完成，重启期间新的请求可能在最多一分钟内失败。随后控制台会自动重新加载并显示子机链接。Codex 继续使用这台电脑上的 `http://127.0.0.1:<port>/v1`，无需设置令牌或环境变量：本地 OpenCodex 会把每个请求转发给主机，由主机用它自己的提供商和账户提供服务。

如果 **Child** 提示先配对这台电脑，请在这台电脑上打开配置的 HTTP 回环 IP 地址控制台，例如 `http://127.0.0.1:<configured-port>`。只有在缺少配对且控制台与 API 使用同一个回环源时，才会显示本地配对表单。复制表单中的 `ocx gui pair --origin "http://127.0.0.1:<configured-port>"` 命令，在这台电脑的终端中运行，再将一次性代码粘贴到表单中。必须使用表单显示的确切源；提供商 API 密钥或管理员令牌不是配对代码。缺少配对与配置端口不匹配是不同的原因。

选择 **Child** 角色还要求 OpenCodex 以独立运行模式在其配置的端口上运行，因为子机会在正好这个端口上重启。如果控制台提示 OpenCodex 未在其配置的端口上运行，请先在该端口上重启它。

## 链接状态

- **Connected** 表示 SSH 隧道已就绪，子机可以使用主机链接。
- **Reconnecting** 表示正在重试隧道。重试期间请求可能暂时返回带有 `Retry-After` 的 `503`。在从自己的仪表板连接的 Child 上，请求会先最多等待 15 秒让隧道恢复。
- **Failed** 表示链接需要处理。请检查 SSH 身份验证、已确认的主机密钥、转发或超时原因。建立 SSH 隧道的一方会在睡眠、故障或重启后自动重试（Home 添加的 Child 由 Home 重试，从自己的仪表板连接的 Child 由 Child 重试）：超时或转发错误后先在一分钟后重试，之后每次重试失败等待时间翻倍，最长五分钟一次；身份验证错误后每五分钟一次。主机密钥变更时不会重试。要立即重连，请在 Home 的仪表板中选择 **Retry**，或在 Home 上运行 `ocx link reconnect --link-id <id>`。这只会重启该链接的隧道，不会重启 OpenCodex。

链接失败时不会静默切换到本地提供商。

## 移除子机

选择子机的 **Disconnect** 并确认别名。主机会停止隧道、吊销该子机的链接密钥并删除保存的链接记录。

如果主机无法连接子机来运行断开命令，请选择 **Remove here only**。这会只删除本机的隧道、密钥和记录。然后登录子机并运行：

```bash
ocx disconnect
```

要断开由子机发起的链接，请在子机上运行 `ocx disconnect`。该命令会断开客户端隧道，并通过 SSH 在 Home 上撤销链接。如果 Home 撤销失败，命令会输出：`Home revoke failed; run ocx link revoke --link-id <linkId> on the home.`

## 安全

子机会通过链接使用主机电脑上的提供商和提供商凭据。主机会为每台子机创建单独的链接密钥；移除链接会吊销该密钥。确认前比较主机指纹，避免误接受错误电脑或已更换的主机密钥。由 Tailscale 身份签发的控制台会话不能管理机器链接。 在子机上，密钥只保留在 OpenCodex 内部：Codex 或 Claude Code 在子机上发送的凭据不会转发给主机，子机上任何能访问 `127.0.0.1:<port>` 的程序都可以无密钥使用主机，这与独立安装给予本地程序的信任相同。来自其他网站的网页会被拒绝。

## CLI 参考

```text
ocx link probe <alias> [--json]
ocx link add <alias> [--expect-fingerprint SHA256:…] [--json]
ocx link port [--json]
ocx link issue --alias <alias> --tunnel-port <port> [--json]
ocx link status [--json]
ocx link revoke --link-id <id> [--json]
ocx link reconnect --link-id <id> [--json]
ocx link check (--link-id <id> | --all) [--no-wait] [--json]
ocx link update (--link-id <id> | --all) --yes [--no-wait] [--json]
ocx link sync (--link-id <id> | --all) [--no-wait] [--json]
ocx link sync --link-id <id> (--restart-app-server-only | --restart-codex --yes) [--no-wait] [--json]
ocx link restart-codex --link-id <id> [--scope app-server|codex] --yes [--no-wait] [--json]
```

非交互式终端（非 TTY）必须提供 `--expect-fingerprint`。交互式终端中可省略该参数，但必须明确确认所提供的指纹。

在 Home 上，`ocx link check (--link-id <id> | --all)` 会读取每个由 Home 添加的子机的已安装版本、安装类型和更新途径：它通过链接的 SSH 连接在子机上运行 `ocx update --plan`（每台子机 60 秒，同时最多三台），该命令只计算更新计划，不做任何修改。早于 2.97.0 的子机显示为 `owner-action`（`legacy-ocx`），其版本在 macOS 和 Linux 上通过再一次只读 SSH 调用获取，在 Windows 上取自子机通过链接上报的版本。由子机发起的链接和 `ocx-child` 子机不经 SSH 直接报告。`ocx link status --json` 会为每一行添加 `child` 块（版本、版本差异、目录是否最新、活动情况、最近一次操作）。详情和退出码见 [Child install, catalog and activity](/guides/remote-link/#child-install-catalog-and-activity)（英文）。

### 从 Home 操作子机

`ocx link sync`、`ocx link restart-codex` 和 `ocx link update` 通过链接的 SSH 连接在由 Home 添加的子机上运行，并以 JSON 输出任务。`sync` 运行固定的 `ocx sync --expect-link`（子机需 2.93.0 或更高版本）。`restart-codex` 先同步，再重启子机上的 Codex app-server，使正在运行的 Codex 加载当前目录；`--scope codex` 还会重新启动桌面应用。重启只能指定一个链接；`restart-codex` 和 `--restart-codex` 需要 `--yes`，而 `ocx link sync --link-id <id> --restart-app-server-only` 无需确认即可重启 app-server。当 Home 正在为该子机中继模型请求时，重启会被跳过（`restart-skipped:link-active`）。对于早于 2.69 的子机，非流式请求要到响应开始后才能被看到。`update --yes` 使用子机自己的更新程序把子机的 OpenCodex 更新到本 Home 的版本，绝不会更新到其他版本（子机需 2.97.0 或更高版本；npm 和 pnpm 安装通过其 Node 启动器应用更新，因此 `ocx link check` 也会在那里以只读方式运行 `node --version`）。每次更新一台子机，应用成功、失败或回滚后会再次同步；结果未知的应用不会重试也不会同步，请用 `ocx link check` 检查。正在为该子机中继的请求会中断。Windows 子机只支持 `sync`，`ocx-child` 子机会将重启和更新报告为不支持。CLI 需要绑定到 loopback 的 Home；在其他 Home 上无法执行这些操作，仪表盘也不提供这些操作。详情和退出码见 [Operating Children from the Home](/guides/remote-link/#operating-children-from-the-home)（英文）。 此保护为尽力而为：在检查与重启之间开始的请求仍可能被结束，因此需要保留轮次时，请先暂停该子机上的新请求。 `ocx sync --restart-children`（或 `--restart-children=codex --yes`）在 Home 同步向外传播时，对所有子机或用 `--child <linkId>` 指定的子机应用同一规则：每台子机都会同步，只有在有中继请求进行时才跳过其重启（`restart-skipped:link-active`）。

### 目录自动分发与子机策略

目录分发默认开启。当 Home 的目录发生变化时（目录自动刷新报告了变化，或每 5 分钟一次的检查发现了在仪表盘或管理 API 中所做的编辑），Home 会等待 60 秒让编辑稳定下来（距第一次变化最多 5 分钟）。之后无需你进行任何操作，它会在后台为每台符合条件的子机打开一个 SSH 会话，运行与 `ocx link sync` 相同的固定 `ocx sync --expect-link`；除非你启用（见下文 `childCodexRestart`），否则不会重启 Codex。符合条件的子机是：由 Home 发起的链接、隧道已连接、没有其他操作在运行，并且此 Home 在那里最后一次运行的同步早于这次变化；只下载过目录的子机仍被视为落后。正在中继模型请求的子机，只有在其 Codex 设置已经与 Home 一致、且应用这些设置后其 OpenCodex 客户端运行时已经重启过时才会同步，否则同步会重启该运行时；否则会在它空闲后再同步。同步失败会在 5 分钟后重试，间隔逐次翻倍，最长 6 小时；低于 2.93.0 的子机在报告其他版本之前不会重试。这些任务与其他任务显示方式相同，带有 `trigger: "auto"`。没有链接的 Home 不会运行其中任何部分。

分发修复的是子机的目录文件。子机上已经在运行的 Codex app-server 会继续使用已加载的列表，直到重启：请使用 `ocx link restart-codex --link-id <id> --yes` 或 `ocx sync --restart-children`，或者用 `ocx link policy --child-codex-restart app-server-when-idle` 让 Home 重启 app-server；Home 只会在同步运行时仍然空闲的子机上这样做。该设置从下一次自动同步起生效；目录已是最新的子机不会被同步，因此也不会被重启，请手动重启它。

策略保存在 Home 的 `<configDir>/link/child-policy.json` 中，不会写入 `config.json`：

| 设置 | 默认值 | 取值 |
|---|---|---|
| `catalogFanout` | `auto` | `auto`, `manual` |
| `childCodexRestart` | `never` | `never`, `app-server-when-idle` |
| `updates` | `auto-when-idle` | `off`, `notify`, `auto-when-idle` |
| `idleAfterMs` | `600000` (10 分钟) | 1 到 60 分钟 |

`updates` 默认会自动让空闲的子机保持与 Home 相同的版本。本版本中自动更新尚未生效；该设置现在就会保存，因此用 `ocx link policy --updates notify` 或 `--updates off` 做出的退出选择，在自动更新到来时依然有效。`idleAfterMs` 表示子机在没有被中继的模型请求的情况下持续多久才算空闲；它也决定 `ocx link status` 中的 `activity.idle`。

```text
ocx link policy                                    # 读取策略
ocx link policy --catalog-fanout manual            # 关闭目录自动分发
ocx link policy --child-codex-restart app-server-when-idle
ocx link policy --updates off --idle-after-minutes 20 --json
```

`GET` 和 `PUT /api/link/children/policy` 读取和修改相同的设置（环回上的管理令牌，或仪表盘会话）；`PUT` 只发送要修改的设置。如果文件损坏或包含未知取值，目录自动分发和更新都会关闭，并且 `ocx link policy` 会提示这一点。保存会清除警告，但未指定的设置仍保持关闭，请显式开启，例如 `ocx link policy --catalog-fanout auto --updates auto-when-idle`。Home 从不自行改写该文件。

不要链接不属于你的机器：Home 会用你的 SSH 密钥在那里运行命令。

## 相关指南

- [Remote Hub 部署](/zh-cn/guides/remote-hub/)
- [远程工作区](/zh-cn/guides/remote-workspace/)


`ocx link probe <alias> --json` · `ocx link add <alias> --expect-fingerprint SHA256:… --json` — [CLI, restart, relay verification and recovery](/guides/remote-link/#add-a-child-from-the-terminal).
