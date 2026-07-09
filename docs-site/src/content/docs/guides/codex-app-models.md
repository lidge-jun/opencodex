---
title: Codex App model picker
description: How opencodex models appear in Codex App, Codex CLI, and Codex TUI through the shared Codex catalog.
---

opencodex does not patch Codex App. It writes the same Codex configuration and model catalog that
Codex CLI/TUI already use. Because Codex App reads that shared state, routed models can appear in the
App's model picker as normal Codex catalog entries.

## Integration path

`ocx init`, `ocx start`, and `ocx sync` keep these Codex files aligned under the resolved
`CODEX_HOME` directory:

```text
$CODEX_HOME/config.toml
$CODEX_HOME/opencodex.config.toml
$CODEX_HOME/opencodex-catalog.json
$CODEX_HOME/models_cache.json
```

The active provider is installed as a root config key:

```toml
model_provider = "opencodex"
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
```

The provider itself is registered as a Responses-compatible endpoint:

```toml
[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://127.0.0.1:10100/v1"
wire_api = "responses"
requires_openai_auth = true
```

`websockets` is off by default. opencodex only advertises `supports_websockets = true` in the
provider table and catalog entries when `"websockets": true` is set.

## Why routed models show up

Codex's model picker expects Codex-shaped catalog entries. opencodex builds those entries by cloning
a native Codex model template, then replacing the routed model identity:

```text
slug = "anthropic/claude-sonnet-..."
display_name = "anthropic/claude-sonnet-..."
visibility = "list"
```

The clone keeps strict-parser fields such as reasoning levels, shell type, API support flags, and
base instructions. That makes each routed entry look like a valid picker-visible Codex model.

## GPT-5.6 preview entries

Preview builds add GPT-5.6 Sol/Terra/Luna to the synced catalog without waiting for every installed
Codex catalog to ship those slugs:

| Route | Picker id |
| --- | --- |
| ChatGPT passthrough | `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` |
| OpenAI (API key) | `openai-apikey/gpt-5.6-sol`, `openai-apikey/gpt-5.6-terra`, `openai-apikey/gpt-5.6-luna` |
| OpenRouter | `openrouter/openai/gpt-5.6-sol`, `openrouter/openai/gpt-5.6-terra`, `openrouter/openai/gpt-5.6-luna` |

Each entry advertises the current GPT-5.6 context metadata (372,000 usable tokens) with the exact
upstream reasoning ladder per slug: Sol and Terra keep `xhigh`, `max`, and `ultra` as separate
choices, while Luna ends at `max` (upstream ships no `ultra` for Luna). Sol defaults to `low`
reasoning; Terra and Luna default to `medium`. `ultra` follows upstream Codex semantics — maximum
reasoning with proactive multi-agent delegation, sent to the backend as `max`. If the upstream
account is not enabled for the model, the request still fails upstream normally.

## Multi-agent surface mode

opencodex adds a 3-state multi-agent surface override that controls the `multi_agent_version` field
on every catalog entry:

| Mode | Effect |
| --- | --- |
| **All v1** | Force every model to the v1 multi-agent surface, overriding upstream pins (including sol/terra). |
| **Default** (install default) | Respect upstream model pins: sol/terra use v2, luna uses v1, everything else follows the codex `multi_agent_v2` feature flag. |
| **All v2** | Force every model to the v2 multi-agent surface, overriding upstream pins (including luna). |

Set the mode from the dashboard Models page (segmented control), `ocx v2 mode v1|default|v2`, or
`PUT /api/v2` with `{ "multiAgentMode": "v1" }`. Changes apply to new Codex sessions.

## Ultra reasoning

Ultra is always advertised in the catalog regardless of the `multi_agent_v2` toggle state. The v2
toggle controls only the multi-agent collab surface, not ultra visibility. On the wire, opencodex
clamps ultra to each model's real top rung (e.g. gpt-5.5 ultra becomes xhigh) via `nativeEffortClamp`.

## Fast tier rules

Codex currently stores fast mode as:

```toml
service_tier = "fast"

[features]
fast_mode = true
```

But the model catalog and runtime request tier id use:

```text
priority
```

opencodex preserves that split. Native OpenAI passthrough models keep fast support; routed
non-OpenAI models strip service-tier metadata so the fast option is not advertised where it cannot
be honored.

## Subagent selection

Codex's `spawn_agent` advertises the highest-priority first 5 catalog models. Pick up to five
`provider/model` or native ids through `subagentModels` or the web dashboard; opencodex sorts those
entries to the front of the shared catalog.

## Refreshing model state

If the picker still shows stale entries, refresh the catalog and restart the target Codex surface:

```bash
ocx sync
```

opencodex also invalidates Codex's `models_cache.json` when it changes routed model visibility or
catalog metadata.
