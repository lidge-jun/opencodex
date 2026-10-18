---
title: CLI 参考
description: 命令分发、退出码，以及指向每个 ocx 命令族的链接。
---

opencodex 的 CLI 是 `ocx`。它会根据第一个命令名进行分发；文档中列出的别名，例如 `setup`/`init`、`restore`/`eject` 以及 `models`/`model`，都会到达同一操作。未知命令和无效的命令形状都视为错误。

运行 `ocx help`（或 `ocx --help` / `ocx -h`）查看顶层用法。运行 `ocx help <command>`、`ocx <command> --help` 或 `ocx <command> -h`，可查看在帮助表中注册的命令。帮助和版本命令都是只读的：它们不会启动、停止、安装、卸载或改写 Codex 或 opencodex 状态。

## 命令族

- [生命周期](/reference/cli/lifecycle/) —— 设置、代理和服务生命周期、健康检查、诊断、目录同步、仪表盘和更新。
- [提供商、账号与模型](/reference/cli/providers-accounts/) —— 提供商配置、认证、凭据池、配额、自定义模型、可见性、已选模型和上下文上限。
- [代理、路由与集成](/zh-cn/reference/cli/agents/) —— 多代理控制、组合、可观测性、准入密钥、客户端集成、运行时设置、已验证配置，以及只读的 Codex CLI 更新检查。

## 无头行为

管理命令会通过实时代理的管理 API 往返调用，使用记录下来的运行时端口和身份检查，而不是维护第二条配置路径。已停止或不可达的代理会被表示为 HTTP 503，并导致 CLI 以非零状态退出。明确标注为离线配置操作的命令，则可以在没有实时代理的情况下验证并编辑配置文件。

`check` 不查询注册表，也不运行 Codex。在 POSIX 上，当已发布启动器捕获的环境候选项与运行时解析器选择的规范路径一致时，`selectionAttested` 可以为 `true`；如果关联的 npm-global 软件包清单证明了所有权，`managed` 可以为 `true`。持久化候选项仍不获认证。Windows 不读取候选项或配置文件，而是推迟检查。直接通过 Bun 或源码运行时没有启动器证明。`plan` 使用隔离的临时 npm 配置、缓存和日志查询官方注册表，并拒绝活动会话或不完整的进程观测。它不安装软件，也不向进程发送信号。请参阅[完整命令和拒绝原因（英文）](/reference/cli/agents/#read-only-codex-cli-update-plan)。

有关 Windows x64 安装观察，请参阅 [`attest` 命令](/zh-cn/reference/cli/agents/)。未提供显式路径时，该命令观察由受证明约束的启动器快照识别出的已选候选项；它不授予更新权限，也不证明运行时选择。

在语义明确时，默认操作是 `list` 或 `status`。使用 `--json` 获取结构化快照，使用 `ocx observe logs --follow --jsonl` 获取流式请求日志。主题、语言、导航以及其他纯视觉浏览器状态都没有 CLI 对应项；Cloudflare Tunnel 的设置不在这组命令之内。

## 存活探测上限覆盖

`ocx health`、`ocx status`、`ocx account *`、`ocx login codex` 和 `ocx ready` 通过短时存活探测查找正在运行的代理：默认每次 750 ms，停止和启动判断使用带重试的 1500 ms。如果安全层（内容过滤器或 EDR 类网络扩展）给每个回环连接增加固定延迟，健康的代理可能来不及响应就已超时。

在这类主机上可设置 `OCX_PROBE_TIMEOUT_MS` 提高上限，例如 `OCX_PROBE_TIMEOUT_MS=5000 ocx status`。取值为 1 到 30000 的整数毫秒。覆盖只会提高上限：750 ms 默认值和 1500 ms 停止/启动预算保留下限，因此 `1000` 只会延长默认探测。未设置、空值、小数、负数、0 或更大的值都会被忽略。

## 退出码与确认

成功的命令退出码为 0。无效用法、未知命令或资源、API 操作失败，以及必需服务不可用时，退出码都非零。`ocx health` 只有在代理健康时才以 0 退出，找不到健康的代理时以 1 退出，参数无效时以 2 退出，因此可作为服务探针。脚本应检查退出码，而不是解析人类可读输出。

声明需要确认的破坏性删除、导入、额度消耗和更新操作，在非交互用法中都要求 `--yes`。该标志是显式选择加入；省略它时，绝不能在静默情况下确认该操作。

## 版本与内部分发目标

`ocx --version`、`ocx -v` 和 `ocx version` 会打印一行适合脚本读取的版本信息并退出。

有两个分发目标会刻意不出现在普通帮助中：`__refresh-version [preview]` 会在分离进程中刷新更新通知缓存，而 `__gui-update-worker <job-id> [latest|preview] [restart]` 会运行一个仪表盘更新任务。它们是实现细节，不是稳定的面向用户命令。仪表盘会记录 worker PID，恢复 worker 已死亡但仍处于活动状态的任务，把更早的、没有 PID 的活动记录在十分钟后视为过期，并保护存活的 worker 不受并发更新影响。

`ocx logs --model` 同时接受显示的 `provider/model` 和裸模型 ID。过滤在行数限制之前进行，`--follow` 使用同一过滤器。空匹配仅在人类可读输出中提示，JSON/JSONL 保持不变。`ocx hub disable` 参见 [Remote Hub](/guides/remote-hub/#return-a-hub-to-standalone)。
