---
title: Codex 无法登录或加载
description: 应用 opencodex 后，Codex 无法登录或所有请求均报错时的处理方法，以及如何在不启动代理的情况下让 Codex 恢复使用自己的账户。
---

如果设置 opencodex 后，Codex 停在登录页面、提示无法加载登录要求，或每次模型请求都失败，最可能的原因是 Codex 仍指向 opencodex 代理，而代理并未运行。该问题见 [#5261](https://github.com/lidge-jun/opencodex/issues/5261)。

## 原因

在默认的回环设置中，opencodex 不会为 Codex 创建独立的提供商。它向 `$CODEX_HOME/config.toml`（Windows 上为 `%USERPROFILE%\.codex`）写入根级覆盖配置，将 Codex 内置的 `openai` 提供商指向代理：

```toml
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
# Auto-injected by opencodex (undo: ocx restore)
openai_base_url = "http://127.0.0.1:10100/v1"
# Auto-injected by opencodex (undo: ocx restore)
experimental_realtime_ws_base_url = "http://127.0.0.1:10100/v1"
```

这些配置行写在磁盘上，因此重启后仍会保留。如果 Codex 启动时代理没有运行，该地址就没有响应，而 Codex 也没有第二个端点可供回退。界面不会提到 opencodex，因此很容易把这种状态误认为 Codex 自身的问题。

代理未运行可能有普通原因。应用 Codex 集成并不会安装后台服务；那是单独的 `ocx service install` 步骤。因此，重启后可能没有任何进程重新启动代理。已注册的 Windows 计划任务在用户登录时而不是系统启动时运行，也可能被禁用、启动失败，或端口被其他进程占用。

## 让 Codex 恢复工作

请选择所需结果。代理停机时，以下两种操作都可以安全执行。

**让 Codex 恢复使用自己的账户和端点：**

```bash
ocx restore
```

此命令会移除注入的路由、实时通信覆盖配置和 opencodex 目录文件指针；无须运行代理、仪表盘会话或网络。之后 Codex 可正常登录和运行。需要重新使用 opencodex 时，`ocx restore back` 会再次将 Codex 指向代理。

**或者重新启动代理：**

```bash
ocx start
ocx service install   # keep it running across restarts
```

`ocx status` 会报告代理是否响应以及 Codex 当前是否经由它路由。`ocx doctor` 会更详细地解释相同状态，并指出建议的修复方法。

## 无法使用 ocx 时

可以手动撤销路由。打开 `$CODEX_HOME/config.toml`，删除三类内容：`openai_base_url` 行、`experimental_realtime_ws_base_url` 行，以及以 `opencodex-catalog.json` 结尾的任何 `model_catalog_json` 行。同时删除前两类配置行正上方的 `# Auto-injected by opencodex` 注释。

请根据键名判断，而不是根据注释。opencodex 也会在它管理的其他键（如注入的 `developer_instructions`）上方使用相同的所有权注释；删除那些键不会帮助登录，反而可能丢失你希望保留的配置。

删除 `model_catalog_json` 时要**连同**路由一起删除，不能只删除路由。若 `model_catalog_json` 指向已不存在的文件，Codex 会完全无法加载配置，看起来像是另一种原因造成的相同锁定问题。

## 无法添加或显示账户

无法向账户池添加账户，或已添加的账户没有出现，与上述锁定问题不同，即使它们发生在同一会话中也是如此。账户池由代理的管理 API 提供，所以 `ocx account login openai` 流程和仪表盘列表首先都需要运行中的代理。浏览器登录还会返回到固定地址 `http://localhost:1455/auth/callback`，不能更换端口。如果端口 1455 被占用，或无法启动浏览器，请改用设备流程：

```bash
ocx account login openai --device
```

有关注入的配置及路由选择方式，请参阅 [Codex 集成](/zh-cn/guides/codex-integration/)。
