---
title: CLI Reference
description: Every ocx command and flag.
---

The opencodex CLI is `ocx`. Run `ocx help` (or `--help` / `-h`) for top-level usage.
Run `ocx help <command>` for commands registered in the help table. Help and version commands are
read-only and do not start, stop, install, uninstall, or rewrite Codex/opencodex state.

## Setup & lifecycle

### `ocx init`

Interactive setup wizard. Prompts for a provider (preset or custom), API key (literal or `${ENV}`),
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
config path, default provider, Codex autostart setting, service state, and shim state.

Use `--json` for a machine-readable, read-only diagnostics contract:

```bash
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

### `ocx sync`

Fetch the live model list from every configured provider and re-inject the merged catalog into Codex.
Run it after adding a provider or to refresh available models.

### `ocx sync-cache`

Invalidate Codex's local model picker cache so it is rebuilt from the active opencodex catalog.

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

### `ocx models [--provider <name>] [--json]`

List the models statically seeded in configured providers. `--provider` filters one configured
provider and `--json` returns model metadata plus a reminder that `liveModels` may add runtime-only
entries. This command does not fetch live catalogs; use `ocx sync` or the dashboard for that.

### `ocx provider <subcommand>`

Non-interactive provider management. Registry entries are seeded by name; a custom name requires
both `--adapter` and `--base-url`.

| Subcommand | Supported flags | Action |
| --- | --- | --- |
| `list` | `--json` | List configured providers and the remaining registry entries. |
| `add <name>` | `--adapter <adapter>`, `--base-url <url>`, `--api-key <key>`, `--default-model <model>`, `--set-default`, `--force`, `--json`, `--sync` | Add a registry/custom provider. `--force` overwrites; `--sync` refreshes a running proxy in human-output mode. |
| `show <name>` | `--json` | Show config with API keys masked. |
| `remove <name>` | `--json` | Remove a non-default provider; the last provider cannot be removed. |
| `set-default <name>` | `--json` | Select an existing provider as the default. |

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
Human output uses `PROVIDER TYPE ID PLAN/LABEL STATUS`; a pinned Codex row is marked `next session`.
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

## Authentication

### `ocx login <provider>`

Start the provider's registered login flow. OAuth providers open a browser and store auto-refreshed
credentials under `~/.opencodex/`; API-key login providers open their key dashboard, prompt for the
key, validate it when possible, and save the resulting provider config. The command prints the
currently accepted OAuth and API-key provider ids when the name is missing or unknown.

```bash
ocx login xai
```

### `ocx logout <provider>`

Remove the stored OAuth credential for a provider.

## Dashboard

### `ocx gui`

Open the [web dashboard](/opencodex/guides/web-dashboard/) at `http://localhost:<port>`, auto-starting
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
| `uninstall` | Remove the service and restore native Codex. |
| `remove` | Alias of `uninstall`. |

```bash
ocx service
ocx service install
ocx service status
ocx service uninstall
```

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
and pending history migration. It prints repair hints but does not apply them.

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
