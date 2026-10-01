---
title: 平台支持
description: OpenCodex 在 macOS、Windows 和 Linux 上的功能，以及部分能力为何限于特定平台。
---

OpenCodex 可在 macOS、Windows 和 Linux 上运行。绝大部分功能在三个平台上的行为一致；少数能力依赖操作系统提供的机制。本页说明这些差异及其原因。

## 所有平台

| 能力 | 说明 |
| --- | --- |
| 代理、路由、提供商适配器 | 核心运行时不依赖特定平台。 |
| 后台服务 | 三种原生后端：macOS 使用 launchd，Windows 使用任务计划程序**或** WinSW，Linux 使用 systemd 用户单元。 |
| 浏览器登录 | 通过平台自身的处理程序打开。 |
| 客户端检测 | 按平台查找 Cursor、Claude Desktop、Kiro 和 Codex 安装。 |

### 操作系统凭据存储中的提供商密钥

三个平台均支持，但前提是**操作系统提供已解锁的凭据服务**：macOS 使用 Keychain，Windows 使用 Credential Manager，Linux 使用 libsecret。密钥环锁定或无头会话中没有已解锁的服务，因此存储不可用；OpenCodex 会明确说明，不会静默回退。存储规则见[提供商](/zh-cn/reference/configuration/providers/)。

## 仅限 macOS

### Claude Code 自动连接

向会话注入 `ANTHROPIC_BASE_URL` 和 Claude Code 控制变量依赖 launchd 用户域；其他平台没有完全对应的单一机制。

在 Linux 上，三种看似可行的机制各自只覆盖部分进程：`systemctl --user set-environment` 仅影响由 systemd 启动的单元，`~/.profile` 仅影响登录 shell，`~/.bashrc` 仅影响交互式非登录 shell。没有一个位置能覆盖用户的整个会话。

Windows 上对应的是 `HKCU\Environment`，它会真正持久保存，而非仅在本次启动期间有效。问题正在于此：它会把 bearer token 从重启后清空的域移入不会清空的注册表配置单元，改变凭据在磁盘上的保存时间和可读取者。移植这项功能需要先进行安全审查。

Claude Code 所需的其他功能在所有平台上都能使用。你可以自行设置相同变量，或运行 `ocx claude`，将变量直接传给子进程。

## 导入与粘贴

### Meta Muse Code

在 macOS 上，普通登录会先尝试导入 `muse login` 已保存的 API 密钥。
没有本地密钥或使用其他平台时，OpenCodex 会启动设备授权，不会启动 Muse CLI。
添加账户和重新授权会跳过导入。
如果设备授权失败且未取消，并且调用方提供输入界面，用户可以手动输入密钥。
粘贴的密钥会经过与导入密钥相同的格式检查和 Model API 验证。
通过管理界面登录前，必须先有仪表盘会话，然后才能获取凭据或提交代码。

如果账户有 Muse 账户访问令牌，OpenCodex 会用它刷新账户用量。
否则，有可用的响应流订阅用量时会显示该观察值。
刷新不会打开浏览器，也不会替换 Model API 密钥。

## Windows 注意事项

Windows 服务可通过任务计划程序运行，也可作为原生 WinSW 服务运行，两者互斥。`ocx service repair` 如果同时发现两种状态，会拒绝继续；猜测用户意图可能导致两个代理争夺同一端口。

非英语 Windows 安装中的控制台输出使用系统代码页，而不是 UTF-8。OpenCodex 会据此解码，使包含非 ASCII 字符的账户名得到正确解析。

## 功能不可用时

OpenCodex 会说明实际原因，而不是静默禁用控件。如果你的平台上某项能力不可用，错误信息或仪表盘会指出缺少的机制及受支持的替代方式。若遇到没有说明原因的情况，值得报告为缺陷。
