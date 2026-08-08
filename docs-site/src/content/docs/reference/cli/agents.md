---
title: CLI Agents, Routing, and Integrations
description: Multi-agent, combo, observability, access, integration, system, and config commands.
---

These commands control agent policy and routing, inspect the live proxy, and connect supported clients to opencodex.

## Agent policy

### `ocx agent <status|injection|effort|subagents|fallback|sidecar> ...`

Manage the headless multi-agent roster, effort caps, prompt injection, fallback, and sidecar settings.
Use `status` for the current policy. See [Sub-agent surfaces](/guides/sub-agent-surface/) for how
surface modes, delegation, effort, and fallback behavior fit together.

```bash
ocx agent subagents set ark/model-a,openai/gpt-5.5
```

### `ocx v2 <status|on|off|mode <v1|default|v2>|threads <n>>`

Manage the Codex `multi_agent_v2` feature flag and the three-state multi-agent surface mode.

| Subcommand | Action |
| --- | --- |
| `status` (default) | Report the current v2 flag, multi-agent mode, and thread concurrency. |
| `on` | Enable the `multi_agent_v2` feature and resync the catalog. |
| `off` | Disable the `multi_agent_v2` feature and resync the catalog. |
| `mode v1` | Force all models to v1, disable native v2, and preserve the active thread limit. |
| `mode default` | Respect upstream model surface pins. |
| `mode v2` | Force all models to v2, enable native v2, and preserve the active thread limit. |
| `threads <n>` | Set the active v1/v2 thread limit to an integer of at least 1. |

```bash
ocx v2 status
ocx v2 mode v1
ocx v2 mode default
ocx v2 on
ocx v2 threads 16
```

The `mode` subcommand writes `multiAgentMode` to the opencodex config and resyncs the Codex catalog.
Mode and flag transitions move the current numeric thread limit between the valid v1/v2 Codex keys;
a failed transition restores the original `config.toml`. Changes apply to new Codex sessions, while
running sessions keep their pinned surface.

## Combo routing

### `ocx combo <list|show|set|remove> ...` · `ocx route combo ...`

Manage combo failover and round-robin virtual models. `ocx route combo` is the hierarchical alias;
combo is currently the supported routing resource. Targets use
`provider/model[:weight],provider/model[:weight]`.

```bash
ocx combo list
ocx route combo set reliable --targets ark/model-a:2,openai/gpt-5.5
```

`set` accepts `--strategy`, `--sticky`, `--effort`, `--alias`, `--rename-from`, `--native-alias`, and
`--display-name <label|->` (`-` clears the label). A native alias captures only one currently supported,
unqualified bare OpenAI model id. Bare `gpt-5.6-*` native aliases use Codex Pool/Direct credentials.
Account-qualified OpenAI routes remain distinct, while provider-qualified routes such as
`openai-apikey/gpt-5.6-*` use their configured API key and never fall through to the native alias.
Read the safety and visibility contract in the guide before enabling the compatibility pair.

See [Combos](/guides/combos/) for routing behavior and configuration guidance.

## Observability and debug

### `ocx observe <logs|usage|storage|memory|debug|claude-inbound|injection> ...`

Inspect proxy requests, usage, storage, memory, and debug data. The direct aliases are:

| Alias | Equivalent resource |
| --- | --- |
| `ocx logs [filters] [--follow] [--json|--jsonl]` | `ocx observe logs` |
| `ocx usage [--range <7d|30d|all>] [--surface <all|codex|claude|grok>] [--json]` | `ocx observe usage` |
| `ocx storage [--json]` | `ocx observe storage` |
| `ocx memory [--json]` | `ocx observe memory` |

```bash
ocx observe usage --range 30d --json
```

### `ocx debug <provider|usage|injection|claude> <on|off|status|reset|logs [-f]>`

Read or change runtime debug overrides through the running proxy's management API.

```bash
ocx debug provider on|off|status|reset
ocx debug provider logs [-f|--follow]
ocx debug usage on|off|status|reset
ocx debug usage logs [-f|--follow]
```

With no scope, `ocx debug` prints usage and, when the proxy is stopped, the next-start environment
defaults. Provider debug defaults from `OCX_DEBUG=1` (legacy `OCX_DEBUG_FRAMES=1` also works); usage
debug defaults from `OPENCODEX_USAGE_DEBUG=1`.

## API access

### `ocx access <key|endpoints|models|test> ...`

Manage OpenCodex admission API keys and inspect external endpoints and models. `ocx api-key
<list|create|remove> ...` is an alias of `ocx access key`.

```bash
ocx access key create deployment
```

## Client integrations

### `ocx integration <claude|grok> ...`

Manage supported Claude and Grok integrations. The direct command families below expose their
client-specific controls.

### `ocx claude [claude args...]`

Ensure the proxy is running, then launch Claude Code with `ANTHROPIC_BASE_URL`,
`ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`, and model slots from
`config.claudeCode`. Routed models appear in the native `/model` picker through stable slot aliases
with Claude Code 2.1.129 or newer. On older versions, select with `ANTHROPIC_MODEL` or `/model <id>`.
User-exported `ANTHROPIC_*` variables always take precedence.

Claude Desktop profile commands are:

```text
ocx claude desktop [apply]                         Save and apply the four-family profile
ocx claude desktop show [--json]                   Show routes, families, and defaults
ocx claude desktop move <route> <family> [--default]
ocx claude desktop default <family> <route|none>
ocx claude desktop export <path|->                 Export versioned JSON (`-` = stdout)
ocx claude desktop import <path> [--apply]         Validate and import JSON
```

The families are `opus`, `fable`, `sonnet`, and `haiku`; new routes start in `opus`. `none` is valid
only when that family is empty. Legacy apply flags `--static`, `--hybrid`, and `--discovery-only`
remain supported. Use `ocx claude config <status|set> ...` for Claude Code settings.

### `ocx opencode [opencode args...]`

Ensure the proxy is running, then launch opencode with a generated `provider.opencodex` block in
OpenCode's inline runtime layer (`OPENCODE_CONFIG_CONTENT`). Existing inline config is preserved and
only `provider.opencodex` is replaced for this launch. Global or project `opencode.json` files may be
read to warn about an existing override, but on-disk files are never modified. Routed models appear
as `opencodex/<provider>/<model>`. Launching plain `opencode` later behaves exactly as before.

### `ocx grok <status|exclude|include|set|clear|apply> ...`

Manage and apply the Grok Build model fence.

## Client config export

### `ocx export --client <opencode|pi>`

Print a client config wired to the running proxy. opencode and [Pi](/guides/pi/) read providers
from their own JSON config rather than environment variables, so this command serializes the
`opencodex` provider block — base URL, model list, and the client's env reference — for you to
merge into that file.

The proxy must be running; the command resolves its live port, reads `/api/models`, and emits only
models Codex can currently see.

| Flag | Action |
| --- | --- |
| `--client <opencode\|pi>` | Required. Selects the client dialect: opencode's keyed `provider` object or Pi's `providers` array. |
| `--json` | Print only the config JSON on stdout, so a redirect captures byte-exact output. Every diagnostic, including the `--out` write note, goes to stderr. |
| `--out <path>` | Write the config to `<path>`. Refuses to replace an existing file. |
| `--force` | Allow `--out` to replace an existing file. |

```bash
ocx export --client opencode                     # config plus destination, merge warning, and counts
ocx export --client pi --json > pi-models.json   # byte-exact JSON for a pipe or a diff
ocx export --client opencode --out ~/opencodex-opencode.json
```

Without `--json` the JSON leads, then the canonical destination path, the merge warning, the env
export line, and a model count with how many rows omit context limits (the client applies its own
defaults for those).

| Client | Canonical destination | Download filename | Env var |
| --- | --- | --- | --- |
| `opencode` | `~/.config/opencode/opencode.json` (`XDG_CONFIG_HOME` wins when set) | `opencode.json` | `OPENCODEX_OPENCODE_API_KEY` |
| `pi` | `~/.pi/agent/models.json` | `pi-models.json` | `OPENCODEX_API_KEY` |

The two env var names are different, and each client only interpolates its own. opencode reads
`{env:OPENCODEX_OPENCODE_API_KEY}`; Pi reads `$OPENCODEX_API_KEY`.

:::caution[Merge, never replace]
`ocx export` never writes your real client config. The destination is printed for you to merge by
hand, and `--out` refuses to overwrite an existing file without `--force`, because replacing a
config destroys the other providers, agents, and MCP entries already in it.
:::

No key is ever serialized. The config carries only the client's env reference, so the secret stays
in your environment. A loopback proxy (`127.0.0.1`, the default) requires no admission key at all —
the reference is simply unused. Set the variable only when the proxy binds beyond loopback; see
[Remote access](/reference/configuration/#remote-access) for how admission keys are issued. Keys for
the upstream providers themselves are a separate thing entirely, configured per
[Providers](/guides/providers/).

The same payload is served by `GET /api/client-config` and rendered on the dashboard's API tab, so
the CLI, the API, and the GUI use the same bytes.

## Runtime and configuration

### `ocx system <status|settings|startup|diagnostics|sync|update> ...`

Manage headless runtime settings, startup, sync, diagnostics, and updates.

```bash
ocx system settings --stream-mode eager-relay
```

### `ocx config <show|get|set|unset|validate|export|import> ...`

Inspect and safely modify validated OpenCodex configuration. `show` and `get` mask secrets. Import
validates before writing and requires `--yes`.
