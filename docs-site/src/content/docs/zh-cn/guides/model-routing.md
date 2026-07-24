---
title: 模型路由
description: opencodex 如何决定由哪个提供商来服务给定的模型 id。
---

当 Codex 请求某个模型时，`router.ts` 会将其解析为唯一一个已配置的提供商。规则**按顺序**检查；第一个匹配者胜出。

OpenAI 的 bare `gpt-*` 使用单一 `openai` provider。`codexAccountMode` 在 Pool（默认，主账户加
添加账户）和 Direct（当前 caller/主登录 bearer）之间选择，模型 id 不变。
`openai-apikey/<model>` 显式使用 API key transport；两条凭证路径互不 fallback。

## 优先级

1. **显式 `provider/model`** —— 如果 id 包含 `/`，且斜杠前的部分是某个已配置提供商的名称，则使用该提供商，并将 id 截取为斜杠之后的部分。

   ```text
   anthropic/claude-opus-5     →  provider "anthropic",   model "claude-opus-5"
   ollama-cloud/glm-5.2        →  provider "ollama-cloud", model "glm-5.2"
   openrouter/openai/gpt-5.6-sol → provider "openrouter",  model "openai/gpt-5.6-sol"
   ```

   这是无歧义的写法，也是 Codex 的模型选择器对路由模型所使用的写法。如果指定的提供商已禁用，
   这种显式写法会直接抛出错误。

2. **某个提供商的 `defaultModel`** —— 如果任一提供商的 `defaultModel` 等于该 id，则使用该提供商（id 原样传递）。

3. **内置前缀模式** —— 将 id 与已知的模型系列前缀进行匹配，然后路由到名称（或名称前缀）与之相符的已配置提供商：

   | 前缀 | 提供商 |
   | --- | --- |
   | `claude-`、`claude-sonnet-`、`claude-opus-`、`claude-haiku-` | `anthropic` |
   | `gpt-`、`o1-`、`o3-`、`o4-` | bare id 使用已配置的 `openai` 账户模式；API key 显式使用 `openai-apikey/` |
   | `llama-`、`mixtral-`、`gemma-` | `groq` |

   该匹配器只检查名称。与 `defaultModel` / `models[]` 扫描不同，目前即使匹配提供商的 `disabled`
   为 true，它也不会跳过该提供商。

4. **某个提供商的 `models[]`** —— 如果前缀规则没有命中，而某个启用的提供商在 `models[]` 中列出
   该 id，则使用该提供商。这个顺序很重要：只要配置了 OpenAI 名称的提供商，裸 `gpt-*` id 就会在
   其他提供商的 `models[]` 声明之前路由到 OpenAI。

5. **默认提供商** —— 如果没有任何匹配，id 将原样发送给 `config.defaultProvider`。（如果未配置默认提供商，或默认提供商已禁用，路由会抛出异常。）

## API 密钥与环境变量

无论选择哪条路由，提供商的 `apiKey` 都会通过 `resolveEnvValue()` 解析：值为 `${OPENAI_API_KEY}` 或 `$OPENAI_API_KEY` 时会在请求时从环境中展开，因此密钥永远无需存放在 `config.json` 中。

## 目录可见性与上下文上限

请求路由和模型目录可见性由不同配置控制：

- `disabledModels` 会从 Codex 目录和 `/v1/models` 中隐藏带命名空间的路由 id。裸原生 GPT slug
  仍保留在目录中，但会改为 `visibility: "hide"`。它**不会**拒绝对该模型的直接请求。
- 提供商的非空 `selectedModels` 是另一层目录 allowlist。实时发现和直接路由仍然有效；它只会缩小
  目录和 `/v1/models` 输出的模型范围。
- `provider.disabled: true` 会把该提供商排除在目录发现之外。显式 `provider/model` 请求会失败，
  `defaultModel` / `models[]` 扫描也会跳过它。
- `providerContextCaps` 为各提供商设置 Codex 可见的上下文上限。`contextCapValue` 是仪表盘共用的值，
  默认为 350,000；但只有 `providerContextCaps` 中列出了提供商时才会生效。上限只能降低已知上下文，
  不会把它调高，也不会改变上游模型的实际限制。

```json
{
  "contextCapValue": 350000,
  "providerContextCaps": {
    "anthropic": 350000,
    "cursor": 350000
  }
}
```

## 提示

- **对路由模型使用显式写法。** 优先使用 `provider/model`（规则 1）——它无歧义，并且与目录同步后 Codex 在其选择器中显示的内容一致。
- **为提供商预置 `models[]` 或 `defaultModel`**，这样短 id（规则 2/4）无需 `provider/` 前缀即可解析。
- **前缀模式只是一种便利**，而非保证：只有当确实配置了同名（例如 `anthropic`、`openai`、`groq`）的提供商时，它们才会解析成功。

这些规则读取的提供商字段请参见 [配置](/zh-cn/reference/configuration/)。
