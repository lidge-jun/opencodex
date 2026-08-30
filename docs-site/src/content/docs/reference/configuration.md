---
title: Configuration Reference
description: Where opencodex stores configuration, how edits are applied, and links to every configuration domain.
---

opencodex stores its persistent configuration in `$OPENCODEX_HOME/config.json`, normally
`~/.opencodex/config.json`. On Windows, the default is
`%USERPROFILE%\.opencodex\config.json`.

## Ways to edit configuration

Choose the editing channel that fits the task:

- **Dashboard:** use the web UI for guided provider, model, agent, access, and storage settings.
- **CLI:** `ocx init` creates the initial file, while commands such as `ocx provider`, `ocx models`,
  `ocx combo`, `ocx agent`, and `ocx config` update or inspect their owned settings.
- **File:** edit `config.json` directly for fields without a dedicated UI or CLI command. The file must
  remain valid JSON.

The dashboard, management API, and mutating CLI commands all persist to the same file. Prefer those
channels, or stop the proxy before hand-editing. A running process keeps configuration in memory, so a
later live save can rewrite unrelated hand edits from its snapshot. Live saves merge externally edited
`claudeCode` and listener-binding fields where those paths have explicit conflict protection, but that
protection does not cover every subtree.

If the file cannot be parsed, opencodex backs it up as
`config.json.invalid-<timestamp>`, warns on the console, and starts with defaults. A missing file also
uses the fresh-install default: one `openai` forward provider.

## Precedence and defaults

### Provider and model aliases

Aliases are optional short request names. They never change the native model id sent upstream, and omitting every alias field preserves existing routing exactly.

```jsonc
{
  "providers": {
    "openrouter": {
      "alias": "or",
      "modelAliases": { "anthropic/claude-opus-5": "opus" },
      "defaultAliases": true
    }
  },
  "defaultModelAliases": false
}
```

Aliases match case-insensitively. A model alias works as `or/opus` or, when globally unique, bare `opus`; an ambiguous bare alias reports its qualified candidates. Codex model pickers show the qualified alias while preserving the canonical `provider/model` routing id. A provider's `defaultAliases` value overrides `defaultModelAliases`. Built-ins are skipped when multiple models in one provider match the same pattern.

Valid values in `config.json` override built-in defaults. Missing optional fields use the defaults
documented on the domain pages. `OPENCODEX_HOME` takes precedence over the default configuration
directory. Fields that accept an environment reference, such as `apiKey: "${PROVIDER_API_KEY}"`,
resolve that variable at request time. For outbound proxying, an already-set `HTTP_PROXY` or
`HTTPS_PROXY` takes precedence over the top-level `proxy` field.

Routing has its own ordered resolution rules; see [Routing](/reference/configuration/routing/).

## Configuration domains

- [Providers](/reference/configuration/providers/) — provider entries, authentication, endpoints,
  catalogs, allowlists, context limits, quotas, and provider-specific options.
- [Routing](/reference/configuration/routing/) — `defaultProvider`, model resolution order, combos,
  aliases, and combo effort defaults.
- [Agents](/reference/configuration/agents/) — multi-agent mode, delegation guidance, fallback models,
  native-default sync, and effort caps.
- [Server and runtime](/reference/configuration/server/) — listener and remote access, admission keys,
  timeouts, storage, sidecars, startup behavior, and shadow calls.

## Keep secrets out of the file

Prefer `${ENV_VAR}` references for API keys. Literal `apiKey`, `apiKeyPool[].key`, and `apiKeys[].key`
values are secrets; do not commit, paste into logs, or share them. OAuth and forward-provider tokens are
stored in separate credential stores rather than in `config.json`. Account ids and emails should also
remain private; use public selector aliases where supported.

:::note[Atomic writes]
opencodex writes managed `config.toml` and `opencodex-catalog.json` files through a temporary file
followed by rename (`atomicWriteFile`).
This prevents partial files when concurrent writers, such as `ocx stop` and the proxy shutdown handler,
restore Codex at the same time.
:::
