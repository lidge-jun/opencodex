---
title: ChatGPT 桌面版发送键解锁
description: 账号用量额度用完时，让 ChatGPT 桌面版的输入框保持可用（macOS，需手动开启）。
---

登录的 ChatGPT 账号用完用量额度后，ChatGPT 桌面版会把发送按钮置灰，即使该对话的模型调用由
opencodex 路由到其他提供商。这个需手动开启的 macOS 集成可以让输入框保持可用，默认关闭。

## 它改变了什么

opencodex 为 `chatgpt.com` 运行一个本地 TLS 监听器。app 启动时会带上一个 Chromium 参数，
把 `chatgpt.com` 指向这个监听器；其他所有域名（包括它的子域名）都保持原来的路径。请求会带着
app 自己的凭据转发到真正的 `chatgpt.com`，WebSocket（例如语音听写）也会一并转发。不记录、
不存储任何内容。

除以下两个接口外，所有响应都原样透传：

- 对话元数据（`/backend-api/conversation/init` 和对话流）：去掉由用量额度导致的发送锁；
- 用量快照（`/backend-api/wham/usage`）：打开“已达上限”的开关。

其他原因的发送锁（例如需要订阅）会保留，并在 `ocx chatgpt status` 中列出。显示的用量
（百分比、重置时间、横幅）不会被修改，OpenAI 服务器仍会对其自身的请求执行所有限制。

## 设置

1. 在 `~/.opencodex/config.json` 中开启该功能，然后重启 opencodex：

   ```json
   { "chatgptDesktop": { "unblockSend": true } }
   ```

   监听器使用代理端口加 200（默认 `10300`）。设置 `chatgptDesktop.port` 可以换用其他端口。

2. 信任本地证书颁发机构（只需一次）。该命令会要求输入登录密码，请自己运行：

   ```bash
   security add-trusted-cert -r trustRoot -p ssl \
     -k ~/Library/Keychains/login.keychain-db ~/.opencodex/claude-intercept/ca.pem
   ```

   没有这项信任，app 无法加载账户、用量和设置页面。如果你使用了自定义的 opencodex 目录，
   `ocx chatgpt status` 会打印适合你环境的准确命令。

3. 通过 opencodex 启动 app：

   ```bash
   ocx chatgpt launch
   ```

4. 可选：让普通的 Dock 和聚焦搜索启动也使用该路径：

   ```bash
   ocx chatgpt install-watcher
   ```

   watcher 在 app 每次启动时运行。如果 opencodex 正在运行而 app 是以普通方式打开的，它会在
   启动后立即退出 app 并带上路径重新打开。它不会对正在使用中的 app 做任何操作，opencodex
   未运行时也什么都不做。该命令会请求确认；`--yes` 可以非交互式确认。

## 网络环境

不需要配置任何 VPN 或代理规则。默认模式下，每次 app 启动时，都会根据系统代理选择启动参数：

| 环境 | app 的启动参数 |
|---|---|
| 无代理 | 只有 `chatgpt.com` 路径。 |
| VPN 系统代理模式 | 路径、带直连回退的系统代理，以及只针对 `chatgpt.com` 的绕过。 |
| VPN TUN 模式 | 只有路径；本机回环流量不会进入隧道。 |
| PAC 文件 | 只有路径。PAC 文件可能让 `chatgpt.com` 继续走代理，输入框因此可能仍被锁定，但其他功能不受影响。 |

opencodex 通过自己的 `proxy` 设置访问真正的 `chatgpt.com`，与它的其他出站流量一致。

## opencodex 停止后仍能使用 app

默认模式下，已接管的 app 依赖监听器：opencodex 停止期间，它对 `chatgpt.com` 的请求都会失败。PAC 回退
改为用生成的 PAC 文件启动 app，让 app 自行回退：

```json
{ "chatgptDesktop": { "unblockSend": true, "pacFallback": true } }
```

`pacFallback` 只有与 `unblockSend` 同时开启才生效。此时 opencodex 还会在监听器端口加一（默认 `10301`）
上监听，并在每次启动时重写主目录下的 `chatgpt-unblock.pac`。PAC 先把 `chatgpt.com` 发给 opencodex，
其他主机则按系统的路由走：

| 环境 | 其他主机，以及 opencodex 停止期间的 `chatgpt.com` |
|---|---|
| 无代理，或 VPN TUN 模式 | 直连。 |
| VPN 系统代理模式 | 系统代理，然后直连。 |
| PAC 文件 | 系统 PAC（嵌入生成的文件中）。 |

opencodex 停止后，app 无需重启就会沿这条路由继续工作；只有发送解锁会暂停，直到 opencodex 恢复。路由在
opencodex 启动时读取：切换 VPN 模式后，请重启 opencodex 并运行 `ocx chatgpt launch`。如果当时设置了系统
PAC 却读取不到，其他主机会直连，opencodex 会打印警告。

开启或关闭 `pacFallback` 后，请重启 opencodex、运行 `ocx chatgpt launch`；如果在用 watcher，还要重新运行
`ocx chatgpt install-watcher`。

## 查看状态

```bash
ocx chatgpt status
```

它会报告：功能是否开启、端口上的监听器是否属于 opencodex、证书是否受信任、watcher 状态、
运行中的 app 是否带有路径，以及被有意保留的发送锁。

## 关闭

```bash
ocx chatgpt uninstall-watcher
ocx chatgpt restore
```

`restore` 会以原生网络重新打开已接管的 app。之后把 `chatgptDesktop.unblockSend` 设为
`false` 并重启 opencodex。该证书颁发机构与 opencodex 的 Claude 集成共用；只有两者都不使用时
才移除它的信任。

## 故障排查

- **账户、用量或设置页面加载不出来：** 证书未受信任。重新执行第 2 步；`ocx chatgpt status`
  会显示信任状态。
- **发送按钮仍是灰色：** 查看 `ocx chatgpt status`。app 可能没有带着路径运行（运行
  `ocx chatgpt launch`），或者锁的原因不是用量额度，会列在 “send blocks kept” 下。
- **opencodex 停止后 app 什么都加载不出来：** 默认模式下，已接管的 app 依赖监听器。重新启动 opencodex，
  或运行 `ocx chatgpt restore`；开启 PAC 回退后，app 会自行回退。
