---
title: macOS 菜单栏应用
description: 在菜单栏中查看 OpenCodex 代理状态、用量和各提供商配额的原生应用。
---

菜单栏应用让你无需打开仪表板，就能看到代理状态、近期用量和各提供商的配额压力。

它与代理是两个独立的程序。`ocx` 照常运行，菜单栏应用只是连接本地管理 API 的客户端。

## 桌面应用（Tauri）

同一个仪表板也可以在 OpenCodex 桌面应用中运行。用量面板会显示匹配操作系统的安装步骤；
在桌面壳中选择**在浏览器中打开**，即可在普通浏览器中打开当前页面。

## 安装

推荐使用 OpenCodex 桌面应用安装。从[发布页面](https://github.com/lidge-jun/opencodex/releases)下载 macOS 的
`OpenCodex-<version>-macos.dmg`，打开 DMG 后将 `OpenCodex.app` 拖到「应用程序」文件夹。
Windows 运行 `OpenCodex-<version>-windows-x64.msi`，Linux 使用 AppImage 或
`OpenCodex-<version>-linux-amd64.deb`。

```bash
chmod +x OpenCodex-<version>-linux-x86_64.AppImage
sudo apt install ./OpenCodex-<version>-linux-amd64.deb
```

Windows SmartScreen 或 macOS Gatekeeper 可能显示警告。应用会连接现有的 `ocx` 代理；
找不到代理时则启动内置 sidecar。

## 首次启动：Gatekeeper

**首次启动会被阻止。** macOS 会提示：

> 无法打开“OpenCodex.app”，因为无法验证开发者。

这是预期行为，所以这里说明原因而不是直接略过。Gatekeeper 需要 Apple 的 Developer ID 签名和
公证（notarization）票据，两者都需要付费的 Apple Developer 账号。OpenCodex 没有该账号，因此
应用以 ad-hoc 签名发布：程序包本身完整、签名有效，但 Apple 并未为发布者背书。

仍要打开：

1. 在 Finder 中右键点击（或按住 Control 点击）`OpenCodex.app`。
2. 选择**打开**。
3. 在弹出的对话框中再次点击**打开**。

如果对话框没有「打开」按钮，请前往**系统设置 → 隐私与安全性**，找到被拦截的提示并点击
**仍要打开**。

macOS 会记住这个选择，因此每个版本只需操作一次。

也可以在终端移除隔离属性：

```bash
xattr -d com.apple.quarantine /Applications/OpenCodex.app
```

如果两种方式都不想用，可以自行构建——本地构建不会带有隔离属性。参见[从源码构建](#从源码构建)。

## 显示的内容

菜单栏图标用形状而非颜色表示状态，因为 macOS 菜单栏图标按惯例是单色的：

| 图标 | 含义 |
| --- | --- |
| 实心标记 | 运行中，路由受保护 |
| 带缺口的实心标记 | 运行中，但路由保护存在风险 |
| 轮廓标记 | 正在检查，或响应异常 |
| 淡色轮廓 | 未运行，或需要 API 密钥 |

点击图标会打开包含四个部分的面板。

**状态** — 代理是否运行、应用正在使用的回环地址以及保护状态。当代理给出修复命令（例如
`ocx service install`）时，会以可选中的文本显示。应用不会替你执行。

**用量** — 最近 7 天的请求数、令牌数和预估成本，以及每日趋势。请求数后的 `~` 表示其中一部分
是估算值，而非提供商上报的数据。

默认情况下，菜单栏标题显示令牌总数；如果您更想查看请求数、成本、配额，或只显示图标，可在控制台 Usage 的 Companion 设置中更改标题指标。
在 macOS 26 中，弹出面板和小组件采用 Liquid Glass；更早版本的 macOS 使用标准弹出面板材质。

**配额** — 每个提供商一行，显示压力最大的那个窗口。如果某个提供商 5 小时额度用了 99%、月度
额度只用了 10%，会显示 5 小时的数值，因为真正卡住你的是它。窗口名称标注在提供商下方，因此
`API usage 的 42%` 和`一个月的 42%` 不会混淆。

**提供商** — 可展开的列表，每个提供商带一个开关。默认提供商在启用状态下开关是锁定的，因为
代理会拒绝停用默认提供商；请先在仪表板中更换默认值。

## 可以做什么

- **Dashboard** — 在浏览器中打开 Web 仪表板。
- **Stop proxy** — 确认后停止代理。这里刻意不叫「重启」：停止会同时停掉 launchd 服务，代理不会
  自动恢复。停止后面板会显示重新启动的命令。
- **提供商开关** — 启用或停用某个提供商。

账号、模型配置、存储等其余操作仍在仪表板中完成。

## 小组件

在桌面上右键点击，选择**编辑小组件**，然后添加 **OpenCodex**。它显示代理状态、今日用量和
配额，并使用与菜单栏应用相同的隐私安全快照。应用轮询时小组件会刷新。需要 macOS 14 或更高
版本；它不会接收 API 密钥或原始账户信息。

## 连接到代理

应用会自动查找。它读取 `~/.opencodex/runtime-port.json`（或
`$OPENCODEX_HOME/runtime-port.json`），找不到则使用端口 `10100`。该文件只提供端口，主机始终
为回环地址。

如果代理绑定在非回环地址上，就需要 API 密钥。面板会说明这一点并提供前往仪表板的按钮。

**该路径尚未支持。** 应用会从 macOS 钥匙串读取密钥并重试一次，但没有输入密钥的界面，也没有
手动写入的办法——它是数据保护钥匙串条目，「钥匙串访问」无法创建。因此在非回环绑定下，面板会
一直停在「Needs API key」。

默认的回环代理不需要密钥。原生密钥输入已在计划中。

## 轮询

应用刻意保持安静。存活检查每 5 秒一次；开销较大的聚合数据（用量和配额）只在面板打开时获取，
且最多每分钟一次。连续三次失败后会退避到 30 秒一次，以免不断敲打你主动停掉的代理。

## 从源码构建

需要 macOS 13 或更高版本、Xcode Command Line Tools 以及 [Bun](https://bun.sh)：

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun run prepare-sidecar
bun run prepare-widget
bunx tauri build
```

程序包会生成在 Tauri 的发布输出中，WidgetKit 扩展位于
`OpenCodex.app/Contents/PlugIns/`。

构建通用二进制（`UNIVERSAL=1`）需要完整的 Xcode。Command Line Tools 只包含当前架构的 Swift
兼容库，此时构建会给出说明信息，而不是抛出链接器错误。

如果钥匙串中有 Developer ID 证书，可以设置 `MACOS_SIGN_IDENTITY`，以 hardened runtime 签名
替代 ad-hoc 签名：

```bash
MACOS_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" bun run prepare-widget
```

## 卸载

把 `OpenCodex.app` 拖到废纸篓即可。应用不会留下偏好设置或其他状态文件，目前也不会在钥匙串中
保存任何内容。
