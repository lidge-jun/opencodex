---
title: CLI Lifecycle
description: Setup, start, stop, service, diagnostics, sync, and update commands.
---

These commands install, run, inspect, repair, and update the local opencodex proxy and its Codex integration.

## Setup

### `ocx init` · `ocx setup`

Interactive setup wizard (`setup` is an alias of `init`). Prompts for a provider (preset or custom),
API key (literal or `${ENV}`), default model, and proxy port; saves `~/.opencodex/config.json`;
optionally injects the proxy into `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`); and
optionally installs the Codex autostart shim.

## Proxy lifecycle

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
background service is installed, `ocx stop` also stops it first so it cannot respawn the proxy.
The same action is available from the web dashboard's **Stop** button (`POST /api/stop`).

### `ocx restart`

Run `stop` followed by `ensure`: stop the proxy/service, restore native Codex, start the proxy in the
background, and sync the live port back into Codex.

### `ocx ensure`

Idempotently ensure a background proxy is running, then sync its live model catalog. If
`codexAutoStart` is `false`, it prints that autostart is disabled and does nothing.

### `ocx restore [back]` · `ocx eject [back]`

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

### `ocx uninstall` · `ocx remove`

Stop the service and proxy, remove the service and Codex shim, restore native Codex, then remove
opencodex local config only if all restore steps succeeded. `remove` is an alias of `uninstall`.
Config cleanup requires ownership metadata created by a fresh install; legacy or shared directories
are left in place.

## Status and health

### `ocx status [--json]`

Print a read-only diagnostic summary: proxy PID, `/healthz` reachability, dashboard URL, config path,
default provider, Codex autostart setting, service state, shim state, and the redacted effective Codex
home. Only the explicit, high-confidence Windows Orca runtime-home signature adds an actionable App-home
mismatch warning; it never changes `CODEX_HOME` automatically.

Human output also includes an **OAuth health** block after the OAuth logins summary: `OAuth health:
ok` when every known account is healthy, or `OAuth health: warning` with one redacted line per
non-healthy account (provider, masked account id, status such as reauthentication required, rate or
quota limited, or refresh conflict) plus an optional `Action:` hint. Account ids are redacted; tokens
and emails are never printed. The `--json` contract does not currently include this health block.

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

### `ocx doctor`

Run read-only environment and connectivity diagnostics: state paths and filesystem type, WSL dual
installs, proxy environment/config, ChatGPT reachability, Codex plugin and project-config warnings,
and pending history migration. The Codex app-home targeting section also detects the narrow Windows
Orca runtime-home mismatch and explains service migration when applicable. Paths shown by this
diagnostic redact the OS username. Doctor prints repair hints but does not apply them.

The **OAuth reliability** section reports whether credential storage is writable, whether refresh
single-flight/lock files can be created under `OPENCODEX_HOME`, non-healthy OAuth or Codex pool
accounts (redacted ids) with a recovery `Action:`, and a static OK that the Codex forward path does
not fabricate official-client metadata. Doctor never mutates credentials or applies repairs.

## Catalog sync

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

## Background service

### `ocx service [install|start|stop|status|uninstall|remove]`

Run opencodex as a login-managed background service (macOS **launchd**, Linux **systemd user unit**,
Windows **Task Scheduler**) that auto-starts on login and auto-restarts on crash. Service runs set
`OCX_SERVICE=1` so a restart does not churn the Codex config.

| Subcommand | Action |
| --- | --- |
| none | Create/update and start the service. |
| `install` | Create and start the service. |
| `start` | Start an installed service. |
| `stop` | Stop the service and restore native Codex. |
| `status` | Report service and proxy diagnostics plus log paths. |
| `uninstall` | Remove the service and restore native Codex. |
| `remove` | Alias of `uninstall`. |

```bash
ocx service
ocx service install
ocx service status
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

### `ocx codex-shim <install|status|uninstall|remove>`

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
| `status` | Report shim state (installed, stale, or missing). |

```bash
ocx codex-shim install
ocx codex-shim status
ocx codex-shim uninstall
```

:::tip[Service vs Shim]
Use `ocx service` for an always-on background proxy (recommended). Use `ocx codex-shim` for
lightweight, on-demand startup without a daemon — the proxy starts only when `codex` is launched.
:::

### `ocx tray <install|start|stop|status|uninstall|remove> [--json] [--no-start]`

Install and control the Windows status tray icon. It starts at Windows login and provides one-click
proxy controls. `start` and `stop` control the icon only; use its menu to control the proxy.
`--no-start` applies to `install` and installs the tray without launching it immediately.

## Dashboard

### `ocx gui`

Open the [web dashboard](/guides/web-dashboard/) at `http://localhost:<port>`, auto-starting the proxy
if it is not running.

## Updating

### `ocx update [--tag latest|preview]`

Self-update opencodex from npm. Stable installs use `@latest`; preview installs stay on `@preview`
unless you pass `--tag latest|preview`. It detects a source checkout and tells you to
`git pull && bun install` instead, and is a no-op if you are already on the newest version for that
tag. A running proxy is stopped before files are replaced; an installed service is rebuilt and
started automatically, while a foreground installation prints `ocx start` as the next step.

```bash
ocx update
ocx update --tag preview
```

New versions become available when the [Release workflow](https://github.com/lidge-jun/opencodex/actions/workflows/release.yml)
publishes them to npm.
