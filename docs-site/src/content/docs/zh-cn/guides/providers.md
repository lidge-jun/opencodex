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

只有一组精选的请求头会被转发（`FORWARD_HEADERS`：authorization、ChatGPT account id、OpenAI beta/originator/session——参见 [Adapters](/opencodex/zh-cn/reference/adapters/)）。这条路径也为 [web-search 和 vision sidecar](/opencodex/zh-cn/guides/sidecars/) 提供支持。

ChatGPT 透传目录也会加入 GPT-5.6 Sol/Terra/Luna 的裸 slug（`gpt-5.6-sol`、
`gpt-5.6-terra`、`gpt-5.6-luna`）；账号具备相应权限时才能实际调用。

## 2. 账号登录（OAuth）

有六个提供商预设使用 OAuth 登录。opencodex 会把凭据存入 `~/.opencodex/auth.json` 并自动刷新。
登录 CLI 也接受 `chatgpt`：它会获取一份 ChatGPT 凭据，并创建一个 `forward` 模式的提供商条目。

```bash
ocx login xai          # xAI Grok
ocx login anthropic    # Anthropic Claude (Pro/Max)
ocx login kimi         # Moonshot Kimi
ocx login kiro         # 导入 kiro-cli 凭据（支持令牌回退）
ocx login google-antigravity
ocx login cursor       # 独立的 Cursor PKCE 登录
ocx login chatgpt      # 独立的 ChatGPT OAuth 登录
ocx logout <provider>
```

| 提供商 | Adapter | 基础 URL | 备注 |
| --- | --- | --- | --- |
| `xai` | `openai-chat` | `https://api.x.ai/v1` | 优先使用实时 Grok 目录；回退默认模型为 `grok-4.5`。 |
| `anthropic` | `anthropic` | `https://api.anthropic.com` | Claude 模型；实时模型列表从 `/v1/models` 获取。 |
| `kimi` | `openai-chat` | `https://api.kimi.com/coding/v1` | Kimi K2.7/K2.6/K2.5 编程模型。 |
| `kiro` | `kiro` | `https://runtime.us-east-1.kiro.dev` | 优先复用已安装的 `kiro-cli` 登录。 |
| `google-antigravity` | `google` | `https://daily-cloudcode-pa.googleapis.com` | 通过 Cloud Code Assist 协议使用 Google OAuth。 |
| `cursor` | `cursor` | `https://api2.cursor.sh` | 实验性 PKCE 登录、HTTP/2 传输和按账号筛选的模型发现。 |

你也可以从 [web 仪表盘](/opencodex/zh-cn/guides/web-dashboard/) 启动 OAuth。

### 多个 OAuth 账号

OAuth 凭据中带有稳定账号 id 或邮箱的提供商可以保存多个登录。Providers 页面会在下拉列表中显示这些
账号，允许继续添加，并在不登出其他账号的情况下切换当前账号。没有身份信息的 Kimi 和 Kiro 会替换
当前 active slot；`chatgpt` 始终只有一个 slot，因为 Codex 账号池使用独立存储。令牌仍保存在
`~/.opencodex/auth.json` 中；`/api/oauth/accounts` 只返回脱敏后的 metadata。

## 3. API 密钥目录

opencodex v2.7.1 内置 50 个预设：40 个密钥预设、6 个 OAuth 预设、3 个本地预设，以及默认的
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
| Together | `https://api.together.xyz/v1` |
| Fireworks | `https://api.fireworks.ai/inference/v1` |
| Moonshot (Kimi API) · Kimi (coding) | `https://api.moonshot.ai/v1` · `https://api.kimi.com/coding/v1` |
| Hugging Face | `https://router.huggingface.co/v1` |
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` |
| Z.AI (GLM Coding) | `https://api.z.ai/api/coding/paas/v4` |
| Qwen Cloud | Token plan（默认）: `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` · 按量付费: `https://dashscope.aliyuncs.com/compatible-mode/v1` · 或自定义 |
| Xiaomi MiMo | `https://api.xiaomimimo.com/anthropic` |
| Kilo | `https://api.kilo.ai/api/gateway` |
| GitHub Copilot · GitLab Duo | `https://api.githubcopilot.com` · `https://cloud.gitlab.com/ai/v1/proxy/openai/v1` |
| Cloudflare AI Gateway | `https://gateway.ai.cloudflare.com/v1/{account-id}/{gateway}/anthropic` |
| ……以及更多 | opencode zen、Vercel AI Gateway、Venice、NanoGPT、Synthetic、Qianfan、Alibaba、Parallel、ZenMux、LiteLLM |

大多数使用带 bearer 密钥的 `openai-chat` adapter；少数仅暴露 Anthropic 兼容端点的提供商（例如 **Xiaomi MiMo**）使用 `anthropic` adapter（`x-api-key`）。

### 多个 API 密钥

基于密钥的提供商也可以保存多个 key。通过 Providers 页面添加密钥时，它会存入
`provider.apiKeyPool`、被设为 active，并同步到 `provider.apiKey`，这样路由和 adapter 仍读取原来的
字段。同一个下拉列表可以切换或移除密钥；管理 API 是 `/api/providers/keys`，并且只返回脱敏后的密钥。

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
Cursor access token 后，opencodex 会使用 Cursor live HTTP/2 transport。v2.7.1 回退列表包含上下文为
1M 的 `gpt-5.6-sol` / `terra` / `luna`，以及上下文为 500K 的
`grok-4.5` / `grok-4.5-fast`；最终显示哪些模型由账号的实时发现结果决定。Cursor 服务器直接发起的
native read/write/delete/ls/grep/shell/fetch 执行默认禁用，因为它会绕过 Codex 的 approval 和
sandbox 路径；只有在可信本地实验中，才应在 `~/.opencodex/config.json` 的 `providers.cursor`
对象上设置 `unsafeAllowNativeLocalExec: true`，也可以在仪表盘的 **Providers → Cursor → Edit JSON**
中设置。完整示例参见 [配置参考](/opencodex/zh-cn/reference/configuration/#cursor-provider-adapter-cursor)。MCP、屏幕录制和 computer-use
通过 executor hook 暴露；没有配置本地 executor 时，opencodex 会返回 typed no-executor 结果。
Cursor OAuth 和 live model discovery 已在这个实验性 adapter 中启用；Cursor 仍不会出现在 key-login
列表中。
:::

### Ollama Cloud

Ollama Cloud 是托管（而非本地）的 Ollama，在 `https://ollama.com/v1` 上兼容 OpenAI，密钥来自 [ollama.com/settings/keys](https://ollama.com/settings/keys)。opencodex 按视觉能力对其云端阵容进行分类，使 [vision sidecar](/opencodex/zh-cn/guides/sidecars/) 仅对纯文本模型生效。纯文本模型（例如 `glm-5.2`、`deepseek-v4-pro`、`gpt-oss`、`qwen3-coder`、`minimax-m2.x`、`nemotron-3-*`）列在 `noVisionModels` 中；原生支持视觉的模型（例如 `kimi-k2.6`、`minimax-m3`、`gemma4`、`qwen3.5`、`gemini-3-flash-preview`）则不在其中。匹配能容忍 Ollama 的 `:size` 标签，因此 `gpt-oss` 涵盖 `gpt-oss:120b` 和 `gpt-oss:20b`。

### 手动输入模型

在 Add Provider 对话框中，你可以选择**手动设置**来代替自动发现。
手动模式会向 provider 配置写入 `liveModels: false` 和 `models` 列表，并且不会发起 `/models` 请求。你输入的 ID 就是 Codex 看到的全部模型。
详情请参见 [配置参考](/opencodex/zh-cn/reference/configuration/)。

## 4. 本地提供商

让 opencodex 指向本地的 OpenAI 兼容服务器——通常使用空密钥：

| 提供商 | 基础 URL |
| --- | --- |
| Ollama (local) | `http://localhost:11434/v1` |
| vLLM | `http://localhost:8000/v1` |
| LM Studio | `http://localhost:1234/v1` |

## 任意 OpenAI 兼容端点

如果某个提供商使用 Chat Completions，`openai-chat` adapter 即可处理它——在仪表盘中选择 **Custom**，或在 `ocx init` 中选择 `custom` 并输入基础 URL。每个提供商字段（`headers`、`noReasoningModels`、`noVisionModels`、`models`……）请参见 [配置参考](/opencodex/zh-cn/reference/configuration/)。
