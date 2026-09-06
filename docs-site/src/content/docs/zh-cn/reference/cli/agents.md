---
title: CLI 代理、路由与集成
description: 多代理、combo、可观测性、访问、集成、系统和配置命令。
---

这些命令用于控制代理策略和路由，检查实时代理，并将受支持的客户端连接到 opencodex。

## Agent policy

### `ocx agent <status|injection|effort|subagents|fallback|sidecar> ...`

管理无头多代理列表、effort 上限、提示注入、回退和 sidecar 设置。使用 `status` 查看当前策略。有关 surface 模式、委派、effort 和回退行为如何协同工作，请参见 [子代理 surface](/guides/sub-agent-surface/)。

```bash
ocx agent subagents set ark/model-a,openai/gpt-5.5
```

### `ocx v2 <status|on|off|mode <v1|default|v2>|threads <n>>`

管理 Codex 的 `multi_agent_v2` 功能标志和三态多代理 surface 模式。

| 子命令 | 动作 |
| --- | --- |
| `status`（默认） | 报告当前的 v2 标志、多代理模式和线程并发数。 |
| `on` | 启用 `multi_agent_v2` 功能并重新同步目录。 |
| `off` | 禁用 `multi_agent_v2` 功能并重新同步目录。 |
| `mode v1` | 强制所有模型使用 v1，禁用原生 v2，并保留当前线程上限。 |
| `mode default` | 遵循上游模型的 surface 固定配置。 |
| `mode v2` | 强制所有模型使用 v2，启用原生 v2，并保留当前线程上限。 |
| `threads <n>` | 将当前 v1/v2 线程上限设为一个至少为 1 的整数。 |

```bash
ocx v2 status
ocx v2 mode v1
ocx v2 mode default
ocx v2 on
ocx v2 threads 16
```

`mode` 子命令会将 `multiAgentMode` 写入 opencodex 配置，并重新同步 Codex 目录。模式和标志的切换会在有效的 v1/v2 Codex 键之间迁移当前的数值线程上限；如果切换失败，会恢复原始的 `config.toml`。更改只会应用于新的 Codex 会话，正在运行的会话会保持其已固定的 surface。

## Combo routing

### `ocx combo <list|show|set|remove> ...` · `ocx route combo ...`

管理 combo 的故障转移和轮询虚拟模型。`ocx route combo` 是层级别名；combo 目前是受支持的路由资源。目标使用 `provider/model[:weight],provider/model[:weight]`。

```bash
ocx combo list
ocx route combo set reliable --targets ark/model-a:2,openai/gpt-5.5
```

`set` 支持 `--strategy`、`--sticky`、`--effort`、`--alias`、`--rename-from`、`--native-alias`
以及 `--display-name <label|->`（`-` 会清除标签）。native alias 只会接管一个当前受支持且
不带限定前缀的 OpenAI 裸 model id。裸 `gpt-5.6-*` native alias 使用 Codex Pool/Direct 凭据；
带账号限定的 OpenAI 路由仍保持独立，而 `openai-apikey/gpt-5.6-*` 这类提供方限定路由使用其配置的
API key，且绝不会回退到 native alias。启用这组兼容选项前，请先阅读 Combos 指南中的安全和可见性契约。

有关路由行为和配置指导，请参见 [Combos](/guides/combos/)。

## Observability and debug

### `ocx observe <logs|usage|storage|memory|debug|claude-inbound|injection> ...`

检查代理请求、用量、存储、内存和调试数据。直接别名如下：

| 别名 | 对应资源 |
| --- | --- |
| `ocx logs [filters] [--follow] [--json|--jsonl]` | `ocx observe logs` |
| `ocx usage [--range <today|1d|7d|30d|all>] [--surface <all|codex|claude|grok>] [--provider <name>] [--model <id>] [--json]` | `ocx observe usage` |
| `ocx storage [--json]` | `ocx observe storage` |
| `ocx memory [--json]` | `ocx observe memory` |

```bash
ocx observe usage --range 30d --json
```

### `ocx debug <provider|usage|injection|claude> <on|off|status|reset|logs [-f]>`

通过正在运行的代理的管理 API 读取或更改运行时调试覆盖项。

```bash
ocx debug provider on|off|status|reset
ocx debug provider logs [-f|--follow]
ocx debug usage on|off|status|reset
ocx debug usage logs [-f|--follow]
```

没有指定作用域时，`ocx debug` 会输出用法；如果代理已停止，还会输出下次启动时的环境默认值。提供方调试默认来自 `OCX_DEBUG=1`（旧版 `OCX_DEBUG_FRAMES=1` 也可用）；用量调试默认来自 `OPENCODEX_USAGE_DEBUG=1`。

## API access

### `ocx access <key|endpoints|models|test> ...`

管理 OpenCodex 准入 API 密钥，并检查外部端点和模型。`ocx api-key
<list|create|remove> ...` 是 `ocx access key` 的别名。

```bash
ocx access key create deployment
```

## Client integrations

### `ocx integration <claude|grok> ...`

管理受支持的 Claude 和 Grok 集成。下面的直接命令族会暴露各自客户端专属的控制项。

### `ocx claude [claude args...]`

确保代理正在运行，然后使用 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` 以及来自 `config.claudeCode` 的模型槽位启动 Claude Code。对于 Claude Code 2.1.129 或更新版本，路由后的模型会通过稳定的槽位别名出现在原生 `/model` 选择器中。在较旧版本中，请使用 `ANTHROPIC_MODEL` 或 `/model <id>` 选择。用户自行导出的 `ANTHROPIC_*` 变量始终优先生效。

Claude Desktop 配置档案命令如下：

```text
ocx claude desktop [apply]                         Save and apply the four-family profile
ocx claude desktop show [--json]                   Show routes, families, and defaults
ocx claude desktop move <route> <family> [--default]
ocx claude desktop default <family> <route|none>
ocx claude desktop export <path|->                 Export versioned JSON (`-` = stdout)
ocx claude desktop import <path> [--apply]         Validate and import JSON
```

这些 family 是 `opus`、`fable`、`sonnet` 和 `haiku`；新路由默认进入 `opus`。只有在该 family 为空时，`none` 才有效。旧版 apply 标志 `--static`、`--hybrid` 和 `--discovery-only` 仍受支持。Claude Code 设置请使用 `ocx claude config <status|set> ...`。

### `ocx opencode [opencode args...]`

确保代理正在运行，然后在 OpenCode 的内联运行时层（`OPENCODE_CONFIG_CONTENT`）中启动 opencode，并注入生成的 `provider.opencodex` 和 `providers.opencodex` 块。现有的内联配置会被保留，仅本次启动会替换这两个键。可能会读取全局或项目级 `opencode.json` 文件以警告已有覆盖，但不会修改磁盘上的文件。路由后的模型会显示为 `opencodex/<provider>/<model>`。稍后再次启动普通 `opencode` 时，行为与之前完全一致。

### `ocx grok <status|exclude|include|set|clear|apply> ...`

管理并应用 Grok Build 模型边界。

## Client config export

### `ocx export --client <opencode|pi|omp|hermes|openclaw|kimi|gajae|dsh|mcode|zcode|prime|aside|raycast>`

输出连接到正在运行代理的客户端配置。此命令会以所选客户端的原生格式序列化 `opencodex` provider 块，其中包含基础 URL、模型列表，以及该客户端适用的凭据引用或 `opencodex-loopback` 占位值。

代理必须正在运行；该命令会解析其当前端口，读取 `/api/models`，并且只输出 Codex 当前可见的模型。

| 标志 | 动作 |
| --- | --- |
| `--client <opencode\|pi\|omp\|hermes\|openclaw\|kimi\|gajae\|dsh\|mcode\|zcode\|prime\|aside\|raycast>` | 必需。选择客户端配置格式。 |
| `--json` | 仅在 stdout 打印配置 JSON，这样重定向即可捕获字节级精确输出。包括 `--out` 写入提示在内的所有诊断信息都会输出到 stderr。 |
| `--out <path>` | 将配置写入 `<path>`。拒绝替换已存在的文件。 |
| `--force` | 允许 `--out` 替换已存在的文件。 |

```bash
ocx export --client opencode                     # config plus destination, merge warning, and counts
ocx export --client pi --json > pi-models.json   # JSON document for a pipe or a diff
ocx export --client omp --out ./omp-models.yml    # native OMP YAML
ocx export --client opencode --out ~/opencodex-opencode.json
```

不使用 `--json` 时，会先输出所选客户端原生格式的生成配置，随后是规范目标路径、合并警告、客户端专属的启动前提示，以及一个模型计数，并标明有多少行省略了上下文限制（客户端会对这些项应用自己的默认值）。

| 客户端 | 规范目标路径 | 下载文件名 | 环境变量 |
| --- | --- | --- | --- |
| `opencode` | `~/.config/opencode/opencode.json`（设置了 `XDG_CONFIG_HOME` 时以其为准） | `opencode.json` | `OPENCODEX_OPENCODE_API_KEY` |
| `pi` | `~/.pi/agent/models.json` (设置后 `PI_CODING_AGENT_DIR` 优先；相对路径会被拒绝) | `pi-models.json` | 无 - 块中携带字面值 `opencodex-loopback` |
| `omp` | `~/.omp/agent/models.yml`（默认路径；即使为空，`OMP_PROFILE` 也优先于 `PI_PROFILE`） | `omp-models.yaml` | 无 - 字面值 `opencodex-loopback` |
| `hermes` | `~/.hermes/config.yaml` | `hermes-config.yaml` | `OPENCODEX_HERMES_API_KEY` |
| `openclaw` | `~/.openclaw/openclaw.json` | `openclaw.json5` | `OPENCODEX_OPENCLAW_API_KEY` |
| `kimi` | `~/.kimi-code/config.toml` | `kimi-config.toml` | 无 - loopback placeholder |
| `gajae` | `~/.gjc/agent/models.yml` | `gajae-models.yaml` | `OPENCODEX_GAJAE_API_KEY` |
| `dsh` | `$DSH_HOME/settings.yaml`（默认 `~/.dsh/settings.yaml`） | `settings.yaml` | 无 — 非秘密环回 bearer 占位值 |
| `mcode` | `~/.minimax/config.yaml` (设置后 `MINIMAX_DATA_DIR` 优先，其次是旧的 `MAVIS_DATA_DIR`；相对路径会被拒绝) | `mcode-config.yaml` | 无 — loopback placeholder |
| `zcode` | `~/.zcode/v2/config.json` (设置后 `ZCODE_DATA_DIR` 优先；相对路径会被拒绝) | `config.json` | 无 — loopback placeholder |
| `prime` | `~/.prime/agent/models.json` (设置后 `PRIME_AGENT_CODING_AGENT_DIR` 优先；相对路径会被拒绝) | `prime-models.json` | 无 — loopback placeholder |
| `raycast` | `~/.config/raycast/ai/providers.yaml`（macOS 与 Windows 相同；Raycast 不遵循 `XDG_CONFIG_HOME`） | `raycast-providers.yaml` | 无 — 仅限回环，不会写入 `api_keys` 条目 |

Raycast 导出是一份独立的 `providers.yaml` 文档，在 `providers` 序列中只有一个 `id: opencodex` 元素：`name: OpenCodex`、代理的 `/v1` 基础 URL，以及每个已路由模型及其 `abilities`（`tools` 与 `system_message` 始终支持，`vision` 取自目录的输入模态，`reasoning_effort` 在模型有 effort 阶梯时设置，`temperature` 对推理模型关闭）。Custom Providers 是 Raycast Pro 功能，且 Raycast 会监视该文件，因此保存后的更改无需重启即可生效。格式见 [manual.raycast.com/ai/custom-providers](https://manual.raycast.com/ai/custom-providers)。不会写入任何 `api_keys` 条目，所以该导出仅限回环，非回环绑定会被拒绝。

opencode 会插值 `{env:OPENCODEX_OPENCODE_API_KEY}`。opencodex 生成的 Pi 导出不需要环境变量，而是携带字面占位值 `opencodex-loopback`。这个值是必需的：Pi 在构建模型列表时会解析 `apiKey`，如果已有配置包含未设置的环境变量引用，它就会隐藏整个 provider。回环上的代理从不校验生成的占位值。

:::caution[合并，不要替换]
`ocx export` 从不写入你的真实客户端配置。该命令只会打印目标路径供你手动合并，而 `--out` 在没有 `--force` 的情况下拒绝覆盖已有文件，因为替换配置会破坏其中已有的其他 providers、agents 和 MCP 条目。
:::

任何密钥都不会被序列化。生成的配置里携带的要么是有文档记录的环境引用，要么是非机密的环回占位值。环回代理（`127.0.0.1`，默认值）根本不需要准入密钥。当代理绑定到环回地址之外时，请设置对应的 `OPENCODEX_OPENCODE_API_KEY`、`OPENCODEX_HERMES_API_KEY` 或 `OPENCODEX_OPENCLAW_API_KEY`。`OPENCODEX_GAJAE_API_KEY` 只会从环境中提供 Gajae provider 凭据，不能发送远程准入 header，因此生成的 Gajae 集成仍仅支持环回。关于准入密钥如何签发，请参见 [远程访问](/reference/configuration/#remote-access)。上游 providers 自身的密钥则完全是另一回事，需要按 [Providers](/guides/providers/) 单独配置。

同一份负载会通过 `GET /api/client-config` 提供，并在仪表盘的 API 选项卡中渲染，因此 CLI、API 和 GUI 使用的是同一字节内容。

## Runtime and configuration

### `ocx system <status|settings|startup|diagnostics|sync|codex-app-server|codex-restart|update|codex-cli-update> ...`

管理无头运行时设置、启动、同步、诊断和更新。

```bash
ocx system settings --stream-mode eager-relay
```

`ocx system update` 更新 OpenCodex 本身。Codex CLI 使用以下独立的只读检查命令：

```bash
ocx system codex-cli-update check --json
```

`check` 不会向软件包注册表发起请求，只会在限定范围内检查已配置候选项的来源证据，包括经过脱敏的可执行文件位置和所有权证据。受信任的已发布启动器上下文只能验证该候选项快照，并不证明 Codex 已成功运行。由于这条一次性命令绝不会运行 Codex，来自环境变量和持久化记录的候选项仅用于报告（`managed: false`，通常为 `selection_unattested`）；JSON 输出包含 `candidateAvailable`、`candidateVersion` 和 `candidateSource`，且 `selectionAttested` 始终为 `false`。检查已配置候选项需要受信任的已发布启动器上下文；直接使用 Bun 启动或从源码运行时没有这项证明，因此会忽略环境变量和持久化记录中的候选项状态，并可能报告 `candidate_unavailable`。在 Windows 上，这个首个切片不会对候选路径或配置路径执行任何文件系统 I/O。只有由受信任启动器捕获的绝对环境候选项可以获得应用捆绑或版本管理器的纯词法标签；其他所有 Windows 候选项都会以失败关闭方式处理。该命令不会运行 Codex 或软件包管理器，不会修复 shim，不会写入配置或缓存，不会停止进程，也不会安装任何内容。随应用捆绑的候选项、位于已识别版本管理器路径中的候选项、未经验证的独立候选项以及 shim 状态不明确的候选项，都会报告为 `unmanaged` 或 `unknown`，绝不会归类为 `managed`。

### `ocx config <show|get|set|unset|validate|export|import> ...`

检查并安全修改已验证的 OpenCodex 配置。`show` 和 `get` 会隐藏密钥。导入会先验证再写入，并且需要 `--yes`。
