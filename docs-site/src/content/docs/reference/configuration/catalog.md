---
title: Catalog options
description: Optional native model omission in the generated Codex catalog.
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
