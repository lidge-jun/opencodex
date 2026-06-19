---
title: CLI Reference
description: Every ocx command and flag.
---

The opencodex CLI is `ocx`. Run `ocx help` (or `--help` / `-h`) for usage.

## Setup & lifecycle

### `ocx init`

Interactive setup wizard. Prompts for a provider (preset or custom), API key (literal or `${ENV}`),
default model, and proxy port; saves `~/.opencodex/config.json`; and optionally injects the proxy into
`~/.codex/config.toml`.

### `ocx start [--port <port>]`

Start the proxy server (default port `10100`). Writes a PID file and refuses to start a second
instance. On start it syncs each provider's models into Codex's catalog. On shutdown it restores
native Codex — unless it was launched as a managed service (`OCX_SERVICE=1`).

```bash
ocx start
ocx start --port 8080
```

### `ocx stop`

Stop the running proxy (by PID), remove the PID file, and restore native Codex.

### `ocx restore` &nbsp;·&nbsp; `ocx eject`

Restore native Codex **without** stopping the proxy — strips the injected config lines and routed
catalog entries so plain `codex` works natively again. `eject` is an alias of `restore`.

### `ocx status`

Print whether the proxy is running (and its PID) or not.

## Models & Codex

### `ocx sync`

Fetch the live model list from every configured provider and re-inject the merged catalog into Codex.
Run it after adding a provider or to refresh available models.

## Authentication

### `ocx login <provider>`

Run the OAuth login flow for a provider and store the credential in `~/.opencodex/auth.json`
(auto-refreshed). Supported: `xai`, `anthropic`, `kimi`.

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

### `ocx service <subcommand>`

Run opencodex as a login-managed background service (macOS **launchd**, Windows **Task Scheduler**)
that auto-starts on login and auto-restarts on crash. Service runs set `OCX_SERVICE=1` so a restart
doesn't churn the Codex config.

| Subcommand | Action |
| --- | --- |
| `install` | Create and start the service. |
| `start` | Start an installed service. |
| `stop` | Stop the service and restore native Codex. |
| `status` | Report whether the service is running. |
| `uninstall` | Remove the service and restore native Codex. (alias: `remove`) |

```bash
ocx service install
ocx service status
ocx service uninstall
```

## Updating

### `ocx update`

Self-update opencodex to the latest version published on npm, using the package manager it was
installed with (`bun add -g @bitkyc08/opencodex@latest` or `npm install -g @bitkyc08/opencodex@latest`). It detects a
source checkout and tells you to `git pull && bun install` instead, and is a no-op if you're already
on the newest version. Restart the proxy afterward (`ocx stop && ocx start`) to run the new build.

```bash
ocx update
```

New versions become available the moment the [Release workflow](https://github.com/lidge-jun/opencodex/actions/workflows/release.yml)
publishes them to npm.

## Help

`ocx help`, `ocx --help`, `ocx -h` — print usage and examples.

:::note
`ocx gui` works but is omitted from the short `ocx help` listing.
:::
