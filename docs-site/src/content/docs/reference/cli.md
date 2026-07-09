---
title: CLI Reference
description: Every ocx command and flag.
---

The opencodex CLI is `ocx`. Run `ocx help` (or `--help` / `-h`) for top-level usage.
Run `ocx help <command>` for command-specific help. Help and version commands are read-only and do
not start, stop, install, uninstall, or rewrite Codex/opencodex state.

## Setup & lifecycle

### `ocx init`

Interactive setup wizard. Prompts for a provider (preset or custom), API key (literal or `${ENV}`),
default model, and proxy port; saves `~/.opencodex/config.json`; and optionally injects the proxy into
`$CODEX_HOME/config.toml` (default `~/.codex/config.toml`).

### `ocx start [--port <port>]`

Start the proxy server (default port `10100`). Writes a PID file and refuses to start a second
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

### `ocx status`

Print a read-only diagnostic summary: proxy PID, `/healthz` reachability, dashboard URL,
config path, default provider, Codex autostart setting, service state, and shim state.

Use `--json` for a machine-readable, read-only diagnostics contract:

```bash
ocx status --json
```

Example shape:

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

The JSON schema is additive-only: future versions may add fields, but existing fields should stay
stable. It intentionally excludes API keys, OAuth tokens, authorization headers, request content,
emails, and account identities.

## Models & Codex

### `ocx sync`

### `ocx v2 [subcommand]`

Manage the Codex `multi_agent_v2` feature flag and the 3-state multi-agent surface mode.

| Subcommand | Action |
| --- | --- |
| `status` (default) | Report the current v2 flag, multi-agent mode, and thread concurrency. |
| `on` | Enable the `multi_agent_v2` feature in `$CODEX_HOME/config.toml` and resync the catalog. |
| `off` | Disable the `multi_agent_v2` feature and resync. |
| `mode v1` | Force ALL models to the v1 multi-agent surface (overrides upstream pins). |
| `mode default` | Respect upstream model pins (sol/terra=v2, luna=v1, rest=codex flag). Install default. |
| `mode v2` | Force ALL models to the v2 multi-agent surface (overrides upstream pins). |
| `threads <n>` | Set `max_concurrent_threads_per_session` (integer >= 1, v2 only). |

```bash
ocx v2 status
ocx v2 mode v1
ocx v2 mode default
ocx v2 on
ocx v2 threads 16
```

The `mode` subcommand writes `multiAgentMode` to the opencodex config and resyncs the Codex catalog.
The `on`/`off` subcommands flip the codex-rs feature flag via `codex features enable|disable`.
Changes apply to new Codex sessions; running sessions keep their pinned surface.

Fetch the live model list from every configured provider and re-inject the merged catalog into Codex.
Run it after adding a provider or to refresh available models.

## Authentication

### `ocx login <provider>`

Run the OAuth login flow for a provider and store the credential in `~/.opencodex/auth.json`
(auto-refreshed). Supported examples: `xai`, `anthropic`, `kimi`, `cursor`, `kiro`,
`google-antigravity`, `chatgpt`.

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

If Codex is updated and overwrites the wrapper, the shim auto-repairs on the next `install` call —
the new binary is backed up and a fresh wrapper is written.

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

## Updating

### `ocx update`

Self-update opencodex from npm. Stable installs use `@latest`; preview installs stay on `@preview`
unless you pass `--tag latest|preview`. It detects a source checkout and tells you to
`git pull && bun install` instead, and is a no-op if you're already on the newest version for that
tag. Restart the proxy afterward (`ocx stop && ocx start`) to run the new build.

```bash
ocx update
ocx update --tag preview
```

New versions become available the moment the [Release workflow](https://github.com/lidge-jun/opencodex/actions/workflows/release.yml)
publishes them to npm.

## Help

`ocx help`, `ocx --help`, `ocx -h` — print top-level usage and examples.

`ocx help <command>`, `ocx <command> --help`, `ocx <command> -h` — print command-specific usage.

Unknown commands remain errors even when a help flag is present, so scripts can rely on the exit
code instead of scraping text.

## Version

`ocx --version`, `ocx -v`, `ocx version` — print a single script-friendly version line and exit.
