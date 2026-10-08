---
title: "Combos: failover and load balancing"
description: Route one virtual model to several providers for failover or weighted load balancing.
---

A **combo** is one virtual model that fronts an ordered list of real provider/model targets. Your
client requests `combo/<id>`; opencodex chooses a target, rewrites the request to that concrete
`provider/model`, and can try another target when the first one has a retryable failure.

This is useful when you want either:

- **Failover:** prefer one model, but keep backups ready.
- **Load balancing:** spread successful requests across models or providers in weighted batches.

Combos sit in front of normal provider routing. Read [Model Routing](/guides/model-routing/) first
if `provider/model` selectors are new to you.

## 60-second quickstart

This example creates `combo/main` with Anthropic first and OpenAI second. Both providers must
already exist and be enabled.

```bash
ocx combo set main --targets anthropic/claude-opus-4-8,openai/gpt-5.6-sol
```

The default strategy is failover, so a normal request goes to
`anthropic/claude-opus-4-8`. If that attempt has a retryable failure, opencodex can hop to
`openai/gpt-5.6-sol`.

Use the virtual model anywhere you would normally provide a model id:

```json
{
  "model": "combo/main",
  "input": "Explain why the sky looks blue."
}
```

Confirm the saved definition:

```bash
ocx combo show main
```

:::tip
Start with failover and equal weights. Switch to round-robin only when you intentionally want to
distribute traffic, and add weights only when equal distribution is not appropriate.
:::

## How combo names work

The combo id in `ocx combo set <id>` must start with a letter or number. It may then contain
letters, numbers, `.`, `_`, or `-`, up to 64 characters total. Its canonical model id is always
`combo/<id>`; for example, id `main` becomes `combo/main`.

The `combo/` namespace is reserved while combos are configured. A provider named `combo` cannot
occupy it, and a combo id cannot duplicate a configured provider name.

An optional alias gives the combo a different public model name. An alias:

- uses the same characters as an id;
- may be bare, such as `daily-fast`, or contain one `/`, such as `team/daily-fast`;
- cannot be `combo` or start with `combo/`;
- cannot duplicate another combo alias; and
- cannot normally be a bare native OpenAI-family name beginning with `gpt-`, `o1-`, `o3-`, `o4-`,
  or `codex-`. The explicit Desktop compatibility mode below is the only exception.

Even when an alias is set, the canonical `combo/<id>` form still resolves. Canonical lookup runs
before alias matching, so an alias cannot take over another combo's canonical id.

:::note
Aliases change the public name clients request; they do not change the combo's stored id or the
concrete provider/model selectors behind it.
:::

## Compaction after switching combos

When a client compacts using a bare model name after switching combos, opencodex can recall the
combo that most recently completed successfully on that conversation lane. The model must match
the completed response, and the combo and its target must still exist in the current configuration.
The request then follows normal combo selection and failover.

Explicit provider/combo selectors and configured combo aliases take precedence over this recall.
Failed, incomplete, or cancelled responses do not replace the last successful selection. Recall is
process-local and bounded to 256 conversations for 30 minutes, and to 1 KiB per remembered model
name and 64 KiB in total; expired entries are also cleaned up in the background. A response whose
model name is too large to retain leaves the previous selection untouched rather than clearing it.
Recall does not store account credentials.
Without usable conversation identity or valid remembered state, normal compaction routing applies.
A restart clears the remembered state.

## Codex Desktop native-allowlist compatibility

Some Codex Desktop releases apply a remote native-only `available_models` allowlist after the
app-server has already loaded `model_catalog_json`. Normal routed ids such as
`Nova1/codex-gpt-5.6-sol` are then usable by the CLI but absent from the Desktop picker. This is the
upstream [Codex Desktop bug](https://github.com/openai/codex/issues/19694) tracked by
[opencodex #241](https://github.com/lidge-jun/opencodex/issues/241).

When you control an equivalent routed target, a combo can explicitly take over one native slug:

```bash
ocx combo set nova-sol \
  --targets Nova1/codex/gpt-5.6-sol \
  --alias gpt-5.6-sol \
  --native-alias \
  --display-name 'Nova1 - codex-gpt-5.6-sol'
```

This mode is deliberately opt-in and requires both `--native-alias` and a non-empty display label.
The alias must be one of the native model ids supported by this opencodex release; a native-family
prefix alone is not accepted because removal must be able to restore authoritative metadata.
When the routed target's discovery response supplies only a model id, the compatibility row fills
missing context, modality, and reasoning metadata from the native id it replaces. Explicit target
limits still win, so this fallback never raises a context cap or overrides declared capabilities.
It changes exact routing precedence: requests for `gpt-5.6-sol` resolve to `combo/nova-sol` before
the canonical OpenAI native-family route. The catalog contains one bare row with the configured
display label, not duplicate native and combo rows. Only the bare `gpt-5.6-sol` slug is captured.
Account-qualified rows such as `main/gpt-5.6-sol` and provider-qualified rows such as
`openai-apikey/gpt-5.6-sol` remain distinct OpenAI routes; the provider-qualified API-key route
never falls through to the native alias.

Visibility keys stay unambiguous:

- `combo/nova-sol` hides the compatibility combo from discovery.
- The bare `gpt-5.6-sol` entry in `disabledModels` continues to mean the dormant native OpenAI row;
  it does not hide the combo that currently owns that public slug.
- While at least one native alias is configured, disabled bare native rows are omitted from the
  effective Codex catalog instead of retained as `visibility: "hide"`. This prevents Desktop's
  allowlist from resurrecting rows it should not show. The Models page still lists unshadowed native
  switches, and re-enabling one restores its preserved or current native metadata.

:::caution
A native alias intentionally takes over a first-party-looking model id. Use it only when the target
is operationally equivalent and label the picker row honestly. Removing the combo restores normal
native routing and catalog identity on the next sync.
:::

## Choose a strategy

### Failover: ordered primary and backups

`failover` selects the first eligible target in configuration order. A target is eligible when its
provider exists, is enabled, is not cooling down, and can handle any special request constraint.
Weights and `stickyLimit` do not affect this strategy.

Given this order:

1. `anthropic/claude-opus-4-8`
2. `openai/gpt-5.6-sol`
3. `google/gemini-3-pro`

each request starts with Anthropic. A retryable Anthropic failure moves that request to OpenAI; a
retryable OpenAI failure can move it to Google. A terminal error stops immediately instead of
trying the remaining targets.

### Round-robin: smooth weighted batches

`round-robin` uses smooth weighted round-robin. A larger target weight gives that target a larger
share over time without sending all of its share as one long block. `stickyLimit` controls how many
successful requests stay on the selected target before the next weighted selection.

Create a 2:1 combo with batches of two successful requests:

```bash
ocx combo set balanced \
  --targets anthropic/claude-opus-4-8:2,openai/gpt-5.6-sol:1 \
  --strategy round-robin \
  --sticky 2
```

Calling the targets **A** (weight 2) and **B** (weight 1), the first six weighted selections are
`A, B, A, A, B, A`. Because `stickyLimit` is 2, each selection stays active for two successful
requests:

| Successful request | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Target | A | A | B | B | A | A | A | A | B | B | A | A |

The long-run share is still 2:1. A retryable failure ends the current sticky batch, cools that
target, and selects another eligible target for the same request.

:::caution
Weights are relative, not percentages. Weights `2,1` and `200,100` express the same ratio. Prefer
small values that communicate intent.
:::

### Random: weighted draw per request

`random` draws one eligible target per request, with odds proportional to `weight`. Every request
is an independent draw, so traffic spreads across targets without the deterministic pattern or
stickiness of round-robin. `stickyLimit` does not affect this strategy.

### Least-used: favor the target with fewest successes

`least-used` routes each request to the eligible target with the fewest successful requests
recorded by this opencodex process. Counts start at zero on restart, and ties keep configuration
order. Weights and `stickyLimit` do not affect this strategy.

### Reset-window: follow the soonest quota reset

`reset-window` routes each request to the eligible target whose cached provider quota snapshot
shows the soonest upcoming window reset (five-hour, weekly, monthly, or custom). This spends the
provider that refreshes first. Targets without fresh quota data, and ties, keep configuration
order. Weights and `stickyLimit` do not affect this strategy.

This ranking and provider exclusion before dispatch require fresh model-inference limits that apply to the current single API key as a whole. OAuth/current-account summaries, caller-forward routes, multiple keys, and snapshots with changed credentials or destinations are display-only for this early decision. The same applies when `Authorization`, `x-api-key`, or `x-goog-api-key` headers override credentials; search-only and MCP-only windows are excluded. If no eligible target has an applicable reset, configuration order wins. Account selection and retries still enforce their normal limits.

### Decision method

`strategy: "jev"` asks a decision backend to choose the first eligible target and a compatible
reasoning effort for the current request. It is opt-in: create a JEV Combo and select that Combo
to use it. Adding a decision credential does not change existing models, aliases, or defaults.

| Method | Combo selection | Backend reported in stats |
| --- | --- | --- |
| TypeSafe (default) | Omit both selectors, or set `decisionProvider: "jev"`. | `typesafe` |
| System One-compatible server | Set `decisionProvider` to a configured `jev-decision` row id other than `jev`. | `systemone` |
| opencodex model | Set `decisionModel` to an ordinary opencodex route, such as `ollama/qwen3:4b`. | `model` |

`decisionProvider` and `decisionModel` are mutually exclusive. The backend is derived from those
fields; there is no stored `backend` setting. Every method uses the same eligible target and effort
allowlist, bounded decision state, timeout, cancellation, and fail-open policy.

#### TypeSafe default

The quickest setup is:

1. Open **Providers**, add **TypeSafe JEV**, enter the TypeSafe API key, and test the connection.
2. From that provider's Overview, choose **Create JEV Auto**. You can also use the same action under
   **Models → Combos**.
3. Review the prefilled Astra → Sol → Luna targets. Add, remove, reorder, or replace them before
   creating the Combo. The first currently eligible row is marked as the fail-open target, and each
   known reasoning ladder is shown beside its row.

The template creates id and alias `jev-auto`, uses adaptive reasoning capability, and remains an
ordinary editable Combo. It does not become the default model. Its targets are the complete
allowlist: JEV can never select a provider/model pair outside that list, and the original target
models remain available in their normal picker groups.

For headless setup, store the key explicitly or reference the TypeSafe environment variable:

```bash
ocx provider add jev --api-key "${TYPESAFE_API_KEY}"
```

When the provider has no saved key, the decision client also accepts `TYPESAFE_API_KEY` directly and
the standard provider-derived alias `JEV_API_KEY` printed by `ocx provider add`.

```json
{
  "providers": {
    "jev": {
      "adapter": "jev-decision",
      "baseUrl": "https://api.typesafe.ai/v1/systemone",
      "authMode": "key",
      "apiKey": "${TYPESAFE_API_KEY}",
      "liveModels": false
    }
  },
  "combos": {
    "jev-auto": {
      "alias": "jev-auto",
      "strategy": "jev",
      "reasoningEffortMode": "adaptive",
      "targets": [
        { "provider": "openai", "model": "gpt-6-astra" },
        { "provider": "openai", "model": "gpt-5.6-sol" },
        { "provider": "openai", "model": "gpt-5.6-luna" }
      ]
    }
  }
}
```

With the default method, OpenCodex sends one bounded decision request to the fixed
`https://api.typesafe.ai/v1/systemone` endpoint with model `jev-latest`. Only currently eligible
configured targets are offered. JEV chooses the target and effort together; the effort is still
constrained by that target's advertised ladder. JEV is not asked again if the selected target has a
retryable failure—the existing Combo cooldown and fallback loop continues through the remaining
configured targets.

#### System One-compatible server

A JEV Combo can ask a hosted or self-hosted server that implements the System One wire contract.
For example, an Ollama server with System One support can serve `tev1` at
`POST /v1/systemone` without an API key. Add a provider row with
`adapter: "jev-decision"` whose `baseUrl` is the **full** decision endpoint, then name it in the
Combo's `decisionProvider`:

```json
{
  "providers": {
    "ollama-tev1": {
      "adapter": "jev-decision",
      "baseUrl": "http://127.0.0.1:11434/v1/systemone",
      "allowPrivateNetwork": true,
      "defaultModel": "tev1:4b",
      "liveModels": false
    }
  },
  "combos": {
    "jev-local": {
      "strategy": "jev",
      "decisionProvider": "ollama-tev1",
      "decisionTimeoutMs": 60000,
      "reasoningEffortMode": "adaptive",
      "targets": [
        { "provider": "openai", "model": "gpt-6-astra" },
        { "provider": "openai", "model": "gpt-5.6-sol" },
        { "provider": "openai", "model": "gpt-5.6-luna" }
      ]
    }
  }
}
```

- The row's `baseUrl` must be the full decision endpoint and its path must end in `/systemone`.
  The decision model is `defaultModel`, else the first `models` entry; a row with neither is
  treated as unusable and fails open without a request (`jev-latest` is TypeSafe's model and is
  never sent to a self-hosted host). The row is a decision service only: it is never published as a
  routable model and cannot be a Combo target.
- A loopback or LAN endpoint needs `allowPrivateNetwork: true` set explicitly on that row. Use a
  literal loopback, RFC 1918, or IPv6 ULA address for plain `http:`; every resolved address must stay
  in the allowed set and no outbound proxy may apply (add the
  host to `NO_PROXY`). Every other destination must use HTTPS. Redirects still fail open.
- Only the row's own `apiKey` is sent, and only when it is set; a keyless row sends no
  `Authorization` header. A row whose `apiKey` references `${TYPESAFE_API_KEY}`/`${JEV_API_KEY}` or
  another provider's keychain entry is refused as unusable, so `TYPESAFE_API_KEY`, `JEV_API_KEY`, and
  the `jev` row's key are never sent to a self-hosted endpoint. The `jev` id itself (explicit or
  omitted) always means the TypeSafe endpoint with model `jev-latest`.
- Self-hosted services receive each target/effort option as a plain description string (for
  example `Target openai/gpt-5.6-sol (provider openai, model gpt-5.6-sol) with low reasoning
  effort.`), because Ollama accepts only string or `null` option descriptions. TypeSafe keeps
  receiving the structured option objects.
- OpenCodex offers 2–26 options to a System One-compatible row. Each target contributes one option
  per offered reasoning effort; use per-target `reasoningEfforts` to trim them. Fewer than 2 or
  more than 26 options fail open without a request.
- A cold model load can take tens of seconds, and an aborted decision request makes Ollama abandon the
  load. Pre-warm the model and keep it resident (`OLLAMA_KEEP_ALIVE=-1`, or `keep_alive`), and raise
  `decisionTimeoutMs` (1000–120000 ms, default 4000) when the service is slower than four seconds.
  Every timeout or error still fails open to the first eligible target.

The provider's **Test connection** sends a bounded probe decision to its endpoint.
**Create JEV Auto** on a System One provider (keyless rows included) prefills that row as the
decision provider. Disabled rows, endpoints not ending in `/systemone`, and rows without a model
are shown with a reason and cannot be picked.

[Laya MLX](https://github.com/mizorewww/laya-mlx) runs typed decisions on Apple Silicon. To use it
with this method, expose it through a System One-compatible HTTP wrapper, then configure a row like
`ollama-tev1` above with the wrapper's full `/systemone` URL and accepted model id as `defaultModel`.
The MLX Python runtime alone is not an HTTP decision endpoint. For a loopback HTTP wrapper, keep
`allowPrivateNetwork: true` and use its literal loopback address.

For a hosted example, a contributor reported the following Zen System One endpoint working in
[#6185](https://github.com/lidge-jun/opencodex/pull/6185). Configure it manually as an ordinary row;
this is not an OpenCodex registry preset or a guarantee of current availability:

```json
{
  "providers": {
    "zen-decision": {
      "adapter": "jev-decision",
      "baseUrl": "https://opencode.ai/zen/v1/systemone",
      "defaultModel": "jev-1.13-free",
      "apiKey": "${ZEN_DECISION_API_KEY}",
      "liveModels": false
    }
  },
  "combos": {
    "jev-zen": {
      "strategy": "jev",
      "decisionProvider": "zen-decision",
      "targets": [
        { "provider": "openai", "model": "gpt-6-astra" },
        { "provider": "openai", "model": "gpt-5.6-luna" }
      ]
    }
  }
}
```

Use that endpoint's own key if authentication is required; omit `apiKey` only if the endpoint
accepts keyless calls. Never reuse `TYPESAFE_API_KEY` or `JEV_API_KEY` for it.

#### opencodex model

An ordinary chat or Responses model can make the same routing choice without implementing
`/systemone`. Configure its inference provider as usual and set `decisionModel` to its route:

```json
{
  "combos": {
    "jev-chat": {
      "strategy": "jev",
      "decisionModel": "ollama/qwen3:4b",
      "decisionTimeoutMs": 60000,
      "targets": [
        { "provider": "openai", "model": "gpt-6-astra" },
        { "provider": "openai", "model": "gpt-5.6-luna" }
      ]
    }
  }
}
```

Other examples are `deepseek/deepseek-v4-flash`, `openai/gpt-5.6-luna`, or
`opencode-zen/<model>` for a configured Zen inference model. These are ordinary route strings,
not decision-service presets; the provider and model must be available on your installation.
For `openai/gpt-5.6-luna`, configure credentials the internal call can use, such as a stored Codex
pool login. A caller-owned ChatGPT forward login is insufficient.

The model receives fixed router instructions and one JSON prompt:

```json
{
  "state": { "user_task": "Review the requested change" },
  "options": { "<key>": "Target description and allowed reasoning effort" }
}
```

`state` is the bounded evidence described below; `options` maps generated option keys to plain
descriptions. The reply contract is `{"choice":"<key>"}`, naming exactly one offered option.
The instructions treat state as evidence, prefer lower resource use among adequate options, and
require JSON only. An invalid or unlisted choice, malformed response, or failed call fails open.

The internal decision turn carries **no caller credential**, caller headers, tools, session, or
conversation history. It must use credentials stored for the selected provider, or a genuinely
keyless local provider such as Ollama. Caller-auth-only configurations, such as Cursor without a
stored credential or a caller-owned ChatGPT forward login, cannot serve as decision models and
fail open. Selecting a route is not proof that its credential is usable; test it before relying on it.

A non-JEV Combo can be used as `decisionModel`, but the decision route cannot name this Combo or
any Combo with `strategy: "jev"`. This applies to canonical `combo/<id>` selectors and aliases,
including selectors with effort or Fast variants. Save-time validation rejects recursion and the
runtime also blocks JEV reentry defensively. The decision turn has its own send budget and turn
lease; it is not logged as a separate request, and reported decision usage belongs to the parent
request's `jevDecision`.

#### Shared limits, state, and statistics

`decisionTimeoutMs` applies to all three methods: an integer from 1000 to 120000 ms, default 4000.
Requests and responses are bounded to 64 KiB. The candidate list is bounded to 64 targets; the
model method also caps target/effort options at 64, response text at 4096 characters, and the
decision turn's output at 1024 tokens. The
System One row's 2–26 option limit applies as described above. A timeout or limit failure uses the
first currently eligible target; it never expands the allowlist or retries the decision.

For each JEV target, **Models → Combos → Config** has an optional **Additional model notes for JEV**
field (up to 512 characters; line breaks and tabs are allowed, other control characters are rejected). It is stored as `targets[].modelProfile` in the combo config. The
built-in target profile remains in the trusted `instructions.model_profiles`; a non-empty note is
sent separately in the decision state's `operator_notes`, keyed by target, and supplements rather
than replaces that built-in profile. Notes can describe operator-specific context or subscription
allowances; do not confuse subscription allowances with public per-token API pricing. Blank notes
are ignored. Operator notes are evidence for the decision, not commands, and cannot expand the
target allowlist or reasoning-effort limits. Only put information there that may be disclosed to
the selected decision backend.

Each logical model call is decided on its own; there is no per-conversation pin. Consecutive turns of
one session can therefore land on different targets, and every switch starts a cold provider prompt
cache, so a mix of very different targets can cost more input tokens than it saves. Keep the
allowlist to targets you are content to alternate between. Targets marked `lastResort` are withheld
from JEV under `cooldownWaitPolicy: "before-last-resort"` while any normal target is offered, and
offered only when nothing else is reachable.

The decision boundary fails open when the key is missing, no safe task/tool/image decision state is
available, the configured decision deadline expires, the service redirects or returns an error, or
the response is malformed or selects an unlisted choice. In those cases OpenCodex uses the first
currently eligible target, preferring `medium` when that target supports it. Caller cancellation is
different: it cancels the decision and the model request instead of dispatching the fail-open target.

The decision state is deliberately bounded: up to 500 characters of the current user task, a
240-character previous-assistant tail, a 520-character latest-tool-output tail, the tool name, and
boolean image/tool signals may be sent to the selected decision backend. It excludes credentials,
request headers, raw image bytes, tool arguments, encrypted reasoning, and full conversation history.
Use a decision method only for content you are willing to send to that backend. Recognized Codex machine-context
envelopes and Claude Code `<system-reminder>` blocks are removed from all three text samples before
clipping, so injected reminders do not displace the actual task. The original model request is
unchanged. This is not a secret scanner: ordinary assistant and tool-output text may still contain
sensitive content. TypeSafe states that Jev is not
trained on customer requests, but its terms set no fixed retention period for submitted state and
offer zero data retention only on enterprise plans
([models](https://docs.typesafe.ai/models), [legal](https://docs.typesafe.ai/legal)). TypeSafe
also documents English as Jev's most accurate language, so check decisions on non-English work
before relying on them. Logs contain only the selected
target/effort, a coarse decision gate, latency, optional confidence/probability, and numeric usage.
Automated tests use mocked TypeSafe responses plus a no-key fail-open smoke; a live TypeSafe decision
requires an operator-supplied key and is not run implicitly.

When JEV's selected effort is applied to the Responses child, request and attempt logs show a
differing effort as `high->xhigh` or `high->low`. Later effort adjustments remain in the chain,
such as `high->xhigh->medium`. An unchanged effort or a target without effort control keeps the
existing label; fallback attempts do not inherit the initial JEV effort. With the opt-in
`protocols.rollout.nativeChatCombos` path, native Chat children currently do not apply JEV's
selected effort; their labels retain the caller's effort and any native child adjustments instead.

After the Combo has served requests, open **Models → Combos → jev-auto → Stats** to inspect JEV's
picks without replacing the normal model picker or Usage page. The tab separates backend-reported decision
tokens from tokens reported by physical model sends, and shows decision gates, fail-open picks,
reasoning efforts, retries/fallbacks, cache tokens, latency, confidence, and per-model totals for 7
days, 30 days, or all available history. Statistics come from the local append-only usage ledger;
they contain the bounded decision metadata described above, not prompts or credentials. Backend
rows show decision count, applied count, and average latency for `typesafe`, `systemone`, and
`model`; older records without a backend are grouped as `unknown`.

## What happens when a target fails

Combo failures are divided into **hop** failures and **terminal** failures.

| Result | Behavior |
| --- | --- |
| HTTP 401, 403, 404, 408, 429, or any 5xx | Cool the target and hop to the next eligible target. |
| HTTP 410 with an explicit model end-of-life, retired, deprecated, sunset, decommissioned, or no-longer-available signal | Cool that target and hop. Unrelated 410 responses remain terminal. |
| Classified authentication, subscription, quota, rate-limit, overload, or upstream-server error | Cool the target and hop, even when the status alone is not sufficient. |
| Client cancellation (499), `origin_rejected`, cyber-policy refusal, context overflow, or other invalid request | Stop and return the error; another target would not make the request valid. |
| Exact HTTP 400 saying a model is not supported when using Codex with a ChatGPT account | Try the next declared target before output commitment. The message must be the whole refusal in `detail`, `error.message`, or bare text; competing `detail` and `error` envelopes stay terminal. This does not quarantine the account or cool every model on the provider. |
| Structured HTTP 400 rejecting optional `user`, an unsupported reasoning effort, or model-scoped image input | Hop before output commitment without cooling; see request-local target compatibility below. |
| First tool call of a Responses turn run by an in-process adapter (`runTurn`) that the current request did not declare, before any output or replay-unsafe side effect | Cool the target and hop with the same tool catalog. After visible output or a replay-unsafe side effect the refusal is final. Chat Completions and Anthropic Messages requests are unchanged. |
| Any other unclassified error | Stop and return the error. |

If the shared request send budget refuses the first target, the combo returns a local 429
`request_send_budget_exhausted` without contacting a provider. If it refuses a later target,
the combo returns the last real upstream failure without sending to that target.

When `cooldownMs` is unset, a hopped target uses an upstream fallback: 5 seconds for request-rate
429s with upstream code `1302` or `1305`, 10 minutes for a spent account usage window, and 60
seconds otherwise. A usage window is recognised by upstream code (`usage_limit_exceeded`,
`usage_limit_reached`, `1308`) or by the prose `usage limit reached`, independent of HTTP status —
the ChatGPT Codex backend reports a spent window as a 502 rather than the documented 429. Credential and
billing failures that already black out the whole provider (`invalid_api_key`, `insufficient_quota`,
`payment_required`, and the other provider-scoped codes) take the same 10-minute hold. When it is set, `cooldownMs`
applies whenever no usable upstream `Retry-After` or Codex reset signal exists, including those
request-rate 429s. Numeric `Retry-After` seconds and HTTP-date values are accepted. Explicit
server delays are capped at 24 hours; reset-derived, configured, and fallback cooldowns are capped
at 10 minutes. The precedence is, from strongest to weakest, explicit
`Retry-After` → Codex reset headers (`x-codex-primary-reset-at`, `x-codex-secondary-reset-at`, or
`x-codex-tertiary-reset-at`) → the combo's `cooldownMs` (when set) → the
10-minute hold for a spent usage window or a credential/billing failure → the 5-second request-rate fallback for upstream
rate-limit codes `1302`/`1305` → the 60-second default. The usage-window hold is tested first, so a
failure that carries a request-rate code *and* usage-limit prose is held for ten minutes rather than
five seconds. A valid immediate
`Retry-After: 0` remains an immediate upstream directive rather than being replaced by a configured
cooldown.

For an Anthropic OAuth or Codex pool, a 429 tied to one account that the pool has cooled does
not cool the whole combo target. Other accounts behind that target remain available. A 429 with
no identified, cooled pool account still cools the target, as do provider-wide failures.

### Last-resort targets

A brief cooldown on a preferred target otherwise routes straight to whatever
comes next in the list — including a target you only ever wanted used in an
emergency. Mark it, and tell the combo to wait first:

```json
{
  "strategy": "failover",
  "cooldownWaitPolicy": "before-last-resort",
  "waitForCooldownMs": 10000,
  "targets": [
    { "provider": "provider-a", "model": "model-a" },
    { "provider": "provider-b", "model": "model-b" },
    { "provider": "provider-c", "model": "model-c", "lastResort": true }
  ]
}
```

With the policy set, selection tries the normal targets first. If they are only
cooling and the earliest cooldown expires inside `waitForCooldownMs`, the
request waits for that instead of dispatching the last-resort target. That
deferral does not depend on the wait: a `lastResort` target is skipped whenever
any normal target is available, for every strategy, and under `round-robin` or
`random` it does not join the rotation at all. `waitForCooldownMs` only adds the
wait for a cooling normal target, so at the default `0` nothing waits: the last
resort is used as soon as no normal target is available. After a failed attempt,
the next pick follows the same rule.

**The policy only ever defers.** When no normal target can be reached — every
one cooling past the budget, already attempted, or ruled out — the last-resort
target is dispatched as usual. A policy that could withhold it would turn a
fallback into an outage, which is worse than the premature routing it prevents.
The same applies to a combo whose targets are *all* marked `lastResort`: it
dispatches normally.

`lastResort` is inert unless `cooldownWaitPolicy` is set, and both are omitted
by default, so existing combos are unaffected. Only the exact string
`before-last-resort` opts in.

The current request never retries the same attempted target — with one exception: a single-target combo
that sets `waitForCooldownMs` may retry its only target once that target's cooldown expires inside the
same request, since there is no alternate to fail over to. Request-local compatibility rejections still
return without any retry. Later requests skip a cooled target until its
cooldown expires; request-local compatibility rejections do not cool the target. A `Retry-After` HTTP-date that is already in the past is also preserved as an
immediate upstream directive, just like `Retry-After: 0`. Set `waitForCooldownMs` to allow a later
request to wait for the earliest eligible target cooldown, up to that cap on each selection attempt,
and then make one fresh selection. A request may therefore wait up to `hops × waitForCooldownMs`
across multiple failover hops. The default is `0`, which fails closed immediately with HTTP 503 when
every eligible target is cooling; that `combo_unavailable` 503 carries a `Retry-After` header equal
to the earliest remaining cooldown, rounded up to whole seconds with a minimum of 1. Waits are not jittered, so
synchronized wake-ups are possible. An aborted request cancels this wait and returns the normal
`client_cancelled` response; it does not dispatch a backup target after cancellation. A combo target
cooldown is process-local per-combo state and is separate from the account-level Codex quota cooldown
used by native account routing.

:::note
Failover is intentionally bounded. It helps with target-specific availability, authentication,
quota, and overload failures; it does not hide caller errors or policy refusals.
On a non-combo Responses request, an allowlisted xAI policy 403 is rewritten to HTTP 200
`incomplete/content_filter` before Codex retries it as a transport failure; see
[xAI policy refusals](/reference/proxy-formats/#xai-policy-refusals). Combo hops still
classify the original HTTP 403 as a hop.
:::

For streaming requests, the upstream HTTP status is not the final decision. OpenCodex buffers a
bounded pre-output prefix of the selected child's Responses SSE. If the stream reports a retryable
`response.failed` terminal before any text, reasoning, tool call, or other output event, the child
is recorded as failed and the combo may try its next eligible target. Once any output event begins,
the target is committed: a later stream failure is returned to the client and is never replayed on
another provider, which prevents duplicate text and tool execution. If the pre-output buffer reaches
its safety cap without a terminal or output boundary, OpenCodex also commits the current target
instead of growing memory without a bound.

## Request-local target compatibility

When routing Claude Code to the canonical ChatGPT Codex backend, OpenCodex removes the unsupported top-level `user` metadata field without changing the session/cache key, input messages, tool schemas, or safety identifiers. Public Responses API and noncanonical forward gateways keep that field.

A combo can also advance after an intact HTTP 400 `invalid_request_error` that specifically rejects `user`, reports `unsupported_value` for `reasoning.effort`/`reasoning_effort`, or reports `param: input` with an exact model-scoped `does not support image inputs` rejection. This is a mismatch for that request, not evidence that the target is unhealthy, so it records no cooldown. This compatibility recovery does not silently change `none` into a different effort or broaden this exception to arbitrary invalid requests. Policy refusals, cancellation and already-committed output remain non-replayable. A single-target request still returns an unresolved upstream rejection.

## Default reasoning effort

`defaultEffort` supplies a configured effort when the selected target has a known, nonempty supported ladder. With the default `defaultEffortMode: "fallback"`, an explicit caller effort keeps precedence. `defaultEffortMode: "force"` overrides a valid caller effort with the configured default; it requires a valid, non-null `defaultEffort` and can increase cost and latency. Force mode is an explicit operator choice through combo configuration or management.

The target's advertised ladder remains authoritative. An exact supported value is retained; otherwise the highest supported rung at or below it is selected, or the lowest supported rung when none is lower. Unknown or empty ladders never cause default injection. Force mode does not repair malformed caller effort into a valid expensive request. Other reasoning fields, including `reasoning.summary`, are preserved.

`reasoningEffortMode` remains independent of `defaultEffortMode`: explicit empty ladders remove unsupported effort/thinking controls, and adaptive unknown ladders do so as well, as described below. Strict unknown ladders preserve the caller's request without forcing a default. Supported defaults are `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`; omit `defaultEffort` or set it to `null` to disable default injection in fallback mode.

### Mixed-capability groups (`reasoningEffortMode`)

The effort levels a combo advertises are the intersection of what its targets advertise. A target
that explicitly advertises **no** effort control takes part in that intersection, so a single
no-effort backup empties the effort picker for the whole combo — including for the targets that do
support tuning.

Set `reasoningEffortMode: "adaptive"` to exclude those empty ladders from the published
intersection instead. The picker then shows the levels the remaining targets share, and the
no-effort target stays eligible for routing. Targets whose ladder is simply *unknown* are treated
as wildcards in both modes.

```json
{
  "combos": {
    "mixed": {
      "targets": [
        { "provider": "openai-apikey", "model": "gpt-5.6-luna" },
        { "provider": "local", "model": "no-effort-model" }
      ],
      "reasoningEffortMode": "adaptive"
    }
  }
}
```

The default is `"strict"`, which keeps the original picker behavior. This setting does not change
target order or failover policy. At dispatch, an explicitly empty target ladder has its unsupported
effort/thinking controls removed in either mode while preserving supported non-effort reasoning fields
such as `reasoning.summary`; `"adaptive"` applies the same normalization to an unknown target
capability, while known non-empty targets keep their existing per-target effort resolution.
In the dashboard it is the **Adaptive reasoning ladder** switch in a
combo's Capabilities section.

## Image / multimodal capability

By default a combo publishes the **intersection** of its targets' input modalities (image is
enabled only when every target advertises it). Set `imageInput: "disabled"` to force text-only
even when every target supports images — the catalog drops `image` from `inputModalities`, and
image-bearing requests are rejected with HTTP 400 before any target is called. `"auto"` (or
omitting the field) keeps the automatic intersection.

## Encrypted v2 sub-agent tasks

There is one important limitation for Codex v2 sub-agents ([issue #92](https://github.com/lidge-jun/opencodex/issues/92)).
A native parent can send a newly spawned worker's task only as ciphertext minted for the native
ChatGPT backend. An external provider cannot read that payload.

For such a request, a combo filters its eligible targets to canonical native ChatGPT routes,
including after a retryable failure. If the combo has no decrypt-capable target, opencodex stops
before dispatch and returns HTTP 400:

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "unreadable_encrypted_agent_task"
  }
}
```

This protects the task from being sent to a provider that would receive no readable instructions.
Readable plaintext tasks use the normal combo strategy.

You have four recovery options:

1. Select a native ChatGPT model for the child.
2. Add a canonical native ChatGPT target to the combo.
3. Use the v1 surface for delegation across different providers.
4. If you control the caller, resend the task as plaintext v2 `agent_message` content.

See [Sub-agent Surface](/guides/sub-agent-surface/) for the v1/base/v2 modes and the full encrypted
task workflow.

## Manage combos

### Dashboard

Open the local dashboard and choose **Models → Combos**. The workspace creates, edits, renames, and removes
combos, and its target picker excludes disabled models, nested combos, and the credential-only JEV
provider. **Create JEV Auto** opens the same Combo editor with an editable decision target template;
an existing `jev-auto` id or alias is reported instead of creating a duplicate. A JEV Combo also shows
**Decision service** (TypeSafe JEV or a configured `jev-decision` provider) and **Decision timeout
(ms)**, and the Combos overview lists each JEV Combo's decision service, endpoint, and timeout.

Each target also shows a live quota badge: **Available**, **Out of quota**, or **Quota unknown**. The editor blocks Save and Create for quota only when every usable target has a current server-confirmed exhausted inference limit for its configured credential. Display-only account, model, search and MCP quota, or missing or expired routing evidence, does not cause this block. The block expires at the applicable reset or freshness boundary and is rechecked when the page becomes active or visible; Refresh reloads both Combo data and quota. The dashboard
editor does not yet expose `cooldownMs` or `waitForCooldownMs`; use the configuration file or management
API until the follow-up UI work lands.

### CLI

The primary commands are:

```bash
ocx combo list
ocx combo show <id>
ocx combo set <id> --targets provider/model[:weight],...
ocx combo remove <id> --yes
```

`set` also accepts `--strategy`, `--sticky`, `--effort`, `--alias`, `--native-alias`,
`--display-name`, `--decision-provider`, `--decision-timeout`, and `--rename-from`. Use `-` as the
value of `--effort`, `--alias`, `--display-name`, `--decision-provider`, or `--decision-timeout` to
clear that field. The two decision flags apply only to `--strategy jev`. `--native-alias` requires a currently supported bare native
model alias and a non-empty display name. `create` and `update` are aliases for `set`; `delete` is an alias for
`remove`; and the same subcommands are available under `ocx route combo`.

### Management API

Headless clients use `GET`, `PUT`, and `DELETE` on `/api/combos`. `GET` lists normalized combo
definitions, `PUT` creates or replaces one (and can rename one), and `DELETE` takes the id query
parameter. Authentication and request/response details are in the
[Management API reference](/reference/management-api/). When a `PUT` body omits `cooldownMs`
or `waitForCooldownMs`, the API preserves the value already stored for that combo; send an explicit
value to change it. An explicit `cooldownMs` (even `60000`) is persisted as-is because it overrides
the request-rate fallback. A stored `cooldownMs` can only be removed by editing the configuration file;
`waitForCooldownMs` resets to its default when a `PUT` explicitly sends `0`, because the sparse
serializer omits that default. Omission preserves both values and the dashboard does not expose them yet.
Omitting `defaultEffortMode`, `reasoningEffortMode`, `imageInput`, or `cooldownWaitPolicy` likewise
keeps the stored value. For a request that keeps `strategy: "jev"`, the decision method is kept
only when both `decisionProvider` and `decisionModel` are omitted: sending either one replaces the
stored method, so `decisionModel: null` without `decisionProvider` selects TypeSafe.
`decisionTimeoutMs` is kept on its own whenever it is omitted. A different strategy drops all three,
and a re-sent target without `lastResort` keeps that target's flag (matched by
provider and model). The dashboard always sends `imageInput` and `reasoningEffortMode`, and for a JEV
Combo `decisionProvider`, `decisionModel` and `decisionTimeoutMs` (`null` for the default), so switching them back to
the default there still replaces the stored value.

For the complete persisted configuration, see [Configuration](/reference/configuration/).

## Configuration reference

Combos are stored in the top-level `combos` object, keyed by combo id:

```json
{
  "combos": {
    "balanced": {
      "targets": [
        { "provider": "anthropic", "model": "claude-opus-4-8", "weight": 2 },
        { "provider": "openai", "model": "gpt-5.6-sol", "weight": 1 }
      ],
      "strategy": "round-robin",
      "stickyLimit": 2,
      "defaultEffort": "high",
      "alias": "team/balanced"
    }
  }
}
```

| Field | Required | Default | Rules |
| --- | --- | --- | --- |
| `targets` | Yes | — | Non-empty ordered array of configured `{ provider, model, weight?, lastResort? }` targets. Duplicate provider/model pairs are rejected. |
| `targets[].weight` | No | `1` | Integer from 1 to 10,000. Used by round-robin and random; ignored by failover, least-used, reset-window, and JEV. |
| `targets[].lastResort` | No | `false` | Marks an emergency-only target. Inert unless `cooldownWaitPolicy` is set. Never makes a target permanently ineligible: when no normal target can be reached it is dispatched as usual. |
| `strategy` | No | `"failover"` | `"failover"`, `"round-robin"`, `"random"`, `"least-used"`, `"reset-window"`, or `"jev"`. JEV decides only the initial eligible target and effort; ordinary Combo fallback owns later attempts. |
| `stickyLimit` | No | `1` | Integer from 1 to 100 successful requests per round-robin selection. Applies only to round-robin. |
| `cooldownMs` | No | unset → upstream fallback (5 s for request-rate 429 codes `1302`/`1305`, 10 min for a spent usage window or a credential/billing failure, otherwise 60 s) | Integer from 1 to 600000. When set, applies as the per-target cooldown whenever no usable upstream `Retry-After` or Codex reset signal exists, including request-rate 429s; when unset, uses the upstream fallback. |
| `waitForCooldownMs` | No | `0` | Integer from 0 to 600000. Maximum time to wait for the earliest eligible cooling target before returning `combo_unavailable`; abort cancels the wait. |
| `cooldownWaitPolicy` | No | unset | `"before-last-resort"` defers targets marked `lastResort`: they are used only when no normal target is available, for every strategy, and `waitForCooldownMs` only adds the wait for a cooling normal target, so at its `0` default nothing waits and the last resort is used as soon as no normal target is available. Only that exact string opts in. The deferral wait and the ordinary wait share one `waitForCooldownMs` budget per selection attempt. |
| `defaultEffort` | No | `null` | `low`, `medium`, `high`, `xhigh`, `max`, or `ultra`; resolved against each target's advertised ladder. |
| `defaultEffortMode` | No | `"fallback"` | `"fallback"` preserves explicit caller effort. `"force"` overrides valid caller effort, requires a valid non-null default, and can increase cost and latency. |
| `reasoningEffortMode` | No | `"strict"` | `"strict"` intersects every known target ladder, so one target advertising no effort control empties the combo's picker. `"adaptive"` excludes those empty ladders from the published intersection. At dispatch, explicit empty or adaptive unknown ladders remove unsupported effort/thinking controls while preserving supported non-effort reasoning fields such as `reasoning.summary`; known non-empty targets keep existing effort resolution. |
| `imageInput` | No | `"auto"` | `"auto"` or `"disabled"`. `"auto"` publishes image support only when every target supports images; `"disabled"` forces text-only (drops image from published modalities and rejects image-bearing requests before dispatch). |
| `alias` | No | none | Optional trimmed public model id; use the alias rules above. An empty value is stored as no alias. |
| `nativeAlias` | No | `false` | Explicitly permit a currently supported bare native `alias` to take routing and catalog precedence. Never inferred from the alias. |
| `displayName` | No | none | Bounded display-only catalog label. Required and non-empty when `nativeAlias` is true. |
| `decisionProvider` | No | `"jev"` | JEV only. Provider id of the decision service: `"jev"` (TypeSafe, valid without a provider row; the same as omission) or a configured `adapter: "jev-decision"` row with a `/systemone` `baseUrl`, such as a self-hosted Ollama `tev1`. |
| `decisionTimeoutMs` | No | `4000` | JEV only. Integer from 1000 to 120000: the decision deadline before failing open to the first eligible target. |

## Troubleshooting

### Why does `combo/<id>` return 404?

The combo id is unknown. The response is HTTP 404 with type `invalid_request_error`. Run
`ocx combo list`, check spelling and case, and confirm your management command wrote to the same
running opencodex instance that receives model requests.

### Why do I get `combo_unavailable`?

Every target is currently ineligible: for example, its provider is disabled, it is cooling down,
it has already been attempted for this request, or an encrypted v2 task excludes it. Check target
provider state and recent upstream errors. For cooldowns, follow an observed `Retry-After` value first;
Codex reset headers also take precedence over `cooldownMs`.
If neither upstream signal is usable, the configured `cooldownMs` applies, or the upstream fallback applies
when it is unset (5 seconds for request-rate codes `1302`/`1305`, 10 minutes for a spent usage
window or a credential/billing failure, otherwise 60 seconds). Explicit
`Retry-After` delays are capped at 24 hours; the other cooldowns are capped at 10 minutes.

### Why was my alias rejected?

Check the alias grammar and reserved names first. A duplicate alias or invalid shape is rejected as
HTTP 400. A slashed alias whose first segment is a configured Codex account namespace is rejected
as HTTP 409; choose a different alias namespace. The CLI and dashboard display the server's exact
validation message.

### Why did failover stop after the first error?

The error was terminal rather than target-specific. Fix invalid input, reduce an oversized context,
handle a policy refusal, or correct the rejected request origin. Combos do not hop for those cases.
