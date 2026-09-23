---
title: Remote Workspace
description: 将 Codex、Claude Code、Pi 及其登录保留在同一个 OCX Hub，让仅安装 OCX 的计算机提供工作区和构建环境。
---

Remote Workspace 让一台 OpenCodex Hub 运行编程代理，由另一台计算机提供项目文件、命令、测试和构建算力。手机或第三台计算机可通过 Hub 仪表盘控制会话。

```text
Phone browser -> Computer 1 OCX Hub -> encrypted channel -> Computer 2 OCX Executor
                 Codex / Claude / Pi                       project and commands
                 logins and sessions                      no coding CLI login
```

Executor 只需要 OpenCodex，不需要 Codex、Claude Code、Pi、ChatGPT 登录或提供商 API 密钥。它向 Hub 建立出站 WebSocket，因此无须为 Executor 开放公网端口或设置路由器端口转发。

:::caution[实验性基础功能]
Remote Workspace 需要主动启用，尚未面向生产环境发布。Linux 提供文件工具，以及在条件满足时通过 bubblewrap 执行命令。Windows 和 macOS 只提供文件工具：官方原生辅助程序会拒绝探测与命令请求。在确认生命周期管理者能够在取消期间保持清理权限之前，Windows 命令仍不受支持。缺少命令支持时，绝不会回退到 Hub 上执行。
:::

## 设置 Hub

计算机 1 保存所有编程代理的登录和模型会话。先在其上安装并登录所需代理，然后以 Hub 身份运行 OpenCodex：

```bash
ocx config set runtimeRole hub
OCX_REMOTE_WORKSPACE_ENABLED=1 ocx start
ocx gui
```

必须在 Hub 进程本身设置 `OCX_REMOTE_WORKSPACE_ENABLED=1`；只对仪表盘命令设置它，不会启用已运行的服务。未明确启用的 Hub 会返回禁用状态，不创建工作区密钥，也不探测编程代理运行时。

从手机或其他计算机打开仪表盘时，请使用经过认证的 HTTPS 部署。受支持的管理入口和 Tailscale 部署方式见 [Remote Hub 部署](/zh-cn/guides/remote-hub/)。不要公开未经认证的本地仪表盘端口。

Codex Remote Workspace 使用当前 App Server 权限配置文件。如果 Hub 选中的 Codex 配置仍设置旧版 `sandbox_mode` 或 `sandbox_workspace_write`，仪表盘会报告 Codex 不可用，而不会以较弱的边界启动。使用此功能前请迁移该 Codex 配置文件；不要同时配置旧版沙箱和权限配置文件。

## 配对 Executor

1. 在 Hub 仪表盘中打开 **Remote Workspace**。
2. 选择 **Create pairing code**。
3. 在计算机 2 上进入要开放的项目目录。
4. 复制为该计算机生成的 **Linux / macOS terminal** 或 **Windows PowerShell** 命令。该命令会配对当前目录，并使 `ocx remote-workspace agent` 在终端内保持连接。

等效的手动流程如下：

```bash
cd /path/to/project
printf '%s\n' 'ONE-TIME-CODE' | ocx remote-workspace pair 'https://your-hub.example' \
  --pairing-code-stdin --root "$PWD"
ocx remote-workspace agent
```

在 Windows PowerShell 上，请使用仪表盘显示的命令。等效的手动写法为：

```powershell
$pairingCode = 'ONE-TIME-CODE'
$pairingCode | ocx remote-workspace pair 'https://your-hub.example' `
  --pairing-code-stdin --root (Get-Location).Path
if ($LASTEXITCODE -eq 0) { ocx remote-workspace agent }
```

在 Linux 沙箱中，当前 OCX Bun 可执行文件会自动以单个只读文件形式加入。如果项目需要系统路径之外的用户安装工具链，请明确配对该工具链，而不要暴露主目录的其他部分：

```bash
printf '%s\n' 'ONE-TIME-CODE' | ocx remote-workspace pair 'https://your-hub.example' \
  --pairing-code-stdin --root "$PWD" \
  --toolchain-root "$HOME/.nvm/versions/node/v24/bin"
```

原生辅助程序源码随包提供，供审查。构建它并不会在本次交付中启用 Windows 或 macOS 命令。`--executor-helper` 仍用于选择经过审查的辅助程序；二进制存在或路径已配置，都不能证明命令可用。

一次性代码从标准输入读取，而不是命令行参数。配对会创建本地设备签名密钥和设备专属 bearer。Hub 只存储 bearer 的哈希，绝不会收到 Executor 的真实路径。按 Ctrl+C 停止前台代理；再次运行会重新连接同一设备。

检查本地登记状态而不打印密钥：

```bash
ocx remote-workspace status
```

## 启动远程编程会话

在仪表盘中选择：

1. 在线的计算机；
2. 一个本地批准的工作区文件夹；
3. Hub 上的 Codex、Claude Code 或 Pi；
4. 访问模式。

**Read only** 是默认模式，只允许列出目录和读取文件。仅当该 Executor 通过命令沙箱探测时，写入选项才显示为 **Edit files and run commands**；否则显示为 **Edit files only**。仪表盘分别显示两个位置，明确模型与登录保留在 Hub，而工作区操作在选中的计算机上运行。

可以从计算机 1、计算机 3 或手机上的 Hub 仪表盘发送提示。会话不能静默切换到其他计算机或文件夹。如果 Executor 断开，会话进入 **Executor offline** 状态，绝不会回退使用 Hub 文件系统。

提交提示后会立即确认已接受；仪表盘会轮询会话进度与完成状态。如果确认响应丢失，草稿仍会显示，并附有提交状态未知的提示。再次发送前请检查会话进度；仪表盘绝不会自动重试提示。

提示运行期间仍可使用 **Stop**。它会中断 Hub 编程代理当前轮次，取消正在运行的 Executor 命令，并阻止迟到的响应重新打开已停止的会话。

## 重启与重新连接

Hub 会持久保存有界的会话元数据和少量近期事件快照。Hub 重启后，未完成的会话会等待其原 Executor。设备重新连接后，下一个提示会恢复原来的 Codex 任务、Claude Code 会话或 Pi 会话 ID。

Claude Code 在第一个提示完成后才创建持久历史。如果 Hub 在新 Claude 会话的任何提示完成之前停止，就没有可恢复的对话；请创建新会话。

能力清单变化不会静默降低现有会话的边界。如果 Executor 失去命令隔离能力，或可用工具发生变化，请新建会话。撤销计算机授权会关闭其 socket，并停止与之绑定的会话。

## 安全边界

- 提供商凭据和编程代理历史保留在 Hub。
- Executor 私钥、设备 bearer 和真实根路径保留在仅所有者可访问的 OCX 状态中。
- 每个监听器会按内核观察到的对端限制配对码失败次数。十分钟内十次失败会返回通用 `429` 和 `Retry-After`；Hub 只保留这些来源身份的有界、会过期的哈希。Tailscale Serve 用户共用管理监听器的回环限额，因为直接本地调用方可以伪造其身份标头。
- 每个工作会话使用 Ed25519 签名的临时 P-256 ECDH 握手，以及有序的 AES-256-GCM 消息。
- 双方就当前能力清单达成一致之前，socket 不会显示为在线。
- 本地沙箱不可用时，重新连接可以移除能力，但绝不会增加配对时记录的授权范围以外的能力。
- 每个请求都绑定一个模型任务、设备、根目录、访问模式和能力集合。
- 路径必须是相对路径，经过规范化和边界检查；符号链接、接合点或父目录逃逸都会被拒绝。Windows 设备名称、备用数据流以及末尾句点/空格别名也会被拒绝。
- Executor 操作按顺序执行；已打开文件的身份会重新核对，写入哈希也会在原子替换前再次检查。若要替换已批准的根目录，必须重新配对；每条命令执行前都会重新验证工具链根目录。
- 文件读写会拒绝硬链接文件。执行命令前，OCX 最多扫描 250,000 个工作区条目；如果任何非目录条目有多个链接，则禁用命令路径，因为路径沙箱无法证明同一 inode 的另一名称是否位于批准根目录之外。
- Linux 命令通过 bubblewrap 运行：只开放一个可写工作区，清空环境，使用私有进程命名空间，将当前 OCX Bun 可执行文件作为单个只读文件加入，限制输出和运行时间，默认关闭网络。专门的隔离测试需要明确配置的托管环境；普通测试套件通过并不证明这些测试已运行。
- macOS 只声明文件工具。子进程调用 `setsid()` 后，进程组便无法再包含它；仅为启动命令而导入宽泛的 Apple Seatbelt 系统配置文件，会暴露无关的宿主服务权限。因此在 OCX 拥有范围狭窄、可撤销的后代进程管理者之前，原生辅助程序会拒绝探测和直接命令请求。
- Windows 和 macOS 原生命令请求均以封闭式失败处理。必须区分其辅助程序直接拒绝测试与实际命令隔离有效的证据；Windows 命令接受能力仍待实现。
- 固定的原生辅助程序必须位于每个已批准可写工作区之外。OCX 在声明命令支持前和每条命令执行前都会检查，避免工作区代码替换执行下一次沙箱检查的二进制文件。
- 停止会话会取消活动的 Executor 命令，并清理 Hub 模型进程和回环工具桥接器。Windows 会停止归属明确的 npm 封装进程树，而不会留下其 Node 子进程；Linux 和 macOS 只在 CLI 忽略正常停止时间窗口时强制停止。

Hub 运行编程代理，因此它有意能够看到提示和模型输出。端到端加密保护 Executor RPC 载荷。配对的 Hub 被信任通过认证 WSS 选择已批准的根目录；它并非无法看到自身的模型对话。

## 当前范围

Remote Workspace 不会将凭据复制或同步到其他计算机。它与 Remote Hub 提供商路由及未来可能的托管算力或 Super Sync 产品相互独立。生产发布仍需要签名的 Windows 辅助程序打包、针对确切二进制文件的原生 CI 证明、独立维护者审查，以及真实的三台计算机验收测试。

## 提示接受 API

`POST /api/remote-workspace/sessions/:id/prompt` 返回 HTTP 202 和已接受的会话快照。会话 ID 与单调递增的事件序号标识该接受快照；202 不代表模型轮次已经完成。请轮询 `GET /api/remote-workspace/sessions` 以获取后续事件和最终状态。该轮次运行期间，重新连接和运行时恢复仍会报告繁忙。确认响应丢失意味着接受状态未知，因此客户端必须先轮询，再决定是否重新提交。
