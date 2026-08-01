---
title: CLI Reference
description: Every ocx command and flag.
---

The opencodex CLI is `ocx`. Run `ocx help` (or `--help` / `-h`) for top-level usage.
Run `ocx help <command>` for commands registered in the help table. Help and version commands are
read-only and do not start, stop, install, uninstall, or rewrite Codex/opencodex state.

## Setup & lifecycle

### `ocx setup` · `ocx init`

Interactive setup wizard (`init` is the compatibility alias). Prompts for a provider (preset or custom), API key (literal or `${ENV}`),
default model, and proxy port; saves `~/.opencodex/config.json`; optionally injects the proxy into
`$CODEX_HOME/config.toml` (default `~/.codex/config.toml`); and optionally installs the Codex
autostart shim.

### `ocx start [--port <port>]`

Start the proxy server (preferred port `10100`). If that port is occupied, opencodex selects and
records another available port. It writes PID/runtime-port state and refuses to start a second live
instance. On start it syncs each provider's models into Codex's catalog. On shutdown it restores
native Codex — unless it was launched as a managed service (`OCX_SERVICE=1`).

```bash
ocx start
ocx start --port 8080
```

### `ocx stop`

Stop the running proxy (by PID), remove the PID file, and restore native Codex. If a managed
background service is installed, `ocx stop` also stops it first (so it won't respawn the proxy).
The same action is available from the web dashboard's **Stop** button (`POST /api/stop`).

### `ocx restore` &nbsp;·&nbsp; `ocx eject`

Restore native Codex **without** stopping the proxy — strips the injected config lines and routed
catalog entries so plain `codex` works natively again. `eject` is an alias of `restore`.

Pass `back` to either spelling to re-point plain `codex` at an already-running proxy without changing
the proxy lifecycle:

```bash
ocx restore back
ocx eject back
```

### `ocx recover-history --legacy-openai`

Explicit recovery for older development builds that remapped Codex App history before reversible
backup support existed. Close Codex first if its history database is locked.

### `ocx restart`

Run `stop` followed by `ensure`: stop the proxy/service, restore native Codex, start the proxy in the
background, and sync the live port back into Codex.

### `ocx ensure`

Idempotently ensure a background proxy is running, then sync its live model catalog. If
`codexAutoStart` is `false`, it prints that autostart is disabled and does nothing.

### `ocx status [--json]`

Print a read-only diagnostic summary: proxy PID, `/healthz` reachability, dashboard URL,
config path, default provider, Codex autostart setting, service state, shim state, and the redacted
effective Codex home. Only the explicit, high-confidence Windows Orca runtime-home signature adds an
actionable App-home mismatch warning; it never changes `CODEX_HOME` automatically.

Human output also includes an **OAuth health** block after the OAuth logins summary: `OAuth health:
ok` when every known account is healthy, or `OAuth health: warning` with one redacted line per
non-healthy account (provider, masked account id, status such as reauthentication required / rate or
quota limited / refresh conflict) plus an optional `Action:` hint. Account ids are redacted; tokens
and emails are never printed. The `--json` contract does not currently include this health block.

Use `--json` for a machine-readable, read-only diagnostics contract:

```bash
ocx status
ocx status --json
```

Abbreviated example shape:

```json
{
  "schemaVersion": 1,
  "proxy": {
    "running": false,
    "pid": null,
    "health": {
      "ok": false,
      "url": "http://127.0.0.1:10100/healthz",
      "message": "unreachable"
    }
  },
  "dashboard": {
    "url": "http://localhost:10100/"
  },
  "paths": {
    "config": "/Users/example/.opencodex/config.json",
    "pid": "/Users/example/.opencodex/ocx.pid",
    "runtime": "/path/to/bun"
  },
  "runtime": {
    "source": "bundled"
  },
  "codexHome": {
    "effectiveCodexHome": "C:\\Users\\[USER]\\.codex",
    "appCodexHome": "C:\\Users\\[USER]\\.codex",
    "mismatch": false,
    "warning": null,
    "action": null
  },
  "codexAutostart": true,
  "defaultProvider": "openai",
  "service": {
    "summary": "not installed (logs: /Users/example/.opencodex/service.log)"
  },
  "codexShim": {
    "summary": "Codex autostart shim: not installed"
  }
}
```

The real object also includes `listen` (port, hostname, runtime/config source), config load
diagnostics, and bundled Codex plugin diagnostics. The JSON schema is additive-only: future versions
may add fields, but existing fields should stay stable. It intentionally excludes API keys, OAuth
tokens, authorization headers, request content, emails, and account identities.

### `ocx health [--json]`

Identity-check the live proxy. Human output reports PID/port; `--json` emits `{ok, pid, port}`. The
command exits 0 only when healthy and 1 otherwise, making it suitable for service probes.

### `ocx uninstall` &nbsp;·&nbsp; `ocx remove`

Stop the service and proxy, remove the service and Codex shim, restore native Codex, then remove
opencodex local config only if all restore steps succeeded. `remove` is an alias of `uninstall`.

## Models & Codex

### `ocx sync [--restart-codex]`

Fetch the live model list from every configured provider and re-inject the merged catalog into Codex.
Run it after adding a provider or to refresh available models.

If long-lived Codex `app-server` processes are still running, `ocx sync` warns that they may keep
serving the previous in-memory model list even though `opencodex-catalog.json` / `models_cache.json`
were updated. Pass `--restart-codex` to send `SIGTERM` only to matching `codex … app-server` and
`codex-code-mode-host` processes owned by the current user (active turns may be interrupted). Broad
`pkill -f codex` matching is intentionally avoided.

### `ocx sync-cache [--restart-codex]`

Invalidate Codex's local model picker cache so it is rebuilt from the active opencodex catalog. The
same stale-`app-server` warning and optional `--restart-codex` behavior as `ocx sync` apply.

### `ocx v2 [subcommand]`

Manage the Codex `multi_agent_v2` feature flag and the 3-state multi-agent surface mode.

| Subcommand | Action |
| --- | --- |
| `status` (default) | Report the current v2 flag, multi-agent mode, and thread concurrency. |
| `on` | Enable the `multi_agent_v2` feature in `$CODEX_HOME/config.toml` and resync the catalog. |
| `off` | Disable the `multi_agent_v2` feature and resync. |
| `mode v1` | Force ALL models to v1, disable native v2, and preserve the thread limit under `[agents] max_threads`. |
| `mode default` | Respect upstream model pins (sol/terra=v2, luna=v1, rest=codex flag). Install default. |
| `mode v2` | Force ALL models to v2, enable native v2, and migrate the same thread limit to the v2 key. |
| `threads <n>` | Set the active v1/v2 thread limit (integer >= 1). |

```bash
ocx v2 status
ocx v2 mode v1
ocx v2 mode default
ocx v2 on
ocx v2 threads 16
```

The `mode` subcommand writes `multiAgentMode` to the opencodex config and resyncs the Codex catalog.
`mode v1`/`mode v2` and `on`/`off` move the current numeric thread limit between the valid v1/v2
Codex keys while flipping the native feature through `codex features enable|disable`. A failed
transition restores the original `config.toml`.
Changes apply to new Codex sessions; running sessions keep their pinned surface.

## Headless dashboard parity

Operational dashboard features are also available without a browser. These commands locate the
identity-checked running proxy (including a fallback runtime port) and reuse the same management
routes, validation, live configuration, and catalog refresh side effects as the GUI.

| Resource | Commands |
| --- | --- |
| Routing | `ocx combo ...` or `ocx route combo ...` |
| Agent policy | `ocx agent injection|effort|subagents|fallback|sidecar ...` |
| Observability | `ocx observe logs|usage|storage|memory|debug ...` |
| API admission | `ocx access key|endpoints|models|test ...` |
| Client configs | `ocx export --client <opencode\|pi> ...` |
| Claude Code | `ocx claude config status|set ...` |
| Grok Build | `ocx grok status|exclude|include|set|clear|apply ...` |
| Runtime control | `ocx system status|settings|startup|diagnostics|sync|update ...` |
| Offline config | `ocx config show|get|set|unset|validate|export|import ...` |

List/status is the default where unambiguous. Use `--json` for structured snapshots and
`ocx observe logs --follow --jsonl` for a streaming request-log feed. Destructive removal/import
and update actions require `--yes`. Live operations require a running proxy; validated config
inspection and import/export work offline.

```bash
ocx provider test ark
ocx models live --provider ark --json
ocx route combo set reliable --targets ark/model-a:2,openai/gpt-5.5
ocx agent subagents set ark/model-a,openai/gpt-5.5
ocx observe usage --range 30d --json
ocx access key create deployment
ocx export --client opencode
ocx system settings --stream-mode eager-relay
```

Theme, language, navigation, and other purely visual browser state intentionally have no CLI
equivalent. Cloudflare Tunnel setup is not part of this command set.

### `ocx models [subcommand]`

List the models statically seeded in configured providers. `--provider` filters one configured
provider and `--json` returns model metadata. `live` reads the running catalog; `add`, `edit`,
`remove`, and `list-custom` manage manual catalog entries; `enable`, `disable`, and `provider`
control visibility; `selected` controls a provider allowlist; `context` controls provider context
caps; and `shadow` manages background shadow-call interception.

Every per-model operation the dashboard offers is available here, so a headless install never
needs the GUI to manage a catalog. `add`, `remove`, and `list-custom` work against the config file
and apply to a running proxy through a catalog sync; the rest talk to the live management API and
require the proxy to be running (`ocx start`, or an installed service).

| Subcommand | Supported flags | Action |
| --- | --- | --- |
| `list` (default) | `--provider <name>`, `--json` | List models seeded in configured providers. |
| `live` | `--provider <name>`, `--json` | Read the running catalog, including models discovered at runtime. Rows are flagged `native`/`routed`, `custom`, and `enabled`/`disabled`. |
| `add <provider> <modelId>` | `--display-name <name>`, `--context-window <tokens>`, `--modalities <text,image,audio>` | Register a model the provider catalog does not advertise. |
| `edit <custom-id>` | `--model-id <id>`, `--display-name <name\|->`, `--context-window <tokens\|0>`, `--modalities <text,image,audio\|->`, `--json` | Edit a custom model. `-` clears a field; `0` clears the context window. |
| `remove <custom-id\|provider/modelId>` | `--yes` | Delete a custom model. Requires `--yes` when stdin is not an interactive terminal. |
| `list-custom` | `--json` | Show all custom models with the `custom-id` the other subcommands take. |
| `enable <provider/model\|native-model>` | `--native`, `--json` | Make one model visible to Codex. |
| `disable <provider/model\|native-model>` | `--native`, `--json` | Hide one model from Codex. |
| `provider <name> <on\|off>` | `--json` | Enable or disable every model of one provider in a single write. |
| `selected <provider>` | `--set <id,id...>`, `--clear`, `--json` | Read or replace the provider model allowlist. `--clear` removes the allowlist so every model is offered. |
| `context <status\|value <tokens>\|provider <name> <on\|off>\|all <on\|off>>` | `--json` | Read or set the context-window cap, globally or per provider. |
| `shadow <status\|set> [model\|-]` | `--enabled <on\|off>`, `--json` | Read or set the replacement model for Codex's background helper calls. `-` clears the model. `status` also reports `sourceModels`, the helper slugs the proxy intercepts (default `gpt-5.4-mini` and `gpt-5.6-luna`, which Codex 0.145.0 switched to). |

```bash
ocx models live --json                                  # what Codex can actually see right now
ocx models disable anthropic/claude-haiku-4             # hide one routed model
ocx models enable gpt-5.6-sol                          # no slash, so it is treated as native
ocx models provider zenmux off                          # hide a noisy provider wholesale
ocx models selected anthropic --set claude-opus-5,claude-fable-5
ocx models selected anthropic --clear                   # drop the allowlist again
ocx models add deepseek deepseek-v4 --display-name 'DeepSeek V4' --context-window 128000 --modalities text,image
ocx models list-custom --json                           # read the custom-id for edit/remove
ocx models remove deepseek/deepseek-v4 --yes
```

A model selector with a slash is routed (`anthropic/claude-opus-5`); a bare id is treated as a
native OpenAI model, so `--native` is only needed to force that reading for an id that would
otherwise look routed.

`--modalities` accepts only `text`, `image`, and `audio`. Codex parses that field as a closed enum
and rejects an entire catalog containing any other value, so `add`, `edit`, and the management API
all refuse the bad value rather than storing something the catalog writer would have to strip
later (#759).

### `ocx provider <subcommand>`

Non-interactive provider management. Registry entries are seeded by name; a custom name requires
both `--adapter` and `--base-url`.

| Subcommand | Supported flags | Action |
| --- | --- | --- |
| `list` | `--json` | List configured providers and the remaining registry entries. |
| `add <name>` | `--adapter <adapter>`, `--base-url <url>`, `--api-key <key>`, `--default-model <model>`, `--set-default`, `--force`, `--json`, `--sync` | Add a registry/custom provider. `--force` overwrites; `--sync` refreshes a running proxy in human-output mode. |
| `edit <name>` | provider field flags, `--json` | Edit validated live provider fields without replacing key pools. |
| `test <name>` | `--json` | Probe the real upstream model endpoint. |
| `show <name>` | `--json` | Show config with API keys masked. |
| `remove <name>` | `--json` | Remove a non-default provider; the last provider cannot be removed. |
| `set-default <name>` | `--json` | Select an existing provider as the default. |
| `selected <name>` | `--set <ids>`, `--clear`, `--json` | Read or update the provider model allowlist. |
| `quota` | `--refresh`, `--json` | Read provider quota reports. |
| `presets` | `--json` | List dashboard provider presets. |
| `account-mode` | `pool`, `direct`, `--json` | Select pooled or direct Codex account routing. |

```bash
ocx provider list --json
ocx provider add anthropic --api-key sk-ant-... --set-default --sync
ocx provider add local-dev --adapter openai-chat --base-url http://localhost:11434/v1
ocx provider show anthropic --json
ocx models --provider anthropic --json
```

### `ocx account <subcommand>`

List and switch provider accounts and API-key pools through the running proxy. The shipped help
surface is:

```text
Usage: ocx account <list|current|use|refresh|auto-switch|remove|add-key> ...

List and switch provider accounts and API-key pools (GUI parity).

list [provider]     Codex account pool, OAuth accounts and API keys (identifiers shown masked as the API returns them).
current <provider>  Show the active account or key.
use <provider> <id> Switch the active credential; 'main' selects the Codex App login.
refresh <provider>  Force-refresh Codex or provider quota reports.
auto-switch <provider> <on|off|status|threshold N>  Control the Codex pool threshold.
remove <provider> <id> --yes  Remove a stored account or key after an existence check.
add-key <provider> [--label <label>]  Add a key read only from piped stdin.
Codex pool switches apply to new sessions; running threads keep their account.
```

All subcommands require the proxy to be running; the CLI auto-resolves its recorded runtime port.
Successful operations exit 0. Invalid usage, an unknown provider or account/key id, an unreachable
proxy, or an API failure exits 1. Credential fields are displayed exactly as the management API
returns them (including its masking); raw API keys and OAuth tokens are never returned. Display
conveniences are synthesized client-side, same as the dashboard: `main` is the CLI alias for the
Codex App login in the `openai` account pool, OAuth accounts without an email appear as
`Account N`, and the plan/label column falls back across plan, masked email, label, and masked key.

`--json` account rows use this common shape (optional fields are omitted when unavailable):

```json
{
  "provider": "openai",
  "type": "codex | oauth | api-key",
  "id": "__main__",
  "label": "plus",
  "email": "m***@example.com",
  "plan": "plus",
  "masked": "sk-ab****wxyz",
  "active": true,
  "needsReauth": false,
  "quota": null
}
```

#### `ocx account list [provider] [--json] [--all]`

Without a provider, lists the Codex pool, OAuth accounts, and configured API-key pools. Empty
providers are skipped unless `--all` is present. With a provider, lists only that credential family.
Human output uses `PROVIDER TYPE ID PLAN/LABEL STATUS`; a manually chosen Codex row is marked `selected`.
When a stored Kiro account exists, the output notes that Kiro has one login slot and that signing in
again replaces the current account. An empty result is still success. `--json` returns:

```text
{ accounts: AccountRow[], notes: string[] }
```

#### `ocx account current <provider> [--json]`

Shows the active account or key. A Codex pool with no manual pin reports automatic lowest-usage
selection; another family with no active credential reports that state and still exits 0. `--json`
returns:

```text
{ provider, type, activeId: string | null, autoSwitchThreshold?: number, account: AccountRow | null }
```

#### `ocx account use <provider> <account-or-key-id|main> [--json]`

Selects an existing Codex account, OAuth account, or API key. For `openai`, `main` selects the Codex
App login. Codex selections apply only to **new sessions**; existing threads keep their account, and
an enabled auto-switch threshold may later override the manual pin. Unknown providers or ids exit 1.
`--json` returns:

```text
{ ok: true, provider, type, activeId }
```

#### `ocx account refresh <provider> [--json]`

For the Codex pool, use `ocx account refresh openai [--json]`. It force-refreshes account quotas and
prints available weekly/monthly percentages and reset times; missing quota data is reported as
unknown, not 0%. Its JSON envelope is `{ accounts: AccountRow[] }`, with `quota` on each Codex row.

For OAuth and API-key providers, this force-refreshes the provider quota-report endpoint; it is not a
token re-login or a plain account-list re-read. `--json` returns
`{ provider, report: ProviderQuotaReport | null }`. A provider with no supported quota report prints
`no quota report available for <provider>` and exits 0. Unknown providers and management-API
failures exit 1; an upstream quota probe that fails or times out degrades to a null or stale
report instead (exit 0), matching the dashboard's quota bars.

#### `ocx account auto-switch <provider> <on|off|status|threshold <0-100>> [--json]`

Controls only the `openai` Codex account pool. `on` sets 80%, `off` sets 0%, `status` reads the current
value, and `threshold <n>` accepts an integer from 0 through 100. Other providers and invalid values
exit 1. `--json` returns:

```text
{ provider, autoSwitchThreshold: number, enabled: boolean }
```

#### `ocx account remove <provider> <id|main> --yes [--json]`

This guarded, non-interactive deletion requires `--yes`. Before deleting, it verifies that the id
exists; a missing id exits 1 without sending DELETE. The main Codex App login cannot be removed, so
`remove openai main --yes` is refused. After deletion, the family is read again: removing the pinned
Codex account clears the pin and returns to automatic selection; OAuth promotes the first remaining
account or reports none; API-key pools promote the first remaining key or report none. `--json`
success and failure shapes are:

```text
{ ok: true, provider, id, removedActive: boolean, promotedActiveId: string | null }
{ error: string } // stderr, exit 1
```

#### `ocx account add-key <provider> [--label <label>] [--json]`

Adds and activates a key for an API-key provider. The key is read only from non-TTY piped/redirected
stdin; interactive TTY input, empty input, OAuth/Codex providers, and API failures exit 1. The key is
never echoed, including when it appears inside a label. Prefer a secret manager or a here-string:

```bash
ocx account add-key openrouter --label personal <<< "$OPENROUTER_API_KEY"
security find-generic-password -w openrouter | ocx account add-key openrouter --json
```

`--json` returns `{ ok: true, id: string | null, label?: string }` and never includes the key.

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
the CLI, the API, and the GUI can never show different bytes.

## Authentication

### `ocx login <provider>`

Start the provider's registered login flow. OAuth providers open a browser and store auto-refreshed
credentials under `~/.opencodex/`; API-key login providers open their key dashboard, prompt for the
key, validate it when possible, and save the resulting provider config. The command prints the
currently accepted OAuth and API-key provider ids when the name is missing or unknown.

Use the same command to **reauthenticate** after `ocx status` / `ocx doctor` reports
reauthentication required or a terminal refresh failure (or use Reauthenticate in the dashboard).
Codex pool accounts are not a public `ocx login` provider — reauthenticate via the dashboard Codex
account pool (Reauthenticate) instead.

```bash
ocx login xai
ocx login anthropic
```

### `ocx logout <provider>`

Remove the stored OAuth credential for a provider.

## Dashboard

### `ocx gui`

Open the [web dashboard](/guides/web-dashboard/) at `http://localhost:<port>`, auto-starting
the proxy if it isn't running.

## Background service

### `ocx service [subcommand]`

Run opencodex as a login-managed background service (macOS **launchd**, Linux **systemd user unit**,
Windows **Task Scheduler**) that auto-starts on login and auto-restarts on crash. Service runs set
`OCX_SERVICE=1` so a restart doesn't churn the Codex config.

| Subcommand | Action |
| --- | --- |
| none | Create/update and start the service. |
| `install` | Create and start the service. |
| `start` | Start an installed service. |
| `stop` | Stop the service and restore native Codex. |
| `status` | Report whether the service is running. |
| `repair` | Refresh installed service assets without re-registering (no Task Scheduler UAC). |
| `uninstall` | Remove the service and restore native Codex. |
| `remove` | Alias of `uninstall`. |

```bash
ocx service
ocx service install
ocx service status
ocx service repair
ocx service uninstall
```

On Windows, `ocx service status` reports Task Scheduler registration separately from
identity-verified OpenCodex proxy reachability. It does not print the localized `schtasks` table,
so the summary remains readable across Windows code pages.

On Windows, creating the Task Scheduler entry requires elevation. Recognized localized
access-denied text keeps the existing guidance path. If that text is unreadable, the fallback
requires the owned command shape `/create /tn opencodex-proxy /xml <non-empty-path> /f`, status 1,
and a confirmed non-elevated token; the dashboard's Startup Safety action can then request UAC
automatically. If that fallback cannot determine the token state, it retains the original scheduler
error. Foreign tasks and operations can never emit the automatic-elevation marker. Approve the
dashboard UAC prompt or rerun `ocx service install` in an elevated PowerShell window.

### `ocx codex-shim <subcommand>`

Wrap a script-based `codex` launcher on PATH with a lightweight autostart script. Real `codex.exe`
targets are left untouched to avoid breaking exact executable invocations.

If a completed external Codex update overwrites an installed shim, the next ordinary `ocx` command
backs up the stable new launcher and restores the shim before dispatch. A launcher that is still
changing is left untouched and retried later. Repair failures warn without failing the requested
command; manual fallback: `ocx codex-shim install`. Set `codexShimAutoRestore` to `false`, or set
`OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0` for a process-level opt-out.

| Subcommand | Action |
| --- | --- |
| `install` | Install the shim (or repair if stale). |
| `uninstall` | Remove the shim and restore the original Codex binary. |
| `remove` | Alias of `uninstall`. |
| `status` | Report shim state (installed / stale / missing). |

```bash
ocx codex-shim install
ocx codex-shim status
ocx codex-shim uninstall
```

:::tip[Service vs Shim]
Use `ocx service` for an always-on background proxy (recommended). Use `ocx codex-shim` for
lightweight, on-demand startup without a daemon — the proxy starts only when `codex` is launched.
:::

## Diagnostics

### `ocx doctor`

Run read-only environment and connectivity diagnostics: state paths and filesystem type, WSL dual
installs, proxy environment/config, ChatGPT reachability, Codex plugin and project-config warnings,
and pending history migration. The Codex app-home targeting section also detects the narrow Windows
Orca runtime-home mismatch and explains service migration when applicable. Paths shown by this new
diagnostic redact the OS username. Doctor prints repair hints but does not apply them.

The **OAuth reliability** section reports whether credential storage is writable, whether refresh
single-flight / lock files can be created under `OPENCODEX_HOME`, non-healthy OAuth or Codex pool
accounts (redacted ids) with a recovery `Action:`, and a static OK that the Codex forward path does
not fabricate official-client metadata. Doctor never mutates credentials or applies repairs.

### `ocx debug [provider|usage …]`

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

## Updating

### `ocx update`

Self-update opencodex from npm. Stable installs use `@latest`; preview installs stay on `@preview`
unless you pass `--tag latest|preview`. It detects a source checkout and tells you to
`git pull && bun install` instead, and is a no-op if you're already on the newest version for that
tag. A running proxy is stopped before files are replaced; an installed service is rebuilt and
started automatically, while a foreground installation prints `ocx start` as the next step.

```bash
ocx update
ocx update --tag preview
```

New versions become available the moment the [Release workflow](https://github.com/lidge-jun/opencodex/actions/workflows/release.yml)
publishes them to npm.

## Help

`ocx help`, `ocx --help`, `ocx -h` — print top-level usage and examples.

`ocx help <command>`, `ocx <command> --help`, `ocx <command> -h` — print command-specific usage for
commands registered in `src/cli/help.ts`. The full `provider`, `debug`, and `v2` subcommand contracts
are documented above.

Unknown commands remain errors even when a help flag is present, so scripts can rely on the exit
code instead of scraping text.

## Version

`ocx --version`, `ocx -v`, `ocx version` — print a single script-friendly version line and exit.

## Internal commands

Two dispatch targets are intentionally omitted from normal help: `__refresh-version [preview]`
refreshes the update-notification cache in a detached process, and
`__gui-update-worker <job-id> [latest|preview] [restart]` runs a dashboard update job. They are
implementation details, not stable user-facing commands.

The dashboard persists the detached update worker PID and automatically recovers an active job if
that worker is no longer alive. Active records written by older releases without a PID are treated
as stale after ten minutes. A live worker remains protected from concurrent updates even if the
update takes longer than that window.
