---
title: Catalog options
description: Catalog reloads, optional native model omission, and routed row defaults in the generated Codex catalog.
---

## Reloading model metadata

Codex loads a local model catalog at startup. After OpenCodex changes that catalog,
run `ocx sync --restart-codex` to refresh existing clients. Publishing a new catalog
file does not update a client that is already running.

A Codex client with missing or stale model metadata can send every MCP tool definition
eagerly instead of using deferred tool discovery, which makes each prompt much larger.
When a Codex request declares 64 or more eager MCP tool definitions, OpenCodex logs a
warning with the count and the threshold, then forwards the request unchanged. The
warning contains no tool names or request content. Restart Codex to reload the catalog:
`ocx system codex-restart --yes` restarts it on request (it interrupts running turns), while
`ocx sync --restart-codex` restarts only after it writes a changed catalog or configuration.

The warning is shown once per session. A request without a session identity has no
session to warn once per, so it is warned once per request instead: a retry or compaction
handoff of the same request stays silent, and the next anonymous request warns again.
The session list is bounded, so an install running more than 1024 concurrent sessions can
see one repeat warning from the session evicted after the longest idle time.

The count covers top-level tools, the Responses Lite `additional_tools` declarations the
client sent with this request, and MCP tools rendered into the Code Mode `exec`
description. Codex resends the window's catalog at the head of every request, so a
resumed turn's client-sent declarations count too, including a turn that resends its whole
stored window under `previous_response_id`; only history the proxy itself restored from
`previous_response_id` state is excluded. Compaction, including Responses API
compaction triggers, counts only the top-level tool catalog. The check recognizes
canonical Codex client identities or Codex turn metadata; an incidental `codex` substring
in another client's name does not activate it. Explicitly deferred tools, conversation
text, and other API clients are not counted.

The diagnostic has a fixed work budget. If a catalog or its surrounding input exceeds
that budget, OpenCodex skips the warning and processes the request unchanged.

Routed models advertise deferred discovery. In Code Mode, discover available tools
through `ALL_TOOLS` and call them through `tools`; a separate `tool_search` function
is not required. Models using the direct tool interface can expose `tool_search`.

## Omit disabled native models

`omitDisabledNativeModels` is an optional boolean in `config.json`, defaulting to `false`.
Enable it and run `ocx sync` to omit explicitly disabled native rows without requiring a
native-alias combo:

```json
{
  "omitDisabledNativeModels": true,
  "disabledModels": ["gpt-5.5"]
}
```

The setting applies to sync, convergence, the generated models cache, and Codex-shaped
`/v1/models?client_version=…` discovery. A bare native disable omits that model and all its
account-selector rows; an account-qualified disable omits only that selector row.
The native inheritance template is validated and captured before omission, so routed
rows keep the same input and tool metadata, including when the only template row is disabled.

Absent, false, or malformed values preserve the default behavior without this additional omission.
Existing native-alias omission remains independent of this flag. This setting controls
discovery only: direct requests to disabled native ids still route normally, and unchanged
sync output keeps its existing no-op write and mtime behavior.

See [Codex App models](/guides/codex-app-models/#what-this-means-for-a-disabled-native-model)
for Desktop visibility and [provider configuration](/reference/configuration/providers/)
for `disabledModels`.

## Routed row defaults

Routed rows (`provider/model` and combo rows) are regenerated on every `ocx sync`, so a hand
edit to `opencodex-catalog.json` lasts only until the next sync. `routedCatalogDefaults` in
`config.json` sets a fixed group of row fields on every generated routed row instead:

```json
{
  "routedCatalogDefaults": {
    "includeSkillsUsageInstructions": true,
    "includeAppsUsageInstructions": true,
    "includePluginUsageInstructions": true,
    "defaultVerbosity": "medium"
  }
}
```

| Setting | Catalog row field | Values |
| --- | --- | --- |
| `includeSkillsUsageInstructions` | `include_skills_usage_instructions` | `true` or `false` |
| `includeAppsUsageInstructions` | `include_apps_usage_instructions` | `true` or `false` |
| `includePluginUsageInstructions` | `include_plugin_usage_instructions` | `true` or `false` |
| `defaultVerbosity` | `default_verbosity` | `"low"`, `"medium"`, or `"high"` |

Every setting is optional. An omitted setting keeps the value the row gets without this block,
inherited from the native template or the catalog default, and an explicit `false` stays `false`.
Run `ocx sync` after editing, or `ocx sync --restart-codex` to reload running clients. Removing
a setting or the whole block and syncing again restores the original values.

The three instruction flags tell Codex whether to add its skills, apps, and plugins usage
instructions to the prompt for that model. Turning one on makes every prompt for that model
larger. The flags only add guidance text; they grant no tool access.

Provider limits always win. A value the provider or model declares itself replaces the default on
that row. `defaultVerbosity` only sets the default level for models that already support
verbosity; it never turns verbosity support on, and a row without verbosity support never carries
`default_verbosity`, so the setting has no effect there.

The block applies to routed rows written by sync and convergence and to Codex-shaped
`/v1/models` discovery. Native OpenAI rows, account-qualified native rows, and custom models on
the built-in `openai` forward provider that reuse a native model's metadata keep their native
values. A routed row kept from the previous catalog because its provider could not be reached
keeps its old values until the provider answers and the row is regenerated. No other row field,
such as tool mode, search, or truncation, can be set here. An invalid block is ignored with a
warning when the configuration loads, and configuration writes reject it. The Dashboard has no
control for this block yet.
