---
title: Model Routing
description: How opencodex decides which provider serves a given model id.
---

When Codex asks for a model, `router.ts` resolves it to exactly one configured provider. The rules are
checked **in order**; the first match wins.

For OpenAI, bare `gpt-*` ids select one `openai` provider. Its `codexAccountMode` chooses
Pool(default, main plus added accounts) or Direct(current caller/main bearer) without changing the
model id. `openai-apikey/<model>` explicitly selects API-key transport. The two credential routes
do not fall through to one another.

## Precedence

1. **Explicit `provider/model`** — if the id contains `/` and the part before it is the name of a
   configured provider, that provider is used and the id is stripped to the part after the slash.

   ```text
   anthropic/claude-opus-5     →  provider "anthropic",   model "claude-opus-5"
   ollama-cloud/glm-5.2        →  provider "ollama-cloud", model "glm-5.2"
   openrouter/openai/gpt-5.6-sol → provider "openrouter",  model "openai/gpt-5.6-sol"
   ```

   This is the unambiguous form, and the one Codex's model picker uses for routed models.
   If the named provider is disabled, this explicit form throws instead of routing.

2. **A provider's `defaultModel`** — if any provider's `defaultModel` equals the id, that provider
   is used (id passed through unchanged).

3. **Built-in prefix patterns** — the id is matched against known model-family prefixes, then routed
   to a configured provider of that name (or name-prefix):

   | Prefixes | Provider |
   | --- | --- |
   | `claude-`, `claude-sonnet-`, `claude-opus-`, `claude-haiku-` | `anthropic` |
   | `gpt-`, `o1-`, `o3-`, `o4-` | bare ids use the configured `openai` account mode; use `openai-apikey/` for API-key transport |
   | `llama-`, `mixtral-`, `gemma-` | `groq` |

   This matcher is name-based and, unlike the `defaultModel` / `models[]` scans, currently does not
   filter a matching provider whose `disabled` flag is true.

4. **A provider's `models[]`** — if no prefix rule won and an active provider lists the id in its
   `models[]`, that provider is used. This order matters: with an OpenAI-named provider configured,
   a bare `gpt-*` id reaches it before another provider's `models[]` claim.

5. **Default provider** — if nothing matched, the id is sent to `config.defaultProvider` unchanged.
   (If no default provider is configured, or it is disabled, routing throws.)

## API keys and environment variables

Whatever route is chosen, the provider's `apiKey` is resolved through `resolveEnvValue()`: a value of
`${OPENAI_API_KEY}` or `$OPENAI_API_KEY` is expanded from the environment at request time, so secrets
never need to live in `config.json`.

## Catalog visibility and context caps

Routing and catalog visibility are separate controls:

- `disabledModels` hides namespaced routed ids from the Codex catalog and `/v1/models`; a bare native
  GPT slug is kept in the catalog with `visibility: "hide"`. It does **not** reject a direct request
  for that model.
- A provider's non-empty `selectedModels` is another catalog allowlist. Live discovery and direct
  routing still work; only catalog and `/v1/models` emission are narrowed.
- `provider.disabled: true` removes that provider from catalog discovery. Explicit
  `provider/model` requests fail, and `defaultModel` / `models[]` scans skip it.
- `providerContextCaps` applies per-provider Codex-visible context caps. `contextCapValue` is the
  shared dashboard value (350,000 by default), but it does nothing by itself until a provider is
  present in `providerContextCaps`. Caps only lower a known context window; they never raise one or
  change the upstream model's actual limit.

```json
{
  "contextCapValue": 350000,
  "providerContextCaps": {
    "anthropic": 350000,
    "cursor": 350000
  }
}
```

## Tips

- **Be explicit for routed models.** Prefer `provider/model` (rule 1) — it's unambiguous and
  matches what Codex shows in its picker after a catalog sync.
- **Seed `models[]` or `defaultModel`** on a provider so short ids (rule 2/4) resolve without the
  `provider/` prefix.
- **Prefix patterns are a convenience**, not a guarantee: they only resolve if a provider with that
  name (e.g. `anthropic`, `openai`, `groq`) is actually configured.

See [Configuration](/reference/configuration/) for the provider fields these rules read.
