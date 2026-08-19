---
title: 提供商
description: opencodex 进行身份验证并与 LLM 提供商通信的所有方式——OAuth、API 密钥、ChatGPT 转发以及本地。
---

**提供商（provider）** 是一个上游 LLM 端点，加上访问它的方式：一个 adapter、一个基础 URL、一种认证模式，以及一个可选的模型列表。提供商配置位于 `~/.opencodex/config.json` 的 `providers` 下。

## OpenAI 账户模式

| Provider id | 用途 | 凭证/账户规则 |
| --- | --- | --- |
| `openai` | Codex 登录 | Pool（默认）选择主账户和添加账户；Direct 只使用当前 caller/主登录。 |
| `openai-apikey` | OpenAI API | 只使用配置的 API key/key pool；不读取 Codex 账户。 |

bare `gpt-5.6-sol` 遵循 Providers 页面中的 Pool/Direct 选项，
`openai-apikey/gpt-5.6-sol` 选择 API。凭证路径之间不会 fallback。API 元数据为 922,000 context /
922,000 max input；`*-pro` virtual id 保留在公开状态中，线上改写为 base 模型加
`reasoning.mode: "pro"`。

若内置 `openai` 提供商缺失或已禁用，可在仪表盘 Accounts 选择器或 Codex Auth 页面恢复：缺失行会从规范预设创建，已禁用的规范行会在不替换已保存模式/模型设置的情况下重新启用，非规范的 `openai` 行不会提供该恢复路径。

### 提供商概览中的账户池容量

Codex 登录使用 Pool 模式时，Providers 概览显示整个账户池的已用容量估算，而不是任意一个
账户的数值。同一行还会显示当前有效账户的原始配额使用率，便于区分账户池估算与下一次请求
将使用的账户状态。

如果有重置信息，概览会显示下一次重置时间以及届时恢复的账户池容量。**覆盖不完整**表示某些
账户无法安全计入估算，例如套餐或配额未知、读数过旧、账户已暂停或需要重新认证。

**部分窗口覆盖不完整**表示某些已计入账户只报告了部分显示的配额窗口。概览会保持各窗口相互
独立，逐一标记受影响的窗口，并且不会把缺失值当作该窗口的使用量。

此估算仅用于显示，不会改变账户选择、会话关联、自动切换、cooldown 或任何其他路由决策。
各账户状态和路由控制请参阅
[Codex Auth 账户池](/zh-cn/guides/web-dashboard/#codex-auth-and-account-pools)。

shipped v1 配置自动迁移到 marker 2 的单一选项行。原配置只保留一次到
`~/.opencodex/config.json.pre-openai-tiers-v2.bak`；恢复命令：
`cp ~/.opencodex/config.json.pre-openai-tiers-v2.bak ~/.opencodex/config.json`。

## 认证模式

提供商配置支持三种 `authMode`，默认值为 `key`。内置注册表还会单独标记本地预设；这类预设通常会
同时省略 `authMode` 和 `apiKey`。

| `authMode` | 如何进行认证 | 使用方 |
| --- | --- | --- |
| `key` | 发送你的 API 密钥（`Authorization: Bearer …`，或按 adapter 使用 `x-api-key` / `api-key`）。密钥可以是字面值，也可以是 `${ENV_VAR}` 引用。 | 大多数提供商。 |
| `forward` | 将**你传入的 Codex 认证请求头**原样转发给提供商——不存储任何密钥。这就是 ChatGPT 登录的透传方式。 | OpenAI（`openai-responses` adapter）。 |
| `oauth` | 读取已存储的 OAuth 访问令牌（过期前自动刷新），并将其用作 bearer 密钥。 | xAI、Anthropic、Kimi、Kiro、Google Antigravity、Cursor、Command Code、GitHub Copilot、Nous Portal。 |

[`retryOn429`](/zh-cn/reference/configuration/)（同 key 的 429 重试）仅适用于 API-key 提供商
（`authMode: "key"`）。OAuth、forward 与本地预设均被排除——同一 token 绝不可重放，本地运行时
也没有需要保留的远程 key。仅在配置后启用，默认关闭；配置了对象即启用，除非 `enabled: false`。

## 1. ChatGPT 登录（forward / 透传）

默认提供商**不需要 API 密钥**。它将你现有 `codex login` 的凭据直接转发到 OpenAI Responses 后端：

```json
{
  "openai": {
    "adapter": "openai-responses",
    "baseUrl": "https://chatgpt.com/backend-api/codex",
    "authMode": "forward"
  }
}
```

只有一组精选的请求头会被转发（`FORWARD_HEADERS`：authorization、ChatGPT account id、OpenAI beta/originator/session——参见 [Adapters](/zh-cn/reference/adapters/)）。这条路径也为 [web-search 和 vision sidecar](/zh-cn/guides/sidecars/) 提供支持。

ChatGPT 透传目录也会加入 GPT-5.6 Sol/Terra/Luna 的裸 slug（`gpt-5.6-sol`、
`gpt-5.6-terra`、`gpt-5.6-luna`）；账号具备相应权限时才能实际调用。

## 2. 账号登录（OAuth）

有八个提供商预设使用 OAuth 登录，另加通过实验性非官方设备流桥接的 GitHub Copilot。
opencodex 会把凭据存入 `~/.opencodex/auth.json` 并自动刷新。登录 CLI 也接受 `chatgpt`：
它会获取一份 ChatGPT 凭据，并创建一个 `forward` 模式的提供商条目。

```bash
ocx login xai          # xAI Grok
ocx login anthropic    # Anthropic Claude (Pro/Max)
ocx login kimi         # Moonshot Kimi
ocx login nous         # Nous Portal（设备授权；免费 + 付费模型）
ocx login kiro         # 导入 kiro-cli 凭据（支持令牌回退）
ocx login google-antigravity
ocx login cursor       # 独立的 Cursor PKCE 登录
ocx login command-code # Command Code 浏览器 OAuth（或导入 ~/.commandcode/auth.json）
ocx login github-copilot  # GitHub 设备流 → Copilot 令牌（Copilot Pro/Business）
ocx login chatgpt      # 独立的 ChatGPT OAuth 登录
ocx logout <provider>
```

| 提供商 | Adapter | 基础 URL | 备注 |
| --- | --- | --- | --- |
| `xai` | `openai-chat` | `https://api.x.ai/v1` | 优先使用实时 Grok 目录；回退默认模型为 `grok-4.5`。 |
| `anthropic` | `anthropic` | `https://api.anthropic.com` | Claude 模型；实时模型列表从 `/v1/models` 获取。 |
| `kimi` | `openai-chat` | `https://api.kimi.com/coding/v1` | Kimi K2.7/K2.6/K2.5 编程模型。 |
| `nous` | `openai-chat` | `https://inference-api.nousresearch.com/v1` | Nous Research 订阅网关（与 Hermes Agent 使用同一后端）。通过设备授权登录 `portal.nousresearch.com`；access 令牌是每个请求的 inference JWT。付费 + `:free` 模型混合目录（`tencent/hy3:free`、`stepfun/step-3.7-flash:free` 等）会从已登录账户实时发现。Refresh 令牌是单次使用，每次刷新都会轮换。 |
| `kiro` | `kiro` | `https://runtime.us-east-1.kiro.dev` | 首次登录会导入已安装并已登录的 Kiro CLI 会话（Unix 使用 `curl -fsSL https://cli.kiro.dev/install` &#124; `bash`；Windows PowerShell 使用 `irm 'https://cli.kiro.dev/install.ps1'` &#124; `iex`；然后运行 `kiro-cli login`）。**添加账户**会先退出 `kiro-cli`，再启动新的浏览器登录，从而切换 `kiro-cli` 自身使用的账户，并保存账户范围的配置文件元数据。现有 OpenCodex 账户会保留；如果取消或失败，则恢复之前的 `kiro-cli` 会话。 |
| `google-antigravity` | `google` | `https://daily-cloudcode-pa.googleapis.com` | 通过 Cloud Code Assist 协议使用 Google OAuth。实时发现调用已认证的 CCA `v1internal:fetchAvailableModels` 端点，并仅发布当前登录账户可用的 agent 模型；维护中的目录仍作为回退。 |
| `cursor` | `cursor` | `https://api2.cursor.sh` | 实验性 PKCE 登录、带可选 HTTP/1.1 兼容路径的 HTTP/2 传输，以及按账号筛选的模型发现。 |
| `github-copilot` | `openai-chat` | `https://api.githubcopilot.com` | 实验性。GitHub 设备流 + `copilot_internal` 交换（VS Code OAuth 客户端）。需要有效的 Copilot 订阅；不是官方第三方 API。 |

Nous refresh 发生终止性失败后，请运行 `ocx login nous` 重新认证。

对于规范的 Kimi Coding Plan 预设（`kimi` 账号登录和 `kimi-code` API key），opencodex
只会把调用方提供的稳定 `prompt_cache_key` 转发到 Chat Completions 请求，绝不自行生成。Kimi
文档要求使用稳定的会话/任务 key 来提高 Code Plan 缓存命中率；没有 key 的请求仍保持不带 key。
若已 opt-in 的上游拒绝该字段，opencodex 不会删除字段后重试，也不会改动已保存配置；其他
provider 仍保持 deny-by-default。

你也可以从 [web 仪表盘](/zh-cn/guides/web-dashboard/) 启动 OAuth。

### 多个 OAuth 账号

OAuth 凭据中带有稳定账号 id 或邮箱的提供商可以保存多个登录。Providers 页面会在下拉列表中显示这些
账号，允许继续添加，并在不登出其他账号的情况下切换当前账号。普通登录时，没有身份信息的 Kimi 凭据会替换
当前 active slot；显式 **添加账号** 会保留原有 slot 并激活一个独立的新 slot。Kiro 账户以配置文件 ARN 为键。
`chatgpt` 始终只有一个 slot，因为 Codex 账号池使用独立存储。令牌仍保存在
`~/.opencodex/auth.json` 中；`/api/oauth/accounts` 只返回脱敏后的 metadata。

### Cockpit Tools Antigravity 导入

v1 中 OpenCodex 仅支持为 `google-antigravity` 提供商导入 **Cockpit Tools Antigravity** JSON 导出文件。在 Providers 仪表板中打开该提供商的 Accounts 标签并选择本地 JSON 文件。仪表板不会显示文件内容或凭据值，只报告已导入、已更新、失败和不支持的数量。v1 会拒绝其他 Cockpit 提供商的导入。

CLI 仅从文件或标准输入读取导出文件，不能将其粘贴到命令参数中：

```bash
ocx account import google-antigravity --format cockpit-tools --file <path> [--json]
cat accounts.json | ocx account import google-antigravity --format cockpit-tools --stdin [--json]
```

内联 JSON 和额外的位置参数会被拒绝。请将导出的文件保密，并在导入后删除或安全存储。

### Kiro 凭据导入

Kiro 登录需要 Kiro CLI：Unix 使用 `curl -fsSL https://cli.kiro.dev/install | bash` 安装；Windows PowerShell 使用 `irm 'https://cli.kiro.dev/install.ps1' | iex`；然后先运行 `kiro-cli login`。如果没有 `kiro-cli` 会话，`ocx login kiro` 会回退到粘贴的访问令牌或 `KIRO_ACCESS_TOKEN` 环境变量。

普通的 `ocx login kiro` 导入会以只读方式打开 CLI SQLite 数据库，不修改数据库、WAL 或 SHM。

- `KIROCLI_DB_PATH` 用于选择非标准位置的 Kiro CLI SQLite 数据库；指定的数据库必须已经存在。
- `KIROCLI_TOKEN_KEY` 在存在多个含糊的令牌行时选择确切的 `auth_kv` 行键。缺少选择值时，登录会失败而不会猜测。

导入的凭据会保存到 `~/.opencodex/auth.json`。**添加账户**的回滚是独立流程：恢复之前的快照时会替换数据库，并删除当前的 WAL、SHM 和 journal 边车文件。

由于回滚依赖快照，当会话存储已存在但无法捕获时（文件不可读、架构不匹配、令牌选择有歧义），当 `KIROCLI_DB_PATH` / `KIRO_CLI_DB_FILE` 将导入路径指向与活动 CLI 存储不同的位置时，或当主 CLI 数据库没有可识别的令牌行时，**添加账户**会拒绝将 `kiro-cli` 登出。请修复或删除常规 `kiro-cli` 数据路径下的损坏数据库，并取消仅用于导入的选择器后重试。对于完全没有现有 `kiro-cli` 会话的机器，不受影响。

## 3. API 密钥目录

opencodex 内置 79 个预设：67 个密钥预设、8 个 OAuth 预设、3 个本地预设，以及 1 个默认的
ChatGPT 转发预设。仪表盘的 **Add provider** 选择器会打开密钥提供商的控制台，验证并保存密钥。
验证因提供商而异。主要条目包括：

**ClinePass** 使用 Cline API 密钥连接[官方订阅目录](https://docs.cline.bot/getting-started/clinepass)和
[Chat Completions 端点](https://docs.cline.bot/api/chat-completions)。运营主体是
[Cline 条款](https://cline.bot/tos)所列的 Cline Bot Inc.。
`cline-pass/cline-pass/kimi-k3` 这样的路由 ID 是预期格式：第一段选择 opencodex 提供商，
其余的 `cline-pass/kimi-k3` 是发送到上游的完整模型 slug。用量由账户的滚动 5 小时、每周和
每月限额共同管理。2026-08-13 的实测确认，所有静态 ClinePass 模型在网关输入端都接受
`low`、`medium`、`high`、`xhigh` 和 `max`。opencodex 会保留请求的档位；后端特定的规范化由 ClinePass 负责。

**Cline** 使用相同的 API 密钥和端点，按用量计费，可访问 100 多个模型
(OpenRouter 风格 ID，如 `anthropic/claude-sonnet-4-6`)。Cline 的促销免费模型仅在
Cline IDE/CLI 中提供，不能通过 API 使用；`minimax/minimax-m2.5` 是文档中通过 API
免费试用的模型。

| 提供商 | 基础 URL |
| --- | --- |
| **OpenAI (API key)** | `https://api.openai.com/v1` |
| **Anthropic (API key)** | `https://api.anthropic.com` |
| **OpenRouter** | `https://openrouter.ai/api/v1` |
| **Cline** | `https://api.cline.bot/api/v1` |
| **ClinePass** | `https://api.cline.bot/api/v1` |
| **Ollama Cloud** | `https://ollama.com/v1` |
| Google Gemini · Google Vertex AI | `https://generativelanguage.googleapis.com` · `https://aiplatform.googleapis.com` |
| Azure OpenAI | `https://{resource}.openai.azure.com/openai` |
| Umans AI · Neuralwatt | `https://api.code.umans.ai` · `https://api.neuralwatt.com/v1` |
| Mistral | `https://api.mistral.ai/v1` |
| MiniMax · MiniMax (CN) | `https://api.minimax.io/v1` · `https://api.minimaxi.com/v1` |
| DeepSeek | `https://api.deepseek.com` |
| Cerebras | `https://api.cerebras.ai/v1` |
| Chutes | `https://llm.chutes.ai/v1` |
| DeepInfra | `https://api.deepinfra.com/v1/openai` |
| Hyperbolic | `https://api.hyperbolic.xyz/v1` |
| Nscale Serverless Inference | `https://inference.api.nscale.com/v1` |
| Vultr Serverless Inference | `https://api.vultrinference.com/v1` |
| Baseten Model APIs | `https://inference.baseten.co/v1` |
| Command Code | `https://api.commandcode.ai/provider/v1` |
| SambaNova Cloud | `https://api.sambanova.ai/v1` |
| Nebius Token Factory | `https://api.tokenfactory.nebius.com/v1` |
| DigitalOcean Serverless Inference | `https://inference.do-ai.run/v1` |
| Scaleway Generative APIs | `https://api.scaleway.ai/v1` |
| Featherless AI | `https://api.featherless.ai/v1` |
| Novita AI | `https://api.novita.ai/openai/v1` |
| Together | `https://api.together.xyz/v1` |
| Fireworks | `https://api.fireworks.ai/inference/v1` |
| Moonshot (Kimi API) · Kimi (coding) | `https://api.moonshot.ai/v1` · `https://api.kimi.com/coding/v1` |
| Hugging Face | `https://router.huggingface.co/v1` |
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` |
| Z.AI (GLM Coding) | `https://api.z.ai/api/coding/paas/v4` |
| 智谱 AI (BigModel) | `https://open.bigmodel.cn/api/paas/v4` |
| Qwen Cloud | Token plan（默认）: `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` · 按量付费: `https://dashscope.aliyuncs.com/compatible-mode/v1` · 或自定义 |
| 腾讯云 Coding Plan | `https://api.lkeap.cloud.tencent.com/coding/v3` |
| SiliconFlow | `https://api.siliconflow.cn/v1` |
| 火山方舟 · Coding Plan · Agent Plan | `https://ark.cn-beijing.volces.com/api/v3` · `https://ark.cn-beijing.volces.com/api/coding/v3` · `https://ark.cn-beijing.volces.com/api/plan/v3` |
| Xiaomi MiMo | `https://api.xiaomimimo.com/anthropic` |
| Xiaomi MiMo (OpenAI Chat) | `https://api.xiaomimimo.com/v1` |
| Kilo | `https://api.kilo.ai/api/gateway` |
| GitLab Duo | `https://cloud.gitlab.com/ai/v1/proxy/openai/v1` |
| Cloudflare AI Gateway | `https://gateway.ai.cloudflare.com/v1/{account-id}/{gateway}/anthropic` |
| ……以及更多 | opencode zen、Vercel AI Gateway、Venice、NanoGPT、Synthetic、Qianfan、Alibaba、Parallel、ZenMux、LiteLLM |

**OpenCode Zen**（`opencode-zen`）与免密钥的 **OpenCode Free** 预设共用
`https://opencode.ai/zen/v1`。该网关上的免费模型常会触发约每分钟 15–20 次请求的短窗口限流（社区观测；OpenCode 未公布 RPM）。Zen 可能返回不带 `Retry-After` / `X-RateLimit-*` 的通用 429。这与免密钥桌面配额（`opencode-free` 上约每 5 小时 200 次 Big Pickle/免费模型请求）是分开的。当这类 429 省略 `Retry-After` 时，opencodex 会在客户端错误中补充说明并附带合成的 `Retry-After`；若上游已提供 `Retry-After`，则仍以它为准。同密钥等待重试仍可通过 [`retryOn429`](/zh-cn/reference/configuration/) 选择开启。

大多数使用带 bearer 密钥的 `openai-chat` adapter；少数仅暴露 Anthropic 兼容端点的提供商（例如 **Xiaomi MiMo**）使用 `anthropic` adapter（`x-api-key`）。
火山方舟 Agent Plan 通过 `openai-responses` adapter 使用原生 Responses 端点。
内置 DeepSeek preset 同样会让 `deepseek-v4-flash` 使用原生 Responses 端点，并保留上游 SSE
流式输出。如果该模型已经完成全部输出项却缺少最终 Responses 事件，opencodex 会应用模型级
5 秒宽限修复；不完整或格式异常的流会以 incomplete 结束，不会被误报为成功。

> **三条火山方舟计费线路：**`volcengine` 是按量付费方舟 API，`volcengine-coding-plan`
> 消耗 Coding Plan 额度，`volcengine-agent-plan` 消耗 Agent Plan 额度。密钥与端点需要属于
> 同一产品；已经订阅 Plan 时调用普通 `/api/v3` 端点仍可能产生按量费用。
> 三个 preset 使用经过筛选的静态模型目录：方舟 `/models` 同时返回文本、Embedding、图片、
> 视频和 3D 资源，Coding 网关也会返回这份宽泛目录，Agent Plan 网关没有 `/models` 资源。
> 按量付费默认使用 `doubao-seed-2-1-pro-260628`，静态目录还包含当前 DeepSeek 和 GLM
> 文本模型。Coding Plan 默认使用 `ark-code-latest`，Agent Plan 默认使用
> `deepseek-v4-pro`。

**Chutes 发现：**`chutes` 预设使用 Chutes 固定的共享 OpenAI 兼容 LLM gateway。它读取公开的
`/v1/models` 目录，仅保留 `supported_features` 包含 `tools` 的记录，保留含 `/` 的原生 model id 与
安全的实时 metadata，并把发现限制为 256 KiB 和 128 条原始记录。由于该目录公开，它无法证明输入的
密钥有效；chat 请求仍会使用已配置的 Bearer 密钥认证。用户自行部署的 custom Chute host 与非 LLM API
需要使用 custom provider。密钥可在 [Chutes dashboard](https://chutes.ai/auth/start) 创建。

**DeepInfra 发现：**`deepinfra` 是使用 `openai-chat` adapter 和 Bearer API 密钥的密钥型
OpenAI Chat Completions 提供商。registry 固定的 DeepInfra 模型列表 URL 仅保留带 `chat` 标签的记录，
同时保留含 `/` 的原生模型 id，并把实时发现限制为 512 KiB 和 512 条原始记录。
密钥可在 [DeepInfra 控制台](https://deepinfra.com/dash/api_keys)创建。

**Hyperbolic 发现：**该预设会使用已配置的 bearer 密钥读取 `/v1/models`，保留含 `/` 的原生模型 id，
并将实时发现限制为 256 KiB 和 256 条原始记录。它仅覆盖 serverless text 与 vision-language chat；独立的
image、audio 和 GPU 端点不在范围内。密钥可在 [Hyperbolic](https://app.hyperbolic.ai) 创建。

**Nscale 与 Vultr 发现：**两个预设都会读取需要认证的 `/v1/models` 目录、保留原生模型 id，并将发现限制为
256 KiB 和 256 条原始记录。Nscale 的目录没有 modality 字段，却混合了 chat、image 与 embedding 模型，
所以预设仅允许其官方工具调用 API 示例使用的 `meta-llama/Llama-3.1-8B-Instruct`。Vultr 目前只明确
`kimi-k2-instruct` 支持工具调用，因此其预设仅暴露这一模型。其他记录会保持隐藏，直到提供商发布同等的
agent-tool 证据。Nscale service token 可在 [Nscale Console](https://console.nscale.com) 创建；Vultr
inference key 可从 [Vultr Console](https://my.vultr.com) 的订阅概览复制。

**Command Code 发现：**该预设从固定的 Provider API 主机读取 Command Code 的
`/provider/v1/models` 列表，保留含 `/` 的原生模型 id，并将实时发现限制为 256 KiB 和 256 条原始记录。
`ocx login command-code` 支持通过浏览器进行 OAuth 登录（现有 Command Code CLI 用户还可选择从
`~/.commandcode/auth.json` 导入本地 CLI 凭据）；模型目录按账户隔离，并在登录后从经过认证的发现
端点获取。聊天请求使用已配置的 bearer 密钥。密钥可在 [Command Code Studio](https://commandcode.ai/studio/) 创建。

**Command Code 配额：**仪表盘和 `ocx account refresh` 会在规范主机 `https://api.commandcode.ai` 上探测 `/alpha/billing/credits` 窗口（5 小时和每周）。OAuth 预设 (`command-code`) 使用已保存的账户 bearer；Provider-API 密钥预设 (`commandcode`) 使用当前配置的有效密钥。用户改写后的仿冒 base URL 不会被探测。当 Command Code 同时返回周期消耗时，剩余的 monthly / purchased / free credits 会显示为 USD 窗口。

**SambaNova Cloud 发现：**该预设从固定 API 主机读取 SambaNova Cloud 的公开 `/v1/models` 列表，保留提供商原生
模型 id，并将发现限制为 128 KiB 和 128 条原始记录。该目录无需鉴权，因此 CLI 登录流程不会把公开响应
当作密钥有效性的证明，而会将密钥报告为无法验证。chat 请求仍使用已配置的 Bearer 密钥；由于 SambaNova
尚不支持并行 function call，该能力会被禁用。私有 SambaStudio 部署端点不在范围内。
密钥可在 [SambaNova Cloud](https://cloud.sambanova.ai/apis) 创建。

**Nebius Token Factory 发现：**该预设请求需要鉴权的 verbose 模型目录，仅保留 architecture 输出 text
的记录，从而排除 embedding 和 image-generation 模型。它保留含 `/` 的原生模型 id、上游报告的 context
和 input modality metadata，并将发现限制为 512 KiB 和 512 条原始记录。dedicated deployment 主机不在
范围内。密钥可在 [Nebius Token Factory](https://tokenfactory.nebius.com) 创建。
**DigitalOcean 发现：**该预设使用 model access key 访问固定的共享 Serverless Inference 主机，只公开
已鉴权 `/v1/models` 响应与 DigitalOcean 官方文档确认的 Chat Completions allowlist 的交集。未知、
Responses-only、embedding 和 media-generation 模型 id 会按 fail closed 原则排除。发现上限为 256 KiB
和 256 条原始记录；agent 专属及 dedicated 主机不在范围内。密钥可在
[DigitalOcean Control Panel](https://cloud.digitalocean.com/model-studio/manage-keys) 创建。

**Scaleway 发现：**该预设只公开已鉴权模型列表与官方文档确认的 Serverless Chat Completions allowlist
的交集。未知、Responses-only、embedding、transcription 及其他 media-model id 会按 fail closed 原则排除；
发现上限为 128 KiB 和 128 条原始记录。它使用默认 Project 的共享 endpoint；带 Project ID 的 URL 和
dedicated deployment 需要配置为 custom provider。API 密钥可在
[Scaleway 控制台](https://console.scaleway.com/generative-api) 创建。

**Featherless 发现：**该预设在固定的 OpenAI 兼容主机上鉴权，只请求按 chat 和当前 plan 过滤后的热门
模型第一页，最多 100 条。registry 随后按 fail closed 原则要求每条记录分别报告当前 plan 可用、无需
Hugging Face gate，且 `features.tool_use: true`。发现上限为 128 KiB 和 100 条原始记录，因此不会下载或
缓存包含数万模型的完整目录。由于 `/v1/models` 在文档中可带或不带鉴权调用，它无法证明输入的密钥有效；chat 请求仍会使用已配置的 Bearer 密钥认证。个人 plan 仅适用于 interactive/prototype 用途；任意 application 需要使用
Scale plan。密钥可在 [Featherless dashboard](https://featherless.ai/account/api-keys) 创建。

**Novita 发现：**密钥预设使用 `openai-chat` adapter，并只向 Novita 的固定 OpenAI 兼容主机发送
Bearer key。公开模型列表只保留同时报告 `model_type: chat` 和 `chat/completions` endpoint 的记录，
发现上限为 512 KiB 和 256 条原始记录。由于 catalog 是公开的，login 会报告密钥无法验证，而不会把
成功列出模型当作密钥有效的证明。模型能力各不相同，因此预设不会声明 provider-wide parallel tool calls
或 OpenAI `reasoning_effort`。密钥可在
[Novita key manager](https://novita.ai/settings/key-management) 创建。

> **Baseten 范围：**该预设仅覆盖 Baseten 的共享 [Model APIs](https://docs.baseten.co/inference/model-apis/overview)。
> 本地使用可选择个人 [API 密钥](https://docs.baseten.co/organization/api-keys)；共享或生产用途请使用具备
> **Call Model APIs** 权限的团队密钥。
> 专用 Truss `predict` 端点使用不同的主机和请求 schema，不由此预设路由。
> 该预设的实时发现上限为 1 MiB 响应和 256 条原始模型记录。

### A6API 信用额度

使用 `openai-chat`、`authMode: "key"` 以及规范地址 `https://api.a6api.com` 或
`https://api.a6api.com/v1` 的自定义提供商，会在仪表板和 `ocx account refresh <provider>`
中显示 A6API 信用使用情况；提供商名称可以自定义。系统依据账户的 hard credit limit 将令牌单位换算为 USD，并显示已用百分比和剩余额度。
令牌到期不代表额度补充，因此不会显示为配额重置。只有当前活动密钥会发送到规范主机，重定向会被拒绝；负数
或内部不一致的计费总数不会生成报告。

> **腾讯云 Coding Plan 使用限制：**腾讯将此订阅限定为交互式编程工具使用。禁止通用 API
> 自动化、自定义应用后端和非交互式批量调用；违规使用可能导致套餐密钥被停用。

> **两条 GLM 线路：**`zai` 是 Z.AI 的国际 coding plan 订阅，`zhipu-bigmodel` 是智谱国内
> BigModel 的按量付费端点。二者主机、密钥与计费均不同，为其中一方签发的密钥无法在另一方通过鉴权。

### 多个 API 密钥

基于密钥的提供商也可以保存多个 key。通过 Providers 页面添加密钥时，它会存入
`provider.apiKeyPool`、被设为 active，并同步到 `provider.apiKey`，这样路由和 adapter 仍读取原来的
字段。同一个下拉列表可以切换或移除密钥；管理 API 是 `/api/providers/keys`，并且只返回脱敏后的密钥。

### 从终端切换账号

无需打开仪表盘，即可使用 `ocx account list`、`ocx account current` 和 `ocx account use` 查看或
切换同一组 Codex、OAuth 和 API-key pool。完整命令、JSON 输出和新 session 生效规则请参阅
[CLI 参考](/zh-cn/reference/cli/#ocx-account-subcommand)。

### GPT-5.6 预览路径

GPT-5.6 Sol/Terra/Luna 会预置在提供商的回退列表中，因此即使实时模型目录暂时滞后，`ocx sync`
也能继续显示这些模型。

| Codex 路由 | 预置模型 id | Codex 中显示的上下文 |
| --- | --- | --- |
| Codex 登录（Pool 或 Direct） | `gpt-5.6-*` | 922,000 |
| OpenAI (API key) | `openai-apikey/gpt-5.6-*` 和 `*-pro` | 922,000（max input 922,000） |
| OpenRouter | `openrouter/openai/gpt-5.6-sol`、`openrouter/openai/gpt-5.6-terra`、`openrouter/openai/gpt-5.6-luna` | 922,000 |
| Cursor | `cursor/gpt-5.6-sol`、`cursor/gpt-5.6-terra`、`cursor/gpt-5.6-luna` | 1,000,000 |

原生 GPT-5.6 条目保留固定的上游 reasoning 档位，例如 Luna 有 `max`，但没有 `ultra`。路由条目
则使用各提供商的元数据和 reasoning 映射。四条路径最终都受上游账号权限限制；Cursor 还会根据实时
发现结果，仅保留当前账号可用的模型。

:::note[gateway 与订阅 proxy]
是否支持某个提供商，取决于 opencodex 是否有匹配的 wire adapter，而**不取决于**它是否属于
“agent”产品。当前 adapter id 包括 `openai-chat`、`openai-responses`、`anthropic`、`google`
（AI Studio、Vertex、Antigravity/Cloud Code Assist 模式）、`azure` / `azure-openai`、`kiro` 和
`cursor`。原生 Amazon Bedrock 这类无法匹配上述实现的专有 API 暂不直接支持。**GitHub Copilot** 和
**GitLab Duo** 是多模型 gateway，映射到各自的通用 OpenAI 兼容端点。Copilot 支持通过
`ocx login github-copilot` 使用 GitHub 设备流 OAuth 登录（非官方桥接 — 使用 VS Code 公开客户端 id
登录后换取短期 Copilot API 令牌，需要有效的 Copilot 订阅，GitHub 政策收紧时可能失效）；GitLab Duo
使用 Bearer **订阅令牌**（而非普通 API 密钥）进行认证。
**Cloudflare AI Gateway** 需要将 account 和 gateway id 填入 URL。

Copilot 提供混合 wire 目录：其 GPT-5 系列模型（`gpt-5.3-codex`、`gpt-5.4`、
`gpt-5.4-mini`、`gpt-5.5`、`gpt-5.6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra`）会拒绝面向
agent 流量的 `/chat/completions`，因此 opencodex 默认将这些模型路由到 Responses API，而其他
Copilot 模型仍走 chat completions。优先级为：硬 wire 固定 → 显式
[`modelAdapters`](/zh-cn/reference/configuration/providers/) 条目 → 注册表默认值 → 提供商级
adapter。若要将没有内置默认值的模型（例如 `gpt-5.4-nano`）接入 Responses，请设置
`"modelAdapters": { "gpt-5.4-nano": "openai-responses" }`。

Cursor 作为单独的实验性 adapter 进行跟踪。`adapter: "cursor"` 会作为实验性本地配置出现在
`ocx init` 和 dashboard Add Provider picker 中，并保存 Cursor 的静态回退模型目录 metadata。配置
Cursor access token 后，opencodex 会使用 Cursor live HTTP/2 transport。代理要求 Cursor 的
HTTP/1.1 兼容路径时，可设置 `upstreamHttpVersion: "http1.1"`；该设置同时覆盖推理与实时模型发现，
并可在 **Providers → Cursor → 设置 → Cursor 传输协议** 中选择。内置回退列表包含上下文为
1M 的 `gpt-5.6-sol` / `terra` / `luna`、上下文为 500K 的 Grok 4.5/4.6 普通与 Fast 条目，以及上下文为
262K 的 `kimi-k3`；最终显示哪些模型由账号的实时发现结果决定。Grok 4.6 的两种形式均提供
`low` / `medium` / `high` / `xhigh`，而 4.5 最高为 `high`。Fast 请求会发送对应的 Grok 基础模型，
并通过独立的 `effort` 与 `fast=true` `requested_model` 参数指定模式；扁平化的
`cursor-grok-{version}-{effort}-fast` id 仅用于发现和 picker 标识。Cursor 只以带 effort 后缀的 wire id
提供 Kimi K3，因此 `cursor/kimi-k3` 暴露 `low` / `high` / `max` 阶梯，默认值为 `max`，与该模型
文档中的 API 默认值一致。Cursor 服务器直接发起的
native read/write/delete/ls/grep/shell/fetch 执行默认禁用，因为它会绕过 Codex 的 approval 和
sandbox 路径；只有在可信本地实验中，才应在 `~/.opencodex/config.json` 的 `providers.cursor`
对象上设置 `unsafeAllowNativeLocalExec: true`，也可以在仪表盘的 **Providers → Cursor → Edit JSON**
中设置。完整示例参见 [配置参考](/zh-cn/reference/configuration/#cursor-provider-adapter-cursor)。MCP、屏幕录制和 computer-use
通过 executor hook 暴露；没有配置本地 executor 时，opencodex 会返回 typed no-executor 结果。
Cursor OAuth 和 live model discovery 已在这个实验性 adapter 中启用；Cursor 仍不会出现在 key-login
列表中。
:::

### Ollama Cloud

Ollama Cloud 是托管（而非本地）的 Ollama，在 `https://ollama.com/v1` 上兼容 OpenAI，密钥来自 [ollama.com/settings/keys](https://ollama.com/settings/keys)。opencodex 按视觉能力对其云端阵容进行分类，使 [vision sidecar](/zh-cn/guides/sidecars/) 仅对纯文本模型生效。纯文本模型（例如 `glm-5.2`、`deepseek-v4-pro`、`gpt-oss`、`qwen3-coder`、`minimax-m2.x`、`nemotron-3-*`）列在 `noVisionModels` 中；原生支持视觉的模型（例如 `kimi-k2.6`、`minimax-m3`、`gemma4`、`qwen3.5`、`gemini-3-flash-preview`）则不在其中。匹配能容忍 Ollama 的 `:size` 标签，因此 `gpt-oss` 涵盖 `gpt-oss:120b` 和 `gpt-oss:20b`。

## 4. 本地提供商

让 opencodex 指向本地的 OpenAI 兼容服务器——通常使用空密钥：

| 提供商 | 基础 URL |
| --- | --- |
| Ollama (local) | `http://localhost:11434/v1` |
| vLLM | `http://localhost:8000/v1` |
| LM Studio | `http://localhost:1234/v1` |

## 任意 OpenAI 兼容端点

如果某个提供商使用 Chat Completions，`openai-chat` adapter 即可处理它——在仪表盘中选择 **Custom**，或在 `ocx init` 中选择 `custom` 并输入基础 URL。每个提供商字段（`headers`、`noReasoningModels`、`noVisionModels`、`models`……）请参见 [配置参考](/zh-cn/reference/configuration/)。
