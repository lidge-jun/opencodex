---
title: 模型路由
description: opencodex 如何决定由哪个提供商来服务给定的模型 id。
---

当 Codex 请求某个模型时，`router.ts` 会将其解析为唯一一个已配置的提供商。规则**按顺序**检查；第一个匹配者胜出。

对于 OpenAI，已配置的 `<selector>/gpt-*` id 会先通过 `codexAccountNamespaces` 精确映射到一个
已存储 Codex 账户，然后才检查 combo 或 provider 命名空间。bare `gpt-*` id 则选择规范的
`openai` provider。其 `codexAccountMode` 在 Pool（默认，主账户加添加账户）和 Direct（当前
caller/主登录 bearer）之间选择，model id 保持不变。`openai-apikey/<model>` 显式使用 API key
transport；这些凭证路径互不 fallback。

## 优先级

1. **精确 Codex 账户 selector** —— 如果 id 是 `<selector>/<native-openai-model>`，且该 selector
   已在 `codexAccountNamespaces` 中配置，请求只使用映射的已存储账户，并向 upstream 发送 bare
   native model。若精确目标不可用，请求会 fail closed，不会继续尝试 Pool、Direct 或 provider
   routing。

   ```text
   side/gpt-5.6-sol → provider "openai", model "gpt-5.6-sol", account selector "side"
   ```

2. **Combo id 或 alias** —— 配置了至少一个 combo 时，规范的 `combo/<id>` 或已配置 combo alias
   会先选择具体目标，然后才检查 provider 命名空间。没有配置 combo 时，名称恰好为 `combo` 的 legacy
   physical provider 仍作为普通 provider 命名空间。目标选择与 failover 行为见
   [Combos](/zh-cn/guides/combos/)。

3. **显式 `provider/model`** —— 如果 id 包含 `/`，且斜杠前的部分是某个已配置提供商的名称，则使用该提供商，并将 id 截取为斜杠之后的部分。

   ```text
   anthropic/claude-opus-5     →  provider "anthropic",   model "claude-opus-5"
   ollama-cloud/glm-5.2        →  provider "ollama-cloud", model "glm-5.2"
   openrouter/openai/gpt-5.6-sol → provider "openrouter",  model "openai/gpt-5.6-sol"
   ```

   这是显式指定 routed provider 的写法，也是 Codex 模型选择器对路由模型所使用的写法。如果同一
   public id 也是已配置的 combo alias，则规则 2 优先。如果指定的 provider 已禁用，这种显式写法会
   直接抛出错误。

4. **Bare native OpenAI-family id** —— `gpt-*`、`o1-*`、`o3-*` 或 `o4-*` 等 id 使用规范且已启用的
   `openai` provider，以及其已配置的 Pool 或 Direct account mode。

5. **某个提供商的 `defaultModel`** —— 如果任一提供商的 `defaultModel` 等于该 id，则使用该提供商（id 原样传递）。

6. **内置前缀模式** —— 将 id 与已知的模型系列前缀进行匹配，然后路由到名称（或名称前缀）与之相符的已配置提供商：

   | 前缀 | 提供商 |
   | --- | --- |
   | `claude-`、`claude-sonnet-`、`claude-opus-`、`claude-haiku-` | `anthropic` |
   | `llama-`、`mixtral-`、`gemma-` | `groq` |

   该匹配器只检查名称。与 `defaultModel` / `models[]` 扫描不同，目前即使匹配提供商的 `disabled`
   为 true，它也不会跳过该提供商。

7. **某个提供商的 `models[]`** —— 如果前缀规则没有命中，而某个启用的提供商在 `models[]` 中列出
   该 id，则使用该提供商。规则 4 已经会在其他 provider 的 `models[]` 声明匹配前，把 bare `gpt-*`
   id 发送到规范且已启用的 `openai` provider。

8. **默认提供商** —— 如果没有任何匹配，id 将原样发送给 `config.defaultProvider`。（如果未配置默认提供商，或默认提供商已禁用，路由会抛出异常。）

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
- `providerContextCaps` 为各提供商设置 Codex 可见的上下文上限。`contextCapValue` 是仪表盘的默认值，
  默认为 350,000；但只有 `providerContextCaps` 中列出了提供商时才会生效。仅当勾选“应用到所有已路由的
  提供方”时，修改仪表盘值才会重新指向所有已启用提供商；否则每个提供商保留自己的上限。上限只能降低
  已知上下文，不会把它调高，也不会改变上游模型的实际限制。

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

- **要显式指定 Codex 账户，** 请使用 `<selector>/<native-openai-model>`（规则 1）。该路由是精确且
  fail closed 的，绝不会静默切换到其他账户。
- **对路由模型使用显式写法。** 当 exact public id 不是 combo alias 时，优先使用
  `provider/model`（规则 3）。它会直接指定 provider，并与 catalog 同步后 Codex 在 picker 中显示的
  内容一致。
- **为提供商预置 `models[]` 或 `defaultModel`**，这样短 id（规则 5/7）无需 `provider/` 前缀即可解析。
- **前缀模式只是一种便利**，而非保证：只有当确实配置了同名（例如 `anthropic` 或 `groq`）的提供商时，它们才会解析成功。

这些规则读取的提供商字段请参见 [配置](/zh-cn/reference/configuration/)。
