---
title: Catalog options
description: Optional native model omission in the generated Codex catalog.
---

## Reloading model metadata

Codex loads a local model catalog at startup. After OpenCodex changes that catalog,
run `ocx sync --restart-codex` to refresh existing clients. Publishing a new catalog
file does not update a client that is already running.

If a Codex client sends 64 or more eager MCP tool definitions, OpenCodex refuses the
request before contacting a model provider with HTTP 400 and error code
`codex_catalog_reload_required`. This prevents missing or stale model metadata from
causing repeated large prompts and compactions. Run the restart command and retry.
The check also covers definitions embedded in Code Mode; it leaves deferred tools,
ordinary conversation history, and other API clients unchanged.

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

Absent, false, or malformed values preserve the default hidden-row behavior.
Existing native-alias omission remains independent of this flag. This setting controls
discovery only: direct requests to disabled native ids still route normally, and unchanged
sync output keeps its existing no-op write and mtime behavior.

See [Codex App models](/guides/codex-app-models/#what-this-means-for-a-disabled-native-model)
for Desktop visibility and [provider configuration](/reference/configuration/providers/)
for `disabledModels`.
