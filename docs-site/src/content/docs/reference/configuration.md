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

### Cursor effort rows

`cursorEffortRows` is an optional boolean and defaults to `false`. When enabled, the raw OpenAI-style
`/v1/models` list adds `<base-id>--<effort>` selectors for reasoning-capable models that Cursor Private
Inference does not match in its installed effort table. Selecting a generated row routes the base model
and applies that row's effort; models Cursor already recognizes receive no variants. The flag reserves a
terminal `--<declared-effort>` suffix for generated selectors, except when the complete value is already
a known configured model id. Cursor may require a model-list refresh or restart after this setting changes.

### Fast rows

`fastRows` is an optional boolean and defaults to `true`. The raw OpenAI-style
`/v1/models` list, Claude Code discovery, and client config exports (including pi, OpenCode,
OMP, Hermes, OpenClaw, Kimi, Gajae, DSH, MCode, ZCode, Prime, and Aside) add a `<base-id>--fast` selector for every model whose
resolved Fast policy is eligible. Selecting one routes the base model and requests the `priority`
service tier — the same Fast the Codex app exposes through its picker toggle. The base row stays
listed, so the row is an addition rather than a replacement.

Set `"fastRows": false` to hide generated Fast selectors. Malformed values also disable them.
Refresh the client model list or regenerate/refresh an existing managed client configuration to
receive the new entries. Connected clients use the serving proxy's availability metadata; older
proxies without that metadata do not gain guessed Fast entries. Codex keeps its native Fast toggle.

The suffix is `--fast`, with two hyphens, because a terminal `-fast` is already a real model id for
several providers (`grok-4-fast`, `glm-5.3-fast`, and Cursor's own fast variants), and a single
hyphen could not tell a product apart from a tier. An exact configured model id always wins over the
generated suffix, and an id carrying both this marker and an effort marker resolves to neither.

A row appears only where the tier can actually be honoured: a model whose provider does not support
it, or supports it on a wire the route cannot use, gets no row. `fastMode: false` still suppresses
Fast globally and takes precedence over a selected row, and a selector whose model later loses
eligibility degrades to an ordinary request instead of failing.

Native models carry one extra condition: as well as an eligible policy, upstream must advertise the
Fast tier for that model. This is the same evidence the Codex picker's own toggle is built from, so
the two surfaces cannot disagree about which natives have Fast.

Scope: this covers the request-serving surfaces — `/v1/models`, Claude Code discovery, and the
`/v1/responses`, `/v1/chat/completions`, `/v1/messages`, `/v1/messages/count_tokens`, and
`/v1/responses/compact` endpoints, plus `ocx export`, managed client integrations, and
the OpenCode launcher. After disabling Fast rows, refresh saved client configs and select a base
model instead of a previously saved Fast selector.

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
