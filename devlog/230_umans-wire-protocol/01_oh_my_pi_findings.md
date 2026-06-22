# 230.1 Oh My Pi Umans implementation findings

## Goal

Inspect how `can1357/oh-my-pi` implements Umans, specifically whether it treats Umans as an
OpenAI-compatible Chat Completions provider or as an Anthropic Messages provider.

Repository:

- https://github.com/can1357/oh-my-pi

Local reference clone:

- `/Users/jun/Developer/new/700_projects/jawcode/devlog/_upstream_omp`
- Checked at `cc0c67beb chore: bump version to 16.1.13`
- `git status --short --branch`: `## main...origin/main`

## Summary

Oh My Pi treats Umans as an **Anthropic Messages** provider.

It does not make Umans' coding-plan login validate against `/v1/chat/completions`. It validates
the pasted key against:

- `POST https://api.code.umans.ai/v1/messages`
- `anthropic-version: 2023-06-01`
- `x-api-key: <umans key>`
- model: `umans-coder`

Its catalog also maps Umans models to:

- `api: "anthropic-messages"`
- `provider: "umans"`
- `baseUrl: "https://api.code.umans.ai"`

This strongly supports making opencodex's first-class Umans preset use the `anthropic` adapter,
not the `openai-chat` adapter.

## Evidence

### Provider registry

Source:

- https://github.com/can1357/oh-my-pi/blob/main/packages/ai/src/registry/umans.ts
- `/Users/jun/Developer/new/700_projects/jawcode/devlog/_upstream_omp/packages/ai/src/registry/umans.ts`

Observed implementation:

```ts
export const loginUmans = createApiKeyLogin({
  providerLabel: "Umans AI Coding Plan",
  authUrl: "https://app.umans.ai/billing",
  instructions: "Create or copy your Umans API key from Dashboard -> API Keys.",
  promptMessage: "Paste your Umans API key",
  placeholder: "sk-...",
  validation: {
    kind: "anthropic-messages",
    provider: "Umans AI Coding Plan",
    baseUrl: "https://api.code.umans.ai",
    model: "umans-coder",
  },
});

export const umansProvider = {
  id: "umans",
  name: "Umans AI Coding Plan",
  login: (cb: OAuthLoginCallbacks) => loginUmans(cb),
};
```

Interpretation:

- The provider id is `umans`.
- The user-facing login is API-key paste, not OAuth.
- Validation kind is `anthropic-messages`.
- Base URL intentionally omits `/v1`; the Anthropic client appends `/v1/messages`.

### API-key validation test

Source:

- https://github.com/can1357/oh-my-pi/blob/main/packages/ai/test/umans-login.test.ts
- `/Users/jun/Developer/new/700_projects/jawcode/devlog/_upstream_omp/packages/ai/test/umans-login.test.ts`

Observed assertions:

```ts
expect(url).toBe("https://api.code.umans.ai/v1/messages");
expect(init?.method).toBe("POST");
expect(headers.get("content-type")).toBe("application/json");
expect(headers.get("anthropic-version")).toBe("2023-06-01");
expect(headers.get("x-api-key")).toBe("sk-umans-valid");
expect(headers.get("authorization")).toBeNull();
expect(body.model).toBe("umans-coder");
expect(body.max_tokens).toBe(1);
```

Interpretation:

- Oh My Pi explicitly forbids Bearer auth for this validation path.
- It validates using `x-api-key`.
- It validates with `umans-coder`, not `umans-kimi-k2.7`.

### Catalog mapping test

Source:

- https://github.com/can1357/oh-my-pi/blob/main/packages/catalog/test/umans-provider.test.ts

Observed assertions:

```ts
expect(model).toMatchObject({
  id: "umans-coder",
  api: "anthropic-messages",
  provider: "umans",
  baseUrl: "https://api.code.umans.ai",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 262_144,
  maxTokens: 32_768,
  thinking: { defaultLevel: "medium" },
  compat: { escapeBuiltinToolNames: true },
});
```

For `umans-kimi-k2.7`:

```ts
expect(mandatoryReasoningModel).toMatchObject({
  id: "umans-kimi-k2.7",
  reasoning: true,
  maxTokens: 32_768,
  thinking: { defaultLevel: "medium", requiresEffort: true },
  compat: { escapeBuiltinToolNames: true },
});
```

Interpretation:

- Oh My Pi models Umans Kimi as mandatory-reasoning Anthropic Messages.
- It adds `compat.escapeBuiltinToolNames: true` for Umans.
- It caps `umans-kimi-k2.7` max output at 32,768 despite some public metadata showing larger plan
  ceilings.

### Dynamic model discovery

Source:

- https://github.com/can1357/oh-my-pi/blob/main/packages/catalog/src/provider-models/openai-compat.ts

Observed implementation:

- `UMANS_BASE_URL = "https://api.code.umans.ai"`
- `UMANS_MODELS_INFO_PATH = "/models/info"`
- `umansModelManagerOptions()` returns `ModelManagerOptions<"anthropic-messages">`
- dynamic discovery fetches:
  - `GET https://api.code.umans.ai/v1/models/info`
  - optional `x-api-key`
- every mapped Umans model has:
  - `api: "anthropic-messages"`
  - `provider: "umans"`
  - `baseUrl: "https://api.code.umans.ai"`
  - `compat.escapeBuiltinToolNames: true`

Important comment:

```ts
// Umans `models/info` reports `supports_vision: true` for natively
// vision-capable models and a non-empty string sentinel (e.g.
// `"via-handoff"`) for models that route image inputs through a vision
// handoff pre-analysis step instead of accepting raw image blocks. Only
// `true` means the model accepts image content directly; sentinel values
// MUST map to text-only ...
```

Interpretation:

- Umans has a custom `/v1/models/info` endpoint with richer capability metadata.
- `supports_vision: "via-handoff"` must not be treated as native image support.
- Oh My Pi drops cached/stale GLM rows if static metadata says those rows are text-only.

### Host compatibility

Source:

- https://github.com/can1357/oh-my-pi/blob/main/packages/catalog/src/hosts.ts
- https://github.com/can1357/oh-my-pi/blob/main/packages/catalog/src/compat/anthropic.ts

Observed implementation:

```ts
umans: { providers: ["umans"], urlMarkers: ["api.code.umans.ai"] }
```

Anthropic compat sets:

```ts
escapeBuiltinToolNames: modelMatchesHost(spec, "umans")
```

Interpretation:

- Umans is a known host class.
- Built-in tool names are escaped for Umans on the Anthropic Messages path.
- This is likely a defensive fix for provider-side reserved/built-in Anthropic tool names.

### Bundled model snapshot

Source:

- https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/catalog/src/models.json

Observed Umans models:

- `umans-coder`
- `umans-flash`
- `umans-glm-5.1`
- `umans-glm-5.2`
- `umans-kimi-k2.6`
- `umans-kimi-k2.7`
- `umans-qwen3.6-35b-a3b`

All are bundled as:

```json
{
  "api": "anthropic-messages",
  "provider": "umans",
  "baseUrl": "https://api.code.umans.ai",
  "reasoning": true,
  "compat": {
    "escapeBuiltinToolNames": true
  }
}
```

Notable model metadata:

- `umans-coder`: text+image, context 262,144, maxTokens 32,768, thinking requires effort.
- `umans-kimi-k2.7`: text+image, context 262,144, maxTokens 32,768, thinking requires effort.
- `umans-glm-5.1` and `umans-glm-5.2`: text-only, because image support is treated as
  via-handoff, not native image blocks.
- `umans-glm-5.2`: context 405,504, maxTokens 131,071.

## Implications for opencodex

### 1. Default Umans preset should be `anthropic`

Recommended opencodex provider seed:

```json
{
  "adapter": "anthropic",
  "baseUrl": "https://api.code.umans.ai",
  "authMode": "key",
  "defaultModel": "umans-coder",
  "models": [
    "umans-coder",
    "umans-kimi-k2.7",
    "umans-kimi-k2.6",
    "umans-flash",
    "umans-glm-5.2",
    "umans-glm-5.1",
    "umans-qwen3.6-35b-a3b"
  ]
}
```

### 2. opencodex may need an Umans-specific Anthropic compat flag

Oh My Pi sets `escapeBuiltinToolNames: true` for Umans. opencodex currently only has generic
Anthropic tool mapping and does not expose an equivalent provider flag. If issue #18 includes
tool/file-change instability on Umans, this is a concrete compatibility gap to inspect.

Patch direction:

- Add an optional provider flag such as `escapeBuiltinToolNames?: boolean`, or hard-code for provider
  id/base URL `umans` / `api.code.umans.ai`.
- Apply it only inside the Anthropic adapter's tool-name mapping path.

### 3. Umans dynamic model metadata should prefer `/v1/models/info`

Oh My Pi does not rely only on generic `/models`. It uses:

- `GET https://api.code.umans.ai/v1/models/info`

Patch direction:

- For opencodex, a first pass can ship static model metadata in `PROVIDER_REGISTRY`.
- A second pass can add Umans-specific live metadata enrichment for context/output/vision/thinking
  flags.

### 4. `openai-chat` should remain an advanced fallback only

Umans does expose Chat Completions, but Oh My Pi's coding-agent path deliberately chooses
Anthropic Messages. For opencodex/Codex, the safer UX is:

- default: `umans` -> `anthropic`
- optional advanced: `umans-openai` -> `openai-chat`

## Conclusion

Oh My Pi strongly confirms the previous opencodex research:

- Umans should be treated as an Anthropic Messages provider for coding-agent usage.
- API-key validation should call `/v1/messages` with `x-api-key`, not `/chat/completions` with
  Bearer.
- Umans model metadata should include mandatory reasoning, text-only GLM via-handoff handling, and
  built-in tool-name escaping.

For opencodex, the next implementation should add a first-class Umans provider preset using the
`anthropic` adapter and then test issue #18 against that path before attempting duplicate-suppression
logic in the OpenAI Chat adapter.
