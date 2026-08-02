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
`openai-apikey/gpt-5.6-sol` 选择 API。凭证路径之间不会 fallback。API 元数据为 1,050,000 context /
922,000 max input；`*-pro` virtual id 保留在公开状态中，线上改写为 base 模型加
`reasoning.mode: "pro"`。

若内置 `openai` 提供商缺失或已禁用，可在仪表盘 Accounts 选择器或 Codex Auth 页面恢复：缺失行会从规范预设创建，已禁用的规范行会在不替换已保存模式/模型设置的情况下重新启用，非规范的 `openai` 行不会提供该恢复路径。

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
| `oauth` | 读取已存储的 OAuth 访问令牌（过期前自动刷新），并将其用作 bearer 密钥。 | xAI、Anthropic、Kimi、Kiro、Google Antigravity、Cursor。 |

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

有六个提供商预设使用 OAuth 登录，另加通过实验性非官方设备流桥接的 GitHub Copilot。
opencodex 会把凭据存入 `~/.opencodex/auth.json` 并自动刷新。登录 CLI 也接受 `chatgpt`：
它会获取一份 ChatGPT 凭据，并创建一个 `forward` 模式的提供商条目。

```bash
ocx login xai          # xAI Grok
ocx login anthropic    # Anthropic Claude (Pro/Max)
ocx login kimi         # Moonshot Kimi
ocx login kiro         # 导入 kiro-cli 凭据（支持令牌回退）
ocx login google-antigravity
ocx login cursor       # 独立的 Cursor PKCE 登录
ocx login github-copilot  # GitHub 设备流 → Copilot 令牌（Copilot Pro/Business）
ocx login chatgpt      # 独立的 ChatGPT OAuth 登录
ocx logout <provider>
```

| 提供商 | Adapter | 基础 URL | 备注 |
| --- | --- | --- | --- |
| `xai` | `openai-chat` | `https://api.x.ai/v1` | 优先使用实时 Grok 目录；回退默认模型为 `grok-4.5`。 |
| `anthropic` | `anthropic` | `https://api.anthropic.com` | Claude 模型；实时模型列表从 `/v1/models` 获取。 |
| `kimi` | `openai-chat` | `https://api.kimi.com/coding/v1` | Kimi K2.7/K2.6/K2.5 编程模型。 |
| `kiro` | `kiro` | `https://runtime.us-east-1.kiro.dev` | 首次登录会导入已安装并已登录的 Kiro CLI 会话（Unix 使用 `curl -fsSL https://cli.kiro.dev/install | bash`；Windows PowerShell 使用 `irm 'https://cli.kiro.dev/install.ps1' | iex`；然后运行 `kiro-cli login`）。**添加账户**会先退出 `kiro-cli`，再启动新的浏览器登录，从而切换 `kiro-cli` 自身使用的账户，并保存账户范围的配置文件元数据。现有 OpenCodex 账户会保留；如果取消或失败，则恢复之前的 `kiro-cli` 会话。 |
| `google-antigravity` | `google` | `https://daily-cloudcode-pa.googleapis.com` | 通过 Cloud Code Assist 协议使用 Google OAuth。 |
| `cursor` | `cursor` | `https://api2.cursor.sh` | 实验性 PKCE 登录、HTTP/2 传输和按账号筛选的模型发现。 |
| `github-copilot` | `openai-chat` | `https://api.githubcopilot.com` | 实验性。GitHub 设备流 + `copilot_internal` 交换（VS Code OAuth 客户端）。需要有效的 Copilot 订阅；不是官方第三方 API。 |

对于规范的 Kimi Coding Plan 预设（`kimi` 账号登录和 `kimi-code` API key），opencodex
只会把调用方提供的稳定 `prompt_cache_key` 转发到 Chat Completions 请求，绝不自行生成。Kimi
文档要求使用稳定的会话/任务 key 来提高 Code Plan 缓存命中率；没有 key 的请求仍保持不带 key。
若已 opt-in 的上游拒绝该字段，opencodex 不会删除字段后重试，也不会改动已保存配置；其他
provider 仍保持 deny-by-default。

你也可以从 [web 仪表盘](/zh-cn/guides/web-dashboard/) 启动 OAuth。

### 多个 OAuth 账号

OAuth 凭据中带有稳定账号 id 或邮箱的提供商可以保存多个登录。Providers 页面会在下拉列表中显示这些
账号，允许继续添加，并在不登出其他账号的情况下切换当前账号。只有没有身份信息的 Kimi 凭据会替换
当前 active slot；Kiro 账户以配置文件 ARN 为键。`chatgpt` 始终只有一个 slot，因为 Codex 账号池使用独立存储。令牌仍保存在
`~/.opencodex/auth.json` 中；`/api/oauth/accounts` 只返回脱敏后的 metadata。

### Kiro 凭据导入

Kiro 登录需要 Kiro CLI：Unix 使用 `curl -fsSL https://cli.kiro.dev/install | bash` 安装；Windows PowerShell 使用 `irm 'https://cli.kiro.dev/install.ps1' | iex`；然后先运行 `kiro-cli login`。如果没有 `kiro-cli` 会话，`ocx login kiro` 会回退到粘贴的访问令牌或 `KIRO_ACCESS_TOKEN` 环境变量。

普通的 `ocx login kiro` 导入会以只读方式打开 CLI SQLite 数据库，不修改数据库、WAL 或 SHM。

- `KIROCLI_DB_PATH` 用于选择非标准位置的 Kiro CLI SQLite 数据库；指定的数据库必须已经存在。
- `KIROCLI_TOKEN_KEY` 在存在多个含糊的令牌行时选择确切的 `auth_kv` 行键。缺少选择值时，登录会失败而不会猜测。

导入的凭据会保存到 `~/.opencodex/auth.json`。**添加账户**的回滚是独立流程：恢复之前的快照时会替换数据库，并删除当前的 WAL、SHM 和 journal 边车文件。

由于回滚依赖快照，当会话存储已存在但无法捕获时（文件不可读、架构不匹配、令牌选择有歧义），当 `KIROCLI_DB_PATH` / `KIRO_CLI_DB_FILE` 将导入路径指向与活动 CLI 存储不同的位置时，或当主 CLI 数据库没有可识别的令牌行时，**添加账户**会拒绝将 `kiro-cli` 登出。请修复或删除常规 `kiro-cli` 数据路径下的损坏数据库，并取消仅用于导入的选择器后重试。对于完全没有现有 `kiro-cli` 会话的机器，不受影响。

## 3. API 密钥目录

opencodex 内置 66 个预设：55 个密钥预设、7 个 OAuth 预设、3 个本地预设，以及默认的
ChatGPT 转发预设。仪表盘的 **Add provider** 选择器会打开密钥提供商的控制台，验证并保存密钥。
主要条目包括：

| 提供商 | 基础 URL |
| --- | --- |
| **OpenAI (API key)** | `https://api.openai.com/v1` |
| **Anthropic (API key)** | `https://api.anthropic.com` |
| **OpenRouter** | `https://openrouter.ai/api/v1` |
| **Ollama Cloud** | `https://ollama.com/v1` |
| Google Gemini · Google Vertex AI | `https://generativelanguage.googleapis.com` · `https://aiplatform.googleapis.com` |
| Azure OpenAI | `https://{resource}.openai.azure.com/openai` |
| Umans AI · Neuralwatt | `https://api.code.umans.ai` · `https://api.neuralwatt.com/v1` |
| Mistral | `https://api.mistral.ai/v1` |
| MiniMax · MiniMax (CN) | `https://api.minimax.io/v1` · `https://api.minimaxi.com/v1` |
| DeepSeek | `https://api.deepseek.com` |
| Cerebras | `https://api.cerebras.ai/v1` |
| DeepInfra | `https://api.deepinfra.com/v1/openai` |
| Hyperbolic | `https://api.hyperbolic.xyz/v1` |
| Baseten Model APIs | `https://inference.baseten.co/v1` |
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
| Kilo | `https://api.kilo.ai/api/gateway` |
| GitLab Duo | `https://cloud.gitlab.com/ai/v1/proxy/openai/v1` |
| Cloudflare AI Gateway | `https://gateway.ai.cloudflare.com/v1/{account-id}/{gateway}/anthropic` |
| ……以及更多 | opencode zen、Vercel AI Gateway、Venice、NanoGPT、Synthetic、Qianfan、Alibaba、Parallel、ZenMux、LiteLLM |

大多数使用带 bearer 密钥的 `openai-chat` adapter；少数仅暴露 Anthropic 兼容端点的提供商（例如 **Xiaomi MiMo**）使用 `anthropic` adapter（`x-api-key`）。
火山方舟 Agent Plan 通过 `openai-responses` adapter 使用原生 Responses 端点。

> **三条火山方舟计费线路：**`volcengine` 是按量付费方舟 API，`volcengine-coding-plan`
> 消耗 Coding Plan 额度，`volcengine-agent-plan` 消耗 Agent Plan 额度。密钥与端点需要属于
> 同一产品；已经订阅 Plan 时调用普通 `/api/v3` 端点仍可能产生按量费用。
> 三个 preset 使用经过筛选的静态模型目录：方舟 `/models` 同时返回文本、Embedding、图片、
> 视频和 3D 资源，Coding 网关也会返回这份宽泛目录，Agent Plan 网关没有 `/models` 资源。
> 按量付费默认使用 `doubao-seed-2-1-pro-260628`，静态目录还包含当前 DeepSeek 和 GLM
> 文本模型。Coding Plan 默认使用 `ark-code-latest`，Agent Plan 默认使用
> `deepseek-v4-pro`。

**DeepInfra 发现：**`deepinfra` 是使用 `openai-chat` adapter 和 Bearer API 密钥的密钥型
OpenAI Chat Completions 提供商。registry 固定的 DeepInfra 模型列表 URL 仅保留带 `chat` 标签的记录，
同时保留含 `/` 的原生模型 id，并把实时发现限制为 512 KiB 和 512 条原始记录。
密钥可在 [DeepInfra 控制台](https://deepinfra.com/dash/api_keys)创建。

**Hyperbolic 发现：**该预设会使用已配置的 bearer 密钥读取 `/v1/models`，保留含 `/` 的原生模型 id，
并将实时发现限制为 256 KiB 和 256 条原始记录。它仅覆盖 serverless text 与 vision-language chat；独立的
image、audio 和 GPU 端点不在范围内。密钥可在 [Hyperbolic](https://app.hyperbolic.ai) 创建。

> **Baseten 范围：**该预设仅覆盖 Baseten 的共享 [Model APIs](https://docs.baseten.co/inference/model-apis/overview)。
> 本地使用可选择个人 [API 密钥](https://docs.baseten.co/organization/api-keys)；共享或生产用途请使用具备
> **Call Model APIs** 权限的团队密钥。
> 专用 Truss `predict` 端点使用不同的主机和请求 schema，不由此预设路由。
> 该预设的实时发现上限为 1 MiB 响应和 256 条原始模型记录。

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
| Codex 登录（Pool 或 Direct） | `gpt-5.6-*` | 372,000 |
| OpenAI (API key) | `openai-apikey/gpt-5.6-*` 和 `*-pro` | 1,050,000（max input 922,000） |
| OpenRouter | `openrouter/openai/gpt-5.6-sol`、`openrouter/openai/gpt-5.6-terra`、`openrouter/openai/gpt-5.6-luna` | 1,050,000 |
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

Cursor 作为单独的实验性 adapter 进行跟踪。`adapter: "cursor"` 会作为实验性本地配置出现在
`ocx init` 和 dashboard Add Provider picker 中，并保存 Cursor 的静态回退模型目录 metadata。配置
Cursor access token 后，opencodex 会使用 Cursor live HTTP/2 transport。内置回退列表包含上下文为
1M 的 `gpt-5.6-sol` / `terra` / `luna`、上下文为 500K 的 `grok-4.5` / `grok-4.5-fast`，以及上下文为
262K 的 `kimi-k3`；最终显示哪些模型由账号的实时发现结果决定。Cursor 只以带 effort 后缀的 wire id
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
