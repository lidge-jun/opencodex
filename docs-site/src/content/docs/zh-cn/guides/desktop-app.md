---
title: 桌面应用
description: 在 macOS、Windows 和 Linux 上安装并使用 OpenCodex 桌面应用。
---

OpenCodex 桌面应用将原生托盘与 web 仪表盘结合。其内置 CLI 会查找现有的本地 proxy；只有确认不存在时，应用才会启动内置运行时。

仪表盘由找到的本地 proxy 端点提供服务（默认端口为 `10100`）。桌面应用是围绕该仪表盘和内置运行时的本地外壳。

## 安装

### macOS

从[最新版本](https://github.com/lidge-jun/opencodex/releases)下载 `OpenCodex-<version>-macos.dmg`。打开 DMG，将 `OpenCodex.app` 拖入“应用程序”。应用要求 macOS 13 或更高版本。

发布版 `OpenCodex.app` 使用 Developer ID 签名，并经过 Apple 公证，因此首次启动时，macOS 通常只会显示下载应用的标准确认提示。如果仍被阻止，请使用 **System Settings → Privacy & Security → Open Anyway**。

### Windows

下载并运行 `OpenCodex-<version>-windows-x64.msi`。安装程序尚未经过代码签名，Windows SmartScreen 可能发出警告；确认文件来自发布页面后，选择 **More info → Run anyway**。

### Linux

从发布页面下载 `OpenCodex-<version>-linux-x86_64.AppImage` 或 `OpenCodex-<version>-linux-amd64.deb`。

使用 AppImage：

```bash
chmod +x OpenCodex-<version>-linux-x86_64.AppImage
./OpenCodex-<version>-linux-x86_64.AppImage
```

使用基于 Debian 的发行版：

```bash
sudo apt install ./OpenCodex-<version>-linux-amd64.deb
```

托盘图标需要支持 AppIndicator 的桌面环境。

## 首次启动

应用会让内置 CLI 运行 `ocx resolve --json`；如果已有可访问的本地 proxy，就连接到它。只有 CLI 证实不存在运行时，应用才会启动内置运行时；结果不确定时会显示启动失败。随后，仪表盘会在应用的 webview 中通过找到的 loopback 端点打开。登录时隐藏在托盘中启动的应用会保留轻量的启动页，直到你第一次从托盘打开或再次启动应用时才加载仪表盘。

使用托盘中的 **Open dashboard** 或 **Open in browser**，可在内嵌仪表盘与常用浏览器之间切换。托盘也提供更新检查。

在 macOS 上，关闭仪表盘后，应用会继续在菜单栏中运行。从 Dock 或 Finder 再次打开 OpenCodex 即可恢复仪表盘，无需重启代理。

当 Codex 启动找不到 proxy 时，内置 CLI 会等待经过独立验证的 Desktop 恢复——即使 Desktop 没有记录在案的所有权声明也不例外。匹配到的 Desktop 已停止其 proxy，或其恢复无法验证时，会报错；但在不支持运行镜像验证的平台上，若有记录在案的所有权声明且应用仍在运行，则保留现有的有界等待。仅凭进程名或定位文件不会阻止普通的 CLI 启动。在 macOS 上，如果 shim 发现 OpenCodex 已退出且记录的所有权与有效的 **Start at Login** 注册一致，就会打开它。自动重新打开时，会选择该注册记录中的应用 bundle 路径，并检查其声明的主可执行文件是否与已注册的 Desktop 可执行文件一致。注册缺失、过期或不一致时，请手动打开 OpenCodex；具有相同 bundle 标识符的其他副本不会作为回退被选中。如果 shim 显示“activation not confirmed”，请在 shell 启动文件中的其他 PATH 设置之后添加 `. ~/.opencodex/codex-shell-env.sh`。

恢复验证覆盖 macOS/Linux 上匹配的内置 CLI 以及受保护的系统级 Debian 安装。早期由 npm 创建的 shim 可能固定了单独的 Bun/CLI 安装，从而绕过 Desktop 的终端命令交接。该入口无法验证 macOS 或 Windows 的 Desktop（包括官方签名副本），也无法验证任意单用户 Linux 副本。请在 Desktop 的 Startup 页面重新创建 shim，或直接调用其内置 CLI。Windows 尚无法建立该恢复证明所需的运行镜像身份；被识别出的运行中同类进程不会获得恢复信任，在没有记录在案的 Desktop 声明时会报错，而不是启动 CLI proxy——即使其磁盘签名有效。存在记录声明且应用正在运行时，CLI 会保留对 Desktop proxy 的现有有界等待。

## 在托盘中查看用量

在 macOS 和 Windows 上，点击托盘图标即可打开紧凑的用量窗口。托盘中的 **Show usage** 也能打开它，包括在不转发点击事件的 Linux 桌面上。在 Linux 上，仪表盘会在启动时打开，即使桌面环境没有显示托盘图标也是如此。

用量窗口显示今日和近 30 天总量、已配置的用量图表、紧凑的模型列表，以及 provider／账户限额。配额条旁显示重置倒计时；悬停可查看准确时间。现有的 **Menu bar & widget** 设置控制可见区块和图表。隐藏的 provider 不计入标题、总量、配额或图表。图表包含当前时间区间内的活动。部分数据指示符表示某些图表数据无法可靠归属；缺失的测量值不会被显示为零用量。在 Windows 和 Linux 上，如果账户列表很长，请在用量窗口内滚动到底部，找到 Refresh 和 Dashboard。

在 macOS 上，该窗口使用原生 SwiftUI 控件和可滚动的 AppKit 面板。macOS 26 及更高版本使用 Apple Liquid Glass；旧系统使用原生弹出面板材质。长账户列表滚动时，标题和 Refresh、Dashboard 按钮仍保持可见。也可以通过 **View → Show Usage**（Command-Shift-U）打开。按 Escape 或点击面板外部即可关闭。

托盘菜单显示今日请求数和 token 数；启用时还会显示估算费用。它采用与 widget 相同的本地日期用量。选择 **Refresh now** 可立即更新；应用也会每 60 秒刷新一次。显示偏好仍在仪表盘的 **Menu bar & widget** 区域中。关闭 **Today** 会隐藏摘要，关闭 **Cost** 会从摘要中移除费用。

不可用或明确未测量的用量显示为 `—`，不会伪装成测得的零值。选择仅图标标题会清除之前的计数。缩写会保留整数位的零：一千万 token 显示为 `10M`，而非 `1M`。

## 更新

在托盘菜单中选择 **Check for Updates…** 可立即检查。发布版还会在启动后及每六小时自动检查。

当 Tauri 更新器发现新应用版本时，macOS 菜单栏图标或有 tray host 的 Windows/Linux 托盘图标上会出现蓝点。内嵌仪表板显示相同的桌面更新信号。连接同一代理的普通浏览器仍显示代理包的更新状态。如果 shell 约三分钟不再报告，内嵌徽标会变为 unknown，直到重新连接。蓝点只表示有更新；安装仍需明确操作。

在桌面应用中，选择仪表盘的更新按钮即可打开应用更新页面。你可以在那里重新检查、安装待处理的已签名更新，或返回仪表盘。托盘菜单也提供相同的安装操作。如果安装失败，更新仍可重试。即使 Linux 桌面没有托盘图标，也可以使用此页面。普通浏览器仪表盘则管理该代理的包安装。

安装更新前，会使用项目已签名的更新器公钥进行验证。在 macOS 上，应用内更新会下载 `OpenCodex-<version>-macos.app.tar.gz`；DMG 用于首次安装。只有配置了更新器密钥 secret，才会生成发布清单；生成时要求四个平台都完成签名。

## Widget

macOS 应用包含 OpenCodex WidgetKit 扩展。widget 的设置和本地快照细节参见 [macOS 菜单栏应用指南](/zh-cn/guides/macos-menu-bar/)。

## 卸载

在 macOS 上，将“应用程序”中的 `OpenCodex.app` 拖入废纸篓。在 Windows 上，从 **Installed apps** 中移除 OpenCodex。在基于 Debian 的 Linux 系统中运行：

```bash
sudo apt remove opencodex
```

对于 AppImage，删除下载的文件即可。

如果无法读取已保存的菜单栏设置，应用会拒绝部分编辑，以保留该文件。请恢复文件，或在再次编辑前明确重置配套设置。
