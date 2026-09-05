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

## Guardrails: sensitive-data placeholders

`guardrails` is disabled by default. Enabling it makes opencodex scan supported textual request fields
for the Responses, Chat Completions, Anthropic Messages/token-count, and Responses compact paths.
In `enforce` mode, detected values are replaced before an outbound provider call with per-turn placeholders such as
`<STRIPE_ACCESS_TOKEN_1>`. Exact placeholders, plus bounded normalized variants produced by a
model, are restored in a successful JSON, SSE, or Responses-over-WebSocket reply only for the
original client and only in non-executable assistant prose. Normalization is limited to ASCII case,
hyphen-versus-underscore separators, embedded ASCII whitespace, and leading zeroes in the numeric
suffix; the candidate token remains capped at 256 UTF-16 code units.
Function/tool arguments, Anthropic `tool_use` input, and shell/computer/tool-search actions remain
masked even in the client-facing response.

Response restoration is bounded and fail-safe. Successful responses that cannot be classified as
JSON or SSE, malformed JSON/UTF-8, and JSON bodies above 32 MiB are returned with placeholders still
masked and produce a metadata-only demask warning; opencodex never partially restores such output.

Images, binary data, and unsupported opaque values are left unchanged. Guardrails is a transport
privacy control, not a general DLP system: it cannot prevent a model from independently inferring or
rephrasing information that was otherwise available to it.

Each semantic text leaf is capped at 128 KiB and the aggregate logical turn at 2 MiB. A separate
128 MiB regex-work budget multiplies UTF-8 bytes by the number of rules that actually execute after
keyword prefiltering. Crossing any limit follows `failurePolicy` for the entire request; opencodex
never sends a partially masked body.

```json
{
  "guardrails": {
    "enabled": true,
    "mode": "enforce",
    "failurePolicy": "block",
    "providerScope": { "mode": "all" },
    "enabledDataTypes": [1, 2, 3, 4, 5, 6],
    "keywordPrefilterEnabled": false
  }
}
```

| Field | Meaning and default |
| --- | --- |
| `enabled` | Explicit opt-in. Only `true` activates the scanner; absence and `false` leave existing traffic unchanged. |
| `mode` | `enforce` (default) replaces detected values on the provider-facing request and restores issued placeholders in eligible response prose. `detect` scans the request but preserves the baseline provider wire payload produced by normal protocol translation and leaves the provider response unchanged; it does not protect upstream data or persist the request for Responses replay. |
| `failurePolicy` | `block` (default) rejects a request when the scanner cannot process it safely, including a traversal limit. `passthrough` may send that request unchanged instead and records a high-severity metadata event. It is an explicit fail-open policy, not a rule-match policy. |
| `providerScope` | Optional closed object. Omitted or `{ "mode": "all" }` protects every current and future provider. `{ "mode": "selected", "providerIds": ["openai", "anthropic-native"] }` protects only those canonical provider IDs. Selected mode requires a non-empty, unique list of valid IDs. `anthropic-native` is reserved for the built-in native Anthropic path and cannot name a configured provider. |
| `enabledDataTypes` | Optional non-empty subset of the numeric categories below; omitted means all six. |
| `disabledBuiltinRuleIds` | Optional built-in rule IDs to disable. Obtain IDs from `GET /api/guardrails/catalog`; the endpoint does not disclose matchers. |
| `customRules` | Up to 100 declarative local rules. Rule IDs match `^[a-z0-9_.-]{1,128}$`, patterns are RE2-compatible and at most 4096 UTF-8 bytes, and placeholder types match `^[A-Z][A-Z0-9_]{0,63}$`. Executable plugins are not supported. |
| `keywordPrefilterEnabled` | Optional recall-preserving performance prefilter, off by default. It skips only built-in rules whose parsed RE2 expression proves that every match contains a declared keyword; custom and unproven rules always execute. |

| Value | Data type |
| --- | --- |
| `1` | Credentials |
| `2` | API keys |
| `3` | Access tokens |
| `4` | IP addresses |
| `5` | Personal data |
| `6` | Custom |

Changes made through the dashboard or Management API are validated and compiled before the active
runtime snapshot is replaced. An invalid custom pattern or conflicting rule leaves the previous
configuration and scanner in place.

Provider scope is evaluated from the canonical routed provider ID. `anthropic-native` identifies
the native Anthropic credential path; routed `anthropic` remains a separate provider. Policy-fallback
attempts are evaluated by concrete provider. A combo is unprotected only when all targets are
excluded; a mixed combo remains protected as one logical turn. A protected continuation cannot
resume through an unchecked provider and receives HTTP `409 guardrails_policy_changed` before
upstream I/O.

If startup finds a malformed optional `guardrails` section, opencodex warns and ignores it when the
section was not explicitly enabled. A malformed section containing `enabled: true` preserves that
opt-in by falling back to the built-in `enforce`/`block` policy. Unrelated provider/account
configuration is preserved in both cases. Live writes are strict and fail without changing the
active or persisted registry.

### Continuations and telemetry boundary

When a Responses request uses `previous_response_id`, the placeholder mapping is retained only in
process memory for up to one hour, with bounded entry count and memory. It is keyed to a normalized
continuation lane derived from `x-codex-parent-thread-id`, `thread-id`, or
`session_id`/`session-id`, plus the admission identity. A parent and a more specific child/session
ID are paired when both are present. Configured credentials use their key ID;
environment admission is one process-wide identity; loopback relies on the local-process trust
boundary. Unscoped, cross-thread, or cross-key requests never inherit a mapping. It is never
written to the ordinary response replay cache or its snapshots. After a restart or expiry, resend the
full text rather than relying on a prior placeholder being restored.

An enforced continuation can resume after enforce rules or settings change: existing mappings keep
their original expiry, while new values use the current enforce registry. Switching the continuation
to detect, disabled, or an unchecked provider returns HTTP `409` with code
`guardrails_policy_changed`; start a new session before weakening the policy. Compact output stays masked and inherits its mapping only through an
in-memory, scope-bound fingerprint of the exact returned compact artifact.

For an enforced turn, request logs and usage-debug capture retain structural metadata such as token
counts and status, but not response bodies or upstream error text. This prevents a downstream
WebSocket or debug logger from retaining values restored for the client.

Use the [Guardrails Management API](/reference/management-api/#guardrails) for automation or the
[Guardrails guide](/guides/guardrails/) for the dashboard workflow, protocol coverage, and
non-covered payloads.

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
