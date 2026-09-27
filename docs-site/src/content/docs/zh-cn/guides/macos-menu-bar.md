---
title: macOS 菜单栏应用
description: 使用 OpenCodex 桌面应用的 macOS 托盘、原生用量面板和 widget。
---

macOS 菜单栏项目是 OpenCodex 桌面应用的一部分。它显示来自本地 proxy 的用量，并打开原生用量面板。同一应用还包含仪表盘和 WidgetKit 扩展。其他平台的安装方法见[桌面应用指南](/zh-cn/guides/desktop-app/)。

## 安装

从[最新版本](https://github.com/lidge-jun/opencodex/releases)下载 `OpenCodex-<version>-macos.dmg`。打开 DMG，将 `OpenCodex.app` 拖入“应用程序”。桌面应用要求 macOS 13 或更高版本；widget 要求 macOS 14 或更高版本。

## 首次启动

发布版 `OpenCodex.app` 使用 Developer ID 签名和加固运行时，经 Apple 公证后，公证票据也会附加到应用上。首次启动时，macOS 通常只会显示从互联网下载应用的标准确认提示。如果仍被阻止，请打开 **System Settings → Privacy & Security**，为 OpenCodex 选择 **Open Anyway**。自行构建的应用使用临时签名；参见[从源码构建](#从源码构建)。

打开应用时，窗口会显示启动进度。首次启动会自动启用一次 **Start at Login**；你可以从托盘菜单关闭。此后由登录项目启动时，窗口会隐藏，但托盘仍可使用。

## 菜单栏与用量面板

菜单栏标题默认显示今日 token 总量。在仪表盘的 **Menu bar & widget** 设置中，可以选择请求数、token 数、估算费用、配额或仅显示图标。

使用托盘菜单中的 **Show Usage** 打开原生面板。面板会按照显示设置列出今日及近 30 天总量、用量图表、模型列表，以及 provider 和账户限额。总量包括 token 和请求数；启用后还会显示估算费用。配额行显示统计窗口、百分比和重置时间。缺失的测量值显示为 `—`，部分用量会标记为不完整。

面板提供 **Refresh**、**Dashboard** 和 **Settings** 控件。**Dashboard** 会在桌面窗口中打开用量视图；**Settings** 会在其中打开配套设置。托盘菜单还提供 **Open Dashboard**、**Open in Browser**、**Start at Login**、**Stop proxy**、**Check for Updates…**、有更新时的 **Install update**，以及 **Quit**。**Stop proxy** 始终列在菜单中，但只有应用自行启动 proxy 时才可点击；你单独启动的 proxy 会继续运行。有托盘可用时，关闭窗口或按 Command-Q 只会隐藏应用；要退出，请使用托盘中的 **Quit**。

桌面仪表盘的更新按钮会打开应用自己的更新页面；它检查并安装与托盘菜单相同的已签名更新。

托盘标题每 60 秒刷新一次。原生面板打开期间，其数据也每 60 秒刷新；点击 **Refresh** 会立即请求更新。

## Widget

在 macOS 14 或更高版本中，先打开一次 OpenCodex.app，然后按住 Control 点击桌面空白处，选择 **Edit Widgets**，搜索 **OpenCodex** 并添加所需尺寸。不同尺寸的 widget 会以不同组合显示 proxy 状态、今日 token 和请求数、估算费用、配额及用量图表。扩展读取桌面应用写入的本地快照；快照只包含显示数据，不包含 API key 或原始账户数据。连接 proxy 期间，应用每经过五个 60 秒托盘刷新周期更新一次 widget 快照，约每五分钟一次。WidgetKit 也会在五分钟后请求新时间线。

## 连接到 proxy

桌面应用让内置 CLI 运行 `ocx resolve --json`。如果已有可访问的本地 proxy，就连接到它；只有 CLI 证实没有运行时在监听，才会启动内置运行时。如果发现结果不确定，应用会报告启动问题，不会启动第二个 proxy。应用通过 `127.0.0.1` 上解析出的端口通信。

对于管理请求，应用首先尝试不携带 token。如果 proxy 返回 HTTP 401，它会使用应用环境中的 `OPENCODEX_ADMIN_AUTH_TOKEN`，或解析出的配置 home 中的 `admin-api-token` 文件重试。它不会使用 macOS Keychain 存储此 token。如果 proxy 只绑定到应用无法通过 loopback 访问的地址，桌面外壳便无法连接它。

## 从源码构建

在 macOS 13 或更高版本中，准备好 Bun、Rust 和 macOS Swift/Xcode 工具，从仓库根目录构建仪表盘，再到 `desktop/` 运行桌面命令：

```bash
bun install
bun run build:gui
cd desktop
bun install
bun run prepare-sidecar
bun run prepare-widget
bun run build:local
```

`build:local` 无需 Tauri 更新器签名密钥即可生成本地应用和 DMG。直接运行 `bunx tauri build` 则需要 `TAURI_SIGNING_PRIVATE_KEY`，因为它还会生成更新器产物。除非设置了 `MACOS_SIGN_IDENTITY`，否则 widget 构建会使用临时签名；本地桌面 bundle 也使用临时签名。应用可以运行，但 macOS 不会注册临时签名的 widget 扩展，因此本地构建通常看不到 OpenCodex widget。`build:local` 始终对应用使用临时签名，仅设置 `MACOS_SIGN_IDENTITY` 并无帮助：只有应用和扩展都由同一 Developer ID 团队签名时，widget 才会注册，就像发布版一样。需要 widget 时请使用发布版构建。

## 卸载

如果启用了 **Start at Login**，先在托盘菜单中关闭它，再将“应用程序”中的 `OpenCodex.app` 移到废纸篓。这会移除内置 CLI 和 widget 扩展，但不会删除 proxy 的 `$OPENCODEX_HOME` 状态或单独安装的 `ocx` 服务。桌面应用还会在应用配置目录中写入安装 ID 和登录项目标记，并在 `~/Library/Containers/com.opencodex.desktop.widget/Data/Library/Application Support/OpenCodex/snapshot.json` 下写入 widget 快照；将应用移到废纸篓不会删除这些文件。
