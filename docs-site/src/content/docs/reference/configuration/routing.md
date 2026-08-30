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
| `routingProfiles?` | `Record<string, OcxRoutingProfileConfig>` | `{}` | Virtual `policy/<id>` models that select among an explicit candidate allowlist using hard capability requirements and deterministic scoring. |

## Model resolution order

opencodex resolves the requested model in this order:

1. A configured `policy/<id>` or routing-profile alias, executing the policy evaluator and routing
   the selected candidate. An unresolved `policy/<id>` falls through to the later rules.
2. A configured `<account-selector>/<native-openai-model>` namespace, routed through exactly the
   mapped stored Codex account. An invalid or unavailable exact target fails closed.
3. A canonical `combo/<id>` or configured combo alias. Canonical ids win before alias matching.
4. An explicit `<provider>/<model>` namespace whose prefix names a configured provider.
5. A bare native OpenAI-family id such as `gpt-*`, `o1-*`, `o3-*`, or `o4-*`, routed through the
   canonical enabled `openai` provider.
6. An exact match for a provider's `defaultModel`.
7. A known provider-family model prefix.
8. An exact model in a provider's configured `models` list.
9. `defaultProvider`, preserving the requested model id.

Disabled providers are excluded. An explicit namespace for a disabled provider fails instead of
falling through. Provider entries are checked in their JSON insertion order for rules that can match
more than one provider, so use explicit namespaces when a bare model could be ambiguous.

### Blocked-model redirects

`blockedModelRedirects` is an optional top-level `Record<string, string>` of exact resolved
model-id replacements, unset by default. It runs **after** the resolution order above: a match
keeps the provider and account route already selected, replaces only the upstream model id, and
records the route reason `blocked-model-redirect`. Omitting the key leaves routing unchanged.

```json
{
  "blockedModelRedirects": { "gpt-5.6-terra": "gpt-5.6-luna" }
}
```

## Exact Codex account selectors

`codexAccountNamespaces` maps a public selector such as `side` to one stored Codex account. A
request for `side/gpt-5.6-sol` uses only that account, even when the canonical `openai` provider is
in Direct mode, and sends the bare `gpt-5.6-sol` model id upstream. Only bare native OpenAI-family
ids are valid after the selector. Account-scoped ids observed in Codex's current model catalog may
also be preserved exactly when they are not yet part of opencodex's static set; the observation must
carry the field shape of a real catalog row, stays qualified to its matching account selector, and
is never promoted into the global bare model list. That shape check filters malformed and minimal
rows — it is not a trust control, because the models cache is a user-owned file and a complete
hand-written row is indistinguishable from an upstream observation. Nothing new becomes routable:
a bare `gpt-*` id under an account selector is accepted by the router regardless of the catalog.

Exact selection bypasses Pool assignment strategy and ordinary thread affinity. If the mapped
account is missing, paused, cooling down, unusable, or requires reauthentication, the request fails
closed instead of switching accounts and does not change the active Pool account. When at least one
eligible selector is configured, Codex catalogs hide bare native picker rows and list a separate
`<selector>/<native-openai-model>` row for each selector. Bare native ids retain normal Pool/Direct
routing and remain in raw `/v1/models` discovery unless explicitly disabled. Selectors whose mapped
stored account is missing are not advertised. Selector validation, collision rules, and privacy guidance are documented in
[Provider Configuration](/reference/configuration/providers/).

The Codex Auth page exposes this picker behavior as an opt-in. Disabling it hides generated
selector-qualified picker rows and restores the ordinary GPT rows, but it does not remove the
mappings or change exact `<selector>/<model>` routing. Re-enabling therefore restores the same public
labels. Account and setting mutations are persisted before a bounded catalog refresh; an `ocx sync`
warning means only that the picker catalog still needs convergence, not that the routing change was
lost.

## Combos (`config.combos`)

Each combo key is an id matching `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. It is always directly addressable
as `combo/<id>` and may also expose one `alias`. Aliases must be unique, cannot occupy the `combo/`
namespace, and cannot use reserved bare native families such as `gpt-*`, `o1-*`, `o3-*`, `o4-*`, or
`codex-*` unless `nativeAlias: true` explicitly enables the Desktop compatibility contract.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `targets` | `{ provider: string; model: string; weight?: number }[]` | required | Ordered concrete routes. `weight` is 1–10000 and defaults to `1`. |
| `strategy?` | `"failover" \| "round-robin" \| "random" \| "least-used" \| "reset-window"` | `"failover"` | Selection strategy. Target order is failover priority; weights shape round-robin and random draws; least-used follows recorded successes; reset-window follows the soonest quota reset. |
| `stickyLimit?` | `number` | `1` | Successful requests retained in one round-robin batch. Range 1–100. Applies only to round-robin. |
| `defaultEffort?` | `"low" \| "medium" \| "high" \| "xhigh" \| "max" \| "ultra" \| null` | unset | Applied only when the caller omits effort and the selected target advertises the requested rung. |
| `imageInput?` | `"auto" \| "disabled"` | `"auto"` | `"auto"` publishes image only when every target supports images; `"disabled"` forces text-only (drops image from published modalities and rejects image-bearing requests before dispatch). |
| `alias?` | `string` | — | Optional public model id in place of the canonical picker slug. |
| `nativeAlias?` | `boolean` | `false` | Let a currently supported bare native id take precedence only for that unqualified id. Bare `gpt-5.6-*` ids use Codex Pool/Direct credentials. Account-qualified routes remain distinct. Provider-qualified routes such as `openai-apikey/gpt-5.6-*` use their configured API-key route and never fall through to the native alias. |
| `displayName?` | `string` | — | Display-only catalog label, required and non-empty for a native alias. |

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

## Routing policy profiles (`config.routingProfiles`)

Routing policy profiles are the Router Intelligence selection layer: an explicitly requested
`policy/<id>` (or configured alias) selects among a fixed candidate allowlist using hard capability
requirements and deterministic, explainable scoring. An explicit `policy/<id>` request (or a
configured alias) executes the evaluator and routes the selected candidate. Existing model ids are
**never** routed through a profile implicitly: the `policy/` namespace and profile aliases are the
only entry points, and both are validated against the model resolution order above.

Each key is an id matching `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, always addressable as `policy/<id>`,
with one optional `alias`. Aliases must be unique and cannot collide with configured providers,
the `<provider>/<model>` routing namespace, combos, codex account namespaces, the `policy/`
namespace, or reserved bare native families (`gpt-*`, `o1-*`, `o3-*`, `o4-*`, `codex-*`).

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `candidates` | `{ provider: string; model: string }[]` | required | Explicit allowlist of `provider/model` refs. No implicit expansion. |
| `alias?` | `string` | — | Optional public model id in place of `policy/<id>`. |
| `require?` | object | `{}` | Hard capability requirements evaluated before scoring (see below). |
| `optimize?` | object | latency 0.55, health 0.25, cost 0.10, quota 0.10 | Scoring weights, normalized deterministically. `health`, `quota`, and `cost` have score dimensions; the configured-priority share is `1 - health - quota - cost` (default 0.55), and `latency` folds into that priority share rather than scoring independently. |
| `limits?` | object | — | Hard limits. `maxEstimatedCostUsd` excludes a candidate when its estimated cost is known and above the cap. When that cap is set, `onUnknownCost` (`"allow"` default, or `"exclude"`) controls unknown estimates: allow prevents a cap-specific exclusion and records `cost.capOutcome: "unknown-allowed"`; exclude emits `cost-limit-unknown` and `capOutcome: "unknown-excluded"`. `onUnknownCost` alone (no cap) is inert. Separate from `unknownEvidence.cost`, which can still exclude or penalize unknown prices via `unknown-price` / scoring. |
| `unknownEvidence?` | object | capability `exclude`, health/quota/cost `penalize` | How unknown evidence is treated per dimension: `allow`, `penalize`, or `exclude`. Unknown never becomes zero. |

`require` supports: `minContextWindow` (positive integer), `minQuotaHeadroom` (0..1 fraction),
and the booleans `tools`, `imageInput`, `structuredOutput`, `localOnly`, `remoteAllowed`,
`encryptedCodexTasks`; plus `reasoningEffort` and `serviceTier` strings.

For `unknownEvidence.capability`, `penalize` currently behaves like `allow`: scoring has only a
configured-priority component until a capability score dimension ships (planned with RI-06+), so
`penalize` cannot yet change the selected candidate.

Request evidence is evaluated against candidate capabilities together with the profile `require`
block; a candidate must satisfy both to be eligible. On the live request path the proxy derives
tools and image-input evidence from the request body; context-window size and the remaining
evidence dimensions stay unknown at routing time. Use the dry-run API/CLI to inspect the full
evidence surface for context-sensitive profiles.

The CLI dry-run accepts request-evidence flags but cannot supply candidate capability evidence yet;
candidate evidence is provided through the API (`POST /api/routing-profiles/dry-run`).

```json
{
  "routingProfiles": {
    "fast": {
      "alias": "ocx/fast",
      "candidates": [
        { "provider": "anthropic", "model": "claude-sonnet-5" },
        { "provider": "openai", "model": "gpt-5.6-sol" }
      ],
      "require": { "tools": true, "minContextWindow": 128000 },
      "optimize": { "latency": 0.55, "health": 0.25, "cost": 0.10, "quota": 0.10 },
      "limits": { "maxEstimatedCostUsd": 0.50, "onUnknownCost": "allow" },
      "unknownEvidence": {
        "capability": "exclude",
        "health": "penalize",
        "quota": "penalize",
        "cost": "penalize"
      }
    }
  }
}
```

CLI: `ocx route policy list [--json]`, `ocx route policy show <id> [--json]`, and
`ocx route policy dry-run <id> [--model-context <tokens>] [--tools] [--image] [--structured-output] [--json]`.
Dry-run evaluates candidates without sending any upstream request.

Quota evidence (`optimize.quota`, `require.minQuotaHeadroom`, `unknownEvidence.quota`) comes from
account-keyed Codex and Anthropic quota caches. A runtime candidate receives cached quota only when
the evidence already identifies the account. Unbound canonical `openai` and Anthropic candidates
remain unknown during policy evaluation because Pool selection, Direct caller identity, provider
rotation, and thread affinity are resolved after the policy chooses a provider/model; a process-active
account is not used as a substitute.
Quota evidence never changes account selection, session affinity, cooldowns, or switching behavior —
it only feeds policy scoring. To see quota-aware behavior in an API dry-run, supply account refs in
the candidate evidence sent to `POST /api/routing-profiles/dry-run`:
`candidates[].codexAccountId` (Codex pool, provider `openai`) or `candidates[].accountRef`
(Anthropic) derives the matching cached account quota; an explicit `candidates[].quota` object is
echoed as given. The CLI dry-run cannot supply these per-candidate account fields.

### Combos vs policy profiles

- A **combo** is explicit target routing with a selectable strategy (ordered failover, smooth
  weighted or random balancing, least-used, or reset-window): the configured strategy decides,
  and retryable failures advance through the list.
- A **policy profile** is evidence-based selection among configured candidates: hard capability
  requirements filter first, then deterministic scoring ranks the survivors.

Both are virtual namespaces with aliases and collision validation; they differ in *how* a candidate
is chosen. Profile scoring combines the configured-priority component with the health (RI-06),
quota (RI-07), and cost (RI-08) score dimensions where evidence is present; the `latency` weight
folds into the priority share rather than scoring independently. Cost is also enforced through the
`limits.maxEstimatedCostUsd` cap: a candidate whose estimated cost is known and exceeds the cap is
excluded (`cost-limit`). When a cap is configured and the estimate is unknown, the default `limits.onUnknownCost: "allow"`
records `cost.capOutcome: "unknown-allowed"` on the route-decision trace without a cap exclusion;
set `onUnknownCost: "exclude"` for a fail-closed ceiling (`cost-limit-unknown`). Cap outcome is not
overall eligibility — `unknownEvidence.cost: "exclude"` can still add `unknown-price` and mark the
candidate ineligible. Per-request route-decision traces are recorded when a policy profile executes.

### Catalog eligibility

A combo remains directly routable even when it cannot be listed. `ocx sync`, `/v1/models`, and the
Codex picker list it only when every target exposes capabilities that can be intersected:

- a positive `contextWindow`, from live metadata, registry hints, provider
  `modelContextWindows` / `contextWindow`, a known positive `maxInputTokens` on the member row,
  or — when the provider is known and enabled but every source still omits a window — a
  conservative 128,000-token fallback (clamped by `providerContextCaps` when set); and
- a non-empty `inputModalities` intersection, treating an omitted member value as `["text"]`.

A target on a disabled provider (even with a complete discovery row), on an unknown provider with
no discovery row, or targets with disjoint modalities, removes the combo from the catalog. Sync
emits a summary warning and the dashboard marks it **Needs attention**. Add context metadata,
align modalities, or target models with discoverable compatible capabilities.

## Request history and routing analytics

- `GET /api/request-history` - cursor-paginated full history from the derived
  index (`routing-history.sqlite`), with filters (`provider`, `model`,
  `requestedModel`, `status`, `conversationId`, `surface`, `inboundProtocol`,
  `apiKeyId`, `profileId`, `fallback`, `from`, `to`) and opaque `cursor`
  pagination. `GET /api/request-history/:requestId` returns one canonical row.
- `GET /api/request-history/:requestId/route-decision` - the why-this-route
  explanation: trace (candidates, exclusions, score components, profile +
  revision), execution attempt sequence, and final outcome.
- `GET /api/routing-analytics` - success/failure/cancelled/fallback rates,
  p50/p95/p99 duration and TTFT, incomplete-stream rate, cooldown-triggering
  failures, cost per successful request, coverage, confidence, and an
  explicit truncation flag.
- `GET /api/routing-profiles`, `POST /api/routing-profiles/dry-run` - profile
  inspection and dry-run evaluation (no upstream dispatch).

Returned history and route-decision payloads expose only masked request metadata
(for example opaque `apiKeyId` labels). They do not include credentials, raw
prompt bodies, or provider secrets.

CLI: `ocx logs explain <request-id>`, `ocx logs rebuild-index`,
`ocx logs index-status`, `ocx route policy list | show | dry-run | evaluate`.

## Migration

`routingProfiles` is optional and additive: existing config files load
unchanged. Old `usage.jsonl` rows without `routeDecision` parse unchanged.
The history index is disposable - deleting `routing-history.sqlite` triggers
an automatic rebuild from `usage.jsonl` on the next query; `ocx logs
rebuild-index` forces one. Nothing in this system auto-tunes weights,
budgets, or candidate sets.
