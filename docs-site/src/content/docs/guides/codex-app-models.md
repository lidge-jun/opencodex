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
