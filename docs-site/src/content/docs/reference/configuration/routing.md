---
title: Routing Configuration
description: Default-provider selection, model resolution order, combo aliases, target ordering, and effort defaults.
---

Routing turns the model id sent by a client into one concrete provider and upstream model.

## Top-level routing fields

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `defaultProvider` | `string` | `"openai"` | Final provider used when no earlier model rule matches. It must name an enabled configured provider. |
| `combos?` | `Record<string, OcxComboConfig>` | `{}` | Virtual `combo/<id>` models built from ordered provider/model targets. |

## Model resolution order

opencodex resolves the requested model in this order:

1. A configured `<account-selector>/<native-openai-model>` namespace, routed through exactly the
   mapped stored Codex account. An invalid or unavailable exact target fails closed.
2. A canonical `combo/<id>` or configured combo alias. Canonical ids win before alias matching.
3. An explicit `<provider>/<model>` namespace whose prefix names a configured provider.
4. A bare native OpenAI-family id such as `gpt-*`, `o1-*`, `o3-*`, or `o4-*`, routed through the
   canonical enabled `openai` provider.
5. An exact match for a provider's `defaultModel`.
6. A known provider-family model prefix.
7. An exact model in a provider's configured `models` list.
8. `defaultProvider`, preserving the requested model id.

Disabled providers are excluded. An explicit namespace for a disabled provider fails instead of
falling through. Provider entries are checked in their JSON insertion order for rules that can match
more than one provider, so use explicit namespaces when a bare model could be ambiguous.

## Exact Codex account selectors

`codexAccountNamespaces` maps a public selector such as `side` to one stored Codex account. A
request for `side/gpt-5.6-sol` uses only that account, even when the canonical `openai` provider is
in Direct mode, and sends the bare `gpt-5.6-sol` model id upstream. Only bare native OpenAI-family
ids are valid after the selector.

Exact selection bypasses Pool assignment strategy and ordinary thread affinity. If the mapped
account is missing, paused, cooling down, unusable, or requires reauthentication, the request fails
closed instead of switching accounts and does not change the active Pool account. Bare native model
ids retain normal Pool/Direct routing. The namespace map itself does not create model-picker rows.
Selector validation, collision rules, and privacy guidance are documented in
[Provider Configuration](/reference/configuration/providers/).

## Combos (`config.combos`)

Each combo key is an id matching `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. It is always directly addressable
as `combo/<id>` and may also expose one `alias`. Aliases must be unique, cannot occupy the `combo/`
namespace, and cannot use reserved bare native families such as `gpt-*`, `o1-*`, `o3-*`, `o4-*`, or
`codex-*`.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `targets` | `{ provider: string; model: string; weight?: number }[]` | required | Ordered concrete routes. `weight` is 1–10000 and defaults to `1`. |
| `strategy?` | `"failover" \| "round-robin"` | `"failover"` | Selection strategy. Target order is failover priority; weights shape smooth weighted round-robin. |
| `stickyLimit?` | `number` | `1` | Successful requests retained in one round-robin batch. Range 1–100. |
| `defaultEffort?` | `"low" \| "medium" \| "high" \| "xhigh" \| "max" \| "ultra" \| null` | unset | Applied only when the caller omits effort and the selected target advertises the requested rung. |
| `alias?` | `string` | — | Optional public model id in place of the canonical picker slug. |

```json
{
  "defaultProvider": "openai",
  "combos": {
    "coding": {
      "targets": [
        { "provider": "anthropic", "model": "claude-sonnet-5" },
        { "provider": "openrouter", "model": "qwen/qwen3-coder-plus" }
      ],
      "strategy": "failover",
      "defaultEffort": "high",
      "alias": "coding-primary"
    }
  }
}
```

For strategy behavior, retryable failures, cooldowns, encrypted v2 task limits, and management
commands, see [Combos](/guides/combos/).

### Catalog eligibility

A combo remains directly routable even when it cannot be listed. `ocx sync`, `/v1/models`, and the
Codex picker list it only when every target exposes capabilities that can be intersected:

- a positive `contextWindow`, from live metadata, registry hints, or provider
  `modelContextWindows` / `contextWindow`; and
- a non-empty `inputModalities` intersection, treating an omitted member value as `["text"]`.

A bare relay id with no context metadata or targets with disjoint modalities removes the combo from
the catalog. Sync emits a summary warning and the dashboard marks it **Needs attention**. Add context
metadata, align modalities, or target models with discoverable compatible capabilities.
