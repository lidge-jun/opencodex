---
title: 远程链接
description: 通过 SSH 将 OpenCodex 主机与子机连接起来。
---

机器链接通过 SSH 连接 OpenCodex **主机（Home）** 与 **子机（Child）**。主机通过 SSH 隧道为子机提供服务，两台电脑各自继续在 `10100` 端口运行本地 OpenCodex 服务。控制台会通过 SSH 传递子机专用的链接密钥，因此不需要手动输入令牌。

## 要求

- 主机可以使用 OpenSSH 密钥登录子机。
- 对于由子机发起的链接，子机必须能使用 OpenSSH 密钥登录主机（不支持密码登录）。
- 子机已安装 OpenCodex 2.66.0 或更高版本（由子机发起的链接还要求主机也满足）。
- 两台电脑运行 macOS 或 Linux。
- 链接从 Home 一侧发起：控制台需在 Home 电脑本机打开（独立安装的浏览器或桌面应用），或通过已配对的 Hub 会话打开。

密码 SSH 和 Windows 不在当前流程中。此版本不支持从控制台把电脑连接为子机（即由子机发起的链接）：加入会重新启动这台电脑上的 OpenCodex，已在运行的 Codex 连接会因此中断，因此控制台中的 **子设备** 角色不可选。受支持的方式是由 Home 发起链接：在要作为 Home 的电脑上选择 **Home**，再按下文步骤把另一台电脑添加为子机。

## 从 `#remote` 添加子机

1. 打开控制台的 `#remote`，开启 Remote Link。
2. 选择 **Home**，然后点击 **Continue**。SSH 主机列表会打开。
3. 从 SSH 候选主机中选择主机，或输入 SSH 配置别名。
4. 运行连接测试，并将显示的主机指纹与目标电脑的指纹进行比较。比较指纹可以在 SSH 信任主机前发现错误的电脑或已更换的主机密钥。
5. 确认指纹，然后连接子机。

控制台不会要求输入令牌。它会先探测主机，只有明确确认指纹后才能应用链接。

## 链接状态

- **Connected** 表示 SSH 隧道已就绪，子机可以使用主机链接。
- **Reconnecting** 表示正在重试隧道。重试期间请求可能暂时返回带有 `Retry-After` 的 `503`。
- **Failed** 表示链接需要处理。请检查 SSH 身份验证、已确认的主机密钥、转发或超时原因。

链接失败时不会静默切换到本地提供商。

## 移除子机

选择子机的 **Disconnect** 并确认别名。主机会停止隧道、吊销该子机的链接密钥并删除保存的链接记录。

如果主机无法连接子机来运行断开命令，请选择 **Remove here only**。这会只删除本机的隧道、密钥和记录。然后登录子机并运行：

```bash
ocx disconnect
```

要断开由子机发起的链接，请在子机上运行 `ocx disconnect`。该命令会断开客户端隧道，并通过 SSH 在 Home 上撤销链接。如果 Home 撤销失败，命令会输出：`Home revoke failed; run ocx link revoke --link-id <linkId> on the home.`

## 安全

子机会通过链接使用主机电脑上的提供商和提供商凭据。主机会为每台子机创建单独的链接密钥；移除链接会吊销该密钥。确认前比较主机指纹，避免误接受错误电脑或已更换的主机密钥。由 Tailscale 身份签发的控制台会话不能管理机器链接。

## CLI 参考

```text
ocx link port [--json]
ocx link issue --alias <alias> --tunnel-port <port> [--json]
ocx link status [--json]
ocx link revoke --link-id <id> [--json]
```

## 相关指南

- [Remote Hub 部署](/zh-cn/guides/remote-hub/)
- [远程工作区](/zh-cn/guides/remote-workspace/)
