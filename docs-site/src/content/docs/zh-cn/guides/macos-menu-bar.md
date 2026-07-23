---
title: macOS 菜单栏
description: 构建并使用原生 opencodex 菜单栏应用，查看代理状态并控制生命周期。
---

macOS 12 及以上版本的菜单栏应用会显示代理健康状态、版本、运行时间、PID、端口、Bun 运行时来源和
launchd 状态，并可在不打开终端的情况下启动、重启或停止代理。

## 构建和打开

先安装并初始化 `ocx` CLI，然后在仓库中运行：

```bash
bun run build:macos
open "dist/macos/OpenCodex.app"
```

选择完整 Xcode 工具链后，使用 `UNIVERSAL=1 bun run build:macos` 可同时构建 arm64 和 x86_64；
只有 Command Line Tools 时只能构建当前架构。产物会进行本地使用的 ad-hoc 签名；正式分发仍需要
Developer ID 签名和 notarization。

应用读取 `ocx status --json`，并把启动、重启和停止操作交给现有 CLI。重启和停止可能中断进行中的
请求，因此会先显示确认对话框。退出菜单栏应用本身不会停止代理。

代理状态行始终清晰显示；可在其子菜单中查看版本、PID、端口、运行时间、运行时、服务和 CLI 详细信息。

应用会从 PATH、Homebrew、Bun、Volta、pnpm、nvm 和 fnm 自动查找 `ocx`。如果未找到，可通过
**选择 ocx CLI…** 手动选择。若要登录时自动打开，可在**系统设置 → 通用 → 登录项**中添加构建后的应用。
