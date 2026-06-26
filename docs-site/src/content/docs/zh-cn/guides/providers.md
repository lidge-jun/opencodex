---
title: 提供商
description: opencodex 进行身份验证并与 LLM 提供商通信的所有方式——OAuth、API 密钥、ChatGPT 转发以及本地。
---

**提供商（provider）** 是一个上游 LLM 端点，加上访问它的方式：一个 adapter、一个基础 URL、一种认证模式，以及一个可选的模型列表。提供商配置位于 `~/.opencodex/config.json` 的 `providers` 下。

## 认证模式

每个提供商都有一个 `authMode`（默认为 `key`）：

| `authMode` | 如何进行认证 | 使用方 |
| --- | --- | --- |
| `key` | 发送你的 API 密钥（`Authorization: Bearer …`，或按 adapter 使用 `x-api-key` / `api-key`）。密钥可以是字面值，也可以是 `${ENV_VAR}` 引用。 | 大多数提供商。 |
| `forward` | 将**你传入的 Codex 认证请求头**原样转发给提供商——不存储任何密钥。这就是 ChatGPT 登录的透传方式。 | OpenAI（`openai-responses` adapter）。 |
| `oauth` | 解析已存储的 OAuth 访问令牌（在过期前自动刷新）并将其用作 bearer 密钥。 | xAI、Anthropic、Kimi。 |

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

## 2. 账号登录（OAuth）

有三个提供商支持真正的账号登录。opencodex 将凭据存储在 `~/.opencodex/auth.json` 中并自动刷新：

```bash
ocx login xai          # xAI Grok
ocx login anthropic    # Anthropic Claude (Pro/Max)
ocx login kimi         # Moonshot Kimi
ocx logout <provider>
```

| 提供商 | Adapter | 基础 URL | 备注 |
| --- | --- | --- | --- |
| `xai` | `openai-chat` | `https://api.x.ai/v1` | Grok 模型；部分模型没有 reasoning 参数（自动处理）。 |
| `anthropic` | `anthropic` | `https://api.anthropic.com` | Claude 模型；实时模型列表从 `/v1/models` 获取。 |
| `kimi` | `openai-chat` | `https://api.kimi.com/coding/v1` | Kimi K2 系列。 |

你也可以从 [web 仪表盘](/opencodex/zh-cn/guides/web-dashboard/) 启动 OAuth。

## 3. API 密钥目录

opencodex 内置了一个基于密钥的提供商目录（大多数兼容 OpenAI，少数兼容 Anthropic）。仪表盘的 **Add provider** 选择器会打开该提供商的密钥仪表盘，验证密钥并将其存储。值得注意的条目：

| 提供商 | 基础 URL |
| --- | --- |
| **Ollama Cloud** | `https://ollama.com/v1` |
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
| Qwen Portal | `https://portal.qwen.ai/v1` |
| Xiaomi MiMo | `https://api.xiaomimimo.com/anthropic` |
| Kilo | `https://api.kilo.ai/api/gateway` |
| GitHub Copilot · GitLab Duo | `https://api.githubcopilot.com` · `https://cloud.gitlab.com/ai/v1/proxy/openai/v1` |
| Cloudflare AI Gateway | `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/anthropic` |
| ……以及更多 | opencode zen、Vercel AI Gateway、Venice、NanoGPT、Synthetic、Qianfan、Alibaba、Parallel、ZenMux、LiteLLM |

大多数使用带 bearer 密钥的 `openai-chat` adapter；少数仅暴露 Anthropic 兼容端点的提供商（例如 **Xiaomi MiMo**）使用 `anthropic` adapter（`x-api-key`）。

:::note[gateway 与订阅 proxy]
只要某个提供商使用 opencodex 能够 proxy 的标准 streaming API（`openai-completions`、`anthropic-messages`、`openai-responses`、Azure 或 Gemini），它就会被收录——而**不是**根据它是否是一款"agent"产品来判断。使用专有协议、没有对应 opencodex adapter 的提供商会被排除：Gemini CLI / Antigravity、Vertex AI、Amazon Bedrock，以及 Codex 后端本身。**GitHub Copilot** 和 **GitLab Duo** 是多模型 gateway，映射到它们通用的 OpenAI 兼容端点；它们使用 Bearer **订阅令牌**（而非普通 API 密钥）进行认证，并且 Copilot 可能需要通过该提供商的 `headers` 设置 `User-Agent` 请求头。**Cloudflare AI Gateway** 需要将你的 account 和 gateway id 填入 URL。

Cursor 作为单独的实验性 adapter scaffold 进行跟踪。源码中已经存在 `adapter: "cursor"`，但 live
OAuth、模型 discovery、HTTP/2 transport 和 native tool 执行在 bridge 审计完成前都保持禁用。Cursor
目前不会出现在 provider picker 或 OAuth login 列表中；手动 Cursor 配置也会以 disabled-transport
错误 fail-closed。
:::

### Ollama Cloud

Ollama Cloud 是托管（而非本地）的 Ollama，在 `https://ollama.com/v1` 上兼容 OpenAI，密钥来自 [ollama.com/settings/keys](https://ollama.com/settings/keys)。opencodex 按视觉能力对其云端阵容进行分类，使 [vision sidecar](/opencodex/zh-cn/guides/sidecars/) 仅对纯文本模型生效。纯文本模型（例如 `glm-5.2`、`deepseek-v4-pro`、`gpt-oss`、`qwen3-coder`、`minimax-m2.x`、`nemotron-3-*`）列在 `noVisionModels` 中；原生支持视觉的模型（例如 `kimi-k2.6`、`minimax-m3`、`gemma4`、`qwen3.5`、`gemini-3-flash-preview`）则不在其中。匹配能容忍 Ollama 的 `:size` 标签，因此 `gpt-oss` 涵盖 `gpt-oss:120b` 和 `gpt-oss:20b`。

## 4. 本地提供商

让 opencodex 指向本地的 OpenAI 兼容服务器——通常使用空密钥：

| 提供商 | 基础 URL |
| --- | --- |
| Ollama (local) | `http://localhost:11434/v1` |
| vLLM | `http://localhost:8000/v1` |
| LM Studio | `http://localhost:1234/v1` |

## 任意 OpenAI 兼容端点

如果某个提供商使用 Chat Completions，`openai-chat` adapter 即可处理它——在仪表盘中选择 **Custom**，或在 `ocx init` 中选择 `custom` 并输入基础 URL。每个提供商字段（`headers`、`noReasoningModels`、`noVisionModels`、`models`……）请参见 [配置参考](/opencodex/zh-cn/reference/configuration/)。
