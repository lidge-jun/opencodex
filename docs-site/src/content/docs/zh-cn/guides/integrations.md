---
title: 集成
description: 从仪表盘将 opencodex 连接到 OpenCode、Pi、OMP、Hermes、OpenClaw、Kimi Code、gjc、DeepSeek Harness、MiniMax Code、ZCode、Prime Agent、Aside、Raycast、omo 和 Cline CLI；每个客户端都有独立开关，且每次写入前都会备份。
---

**Integrations** 标签页可将 opencodex 的提供商配置块写入客户端自己的配置文件，也可再次移除。以下 15 个客户端都采用这种方式，各有独立开关：

| 客户端 | 配置文件 | 格式 | 变更生效时间 | 凭据 |
|---|---|---|---|---|
| OpenCode | `~/.config/opencode/opencode.json` | JSON | 下次直接启动时 | `OPENCODEX_OPENCODE_API_KEY` |
| Pi | `~/.pi/agent/models.json` | JSON | 新会话 | 回环占位符 |
| OMP | `~/.omp/agent/models.yml` | YAML | 重启 OMP 后 | `opencodex-loopback` 占位符 |
| Hermes | `~/.hermes/config.yaml` | YAML | 新会话 | `OPENCODEX_HERMES_API_KEY` |
| OpenClaw | `~/.openclaw/openclaw.json` | JSON5 | 运行中的网关立即生效 | `OPENCODEX_OPENCLAW_API_KEY` |
| Kimi Code | `~/.kimi-code/config.toml` | TOML | 重启或执行 `/reload` 后 | 回环占位符 |
| gjc | `~/.gjc/agent/models.yml` | YAML | 新会话，或打开 `/model` 时 | 非敏感回环占位符 |
| DeepSeek Harness (DSH) | `$DSH_HOME/settings.yaml`（默认 `~/.dsh/settings.yaml`） | YAML | 热重载 | 非敏感回环 bearer 占位符 |
| MiniMax Code | `~/.minimax/config.yaml` | YAML | 新会话，或打开模型选择器后 | 回环占位符 |
| Prime Agent | `~/.prime/agent/models.json` | JSON | 新会话 | 回环占位符 |
| ZCode | `~/.zcode/v2/config.json` | JSON | 重启后 | 回环占位符 |
| Aside | `~/.aside/u/<account>/models.json` | JSON | 完全退出并重新打开 Aside 后 | 回环占位符 |
| Raycast | `~/.config/raycast/ai/providers.yaml` | YAML | 保存后立即生效——Raycast 监视该文件 | 无——仅回环 |
| omo | `~/.omo/agent/models.json` | JSON | 新会话 | 回环占位符 |
| Cline CLI | `~/.cline/data/settings/providers.json` 及同目录下的 `models.json` | JSON 文件对 | 停止并重启 Cline 后 | 回环占位符 |

生成的目录只包含各提供商选择中已启用的模型。下载文件和托管集成都遵循这一规则，Pi 和 Aside 也不例外。管理模型列表仍显示完整阵容，以便启用更多模型。

对于 Gajae 内置预设，请在 `~/.gjc/agent/config.yml` 中保留路由选择：

```yaml
modelProfile:
  proxyProvider: opencodex
  proxyMode: always
```

保留所选的 `modelProfile.default`，使普通 `gjc` 启动时应用它。托管集成只管理 `models.yml` 中的 `providers.opencodex`；刷新或禁用该提供商不会改写预设选择。更改导出的模型选择后，请刷新集成。

托管 OpenCode 集成管理两个片段：`provider.opencodex`（opencode V1）和 `providers.opencodex`（opencode V2）。只有 V2 配置块包含各模型的推理强度变体，因此两者都会写入并保持同步；它们使用相同的提供商与模型 id，opencode V2 会将它们合并为一个提供商条目。Apply、Refresh、Disable 和 Restore 都作用于两个片段；其他提供商、代理、快捷键与 MCP 条目保持不变。

托管 DSH 支持的最低兼容版本为 **DSH 0.1.0-rc.6**。OpenCodex 只管理 `llm-pi-ai.providers.opencodex`；Apply 和 Refresh 替换该片段，Disable 只移除该片段，Restore 恢复已记录的快照。DSH 会热重载提供商变更。这些操作不会改变用户的默认模型或原生 `deepseek-official` 提供商。托管 DSH 集成目前仅支持回环地址，绝不会写入真实凭据。

MiniMax Code 依次遵循 `MINIMAX_DATA_DIR`、`MAVIS_DATA_DIR`，否则使用 `~/.minimax`。其托管配置块只管理 `custom_provider.opencodex`，不会更改 `defaultModel`、所选 MiniMax 凭据来源或用户的 MiniMax 登录。连接后，在 MCode 中选择 `custom_provider:opencodex/<provider/model>` 条目。刷新集成还会刷新各模型可靠的上下文窗口和推理强度选项；未知能力会省略，MCode 会话中的当前强度保持不变。

Prime Agent 优先使用 `PRIME_AGENT_CODING_AGENT_DIR`，否则使用 `~/.prime/agent`；相对路径会被拒绝，避免代理与客户端对目标文件产生分歧。其托管配置块只管理 `providers.opencodex`，其他提供商和已设置的 `modelOverrides` 保持不变。Prime Agent 在会话启动时读取 `models.json`，连接后请启动新会话。

Aside 为每个已注册的配置文件（包括本地配置文件）分别保存模型目录。OpenCodex 会列出所有已注册配置文件（包括本地配置文件），可一起同步，也可逐个控制。切换集成绝不会改变 Aside 的活动账户。此前连接过 Aside 时，默认会启用所有配置文件；单个配置文件的排除设置在后续同步中仍会保留。

Aside 有一项特殊注意事项：运行中的应用会自行重写 `models.json`，因此应用集成后必须完全退出并重新打开 Aside，类似 Claude Desktop 的重启要求。Aside 配置块只适用于回环地址，绝不包含真实凭据。

托管 Raycast 集成支持 **macOS 和 Windows**。Custom Providers 是 **Raycast Pro** 功能：免费方案下仍会写入文件，但 `ocx integration client status --client raycast` 和 Integrations 页面会显示警告，因为 Raycast 不会读取该文件。在 macOS 或 Windows 上，请先打开 Raycast → Settings → AI → **Reveal Providers Config**，确保 `ai` 文件夹存在。在这些受支持的平台上，opencodex 以该文件夹作为安装信号；文件夹不存在时会报告客户端未安装。即使文件夹存在，Linux 仍不受支持。

状态字段 `aiDirPresent` 只表示 `~/.config/raycast/ai` 是否存在，与 Raycast 应用是否安装或平台是否受支持无关。它不能证明 Raycast 已安装或可用。CLI 会单独打印 `plan` 行；当 `aiDirPresent` 为 false 时，还会添加 macOS/Windows 设置说明。`--json` 保留原始状态，包括嵌套的 `raycast` 配置块。macOS 和 Windows 上的 Raycast 都读取 `~/.config/raycast/ai/providers.yaml`，且不遵循 `XDG_CONFIG_HOME`，因此该路径不可迁移。

托管配置块是文件 `providers` 序列中的一个元素，即 `id: opencodex`：包含 `name: OpenCodex`、`base_url: http://<host>:<port>/v1` 以及每个路由模型和其 `abilities`。导出器按客户端导出约定将 `tools` 与 `system_message` 设为 `true`；`vision` 遵循目录中的输入模态；模型具有强度级别时设置 `reasoning_effort`；推理模型关闭 `temperature`。文件中的其他提供商会保留，禁用时只移除 OpenCodex 元素。Raycast 在文件保存后立即读取变更，无须重启；模型会在其模型选择器的 **OpenCodex** 分组中出现。Raycast 支持可选的 `api_keys`，但 OpenCodex 有意省略它们，并拒绝非回环或需要准入认证的目标；此集成无法提供 OpenCodex 必需的准入标头。

macOS 私有偏好设置仅是 Pro 状态的参考提示；Windows 不读取它，并报告方案未知。方案检测既不授权也不阻止写入。导出元数据没有可靠的工具支持标志，因此 `tools: true` 不能证明每个路由模型都支持工具。视觉与强度标志遵循目录元数据；有强度级别时关闭温度是保守的导出行为。提供商的值会保留，但 YAML 格式和注释不保证保留。格式说明见 [manual.raycast.com/ai/custom-providers](https://manual.raycast.com/ai/custom-providers)。

Raycast CLI 导出和仪表盘下载使用运行中服务器的目标地址和准入策略，包括已配置的免认证回环监听器。`ocx ensure` 不会根据保存的配置快照刷新 Raycast，因为它可能与运行中的服务器不同。服务器启动和明确执行同步仍是刷新目录的途径。

Cursor 有自己的标签页，但不属于这些开关。普通 Cursor 从自己的后端调用自定义端点，因此没有公网隧道就无法访问回环代理；独立的 Cursor Private Inference 构建则在 Cursor 内配置。**Cursor** 标签页只读：它检测安装的构建、显示需要粘贴到 Cursor 的 Base URL 和 API Key，并报告 Cursor 向代理发出的最近一次请求。详见 [Cursor Private Inference](/zh-cn/guides/cursor-private-inference/)。

客户端提供环境变量覆盖时，路径会遵循各自的覆盖设置。对于 OMP，`OMP_PROFILE` 只要存在就优先于 `PI_PROFILE`，即使显式设为空值。命名配置文件将 `PI_CONFIG_DIR` 视为相对于用户主目录的目录名，并忽略 `PI_CODING_AGENT_DIR`；没有命名配置文件时，`PI_CODING_AGENT_DIR` 优先。OMP 支持提供商级标头，但此次初始集成有意只支持回环；远程 `x-opencodex-api-key` 的接线留待以后处理。迁移后的 `HERMES_HOME`、`KIMI_CODE_HOME` 和 `XDG_CONFIG_HOME` 路径也会被遵循，而不会猜测。表格列出的是各客户端默认值。

对于原生 OpenAI 模型，生成的 OMP 配置块选择模型级 Responses API，以保留图像输入和推理强度控件。路由模型仍使用提供商的 Chat Completions 方言，保持现有适配器兼容。

OpenClaw 有多个相关变量，作用各异。`OPENCLAW_CONFIG_PATH` 选择文件；`OPENCLAW_STATE_DIR`、`OPENCLAW_PROFILE` 和 `OPENCLAW_HOME` 选择状态目录，检测也会检查该目录。因此，使用配置文件或迁移后的主目录仍会显示为已安装，而配置文件路径覆盖只移动文件。如果仍使用旧版 `.clawdbot` 布局，也能检测到：现代目录存在时优先使用它；仅有旧目录时才使用旧目录。

这些路径必须是**绝对路径**或以 `~` 开头。相对路径会被拒绝，而不是解析，因为它依赖各进程的启动目录；路径还会与备份一同保存，必须在明天仍指向今天的同一文件。

opencodex 从自己的环境读取这些变量。如果网关使用配置文件或迁移后的主目录，请用相同变量启动 opencodex，否则它会正确地指向另一处安装。

## 另外五个界面不是开关

**API Keys** 管理 opencodex 自己的凭据，根本不是客户端。**Codex CLI** 由代理服务自身连接：启动 opencodex 时应用路由，停止时恢复原生路由，因此没有逐文件开关。**Claude** 保留自己的启用标志和 Desktop 的 Save/Apply 流程；**Grok Build** 保留先选择再应用的模型边界。这些语义早于此功能，且未发生变化。**Cursor** 完全不写入文件：标签页显示检测结果、网关值和最近收到的请求，其余操作在 Cursor Private Inference 中完成。

## 回滚

每次成功写入都会**先**对文件拍摄快照，因此总能恢复之前的状态：

- 当文件仍与我们写入的内容一致时，最新操作会显示 **Undo**。
- 较旧的操作，或操作后文件已发生变化时，会显示 **Restore this point…**。跨越此类变更恢复时，会在替换较新编辑内容前再次确认，并先备份这些编辑内容，因此恢复操作本身也可撤销。
- 每个客户端保留十份备份。超过后会删除最旧的快照文件，对应的历史记录显示 **Backup expired**。

Disable 只移除 opencodex 记录为自己管理的条目。如果文件在写入后发生变化，结果取决于我们的条目是否仍完整以及文件格式。对于严格 JSON 配置（OpenCode、Pi），在配置块**旁边**编辑，例如添加 MCP 服务器或自己的提供商，会显示 **Update needed**：刷新时会绕过并保留这些条目，但格式可能被规范化。有些 JSON 内容无法精确保留：如 `1e999` 这样的非有限数值、重写时会舍入的数字（超大整数或会变成零的极小数字）、`-0`、同一对象中的重复键，或超过 1000 层的嵌套。遇到这些内容时，开关会锁定，以免静默更改或丢弃数据。**OMP、DSH 和 Hermes** 也不受相邻编辑影响，但原因不同：其写入器只按字节修补自身管理的提供商片段，不重写文件其余部分。对于其他可能带注释的格式（OpenClaw、Kimi Code、gjc、MiniMax Code、Raycast——整份写入的 JSON5 和 TOML，或不保留源码的通用 YAML），以及我们管理的条目被编辑时，开关会锁定，Disable 会拒绝执行，而不是猜测哪些编辑来自你。

锁定状态并非无解。有冲突的客户端会在概览卡片和自身页面的开关旁显示 **Replace**。它会将占据我们设置位置的内容替换为 opencodex 将写入的配置块，并事先询问：对话框会显示文件名、说明会丢失什么，并指向可用于撤销的快照。开关本身仍锁定，因为它无法知道你希望保留哪些编辑；只有你能决定。其他限制没有放宽：无法解析或无法可靠理解结构的文件仍会拒绝处理。

Hermes 的会话标识升级是上述冲突规则的特例：已有受管配置仅新增 `session_affinity_header: session-id` 时，可通过 **Apply** 接纳；其他受管字段的修改仍会冲突。升级前，后台刷新会同时暂停该集成的模型列表更新。此设置适用于该 provider 的所有模型，需要支持该能力的 Hermes 版本，且不保证缓存命中率。详见[英文升级说明](/guides/integrations/#hermes-session-affinity)。

## 预览并确认变更

Apply、Replace、Disable 和 Restore 都先显示预览。对话框准确列出会变化的托管设置，包括有界的变更路径及每项变更是添加、更新还是移除。确认前请检查计划。

如果计划显示没有变更，说明托管客户端文档已处于请求的状态。对于选中的 Aside 配置文件，即使托管文档不变，确认操作仍可能保存该配置文件的同步偏好。

如果检查后文件发生变化，写入会因计划过期而被拒绝。对话框会用更新后的计划替换旧计划，并要求再次确认；绝不会自动重试写入。如果预览暂时不可用，请正常重新加载页面，再发起操作。

Aside 对单个选中配置文件采用相同的预览和确认流程。**Sync all profiles** 仍是单独的批量操作，不与一份合并预览绑定。

## 实际效果与限制

**通常不会保留格式。** 应用操作会解析配置并重新写出，因此 JSON、JSON5 和 TOML 的排版可能变化，JSON5 或 TOML 中的注释也会丢失。OMP、DSH 和 Hermes 是例外：它们的 YAML 写入器分别只修补 `providers.opencodex` 和 `llm-pi-ai.providers.opencodex`，逐字节保留无关提供商的注释和格式。如果无法安全确定准确的源码范围，操作会拒绝执行。对于其他客户端，如需先前文件的原始字节，请使用 Restore；快照是逐字节副本。

**如果无法忠实重写某个值，开关也会拒绝执行。** 往返转换覆盖这些格式实际使用的值类型；无法覆盖时，例如 TOML 使用 `inf` 或 `nan` 而当前解析器无法准确读回，应用操作会停止并说明原因，不会写入改变后的值却声称成功。界面会指出文件名，磁盘内容保持不变。你仍可手动编辑该文件；拒绝的只是自动重写。

TOML 日期和时间也会拒绝托管重写，因为合并步骤会将这些带类型的值变成带引号的字符串。数组和内联表中的值也包括在内。带引号的日期字符串仍受支持；不带引号的日期必须通过手动编辑配置来保留。

**Pi、Kimi Code、gjc、MiniMax Code、Prime Agent、Aside、Raycast、omo 和托管 DSH 集成仅适用于回环绑定。** 前四者没有配置字段可传递非回环绑定所需的 `x-opencodex-api-key` 标头。DSH 有通用标头映射，但 rc.6 没有将专用准入标头文档化为受支持的集成契约，因此托管写入器会封闭式失败，而不会猜测。Prime Agent 的提供商配置块接受标头，但远程凭据接线不在首次集成范围内。请通过 SSH 隧道或会添加标头的本地转发器向它们提供回环访问。

**生成的 OMP 集成也有意仅支持回环地址。** OMP 虽支持提供商级标头，但此次初始集成不会输出远程 `x-opencodex-api-key` 凭据接线。手动配置远程 OMP 暂不属于托管集成。

**Kimi Code 不能保存环境变量引用，**因此其配置包含 `opencodex-loopback` 占位符而非密钥。任何客户端配置中都不会写入真实凭据。

**对于 `ocx opencode`，启动器的提供商配置块优先。** 启动器通过 `OPENCODE_CONFIG_CONTENT` 注入 `provider.opencodex` 和 `providers.opencodex`，其优先级高于磁盘上的相同条目；其余 opencode 配置照常生效。直接启动 `opencode` 时，此处的开关才是关键。

## 从终端操作

相同操作也可以在无图形界面的环境中执行：

```bash
ocx integration client status
ocx integration client enable --client hermes
ocx integration client disable --client hermes
ocx integration client history --client hermes
ocx integration client restore --op <opId> [--confirm-drift]
```

`--overwrite-conflict` 是 **Replace** 的终端形式：

```bash
ocx integration client enable --client zcode --overwrite-conflict
```

与 `--confirm-drift` 一样，它绝不会被默认启用；不带此选项时，仍会拒绝冲突。它只适用于 `enable`；强制在冲突中执行 *disable* 可能删除我们从未写入的配置块，因此该组合会被拒绝。

对于 MiniMax Code，先连接提供商一次，再通过经过检查的封装命令启动：

```bash
ocx integration client enable --client mcode
ocx mcode
```

连接后，`ocx sync` 和 `POST /api/sync` 会按当前模型选择、上下文窗口及推理强度级别刷新已管理的 MCode、Pi、Aside、Raycast 和 omo 目录。代理启动时会刷新已管理的 Raycast 目录。模型可见性、提供商选择或预设变化，也会刷新已连接的 Pi、Aside、Raycast 和 omo 目录。缺失、被外部编辑或不安全的配置块不会被触碰；此前归 OpenCodex 管理、但被你手动删除的配置块也不会重建。已启用的 Aside 配置文件是“仅刷新已管理配置块”规则的例外：如果账户目录存在且从未有过已管理配置块，当该位置为空时，同步可以创建首个配置块。此前连接过 Aside 会默认对所有已注册配置文件启用这一行为。同步不会创建缺失的账户目录，也不会替换手动配置块。拒绝或重叠的刷新会按客户端分别报告。启动新 Pi 会话，或完全退出并重新打开 Aside，才能加载更新后的文件。Aside 刷新要求[运行中的兼容代理](#aside-配置文件控制)。

如果 Models 同时显示 **“Model selection saved”** 和客户端刷新警告，说明选择已保存，但一个或多个客户端文件未能更新。警告会指出受影响的客户端，以及适用时的 Aside 配置文件，并解释拒绝原因。启动新会话前，请打开 **Integrations** 检查该客户端或配置文件。处理报告的问题后，重试 `ocx sync`；重叠操作必须先完成。如果警告包含备份路径，或指出恢复未完成，请在重试前检查恢复状态。仅有选择保存成功的提示，并不能证明客户端文件恢复完成。

独立的 MiniMax 平台 CLI（`mmx`）不是文件开关集成。其文本命令使用 MiniMax 的 Anthropic 兼容端点，因此 OpenCodex 提供隔离凭据且仅限回环地址的启动器：

```bash
ocx mmx text chat --model anthropic/claude-opus-5 --message "Hello"
ocx mmx text repl --model openai/gpt-5.6-sol
```

只有 `mmx text chat` 和 `mmx text repl` 通过代理。对于 MiniMax 原生的图像、视频、语音、音乐、视觉、搜索、额度、认证、配置、文件和更新命令，请使用普通 `mmx`。封装命令使用仅包含非敏感回环占位符的临时配置；绝不会加载 `~/.mmx` 中的 OAuth 或 API 密钥凭据，并拒绝 `--api-key`、`--base-url` 和 `--region` 覆盖。完整流程和限制见 [MiniMax 客户端](/zh-cn/guides/minimax/)。

`--confirm-drift` 绝不会被默认启用。如果要恢复的操作执行后文件发生变化，命令会拒绝并给出说明，因为是否替换较新的编辑应由你决定。

客户端细节已对照各项目自身的配置格式验证；检查内容及时间记录在 `devlog/_fin/260802_client_toggle_api/002_client_toggle_matrix.md` 的研究笔记中。

## Aside 配置文件控制

Aside 配置文件控件和 `ocx sync` 执行的 Aside 刷新，都需要运行中的 ocx 代理支持 Aside 配置文件 API。仅更新 CLI 不会更新已经运行的代理。若代理不可用或版本过旧，Aside 操作无法完成；CLI 不会回退到本地写入 Aside 配置文件。

升级代理所使用的 ocx 安装，然后重启代理（若已停止则启动）。重新执行 `ocx sync` 或配置文件命令。配置文件更新成功后，请完全退出并重新打开 Aside，以加载新目录。

```bash
ocx integration client status --client aside --json
ocx integration client enable --client aside
ocx integration client disable --client aside --profile 1
ocx integration client history --client aside --profile 1
ocx integration client restore --client aside --profile 1 --op <opId>
```

配置文件编号是状态命令显示的账户 ID。对 Aside 开关省略 `--profile`，会将目标状态应用到所有已注册配置文件。逐配置文件变更不影响其他配置文件。预期同步设置会在文件变更前保存；每个配置文件都会报告实际状态及拒绝原因。部分成功的批量结果不算全部应用成功，CLI 会以非零状态退出。Undo 会同时恢复所选配置文件的同步意图与文件，避免后续同步静默撤销 Undo。

[配置文件 API](/reference/management-api/#aside-profile-controls) 在批量操作成功时返回 HTTP 200；任一配置文件拒绝时，返回 HTTP 207 和 `ok: false`。请检查 `results` 中每个条目：一个配置文件失败时，成功的配置文件不会回滚。预期设置仍会保存，因此请解决受影响配置文件的问题后重试，不要假设整批操作都失败。如果保存这些设置失败，则不会修改任何配置文件。

每个配置文件都有独立的所有权与历史记录。现有用户编辑、不安全路径及链接的目录都会被拒绝；现有的明确覆盖与漂移确认控件仍可使用。完全退出并重新打开 Aside，才能加载变更后的模型文件。

## ZCode 3.14 及更新版本

ZCode 3.14 将自定义提供商移至 `~/.zcode/v2/provider_config.json`，而 `~/.zcode/v2/config.json` 只能通过新文件缺失时运行的一次性导入影响它。ZCode 首次运行就会创建新文件，因此任何已启动过的安装都已经用完导入机会；写入 `config.json` 不会生效。

可以时，opencodex 会直接写入 `provider_config.json`。启用集成会向该文件添加 `opencodex` 提供商规则，目录刷新会更新它，禁用时则准确移除 opencodex 写入的内容。文件中的其他规则保持不变，包括其他提供商针对也出现在我们目录中的模型 id 所保留的规则。如果某条规则带有 `opencodex` id 却并非由 opencodex 写入，它会被视为冲突，而不会被直接接管；请在 ZCode 中解决，或明确选择覆盖。

无法读取或并非普通文件的提供商存储也会拒绝写入；它不会被当作不存在的存储，以允许旧版导入。

另有两种情况会拒绝写入。其一，ZCode 迁移存储前由 opencodex 应用的配置块仍将集成绑定在 `config.json`：请先在该文件中禁用，再次启用以写入新存储。其二，`provider_config.json` 的 `schemaVersion` 不是 opencodex 已观察过的版本：系统会报告，而不会合并。这个文件保存 ZCode 的所有提供商，擅自假设其结构可能将静默无效变成静默丢失。若集成没有写入 ZCode 实际读取的文件，状态会指出该文件。

第二种情况下，请在 ZCode 自己的设置中添加提供商：基础 URL 为 `http://127.0.0.1:10100/v1`（按绑定端口调整），使用任意非空密钥，模型 id 来自 `ocx export --client zcode`。不支持删除 `provider_config.json` 以重新触发 ZCode 导入，因为这样会丢弃 ZCode 保存在其中的所有提供商。

## Cline CLI

此集成面向 Cline 当前 CLI/共享 SDK 的提供商存储，其原生 schema 为 `version: 1`。旧版 VS Code 扩展的 `globalState`/secret 存储不会被迁移，也不会被检测为此集成。请先运行一次 Cline，以初始化其设置目录。

**启用、同步、禁用或恢复集成前，请停止 Cline。** OpenCodex 会把 `providers.opencodex` 同时写入 `providers.json` 和同目录的 `models.json`。前者包含使用非敏感回环占位符的 OpenAI Responses 连接；后者包含经过筛选的路由模型目录，以及可用的上下文与图像元数据。现有提供商条目和默认提供商选择保持不变。

```bash
ocx integration client list --json
ocx integration client enable --client cline
ocx integration client history --client cline
ocx integration client restore --op <operation-id>
```

启用后重启 Cline 并选择 OpenCodex，或使用 `cline --provider opencodex --model <provider/model>` 启动。外部目录变更会在 Cline 重启时读取。Cline 不参与无人值守的目录刷新；更改路由模型选择后，请先停止 Cline，再运行 `ocx sync` 或再次启用集成以刷新。所选模型仍在路由目录中时会保留，从导出目录移除时会清除。

`CLINE_PROVIDER_SETTINGS_PATH` 覆盖主文件路径。否则，`CLINE_DATA_DIR` 选择数据目录，接着 `CLINE_DIR` 选择根目录，最后使用 `~/.cline`。模型文件始终是所选提供商文件旁的 `models.json`。覆盖路径必须为绝对路径或以 `~` 开头。以命令参数指定 Cline `--config` 路径时，启动 OpenCodex 也应设置对应的 `CLINE_PROVIDER_SETTINGS_PATH`。主文件不能命名为 `models.json`，因为两个文件必须不同。

每个文件的替换都是原子的，但文件系统没有同时替换两个文件的单一操作。一条日志操作会为两个原始文件拍摄快照；写入或记账失败时会补偿恢复两者。中断的操作会留下私有恢复记录。状态会将未完成恢复报告为不安全；下一次明确的变更操作只在两个文件及其所有权都没有无关编辑时才执行恢复。如果恢复被拒绝，请保留文件和操作报告的恢复路径，解决冲突后再重试。

Undo 会恢复**两个原始字节串**，包括原本不存在的文件。操作后的编辑需要现有的明确 `--confirm-drift`；编辑后的文件对会先备份。被其他内容占用的 OpenCodex 条目需要现有的 `--overwrite-conflict` 选择。Disable 只移除两个托管条目，不会恢复先前的外来条目；如需恢复，请使用 Undo。快照保留和过期规则与其他集成相同。

下载文件 `cline-config-bundle.json` 包含两个原生文档成员：对应 `providers.json` 的 `settings`，以及对应 `models.json` 的 `catalog`。它本身不是 Cline 设置文件。建议使用集成命令，以获得带日志的合并和回滚。此生成集成不支持远程准入接线，需要免认证的回环访问。

## GitHub Copilot 应用

GitHub Copilot 桌面应用可以将 opencodex 用作兼容 OpenAI 的模型提供方。这需要手动配置客户端，Integrations 标签页没有对应的开关；它也不同于上游 `github-copilot` 提供方，后者使用 Copilot 订阅作为 opencodex 的后端。

1. 启动 opencodex 并确认它能正常响应：

   ```bash
   curl http://127.0.0.1:10100/healthz
   curl http://127.0.0.1:10100/v1/models
   ```

2. 在 Copilot 应用中打开 **Settings → Model providers → Add provider**，填写：

   | 字段 | 值 |
   |---|---|
   | 名称 | 任意标签，例如 `OpenCodex` |
   | Base URL | `http://127.0.0.1:10100/v1`（按绑定端口调整） |
   | API key | 回环连接时留空 |

3. 从端点同步模型，或按 `provider/model` ID 添加模型，然后选择它。

应用通过 `GET /v1/models` 发现模型，并通过 `POST /v1/chat/completions` 发送请求。这些请求经过 opencodex 的常规模型路由，因此与其他客户端一样会应用提供方凭据、OAuth 账户和组合路由。支持的请求字段见[代理格式参考](/reference/proxy-formats/)。

如果应用提示没有模型，请确认 Base URL 以 `/v1` 结尾，而不是 `/v1/chat/completions`，并确认 `/v1/models` 返回非空的 `data` 数组。如果 opencodex 监听的不是回环地址，请在应用的 API key 字段中填写数据准入密钥（[远程访问](/reference/configuration/server/#remote-access)中说明的令牌，或由仪表盘生成的 `ocx_…` 密钥）。应用会将其作为 `Authorization: Bearer` 发送；`/v1/chat/completions` 仅将其用于代理准入，不会转发到上游。详见[认证矩阵](/reference/proxy-formats/#authentication-matrix)。
