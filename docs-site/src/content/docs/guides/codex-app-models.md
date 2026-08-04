---
title: Codex App model picker
description: How opencodex models appear in Codex App, Codex CLI, and Codex TUI through the shared Codex catalog.
---

opencodex does not patch Codex App. It writes the same Codex configuration and model catalog that
Codex CLI/TUI already use. Because Codex App reads that shared state, routed models can appear in the
App's model picker as normal Codex catalog entries.

OpenAI entries have two stable identities: one bare native `openai` group whose Pool(default) or
Direct account selection is controlled by `codexAccountMode`, and namespaced
`openai-apikey/<model>` API-key transport. Changing the account mode does not change picker ids.
API GPT-5.6 entries use
1,050,000 context / 922,000 max input, and `*-pro` picker ids resolve to the base wire model with
`reasoning.mode: "pro"` while logs, usage, and picker state keep the virtual id.
The API catalog is fixed to exactly eight ids: `gpt-5.5`, `gpt-5.6`, Sol/Terra/Luna, and their
three Pro virtual ids; there is no generic `gpt-5.6-pro` alias.
Compact requests keep the selected tier but send the base model without a reasoning object.

Select a credential route explicitly; change Pool/Direct on the Providers page:

```text
gpt-5.6-sol                         # openai (Pool or Direct option)
openai-apikey/gpt-5.6-sol           # API key
```

Fresh installs and configs with no saved mode default to Pool. Current configs use marker 2 and
retain the shipped v1 source at `~/.opencodex/config.json.pre-openai-tiers-v2.bak`; restore it with:

```sh
cp ~/.opencodex/config.json.pre-openai-tiers-v2.bak ~/.opencodex/config.json
```

Earlier v1 three-provider configurations migrate automatically into the single option-aware row.

## Integration path

`ocx init`, `ocx start`, and `ocx sync` wire the shared Codex config and catalog into the proxy; see
[Codex Integration](/guides/codex-integration/) for config injection, catalog sync, shims, WebSocket
fallback, and restore mechanics.

## Why routed models show up

Codex's model picker expects Codex-shaped catalog entries. opencodex builds routed entries by cloning
a native Codex model template, then replacing the routed model identity:

```text
slug = "anthropic/claude-sonnet-..."
display_name = "anthropic/claude-sonnet-..."
visibility = "list"
```

The clone keeps strict-parser fields such as reasoning levels, shell type, API support flags, and
base instructions. opencodex then removes native-only capabilities that the route cannot honor,
including OpenAI service-tier metadata.

## Current stable model coverage

The native fallback set includes `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`,
`gpt-5.3-codex-spark`, and GPT-5.6 Sol/Terra/Luna. For the GPT-5.5/5.4 family, opencodex preserves
the installed Codex catalog's richer live entries and only synthesizes a missing entry. The bundled
upstream snapshot is used only for GPT-5.6, where it supplies the real per-model identity and
metadata instead of an older-template approximation.

| Route | Picker ids and catalog metadata |
| --- | --- |
| Codex login (Pool or Direct) | `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` (372,000-token catalog window) |
| OpenAI (API key) | Exactly eight namespaced rows: `gpt-5.5`, `gpt-5.6`, Sol/Terra/Luna, and the three `*-pro` virtual ids (1,050,000 context; 922,000 max input for all eight) |
| OpenRouter | `openrouter/openai/gpt-5.6-sol`, `openrouter/openai/gpt-5.6-terra`, `openrouter/openai/gpt-5.6-luna` (1,050,000) |
| Cursor | Static fallback includes `cursor/gpt-5.6-sol`, `cursor/gpt-5.6-terra`, and `cursor/gpt-5.6-luna` (1,000,000), plus `cursor/grok-4.5` and `cursor/grok-4.5-fast` (500,000); live account discovery decides which remain visible. |
| xAI | Live discovery is authoritative; the fallback catalog defaults to `xai/grok-4.5` with a 500,000-token window and `low` / `medium` / `high` reasoning controls. |

The pinned GPT-5.6 entries preserve the exact upstream ladder. Sol and Terra expose `low` through
`ultra`; Luna stops at `max`. Sol defaults to `low`, while Terra and Luna default to `medium`.
`ultra` is a client-facing choice for maximum reasoning plus proactive delegation and reaches the
backend as `max`. A picker entry only means the catalog is ready: the connected account or API key
must still be entitled to use that model.

## Native and routed model toggles

The dashboard Models page uses `disabledModels` for both model families:

- Routed ids are namespaced (`provider/model`). Disabling one excludes it from the synced catalog
  and `/v1/models`.
- Native GPT ids are bare slugs. Disabling one keeps its catalog entry but changes
  `visibility` to `hide`, preserving the exact entry for a later re-enable; the bare OpenAI list
  shape omits it while disabled.
- Native rows come from the supported static set, so a disabled native model stays visible in the
  dashboard and can be turned back on.

The visibility pass runs after snapshot upgrades, and the management API refreshes the catalog and
forces Codex's model cache stale after a toggle.

## Multi-agent surface mode

The Models-page v1/base/v2 control changes which Codex collaboration surface each picker entry uses;
see [Sub-agent Surface](/guides/sub-agent-surface/) for the canonical mode, delegation, inheritance,
fallback, and encrypted-task behavior.

## Reasoning top tiers

Reasoning-tier visibility is independent of the v1/base/v2 surface mode. Generated reasoning-capable
entries advertise `max` so direct sub-agent effort overrides validate; current generated routed
entries and older native GPT entries also advertise `ultra`. Exact upstream GPT-5.6 ladders are
preserved, so Luna has `max` but no `ultra`.

On the wire, routed adapters map or clamp unsupported tiers. For older native models whose real
ladder stops at `xhigh`, `nativeEffortClamp` maps a direct `max` or an `ultra` selection to `xhigh`
(for example, GPT-5.5). Sol, Terra, and Luna have a real `max` rung.

## Fast tier rules

Codex stores fast mode as:

```toml
service_tier = "fast"

[features]
fast_mode = true
```

But the model catalog and runtime request tier id use `priority`. opencodex preserves that split.
Native OpenAI passthrough models keep fast support; routed non-OpenAI models strip service-tier
metadata so the fast option is not advertised where it cannot be honored.

## Subagent selection

Codex sorts picker-visible catalog entries by ascending `priority` and advertises the first five as
`spawn_agent` model overrides. Pick up to five bare native ids or namespaced `provider/model` ids
through `subagentModels` or the dashboard Subagents page; opencodex gives those entries priorities
0-4 in the chosen order. Other models remain callable by exact id.

The featured-model list is separate from the Dashboard's **Sub-agent delegation** selection. It
controls which overrides Codex offers first; it does not select a model or trigger delegation by
itself.

## Refreshing model state

If the picker still shows stale entries, refresh the catalog and restart the target Codex surface:

```bash
ocx sync
```

opencodex rewrites `models_cache.json` with a deliberately stale cache wrapper whenever catalog
visibility, priority, or metadata changes, so the next Codex model refresh reads the new catalog.
