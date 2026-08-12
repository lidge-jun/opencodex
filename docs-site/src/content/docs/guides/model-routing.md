---
title: Model Routing
description: How opencodex decides which provider serves a given model id.
---

When Codex asks for a model, `router.ts` resolves it to exactly one configured provider. The rules are
checked **in order**; the first match wins.

For OpenAI, a configured `<selector>/gpt-*` id maps through `codexAccountNamespaces` to exactly one
stored Codex account before combo or provider namespaces are considered. Bare `gpt-*` ids select
the canonical `openai` provider instead. Its `codexAccountMode` chooses Pool (default, main plus
added accounts) or Direct (current caller/main bearer) without changing the model id.
`openai-apikey/<model>` explicitly selects API-key transport. These credential routes do not fall
through to one another.

## Precedence

1. **Exact Codex account selector** — if the id is
   `<selector>/<native-openai-model>` and the selector is configured in `codexAccountNamespaces`,
   the request uses only the mapped stored account and sends the bare native model upstream.
   Unavailable exact targets fail closed instead of continuing through Pool, Direct, or provider
   routing.

   ```text
   side/gpt-5.6-sol → provider "openai", model "gpt-5.6-sol", account selector "side"
   ```

2. **Combo id or alias** — while at least one combo is configured, a canonical `combo/<id>` or
   configured combo alias selects its concrete target before provider namespaces are checked. With
   no configured combos, a legacy physical provider literally named `combo` remains a normal
   provider namespace. See [Combos](/guides/combos/) for target selection and failover behavior.

3. **Explicit `provider/model`** — if the id contains `/` and the part before it is the name of a
   configured provider, that provider is used and the id is stripped to the part after the slash.

   ```text
   anthropic/claude-opus-5     →  provider "anthropic",   model "claude-opus-5"
   ollama-cloud/glm-5.2        →  provider "ollama-cloud", model "glm-5.2"
   openrouter/openai/gpt-5.6-sol → provider "openrouter",  model "openai/gpt-5.6-sol"
   ```

   This is the explicit routed-provider form, and the one Codex's model picker uses for routed
   models. If the same public id is a configured combo alias, rule 2 wins. If the named provider is
   disabled, this explicit form throws instead of routing.

4. **Bare native OpenAI-family id** — an id such as `gpt-*`, `o1-*`, `o3-*`, or `o4-*` uses the
   canonical enabled `openai` provider and its configured Pool or Direct account mode.

5. **A provider's `defaultModel`** — if any provider's `defaultModel` equals the id, that provider
   is used (id passed through unchanged).

6. **Built-in prefix patterns** — the id is matched against known model-family prefixes, then routed
   to a configured provider of that name (or name-prefix):

   | Prefixes | Provider |
   | --- | --- |
   | `claude-`, `claude-sonnet-`, `claude-opus-`, `claude-haiku-` | `anthropic` |
   | `llama-`, `mixtral-`, `gemma-` | `groq` |

   This matcher is name-based and, unlike the `defaultModel` / `models[]` scans, currently does not
   filter a matching provider whose `disabled` flag is true.

7. **A provider's `models[]`** — if no prefix rule won and an active provider lists the id in its
   `models[]`, that provider is used. Rule 4 already sends a bare `gpt-*` id to the canonical enabled
   `openai` provider before another provider's `models[]` claim can match.

8. **Default provider** — if nothing matched, the id is sent to `config.defaultProvider` unchanged.
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
  dashboard default (350,000 by default), but it does nothing by itself until a provider is
  present in `providerContextCaps`. Changing the dashboard value re-points every enabled provider
  only when "apply to every routed provider" is toggled on; otherwise each provider keeps its own
  cap. Caps only lower a known context window; they never raise one or change the upstream model's
  actual limit.

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

- **Target a Codex account explicitly** with `<selector>/<native-openai-model>` (rule 1). That route
  is exact and fails closed; it never silently switches to another account.
- **Be explicit for routed models.** Prefer `provider/model` (rule 3) when that exact public id is
  not a combo alias. It directly names the provider and matches what Codex shows in its picker after
  a catalog sync.
- **Seed `models[]` or `defaultModel`** on a provider so short ids (rules 5/7) resolve without the
  `provider/` prefix.
- **Prefix patterns are a convenience**, not a guarantee: they only resolve if a provider with that
  name (e.g. `anthropic` or `groq`) is actually configured.

See [Configuration](/reference/configuration/) for the provider fields these rules read.
