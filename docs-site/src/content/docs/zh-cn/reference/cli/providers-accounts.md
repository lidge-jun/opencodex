---
title: CLI 提供方、账号与模型
description: 提供方配置、凭据、配额，以及模型目录命令。
---

这些命令用于配置上游提供方、认证账号、管理凭据池，并控制暴露给 Codex 的模型目录。

## 提供方

### `ocx provider <subcommand>`

非交互式提供方管理。注册表条目按名称预置；自定义名称必须同时提供
`--adapter` 和 `--base-url`。

| 子命令 | 支持的标志 | 操作 |
| --- | --- | --- |
| `list` | `--json` | 列出已配置的提供方以及剩余的注册表条目。 |
| `add <name>` | `--adapter <adapter>`, `--base-url <url>`, `--api-key <key>`, `--default-model <model>`, `--set-default`, `--force`, `--json`, `--sync` | 添加一个注册表/自定义提供方。`--force` 会覆盖；`--sync` 会在有人类输出模式运行的代理上刷新配置。 |
| `edit <name>` | 提供方字段标志，`--headers <json>`，`--json` | 在不替换密钥池的情况下，编辑经过校验的在线提供方字段。`--headers` 会合并自定义请求头；传入 `{}` 或 `-` 可清空。 |
| `test <name>` | `--json` | 探测真实的上游模型端点。 |
| `show <name>` | `--json` | 显示已屏蔽 API 密钥的配置。 |
| `remove <name>` | `--json` | 移除一个非默认提供方；最后一个提供方不能被移除。 |
| `set-default <name>` | `--json` | 将现有提供方设为默认提供方。 |
| `selected <name>` | `--set <ids>`, `--clear`, `--json` | 读取或更新提供方模型允许列表。 |
| `quota` | `--refresh`, `--json` | 读取提供方配额报告。 |
| `presets` | `--json` | 列出仪表盘提供方预设。 |
| `account-mode` | `pool`, `direct`, `--json` | 选择 Codex 账号的池化或直连路由。 |

```bash
ocx provider list --json
ocx provider test ark
ocx provider add anthropic --api-key sk-ant-... --set-default --sync
ocx provider add local-dev --adapter openai-chat --base-url http://localhost:11434/v1
ocx provider show anthropic --json
ocx models --provider anthropic --json
ocx models live --provider ark --json
```

:::caution[自定义请求头不是凭据通道]
`--headers` 用于非机密的请求元数据 —— 路由提示、租户或项目选择器、追踪 ID 等。它不是
存放认证信息的地方，校验器会拒绝标准凭据请求头名称（`Authorization`、`X-Api-Key`、
`Cookie` 等），并提示改用 `apiKey` / `authMode`。

但校验器无法识别 `X-My-Token` 这类任意名称，因此这条边界需要你自己遵守。原因有两点：

- 该 JSON 是命令行参数，机密会留在 shell 历史和进程列表中；在 CLI 做任何脱敏之前，
  同一台机器上的其他进程就能读到。
- 请求头的值以明文保存在 `config.json` 中，这与拥有独立存储和脱敏路径的 API 密钥不同。

任何机密内容请使用 `--api-key` 或 OAuth 登录。
:::

## 认证

### `ocx login <provider>`

启动该提供方已注册的登录流程。OAuth 提供方会打开浏览器，并将自动刷新的
凭据存储在 `~/.opencodex/` 下；API 密钥登录提供方会打开其密钥控制台，提示输入
密钥，在可行时进行校验，并保存生成的提供方配置。当名称缺失或未知时，命令会
打印当前可接受的 OAuth 和 API 密钥提供方 id。

在 `ocx status` / `ocx doctor` 报告需要重新认证或终端刷新失败后，也可用同一条
命令执行**重新认证**（或者在仪表盘中使用 Reauthenticate）。Codex 池账号不是一个
公开的 `ocx login` 提供方 - 请通过仪表盘里的 Codex 账号池（Reauthenticate）或
无头模式的 `ocx account reauth` 流程重新认证。

```bash
ocx login xai
ocx login anthropic
```

### `ocx logout <provider>`

移除某个提供方已存储的 OAuth 凭据。

## 账号与密钥池

### `ocx account <subcommand>`

通过正在运行的代理列出并切换提供方账号和 API 密钥池。随附的帮助输出如下：

```text
Usage: ocx account <list|current|use|refresh|auto-switch|priority|login|reauth|code|cancel|remove|add-key|reset-credits> ...

list [provider]     Codex account pool, OAuth accounts and API keys (identifiers shown masked as the API returns them).
current <provider>  Show the active account or key.
use <provider> <id> Switch the active credential; 'main' selects the Codex App login.
refresh <provider>  Force-refresh Codex or provider quota reports.
auto-switch <provider> <on|off|status|threshold N>  Control the Codex pool threshold.
priority <provider> <id|main> [first|earlier|normal|later|last|-100..100|reset]  Selection order; omit the value to read it.
remove <provider> <id> --yes  Remove a stored account or key after an existence check.
add-key <provider> [--label <label>]  Add a key read only from piped stdin.
login/reauth/code/cancel  Run browser or manual-code auth from a headless shell.
reset-credits <id|main> [--consume --yes]  Inspect or consume Codex reset credits.
Codex pool selection applies to the next request after clearing existing affinity; in-flight requests keep their captured account.
```

所有子命令都要求代理正在运行；CLI 会自动解析其记录的运行时端口。成功操作的
退出码为 0。无效用法、未知的提供方或账号/密钥 id、无法访问的代理，或 API 失败
都会以 1 退出。凭据字段会严格按管理 API 返回的样子显示（包括其屏蔽格式）；
原始 API 密钥和 OAuth token 永远不会返回。显示上的便利字段都像仪表盘一样在
客户端侧合成：`main` 是 `openai` 账号池中 Codex App 登录的 CLI 别名，没有邮箱的
OAuth 账号会显示为 `Account N`，而 plan/label 列会在 plan、屏蔽后的邮箱、label 和
屏蔽后的密钥之间回退。

`--json` 账号行使用以下通用结构（不可用时会省略可选字段）：

```json
{
  "provider": "openai",
  "type": "codex | oauth | api-key",
  "id": "__main__",
  "label": "plus",
  "email": "m***@example.com",
  "plan": "plus",
  "priority": 0,
  "masked": "sk-ab****wxyz",
  "active": true,
  "needsReauth": false,
  "quota": null
}
```

### `ocx account list [provider] [--json] [--all]`

不指定提供方时，会列出 Codex 池、OAuth 账号和已配置的 API 密钥池。除非提供
`--all`，否则会跳过空的提供方。指定提供方时，只列出该凭据家族。人类可读输出
使用 `PROVIDER TYPE ID PLAN/LABEL PRIORITY STATUS`；手动选中的 Codex 行会标记为 `selected`。
当存在已存储的 Kiro 账号时，输出会提示 Kiro 只有一个登录槽位，并且再次登录会
替换当前账号。空结果仍然算成功。`--json` 返回：

```text
{ accounts: AccountRow[], notes: string[] }
```

### `ocx account current <provider> [--json]`

显示当前活动账号或密钥。没有手动固定的 Codex 池会报告自动选择最低使用量的结果；
没有活动凭据的其他家族会报告该状态，但仍然以 0 退出。`--json` 返回：

```text
{ provider, type, activeId: string | null, autoSwitchThreshold?: number, account: AccountRow | null }
```

### `ocx account use <provider> <account-or-key-id|main> [--json]`

选择已有的 Codex 账号、OAuth 账号或 API key。对 `openai` 而言，`main` 选择 Codex App 登录。
Codex Pool 选择会清除进程本地 affinity，并从下一次请求开始生效，包括已有可见任务的请求；代理重启或 affinity eviction 后，任务也可能变为未绑定，但进行中的请求保留已捕获账号。此选择只控制 Pool routing；Direct mode 继续使用 caller-owned/native main credential。基于用量的主动切换、401/403 重新认证、429/retry-after cooldown、排除，以及输出前 429/402 故障恢复之后仍可能选择其他合格 Pool 账号。这些恢复路径在关闭基于用量的切换时仍然有效。账号变化后 OpenCodex 会重放对话上下文，但 provider prompt cache 可能需要重新预热。未知 provider 或 id 返回退出码 1。`--json` 返回：
遇到 **401/403** 时，App 登录会清除该账户的进程内 affinity 并要求重新认证。
遇到 **429** 时，它会遵循 `Retry-After`、启动账户 cooldown、清除 affinity，
并可将请求切换到另一个符合条件的 Pool 账户。即使 `autoSwitchThreshold: 0`，
这些故障恢复流程仍然有效；`0` 只会禁用基于用量的主动切换。

```text
{ ok: true, provider, type, activeId }
```

### `ocx account refresh <provider> [--json]`

对于 Codex 池，请使用 `ocx account refresh openai [--json]`。它会强制刷新账号配额，
并打印可用的周/月百分比和重置时间；缺失的配额数据会报告为未知，而不是 0%。其
JSON 外壳是 `{ accounts: AccountRow[] }`，每个 Codex 行上都会带有 `quota`。

对于 OAuth 和 API 密钥提供方，这会强制刷新提供方的配额报告端点；它不是重新登录
token，也不是简单重读账号列表。`--json` 返回
`{ provider, report: ProviderQuotaReport | null }`。不支持配额报告的提供方会打印
`no quota report available for <provider>` 并以 0 退出。未知提供方和管理 API 失败
会以 1 退出；上游配额探测如果失败或超时，则会降级为 `null` 或陈旧报告（以 0 退出），
与仪表盘的配额条保持一致。

### `ocx account auto-switch <provider> <on|off|status|threshold <0-100>> [--json]`

只控制 `openai` 的 Codex 账号池。`on` 会设为 80%，`off` 会设为 0%，`status` 会读取
当前值，而 `threshold <n>` 接受 0 到 100 之间的整数。其他提供方和无效值都会以 1
退出。`--json` 返回：

```text
{ provider, autoSwitchThreshold: number, enabled: boolean }
```

### `ocx account priority <provider> <account-id|main> [<-100..100|first|earlier|normal|later|last|reset>] [--json]`

读取或设置某个 Codex pool 账号的选择顺序：**数值越大越先使用**，默认值为 `0`，范围是 `-100` 到
`100`。只有 `openai` 的 Codex pool 有选择顺序，其他 provider 返回退出码 1。`main` 指向 Codex Desktop
登录账号，它与其他 pool 账号一样参与排序：`ocx account priority openai main last` 就能把它留作备用。

预设词只是小整数的别名：`first` 为 `+2`，`earlier` 为 `+1`，`normal` 为 `0`，`later` 为 `-1`，
`last` 为 `-2`。`reset` 恢复默认值并删除已保存的条目。**省略取值即为读取**，不会改写当前顺序。

顺序决定的是先考虑哪些账号，而不是哪些账号可用：选择仍然只在合格账号中进行，取仍有 quota 余量的
最高 tier，再由 `accountPoolStrategy` 在该 tier 内挑选。暂停、cooldown 和重新认证都不受影响。改动
从**下一个未绑定请求**起生效，而不仅限于新开的 session：一旦更高顺序重新有了余量，preemption 会立即把
未绑定请求提上去。已绑定账号的 thread 通常会保留该账号直到其用尽，但重新认证失败、quota cooldown 或连续的临时失败都会更早解除绑定。任何被接受的写入也会解除手动的“立即使用此账号”固定，无论固定在哪个账号上；写入与当前相同的顺序同样会解除，这是在保留当前所选账号的前提下解除固定的唯一方式（通过管理 API 清空活动账号同样会解除固定，但所选账号也一并丢失）。代理不可达、账号 id 不存在或取值不在
允许范围内都会返回退出码 1。`--json` 返回：

```text
{ ok: true, provider, id, priority: number, preset: string | null }
```


### `ocx account login|reauth|code|cancel ...`

在无头 shell 中运行基于浏览器或手动代码的账号认证。请使用
`ocx account --help` 查看与提供方相关的命令形式。如果 Codex 账号登录已保存但模型目录刷新
仍待完成，人类可读输出仍会成功退出，并在 stderr 打印固定的 `ocx sync` 恢复指引。使用
`--json` 时 stdout 保持可解析，已完成的登录状态会包含 `catalogRefreshPending: true`，且不会
打印人类可读警告。

### `ocx account remove <provider> <id|main> --yes [--json]`

这个受保护的非交互式删除需要 `--yes`。删除前，它会验证 id 是否存在；缺失的 id
会以 1 退出，而不会发送 DELETE。主 Codex App 登录不能被移除，因此会拒绝
`remove openai main --yes`。删除后会重新读取该家族：移除已固定的 Codex 账号会清除
固定并回到自动选择；OAuth 会提升第一个剩余账号，或者报告不存在；API 密钥池会
提升第一个剩余密钥，或者报告不存在。`--json` 的成功和失败结构如下：

```text
{ ok: true, provider, id, removedActive: boolean, promotedActiveId: string | null, catalogRefreshPending?: boolean }
{ error: string } // stderr, exit 1
```

`catalogRefreshPending` 只出现在 Codex 删除结果中。值为 `true` 时，账号删除已经保存；人类可读
输出会在 stderr 打印通用的 `ocx sync` 恢复指引，并仍以 0 退出。OAuth 账号和 API 密钥删除的
响应结构不会增加此字段。

### `ocx account add-key <provider> [--label <label>] [--json]`

为 API 密钥提供方添加并激活一个密钥。该密钥只会从非 TTY 的管道/重定向 stdin
读取；交互式 TTY 输入、空输入、OAuth/Codex 提供方，以及 API 失败都会以 1 退出。
密钥永远不会回显，即使它出现在 label 里也是如此。建议使用秘密管理器或 here-string：

```bash
ocx account add-key openrouter --label personal <<< "$OPENROUTER_API_KEY"
security find-generic-password -w openrouter | ocx account add-key openrouter --json
```

`--json` 返回 `{ ok: true, id: string | null, label?: string }`，并且绝不会包含该密钥。

### `ocx account reset-credits <id|main> [--consume --yes]`

查看某个账号的 Codex 重置额度。消耗额度会造成破坏性影响，因此同时需要 `--consume`
和 `--yes`。

### `ocx account main <subcommand>`

管理命名的原生 Codex 主登录配置文件，而不更改 OpenCodex 账号池路由。

```text
ocx account main doctor [--json]
ocx account main list [--json]
ocx account main register <label> [--json]
ocx account main add <label>
ocx account main switch <profile-id-or-label> --yes [--json]
ocx account main recover [--rollback --yes] [--json]
```

每个变更命令都会显示运行中代理返回的规范化有效 `CODEX_HOME`。该路径可能与调用进程的
`CODEX_HOME` 不同；支持 JSON 的命令会在 `effectiveCodexHome` 中返回相同的值。

版本 1 支持基于文件的 Codex 身份验证，使用 AES-256-GCM 加密保存的配置文件，并将加密密钥保存在操作系统凭据存储中。`add` 会先在受限暂存环境中启动官方 Codex 登录，再导入生成的凭据。切换配置文件前请关闭 Codex。切换成功后会保留本地任务和历史记录，但继续使用前必须重启 Codex。使用 `doctor` 检查配置文件状态，使用 `recover` 完成或回滚中断的切换。`switch` 可接受配置文件 ID 或标签。

v1 恢复矩阵覆盖的是事务文件通过重命名发布后 OpenCodex 进程退出的情况。它不声明能够在操作系统或内核崩溃、突然断电后持久保存：`atomicWriteFileAsync()` 不会对文件或父目录执行 `fsync`。

加密保管库、切换日志、恢复标记和日志隔离文件位于规范的 `<real CODEX_HOME>/.opencodex-native-main-profiles` 目录中。因此，共用该 Codex 主目录的所有 OpenCodex 实例都会看到同一个所有者和同一份恢复状态。明文登录暂存数据仍分别隔离在各自的 `<OPENCODEX_HOME>/native-main-profile-staging` 目录下。

在允许 native-main 流量或日志恢复之前，生命周期所有者会取得凭据的独占占用权，并且只删除名称与 `auth.json.ocx.<pid>.<sequence>.tmp` 完全匹配的崩溃残留文件。每个候选文件在整个过程中都必须位于未发生变化的规范 `CODEX_HOME` 下，并保持为硬链接计数为 1 的普通文件；系统会先将其截断，再刷新其内容，最后取消链接（unlink）。若发生链接或重解析点替换、文件标识发生变化或存在其他歧义，native-main 流量将继续保持关闭；名称仅近似匹配的文件绝不会被自动删除。这项防护针对正常协作的 OpenCodex 发生崩溃的情况，并不能抵御已经以同一操作系统用户身份运行的恶意进程。该用户以及承载 `CODEX_HOME` 的文件系统仍属于信任范围；截断文件也不保证从写时复制存储、快照或 SSD 残留数据中实现物理擦除。

预览版使用 `<OPENCODEX_HOME>/native-main-profiles`。该布局绝不会被静默导入。如果 `doctor` 报告旧版配置文件状态，请停止所有共用同一 `CODEX_HOME` 的 OpenCodex 代理。然后，请先备份，并在保留仅所有者可访问权限的情况下，将相应的 `*.vault.json`、`*.journal.json`、恢复标记以及任何被引用的日志隔离文件一起移动到规范目录中；或者删除旧的预览版文件集，再次运行 `ocx account main register`。只要仍有任何共用该 `CODEX_HOME` 的代理正在运行，就不要在多个旧根目录之间选择其一，也不要同时使用两种布局。在 Windows 上，按以前不区分大小写的主目录标识索引的预览状态必须重置，而不能直接移动，因为其加密 AAD 和操作系统密钥环标识被有意设计为不再复用。

## 模型

### `ocx models [subcommand]` · `ocx model <subcommand>`

`ocx model` 是 `ocx models` 的别名。没有子命令时，列出已配置提供方中静态预置的模型。
`--provider` 可过滤单个已配置提供方，而 `--json` 会返回模型元数据。`live` 读取运行中
的目录；`add`、`edit`、`remove` 和 `list-custom` 管理手动目录条目；`enable`、
`disable` 和 `provider` 控制可见性；`selected` 控制提供方允许列表；`context` 控制提供方
上下文上限；`shadow` 管理后台 shadow-call 拦截。

这里提供仪表盘中所有逐模型操作，因此无头安装永远不需要 GUI 来管理目录。`add`、
`remove` 和 `list-custom` 针对配置文件工作，并通过目录同步应用到正在运行的代理；
其余命令会与在线管理 API 通信，并要求代理正在运行（`ocx start`，或已安装的服务）。

| 子命令 | 支持的标志 | 操作 |
| --- | --- | --- |
| `list` (默认) | `--provider <name>`, `--json` | 列出已配置提供方中预置的模型。 |
| `live` | `--provider <name>`, `--json` | 读取运行中的目录，包括运行时发现的模型。各行会标记为 `native`/`routed`、`custom`，以及 `enabled`/`disabled`。 |
| `add <provider> <modelId>` | `--display-name <name>`, `--context-window <tokens>`, `--modalities <text,image,audio>` | 注册一个提供方目录未公布的模型。 |
| `edit <custom-id>` | `--model-id <id>`, `--display-name <name\|->`, `--context-window <tokens\|0>`, `--modalities <text,image,audio\|->`, `--json` | 编辑自定义模型。`-` 会清空字段；`0` 会清空上下文窗口。 |
| `remove <custom-id\|provider/modelId>` | `--yes` | 删除一个自定义模型。当 stdin 不是交互式终端时，必须提供 `--yes`。 |
| `list-custom` | `--json` | 显示所有自定义模型，以及其他子命令所使用的 `custom-id`。 |
| `enable <provider/model\|native-model>` | `--native`, `--json` | 让一个模型对 Codex 可见。 |
| `disable <provider/model\|native-model>` | `--native`, `--json` | 对 Codex 隐藏一个模型。 |
| `provider <name> <on\|off>` | `--json` | 一次写入中启用或禁用某个提供方的全部模型。 |
| `selected <provider>` | `--set <id,id...>`, `--clear`, `--json` | 读取或替换提供方模型允许列表。`--clear` 会移除允许列表，使所有模型都可提供。 |
| `context <status\|value <tokens> [--set-all]\|provider <name> on [--value <tokens>]\|provider <name> off\|all <on\|off>>` | `--json` | 读取或设置上下文窗口上限，可全局设置或按提供方设置。`value <tokens> --set-all` 还会把值重新应用到所有已路由提供方（等同于仪表板开关）；不加它则只改变默认值。`provider ... on --value <tokens>` 仅为该提供方设置独立上限（`--value` 仅可用于 `on`）。 |
| `shadow <status\|set> [model\|-]` | `--enabled <on\|off>`, `--json` | 读取或设置 Codex 后台辅助调用所替换的模型。`-` 会清除该模型。`status` 还会报告 `sourceModels`，即代理拦截的辅助器 slug（默认值：`gpt-5.6-luna`；0.144.x 及更早客户端使用的 `gpt-5.4-mini` 可通过显式 `sourceModels` 覆盖恢复）。 |

```bash
ocx models live --json                                  # what Codex can actually see right now
ocx models disable anthropic/claude-haiku-4             # hide one routed model
ocx models enable gpt-5.6-sol                           # no slash, so it is treated as native
ocx models provider zenmux off                          # hide a noisy provider wholesale
ocx models selected anthropic --set claude-opus-5,claude-fable-5
ocx models selected anthropic --clear                   # drop the allowlist again
ocx models add deepseek deepseek-v4 --display-name 'DeepSeek V4' --context-window 128000 --modalities text,image
ocx models list-custom --json                           # read the custom-id for edit/remove
ocx models remove deepseek/deepseek-v4 --yes
```

带斜杠的模型选择器会按 routed 处理（`anthropic/claude-opus-5`）；裸 id 会被视为
native 的 OpenAI 模型，因此只有当某个 id 本来会被看成 routed 时，才需要 `--native`
来强制按这种方式解释。

`--modalities` 只接受 `text`、`image` 和 `audio`。Codex 会把该字段解析为封闭枚举，
并拒绝任何包含其他值的完整目录，因此 `add`、`edit` 和管理 API 都会直接拒绝这个
错误值，而不会存下一个目录写入器之后还得再剥离的内容（#759）。
