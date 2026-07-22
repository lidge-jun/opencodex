---
title: Claude Code 指南
description: 在 Claude Code 中使用任意已路由模型——opencodex 在同一端口提供 Anthropic Messages API 和网关模型发现功能。
---

opencodex 在 `/v1/responses` 之外还提供 `POST /v1/messages`（以及 `count_tokens`），因此 Claude
Code 可以使用每一个已路由的提供商——包括 OAuth 登录、账户池、密钥故障转移和 sidecar——
而无需进行任何额外的身份验证配置。

## 快速开始

```bash
ocx claude
```

`ocx claude` 会确保代理正在运行，然后在接好环境变量的情况下启动 Claude Code：

| 变量 | 值 |
| --- | --- |
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:<port>` |
| `ANTHROPIC_AUTH_TOKEN` | 仅在代理要求 API 密钥时设置——否则不会设置，因此你的 claude.ai 登录（订阅 + 连接器）会保持有效 |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | `1`（原生 `/model` 选择器发现） |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | 自动上下文压缩阈值（默认 `350000`）；仅在启用自动上下文时注入 |
| `ANTHROPIC_MODEL` | `claudeCode.model`（可选） |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `claudeCode.tierModels.haiku ?? claudeCode.smallFastModel`（可选，也包括旧版 `ANTHROPIC_SMALL_FAST_MODEL`） |
| `ANTHROPIC_DEFAULT_{OPUS,SONNET,FABLE}_MODEL` | `claudeCode.tierModels.*`（可选） |
| `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` | 启用 `alwaysEnableEffort` 时设为 `1`（条件注入） |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` / `DISABLE_COMPACT` | 设置 `maxContextTokens` 时使用的旧版上下文覆盖项（条件注入） |
你自行导出的变量始终优先。额外参数会直接透传：`ocx claude -p "hello"`。

## 系统环境集成（macOS）

当 `claudeCode.systemEnv` 设置为 `true`（默认：**关闭**）时，`ocx start` 会使用 `launchctl setenv`
在系统范围内注入 `ANTHROPIC_BASE_URL` 和相关的 Claude Code 环境变量。因此，新打开的终端窗口和
标签页可以直接通过代理路由普通的 `claude` 命令，无需使用 `ocx claude` 包装器。已经打开的
shell 不受影响，必须重新打开。

`ocx stop` 和代理关闭操作会**取消设置已注入的键**（不会恢复之前的值——只会移除 opencodex
注入的键）。代理还会写入 `~/.opencodex/claude-env.sh`；`ocx start` 会安装一个 `.zshrc`
source hook，以自动加载该文件。

可以在配置中设置 `claudeCode.systemEnv: false`，或使用 GUI 开关来禁用。此功能仅适用于
macOS；在其他平台上，请使用 `ocx claude`。

## 原生 Claude 透传（订阅直通）

未设置身份验证覆盖时，Claude Code 会保留其 claude.ai OAuth 登录，并将其发送给代理。
对于未被任何别名或模型映射占用的真正 `claude*`/`anthropic*` 模型，请求会连同你的凭据
**原样**转发到 `api.anthropic.com`——beta、思考签名、提示缓存和计费身份都保持完全原生，
而已路由模型仍可在同一会话中通过选择器别名使用。

**请求头处理：**转发前会移除逐跳请求头以及 `host`、`content-length`、`accept-encoding`、
`x-opencodex-api-key` 和 `origin`。其他所有请求头（包括 `anthropic-beta` 和
`anthropic-version`）都会透传。

只有同时满足以下**四个**条件时才会触发透传：`nativePassthrough` 不为 `false`；模型以
`claude` 或 `anthropic` 开头；bearer 或 `x-api-key` 以 `sk-ant-` 开头；并且别名/模型映射
解析后返回的模型保持不变。这也意味着使用 `ocx claude` 时不再出现
“claude.ai connectors are disabled”警告。

可以设置 `claudeCode.nativePassthrough: false` 来禁用；也可以通过
`claudeCode.anthropicBaseUrl` 指向其他位置。

## /model 选择器（“From gateway”）
每个条目带有诚实的显示名（如 `gemini-3-pro (gemini)`），并以官方 ModelInfo 形态附带模型能力
信息（推理强度梯度、thinking 类型），使 Claude Desktop 的第三方网关模式能够启用推理强度选择
UI。真实 Anthropic 模型保留其原始 id。合成的 2026 日期是内部槽位，不是发布日期。旧版哈希
别名和 `claude-ocx-<provider>--<model>` 别名仍可解析。拥有 1M 上下文的模型会多出一行 `…[1m]`：
选中后 Claude Code 会按 1M 计算该模型的上下文（自动压缩保留，代理在路由前去掉该标记）。
选中后会保存到 Claude Code 的 `settings.json` `model` 字段；入站请求会将别名解析回路由
模型。旧版 Claude Code 中选择器保持原生 — 通过 `ANTHROPIC_MODEL` 设置槽位，或直接在 `/model`
中输入任意路由 id（Claude Code 会原样传递字符串）。

Claude Code 2.1.129+ 通过 `GET /v1/models?limit=1000` 发现网关模型，并在原生 `/model`
选择器中以“From gateway”标签列出。由于选择器只接受以 `claude` 或 `anthropic` 开头的 ID，
opencodex 会将已路由模型公开为稳定且可逆的别名：

| 界面 | 格式 | 示例 |
| --- | --- | --- |
| Claude Code CLI | `claude-ocx-<provider>--<model>` | `claude-ocx-native--gpt-5.6-sol` |
| Claude Desktop 3P | `claude-opus-4-8-<code>`（3 字符 base36 哈希） | `claude-opus-4-8-ncb` |

代理会按请求选择别名族：`?ids=cli` 或 `?ids=desktop` 优先；否则，`claude-code/*`
user-agent 会获得易读的 CLI 形式，其他客户端会获得 Desktop 哈希形式。两种别名族都会永久
保持可解码——以任一形式保存在 `settings.json` 中的模型都能继续工作。

**别名语法规则：**provider 不得包含 `/` 或 `--`，也不得等于 `native`；model 不得包含
`/`。易读形式无法表达的路由会回退到哈希别名。模型 ID **可以**包含 `--`（解析时只按第一个
`--` 拆分）；包含 `--` 的原生 slug 会回退到哈希形式。

**模型解析顺序：**移除 `[1m]` 标记 → 解码易读别名 → 解码 Desktop 哈希别名 →
`modelMap` 精确匹配 → 移除日期后的匹配（移除 `-20250514`）→ 透传。

每个条目都带有类似 `gemini-3-pro (gemini)` 的显示名称，以及官方 `ModelInfo` 结构中的完整
模型能力（推理强度阶梯、思考类型）。真正的 Anthropic 模型在两个界面上都保留其规范 ID。

### 上下文变体 `[1m]` 标记

权威上下文窗口为 1M 的模型（或者启用自动上下文时，窗口大于 200k 且至少达到压缩阈值的模型）
会多出一个带 `…[1m]` 的选择器条目。选择它后，Claude Code 会按完整的 1M 上下文计算。
代理会在进行别名解析和路由之前移除不区分大小写的 `[1m]` 后缀。

## 自动上下文（突破 200k 上限的大上下文模型）

对于任何无法识别的模型，Claude Code 都会按 200k token 计算。默认开启的**自动上下文**可解决
这一问题：

1. 实际窗口大于 200k **且**至少达到自动压缩阈值的模型，其选择器条目和环境变量槽位会带有
   `[1m]` 标记。
2. 系统会注入 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`（默认 `350000`，范围 `100000`–`1000000`），
   使对话在该位置自动进行摘要。

配置有三种状态：

- **缺省 / `true`：**启用（默认）
- **`false`：**禁用——不添加标记，也不注入压缩窗口
- **设置了旧版 `maxContextTokens`：**隐式禁用自动上下文

可以在 Claude 页面调整压缩值。**警告：**如果将其提高到超过模型的实际窗口，该模型将无法正常
工作——聊天会在触发摘要之前报错。

低于 1M 的原生 Anthropic 模型绝不会被自动标记。你自行导出的值始终优先（代理会使用**你的**
值来判断哪些模型可以安全标记）。手动编辑配置时填入的无效值会回退到 350k。

### 有效模型环境变量

`effectiveModelEnv` 会计算由 `ocx claude` / 系统环境 / shell 文件注入的六个槽位：
`ANTHROPIC_MODEL`、四个 `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`，以及旧版
`ANTHROPIC_SMALL_FAST_MODEL`。有效 Haiku 值为 `tierModels.haiku ?? smallFastModel`，并会
提供给两个 Haiku 变量。

## 名册代理（injectAgents）

`ocx claude`（以及系统环境守护进程）会把你的精选子代理名册（Subagents 标签页，最多 5 个模型）
和 `ocx-self` 同步到 `~/.claude/agents/ocx-*.md`。

- **`ocx-self`** 固定你在 `/model` 选择器中的默认模型（回退到 `claudeCode.model`）；两者均
  不存在时省略。它**不**使用模型继承。
- 每个代理正文都包含一条 `<!-- ocx-route: <model> -->` 指令——代理使用该指令固定实际路由。
  因此 Agent 工具的 `model` 参数不起作用；请传入 `"sonnet"` 作为占位符。
- Frontmatter 携带别名；路由由指令驱动。
- 只有包含 `generated-by: opencodex` 且通过标记验证的 `ocx-*.md` 文件才会被覆盖或清理；
  你自己的代理绝不会被改动。
- 文件按单个文件进行原子同步（写入 + 重命名）。
- `enabled: false` 或 `injectAgents: false` 会清理所有经验证归属的定义。
- GUI PUT 和名册变更会立即重新同步；启动器/系统环境会在启动时同步。

派发方式：`subagent_type: "ocx-gpt-5-6-sol"`。支持 1M 的目标会自动携带 `[1m]`。

## 内置技能省略（blockedSkills）

Claude Code 内置的 `claude-api` 技能会注入约 840KB（约 136k token）的 Anthropic 文档，
并在提及 Claude 模型时自动触发。已路由模型并未针对该文档包进行训练，因此默认情况下，
opencodex 会在**已路由**请求中将该技能内容替换为一个短占位说明。原生 Anthropic 透传不受影响。

**会处理两种载体：**

1. **工具结果载体：**assistant 的 `Skill(...)` 调用——当转为小写的 JSON 输入包含被屏蔽名称时，
   与之配对的 `tool_result` 正文会被替换为占位说明。
2. **文本块载体：**以 `Base directory for this skill: ` 开头且不少于 10,000 字符的用户
   文本块——当目录 basename 等于被屏蔽名称时匹配（不区分大小写）。

通过 `claudeCode.blockedSkills` 配置（默认 `["claude-api"]`；`[]` 会完全禁用省略）。
占位说明会保持工具调用/结果的配对关系不变。

## 模型映射（拦截）

`claudeCode.modelMap` 会在路由前重写传入的 Anthropic 模型 ID：

```json
{
  "claudeCode": {
    "modelMap": {
      "claude-sonnet-4-5": "gemini/gemini-3-pro",
      "claude-haiku-4-5": "gemini/gemini-3-flash"
    }
  }
}
```

查找顺序：发现别名 → 精确 ID → 移除日期后缀的 ID（`-20250514`）→ 透传。

## Sidecar 矩阵：Web Search 与图像理解

不同路由模型拥有的托管工具和图像能力并不相同。opencodex 会在主模型回答前补齐这些能力：

- **Web-search sidecar** 执行真实的托管搜索，再把答案和来源作为工具结果交给路由模型。
- **Vision sidecar** 在调用 `noVisionModels` 中的模型前描述附件图像，并用文字描述替换图像。

两个 sidecar 都可使用以下任一后端：

| 后端 | 运行方式 | 所需条件 |
| --- | --- | --- |
| `openai` | 通过 ChatGPT `forward` provider 调用小型 GPT 模型 | ChatGPT 登录，以及已启用的 `authMode: "forward"` provider |
| `anthropic` | 通过已存储的 Anthropic OAuth 调用 Claude；Web Search 使用 `web_search_20250305`，Vision 让 Claude 描述图像 | 已启用的 `adapter: "anthropic"`、`authMode: "oauth"` provider，且其活动账户未标记 `needsReauth` |

显式设置的 `backend` 始终优先。省略时，如果存在可用的 Anthropic OAuth 活动账户，则选择
`anthropic`；否则选择 `openai`。显式选择 `anthropic` 却没有可用凭据时会**关闭失败
（fail closed）**：不会借用 ChatGPT 凭据，也不会静默切换后端。同样，OpenAI 后端缺少 ChatGPT
登录或 forward provider 时不会启用。

Claude 入站的路由重放会把主 ChatGPT 登录附加到内部请求，因此即使 Claude Code 的 bearer 仅用于
代理认证，OpenAI sidecar 仍可访问。该 ChatGPT bearer 不会发送给主路由 provider。

```json
{
  "webSearchSidecar": {
    "backend": "anthropic",
    "model": "claude-sonnet-5",
    "maxSearchesPerTurn": 3
  },
  "visionSidecar": {
    "backend": "anthropic",
    "model": "claude-sonnet-5",
    "maxDescriptionsPerTurn": 8
  }
}
```

`maxDescriptionsPerTurn` 限制一个主模型 turn 中新增的图像描述次数。缓存命中和同一 turn 内重复的
进行中描述不会消耗配额。成功的 `data:` 图像描述会按后端、模型、detail、图像字节和请求上下文
缓存，避免每次重放都重复描述同一图像与上下文。内容可能变化的远程 `https:` 图像不会缓存。

全部配置项见[配置参考](/opencodex/zh-cn/reference/configuration/#sidecars)。Anthropic OAuth Web
Search 和图像描述沿用仓库已有的 Claude Code OAuth fingerprint 先例，但在用于长时间无人值守任务前，
仍应使用你的账户和实际负载进行充分 soak test。

<!-- TODO(WP5 GUI): GUI 控件完成后补充 sidecar 设置页面操作说明。 -->

## 推理强度

Claude Code 的 `/effort` 设置会完整保留并传递给适配器：

| 传输格式 | 映射 |
| --- | --- |
| `thinking.type: "adaptive"` + `output_config.effort` | 直接传递强度（`minimal`\|`low`\|`medium`\|`high`\|`xhigh`\|`max`\|`ultra`） |
| `thinking.type: "enabled"` + `budget_tokens` | ≤4096→`low`，≤16384→`medium`，更高→`high` |
| `thinking.type: "disabled"` | 完全省略推理参数 |

解析后的值会显示在请求日志的 **Reasoning effort** 列中。

## 入站转换（Messages → Responses）

代理会将每个 Anthropic Messages API 请求转换为 Codex Responses API 格式：

| Messages 输入 | Responses 输出 |
| --- | --- |
| 顶层 `system` | `instructions`（文本块以 `\n\n` 连接） |
| `messages[].role: "system"` | 同样合并到 `instructions` |
| 用户文本 / 图像 | `input_text` / `input_image`（base64 → data URL） |
| Assistant 文本 | `output_text` |
| Assistant `tool_use` | `function_call`（`input` → JSON 字符串化的 `arguments`） |
| 用户 `tool_result` | `function_call_output`（`is_error` → `[tool error]` 前缀） |
| 重放 `thinking` / `redacted_thinking` | 丢弃 |
| Function 工具 | `{type: "function"}`（`web_search*` → `{type: "web_search"}`） |
| `tool_choice` | `auto`→`auto`，`none`→`none`，`any`→`required`，指定名称→`{type:"function",name}` |
| `max_tokens` | `max_output_tokens` |
| `stop_sequences` | `stop` |

**错误情况（400）：**JSON 格式错误；缺少/空的 `model`；缺少/空的 `messages`；不支持的
role；`tool_result` 缺少 `tool_use_id`；`tool_use` 缺少 id/name；指定名称的 `tool_choice`
缺少 name。

## 出站转换（Responses → Messages SSE）

| Responses 事件 | Messages SSE |
| --- | --- |
| `response.created` | `message_start` + `ping` |
| 心跳 | `ping` |
| 文本增量 | `content_block_start` → `content_block_delta`（文本）→ `content_block_stop` |
| 推理摘要/文本 | 带合成签名的 `thinking` 块 |
| Function-call 帧 | 带 `input_json_delta` 的 `tool_use` 块 |
| 终止事件 | `message_delta` → `message_stop` |
| 在终止事件前 EOF | 502 风格的 `api_error` |

**停止原因映射：**`completed` → `tool_use`（如果有工具调用）或 `end_turn`；
`incomplete/max_output_tokens` → `max_tokens`；`incomplete/content_filter` → `refusal`。

**错误分类：**400 `invalid_request_error`、401 `authentication_error`、
402 `billing_error`、403 `permission_error`、404 `not_found_error`、409 `conflict_error`、
413 `request_too_large`、429 `rate_limit_error`、504 `timeout_error`、529 `overloaded_error`，
其他 5xx 为 `api_error`。`Retry-After` 会保留。

## 提示缓存与 token 用量

**Anthropic 路由请求：**适配器会管理工具、系统内容和倒数第二条用户消息的缓存断点，以及顶层
自动 `cache_control`。稳定轮次通常能达到约 99.9% 的缓存命中率。

**原生 OpenAI/ChatGPT 路由：**派生会话范围的 `prompt_cache_key`（存在时取自
`metadata.user_id`，否则回退到系统内容哈希）和用于缓存亲和性的 `session_id` 请求头。
缓存键包含模型和完整的工具 schema。

**Token 计算：**Anthropic 输出会从 `input_tokens` 中减去 `cached_tokens` 和
`cache_write_tokens`，并将它们分别公开为 `cache_read_input_tokens` 和
`cache_creation_input_tokens`。请求日志会将其映射回包含这些值的 `inputTokens`，读取量同时
记录在 `cachedInputTokens` 和 `cacheReadInputTokens` 中，写入量记录在
`cacheCreationInputTokens` 中。Usage 页面会分别报告缓存命中和缓存创建。

**count_tokens：**已路由模型使用近似值（序列化后的 system + messages + tools）。使用
`sk-ant-` 凭据的原生 Anthropic 模型会将请求透传到真实的 Anthropic
`/v1/messages/count_tokens` 端点。

## 调试捕获

`ocx debug claude on|off|status|reset`、`OCX_CLAUDE_DEBUG=1` 或
`PUT /api/debug {"claude": true}` 控制入站捕获。`GET /api/claude/inbound-debug` 返回
`{enabled, entries}`（最新条目在前，环形缓冲区大小为 20）。

每个条目记录：`at`、`endpoint`、`model`、`resolvedModel`、`stream`、`maxTokens`、
`thinkingType`、`thinkingBudgetTokens`、`outputConfigEffort`、`metadataKeys`、
`hasMetadataUserId`、`hasSystem`、原始 `anthropicBeta`，以及 user id / system 的八字符
HMAC 等值标签。**不会存储提示文本、原始对象或跨运行稳定的哈希。**禁用 Claude 调试会立即
清空环形缓冲区。

## GUI（Claude 页面）

仪表板侧边栏有一个专用的 **Claude** 页面（位于 API 下方）和 **Claude ON** 开关
（标签特意在所有语言中保持一致）。该页面显示：

- 入站总开关（启用开关）
- 快速开始（`ocx claude`）和手动环境变量块
- Fast Mode 选择器（Auto / ON / OFF）
- 自动上下文开关和压缩阈值下拉菜单
- 子代理自动注册开关
- 模型拦截（modelMap）编辑器
- 选择器别名实时预览

`GET /api/claude-code` 返回有效默认值、配置、上下文窗口注册表、有效环境变量、可用路由 ID、
别名和端口。`PUT /api/claude-code` 接受部分更新并保留省略的字段；`null` 会重置
context/blocklist/compact-window 值。

## 故障排除

**Claude Code 显示“Did 0 searches”**——当前版本会把已完成的 Responses
`web_search_call` 转换成配对的 Anthropic `server_tool_use` 和 `web_search_tool_result` block，
并写入 `usage.server_tool_use.web_search_requests`。如果旧版本已经完成搜索却仍计为 0，请更新
opencodex。

**Sidecar 未启用**——使用 `backend: "openai"` 时，请确认已登录 ChatGPT，并存在已启用的
`authMode: "forward"` provider。使用 `backend: "anthropic"` 时，请确认已存储的 Anthropic
OAuth 活动账户未标记 `needsReauth`。显式选择 Anthropic 却没有可用凭据时会按设计关闭失败。

**“claude.ai connectors are disabled”**——你的 shell 中设置了 `ANTHROPIC_API_KEY` 或
`ANTHROPIC_AUTH_TOKEN`。`ocx claude` 特意**不会**设置 `ANTHROPIC_API_KEY`；如果你已将其
导出，请取消设置。`ocx claude` 会注入 `ANTHROPIC_BASE_URL`、发现相关变量、自动上下文和已配置的模型槽位，但绝不会注入 `ANTHROPIC_API_KEY`。

**模型未显示在 /model 选择器中**——确认已设置
`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`（使用 `ocx claude` 时会自动设置）。运行
`ocx claude` 以刷新 `~/.claude/cache/gateway-models.json` 中的网关模型缓存。检查
`claudeCode.enabled` 不为 `false`。

**端口更改后环境变量过时**——如果代理端口发生变化，旧 shell 中的
`ANTHROPIC_BASE_URL` 可能已经过时。请打开一个新终端，或重新运行 `ocx claude`。

**大模型仍受 200k 上下文上限限制**——在选择器中选择 `[1m]` 变体，或启用自动上下文
（默认开启）。如果选择器中没有 `[1m]` 条目，该模型的权威上下文窗口可能低于自动压缩阈值。

**技能加载导致 token 数量过高**——内置的 `claude-api` 技能（约 136k token）会在提及
Claude 模型时自动加载。对于原生透传，这是正常现象；对于已路由模型，opencodex 默认会将其
替换为占位说明（`blockedSkills: ["claude-api"]`）。

**子代理派发到错误模型**——名册代理（`ocx-*`）使用 `<!-- ocx-route: ... -->` 指令，
而不是 Agent 工具的 `model` 参数。请确保指令与预期路由一致。传入 `"sonnet"` 作为模型占位符。
