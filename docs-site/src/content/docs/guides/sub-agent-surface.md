---
title: Sub-agent Surface (v1 / base / v2)
description: Control how Codex spawns and manages sub-agents across all models.
---

opencodex lets you choose the multi-agent collaboration surface for every model in the catalog. The **Sub-agent** toggle in the dashboard and Models page controls this globally.

:::note
On the v2 surface (`multi_agent_v2`), a spawned sub-agent inherits the parent model **by default**: `fork_turns` defaults to `all`, and full-history forks reject overrides. Since v2.7.2 opencodex injects guidance that teaches the model how to break inheritance — a `spawn_agent` call that sets `fork_turns` to `"none"` (or a partial fork such as `"3"`) can pass `model` / `reasoning_effort` arguments, which the Codex runtime parses and applies even though the published tool schema hides them. Known limitation: when a **native** parent spawns a child routed to a **non-native** provider, the Codex client may send the `NEW_TASK` payload only as backend-encrypted `encrypted_content`, so the routed child receives an empty task body ([#92](https://github.com/lidge-jun/opencodex/issues/92)). The model override still applies, but the task text can be lost — the v1 surface remains the reliable choice for heterogeneous-provider delegation.
:::

## Modes

| Mode | Surface | Behavior |
| --- | --- | --- |
| **v1** | `multi_agent_v1` | Classic namespaced agent tools with `send_input` / `close_agent` / `resume_agent`. A `spawn_agent` model override can start a sub-agent on a different model. |
| **base** (default) | Upstream pins | Restores upstream model pins: gpt-5.6-sol and gpt-5.6-terra use v2, gpt-5.6-luna uses v1, and unpinned models follow the Codex `multi_agent_v2` feature flag. Spawn behavior follows the surface that resolves for that model. |
| **v2** | `multi_agent_v2` | Flat `spawn_agent` tools with concurrent sessions and `send_message` / `followup_task` / `wait_agent` / `interrupt_agent`. Children inherit the parent model on full-history forks; `fork_turns: "none"` (or a partial fork) accepts `model` / `reasoning_effort` overrides. Task body may arrive encrypted for native→routed children ([#92](https://github.com/lidge-jun/opencodex/issues/92)). |

## How it works

The mode sets the `multi_agent_version` field on every catalog entry that Codex reads:

- **v1 mode**: forces `multi_agent_version = "v1"` on all entries, overriding upstream pins.
- **base mode**: restores upstream defaults. Pinned models get their snapshot value; unpinned models omit the field so the Codex feature flag decides.
- **v2 mode**: forces `multi_agent_version = "v2"` on all entries, overriding upstream pins.

The override is the final pass in both the live `/v1/models` catalog response and the on-disk catalog sync. Mode changes therefore apply consistently to newly created sessions, regardless of how an entry was built.

### Delegation model and effort

The dashboard's **Sub-agent delegation** picker stores an `injectionModel` and, optionally, an `injectionEffort`. These are delegation guidance settings, not a proxy-side spawn router. An optional `injectionPrompt` replaces the built-in guidance text entirely.

`multiAgentGuidanceText` identifies the surface from the request's tools — including the Codex Desktop WebSocket path (`responses_lite`), where tools arrive inside an `additional_tools` input item instead of the request's `tools` array.

On a **v2** turn (Sol/Terra in base mode, every model in v2 mode), the proxy injects a compact guidance block — budgeted to 700 characters — whenever an eligible injection model is set or the effective sub-agent roster is non-empty. The block conditionally describes `model` / `reasoning_effort` overrides without assuming whether they appear in the active schema, mandates `fork_turns: "none"` (or a partial fork), names only an eligible canonical preferred model, and lists only configured models in Codex's picker-visible, v2-compatible, priority-sorted first five with their available effort ladders.

On a **v1** turn the proxy only mirrors upstream's Proactive delegation text at the top effort tier (max / ultra). No model designation, roster, or custom prompt is added there — v1 stays lean by design.

To replace the built-in v2 guidance, set `injectionPrompt` (config key, or `PUT /api/injection-model` with a `prompt` value). The placeholders `{{model}}`, `{{effort}}`, and `{{roster}}` are substituted with the configured injection model, effort, and the resolved roster line. Firing gates are unchanged: a custom prompt never makes a turn fire that would otherwise stay silent.

## Changing the mode

### GUI

- **Dashboard** → first stat cell: click **v1**, **base**, or **v2**.
- **Models** page → top-row segmented control.
- Both pages have a **?** button that opens a help modal with a link back here.
- **Dashboard** → **Sub-agent delegation**: choose a preferred model and optional reasoning effort. On v2 the injected guidance instructs the agent to spawn with `fork_turns: "none"` so the model override applies — though for native→routed children the task body can currently arrive encrypted ([#92](https://github.com/lidge-jun/opencodex/issues/92)).

### CLI

```bash
ocx v2 mode v1       # force all models to v1
ocx v2 mode default  # restore upstream pins
ocx v2 mode v2       # force all models to v2
ocx v2 status        # show current mode + Codex feature flag
```

### API

```bash
# Read the surface mode, feature flag, and thread limit
curl http://localhost:10100/api/v2

# Set the surface mode
curl -X PUT http://localhost:10100/api/v2 \
  -H 'Content-Type: application/json' \
  -d '{"multiAgentMode": "v2"}'
```

The `/api/v2` PUT endpoint also accepts `enabled` (boolean, the Codex feature flag) and `maxConcurrentThreadsPerSession` (integer). It validates the request, saves the mode, resyncs the catalog, and reports that mode changes apply to new sessions.

The delegation picker uses a separate endpoint:

```bash
# Read the current model/effort and the available picker values
curl http://localhost:10100/api/injection-model

# Set both values
curl -X PUT http://localhost:10100/api/injection-model \
  -H 'Content-Type: application/json' \
  -d '{"model": "anthropic/claude-sonnet-5", "effort": "xhigh"}'

# Set a custom guidance prompt ({{model}}/{{effort}}/{{roster}} placeholders)
curl -X PUT http://localhost:10100/api/injection-model \
  -H 'Content-Type: application/json' \
  -d '{"model": "anthropic/claude-sonnet-5", "prompt": "Delegate to {{model}}.{{roster}}"}'

# Clear both values
curl -X PUT http://localhost:10100/api/injection-model \
  -H 'Content-Type: application/json' \
  -d '{"model": null}'
```

`GET /api/injection-model` returns `model`, `effort`, `prompt`, the global `efforts` ladder, and enabled native/routed `available` models. For PUT, omitting `effort` or `prompt` keeps the current value, `null` clears it, and clearing `model` always clears the effort too. The API validates effort against the global Codex ladder; Codex still validates a spawn effort against the target catalog entry.

## Reasoning effort

The optional sub-agent effort setting is stored as `injectionEffort` and is meaningful only with an injection model. It adds a `reasoning_effort` instruction to the injected v2 guidance; it does not change the parent session's effort. On any fork that accepts overrides, Codex applies a `reasoning_effort` passed to `spawn_agent` directly.

`ultra` ranks above `max` in the Codex catalog and adds automatic-delegation semantics, but it never reaches a provider as a literal wire value. Codex converts `ultra` to `max` at the client boundary. opencodex then keeps the provider request valid:

| Model | `max` on wire | `ultra` selection on wire |
| --- | --- | --- |
| gpt-5.5, gpt-5.4, gpt-5.4-mini | xhigh | xhigh (via max, then `nativeEffortClamp`) |
| gpt-5.6-sol, gpt-5.6-terra | max | max |
| gpt-5.6-luna | max | Not advertised by its exact upstream ladder |
| Routed models | Mapped or clamped by the adapter | Converted to max, then mapped or clamped by the adapter |

Catalog availability is independent of the v1/v2 mode. Reasoning-capable generated entries advertise `max` so direct sub-agent effort overrides validate; current generated routed entries also advertise `ultra`. Exact upstream model ladders are preserved, which is why gpt-5.6-luna stops at `max`.

## Context cap

The global context cap value defaults to 350k and limits the advertised `context_window` only for routed providers whose cap is enabled. Native OpenAI models keep their real context windows.

Change the value or the all-provider setting in the Models page, or toggle the cap next to an individual provider group header.
